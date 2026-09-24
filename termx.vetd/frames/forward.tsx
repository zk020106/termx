export const frame = { width: 1440, height: 900, title: "端口转发" };

import { WindowChrome } from "../components/WindowChrome";

const rules = [
	{ name: "订单业务 API", type: "本地 -L", bind: "127.0.0.1:18080", remote: "10.0.3.21:8080", state: "运行中", note: "3 个连接 · 2.4 MB/s", status: "success" },
	{ name: "Postgres 主库", type: "本地 -L", bind: "127.0.0.1:5432", remote: "10.2.0.11:5432", state: "已停止", note: "手动启动", status: "stopped" },
	{ name: "调试 SOCKS 代理", type: "动态 -D", bind: "127.0.0.1:1080", remote: "—", state: "启动出错", note: "本地 1080 端口被占用", status: "danger" },
];

const listeningPorts = [
	{ port: "8080", bind: "0.0.0.0", proc: "order-api", pid: "1842" },
	{ port: "9090", bind: "127.0.0.1", proc: "prometheus-node", pid: "1205" },
	{ port: "5432", bind: "10.2.0.11", proc: "postgres-server", pid: "882" },
	{ port: "6379", bind: "10.0.8.40", proc: "redis-cluster", pid: "902" },
	{ port: "22", bind: "0.0.0.0", proc: "sshd", pid: "1" },
	{ port: "9100", bind: "0.0.0.0", proc: "node-exporter", pid: "1190" },
];

export default function Forward() {
	return (
		<WindowChrome activity="forward">
			<div className="flex min-h-0 flex-1 bg-surface">
				{/* 左侧规则列表 (280px) */}
				<aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-surface-sunk">
					<div className="flex h-10 items-center justify-between border-b border-border px-3">
						<div className="flex items-center gap-1.5">
							<span className="icon-[lucide--waypoints] size-3.5 text-primary" />
							<h1 className="text-[12px] font-semibold text-surface-foreground">端口转发规则</h1>
						</div>
						<button
							type="button"
							className="flex h-6 items-center gap-1 rounded bg-primary px-2 text-[11px] font-medium text-primary-foreground shadow-sm hover:opacity-90"
						>
							<span className="icon-[lucide--plus] size-3" />
							<span>新建</span>
						</button>
					</div>

					<div className="px-3 py-1.5 text-[10.5px] font-medium text-faint uppercase tracking-wider border-b border-border/40">
						order-api-01 · 自动探测 6 条端口
					</div>

					{/* 规则条目 */}
					<div className="flex-1 overflow-y-auto p-2 space-y-1.5">
						{rules.map((r, i) => (
							<div
								key={r.name}
								className={`rounded border p-2.5 transition-colors cursor-pointer ${
									i === 2
										? "border-danger/40 bg-surface-raised shadow-sm"
										: i === 0
										? "border-border bg-surface-raised"
										: "border-border bg-surface hover:border-white/20"
								}`}
							>
								<div className="flex items-center justify-between text-[12px]">
									<span className="font-medium text-surface-foreground truncate">{r.name}</span>
									<span
										className={`flex items-center gap-1 font-mono text-[10.5px] ${
											r.status === "success"
												? "text-success"
												: r.status === "danger"
												? "text-danger"
												: "text-faint"
										}`}
									>
										<span className={`size-1.5 rounded-full ${r.status === "success" ? "bg-success" : r.status === "danger" ? "bg-danger" : "bg-border"}`} />
										{r.state}
									</span>
								</div>

								<div className="mt-1 flex items-center justify-between font-mono text-[11px]">
									<span className="text-muted truncate">{r.bind}</span>
									<span className="rounded border border-border bg-surface px-1 text-[9.5px] text-faint">{r.type}</span>
								</div>

								<div className="mt-1 text-[10.5px] text-faint truncate">{r.note}</div>
							</div>
						))}
					</div>
				</aside>

				{/* 右侧规则配置与远程端口发现 */}
				<div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
					<div className="max-w-2xl">
						{/* 规则编辑卡片 */}
						<div className="rounded-lg border border-border bg-surface-raised p-5 shadow-sm">
							<div className="flex items-center justify-between border-b border-border pb-3">
								<div className="flex items-center gap-2">
									<h2 className="text-[14px] font-semibold tracking-tight text-surface-foreground">
										调试 SOCKS 代理
									</h2>
									<span className="rounded border border-danger/40 bg-danger/10 px-1.5 py-0.2 font-mono text-[10px] font-medium text-danger">
										PORT CONFLICT
									</span>
								</div>
								<div className="flex items-center gap-2 font-mono text-[11px] text-muted">
									<span>动态转发 (-D)</span>
								</div>
							</div>

							{/* 错误提示呼应 */}
							<div className="mt-3 flex items-center gap-2 rounded border border-danger/30 bg-danger/10 p-2.5 text-[11.5px] text-danger">
								<span className="icon-[lucide--alert-circle] size-4 shrink-0" />
								<span>本地端口 127.0.0.1:1080 已被系统其他进程占用。建议换用端口 1081 或终止占用进程。</span>
							</div>

							{/* 模式切换 (Segmented Control) */}
							<div className="mt-4">
								<label className="mb-1 block text-[11px] font-medium text-muted">转发模式</label>
								<div className="grid grid-cols-3 rounded border border-border bg-surface p-0.5 text-[11.5px]">
									{["本地转发 (-L)", "远程反向 (-R)", "动态 SOCKS5 (-D)"].map((t, i) => (
										<button
											key={t}
											type="button"
											className={`rounded py-1 text-center font-medium transition-colors ${
												i === 2
													? "bg-surface-raised text-surface-foreground border border-border shadow-sm"
													: "text-muted hover:text-surface-foreground"
											}`}
										>
											{t}
										</button>
									))}
								</div>
							</div>

							{/* 输入参数 */}
							<div className="mt-3.5 grid grid-cols-2 gap-3">
								<div className="flex flex-col">
									<label className="mb-1 text-[11px] text-muted">本地监听地址</label>
									<div className="flex h-7.5 items-center rounded border border-danger/60 bg-surface px-2.5 font-mono text-[12px] text-surface-foreground">
										127.0.0.1:1080
									</div>
								</div>
								<div className="flex flex-col">
									<label className="mb-1 text-[11px] text-muted">目标出口</label>
									<div className="flex h-7.5 items-center rounded border border-border bg-surface px-2.5 font-mono text-[12px] text-muted">
										跟随当前 SSH 主机动态代理
									</div>
								</div>
							</div>

							<div className="mt-4 flex items-center justify-between border-t border-border pt-3">
								<label className="flex items-center gap-2 text-[11.5px] text-muted cursor-pointer">
									<span className="flex size-3.5 items-center justify-center rounded border border-border bg-surface" />
									<span>主机连接建立后自动启动此转发规则</span>
								</label>
								<div className="flex items-center gap-2">
									<button
										type="button"
										className="h-7 rounded border border-border bg-surface px-2.5 text-[11.5px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground"
									>
										保持停止
									</button>
									<button
										type="button"
										className="flex h-7 items-center gap-1 rounded bg-primary px-3 text-[11.5px] font-medium text-primary-foreground shadow-sm hover:opacity-90"
									>
										<span className="icon-[lucide--zap] size-3" />
										<span>改用 1081 并重试启动</span>
									</button>
								</div>
							</div>
						</div>

						{/* 远程正在监听的端口自动发现列表 (Linear 风格 Table) */}
						<div className="mt-6">
							<div className="mb-2 flex items-center justify-between">
								<div className="flex items-center gap-2">
									<span className="icon-[lucide--radio] size-3.5 text-primary" />
									<h3 className="text-[13px] font-semibold text-surface-foreground">远程自动端口发现</h3>
								</div>
								<span className="font-mono text-[11px] text-faint">检测到 6 个监听端口</span>
							</div>

							<div className="rounded-lg border border-border bg-surface overflow-hidden">
								<div className="grid grid-cols-[80px_130px_1fr_80px_70px] border-b border-border bg-surface-sunk/60 px-3 py-1.5 font-mono text-[10.5px] text-faint uppercase">
									<span>端口</span>
									<span>绑定地址</span>
									<span>进程名称</span>
									<span>PID</span>
									<span className="text-right">操作</span>
								</div>

								<div className="divide-y divide-border/30 text-[11.5px] font-mono">
									{listeningPorts.map((p) => (
										<div key={p.port} className="grid grid-cols-[80px_130px_1fr_80px_70px] items-center px-3 py-1.5 hover:bg-surface-raised transition-colors">
											<span className="text-primary font-medium">{p.port}</span>
											<span className="text-muted">{p.bind}</span>
											<span className="font-sans text-surface-foreground">{p.proc}</span>
											<span className="text-faint">{p.pid}</span>
											<div className="text-right">
												<button
													type="button"
													className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10.5px] font-sans font-medium text-muted hover:border-primary hover:text-primary transition-colors"
												>
													一键转发
												</button>
											</div>
										</div>
									))}
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}
