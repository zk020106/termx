export const frame = { width: 1440, height: 900, title: "连接过程" };

import { Link } from "react-router";
import { EnvPill, WindowChrome } from "../components/WindowChrome";

const steps = [
	{ name: "解析地址", detail: "10.0.3.21:22", state: "done" },
	{ name: "建立网络连接", detail: "经由跳板机 bastion-sh", state: "done" },
	{ name: "SSH 协议握手", detail: "OpenSSH 9.6p1", state: "done" },
	{ name: "用户身份认证", detail: "等待二次验证 (2FA / OTP)", state: "now" },
	{ name: "启动远程会话", detail: "打开 xterm-256color PTY", state: "wait" },
];

export default function Connect() {
	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1 flex-col bg-surface">
				{/* 顶置标签 */}
				<div className="flex h-8.5 items-end border-b border-border bg-surface-sunk px-2">
					<div className="flex h-7.5 items-center gap-2 rounded-t border-t border-x border-border bg-term px-3 text-[12px] text-surface-foreground">
						<span className="size-1.5 animate-pulse rounded-full bg-primary" />
						<span className="font-mono">order-api-01</span>
						<span className="text-[10px] text-faint">连接中…</span>
					</div>
				</div>

				{/* 遮罩背景与居中弹窗 */}
				<div className="relative min-h-0 flex-1 bg-term">
					<div className="p-4 font-mono text-[12px] text-faint">
						<div>OpenSSH_9.6p1, LibreSSL 3.3.6</div>
						<div className="text-muted">Connecting to 10.0.3.21 via proxy bastion-sh (10.0.0.4:22)...</div>
						<div className="text-muted">Connection established. Handshake completed.</div>
					</div>

					{/* 浮动居中模态卡片 (Linear 风格) */}
					<div className="absolute inset-0 flex items-center justify-center bg-term/80 backdrop-blur-sm p-4">
						<div className="w-[420px] rounded-lg border border-border bg-surface-raised p-5 shadow-2xl">
							<div className="flex items-center justify-between border-b border-border pb-3">
								<div className="flex items-center gap-2">
									<span className="icon-[lucide--server] size-4 text-primary" />
									<h1 className="text-[13px] font-semibold tracking-tight text-surface-foreground">
										连接 order-api-01
									</h1>
								</div>
								<EnvPill env="PROD" />
							</div>

							{/* 分步进度列表 */}
							<div className="mt-3.5 space-y-2">
								{steps.map((s) => (
									<div key={s.name} className="flex items-center justify-between text-[12px]">
										<div className="flex items-center gap-2">
											<StepMark state={s.state} />
											<span className={s.state === "wait" ? "text-faint" : s.state === "now" ? "font-medium text-surface-foreground" : "text-muted"}>
												{s.name}
											</span>
										</div>
										<span className="font-mono text-[11px] text-faint">{s.detail}</span>
									</div>
								))}
							</div>

							{/* 2FA 动态码输入 */}
							<div className="mt-4 rounded border border-border bg-surface p-3">
								<div className="flex items-center justify-between">
									<label className="text-[11px] font-medium text-muted">输入二次验证码 (Google Authenticator / OTP)</label>
									<span className="font-mono text-[10px] text-primary">有效时间 24s</span>
								</div>

								<div className="mt-2 flex items-center justify-between gap-1.5 font-mono">
									{["4", "8", "2", "·", "·", "·"].map((c, i) => (
										<div
											key={i}
											className={`flex size-8 items-center justify-center rounded border text-[14px] font-semibold ${
												i < 3
													? "border-primary bg-primary/10 text-surface-foreground"
													: i === 3
													? "border-primary/60 bg-surface-raised text-primary animate-pulse"
													: "border-border bg-surface text-faint"
											}`}
										>
											{c === "·" ? "" : c}
										</div>
									))}
								</div>

								<label className="mt-3 flex items-center gap-2 text-[11.5px] text-muted cursor-pointer">
									<span className="flex size-3.5 items-center justify-center rounded border border-border bg-surface-sunk" />
									<span>本次在此设备记住会话凭据（30 天）</span>
								</label>
							</div>

							{/* 操作按钮栏 */}
							<div className="mt-4 flex items-center justify-end gap-2">
								<Link
									to="/hosts"
									className="flex h-7 items-center rounded border border-border bg-surface px-2.5 text-[11.5px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground"
								>
									取消连接
								</Link>
								<Link
									to="/"
									className="flex h-7 items-center gap-1.5 rounded bg-primary px-3 text-[11.5px] font-medium text-primary-foreground shadow-sm hover:opacity-90"
								>
									<span>验证并进入终端</span>
									<span className="icon-[lucide--arrow-right] size-3" />
								</Link>
							</div>
						</div>
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}

function StepMark({ state }: { state: string }) {
	if (state === "done") {
		return (
			<span className="flex size-4 items-center justify-center rounded-full bg-success/15 text-success">
				<span className="icon-[lucide--check] size-2.5" />
			</span>
		);
	}
	if (state === "now") {
		return (
			<span className="flex size-4 items-center justify-center rounded-full bg-primary/20 text-primary">
				<span className="size-1.5 rounded-full bg-primary animate-ping" />
			</span>
		);
	}
	return <span className="size-4 rounded-full border border-border flex items-center justify-center"><span className="size-1 rounded-full bg-border" /></span>;
}
