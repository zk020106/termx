export const frame = { width: 1440, height: 900, title: "主机监控" };

import { WindowChrome } from "../components/WindowChrome";

const processes = [
	{ pid: "1842", name: "java -jar order-api.jar", cpu: "18.4%", mem: "1.2 GB" },
	{ pid: "902", name: "redis-server 10.0.8.40:6379", cpu: "4.1%", mem: "412 MB" },
	{ pid: "1104", name: "nginx: worker process", cpu: "1.2%", mem: "84 MB" },
	{ pid: "2411", name: "node-exporter --web.listen", cpu: "0.6%", mem: "32 MB" },
];

export default function Monitor() {
	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1 bg-surface">
				{/* 左侧活跃终端内容 */}
				<div className="flex min-w-0 flex-1 flex-col bg-term p-4 font-mono text-[12px] leading-relaxed text-term-ink">
					<div className="flex items-center justify-between border-b border-border/50 pb-2 text-[11px] text-muted">
						<div className="flex items-center gap-2">
							<span className="text-primary font-medium">deploy@order-api-01:~$</span>
							<span>top -b -n 1 | head -n 12</span>
						</div>
						<span className="text-faint">右侧抽屉已联动当前主机，共用 SSH 单连接通道</span>
					</div>

					<div className="mt-3 space-y-1 text-muted">
						<div>top - 10:14:28 up 41 days, 6:18,  2 users,  load average: 1.84, 1.42, 1.10</div>
						<div>Tasks: 168 total,   1 running, 167 sleeping,   0 stopped,   0 zombie</div>
						<div>%Cpu(s): <span className="text-surface-foreground">42.4 us</span>,  2.1 sy,  0.0 ni, 54.8 id,  0.7 wa,  0.0 hi,  0.0 si</div>
						<div>MiB Mem :  <span className="text-surface-foreground">7924.2 total</span>,   1240.1 free,   <span className="text-primary">3142.8 used</span>,   3541.3 buff/cache</div>
						<div>MiB Swap:  2048.0 total,   2048.0 free,      0.0 used.   4412.0 avail Mem</div>
					</div>

					<div className="mt-6 text-faint">
						# 监控指标每 2 秒静默轮询一次，无需额外安装 agent 守护进程。
					</div>
				</div>

				{/* 右侧遥测监控抽屉 (Linear 风格 340px) */}
				<aside className="flex w-[340px] shrink-0 flex-col border-l border-border bg-surface-sunk">
					{/* 抽屉选项卡 */}
					<div className="flex h-10 items-center justify-between border-b border-border px-3 text-[12px]">
						<div className="flex items-center gap-2">
							<span className="font-medium text-surface-foreground">实时指标</span>
							<span className="text-border">/</span>
							<span className="font-mono text-muted text-[11px]">order-api-01</span>
						</div>
						<div className="flex items-center gap-1">
							<span className="rounded bg-surface-raised px-2 py-0.5 font-medium text-primary border border-border text-[11px]">监控</span>
							<span className="px-2 py-0.5 text-muted hover:text-surface-foreground cursor-pointer text-[11px]">片段</span>
							<span className="px-2 py-0.5 text-faint text-[11px]">AI 助手</span>
						</div>
					</div>

					<div className="flex-1 overflow-y-auto p-3 space-y-4">
						{/* 2x2 核心指标卡片 */}
						<div className="grid grid-cols-2 gap-2">
							<MetricCard label="CPU 使用率" value="42.4%" hint="8 核心均值" progress={42} />
							<MetricCard label="内存 (RAM)" value="3.1 / 8 G" hint="缓存 3.5 G" progress={39} />
							<MetricCard label="磁盘利用率" value="71%" hint="根挂载 /" progress={71} warn />
							<MetricCard label="系统负载 (1m)" value="1.84" hint="阈值 8.0" progress={23} />
						</div>

						{/* CPU 60秒活动柱状图 */}
						<div className="rounded border border-border bg-surface p-3">
							<div className="flex items-center justify-between text-[11px]">
								<span className="font-medium text-surface-foreground">CPU 负载历史 · 最近 60 秒</span>
								<span className="font-mono text-primary tabular-nums">峰值 61%</span>
							</div>
							<div className="mt-3 flex h-14 items-end gap-1">
								{[22, 28, 31, 26, 40, 48, 44, 42, 55, 61, 50, 42, 38, 42].map((v, i) => (
									<div
										key={i}
										className="flex-1 rounded-t bg-primary transition-all"
										style={{ height: `${v}%`, opacity: i === 13 ? 1 : 0.45 + (i / 26) }}
										title={`${v}%`}
									/>
								))}
							</div>
						</div>

						{/* 磁盘空间报警横幅 */}
						<div className="rounded border border-warning/40 bg-warning/10 p-2.5 text-[11.5px] text-warning leading-relaxed">
							<div className="flex items-center gap-1.5 font-medium">
								<span className="icon-[lucide--alert-triangle] size-3.5" />
								<span>根分区利用率超过 70% 阈值</span>
							</div>
							<p className="mt-1 text-[11px] opacity-90">
								/var/log 目录占用已达 41.2 GB，建议执行命令片段排查大日志文件。
							</p>
						</div>

						{/* 网络吞吐 */}
						<div className="rounded border border-border bg-surface p-3 font-mono text-[11.5px]">
							<div className="text-[10.5px] font-sans font-medium text-faint uppercase tracking-wider mb-2">网络流量 (eth0)</div>
							<div className="space-y-1.5">
								<div className="flex items-center justify-between">
									<span className="flex items-center gap-1.5 text-muted">
										<span className="icon-[lucide--arrow-down] size-3 text-success" />
										接收 (RX)
									</span>
									<span className="tabular-nums text-surface-foreground">2.14 MB/s</span>
								</div>
								<div className="flex items-center justify-between">
									<span className="flex items-center gap-1.5 text-muted">
										<span className="icon-[lucide--arrow-up] size-3 text-primary" />
										发送 (TX)
									</span>
									<span className="tabular-nums text-surface-foreground">0.42 MB/s</span>
								</div>
							</div>
						</div>

						{/* 进程列表摘要 */}
						<div className="rounded border border-border bg-surface p-3">
							<div className="flex items-center justify-between mb-2">
								<span className="text-[11.5px] font-medium text-surface-foreground">Top 进程占用</span>
								<span className="font-mono text-[10.5px] text-faint">按 CPU 排序</span>
							</div>

							<div className="space-y-1.5 font-mono text-[11px]">
								{processes.map((proc) => (
									<div key={proc.pid} className="flex items-center justify-between text-muted">
										<div className="flex items-center gap-1.5 truncate max-w-[190px]">
											<span className="text-faint">{proc.pid}</span>
											<span className="truncate text-surface-foreground font-sans">{proc.name}</span>
										</div>
										<span className="text-primary tabular-nums">{proc.cpu}</span>
									</div>
								))}
							</div>
						</div>
					</div>

					<div className="border-t border-border bg-surface-raised px-3 py-2 font-mono text-[10.5px] text-faint flex justify-between">
						<span>采样周期: 2.0s</span>
						<span>Agentless SSH</span>
					</div>
				</aside>
			</div>
		</WindowChrome>
	);
}

function MetricCard({
	label,
	value,
	hint,
	progress,
	warn,
}: {
	label: string;
	value: string;
	hint: string;
	progress: number;
	warn?: boolean;
}) {
	return (
		<div className="rounded border border-border bg-surface p-2.5">
			<div className="text-[10.5px] text-muted">{label}</div>
			<div className={`mt-1 font-mono text-[15px] font-semibold tabular-nums ${warn ? "text-warning" : "text-surface-foreground"}`}>
				{value}
			</div>
			<div className="mt-1 h-1 overflow-hidden rounded bg-surface-sunk border border-border/60">
				<div
					className={`h-full ${warn ? "bg-warning" : "bg-primary"}`}
					style={{ width: `${progress}%` }}
				/>
			</div>
			<div className="mt-1 font-mono text-[10px] text-faint">{hint}</div>
		</div>
	);
}
