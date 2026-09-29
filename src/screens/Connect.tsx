import { WindowChrome } from "@/components/chrome/WindowChrome";
import { closeSshSession, hasSshSession, openSshSession, sshKeyForHost, type SshOpenResult } from "@/components/terminal/sshCache";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState, StatusDot } from "@/components/ui/Display";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Overlay";
import { AUTH_LABEL, type ConnectionStatus, type Host } from "@/data/types";
import { cn } from "@/lib/cn";
import { describeProbe, probeSupported, type ProbeReport } from "@/lib/probe";
import { sshSupported, type SshPhase } from "@/lib/ssh";
import { useHostsStore } from "@/store/hosts";
import { useProbeStore } from "@/store/probe";
import { useSessionsStore } from "@/store/sessions";
import { toast } from "@/store/toast";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useNavigate, useSearchParams } from "react-router";

/* =============================================================================
 * 连接过程（路由 /connect?host=<id>）
 *
 * 只呈现真实结果：
 *  - 点「连接」之前，前两步来自 useProbeStore 对这台主机的实测 TCP 探测
 *    （浏览器内没有探测能力，如实标注「需桌面端」）。
 *  - 点「连接」之后，五步全部由 Rust 端推送的真实 SSH 阶段驱动：
 *    resolve → tcp → handshake → auth → shell，失败时收到 failed + 中文原因。
 *  - 指纹取握手阶段的真实 detail；但 known_hosts 校验与首次连接人工确认尚未实现，
 *    界面必须同时说明「当前不会阻止你连接」，不许假装校验过。
 *  - 二次验证（键盘交互）与指纹变化警告仍未接入，保留骨架并标 unwired。
 *
 * 密码只活在内存里：用来建立会话，不进主机库、不写配置文件，应用退出即消失。
 * ========================================================================== */

/** 步骤状态：unwired = 能力确实尚未接入（既非成功也非失败） */
type StepState = "done" | "failed" | "active" | "pending" | "unwired";

interface Step {
	id: string;
	label: string;
	state: StepState;
	detail: string;
}

/** 与 Rust 端 emit_phase 的 phase 名一一对应，顺序就是步骤条的顺序 */
const SSH_STAGES = ["resolve", "tcp", "handshake", "auth", "shell"] as const;
type SshStage = (typeof SSH_STAGES)[number];

const STAGE_LABEL: Record<SshStage, string> = {
	resolve: "解析地址",
	tcp: "建立 TCP 连接",
	handshake: "SSH 握手",
	auth: "认证",
	shell: "打开终端",
};

/** 会话在进入本页之前就已建立时，各步没有过程记录，只能如实说「已完成」 */
const ESTABLISHED_DETAIL: Record<SshStage, string> = {
	resolve: "已确认",
	tcp: "已连接",
	handshake: "握手已完成",
	auth: "认证已完成",
	shell: "终端已就绪",
};

/** 单个阶段收到的真实结果 */
interface StageResult {
	ok: boolean;
	detail: string;
}

interface SshProgress {
	/** 用户在本页点过「连接」：从这一刻起步骤条交给真实事件 */
	started: boolean;
	connecting: boolean;
	connected: boolean;
	/** phase 名 → 真实结果（含 failed 这一伪阶段） */
	stages: Record<string, StageResult>;
	/** 失败落在哪一步，由已收到的阶段推导 */
	failedStage: SshStage | null;
	failure: string | null;
}

const EMPTY_PROGRESS: SshProgress = {
	started: false,
	connecting: false,
	connected: false,
	stages: {},
	failedStage: null,
	failure: null,
};

/** 仍未接入、只能预览骨架的能力 */
type PreviewState = "2fa" | "fingerprint" | "changed";

const PREVIEW_OPTIONS: { value: PreviewState; label: string }[] = [
	{ value: "2fa", label: "二次验证" },
	{ value: "fingerprint", label: "首次指纹" },
	{ value: "changed", label: "指纹变化" },
];

export default function Connect() {
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const hostId = params.get("host");
	const hosts = useHostsStore((s) => s.hosts);
	const host = hosts.find((h) => h.id === hostId) ?? null;

	const probeResults = useProbeStore((s) => s.results);
	const probing = useProbeStore((s) => s.probing);
	const runProbe = useProbeStore((s) => s.run);

	/** 真实 SSH 进度：全部来自 Rust 端事件，退出即消失 */
	const [progress, setProgress] = useState<SshProgress>(EMPTY_PROGRESS);
	/** 密码只在内存里活到本次连接结束，绝不写进任何 store 或配置文件 */
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	/** 未接入能力的界面预览，与真实连接无关 */
	const [preview, setPreview] = useState<PreviewState | null>(null);
	/** 桌面端探测本身失败（Rust 端没返回结果）：既不是可达也不是不可达，如实标出来 */
	const [probeError, setProbeError] = useState<string | null>(null);
	const codeRef = useRef<HTMLInputElement>(null);

	const supported = probeSupported();
	const sshReady = sshSupported();
	const report: ProbeReport | undefined = host ? probeResults[host.id] : undefined;
	const isProbing = host ? probing.includes(host.id) : false;

	// 进入页面即对这台主机做一次真实 TCP 探测；浏览器内没有 Rust 端，跳过探测
	const hostname = host?.hostname;
	const port = host?.port;
	useEffect(() => {
		if (!hostId || !hostname || port == null || !supported) return;
		void runProbe([{ id: hostId, host: hostname, port }]).then((summary) => {
			setProbeError(summary ? null : "探测未能完成：Rust 端没有返回结果");
		});
	}, [hostId, hostname, port, supported, runProbe]);

	if (!host) {
		return (
			<WindowChrome>
				<div className="flex min-h-0 flex-1 flex-col">
					<EmptyState
						icon="icon-[lucide--server-off]"
						title={hostId ? "找不到这台主机" : "没有指定要连接的主机"}
						description={
							hostId
								? `主机库里没有 id 为 ${hostId} 的主机，它可能已经被删除。`
								: "连接页从地址栏的 ?host=<id> 取真实主机，不会自动挑一台。先去主机库选一台再发起连接。"
						}
						action={
							<Button size="sm" variant="primary" icon="icon-[lucide--server]" onClick={() => navigate("/hosts")}>
								去主机库
							</Button>
						}
					/>
				</div>
			</WindowChrome>
		);
	}

	// 本页之前就已建立、且还活着的会话（从工作区点回连接页时会走到这里）
	const sessionKey = sshKeyForHost(host.id);
	const alreadyConnected = hasSshSession(sessionKey);
	const ssh: SshProgress = alreadyConnected && !progress.connected ? { ...progress, connected: true } : progress;

	const connecting = ssh.connecting;
	const connected = ssh.connected;
	/** 真实指纹：只从握手阶段的 detail 里取，取不到就不显示 */
	const fingerprint = fingerprintOf(progress.stages.handshake?.detail);
	/** 服务器要求多因素时，界面要说明键盘交互尚未接入，而不是假装能继续 */
	const needsInteractiveAuth = Boolean(ssh.failure && ssh.failedStage === "auth" && /多因素|继续验证/.test(ssh.failure));

	const steps = buildSteps(host, report, supported, isProbing, probeError, ssh);
	const conclusion = summarize(report, supported, isProbing, probeError, ssh);
	const tabStatus: ConnectionStatus = connected
		? "connected"
		: connecting
			? "connecting"
			: ssh.failure
				? "failed"
				: report
					? report.reachable
						? "connected"
						: "failed"
					: probeError
						? "failed"
						: "connecting";
	const tabLabel = connected
		? "SSH 已连接"
		: connecting
			? "SSH 连接中…"
			: ssh.failure
				? "SSH 连接失败"
				: report
					? report.reachable
						? "TCP 已确认"
						: "TCP 不可达"
					: probeError
						? "探测失败"
						: isProbing
							? "探测中…"
							: "未探测";

	const copy = (text: string, title: string) => {
		void navigator.clipboard
			?.writeText(text)
			.then(() => toast({ title, tone: "success" }))
			.catch(() => toast({ title: "复制失败，请手动选择文本", tone: "warning" }));
	};

	const probeNow = async () => {
		if (!supported) {
			toast({ title: "浏览器内无法探测", description: "TCP 可达性由 Rust 端探测，请用 pnpm tauri:dev 启动桌面端", tone: "warning" });
			return;
		}
		const summary = await runProbe([{ id: host.id, host: host.hostname, port: host.port }]);
		if (!summary) {
			setProbeError("探测未能完成：Rust 端没有返回结果");
			toast({ title: "探测没有返回结果", description: "请稍后重试", tone: "danger" });
			return;
		}
		setProbeError(null);
		toast({
			title: summary.ok > 0 ? "TCP 可达" : "TCP 不可达",
			description: `${host.hostname}:${host.port} · TCP 可达不等于 SSH 可用`,
			tone: summary.ok > 0 ? "success" : "danger",
		});
	};

	/** 会话标签 + 进入工作区：工作区的终端会自己挂到这条 SSH 会话上 */
	const enterWorkspace = () => {
		useSessionsStore.getState().openSession(host.id);
		navigate("/");
	};

	/** 主按钮：发起真实连接。密码只在这次调用里用一次。 */
	const startConnect = async () => {
		if (connecting) return;
		if (!sshReady) {
			toast({
				title: "SSH 需要在桌面端运行",
				description: "浏览器预览里没有原生 SSH 通道，请用 pnpm tauri:dev 启动桌面端",
				tone: "warning",
			});
			return;
		}
		if (!password) {
			toast({ title: "请先输入登录密码", tone: "warning" });
			return;
		}

		setPreview(null);
		setProgress({ ...EMPTY_PROGRESS, started: true, connecting: true });

		let result: SshOpenResult;
		try {
			result = await openSshSession(
				sessionKey,
				{ host: host.hostname, port: host.port, username: host.username, password, cols: 80, rows: 24 },
				(phase: SshPhase) => setProgress((prev) => applyPhase(prev, phase)),
			);
		} catch (error) {
			// 例如原生通道不可用：如实报出，不伪造阶段
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}

		setProgress((prev) => ({
			...prev,
			connecting: false,
			connected: result.ok,
			failure: result.ok ? prev.failure : (result.error ?? prev.failure ?? "连接失败"),
		}));

		if (!result.ok) {
			toast({ title: "SSH 连接失败", description: result.error ?? "请查看失败原因", tone: "danger" });
			return;
		}

		toast({
			title: "SSH 会话已建立",
			description: `${host.username}@${host.hostname}:${host.port}`,
			tone: "success",
		});
		enterWorkspace();
	};

	const disconnect = async () => {
		setProgress({ ...EMPTY_PROGRESS });
		setPassword("");
		await closeSshSession(sessionKey);
		toast({ title: "已断开 SSH 会话", description: `${host.username}@${host.hostname}`, tone: "default" });
	};

	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1 flex-col bg-surface">
				{/* 顶置标签：进度显示在标签内部，不弹窗（需求书 07） */}
				<div className="flex h-8.5 shrink-0 items-end border-b border-border bg-surface-sunk px-2">
					<div className="flex h-7.5 items-center gap-2 rounded-t border-t border-x border-border bg-term px-3 text-[12px] text-surface-foreground">
						<StatusDot status={tabStatus} size={6} />
						<span className="font-mono">{host.name}</span>
						<span
							className={cn(
								"text-[10px]",
								tabStatus === "failed" ? "text-danger" : tabStatus === "connected" ? "text-success" : "text-faint",
							)}
						>
							{tabLabel}
						</span>
					</div>
				</div>

				{/* 终端背景 + 居中连接面板 */}
				<div className="relative min-h-0 flex-1 overflow-hidden bg-term">
					<div className="p-4 font-mono text-[12px] text-faint">
						<div>TermX 连接过程 · {host.name}</div>
						<div className="text-muted">
							目标 {host.hostname}:{host.port} · 用户 {host.username} · 认证方式 {AUTH_LABEL[host.auth.method]}
						</div>
						<div className="text-muted">
							{connected
								? "SSH 会话已建立：远端输出会在工作区终端里回放（登录横幅与首个提示符不会丢）"
								: connecting
									? `Rust 端正在推送真实阶段：${SSH_STAGES.join(" → ")}`
									: report
										? describeProbe(report)
										: !supported
											? "浏览器内没有 TCP 探测能力：用 pnpm tauri:dev 启动桌面端后会自动重测"
											: (probeError ?? (isProbing ? "正在探测 TCP 可达性…" : "等待发起连接"))}
						</div>
						{!connected && ssh.failure && <div className="text-danger">SSH：{ssh.failure}</div>}
						{!connecting && report && !report.reachable && (
							<div className="text-danger">TCP 不可达：{report.error ?? "目标端口无响应"}</div>
						)}
					</div>

					<div className="absolute inset-0 flex items-center justify-center bg-term/80 p-4 backdrop-blur-sm">
						<div className="max-h-full w-[420px] overflow-y-auto rounded-card border border-border bg-surface-raised p-5 shadow-2xl">
							<div className="flex items-center justify-between border-b border-border pb-3">
								<div className="flex items-center gap-2">
									<span className="icon-[lucide--server] size-4 text-primary" />
									<h1 className="text-[13px] font-semibold tracking-tight text-surface-foreground">连接 {host.name}</h1>
								</div>
								<span className="font-mono text-[10.5px] text-faint">端口 {host.port}</span>
							</div>

							{/* 分步进度：五步全部由真实结果驱动 */}
							<div className="mt-3.5 space-y-2">
								{steps.map((s) => (
									<div key={s.id} className="flex items-center justify-between gap-3 text-[12px]">
										<div className="flex min-w-0 items-center gap-2">
											<StepMark state={s.state} />
											<span
												className={cn(
													"truncate",
													s.state === "failed"
														? "font-medium text-danger"
														: s.state === "active"
															? "font-medium text-surface-foreground"
															: s.state === "pending" || s.state === "unwired"
																? "text-faint"
																: "text-muted",
												)}
											>
												{s.label}
											</span>
										</div>
										<span
											title={s.detail}
											className={cn(
												"max-w-[52%] shrink-0 truncate font-mono text-[11px]",
												s.state === "failed" ? "text-danger" : s.state === "pending" || s.state === "unwired" ? "text-faint" : "text-muted",
											)}
										>
											{s.detail}
										</span>
									</div>
								))}
							</div>

							{/* 结论：TCP 可达 ≠ SSH 可用；连上以后一律以真实阶段为准 */}
							<div className={cn("mt-4 rounded-control border p-3", conclusion.tone)}>
								<div className="flex items-center gap-2">
									<span className={cn("size-3.5 shrink-0", conclusion.icon)} />
									<span className="text-[12px] font-medium text-surface-foreground">{conclusion.headline}</span>
								</div>
								<p className="mt-1.5 text-[11px] leading-4 text-muted">{conclusion.body}</p>
								<div className="mt-2.5 flex items-center gap-1.5">
									<Button
										size="sm"
										icon="icon-[lucide--gauge]"
										disabled={isProbing || connecting}
										onClick={() => void probeNow()}
									>
										{isProbing ? "正在探测…" : "重新探测 TCP"}
									</Button>
									<Button size="sm" icon="icon-[lucide--pencil]" disabled={connecting} onClick={() => navigate(`/hosts/${host.id}/edit`)}>
										编辑主机
									</Button>
								</div>
							</div>

							{/* 认证：真实密码输入 + 主连接按钮 */}
							{!preview && !connected && !ssh.failure && (
								<div className="mt-4 rounded-control border border-border bg-surface p-3">
									<div className="flex items-center justify-between">
										<label htmlFor="ssh-password" className="text-[11px] font-medium text-muted">
											输入 {host.username}@{host.hostname} 的登录密码
										</label>
										<Badge className="font-mono text-[9.5px]">只存内存</Badge>
									</div>
									<Input
										id="ssh-password"
										type="password"
										value={password}
										disabled={connecting}
										autoComplete="off"
										placeholder={connecting ? "正在认证…" : "SSH 登录密码"}
										onChange={(e) => setPassword(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") void startConnect();
										}}
										className="mt-2 font-mono"
									/>
									<p className="mt-1.5 text-[10.5px] leading-4 text-faint">
										密码只用于本次连接，保存在内存里：不写进主机库、不写进配置文件，应用退出即消失。写入系统钥匙串的密码持久化尚未接入。
									</p>
									{host.auth.method !== "password" && (
										<p className="mt-1 text-[10.5px] leading-4 text-warning">
											这台主机登记的是「{AUTH_LABEL[host.auth.method]}」认证；Rust 侧目前只实现了密码认证，本次会用密码尝试。
										</p>
									)}
									{!sshReady && (
										<div className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-4 text-warning">
											<span className="icon-[lucide--laptop] mt-px size-3 shrink-0" />
											<span>SSH 需要在桌面端运行：浏览器预览里没有原生 SSH 通道，按钮已禁用，也不会伪造连接过程。</span>
										</div>
									)}
									<div className="mt-3 flex items-center gap-2">
										<Button
											size="sm"
											variant="primary"
											icon="icon-[lucide--plug-zap]"
											disabled={connecting || !sshReady || password.length === 0}
											onClick={() => void startConnect()}
										>
											{connecting ? "连接中…" : "连接"}
										</Button>
										{!connecting && password.length === 0 && sshReady && (
											<span className="text-[10.5px] text-faint">输入密码后即可发起真实连接</span>
										)}
									</div>
								</div>
							)}

							{/* 连接成功：真实指纹 + 进入工作区 */}
							{!preview && connected && (
								<div className="mt-4 rounded-control border border-success/40 bg-success/10 p-3">
									<div className="flex items-center gap-2">
										<span className="icon-[lucide--check-circle] size-3.5 shrink-0 text-success" />
										<span className="text-[12px] font-medium text-surface-foreground">SSH 会话已建立</span>
									</div>
									<p className="mt-1.5 text-[11px] leading-4 text-muted">
										{host.username}@{host.hostname}:{host.port} 的远程 shell 已就绪，进入工作区即可看到远端输出。
									</p>
									<FingerprintBlock value={fingerprint} className="mt-2.5" />
									{!fingerprint && (
										<p className="mt-1.5 text-[10.5px] leading-4 text-faint">
											这条会话是在进入本页之前建立的，本页没有握手阶段的记录，因此没有指纹可显示 —— TermX 不会补造一个。
										</p>
									)}
									<div className="mt-2.5 flex items-center gap-1.5">
										<Button size="sm" variant="primary" icon="icon-[lucide--terminal]" onClick={enterWorkspace}>
											进入工作区
										</Button>
										<Button size="sm" icon="icon-[lucide--x]" onClick={() => void disconnect()}>
											断开连接
										</Button>
										<Button size="sm" icon="icon-[lucide--pencil]" onClick={() => navigate(`/hosts/${host.id}/edit`)}>
											编辑主机
										</Button>
									</div>
								</div>
							)}

							{/* 失败态：只展示 Rust 端真实返回的原因 */}
							{!preview && !connected && ssh.failure && (
								<div className="mt-4 rounded-control border border-danger/40 bg-danger/10 p-3">
									<div className="flex items-start gap-2">
										<span className="icon-[lucide--circle-x] mt-px size-3.5 shrink-0 text-danger" />
										<div className="min-w-0 flex-1">
											<div className="text-[11.5px] font-medium text-danger">
												SSH 连接失败
												{ssh.failedStage ? ` · 失败于「${STAGE_LABEL[ssh.failedStage]}」` : ""}
											</div>
											<p className="mt-1 text-[11px] leading-4 text-muted">{ssh.failure}</p>
											<div className="selectable mt-2 rounded border border-border bg-term px-2 py-1.5 font-mono text-[10.5px] leading-4 break-all text-term-ink">
												{host.username}@{host.hostname}:{host.port}
												{"\n"}
												{ssh.failure}
											</div>
											<div className="mt-2.5 flex items-center gap-1.5">
												<Button
													size="sm"
													variant="primary"
													icon="icon-[lucide--rotate-cw]"
													disabled={connecting || !sshReady || password.length === 0}
													onClick={() => void startConnect()}
												>
													重试
												</Button>
												<Button size="sm" icon="icon-[lucide--pencil]" onClick={() => navigate(`/hosts/${host.id}/edit`)}>
													编辑主机
												</Button>
												<Button
													size="sm"
													icon="icon-[lucide--copy]"
													onClick={() =>
														copy(
															`${host.name} (${host.username}@${host.hostname}:${host.port})\n${ssh.failure ?? ""}`,
															"已复制错误信息",
														)
													}
												>
													复制错误信息
												</Button>
											</div>
										</div>
									</div>
								</div>
							)}

							{/* 二次验证：服务器真的要二次验证时才出现，并明确标注尚未接入 */}
							{(preview === "2fa" || (!preview && needsInteractiveAuth)) && (
								<TwoFactorCard code={code} onChange={setCode} inputRef={codeRef} className="mt-4" />
							)}

							{/* 首次指纹预览：有真实指纹就显示真值，没有就说没有 */}
							{preview === "fingerprint" && (
								<div className="mt-4 rounded-control border border-warning/40 bg-warning/10 p-3">
									<div className="flex items-center gap-2">
										<span className="icon-[lucide--fingerprint] size-3.5 shrink-0 text-warning" />
										<span className="text-[11.5px] font-medium text-surface-foreground">首次连接该主机，请确认指纹</span>
									</div>
									<FingerprintBlock value={fingerprint} className="mt-2" />
									<p className="mt-2 text-[10.5px] leading-4 text-muted">
										{fingerprint
											? "上面是本次连接握手阶段服务器真实返回的值，可对照服务器上的 ssh-keygen -lf 结果。"
											: "还没有握手，因此没有指纹可显示 —— 指纹只能来自服务器，TermX 不会预填或推测任何指纹值。"}
									</p>
								</div>
							)}

							{/* 指纹变化：检查逻辑尚未接入，说明清楚但不伪造任何历史记录 */}
							{preview === "changed" && (
								<div className="mt-4 rounded-control border border-danger/50 bg-danger/10 p-3">
									<div className="flex items-center gap-2">
										<span className="icon-[lucide--shield-alert] size-4 shrink-0 text-danger" />
										<span className="text-[12px] font-semibold text-danger">主机指纹变化警告</span>
										<StepMark state="unwired" />
									</div>
									<p className="mt-1.5 text-[11px] leading-4 text-muted">
										真实实现会拿服务器返回的指纹与 known_hosts 记录比对，不一致时在这里给出已记录值、本次值与上次成功连接时间。
										Rust 侧当前接受任何指纹、还没有 known_hosts 校验，所以这条警告不会触发，本页也不显示任何已记录值。
									</p>
									<div className="mt-2 flex items-center gap-2">
										<Button size="sm" variant="danger" icon="icon-[lucide--triangle-alert]" onClick={() => navigate("/hosts")}>
											中止并回到主机库
										</Button>
									</div>
								</div>
							)}

							{/* 操作按钮栏 */}
							<div className="mt-4 flex items-center justify-end gap-2">
								<Button
									size="sm"
									className="h-7 px-2.5"
									onClick={() => {
										toast({ title: `已离开连接页 ${host.name}`, tone: "default" });
										navigate("/hosts");
									}}
								>
									返回主机库
								</Button>
								<Button
									size="sm"
									icon="icon-[lucide--gauge]"
									className="h-7 px-3"
									disabled={isProbing || connecting}
									onClick={() => void probeNow()}
								>
									{isProbing ? "正在探测…" : "重新探测 TCP"}
								</Button>
							</div>
						</div>
					</div>
				</div>

				{/* 首次连接确认指纹：有真实指纹就显示真值，没有就如实说明 */}
				<Modal
					open={preview === "fingerprint"}
					onClose={() => setPreview(null)}
					title="首次连接该主机，请确认指纹"
					icon="icon-[lucide--fingerprint]"
					width={430}
					footer={
						<Button size="sm" onClick={() => setPreview(null)}>
							关闭
						</Button>
					}
				>
					<p>
						TermX 会在 SSH 握手时拿到 <span className="font-mono text-surface-foreground">{host.hostname}</span> 的主机密钥，
						把 SHA256 指纹显示在这里。
					</p>
					<FingerprintBlock value={fingerprint} className="mt-2" />
					<div className="mt-2.5 flex items-start gap-1.5 text-[10.5px] leading-4 text-warning">
						<span className="icon-[lucide--triangle-alert] mt-px size-3 shrink-0" />
						指纹只能来自服务器，TermX 不会预填或推测任何指纹值；首次连接的人工确认与 known_hosts 写入也尚未接入。
					</div>
				</Modal>

				{/* 未接入能力预览：真实流程走不到的状态，保留骨架以便逐条评审 */}
				<div className="absolute right-3 bottom-3 z-[60] flex items-center gap-2 rounded-card border border-border bg-surface-raised px-2 py-1.5 shadow-lg">
					<span className="text-[10px] font-medium tracking-wider text-faint uppercase">未接入能力</span>
					<div className="flex items-center gap-0.5">
						{PREVIEW_OPTIONS.map((o) => (
							<button
								key={o.value}
								type="button"
								onClick={() => setPreview((current) => (current === o.value ? null : o.value))}
								className={cn(
									"rounded px-1.5 py-0.5 text-[11px] transition-colors",
									preview === o.value ? "bg-primary/15 font-medium text-primary" : "text-muted hover:text-surface-foreground",
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

/* ---------------------------------- 逻辑 ---------------------------------- */

function isSshStage(phase: string): phase is SshStage {
	return (SSH_STAGES as readonly string[]).includes(phase);
}

/** 失败落在哪一步：优先取自带 ok:false 的阶段，否则是最后一个成功阶段的下一步 */
function stageOfFailure(stages: Record<string, StageResult>): SshStage | null {
	for (const stage of SSH_STAGES) {
		const result = stages[stage];
		if (result && !result.ok) return stage;
	}
	const lastOk = [...SSH_STAGES].reverse().find((stage) => stages[stage]?.ok);
	const index = lastOk ? SSH_STAGES.indexOf(lastOk) + 1 : 0;
	return SSH_STAGES[index] ?? null;
}

/** 把一条真实阶段事件并入进度 */
function applyPhase(progress: SshProgress, phase: SshPhase): SshProgress {
	const stages = { ...progress.stages, [phase.phase]: { ok: phase.ok, detail: phase.detail } };
	if (phase.phase === "failed") {
		return { ...progress, stages, failure: phase.detail, failedStage: stageOfFailure(stages) };
	}
	if (!phase.ok) {
		return {
			...progress,
			stages,
			failure: phase.detail,
			failedStage: isSshStage(phase.phase) ? phase.phase : progress.failedStage,
		};
	}
	return { ...progress, stages };
}

/** 从握手阶段的真实 detail 里取指纹（Rust 端形如「主机指纹 SHA256:...」）；取不到就原样返回，不编造 */
function fingerprintOf(detail: string | undefined): string | null {
	if (!detail) return null;
	const match = /SHA256:[A-Za-z0-9+/=]+/.exec(detail);
	return match ? match[0] : detail;
}

/** 用真实结果推导分步进度：未发起 SSH 时前两步看 TCP 探测，发起后五步全看 SSH 阶段 */
function buildSteps(
	host: Host,
	report: ProbeReport | undefined,
	supported: boolean,
	probing: boolean,
	probeError: string | null,
	ssh: SshProgress,
): Step[] {
	const sshDriven = ssh.started || ssh.connected;
	const probeDetail = !supported ? "需桌面端" : probing ? "正在探测…" : probeError ? "探测失败" : "等待探测";
	const probeState: StepState = probing ? "active" : probeError ? "failed" : "pending";
	const nextStage = SSH_STAGES.find((stage) => !ssh.stages[stage]);

	const sshStep = (id: SshStage, label: string): Step => {
		const result = ssh.stages[id];
		if (result) return { id, label, state: result.ok ? "done" : "failed", detail: result.detail };
		if (ssh.connected) return { id, label, state: "done", detail: ESTABLISHED_DETAIL[id] };
		if (ssh.failedStage === id) return { id, label, state: "failed", detail: ssh.failure ?? "连接失败" };
		// 有一步失败了：这一步没走到，如实留 pending，不写「尚未接入」也不写成功
		if (ssh.failedStage) return { id, label, state: "pending", detail: "未走到这一步" };
		if (ssh.connecting) {
			return id === nextStage
				? { id, label, state: "active", detail: "进行中…" }
				: { id, label, state: "pending", detail: "等待上一步" };
		}
		return { id, label, state: "pending", detail: "等待连接" };
	};

	const resolve: Step = sshDriven
		? sshStep("resolve", STAGE_LABEL.resolve)
		: report
			? { id: "resolve", label: STAGE_LABEL.resolve, state: "done", detail: `目标 ${report.host}:${report.port}` }
			: { id: "resolve", label: STAGE_LABEL.resolve, state: probeState, detail: probeDetail };

	const tcp: Step = sshDriven
		? sshStep("tcp", STAGE_LABEL.tcp)
		: report
			? report.reachable
				? { id: "tcp", label: STAGE_LABEL.tcp, state: "done", detail: `TCP ${Math.round(report.avg_ms)} ms` }
				: { id: "tcp", label: STAGE_LABEL.tcp, state: "failed", detail: report.error ?? "TCP 不可达" }
			: { id: "tcp", label: STAGE_LABEL.tcp, state: probeState, detail: probeDetail };

	return [
		resolve,
		tcp,
		sshStep("handshake", STAGE_LABEL.handshake),
		sshStep("auth", `认证 · ${AUTH_LABEL[host.auth.method]}`),
		sshStep("shell", STAGE_LABEL.shell),
	];
}

interface Conclusion {
	tone: string;
	icon: string;
	headline: string;
	body: string;
}

/** 顶部结论卡片的文案：优先讲真实 SSH 结果，其次讲 TCP 探测，都不伪造 */
function summarize(
	report: ProbeReport | undefined,
	supported: boolean,
	probing: boolean,
	probeError: string | null,
	ssh: SshProgress,
): Conclusion {
	if (ssh.connected) {
		return {
			tone: "border-success/40 bg-success/10",
			icon: "icon-[lucide--check-circle] text-success",
			headline: "SSH 会话已建立",
			body: "远程 shell 已就绪，进入工作区即可看到远端输出；服务器返回的主机指纹在下方。",
		};
	}
	if (ssh.connecting) {
		return {
			tone: "border-primary/40 bg-primary/10",
			icon: "icon-[lucide--circle-dashed] text-primary",
			headline: "正在建立 SSH 会话",
			body: `下面五步由 Rust 端真实推送的阶段驱动：${SSH_STAGES.join(" → ")}。`,
		};
	}
	if (ssh.failure) {
		return {
			tone: "border-danger/40 bg-danger/10",
			icon: "icon-[lucide--circle-x] text-danger",
			headline: ssh.failedStage ? `SSH 连接失败 · 失败于「${STAGE_LABEL[ssh.failedStage]}」` : "SSH 连接失败",
			body: ssh.failure,
		};
	}
	if (report && !report.reachable) {
		return {
			tone: "border-danger/40 bg-danger/10",
			icon: "icon-[lucide--circle-x] text-danger",
			headline: "TCP 不可达；尚未发起 SSH 连接",
			body: report.error ?? "目标端口无响应，请检查安全组、防火墙或跳板机路由。",
		};
	}
	if (report) {
		return {
			tone: "border-success/40 bg-success/10",
			icon: "icon-[lucide--check-circle] text-success",
			headline: "TCP 可达性已确认；尚未发起 SSH 连接",
			body: `${describeProbe(report)}。TCP 能连上并不代表 SSH 一定可用，填好密码点「连接」用真实握手确认。`,
		};
	}
	if (!supported) {
		return {
			tone: "border-border bg-surface",
			icon: "icon-[lucide--circle-dashed] text-faint",
			headline: "浏览器内无法确认 TCP 可达性，也无法发起 SSH 连接",
			body: "TCP 探测与 SSH 都跑在 Rust 端，请用 pnpm tauri:dev 启动桌面端。",
		};
	}
	if (probeError) {
		return {
			tone: "border-warning/40 bg-warning/10",
			icon: "icon-[lucide--triangle-alert] text-warning",
			headline: "TCP 探测没有完成；尚未发起 SSH 连接",
			body: probeError,
		};
	}
	return {
		tone: "border-border bg-surface",
		icon: "icon-[lucide--circle-dashed] text-faint",
		headline: probing ? "正在探测 TCP 可达性…" : "TCP 可达性尚未确认；尚未发起 SSH 连接",
		body: probing ? "探测结果会显示在步骤条的前两步。" : "可以先探测 TCP，也可以直接填密码发起真实 SSH 连接。",
	};
}

/* ---------------------------------- 零件 ---------------------------------- */

/** 骨架态共用的提醒：这些能力为什么还不能用 */
function UnwiredNote({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				"flex items-start gap-2 rounded-control border border-border bg-surface p-3 text-[11px] leading-4 text-muted",
				className,
			)}
		>
			<StepMark state="unwired" />
			<span>{children}</span>
		</div>
	);
}

/** 真实指纹 + 未实现的信任策略：两者必须一起出现，否则会让人以为做过校验 */
function FingerprintBlock({ value, className }: { value: string | null; className?: string }) {
	return (
		<div className={cn("rounded-control border border-border bg-surface-sunk p-2.5", className)}>
			<div className="flex items-center gap-1.5 text-[10.5px] font-medium text-muted">
				<span className="icon-[lucide--fingerprint] size-3 shrink-0" />
				服务器返回的主机指纹
			</div>
			<div className="mt-1.5 font-mono text-[11px] leading-4 break-all text-surface-foreground">
				{value ?? "尚未握手，没有指纹可显示"}
			</div>
			<div className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-4 text-warning">
				<span className="icon-[lucide--triangle-alert] mt-px size-3 shrink-0" />
				<span>已显示服务器返回的真实指纹；known_hosts 校验与首次连接人工确认尚未实现，当前不会阻止你连接。</span>
			</div>
		</div>
	);
}

/** 二次验证（键盘交互）：Rust 侧尚未实现，这里只保留骨架并如实标注 */
function TwoFactorCard({
	code,
	onChange,
	inputRef,
	className,
}: {
	code: string;
	onChange: (value: string) => void;
	inputRef: RefObject<HTMLInputElement | null>;
	className?: string;
}) {
	return (
		<div className={cn("rounded-control border border-border bg-surface p-3", className)}>
			<div className="flex items-center justify-between">
				<label className="text-[11px] font-medium text-muted">输入二次验证码 (Google Authenticator / OTP)</label>
				<span className="flex items-center gap-1.5">
					<Badge className="font-mono text-[9.5px]">尚未接入</Badge>
					<StepMark state="unwired" />
				</span>
			</div>

			<div className="mt-2 flex items-center justify-between gap-1.5 font-mono" onClick={() => inputRef.current?.focus()}>
				{Array.from({ length: 6 }).map((_, i) => {
					const char = code[i];
					return (
						<div
							key={i}
							className={cn(
								"flex size-8 items-center justify-center rounded border text-[14px] font-semibold",
								char ? "border-primary bg-primary/10 text-surface-foreground" : "border-border bg-surface text-faint",
							)}
						>
							{char ?? ""}
						</div>
					);
				})}
			</div>

			{/* 真正的键盘输入源：隐藏输入框，支持退格、粘贴与输入法 */}
			<input
				ref={inputRef}
				value={code}
				inputMode="numeric"
				autoComplete="one-time-code"
				aria-label="二次验证码"
				onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
				className="sr-only"
			/>

			<UnwiredNote className="mt-3">
				键盘交互认证（Keyboard-Interactive）尚未在 Rust 侧实现：服务器要求二次验证时，TermX 现在只能如实报出失败；这个输入框不参与任何提交，也不会被保存。
			</UnwiredNote>
		</div>
	);
}

function StepMark({ state }: { state: StepState }) {
	if (state === "done") {
		return (
			<span className="flex size-4 items-center justify-center rounded-full bg-success/15 text-success">
				<span className="icon-[lucide--check] size-2.5" />
			</span>
		);
	}
	if (state === "active") {
		return (
			<span className="flex size-4 items-center justify-center rounded-full bg-primary/20 text-primary">
				<span className="size-1.5 animate-ping rounded-full bg-primary" />
			</span>
		);
	}
	if (state === "failed") {
		return (
			<span className="flex size-4 items-center justify-center rounded-full bg-danger/20 text-danger">
				<span className="icon-[lucide--x] size-2.5" />
			</span>
		);
	}
	if (state === "unwired") {
		return (
			<span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-faint">
				<span className="icon-[lucide--minus] size-2.5" />
			</span>
		);
	}
	return (
		<span className="flex size-4 items-center justify-center rounded-full border border-border">
			<span className="size-1 rounded-full bg-border" />
		</span>
	);
}
