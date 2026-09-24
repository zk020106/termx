export const frame = { width: 1440, height: 900, title: "首次启动" };

import { Link } from "react-router";

export default function Welcome() {
	return (
		<div className="flex h-full flex-col bg-surface text-surface-foreground antialiased selection:bg-primary/20">
			{/* Windows 顶栏 */}
			<header className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-sunk px-3">
				<div className="flex items-center gap-2">
					<div className="flex size-5 items-center justify-center rounded bg-primary/15 text-primary">
						<span className="icon-[lucide--terminal] size-3.5" />
					</div>
					<span className="text-[12px] font-semibold tracking-tight text-surface-foreground">TermX</span>
					<span className="font-mono text-[10px] text-faint">首次配置引导</span>
				</div>
				<div className="flex items-center text-muted">
					<span className="flex size-8 items-center justify-center hover:bg-surface-raised"><span className="icon-[lucide--minus] size-3.5" /></span>
					<span className="flex size-8 items-center justify-center hover:bg-surface-raised"><span className="icon-[lucide--square] size-3" /></span>
					<span className="flex size-8 items-center justify-center hover:bg-danger hover:text-primary-foreground"><span className="icon-[lucide--x] size-3.5" /></span>
				</div>
			</header>

			{/* 主内容区：Linear 经典双列工作区配置 (左引导 + 右安全锁) */}
			<div className="grid min-h-0 flex-1 grid-cols-[1.1fr_0.9fr] items-center px-16">
				<div className="max-w-lg">
					<div className="flex items-center gap-1.5 font-mono text-[11px] font-medium text-primary uppercase tracking-wider">
						<span className="size-1.5 rounded-full bg-primary" />
						Native SSH Workspace
					</div>

					<h1 className="mt-2 text-[24px] font-semibold tracking-tight text-surface-foreground leading-snug">
						一台主机，一个工作区
					</h1>

					<p className="mt-2 text-[13px] leading-relaxed text-muted">
						把终端、SFTP 文件传输、端口转发与实时遥测挂在同一个连接节点。先导入本地配置，或直接新建首台主机。
					</p>

					<div className="mt-6 space-y-2">
						<Link
							to="/hosts"
							className="group flex h-10 w-[380px] items-center gap-3 rounded border border-border bg-surface-raised px-3 text-[12.5px] transition-colors hover:border-white/20"
						>
							<div className="flex size-6 items-center justify-center rounded border border-border bg-surface text-primary">
								<span className="icon-[lucide--file-code] size-3.5" />
							</div>
							<div className="flex-1 truncate">
								<span className="font-medium text-surface-foreground">导入 ~/.ssh/config 会话</span>
							</div>
							<span className="font-mono text-[11px] text-faint">检测到 12 台</span>
						</Link>

						<Link
							to="/hosts"
							className="group flex h-10 w-[380px] items-center gap-3 rounded border border-border bg-surface-raised px-3 text-[12.5px] transition-colors hover:border-white/20"
						>
							<div className="flex size-6 items-center justify-center rounded border border-border bg-surface text-primary">
								<span className="icon-[lucide--import] size-3.5" />
							</div>
							<div className="flex-1 truncate">
								<span className="font-medium text-surface-foreground">从 Xshell / FinalShell 导入备份</span>
							</div>
							<span className="icon-[lucide--chevron-right] size-3.5 text-faint group-hover:text-surface-foreground" />
						</Link>

						<Link
							to="/host-edit"
							className="flex h-10 w-[380px] items-center justify-center gap-1.5 rounded bg-primary text-[12.5px] font-medium text-primary-foreground shadow-sm hover:opacity-90"
						>
							<span className="icon-[lucide--plus] size-3.5" />
							手动创建第一台主机
						</Link>
					</div>

					<div className="mt-6 flex items-center gap-4 text-[11px] text-faint font-mono">
						<span>✓ 跨平台同步</span>
						<span>✓ 本地主密码加密</span>
						<span>✓ 零遥测隐私</span>
					</div>
				</div>

				{/* 右侧：设置主密码（可选安全保护卡） */}
				<div className="flex justify-center">
					<div className="w-[360px] rounded-lg border border-border bg-surface-raised p-5 shadow-lg">
						<div className="flex items-center justify-between border-b border-border pb-3">
							<div className="flex items-center gap-2">
								<span className="icon-[lucide--shield-check] size-4 text-primary" />
								<h2 className="text-[13px] font-semibold text-surface-foreground">设置本地主密码</h2>
							</div>
							<span className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[9px] text-faint uppercase">可选</span>
						</div>

						<p className="mt-2.5 text-[12px] leading-relaxed text-muted">
							所有 SSH 密码与私钥口令均通过 AES-256 加密存入本地系统钥匙串。闲置离开时可自动锁屏保护。
						</p>

						<div className="mt-4 space-y-3">
							<div className="flex flex-col">
								<label className="mb-1 text-[11px] text-muted">创建主密码</label>
								<div className="flex h-7.5 items-center rounded border border-border bg-surface px-2.5 font-mono text-[12px] text-surface-foreground">
									••••••••••••
								</div>
							</div>

							<div className="flex flex-col">
								<label className="mb-1 text-[11px] text-muted">确认主密码</label>
								<div className="flex h-7.5 items-center rounded border border-border bg-surface px-2.5 font-mono text-[12px] text-surface-foreground">
									••••••••••••
								</div>
							</div>
						</div>

						<div className="mt-5 flex items-center justify-between pt-2 border-t border-border">
							<Link to="/" className="text-[11.5px] text-faint hover:text-surface-foreground">
								稍后在设置中启用
							</Link>
							<Link
								to="/"
								className="flex h-7 items-center gap-1 rounded bg-primary px-3 text-[11.5px] font-medium text-primary-foreground shadow-sm hover:opacity-90"
							>
								<span>保存并进入</span>
								<span className="icon-[lucide--arrow-right] size-3" />
							</Link>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
