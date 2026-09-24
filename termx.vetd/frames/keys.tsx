export const frame = { width: 1440, height: 900, title: "密钥库" };

import { WindowChrome } from "../components/WindowChrome";

const keys = [
	{
		name: "工作笔记本默认密钥",
		type: "Ed25519",
		use: "关联 12 台主机",
		fingerprint: "SHA256:k9Qm3pL8nR2vXc4e2J5hW1yZ",
		created: "2024-03-02",
		active: true,
	},
	{
		name: "核心跳板专用密钥",
		type: "Ed25519",
		use: "用于 bastion-sh (OPS)",
		fingerprint: "SHA256:a1Lp99sK3xMn4dF8pQ2vR1tX",
		created: "2024-06-15",
	},
	{
		name: "历史遗留 RSA",
		type: "RSA 4096",
		use: "暂未关联主机 (可归档)",
		fingerprint: "SHA256:zz18Nm3kP9qW2xY7vC4eR0oL",
		created: "2022-11-20",
	},
];

export default function Keys() {
	return (
		<WindowChrome activity="keys">
			<div className="flex min-h-0 flex-1 bg-surface">
				{/* 左侧密钥列表 (280px) */}
				<aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-surface-sunk">
					<div className="flex h-10 items-center justify-between border-b border-border px-3">
						<div className="flex items-center gap-1.5">
							<span className="icon-[lucide--key-round] size-3.5 text-primary" />
							<h1 className="text-[12px] font-semibold text-surface-foreground">SSH 密钥管理</h1>
						</div>
						<button
							type="button"
							className="flex h-6 items-center gap-1 rounded bg-primary px-2 text-[11px] font-medium text-primary-foreground shadow-sm hover:opacity-90"
						>
							<span className="icon-[lucide--plus] size-3" />
							<span>生成密钥</span>
						</button>
					</div>

					<div className="p-2 space-y-1.5 flex-1 overflow-y-auto">
						{keys.map((k) => (
							<div
								key={k.name}
								className={`rounded border p-2.5 transition-colors cursor-pointer ${
									k.active
										? "border-border bg-surface-raised shadow-sm"
										: "border-transparent bg-surface hover:border-border"
								}`}
							>
								<div className="flex items-center justify-between text-[12px]">
									<span className="font-medium text-surface-foreground truncate">{k.name}</span>
									<span className="rounded border border-border bg-surface px-1 font-mono text-[9.5px] text-primary">{k.type}</span>
								</div>

								<div className="mt-1 font-mono text-[10.5px] text-faint truncate">{k.fingerprint}</div>
								<div className="mt-1 flex items-center justify-between text-[10.5px] text-muted">
									<span>{k.use}</span>
									<span className="font-mono text-faint">{k.created}</span>
								</div>
							</div>
						))}
					</div>

					<div className="border-t border-border p-2">
						<button
							type="button"
							className="flex h-7 w-full items-center justify-center gap-1.5 rounded border border-border bg-surface text-[11px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground"
						>
							<span className="icon-[lucide--upload] size-3" />
							<span>导入外部私钥文件 (PEM / OpenSSH)</span>
						</button>
					</div>
				</aside>

				{/* 右侧密钥详情与部署操作 */}
				<div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
					<div className="max-w-2xl space-y-5">
						{/* 密钥详情卡片 */}
						<div className="rounded-lg border border-border bg-surface-raised p-5 shadow-sm">
							<div className="flex items-center justify-between border-b border-border pb-3">
								<div>
									<div className="flex items-center gap-2">
										<h2 className="text-[14px] font-semibold text-surface-foreground">工作笔记本默认密钥</h2>
										<span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.2 font-mono text-[10px] text-primary">
											ED25519
										</span>
									</div>
									<p className="mt-1 text-[11.5px] text-muted">创建于 2024-03-02 · 已受系统钥匙串与主密码保护</p>
								</div>

								<div className="flex items-center gap-2">
									<button
										type="button"
										className="flex h-6.5 items-center gap-1 rounded border border-border bg-surface px-2 text-[11px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground"
									>
										<span className="icon-[lucide--copy] size-3" />
										复制公钥
									</button>
								</div>
							</div>

							{/* 指纹信息 */}
							<div className="mt-3.5 space-y-1">
								<span className="text-[11px] text-faint uppercase font-mono tracking-wider">SHA256 FINGERPRINT</span>
								<div className="flex h-7 items-center rounded border border-border bg-surface px-2.5 font-mono text-[11.5px] text-surface-foreground">
									SHA256:k9Qm3pL8nR2vXc4e2J5hW1yZ8mPqRtUvWxYz0123456
								</div>
							</div>

							{/* 公钥预览 */}
							<div className="mt-3.5 space-y-1">
								<span className="text-[11px] text-faint uppercase font-mono tracking-wider">PUBLIC KEY (~/.ssh/id_ed25519.pub)</span>
								<div className="rounded border border-border bg-term p-2.5 font-mono text-[11px] leading-relaxed text-term-ink break-all">
									ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBk7M8pQ2vR1tX9Qm3pL8nR2vXc4e2J5hW1yZ8mPqRtU deploy@studio-mbp
								</div>
							</div>
						</div>

						{/* 一键部署公钥到远程主机卡片 */}
						<div className="rounded-lg border border-border bg-surface-raised p-5 shadow-sm">
							<div className="flex items-center gap-2 border-b border-border pb-3">
								<span className="flex size-5 items-center justify-center rounded bg-primary/15 text-primary">
									<span className="icon-[lucide--shield-plus] size-3" />
								</span>
								<div>
									<h3 className="text-[13px] font-semibold text-surface-foreground">一键部署公钥到远程主机</h3>
									<p className="text-[11px] text-muted">自动将此公钥写入目标主机的 ~/.ssh/authorized_keys</p>
								</div>
							</div>

							<div className="mt-4 grid grid-cols-[1fr_1fr] gap-3">
								<div className="flex flex-col">
									<label className="mb-1 text-[11.5px] text-muted">目标主机</label>
									<div className="flex h-7.5 items-center justify-between rounded border border-border bg-surface px-2.5 text-[12px] text-surface-foreground">
										<span className="font-mono">order-api-01 (10.0.3.21)</span>
										<span className="icon-[lucide--chevron-down] size-3 text-faint" />
									</div>
								</div>
								<div className="flex flex-col">
									<label className="mb-1 text-[11.5px] text-muted">登录用户名</label>
									<div className="flex h-7.5 items-center rounded border border-border bg-surface px-2.5 font-mono text-[12px] text-surface-foreground">
										deploy
									</div>
								</div>
							</div>

							<div className="mt-4 flex items-center justify-between border-t border-border pt-3">
								<span className="text-[11px] text-faint">经由跳板链路: bastion-sh (10.0.0.4:22)</span>
								<button
									type="button"
									className="flex h-7 items-center gap-1.5 rounded bg-primary px-3 text-[11.5px] font-medium text-primary-foreground shadow-sm hover:opacity-90"
								>
									<span className="icon-[lucide--send] size-3" />
									<span>开始写入公钥</span>
								</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}
