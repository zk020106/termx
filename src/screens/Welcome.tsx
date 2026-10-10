import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Input";
import { AUTH_LABEL, type AuthMethod } from "@/data/types";
import { cn } from "@/lib/cn";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { parseHostCsv, parseSshConfig, toHosts, expandHome, type ImportResult } from "@/lib/hostImport";
import { createVerifier, lockCryptoAvailable } from "@/lib/lock";
import { fsLocalHome, fsLocalReadFile } from "@/lib/sftp";
import { isTauri } from "@/lib/tauri";
import { useHostsStore } from "@/store/hosts";
import { useSessionsStore } from "@/store/sessions";
import { useSettingsStore } from "@/store/settings";
import { toast } from "@/store/toast";
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from "@/lib/window";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

/* 首次启动（对应 termx.vetd/frames/welcome.tsx，需求书 06）。
 * 整页界面，不套 WindowChrome。四步流程：欢迎 → 导入会话 → 手动新建 → 设置主密码（可跳过），可前进/后退。
 * 每一步都是真的：~/.ssh/config 真实解析计数并导入；CSV 选文件后导入；手动新建写入主机库；
 * 主密码生成 PBKDF2 校验材料并开启 15 分钟自动锁定。Xshell / FinalShell / MobaXterm 的格式尚未支持，如实标注。 */

interface ImportSource {
	id: string;
	name: string;
	detail: string;
	icon: string;
	count: number;
	/** 还不支持的来源：显示原因，不可选 */
	unsupported?: string;
}

const BASE_SOURCES: ImportSource[] = [
	{ id: "ssh-config", name: "~/.ssh/config", detail: "OpenSSH 客户端配置", icon: "icon-[lucide--file-code]", count: 0 },
	{ id: "xshell", name: "Xshell", detail: "会话备份（.xsh / 导出目录）", icon: "icon-[lucide--archive]", count: 0, unsupported: "格式暂不支持" },
	{ id: "finalshell", name: "FinalShell", detail: "conn/*.json 连接配置", icon: "icon-[lucide--folder-tree]", count: 0, unsupported: "格式暂不支持" },
	{ id: "mobaxterm", name: "MobaXterm", detail: "MobaXterm.ini 会话段", icon: "icon-[lucide--notebook-tabs]", count: 0, unsupported: "格式暂不支持" },
	{ id: "csv", name: "CSV 表格", detail: "通用列：名称 / 地址 / 用户 / 端口", icon: "icon-[lucide--table]", count: 0 },
];

const STEPS = [
	{ label: "欢迎", hint: "了解 TermX" },
	{ label: "导入会话", hint: "从现有配置迁移" },
	{ label: "新建主机", hint: "最少两项即可" },
	{ label: "设置主密码", hint: "可选，可跳过" },
];

export default function Welcome() {
	const navigate = useNavigate();
	const [search] = useSearchParams();

	const [step, setStep] = useState(() => {
		const raw = Number(search.get("step") ?? "1");
		return Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw) - 1, 0), STEPS.length - 1) : 0;
	});
	const [picked, setPicked] = useState<string[]>([]);
	/** 各来源真实解析出的结果（按来源 id） */
	const [parsed, setParsed] = useState<Record<string, ImportResult & { label: string }>>({});
	const [home, setHome] = useState("");
	const [importedOnce, setImportedOnce] = useState(false);
	const [createdHostId, setCreatedHostId] = useState<string | null>(null);
	const sshConfigPath = useSettingsStore((s) => s.sshConfigPath);
	const IMPORT_SOURCES = BASE_SOURCES.map((source) => ({ ...source, count: parsed[source.id]?.hosts.length ?? 0 }));

	// 自动检测 ~/.ssh/config（读不到就是「未检测到」，不编数字）
	useEffect(() => {
		if (!isTauri()) return;
		let cancelled = false;
		void (async () => {
			try {
				const h = await fsLocalHome();
				if (cancelled) return;
				setHome(h);
				const path = expandHome(sshConfigPath, h) ?? sshConfigPath;
				const text = await fsLocalReadFile(path);
				if (cancelled) return;
				const result = parseSshConfig(text);
				setParsed((prev) => ({ ...prev, "ssh-config": { ...result, label: path } }));
				if (result.hosts.length > 0) setPicked((prev) => (prev.includes("ssh-config") ? prev : [...prev, "ssh-config"]));
			} catch {
				/* 没有这个文件：保持未检测到 */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [sshConfigPath]);

	/** CSV 来源：选中时让用户挑文件 */
	const pickCsv = async () => {
		try {
			const file = await openFileDialog({ multiple: false, directory: false, filters: [{ name: "CSV", extensions: ["csv", "txt"] }] });
			if (!file || Array.isArray(file)) return false;
			const result = parseHostCsv(await fsLocalReadFile(file));
			setParsed((prev) => ({ ...prev, csv: { ...result, label: file } }));
			if (result.hosts.length === 0) {
				toast({ title: "CSV 里没有可导入的主机", description: result.skipped.join("；"), tone: "warning" });
				return false;
			}
			return true;
		} catch (error) {
			toast({ title: "读取 CSV 失败", description: String(error), tone: "danger" });
			return false;
		}
	};

	/** 把勾选来源的主机写入主机库；同名 / 同地址的跳过并说明 */
	const runImport = () => {
		const store = useHostsStore.getState();
		const all = pickedSources.flatMap((source) => parsed[source.id]?.hosts ?? []);
		if (all.length === 0) return;
		const defaultUser = home.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || undefined;
		const { hosts, conflicts } = toHosts(all, store.hosts, { home, defaultUser });
		for (const h of hosts) store.upsertHost(h);
		const skipped = pickedSources.flatMap((source) => parsed[source.id]?.skipped ?? []);
		setImportedOnce(true);
		toast({
			title: `已导入 ${hosts.length} 台主机`,
			description: [conflicts.length ? `跳过 ${conflicts.length} 项：${conflicts.slice(0, 3).join("；")}${conflicts.length > 3 ? "…" : ""}` : "", skipped.length ? `未导入 ${skipped.length} 条规则` : ""]
				.filter(Boolean)
				.join(" · ") || "密码未导入，首次连接时输入",
			tone: hosts.length > 0 ? "success" : "warning",
		});
	};
	const [host, setHost] = useState({ address: "", user: "", port: "22", auth: "key" as AuthMethod, group: "", note: "" });
	const [hostErrors, setHostErrors] = useState<{ address?: string; user?: string }>({});
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [passwordError, setPasswordError] = useState<string | null>(null);

	const pickedSources = IMPORT_SOURCES.filter((source) => picked.includes(source.id));
	const importTotal = pickedSources.reduce((sum, source) => sum + source.count, 0);
	const hostReady = host.address.trim() !== "" && host.user.trim() !== "";

	const toggleSource = (id: string) => {
		if (id === "csv" && !picked.includes("csv")) {
			void pickCsv().then((ok) => ok && setPicked((current) => [...current, "csv"]));
			return;
		}
		setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
	};

	// 引导结束后回首页（主机库）：那里才有「连哪台」的下一步
	const finish = () => {
		useSessionsStore.getState().setActiveTab("vaults");
		navigate("/workspace");
	};

	const next = async () => {
		if (step === 1 && !importedOnce && pickedSources.length > 0) runImport();
		if (step === 2) {
			const hostsNow = useHostsStore.getState().hosts;
			// 已经导入过主机、这一页什么都没填：允许直接下一步
			const blank = !host.address.trim() && !host.user.trim();
			if (!(blank && hostsNow.length > 0)) {
				const port = Number(host.port || "22");
				const errors = {
					address: host.address.trim() ? undefined : "地址不能为空，例如 10.0.3.21 或 order-api-01",
					user: host.user.trim() ? undefined : "用户名不能为空，例如 deploy",
				};
				setHostErrors(errors);
				if (errors.address || errors.user) return;
				if (!Number.isInteger(port) || port < 1 || port > 65535) {
					setHostErrors({ address: "端口需为 1-65535 的整数" });
					return;
				}
				const store = useHostsStore.getState();
				const groupName = host.group.trim();
				const groupId = groupName
					? (store.groups.find((g) => g.name === groupName)?.id ?? store.addGroup(groupName).id)
					: null;
				const id = createdHostId ?? `host-${Date.now().toString(36)}`;
				store.upsertHost({
					id,
					name: host.address.trim(),
					groupId,
					hostname: host.address.trim(),
					port,
					username: host.user.trim(),
					tags: [],
					favorite: false,
					spec: host.note.trim() || undefined,
					auth: { method: host.auth },
					jumpHostIds: [],
					reachable: false,
				});
				if (!createdHostId) toast({ title: `已添加主机 ${host.address.trim()}`, tone: "success" });
				setCreatedHostId(id);
			}
		}
		if (step === STEPS.length - 1) {
			if (password || confirm) {
				if (password.length < 8) {
					setPasswordError("主密码至少 8 位");
					return;
				}
				if (password !== confirm) {
					setPasswordError("两次输入的主密码不一致");
					return;
				}
				if (!lockCryptoAvailable()) {
					setPasswordError("当前环境没有 WebCrypto，无法设置主密码");
					return;
				}
				useSettingsStore.getState().setSecurity({ lockVerifier: await createVerifier(password), autoLock: "15" });
				toast({ title: "主密码已设置", description: "闲置 15 分钟自动锁定，可在设置中调整", tone: "success" });
			}
			setPasswordError(null);
			finish();
			return;
		}
		setStep((current) => Math.min(current + 1, STEPS.length - 1));
	};

	const back = () => setStep((current) => Math.max(current - 1, 0));

	const primaryLabel = step === 0 ? "开始设置" : step === STEPS.length - 1 ? "保存并进入" : "下一步";

	/* ------------------------------ 左栏：分步内容 ------------------------------ */

	const leftColumn = () => {
		if (step === 1) {
			return (
				<>
					<Eyebrow>Import Sessions</Eyebrow>
					<Headline>导入已有会话</Headline>
					<Lede>选择要迁移的来源，导入后可在主机库继续编辑。</Lede>

					<div className="mt-5 space-y-1.5">
						{IMPORT_SOURCES.map((source) => (
							<ImportRow
								key={source.id}
								source={source}
								selected={picked.includes(source.id)}
								onToggle={() => toggleSource(source.id)}
							/>
						))}
					</div>

					<div className="mt-4 flex items-center gap-3 font-mono text-[11px] text-faint">
						<span>
							已选 {pickedSources.length} 个来源 · 预计导入 {importTotal} 台主机
						</span>
						<button
							type="button"
							onClick={() =>
								setPicked(IMPORT_SOURCES.filter((source) => source.count > 0 && !source.unsupported).map((source) => source.id))
							}
							className="text-primary hover:underline"
						>
							全选
						</button>
						<button type="button" onClick={() => setPicked([])} className="hover:text-surface-foreground">
							清空
						</button>
					</div>
				</>
			);
		}

		if (step === 2) {
			return (
				<>
					<Eyebrow>Manual Host</Eyebrow>
					<Headline>手动新建第一台主机</Headline>
					<Lede>最少只填地址和用户名，其余保持默认；高级选项已折叠。</Lede>

					<div className="mt-5 w-[420px] space-y-3">
						<Field label="地址" hint="IP 或域名" required error={hostErrors.address}>
							<Input
								value={host.address}
								onChange={(e) => setHost({ ...host, address: e.target.value })}
								onKeyDown={(e) => e.key === "Enter" && void next()}
								placeholder="10.0.3.21"
								autoFocus
							/>
						</Field>

						<Field label="用户名" required error={hostErrors.user}>
							<Input
								value={host.user}
								onChange={(e) => setHost({ ...host, user: e.target.value })}
								onKeyDown={(e) => e.key === "Enter" && void next()}
								placeholder="deploy"
							/>
						</Field>

						<div className="overflow-hidden rounded-card border border-border bg-surface-raised">
							<button
								type="button"
								onClick={() => setAdvancedOpen((open) => !open)}
								className="flex h-8 w-full items-center gap-2 px-3 text-[11.5px] text-muted transition-colors hover:text-surface-foreground"
							>
								<span className="icon-[lucide--settings-2] size-3.5" />
								<span className="flex-1 text-left font-medium">高级选项</span>
								<span className="font-mono text-[10px] text-faint">端口 · 认证 · 分组 · 备注</span>
								<span className={cn(advancedOpen ? "icon-[lucide--chevron-up]" : "icon-[lucide--chevron-down]", "size-3.5")} />
							</button>

							{advancedOpen && (
								<div className="space-y-3 border-t border-border p-3">
									<div className="grid grid-cols-2 gap-3">
										<Field label="端口" hint="默认 22">
											<Input
												value={host.port}
												onChange={(e) => setHost({ ...host, port: e.target.value })}
												placeholder="22"
											/>
										</Field>
										<Field label="认证方式">
											<Select value={host.auth} onChange={(e) => setHost({ ...host, auth: e.target.value as AuthMethod })}>
												{(Object.keys(AUTH_LABEL) as AuthMethod[]).map((method) => (
													<option key={method} value={method}>
														{AUTH_LABEL[method]}
													</option>
												))}
											</Select>
										</Field>
									</div>
									<Field label="分组" hint="留空进默认分组">
										<Input value={host.group} onChange={(e) => setHost({ ...host, group: e.target.value })} placeholder="生产环境 / 华东1" />
									</Field>
									<Field label="备注">
										<Input value={host.note} onChange={(e) => setHost({ ...host, note: e.target.value })} placeholder="例如：订单服务主节点" />
									</Field>
								</div>
							)}
						</div>
					</div>
				</>
			);
		}

		if (step === 3) {
			return (
				<>
					<Eyebrow>Security</Eyebrow>
					<Headline>最后一步：设置本地主密码</Headline>

					<div className="mt-5 space-y-2 font-mono text-[11.5px] text-muted">
						<div className="flex items-center gap-2">
							<span className="icon-[lucide--shield-check] size-3.5 text-primary" />
							PBKDF2-SHA256 校验，主密码本身不保存
						</div>
						<div className="flex items-center gap-2">
							<span className="icon-[lucide--timer] size-3.5 text-primary" />
							闲置 15 分钟自动锁屏（可在设置中调整）
						</div>
						<div className="flex items-center gap-2">
							<span className="icon-[lucide--triangle-alert] size-3.5 text-warning" />
							主密码无法找回，忘记只能重置并重新录入凭据
						</div>
					</div>
				</>
			);
		}

		return (
			<>
				<Eyebrow>Native SSH Workspace</Eyebrow>
				<Headline>一台主机，一个工作区</Headline>

				<div className="mt-6 space-y-2">
					<EntryRow
						icon="icon-[lucide--file-code]"
						title="导入 ~/.ssh/config 会话"
						meta={IMPORT_SOURCES[0].count > 0 ? `检测到 ${IMPORT_SOURCES[0].count} 台` : "未检测到"}
						onClick={() => setStep(1)}
					/>
					<EntryRow
						icon="icon-[lucide--import]"
						title="从 CSV 表格导入（Xshell / FinalShell 暂不支持）"
						meta="选择文件"
						onClick={() => setStep(1)}
					/>
					{/* 设计帧里这一项是实心主色按钮，作为「没有现成配置」时的主动作 */}
					<button
						type="button"
						onClick={() => setStep(2)}
						className="flex h-10 w-full items-center justify-center gap-2 rounded-control bg-primary text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
					>
						<span className="icon-[lucide--plus] size-3.5" />
						手动创建第一台主机
					</button>
				</div>
			</>
		);
	};

	/* ------------------------------ 右栏：随步骤变化的卡片 ------------------------------ */

	const rightColumn = () => {
		if (step === 1) {
			return (
				<WizardCard icon="icon-[lucide--download]" title="导入预览" badge={`${pickedSources.length} 个来源`}>
					<div className="mt-3 space-y-2">
						<PreviewRow label="将导入会话" value={`${importTotal} 台`} mono />
						<PreviewRow label="同名会话" value="跳过并标记冲突" />
						<PreviewRow label="登录凭据" value="不导入密码，首次连接时输入" />
					</div>
					<div className="mt-4 flex flex-wrap gap-1 border-t border-border pt-3">
						{pickedSources.length === 0 ? (
							<span className="text-[11px] text-faint">尚未选择任何来源</span>
						) : (
							pickedSources.map((source) => (
								<span
									key={source.id}
									className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[9.5px] text-muted"
								>
									{source.name} · {source.count}
								</span>
							))
						)}
					</div>
				</WizardCard>
			);
		}

		if (step === 2) {
			return (
				<WizardCard icon="icon-[lucide--server]" title="主机预览" badge="实时">
					<div className="mt-3 space-y-2">
						<PreviewRow
							label="连接地址"
							value={
								hostReady
									? `${host.user.trim()}@${host.address.trim()}:${host.port.trim() || "22"}`
									: "等待填写地址和用户名"
							}
							mono
						/>
						<PreviewRow label="认证方式" value={AUTH_LABEL[host.auth]} />
						<PreviewRow label="保存分组" value={host.group.trim() || "默认分组"} />
					</div>
					<div className="mt-4 border-t border-border pt-3">
						<div className="font-mono text-[10px] tracking-wider text-faint uppercase">等价命令</div>
						<div className="mt-1.5 truncate rounded border border-border bg-surface px-2 py-1 font-mono text-[11px] text-muted">
							ssh -p {host.port.trim() || "22"} {host.user.trim() || "user"}@{host.address.trim() || "host"}
						</div>
					</div>
				</WizardCard>
			);
		}

		if (step === 3) {
			const strength =
				password.length === 0 ? "未设置（可跳过）" : password.length < 8 ? "太短，至少 8 位" : password.length < 12 ? "中等" : "强";
			const strengthTone =
				password.length === 0 ? "text-faint" : password.length < 8 ? "text-danger" : password.length < 12 ? "text-warning" : "text-success";

			return (
				<WizardCard
					icon="icon-[lucide--shield-check]"
					title="设置本地主密码"
					badge="可选"
					footer={
						<>
							<button type="button" onClick={finish} className="text-[11.5px] text-faint transition-colors hover:text-surface-foreground">
								稍后在设置中启用
							</button>
							<Button variant="primary" size="sm" onClick={() => void next()}>
								保存并进入
								<span className="icon-[lucide--arrow-right] size-3" />
							</Button>
						</>
					}
				>
					<div className="mt-4 space-y-3">
						<Field label="创建主密码">
							<Input
								type="password"
								value={password}
								onChange={(e) => {
									setPassword(e.target.value);
									setPasswordError(null);
								}}
								placeholder="至少 8 位"
							/>
						</Field>
						<Field label="确认主密码" error={passwordError ?? undefined}>
							<Input
								type="password"
								value={confirm}
								onChange={(e) => {
									setConfirm(e.target.value);
									setPasswordError(null);
								}}
								onKeyDown={(e) => e.key === "Enter" && void next()}
								placeholder="再次输入"
							/>
						</Field>
					</div>

					<div className="mt-3 flex items-center gap-1.5 font-mono text-[10px]">
						<span className="icon-[lucide--info] size-3 text-faint" />
						<span className="text-faint">强度：</span>
						<span className={strengthTone}>{strength}</span>
					</div>
				</WizardCard>
			);
		}

		return (
			<WizardCard icon="icon-[lucide--list-checks]" title="设置向导" badge={`${STEPS.length} 步`}>
				<div className="mt-3 space-y-1">
					{STEPS.map((item, index) => (
						<button
							key={item.label}
							type="button"
							onClick={() => setStep(index)}
							className={cn(
								"flex w-full items-center gap-2.5 rounded border px-2 py-1.5 text-left transition-colors",
								index === step ? "border-border bg-surface" : "border-transparent hover:bg-surface",
							)}
						>
							<span
								className={cn(
									"flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]",
									index < step
										? "border-primary bg-primary/15 text-primary"
										: index === step
											? "border-primary bg-primary text-primary-foreground"
											: "border-border text-faint",
								)}
							>
								{index < step ? <span className="icon-[lucide--check] size-3" /> : index + 1}
							</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[12px] font-medium text-surface-foreground">{item.label}</span>
								<span className="block truncate text-[10.5px] text-faint">{item.hint}</span>
							</span>
							{index === step && <span className="icon-[lucide--chevron-right] size-3.5 shrink-0 text-faint" />}
						</button>
					))}
				</div>
				<div className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-faint">
					这里的所有设置都能稍后在「设置」中修改。
				</div>
			</WizardCard>
		);
	};

	return (
		<div className="relative flex h-full flex-col bg-surface text-surface-foreground antialiased selection:bg-primary/20">
			{/* Windows 顶栏 */}
			<header className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-sunk px-3">
				<div className="flex items-center gap-2">
					<div className="flex size-5 items-center justify-center rounded bg-primary/15 text-primary">
						<span className="icon-[lucide--terminal] size-3.5" />
					</div>
					<span className="text-[12px] font-semibold tracking-tight text-surface-foreground">TermX</span>
					<span className="font-mono text-[10px] text-faint">首次配置引导</span>
				</div>

				<div className="flex items-center gap-3">
					<span className="font-mono text-[10px] text-faint">
						第 {step + 1} / {STEPS.length} 步 · {STEPS[step].label}
					</span>
					{isTauri() && (
						<div className="flex items-center text-muted gap-0.5">
							<button
								type="button"
								aria-label="最小化"
								title="最小化"
								onClick={() => void minimizeWindow()}
								className="flex size-7 items-center justify-center rounded hover:bg-surface-raised cursor-pointer"
							>
								<span className="icon-[lucide--minus] size-3.5" />
							</button>
							<button
								type="button"
								aria-label="最大化"
								title="最大化"
								onClick={() => void toggleMaximizeWindow()}
								className="flex size-7 items-center justify-center rounded hover:bg-surface-raised cursor-pointer"
							>
								<span className="icon-[lucide--square] size-3" />
							</button>
							<button
								type="button"
								aria-label="关闭"
								title="关闭"
								onClick={() => void closeWindow()}
								className="flex size-7 items-center justify-center rounded hover:bg-danger hover:text-white cursor-pointer"
							>
								<span className="icon-[lucide--x] size-3.5" />
							</button>
						</div>
					)}
				</div>
			</header>

			{/* 主内容区：左分步内容 + 右上下文卡片 */}
			<div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] items-center gap-6 lg:gap-10 px-4 sm:px-8 lg:px-16 overflow-y-auto py-6">
				<div className="max-w-lg">
					{leftColumn()}

					{/* 前进 / 后退 */}
					<div className="mt-6 flex items-center gap-2">
						<Button variant="default" size="md" icon="icon-[lucide--arrow-left]" onClick={back} disabled={step === 0}>
							上一步
						</Button>
						<Button variant="primary" size="md" onClick={() => void next()}>
							{primaryLabel}
							<span className="icon-[lucide--arrow-right] size-3" />
						</Button>
						{step === STEPS.length - 1 && (
							<button type="button" onClick={finish} className="ml-1 text-[11.5px] text-faint transition-colors hover:text-surface-foreground">
								跳过主密码
							</button>
						)}
					</div>
				</div>

				<div className="flex justify-center">{rightColumn()}</div>
			</div>
		</div>
	);
}

/* ------------------------------ 局部小组件 ------------------------------ */

function Eyebrow({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-center gap-1.5 font-mono text-[11px] font-medium tracking-wider text-primary uppercase">
			<span className="size-1.5 rounded-full bg-primary" />
			{children}
		</div>
	);
}

function Headline({ children }: { children: ReactNode }) {
	return <h1 className="mt-2 text-[24px] leading-snug font-semibold tracking-tight text-surface-foreground">{children}</h1>;
}

function Lede({ children }: { children: ReactNode }) {
	return <p className="mt-2 text-[13px] leading-relaxed text-muted">{children}</p>;
}

function EntryRow({
	icon,
	title,
	meta,
	onClick,
}: {
	icon: string;
	title: string;
	meta: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="group flex h-10 w-[380px] items-center gap-3 rounded border border-border bg-surface-raised px-3 text-[12.5px] transition-colors hover:border-primary/40"
		>
			<span className="flex size-6 shrink-0 items-center justify-center rounded border border-border bg-surface text-primary">
				<span className={cn(icon, "size-3.5")} />
			</span>
			<span className="flex-1 truncate text-left font-medium text-surface-foreground">{title}</span>
			<span className="shrink-0 font-mono text-[11px] text-faint">{meta}</span>
			<span className="icon-[lucide--chevron-right] size-3.5 shrink-0 text-faint group-hover:text-surface-foreground" />
		</button>
	);
}

function ImportRow({
	source,
	selected,
	onToggle,
}: {
	source: ImportSource;
	selected: boolean;
	onToggle: () => void;
}) {
	// CSV 要先选文件才知道数量，所以 0 台时也可以点
	const empty = source.unsupported !== undefined || (source.count === 0 && source.id !== "csv");

	return (
		<button
			type="button"
			onClick={onToggle}
			disabled={empty}
			className={cn(
				"flex h-11 w-[420px] items-center gap-3 rounded border bg-surface-raised px-3 text-left transition-colors",
				empty
					? "cursor-not-allowed border-border opacity-50"
					: selected
						? "border-primary/50"
						: "border-border hover:border-primary/40",
			)}
		>
			<span
				className={cn(
					"flex size-4 shrink-0 items-center justify-center rounded border",
					selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface",
				)}
			>
				{selected && <span className="icon-[lucide--check] size-3" />}
			</span>
			<span className={cn(source.icon, "size-3.5 shrink-0 text-muted")} />
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[12.5px] font-medium text-surface-foreground">{source.name}</span>
				<span className="block truncate font-mono text-[10.5px] text-faint">{source.detail}</span>
			</span>
			<span className={cn("shrink-0 font-mono text-[11px]", empty ? "text-faint" : "text-muted")}>
				{source.unsupported ?? (source.count > 0 ? `${source.count} 台` : source.id === "csv" ? "选择文件" : "未检测到")}
			</span>
		</button>
	);
}

function WizardCard({
	icon,
	title,
	badge,
	footer,
	children,
}: {
	icon: string;
	title: string;
	badge: string;
	footer?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="w-[360px] rounded-lg border border-border bg-surface-raised p-5 shadow-lg">
			<div className="flex items-center justify-between border-b border-border pb-3">
				<div className="flex items-center gap-2">
					<span className={cn(icon, "size-4 text-primary")} />
					<h2 className="text-[13px] font-semibold text-surface-foreground">{title}</h2>
				</div>
				<span className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[9px] text-faint uppercase">{badge}</span>
			</div>

			{children}

			{footer && <div className="mt-5 flex items-center justify-between border-t border-border pt-3">{footer}</div>}
		</div>
	);
}

function PreviewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
	return (
		<div className="flex items-baseline justify-between gap-3">
			<span className="shrink-0 text-[11.5px] text-muted">{label}</span>
			<span className={cn("truncate text-[11.5px] text-surface-foreground", mono && "font-mono")}>{value}</span>
		</div>
	);
}
