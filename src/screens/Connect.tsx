import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { EmptyState, StatusDot } from "@/components/ui/Display";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Toggle";
import { Modal } from "@/components/ui/Overlay";
import { connectionSteps } from "@/data/mock";
import { cn } from "@/lib/cn";
import { useHostsStore } from "@/store/hosts";
import { toast } from "@/store/toast";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { ConnectionStep, StepState } from "@/data/types";

/* 连接过程（对应 termx.vetd/frames/connect.tsx）。
 * 覆盖状态（需求书 06 / 07-连接流程）：分步进度、输入密码（记住密码默认不勾）、
 * 二次验证码（键盘交互）、首次指纹确认、指纹变化警告、各步骤失败态（重试 / 编辑主机 / 复制错误信息）。 */

type DemoState = "progress" | "password" | "2fa" | "fingerprint" | "changed" | "failed";

const DEMO_OPTIONS: { value: DemoState; label: string }[] = [
	{ value: "progress", label: "分步进度" },
	{ value: "password", label: "输入密码" },
	{ value: "2fa", label: "二次验证" },
	{ value: "fingerprint", label: "首次指纹" },
	{ value: "changed", label: "指纹变化" },
	{ value: "failed", label: "连接失败" },
];

/** 各步骤的失败原因（需求书 07：在出错的那一步给出原因和操作按钮） */
const FAILURES: Record<string, { title: string; hint: string; raw: string }> = {
	connect: {
		title: "建立 TCP 连接超时",
		hint: "目标端口 22 无响应，检查安全组、防火墙或跳板机路由。",
		raw: "connect to host 10.0.3.21 port 22: Connection timed out\ntcp_connect: timeout after 15000ms",
	},
	handshake: {
		title: "SSH 握手失败",
		hint: "两端没有协商出共同的算法组合，或被中间网络设备重置了连接。",
		raw: "kex_exchange_identification: read: Connection reset by peer\nssh_dispatch_run_fatal: Connection to 10.0.3.21 port 22",
	},
	auth: {
		title: "用户身份认证失败",
		hint: "服务器拒绝了当前密钥；若走跳板机，请确认 bastion-sh 的口令是否正确。",
		raw: "deploy@10.0.3.21: Permission denied (publickey).\n跳板机 bastion-sh: authentication failed for key ops@bastion",
	},
	shell: {
		title: "无法打开远程会话",
		hint: "PTY 申请被拒绝，可能已达到服务器 MaxSessions / MaxStartups 上限。",
		raw: "PTY allocation request failed on channel 0\nshell request failed on channel 0",
	},
};

const FAIL_STEPS = ["connect", "handshake", "auth", "shell"];

const FINGERPRINT = {
	sha256: "SHA256:9f2c4b81d0a7e35c6ff1b2904c7ad83e2a5b190f7c4e6d38a1b0c9f2e7d4a71b",
	md5: "a3:1f:9c:04:7e:b2:5d:88:11:cf:6a:23:90:4b:de:71",
	known: "SHA256:41ba0cd97e2f8a15b3c6d2049f7e35a8c1b0d9e4f76a2c38b5d1e0f9a7c4b26d",
};

export default function Connect() {
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const hosts = useHostsStore((s) => s.hosts);
	const host = hosts.find((h) => h.id === params.get("host")) ?? hosts[0];
	const jump = hosts.find((h) => host?.jumpHostIds.includes(h.id));

	/* 默认停在设计稿那一帧：二次验证码（需求书 07-连接流程的必经步骤） */
	const [demo, setDemo] = useState<DemoState>("2fa");
	const [password, setPassword] = useState("");
	const [remember, setRemember] = useState(false);
	const [code, setCode] = useState("482");
	const [error, setError] = useState("");
	const [seconds, setSeconds] = useState(30);
	const [failStep, setFailStep] = useState("auth");
	const [showKnown, setShowKnown] = useState(false);
	const codeRef = useRef<HTMLInputElement>(null);

	/* OTP 有效期倒计时 */
	useEffect(() => {
		if (demo !== "2fa") return;
		const timer = window.setInterval(() => setSeconds((s) => (s <= 1 ? 30 : s - 1)), 1000);
		return () => window.clearInterval(timer);
	}, [demo]);

	if (!host) {
		return (
			<WindowChrome>
				<div className="min-h-0 flex-1">
					<EmptyState
						icon="icon-[lucide--server-off]"
						title="没有可连接的主机"
						description="先去主机库新建一台主机，再回到这里发起连接。"
						action={
							<Button size="sm" variant="primary" icon="icon-[lucide--plus]" onClick={() => navigate("/hosts/new")}>
								新建主机
							</Button>
						}
					/>
				</div>
			</WindowChrome>
		);
	}

	const failure = FAILURES[failStep] ?? FAILURES.auth;
	const steps = buildSteps(demo, failStep);
	const tabStatus = demo === "failed" ? "failed" : "connecting";
	const tabLabel = demo === "failed" ? "连接失败" : demo === "fingerprint" || demo === "changed" ? "校验指纹…" : "连接中…";

	const copy = (text: string, title: string) => {
		void navigator.clipboard
			?.writeText(text)
			.then(() => toast({ title, tone: "success" }))
			.catch(() => toast({ title: "复制失败，请手动选择文本", tone: "warning" }));
	};

	const enterTerminal = () => {
		toast({ title: `已连接 ${host.name}`, description: `${host.username}@${host.hostname}:${host.port}`, tone: "success" });
		navigate("/");
	};

	const submitPassword = () => {
		if (!password) {
			setError("请输入登录密码");
			return;
		}
		setError("");
		toast({ title: "密码已提交，等待服务器验证", tone: "default" });
		setDemo("2fa");
	};

	const submitCode = () => {
		if (code.length !== 6) {
			setError("请输入 6 位验证码");
			return;
		}
		setError("");
		enterTerminal();
	};

	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1 flex-col bg-surface">
				{/* 顶置标签：进度显示在标签内部，不弹窗（需求书 07） */}
				<div className="flex h-8.5 shrink-0 items-end border-b border-border bg-surface-sunk px-2">
					<div className="flex h-7.5 items-center gap-2 rounded-t border-t border-x border-border bg-term px-3 text-[12px] text-surface-foreground">
						<StatusDot status={tabStatus} size={6} />
						<span className="font-mono">{host.name}</span>
						<span className={cn("text-[10px]", demo === "failed" ? "text-danger" : "text-faint")}>{tabLabel}</span>
					</div>
				</div>

				{/* 终端背景 + 居中连接面板 */}
				<div className="relative min-h-0 flex-1 overflow-hidden bg-term">
					<div className="p-4 font-mono text-[12px] text-faint">
						<div>OpenSSH_9.6p1, LibreSSL 3.3.6</div>
						<div className="text-muted">
							{jump
								? `Connecting to ${host.hostname} via proxy ${jump.name} (${jump.hostname}:${jump.port})...`
								: `Connecting to ${host.hostname}:${host.port}...`}
						</div>
						<div className="text-muted">Connection established. Handshake completed.</div>
						{demo === "failed" && <div className="text-danger">Connection failed: {failure.title}</div>}
						{demo === "fingerprint" || demo === "changed" ? (
							<div className="text-warning">Host key verification in progress...</div>
						) : null}
					</div>

					<div className="absolute inset-0 flex items-center justify-center bg-term/80 p-4 backdrop-blur-sm">
						<div className="w-[420px] rounded-card border border-border bg-surface-raised p-5 shadow-2xl">
							<div className="flex items-center justify-between border-b border-border pb-3">
								<div className="flex items-center gap-2">
									<span className="icon-[lucide--server] size-4 text-primary" />
									<h1 className="text-[13px] font-semibold tracking-tight text-surface-foreground">连接 {host.name}</h1>
								</div>
								<span className="font-mono text-[10.5px] text-faint">端口 {host.port}</span>
							</div>

							{/* 分步进度（connectionSteps） */}
							<div className="mt-3.5 space-y-2">
								{steps.map((s) => (
									<div key={s.id} className="flex items-center justify-between gap-3 text-[12px]">
										<div className="flex min-w-0 items-center gap-2">
											<StepMark state={s.state} />
											<span
												className={cn(
													"truncate",
													s.state === "pending"
														? "text-faint"
														: s.state === "failed"
															? "font-medium text-danger"
															: s.state === "active"
																? "font-medium text-surface-foreground"
																: "text-muted",
												)}
											>
												{s.label}
											</span>
										</div>
										<span className={cn("shrink-0 font-mono text-[11px]", s.state === "failed" ? "text-danger" : "text-faint")}>
											{s.state === "failed" ? `${failure.title}` : s.detail}
										</span>
									</div>
								))}
							</div>

							{/* 分步进度态：说明进度不阻塞其它标签 */}
							{demo === "progress" && (
								<div className="mt-4 flex items-start gap-2 rounded-control border border-border bg-surface p-3 text-[11px] text-muted">
									<span className="icon-[lucide--info] mt-px size-3.5 shrink-0 text-primary" />
									<span>进度显示在标签内部，连接期间可以切换到其他标签继续工作，不会中断。</span>
								</div>
							)}

							{/* 输入密码：记住密码默认不勾选（需求书 07） */}
							{demo === "password" && (
								<div className="mt-4 rounded-control border border-border bg-surface p-3">
									<label className="text-[11px] font-medium text-muted">输入 {host.username}@{host.hostname} 的登录密码</label>
									<Input
										type="password"
										autoFocus
										value={password}
										onChange={(e) => {
											setPassword(e.target.value);
											setError("");
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") submitPassword();
										}}
										placeholder="••••••••"
										className="mt-2 font-mono"
									/>
									{error && (
										<div className="mt-1.5 flex items-center gap-1 text-[10.5px] text-danger">
											<span className="icon-[lucide--circle-alert] size-3" />
											{error}
										</div>
									)}
									<Checkbox
										className="mt-3"
										checked={remember}
										onChange={setRemember}
										label="记住密码"
										description="默认不勾选；勾选后凭据写入系统钥匙串，仅在本次设备生效。"
									/>
								</div>
							)}

							{/* 二次验证码：键盘直接输入，支持退格与粘贴 */}
							{demo === "2fa" && (
								<div className="mt-4 rounded-control border border-border bg-surface p-3">
									<div className="flex items-center justify-between">
										<label className="text-[11px] font-medium text-muted">输入二次验证码 (Google Authenticator / OTP)</label>
										<span className="font-mono text-[10px] text-primary">有效时间 {seconds}s</span>
									</div>

									<div
										className="mt-2 flex items-center justify-between gap-1.5 font-mono"
										onClick={() => codeRef.current?.focus()}
									>
										{Array.from({ length: 6 }).map((_, i) => {
											const char = code[i];
											const cursor = i === code.length;
											return (
												<div
													key={i}
													className={cn(
														"flex size-8 items-center justify-center rounded border text-[14px] font-semibold",
														char
															? "border-primary bg-primary/10 text-surface-foreground"
															: cursor
																? "animate-pulse border-primary/60 bg-surface-raised text-primary"
																: "border-border bg-surface text-faint",
													)}
												>
													{char ?? ""}
												</div>
											);
										})}
									</div>

									{/* 真正的键盘输入源：隐藏输入框，支持退格、粘贴与输入法 */}
									<input
										ref={codeRef}
										autoFocus
										value={code}
										inputMode="numeric"
										autoComplete="one-time-code"
										aria-label="二次验证码"
										onChange={(e) => {
											setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
											setError("");
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") submitCode();
										}}
										className="sr-only"
									/>

									{error && (
										<div className="mt-2 flex items-center gap-1 text-[10.5px] text-danger">
											<span className="icon-[lucide--circle-alert] size-3" />
											{error}
										</div>
									)}

									<Checkbox
										className="mt-3"
										checked={remember}
										onChange={setRemember}
										label="本次在此设备记住会话凭据（30 天）"
										description="默认不勾选；验证码本身不会被保存。"
									/>
								</div>
							)}

							{/* 首次指纹确认：等待模态框确认 */}
							{demo === "fingerprint" && (
								<div className="mt-4 flex items-start gap-2 rounded-control border border-warning/40 bg-warning/10 p-3 text-[11px] text-muted">
									<span className="icon-[lucide--fingerprint] mt-px size-3.5 shrink-0 text-warning" />
									<span>这是首次连接该主机，请在弹出的窗口中核对 SHA256 指纹后再继续。</span>
								</div>
							)}

							{/* 指纹变化：醒目的红色警告（需求书 07 / 05-B 主机指纹） */}
							{demo === "changed" && (
								<div className="mt-4 rounded-control border border-danger/50 bg-danger/10 p-3">
									<div className="flex items-center gap-2">
										<span className="icon-[lucide--shield-alert] size-4 shrink-0 text-danger" />
										<span className="text-[12px] font-semibold text-danger">主机指纹已变化，可能存在中间人攻击</span>
									</div>
									<p className="mt-1.5 text-[11px] leading-4 text-muted">
										服务器返回的指纹与 known_hosts 中记录的不一致。这可能是服务器重装或密钥轮换，也可能是有人正在中间转发你的连接并窃取凭据。
									</p>
									<div className="mt-2 space-y-1 font-mono text-[10.5px]">
										<div className="flex items-center gap-2 rounded border border-border bg-surface px-2 py-1">
											<span className="text-faint">已记录</span>
											<span className="truncate text-muted">{FINGERPRINT.known}</span>
										</div>
										<div className="flex items-center gap-2 rounded border border-danger/40 bg-surface px-2 py-1">
											<span className="text-danger">本次</span>
											<span className="truncate text-danger">{FINGERPRINT.sha256}</span>
										</div>
									</div>
									{showKnown && (
										<div className="mt-2 space-y-1 border-t border-border pt-2 text-[10.5px] text-faint">
											<div>MD5：{FINGERPRINT.md5}</div>
											<div>上次成功连接：order-api-01 · 2026-09-24 16:41</div>
											<div>记录位置：~/.ssh/known_hosts 第 42 行（由 TermX 管理）</div>
										</div>
									)}
									<div className="mt-2 flex items-center gap-2">
										<button
											type="button"
											onClick={() => setShowKnown((v) => !v)}
											className="text-[11px] font-medium text-primary hover:underline"
										>
											{showKnown ? "收起详情" : "查看详情"}
										</button>
										<button
											type="button"
											onClick={() => copy(FINGERPRINT.sha256, "已复制本次指纹")}
											className="text-[11px] text-muted hover:text-surface-foreground"
										>
											复制指纹
										</button>
									</div>
								</div>
							)}

							{/* 失败态：原因 + 重试 / 编辑主机 / 复制错误信息 */}
							{demo === "failed" && (
								<div className="mt-4 rounded-control border border-danger/40 bg-danger/10 p-3">
									<div className="flex items-start gap-2">
										<span className="icon-[lucide--circle-x] mt-px size-3.5 shrink-0 text-danger" />
										<div className="min-w-0 flex-1">
											<div className="text-[11.5px] font-medium text-danger">{failure.title}</div>
											<p className="mt-1 text-[11px] leading-4 text-muted">{failure.hint}</p>
											<div className="selectable mt-2 rounded border border-border bg-term px-2 py-1.5 font-mono text-[10.5px] leading-4 break-all text-term-ink">
												{failure.raw}
											</div>
											<div className="mt-2.5 flex items-center gap-1.5">
												<Button
													size="sm"
													variant="primary"
													icon="icon-[lucide--rotate-cw]"
													onClick={() => {
														setDemo("progress");
														toast({ title: "正在重试连接…", tone: "default" });
													}}
												>
													重试
												</Button>
												<Button size="sm" icon="icon-[lucide--pencil]" onClick={() => navigate(`/hosts/${host.id}/edit`)}>
													编辑主机
												</Button>
												<Button
													size="sm"
													icon="icon-[lucide--copy]"
													onClick={() => copy(`${failure.title}\n${failure.raw}`, "已复制错误信息")}
												>
													复制错误信息
												</Button>
											</div>
										</div>
									</div>
								</div>
							)}

							{/* 操作按钮栏 */}
							<div className="mt-4 flex items-center justify-end gap-2">
								<Button
									size="sm"
									className="h-7 px-2.5"
									onClick={() => {
										toast({ title: `已取消连接 ${host.name}`, tone: "default" });
										navigate("/hosts");
									}}
								>
									{demo === "changed" ? "中止连接" : "取消连接"}
								</Button>

								{demo === "progress" && (
									<Button
										size="sm"
										variant="primary"
										icon="icon-[lucide--arrow-right]"
										className="h-7 px-3"
										onClick={() => {
											toast({ title: "连接将在后台继续", tone: "default" });
											navigate("/");
										}}
									>
										后台连接
									</Button>
								)}

								{demo === "password" && (
									<Button size="sm" variant="primary" icon="icon-[lucide--arrow-right]" className="h-7 px-3" onClick={submitPassword}>
										连接
									</Button>
								)}

								{demo === "2fa" && (
									<Button size="sm" variant="primary" icon="icon-[lucide--arrow-right]" className="h-7 px-3" onClick={submitCode}>
										验证并进入终端
									</Button>
								)}

								{demo === "fingerprint" && (
									<Button size="sm" variant="primary" className="h-7 px-3" onClick={() => setDemo("fingerprint")}>
										等待指纹确认…
									</Button>
								)}

								{demo === "changed" && (
									<Button
										size="sm"
										variant="danger"
										icon="icon-[lucide--triangle-alert]"
										className="h-7 px-3"
										onClick={() => {
											toast({ title: "已忽略指纹变化并继续连接", description: "风险自负：请确认这是预期的密钥轮换", tone: "warning" });
											enterTerminal();
										}}
									>
										仍然继续
									</Button>
								)}

								{demo === "failed" && (
									<Button
										size="sm"
										variant="primary"
										icon="icon-[lucide--rotate-cw]"
										className="h-7 px-3"
										onClick={() => setDemo("progress")}
									>
										重试
									</Button>
								)}
							</div>
						</div>
					</div>
				</div>

				{/* 首次连接：确认主机指纹（模态框，需求书 03-2） */}
				<Modal
					open={demo === "fingerprint"}
					onClose={() => setDemo("progress")}
					title="首次连接该主机，请确认指纹"
					icon="icon-[lucide--fingerprint]"
					width={430}
					footer={
						<>
							<Button size="sm" onClick={() => setDemo("progress")}>
								取消
							</Button>
							<Button size="sm" icon="icon-[lucide--copy]" onClick={() => copy(FINGERPRINT.sha256, "已复制指纹")}>
								复制指纹
							</Button>
							<Button size="sm" variant="primary" icon="icon-[lucide--shield-check]" onClick={enterTerminal}>
								信任并继续
							</Button>
						</>
					}
				>
					<p>
						这是 TermX 第一次连接 <span className="font-mono text-surface-foreground">{host.hostname}</span>，请与服务器管理员核对下面的
						SHA256 指纹，确认无误后会写入 known_hosts。
					</p>
					<div className="selectable mt-2 rounded-control border border-border bg-surface-sunk px-2.5 py-2 font-mono text-[11px] break-all text-surface-foreground">
						{FINGERPRINT.sha256}
					</div>
					<div className="mt-2 space-y-0.5 font-mono text-[10.5px] text-faint">
						<div>MD5：{FINGERPRINT.md5}</div>
						<div>
							算法：ssh-ed25519 · 服务器：{host.hostname}:{host.port}
						</div>
					</div>
					<div className="mt-2.5 flex items-start gap-1.5 text-[10.5px] text-warning">
						<span className="icon-[lucide--triangle-alert] mt-px size-3 shrink-0" />
						指纹不一致时不要继续，中间人可能正在窃听这次连接。
					</div>
				</Modal>

				{/* 状态切换器（骨架期评审工具） */}
				<div className="absolute right-3 bottom-3 z-[60] flex items-center gap-2 rounded-card border border-border bg-surface-raised px-2 py-1.5 shadow-lg">
					<span className="text-[10px] font-medium tracking-wider text-faint uppercase">状态</span>
					<div className="flex items-center gap-0.5">
						{DEMO_OPTIONS.map((o) => (
							<button
								key={o.value}
								type="button"
								onClick={() => {
									setError("");
									setDemo(o.value);
									if (o.value === "fingerprint") setShowKnown(false);
								}}
								className={cn(
									"rounded px-1.5 py-0.5 text-[11px] transition-colors",
									demo === o.value ? "bg-primary/15 font-medium text-primary" : "text-muted hover:text-surface-foreground",
								)}
							>
								{o.label}
							</button>
						))}
					</div>
					{demo === "failed" && (
						<>
							<span className="h-4 w-px bg-border" />
							<span className="text-[10px] font-medium tracking-wider text-faint uppercase">失败步骤</span>
							<div className="flex items-center gap-0.5">
								{FAIL_STEPS.map((id) => (
									<button
										key={id}
										type="button"
										onClick={() => setFailStep(id)}
										className={cn(
											"rounded px-1.5 py-0.5 font-mono text-[10.5px] transition-colors",
											failStep === id ? "bg-danger/15 font-medium text-danger" : "text-muted hover:text-surface-foreground",
										)}
									>
										{connectionSteps.find((s) => s.id === id)?.label ?? id}
									</button>
								))}
							</div>
						</>
					)}
				</div>
			</div>
		</WindowChrome>
	);
}

/* ---------------------------------- 零件 ---------------------------------- */

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
	return (
		<span className="flex size-4 items-center justify-center rounded-full border border-border">
			<span className="size-1 rounded-full bg-border" />
		</span>
	);
}

/** 用 mock 的 connectionSteps 推导当前分步进度；失败态标出出错的那一步 */
function buildSteps(demo: DemoState, failStep: string): ConnectionStep[] {
	const failIndex = connectionSteps.findIndex((s) => s.id === failStep);
	const activeIndex =
		demo === "fingerprint" || demo === "changed"
			? Math.max(connectionSteps.length - 1, 0)
			: connectionSteps.findIndex((s) => s.state === "active");

	return connectionSteps.map((s, i) => {
		if (demo === "failed") {
			if (i < failIndex) return { ...s, state: "done" };
			if (i === failIndex) return { ...s, state: "failed" };
			return { ...s, state: "pending" };
		}
		if (i < activeIndex) return { ...s, state: "done" };
		if (i === activeIndex) return { ...s, state: "active" };
		return { ...s, state: "pending" };
	});
}
