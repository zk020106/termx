export const frame = { width: 1440, height: 900, title: "编辑器" };

import { WindowChrome } from "../components/WindowChrome";

const lines = [
	{ num: 1, text: "# TermX 微服务生产环境配置文件", type: "comment" },
	{ num: 2, text: "server:", type: "key" },
	{ num: 3, text: "  port: 8080", type: "pair", val: "8080" },
	{ num: 4, text: "  name: order-api", type: "pair", val: "order-api" },
	{ num: 5, text: "  env: production", type: "pair", val: "production" },
	{ num: 6, text: "  gracefulShutdown: 30s", type: "pair", val: "30s" },
	{ num: 7, text: "redis:", type: "key" },
	{ num: 8, text: "  host: 10.0.8.40", type: "pair", val: "10.0.8.40" },
	{ num: 9, text: "  port: 6379", type: "pair", val: "6379" },
	{ num: 10, text: "  timeout: 200ms", type: "pair", val: "200ms" },
	{ num: 11, text: "  poolSize: 16", type: "pair", val: "16" },
	{ num: 12, text: "database:", type: "key" },
	{ num: 13, text: "  host: 10.2.0.11", type: "pair", val: "10.2.0.11" },
	{ num: 14, text: "  name: order_master", type: "pair", val: "order_master" },
	{ num: 15, text: "  maxConnections: 20", type: "pair", val: "20" },
	{ num: 16, text: "  idleTimeout: 60s", type: "pair", val: "60s" },
	{ num: 17, text: "logging:", type: "key" },
	{ num: 18, text: "  level: info", type: "pair", val: "info" },
	{ num: 19, text: "  path: /var/log/app.log", type: "pair", val: "/var/log/app.log" },
	{ num: 20, text: "  rotate: daily", type: "pair", val: "daily" },
	{ num: 21, text: "metrics:", type: "key" },
	{ num: 22, text: "  enabled: true", type: "pair", val: "true" },
	{ num: 23, text: "  prometheusPort: 9090", type: "pair", val: "9090" },
];

export default function Editor() {
	return (
		<WindowChrome activity="sftp">
			<div className="flex min-h-0 flex-1 flex-col bg-term">
				{/* 编辑器标签栏 (Linear 极简风) */}
				<div className="flex h-8.5 items-end justify-between border-b border-border bg-surface-sunk px-2">
					<div className="flex items-center gap-1">
						{/* 活跃且未保存文件 */}
						<div className="flex h-7.5 items-center gap-2 rounded-t border-t border-x border-border bg-term px-3 text-[12px] text-surface-foreground">
							<span className="size-1.5 rounded-full bg-warning" title="已修改未保存" />
							<span className="font-mono">config.yml</span>
							<span className="font-mono text-[10px] text-faint">order-api-01</span>
							<button type="button" className="ml-1 text-muted hover:text-surface-foreground">
								<span className="icon-[lucide--x] size-3" />
							</button>
						</div>

						{/* 其他标签 */}
						<div className="flex h-7.5 items-center gap-2 rounded-t border-t border-x border-transparent px-3 text-[12px] text-muted hover:text-surface-foreground">
							<span className="font-mono">app.log</span>
							<span className="font-mono text-[10px] text-faint">只读</span>
						</div>

						<div className="flex h-7.5 items-center gap-2 rounded-t border-t border-x border-transparent px-3 text-[12px] text-muted hover:text-surface-foreground">
							<span className="font-mono">deploy.sh</span>
						</div>
					</div>

					{/* 快捷操作 */}
					<div className="flex items-center gap-3 pb-1 text-[11px] text-muted font-mono">
						<span>UTF-8</span>
						<span>YAML</span>
						<span className="text-primary font-sans font-medium">Ctrl + S 保存</span>
					</div>
				</div>

				{/* 路径与只读标识面包屑 */}
				<div className="flex h-6.5 items-center justify-between border-b border-border/40 bg-surface/80 px-3 font-mono text-[11px] text-muted">
					<div className="flex items-center gap-1.5">
						<span className="icon-[lucide--server] size-3 text-primary" />
						<span className="text-surface-foreground">order-api-01</span>
						<span>:</span>
						<span className="text-muted">/home/deploy/app/config.yml</span>
					</div>
					<div className="flex items-center gap-2 text-faint">
						<span>行 4, 列 18</span>
						<span>·</span>
						<span>23 行</span>
					</div>
				</div>

				{/* 代码编辑区 */}
				<div className="relative min-h-0 flex-1 overflow-y-auto p-3 font-mono text-[12.5px] leading-6">
					{lines.map((l) => (
						<div key={l.num} className="grid grid-cols-[40px_1fr] hover:bg-white/[0.02]">
							<span className="select-none text-right pr-4 text-faint/60 text-[11px]">{l.num}</span>
							<span className="text-term-ink">
								{l.type === "comment" ? (
									<span className="text-muted italic">{l.text}</span>
								) : l.type === "key" ? (
									<span className="text-primary font-medium">{l.text}</span>
								) : (
									l.text
								)}
							</span>
						</div>
					))}

					{/* 浮动冲突提示卡片 (Linear 风格 380px) */}
					<div className="absolute bottom-4 right-4 w-[380px] rounded-lg border border-warning/40 bg-surface-raised p-4 shadow-2xl">
						<div className="flex items-center gap-2.5">
							<div className="flex size-6 shrink-0 items-center justify-center rounded bg-warning/15 text-warning">
								<span className="icon-[lucide--alert-triangle] size-3.5" />
							</div>
							<div className="flex-1">
								<div className="flex items-center justify-between">
									<h4 className="text-[12.5px] font-semibold text-surface-foreground">远端文件已被并发修改</h4>
									<span className="font-mono text-[10px] text-faint">10:06:12</span>
								</div>
								<p className="mt-1 text-[11.5px] leading-relaxed text-muted">
									在您打开编辑期间，远端服务器该文件被其他进程或运维人员写入了新的内容。
								</p>
							</div>
						</div>

						{/* 解决冲突操作按钮 */}
						<div className="mt-3.5 flex items-center justify-end gap-2 border-t border-border pt-3">
							<button
								type="button"
								className="h-6.5 rounded border border-border bg-surface px-2 text-[11px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground"
							>
								放弃本地修改
							</button>
							<button
								type="button"
								className="h-6.5 rounded border border-primary/40 bg-primary/10 px-2 text-[11px] font-medium text-primary hover:bg-primary/20"
							>
								查看 Diff 差异
							</button>
							<button
								type="button"
								className="flex h-6.5 items-center gap-1 rounded bg-primary px-2.5 text-[11px] font-medium text-primary-foreground shadow-sm hover:opacity-90"
							>
								<span>强制覆盖远端</span>
							</button>
						</div>
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}
