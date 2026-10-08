import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Input";
import { AUTH_LABEL, type AuthMethod } from "@/data/types";
import { cn } from "@/lib/cn";
import type { ReactNode } from "react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useSessionsStore } from "@/store/sessions";

/* 首次启动（对应 termx.vetd/frames/welcome.tsx，需求书 06）。
 * 整页界面，不套 WindowChrome。四步流程：欢迎 → 导入会话 → 手动新建 → 设置主密码（可跳过），可前进/后退。 */

interface ImportSource {
	id: string;
	name: string;
	detail: string;
	icon: string;
	count: number;
}

const IMPORT_SOURCES: ImportSource[] = [
	{ id: "ssh-config", name: "~/.ssh/config", detail: "OpenSSH 客户端配置", icon: "icon-[lucide--file-code]", count: 12 },
	{ id: "xshell", name: "Xshell", detail: "会话备份（.xsh / 导出目录）", icon: "icon-[lucide--archive]", count: 8 },
	{ id: "finalshell", name: "FinalShell", detail: "conn/*.json 连接配置", icon: "icon-[lucide--folder-tree]", count: 6 },
	{ id: "mobaxterm", name: "MobaXterm", detail: "MobaXterm.ini 会话段", icon: "icon-[lucide--notebook-tabs]", count: 4 },
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
	const [picked, setPicked] = useState<string[]>(["ssh-config", "xshell"]);
	const [host, setHost] = useState({ address: "", user: "", port: "22", auth: "key" as AuthMethod, group: "", note: "" });
	const [hostErrors, setHostErrors] = useState<{ address?: string; user?: string }>({});
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [passwordError, setPasswordError] = useState<string | null>(null);

	const pickedSources = IMPORT_SOURCES.filter((source) => picked.includes(source.id));
	const importTotal = pickedSources.reduce((sum, source) => sum + source.count, 0);
	const hostReady = host.address.trim() !== "" && host.user.trim() !== "";

	const toggleSource = (id: string) =>
		setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

	// 引导结束后回首页（主机库）：那里才有「连哪台」的下一步
	const finish = () => {
		useSessionsStore.getState().setActiveTab("vaults");
		navigate("/workspace");
	};

	const next = () => {
		if (step === 2) {
			const errors = {
				address: host.address.trim() ? undefined : "地址不能为空，例如 10.0.3.21 或 order-api-01",
				user: host.user.trim() ? undefined : "用户名不能为空，例如 deploy",
			};
			setHostErrors(errors);
			if (errors.address || errors.user) return;
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
							onClick={() => setPicked(IMPORT_SOURCES.filter((source) => source.count > 0).map((source) => source.id))}
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
								onKeyDown={(e) => e.key === "Enter" && next()}
								placeholder="10.0.3.21"
								autoFocus
							/>
						</Field>

						<Field label="用户名" required error={hostErrors.user}>
							<Input
								value={host.user}
								onChange={(e) => setHost({ ...host, user: e.target.value })}
								onKeyDown={(e) => e.key === "Enter" && next()}
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
							AES-256 加密 + 系统钥匙串托管
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
						meta="检测到 12 台"
						onClick={() => setStep(1)}
					/>
					<EntryRow
						icon="icon-[lucide--import]"
						title="从 Xshell / FinalShell 导入备份"
						meta="共 14 台"
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
							<Button variant="primary" size="sm" onClick={next}>
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
								onKeyDown={(e) => e.key === "Enter" && next()}
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
					<div className="flex items-center text-muted">
						<span className="flex size-8 items-center justify-center hover:bg-surface-raised">
							<span className="icon-[lucide--minus] size-3.5" />
						</span>
						<span className="flex size-8 items-center justify-center hover:bg-surface-raised">
							<span className="icon-[lucide--square] size-3" />
						</span>
						<span className="flex size-8 items-center justify-center hover:bg-danger hover:text-primary-foreground">
							<span className="icon-[lucide--x] size-3.5" />
						</span>
					</div>
				</div>
			</header>

			{/* 主内容区：左分步内容 + 右上下文卡片 */}
			<div className="grid min-h-0 flex-1 grid-cols-[1.1fr_0.9fr] items-center gap-10 px-16">
				<div className="max-w-lg">
					{leftColumn()}

					{/* 前进 / 后退 */}
					<div className="mt-6 flex items-center gap-2">
						<Button variant="default" size="md" icon="icon-[lucide--arrow-left]" onClick={back} disabled={step === 0}>
							上一步
						</Button>
						<Button variant="primary" size="md" onClick={next}>
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
	const empty = source.count === 0;

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
				{empty ? "未检测到" : `${source.count} 台`}
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
