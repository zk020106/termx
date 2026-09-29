import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { EnvPill, Segmented, SectionLabel } from "@/components/ui/Display";
import { Field, Input, ReadonlyValue, Select, Textarea } from "@/components/ui/Input";
import { Checkbox, Switch } from "@/components/ui/Toggle";
import { Drawer, Modal } from "@/components/ui/Overlay";
import { sshKeys } from "@/data/mock";
import { ENV_NAME, type AuthMethod, type Env, type Host } from "@/data/types";
import { cn } from "@/lib/cn";
import { useHostsStore } from "@/store/hosts";
import { toast } from "@/store/toast";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";

/* 编辑主机（对应 termx.vetd/frames/host-edit.tsx）。
 * 覆盖状态（需求书 06）：新建 / 编辑两种模式；基本信息、认证、跳板机、高级、外观五个分区；
 * 校验失败（名称 / 地址为空、端口非法）；未保存离开提示。 */

type TabKey = "basic" | "auth" | "jump" | "advanced" | "appearance";

const TABS: { value: TabKey; label: string }[] = [
	{ value: "basic", label: "基本信息" },
	{ value: "auth", label: "认证凭据" },
	{ value: "jump", label: "跳板机网络" },
	{ value: "advanced", label: "高级选项" },
	{ value: "appearance", label: "外观终端" },
];

const ENVS: Env[] = ["prod", "stage", "test", "dev"];

const AUTH_OPTIONS: { value: AuthMethod; label: string }[] = [
	{ value: "password", label: "密码" },
	{ value: "key", label: "私钥" },
	{ value: "key-passphrase", label: "私钥+口令" },
	{ value: "agent", label: "Agent" },
	{ value: "keyboard-interactive", label: "键盘交互" },
];

const CURSOR_OPTIONS: { value: "block" | "bar" | "underline"; label: string }[] = [
	{ value: "block", label: "方块" },
	{ value: "bar", label: "竖线" },
	{ value: "underline", label: "下划线" },
];

type DemoState = "edit" | "new" | "invalid" | "leave";

interface FormState {
	name: string;
	hostname: string;
	port: string;
	username: string;
	env: Env;
	groupId: string;
	tags: string;
	authMethod: AuthMethod;
	password: string;
	rememberPassword: boolean;
	keyId: string;
	passphrase: string;
	jumpHostIds: string[];
	encoding: string;
	termType: string;
	proxyEnabled: boolean;
	proxyType: "socks5" | "http";
	proxyHost: string;
	proxyPort: string;
	envVars: { key: string; value: string }[];
	loginScript: string;
	colorScheme: string;
	fontFamily: string;
	fontSize: string;
	lineHeight: string;
	cursorStyle: "block" | "bar" | "underline";
}

export default function HostEdit() {
	const navigate = useNavigate();
	const { hostId } = useParams();
	const editing = Boolean(hostId);

	const [form, setForm] = useState<FormState>(() => toForm(findHost(hostId)));
	const [initial, setInitial] = useState<FormState>(() => toForm(findHost(hostId)));
	const [tab, setTab] = useState<TabKey>("basic");
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [showErrors, setShowErrors] = useState(false);
	const [leaveOpen, setLeaveOpen] = useState(false);
	const [demo, setDemo] = useState<DemoState>(editing ? "edit" : "new");

	const dirty = JSON.stringify(form) !== JSON.stringify(initial);

	/* 路由变化（新建 ⇄ 编辑）时重建表单 */
	useEffect(() => {
		const next = toForm(findHost(hostId));
		setForm(next);
		setInitial(next);
		setErrors({});
		setShowErrors(false);
		setLeaveOpen(false);
		setTab("basic");
		setDemo(hostId ? "edit" : "new");
	}, [hostId]);

	/* 状态切换器：校验失败 / 未保存离开两个评审态（骨架期评审工具） */
	const applyDemo = (next: DemoState) => {
		setDemo(next);
		if (next === "invalid") {
			setForm((f) => ({ ...f, name: "", hostname: "", port: "70000" }));
			setErrors({ name: "主机显示名称不能为空", hostname: "连接主机地址不能为空", port: "端口需为 1–65535 之间的整数" });
			setShowErrors(true);
			setTab("basic");
		}
		if (next === "leave") setLeaveOpen(true);
		if (next === "new") navigate("/hosts/new");
		if (next === "edit") navigate(`/hosts/${useHostsStore.getState().hosts[0]?.id ?? "order-api-01"}/edit`);
	};

	const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

	const handleClose = () => {
		if (dirty) {
			setLeaveOpen(true);
			return;
		}
		navigate("/hosts");
	};

	const save = () => {
		const next = validate(form);
		setErrors(next);
		setShowErrors(true);
		if (Object.keys(next).length > 0) {
			setTab("basic");
			setDemo("invalid");
			return;
		}
		const existing = findHost(hostId);
		const host: Host = {
			id: hostId ?? `host-${Date.now().toString(36)}`,
			name: form.name.trim(),
			groupId: form.groupId || null,
			hostname: form.hostname.trim(),
			port: Number(form.port),
			username: form.username.trim() || "root",
			env: form.env,
			tags: form.tags
				.split(/[,，\s]+/)
				.map((t) => t.trim())
				.filter(Boolean),
			favorite: existing?.favorite ?? false,
			os: existing?.os,
			spec: existing?.spec,
			auth: {
				method: form.authMethod,
				keyId: form.authMethod === "key" || form.authMethod === "key-passphrase" ? form.keyId : undefined,
				rememberPassword: form.rememberPassword,
			},
			jumpHostIds: form.jumpHostIds,
			proxy: form.proxyEnabled
				? { type: form.proxyType, host: form.proxyHost.trim() || "127.0.0.1", port: Number(form.proxyPort) || 1080 }
				: null,
			encoding: form.encoding,
			termType: form.termType,
			envVars: form.envVars.filter((v) => v.key.trim() !== ""),
			loginScript: form.loginScript,
			terminal: {
				colorScheme: form.colorScheme,
				fontFamily: form.fontFamily,
				fontSize: Number(form.fontSize) || 13,
				lineHeight: Number(form.lineHeight) || 1.5,
				cursorStyle: form.cursorStyle,
			},
			lastConnectedAt: existing?.lastConnectedAt,
			latencyMs: existing?.latencyMs,
			reachable: existing?.reachable ?? false,
		};
		useHostsStore.getState().upsertHost(host);
		setInitial(form);
		setLeaveOpen(false);
		toast({
			title: hostId ? `已保存 ${host.name}` : `已新建主机 ${host.name}`,
			description: `${host.username}@${host.hostname}:${host.port}`,
			tone: "success",
		});
		navigate("/hosts");
	};

	const err = (key: string) => (showErrors ? errors[key] : undefined);
	const hosts = useHostsStore((s) => s.hosts);
	const groups = useHostsStore((s) => s.groups);
	const activeGroup = groups.find((g) => g.id === form.groupId);
	const underlying = hosts.slice(0, 6);
	const jumpCandidates = hosts.filter((h) => h.id !== hostId && !form.jumpHostIds.includes(h.id));

	return (
		<WindowChrome>
			<div className="relative min-h-0 flex-1 bg-surface">
				{/* 底层：主机库视图（抽屉打开时被遮罩压暗） */}
				<div className="flex h-10 items-center justify-between border-b border-border bg-surface-sunk px-4">
					<div className="flex items-center gap-1.5 text-[12px] text-muted">
						<span>主机库</span>
						<span className="text-border">/</span>
						<span className="text-surface-foreground">{activeGroup?.name ?? "全部主机"}</span>
					</div>
					<span className="mr-[480px] font-mono text-[11px] text-faint">{hosts.length} 台节点</span>
				</div>

				<div className="grid grid-cols-3 content-start gap-3 p-4 pr-[480px]">
					{underlying.map((h) => (
						<div key={h.id} className="rounded-card border border-border bg-surface-raised p-3 text-[12px]">
							<div className="flex items-center justify-between gap-2">
								<span className="truncate font-mono font-medium text-surface-foreground">{h.name}</span>
								<EnvPill env={h.env} size="xs" />
							</div>
							<div className="mt-1 truncate font-mono text-[11px] text-muted">
								{h.username}@{h.hostname}
							</div>
						</div>
					))}
				</div>

				{/* 编辑抽屉 */}
				<Drawer
					open
					onClose={handleClose}
					width={460}
					title={
						<span className="flex items-center gap-2">
							<span className="icon-[lucide--server] size-4 text-primary" />
							{editing ? "编辑主机配置" : "新建主机"}
						</span>
					}
					subtitle={
						editing && form.hostname
							? `${form.username || "root"}@${form.hostname}:${form.port}`
							: "填写连接信息后保存到主机库"
					}
					footer={
						<>
							{dirty && (
								<span className="mr-auto flex items-center gap-1 text-[11px] text-warning">
									<span className="size-1.5 rounded-full bg-warning" />
									有未保存的修改
								</span>
							)}
							<Button size="sm" onClick={handleClose}>
								取消
							</Button>
							<Button size="sm" variant="primary" icon="icon-[lucide--check]" onClick={save}>
								保存主机
							</Button>
						</>
					}
				>
					{/* 五个分区 */}
					<div className="sticky top-0 z-10 border-b border-border bg-surface-sunk p-2">
						<Segmented value={tab} onChange={setTab} options={TABS} className="w-full" />
					</div>

					<div className="flex flex-col gap-3 p-4">
						{showErrors && Object.keys(errors).length > 0 && (
							<div className="flex items-start gap-2 rounded-control border border-danger/40 bg-danger/10 px-2.5 py-2 text-[11px] text-danger">
								<span className="icon-[lucide--circle-alert] mt-px size-3.5 shrink-0" />
								<span>有 {Object.keys(errors).length} 处校验未通过，请修正后再保存。</span>
							</div>
						)}

						{tab === "basic" && (
							<>
								<Field label="主机显示名称" required error={err("name")} hint="用于标签页、列表与命令面板">
									<Input
										value={form.name}
										onChange={(e) => set("name", e.target.value)}
										placeholder="例如 order-api-01"
										className="font-mono"
									/>
								</Field>

								<div className="grid grid-cols-[1fr_80px] gap-2">
									<Field label="连接主机地址 (IP / 域名)" required error={err("hostname")}>
										<Input
											value={form.hostname}
											onChange={(e) => set("hostname", e.target.value)}
											placeholder="10.0.3.21"
											className="font-mono"
										/>
									</Field>
									<Field label="SSH 端口" error={err("port")}>
										<Input
											value={form.port}
											onChange={(e) => set("port", e.target.value)}
											inputMode="numeric"
											placeholder="22"
											className="font-mono"
										/>
									</Field>
								</div>

								<Field label="登录用户名" hint="留空默认 root">
									<Input
										value={form.username}
										onChange={(e) => set("username", e.target.value)}
										placeholder="deploy"
										className="font-mono"
									/>
								</Field>

								<Group label="环境标识" hint="生产 / 预发 / 测试 / 开发各用固定颜色">
									<div className="flex items-center gap-1.5">
										{ENVS.map((e) => (
											<button
												key={e}
												type="button"
												onClick={() => set("env", e)}
												className={cn(
													"flex h-7 flex-1 items-center justify-center gap-1.5 rounded-control border transition-colors",
													form.env === e
														? "border-primary/60 bg-primary/10 text-surface-foreground"
														: "border-border bg-surface text-muted hover:bg-surface-raised",
												)}
											>
												<EnvPill env={e} size="xs" />
												<span className="text-[11px]">{ENV_NAME[e]}</span>
											</button>
										))}
									</div>
								</Group>

								<div className="grid grid-cols-2 gap-2">
									<Field label="所属分组">
										<Select value={form.groupId} onChange={(e) => set("groupId", e.target.value)}>
											<option value="">未分组</option>
											{groups.map((g) => (
												<option key={g.id} value={g.id}>
													{g.name}
												</option>
											))}
										</Select>
									</Field>
									<Field label="自定义标签" hint="逗号分隔">
										<Input value={form.tags} onChange={(e) => set("tags", e.target.value)} placeholder="java, 订单" />
									</Field>
								</div>
							</>
						)}

						{tab === "auth" && (
							<>
								<Group label="认证方式">
									<Segmented value={form.authMethod} onChange={(v) => set("authMethod", v)} options={AUTH_OPTIONS} className="w-full" />
								</Group>

								{form.authMethod === "password" && (
									<>
										<Field label="登录密码" hint="保存后写入系统钥匙串">
											<Input
												type="password"
												value={form.password}
												onChange={(e) => set("password", e.target.value)}
												placeholder="••••••••"
												className="font-mono"
											/>
										</Field>
										<Checkbox
											checked={form.rememberPassword}
											onChange={(v) => set("rememberPassword", v)}
											label="记住密码"
											description="默认不勾选（需求书 07-连接流程）；勾选后凭据存入系统钥匙串。"
										/>
									</>
								)}

								{(form.authMethod === "key" || form.authMethod === "key-passphrase") && (
									<Field label="指定私钥身份">
										<Select value={form.keyId} onChange={(e) => set("keyId", e.target.value)} className="font-mono">
											{sshKeys.map((k) => (
												<option key={k.id} value={k.id}>
													{k.name} · {k.type}
													{k.bits ? ` ${k.bits}` : ""} · {k.fingerprint}
												</option>
											))}
										</Select>
									</Field>
								)}

								{form.authMethod === "key-passphrase" && (
									<Field label="私钥口令">
										<Input
											type="password"
											value={form.passphrase}
											onChange={(e) => set("passphrase", e.target.value)}
											placeholder="••••••••"
											className="font-mono"
										/>
									</Field>
								)}

								{form.authMethod === "agent" && (
									<ReadonlyValue>
										<span className="icon-[lucide--key-round] size-3 text-primary" />
										使用系统 SSH Agent 中的密钥（无需在 TermX 保存凭据）
									</ReadonlyValue>
								)}

								{form.authMethod === "keyboard-interactive" && (
									<Group label="键盘交互">
										<div className="rounded-control border border-border bg-surface p-2.5 text-[11px] text-muted">
											连接时由服务器逐步提问，TermX 弹出输入框接收密码 / 二次验证码（OTP），不在本地保存。
										</div>
									</Group>
								)}

								{/* 会话保持与重连策略 */}
								<div className="rounded-card border border-border bg-surface p-2.5 text-[11.5px]">
									<div className="flex items-center justify-between">
										<span className="flex items-center gap-1.5 font-medium text-surface-foreground">
											<span className="icon-[lucide--shield-check] size-3.5 text-primary" />
											会话保持与重连策略
										</span>
										<span className="font-mono text-[10.5px] text-faint">心跳 30s</span>
									</div>
									<p className="mt-1 text-[11px] text-muted">网络闪断后自动无感重连，保持会话前台程序</p>
								</div>
							</>
						)}

						{tab === "jump" && (
							<>
								<Group label="跳板机链路" hint="按顺序逐跳连接">
									{form.jumpHostIds.length === 0 ? (
										<div className="flex h-7 items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 font-mono text-[11.5px] text-muted">
											<span className="icon-[lucide--zap] size-3 text-faint" />
											直连（无跳板）
										</div>
									) : (
										<div className="space-y-1">
											{form.jumpHostIds.map((id, i) => {
												const hop = hosts.find((h) => h.id === id);
												return (
													<div key={id} className="flex h-7 items-center gap-2 rounded-control border border-border bg-surface px-2.5">
														<span className="font-mono text-[10px] text-faint">{i + 1}</span>
														<span className="icon-[lucide--waypoints] size-3 text-primary" />
														<span className="font-mono text-[11.5px] text-surface-foreground">{hop?.name ?? id}</span>
														<span className="flex-1 truncate font-mono text-[10.5px] text-faint">
															{hop ? `${hop.username}@${hop.hostname}:${hop.port}` : ""}
														</span>
														<button
															type="button"
															aria-label="移除这一跳"
															onClick={() => set("jumpHostIds", form.jumpHostIds.filter((x) => x !== id))}
															className="flex size-5 items-center justify-center rounded text-muted hover:bg-danger/15 hover:text-danger"
														>
															<span className="icon-[lucide--x] size-3" />
														</button>
													</div>
												);
											})}
										</div>
									)}
								</Group>

								<Field label="添加跳板机" hint="每一跳可单独配置认证方式">
									<Select
										value=""
										onChange={(e) => {
											if (e.target.value) set("jumpHostIds", [...form.jumpHostIds, e.target.value]);
										}}
									>
										<option value="">选择一台主机作为下一跳…</option>
										{jumpCandidates.map((h) => (
											<option key={h.id} value={h.id}>
												{h.name} · {h.username}@{h.hostname}
											</option>
										))}
									</Select>
								</Field>

								<div className="rounded-card border border-border bg-surface p-2.5 text-[11px] text-muted">
									跳板链上的每一跳都可以覆盖认证方式与端口；认证失败时会在连接进度里标出具体是哪一跳。
								</div>
							</>
						)}

						{tab === "advanced" && (
							<>
								<div className="grid grid-cols-2 gap-2">
									<Field label="字符编码">
										<Select value={form.encoding} onChange={(e) => set("encoding", e.target.value)} className="font-mono">
											{["UTF-8", "GBK", "GB18030", "ISO-8859-1"].map((c) => (
												<option key={c} value={c}>
													{c}
												</option>
											))}
										</Select>
									</Field>
									<Field label="终端类型">
										<Select value={form.termType} onChange={(e) => set("termType", e.target.value)} className="font-mono">
											{["xterm-256color", "xterm", "screen-256color", "vt100"].map((t) => (
												<option key={t} value={t}>
													{t}
												</option>
											))}
										</Select>
									</Field>
								</div>

								<Group label="代理">
									<div className="rounded-card border border-border bg-surface p-2.5">
										<div className="flex items-center justify-between">
											<span className="text-[11.5px] text-surface-foreground">经由 SOCKS5 / HTTP 代理连接</span>
											<Switch checked={form.proxyEnabled} onChange={(v) => set("proxyEnabled", v)} label="启用代理" />
										</div>
										{form.proxyEnabled && (
											<div className="mt-2 grid grid-cols-[80px_1fr_70px] gap-2">
												<Select value={form.proxyType} onChange={(e) => set("proxyType", e.target.value as "socks5" | "http")}>
													<option value="socks5">SOCKS5</option>
													<option value="http">HTTP</option>
												</Select>
												<Input value={form.proxyHost} onChange={(e) => set("proxyHost", e.target.value)} className="font-mono" />
												<Input
													value={form.proxyPort}
													onChange={(e) => set("proxyPort", e.target.value)}
													inputMode="numeric"
													className="font-mono"
												/>
											</div>
										)}
									</div>
								</Group>

								<Group label="环境变量">
									<div className="space-y-1">
										{form.envVars.length === 0 && <div className="px-1 text-[11px] text-faint">登录时注入的环境变量，暂无</div>}
										{form.envVars.map((v, i) => (
											<div key={i} className="flex items-center gap-1.5">
												<Input
													value={v.key}
													onChange={(e) =>
														set(
															"envVars",
															form.envVars.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)),
														)
													}
													placeholder="JAVA_HOME"
													className="h-6.5 font-mono text-[11px]"
												/>
												<span className="text-faint">=</span>
												<Input
													value={v.value}
													onChange={(e) =>
														set(
															"envVars",
															form.envVars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
														)
													}
													placeholder="/usr/lib/jvm/java-17"
													className="h-6.5 font-mono text-[11px]"
												/>
												<button
													type="button"
													aria-label="删除变量"
													onClick={() => set("envVars", form.envVars.filter((_, j) => j !== i))}
													className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-danger/15 hover:text-danger"
												>
													<span className="icon-[lucide--trash-2] size-3" />
												</button>
											</div>
										))}
										<Button
											size="sm"
											variant="ghost"
											icon="icon-[lucide--plus]"
											onClick={() => set("envVars", [...form.envVars, { key: "", value: "" }])}
										>
											添加变量
										</Button>
									</div>
								</Group>

								<Field label="登录后自动执行的命令" hint="每行一条">
									<Textarea
										rows={3}
										value={form.loginScript}
										onChange={(e) => set("loginScript", e.target.value)}
										placeholder={"cd /srv/app\nexport PS1='\\u@\\h:\\w$ '"}
										className="text-[11.5px]"
									/>
								</Field>
							</>
						)}

						{tab === "appearance" && (
							<>
								<div className="grid grid-cols-2 gap-2">
									<Field label="配色方案">
										<Select value={form.colorScheme} onChange={(e) => set("colorScheme", e.target.value)}>
											{["One Dark", "Dracula", "Nord", "Solarized Dark", "Gruvbox Dark"].map((s) => (
												<option key={s} value={s}>
													{s}
												</option>
											))}
										</Select>
									</Field>
									<Field label="字体">
										<Select value={form.fontFamily} onChange={(e) => set("fontFamily", e.target.value)}>
											{["JetBrains Mono", "Cascadia Mono", "Consolas", "系统等宽字体"].map((f) => (
												<option key={f} value={f}>
													{f}
												</option>
											))}
										</Select>
									</Field>
								</div>

								<div className="grid grid-cols-2 gap-2">
									<Field label="字号 (px)">
										<Input
											value={form.fontSize}
											onChange={(e) => set("fontSize", e.target.value)}
											inputMode="numeric"
											className="font-mono"
										/>
									</Field>
									<Field label="行高">
										<Input
											value={form.lineHeight}
											onChange={(e) => set("lineHeight", e.target.value)}
											inputMode="decimal"
											className="font-mono"
										/>
									</Field>
								</div>

								<Group label="光标样式">
									<Segmented value={form.cursorStyle} onChange={(v) => set("cursorStyle", v)} options={CURSOR_OPTIONS} className="w-full" />
								</Group>

								<SectionLabel className="px-0">预览</SectionLabel>
								<div className="rounded-card border border-border bg-term p-3 text-term-ink">
									<div className="font-mono text-[11.5px] leading-5">
										<div className="text-muted">deploy@{form.hostname || "host"}:~$ tail -f app.log</div>
										<div>INFO 10:14:02 started in {(form.lineHeight || "1.5").toString()} line-height</div>
										<div>
											<span className="rounded-sm bg-primary/30 px-0.5">
												{form.cursorStyle === "block" ? "█" : form.cursorStyle === "underline" ? "_" : "|"}
											</span>
										</div>
									</div>
									<div className="mt-2 flex items-center justify-between border-t border-border/40 pt-2 font-mono text-[10px] text-faint">
										<span>
											{form.colorScheme} · {form.fontFamily}
										</span>
										<span>
											{form.fontSize || 13}px / {form.lineHeight || 1.5}
										</span>
									</div>
								</div>
							</>
						)}
					</div>
				</Drawer>

				{/* 未保存离开提示 */}
				<Modal
					open={leaveOpen}
					onClose={() => setLeaveOpen(false)}
					title="有未保存的修改"
					icon="icon-[lucide--triangle-alert]"
					footer={
						<>
							<Button size="sm" onClick={() => setLeaveOpen(false)}>
								继续编辑
							</Button>
							<Button
								size="sm"
								variant="danger"
								onClick={() => {
									setLeaveOpen(false);
									navigate("/hosts");
								}}
							>
								放弃修改
							</Button>
							<Button size="sm" variant="primary" onClick={save}>
								保存并离开
							</Button>
						</>
					}
				>
					<p>
						主机 <span className="font-mono text-surface-foreground">{form.name || "未命名"}</span> 的修改尚未保存，离开后这些改动会丢失。
					</p>
					<div className="mt-2 flex items-center gap-1.5 font-mono text-[10.5px] text-faint">
						<span className="icon-[lucide--info] size-3" />
						也可以按 Esc 返回继续编辑
					</div>
				</Modal>

				{/* 状态切换器（骨架期评审工具） */}
				<div className="absolute bottom-3 left-3 z-50 flex items-center gap-2 rounded-card border border-border bg-surface-raised px-2 py-1.5 shadow-lg">
					<span className="text-[10px] font-medium tracking-wider text-faint uppercase">状态</span>
					<div className="flex items-center gap-0.5">
						{(
							[
								{ value: "edit", label: "编辑态" },
								{ value: "new", label: "新建态" },
								{ value: "invalid", label: "校验失败" },
								{ value: "leave", label: "未保存离开" },
							] as { value: DemoState; label: string }[]
						).map((o) => (
							<button
								key={o.value}
								type="button"
								onClick={() => applyDemo(o.value)}
								className={cn(
									"rounded px-1.5 py-0.5 text-[11px] transition-colors",
									demo === o.value ? "bg-primary/15 font-medium text-primary" : "text-muted hover:text-surface-foreground",
								)}
							>
								{o.label}
							</button>
						))}
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}

/* ---------------------------------- 零件 ---------------------------------- */

/** 非输入型分组标题（Field 只用于真正的表单控件，避免 label 抢焦点） */
function Group({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="flex items-baseline gap-1.5">
				<span className="text-[11.5px] font-medium text-surface-foreground">{label}</span>
				{hint && <span className="text-[10.5px] text-faint">{hint}</span>}
			</span>
			{children}
		</div>
	);
}

/* ---------------------------------- 逻辑 ---------------------------------- */

function findHost(hostId?: string) {
	if (!hostId) return undefined;
	return useHostsStore.getState().hosts.find((h) => h.id === hostId);
}

function toForm(host?: Host): FormState {
	return {
		name: host?.name ?? "",
		hostname: host?.hostname ?? "",
		port: String(host?.port ?? 22),
		username: host?.username ?? "",
		env: host?.env ?? "dev",
		groupId: host?.groupId ?? "",
		tags: host?.tags.join(", ") ?? "",
		authMethod: host?.auth.method ?? "key",
		password: "",
		rememberPassword: host?.auth.rememberPassword ?? false,
		keyId: host?.auth.keyId ?? sshKeys[0]?.id ?? "",
		passphrase: "",
		jumpHostIds: host?.jumpHostIds ?? [],
		encoding: host?.encoding ?? "UTF-8",
		termType: host?.termType ?? "xterm-256color",
		proxyEnabled: Boolean(host?.proxy),
		proxyType: host?.proxy?.type ?? "socks5",
		proxyHost: host?.proxy?.host ?? "127.0.0.1",
		proxyPort: String(host?.proxy?.port ?? 1080),
		envVars: host?.envVars ?? [],
		loginScript: host?.loginScript ?? "",
		colorScheme: host?.terminal?.colorScheme ?? "One Dark",
		fontFamily: host?.terminal?.fontFamily ?? "JetBrains Mono",
		fontSize: String(host?.terminal?.fontSize ?? 13),
		lineHeight: String(host?.terminal?.lineHeight ?? 1.5),
		cursorStyle: host?.terminal?.cursorStyle ?? "bar",
	};
}

/** 校验：名称 / 地址必填，端口必须是 1–65535 的整数 */
function validate(form: FormState): Record<string, string> {
	const errors: Record<string, string> = {};
	if (!form.name.trim()) errors.name = "主机显示名称不能为空";
	if (!form.hostname.trim()) errors.hostname = "连接主机地址不能为空";
	const port = Number(form.port);
	if (!/^\d+$/.test(form.port.trim()) || !Number.isInteger(port) || port < 1 || port > 65535) {
		errors.port = "端口需为 1–65535 之间的整数";
	}
	return errors;
}
