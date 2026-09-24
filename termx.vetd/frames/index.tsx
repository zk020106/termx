export const frame = { width: 1440, height: 900, title: "终端工作区" };

import { Link } from "react-router";
import { EnvPill, WindowChrome } from "../components/WindowChrome";

export default function Workspace() {
	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1">
				{/* 左侧主机侧边栏：Linear 紧凑树形/列表 (220px) */}
				<aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-surface-sunk">
					<div className="flex h-9 items-center justify-between border-b border-border px-3">
						<span className="text-[12px] font-medium tracking-tight text-surface-foreground">主机库</span>
						<div className="flex items-center gap-1 font-mono text-[10px]">
							<Link to="/hosts" className="rounded px-1.5 py-0.5 text-primary hover:bg-surface-raised">卡片</Link>
							<span className="text-border">/</span>
							<span className="rounded bg-surface-raised px-1.5 py-0.5 text-surface-foreground">列表</span>
						</div>
					</div>

					<div className="p-2">
						<div className="flex h-7 items-center gap-1.5 rounded border border-border bg-surface px-2 text-[11px] text-faint">
							<span className="icon-[lucide--search] size-3 text-muted" />
							<span className="truncate">搜索主机…</span>
							<kbd className="ml-auto font-mono text-[9px] text-muted">Ctrl P</kbd>
						</div>
					</div>

					<div className="flex-1 overflow-y-auto px-1.5 pb-2">
						<Group label="最近连接" />
						<HostItem name="order-api-01" env="PROD" live selected />
						<HostItem name="bastion-sh" env="DEV" live />

						<Group label="订单服务集群" />
						<HostItem name="order-api-01" env="PROD" live />
						<HostItem name="order-api-02" env="PROD" live />
						<HostItem name="order-stage" env="STG" />

						<Group label="基础设施" />
						<HostItem name="bastion-sh" env="DEV" live />
						<HostItem name="redis-test-01" env="TEST" />
						<HostItem name="log-agg-node" env="DEV" live />
					</div>
				</aside>

				{/* 终端主工作区 */}
				<section className="flex min-w-0 flex-1 flex-col bg-surface">
					{/* Tab 栏：Linear 极简标签（高 34px，微下划线与状态指示条） */}
					<div className="flex h-8.5 items-end gap-1 border-b border-border bg-surface-sunk px-2">
						<TabItem name="order-api-01" env="PROD" active />
						<TabItem name="order-stage" env="STG" />
						<TabItem name="本地终端" env="DEV" />

						<button
							type="button"
							className="mb-1 ml-1 flex size-6 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-surface-foreground"
							aria-label="新建标签"
						>
							<span className="icon-[lucide--plus] size-3.5" />
						</button>

						<div className="ml-auto mb-1 flex items-center gap-2 text-[11px] text-muted">
							<span className="flex items-center gap-1 rounded border border-border bg-surface-raised px-1.5 py-0.5 font-mono text-[10px]">
								<span className="icon-[lucide--columns-2] size-3 text-primary" />
								2 分屏
							</span>
							<span className="flex items-center gap-1 rounded border border-border bg-surface-raised px-1.5 py-0.5 font-mono text-[10px]">
								<span className="icon-[lucide--lock] size-3 text-env-prod" />
								生产保护
							</span>
						</div>
					</div>

					{/* 终端分屏网格与 SFTP 抽屉：PROD 环境带精致微红顶条 */}
					<div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-[1fr_150px] bg-term">
						{/* 焦点分屏格（左）：tail 日志 */}
						<div className="relative flex flex-col overflow-hidden border-r border-border p-3 font-mono text-[12px] leading-5 text-term-ink shadow-[inset_0_0_0_1px_var(--color-primary)]">
							<div className="mb-2 flex items-center justify-between text-[11px] text-muted">
								<span className="text-primary">deploy@order-api-01:~$</span>
								<span className="text-[10px] text-faint">bash · 42 行/秒</span>
							</div>
							<div className="flex-1 space-y-1 overflow-hidden font-mono text-[12px]">
								<div className="text-surface-foreground">deploy@order-api-01:~$ tail -f /var/log/app.log</div>
								<div className="text-muted"><span className="text-success font-medium">INFO</span> 10:14:02.108 [main] Bootstrapped ServiceApplication in 2.4s</div>
								<div className="text-muted"><span className="text-success font-medium">INFO</span> 10:14:03.220 [http-nio-8080] OrderService: created id=88213 user=chen</div>
								<div className="text-muted"><span className="text-warning font-medium">WARN</span> 10:14:05.419 [db-pool-2] Slow query 1.2s: SELECT * FROM orders WHERE status = 'PENDING'</div>
								<div className="text-muted"><span className="text-danger font-medium">ERROR</span> 10:14:08.891 [redis-client] Connection timeout to 10.0.8.40:6379</div>
								<div className="text-muted"><span className="text-success font-medium">INFO</span> 10:14:09.102 [retry-worker] Failover to redis replica 10.0.8.41:6379: OK</div>
								<div className="mt-2 flex items-center gap-1 text-surface-foreground">
									<span className="text-primary">deploy@order-api-01:~$</span>
									<span className="inline-block h-3.5 w-1.5 bg-primary animate-pulse" />
								</div>
							</div>
						</div>

						{/* 副分屏格（右）：htop 监控 */}
						<div className="flex flex-col overflow-hidden p-3 font-mono text-[12px] leading-5 text-muted">
							<div className="mb-2 flex items-center justify-between text-[11px] text-muted">
								<span className="text-primary">deploy@order-api-01:~$</span>
								<span className="text-[10px] text-faint">htop 3.2.2</span>
							</div>
							<div className="space-y-1">
								<div className="flex items-center gap-2">
									<span className="w-10 text-[11px] text-faint">CPU</span>
									<div className="flex-1 h-2 rounded bg-surface border border-border overflow-hidden">
										<div className="h-full bg-primary" style={{ width: "42%" }} />
									</div>
									<span className="w-12 text-right tabular-nums text-surface-foreground">42.4%</span>
								</div>
								<div className="flex items-center gap-2">
									<span className="w-10 text-[11px] text-faint">Mem</span>
									<div className="flex-1 h-2 rounded bg-surface border border-border overflow-hidden">
										<div className="h-full bg-accent" style={{ width: "38.7%" }} />
									</div>
									<span className="w-12 text-right tabular-nums text-surface-foreground">3.1/8 G</span>
								</div>
								<div className="flex items-center gap-2">
									<span className="w-10 text-[11px] text-faint">Swp</span>
									<div className="flex-1 h-2 rounded bg-surface border border-border overflow-hidden">
										<div className="h-full bg-border" style={{ width: "0%" }} />
									</div>
									<span className="w-12 text-right tabular-nums text-muted">0/2 G</span>
								</div>

								<div className="mt-3 grid grid-cols-[56px_1fr_64px] border-b border-border/60 pb-1 text-[10px] font-sans text-faint">
									<span>PID</span><span>COMMAND</span><span className="text-right">CPU%</span>
								</div>
								<div className="space-y-0.5 text-[11px]">
									<div className="grid grid-cols-[56px_1fr_64px] items-center text-surface-foreground">
										<span className="text-faint">1842</span><span className="truncate">java -jar order-api.jar</span><span className="text-right tabular-nums font-mono text-primary">18.4%</span>
									</div>
									<div className="grid grid-cols-[56px_1fr_64px] items-center text-muted">
										<span className="text-faint">902</span><span className="truncate">redis-server 10.0.8.40:6379</span><span className="text-right tabular-nums font-mono">4.1%</span>
									</div>
									<div className="grid grid-cols-[56px_1fr_64px] items-center text-muted">
										<span className="text-faint">1104</span><span className="truncate">nginx: worker process</span><span className="text-right tabular-nums font-mono">1.2%</span>
									</div>
								</div>
							</div>
						</div>

						{/* 底部内嵌 SFTP 面板：跟随当前终端目录 */}
						<div className="col-span-2 flex flex-col border-t border-border bg-surface">
							<div className="flex h-7 items-center justify-between border-b border-border bg-surface-raised px-3 text-[11px]">
								<div className="flex items-center gap-2 font-mono">
									<span className="icon-[lucide--folder] size-3.5 text-primary" />
									<span className="text-surface-foreground">/home/deploy/app</span>
									<span className="text-border">·</span>
									<span className="font-sans text-faint">跟随终端</span>
								</div>
								<div className="flex items-center gap-3 text-muted">
									<span>4 个项目</span>
									<Link to="/sftp" className="flex items-center gap-1 text-primary hover:underline">
										<span>展开双栏模式</span>
										<span className="icon-[lucide--external-link] size-3" />
									</Link>
								</div>
							</div>

							<div className="grid grid-cols-[1fr_90px_130px_70px] border-b border-border/40 px-3 py-1 font-sans text-[11px] text-faint">
								<span>名称</span><span className="text-right">大小</span><span className="text-right">修改时间</span><span className="text-right">权限</span>
							</div>
							<div className="flex-1 overflow-y-auto">
								<FileRow name="logs" size="—" time="今天 10:14" perm="drwxr-xr-x" folder />
								<FileRow name="app.log" size="12.4 MB" time="今天 10:14" perm="-rw-r--r--" />
								<FileRow name="config.yml" size="2 KB" time="昨天 18:41" perm="-rw-r--r--" />
								<FileRow name="release" size="—" time="09-22 15:30" perm="drwxr-xr-x" folder />
							</div>
						</div>
					</div>
				</section>

				{/* 右侧工具抽屉：主机实时遥测指标 (200px) */}
				<aside className="flex w-[200px] shrink-0 flex-col border-l border-border bg-surface-sunk p-3">
					<div className="flex items-center justify-between border-b border-border pb-2">
						<span className="text-[12px] font-semibold text-surface-foreground">主机监控</span>
						<Link to="/monitor" className="font-sans text-[11px] text-primary hover:underline">详情</Link>
					</div>

					<div className="mt-2.5 space-y-3">
						<TelemetryMeter label="CPU 使用率" value="42%" progress={42} />
						<TelemetryMeter label="内存 (RAM)" value="3.1 / 8 G" progress={39} />
						<TelemetryMeter label="根磁盘 /" value="71%" progress={71} warn />
						<TelemetryMeter label="系统负载 (1m)" value="1.84" progress={46} />
					</div>

					<div className="mt-4 border-t border-border pt-3">
						<div className="text-[10px] font-sans font-medium text-faint uppercase tracking-wider">实时网络吞吐</div>
						<div className="mt-2 space-y-1.5 font-mono text-[11px]">
							<div className="flex items-center justify-between">
								<span className="flex items-center gap-1 text-muted">
									<span className="icon-[lucide--arrow-down] size-3 text-success" />
									下行
								</span>
								<span className="tabular-nums text-surface-foreground">2.1 MB/s</span>
							</div>
							<div className="flex items-center justify-between">
								<span className="flex items-center gap-1 text-muted">
									<span className="icon-[lucide--arrow-up] size-3 text-primary" />
									上行
								</span>
								<span className="tabular-nums text-surface-foreground">0.4 MB/s</span>
							</div>
						</div>
					</div>

					<div className="mt-auto rounded border border-border bg-surface-raised p-2 font-mono text-[10px] text-muted">
						<div className="flex justify-between">
							<span className="text-faint">运行时间</span>
							<span>41 天 6 小时</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span className="text-faint">OS 核心</span>
							<span>Linux 5.15</span>
						</div>
					</div>
				</aside>
			</div>
		</WindowChrome>
	);
}

function Group({ label }: { label: string }) {
	return <div className="mt-2 mb-1 px-2 text-[10px] font-medium tracking-wider text-faint uppercase">{label}</div>;
}

function HostItem({ name, env, live, selected }: { name: string; env: "PROD" | "STG" | "TEST" | "DEV"; live?: boolean; selected?: boolean }) {
	return (
		<div
			className={`group flex h-7 items-center gap-2 rounded px-2 text-[12px] transition-colors ${
				selected
					? "bg-surface-raised font-medium text-surface-foreground border border-border"
					: "text-muted hover:bg-surface hover:text-surface-foreground"
			}`}
		>
			<span className={`size-1.5 rounded-full ${live ? "bg-success" : "bg-border"}`} />
			<span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{name}</span>
			<EnvPill env={env} />
		</div>
	);
}

function TabItem({ name, env, active }: { name: string; env: "PROD" | "STG" | "TEST" | "DEV"; active?: boolean }) {
	return (
		<div
			className={`flex h-7.5 items-center gap-2 rounded-t border-t border-x px-3 text-[12px] transition-colors ${
				active
					? "border-border bg-term text-surface-foreground font-medium shadow-sm"
					: "border-transparent bg-transparent text-muted hover:bg-surface-raised/40 hover:text-surface-foreground"
			}`}
		>
			<span className={`h-2.5 w-0.5 rounded ${env === "PROD" ? "bg-env-prod" : env === "STG" ? "bg-env-stage" : "bg-muted"}`} />
			<span className="truncate">{name}</span>
			{active && (
				<button type="button" className="ml-1 text-muted hover:text-surface-foreground" aria-label="关闭标签">
					<span className="icon-[lucide--x] size-3" />
				</button>
			)}
		</div>
	);
}

function FileRow({ name, size, time, perm, folder }: { name: string; size: string; time: string; perm: string; folder?: boolean }) {
	return (
		<div className="grid h-7 grid-cols-[1fr_90px_130px_70px] items-center px-3 text-[12px] hover:bg-surface-raised transition-colors">
			<span className="flex items-center gap-2 truncate">
				<span className={`${folder ? "icon-[lucide--folder] text-primary" : "icon-[lucide--file-text] text-faint"} size-3.5`} />
				<span className="font-mono text-[11.5px] text-surface-foreground">{name}</span>
			</span>
			<span className="text-right font-mono text-[11px] tabular-nums text-muted">{size}</span>
			<span className="text-right font-mono text-[11px] text-faint">{time}</span>
			<span className="text-right font-mono text-[10px] text-faint">{perm}</span>
		</div>
	);
}

function TelemetryMeter({ label, value, progress, warn }: { label: string; value: string; progress: number; warn?: boolean }) {
	return (
		<div className="space-y-1">
			<div className="flex justify-between text-[11px]">
				<span className="text-muted">{label}</span>
				<span className={`font-mono tabular-nums ${warn ? "text-warning font-medium" : "text-surface-foreground"}`}>{value}</span>
			</div>
			<div className="h-1.5 overflow-hidden rounded bg-surface border border-border">
				<div
					className={`h-full ${warn ? "bg-warning" : "bg-primary"}`}
					style={{ width: `${progress}%` }}
				/>
			</div>
		</div>
	);
}
