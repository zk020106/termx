export const frame = { width: 1440, height: 900, title: "终端工作区" };

import { Link } from "react-router";
import { EnvPill, WindowChrome } from "../components/WindowChrome";

export default function Workspace() {
	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1">
				{/* 左侧主机侧边栏 */}
				<aside className="flex w-[240px] shrink-0 flex-col border-r border-border bg-surface-sunk/60">
					<div className="flex h-10 items-center justify-between px-3.5 border-b border-border/40">
						<span className="font-display text-[12px] font-semibold text-surface-foreground">主机快速列表</span>
						<div className="flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-surface-raised p-0.5 text-[10px] font-mono">
							<Link to="/hosts" className="rounded px-1.5 py-0.5 text-accent font-medium bg-accent-soft">卡片</Link>
							<span className="px-1.5 py-0.5 text-faint">树形</span>
						</div>
					</div>

					<div className="p-2">
						<div className="flex h-7 items-center gap-1.5 rounded-lg border border-white/[0.06] bg-surface-raised/70 px-2 text-[11px] text-faint shadow-inner">
							<span className="icon-[lucide--search] size-3" />
							<span>过滤主机…</span>
							<kbd className="ml-auto font-mono text-[9px] text-muted">⌘P</kbd>
						</div>
					</div>

					<div className="flex-1 overflow-y-auto px-1 pb-3">
						<Group label="最近连接" />
						<Host name="order-api-01" env="PROD" live selected />
						<Host name="bastion-sh" env="DEV" live />

						<Group label="订单服务集群" />
						<Host name="order-api-01" env="PROD" live />
						<Host name="order-api-02" env="PROD" live />
						<Host name="order-stage" env="STG" />

						<Group label="基础设施" />
						<Host name="bastion-sh" env="DEV" live />
						<Host name="redis-test-01" env="TEST" />
						<Host name="log-agg-node" env="DEV" live />
					</div>
				</aside>

				{/* 终端主工作区 */}
				<section className="flex min-w-0 flex-1 flex-col bg-surface-sunk">
					{/* Tab 栏：高科技顶置流光条 */}
					<div className="flex h-9 items-end gap-1 border-b border-border bg-surface-sunk px-2 pt-1">
						<Tab name="order-api-01" env="PROD" active />
						<Tab name="order-stage" env="STG" />
						<Tab name="本地终端 (zsh)" env="DEV" />

						<button
							type="button"
							className="mb-1 ml-1 grid size-6 place-items-center rounded-md text-muted hover:bg-white/[0.06] hover:text-surface-foreground transition-colors"
							aria-label="新建标签"
						>
							<span className="icon-[lucide--plus] size-3.5" />
						</button>

						<div className="ml-auto mb-1 flex items-center gap-1 text-[11px] text-muted">
							<span className="flex items-center gap-1 rounded bg-white/[0.04] px-2 py-0.5 font-mono text-[10px]">
								<span className="icon-[lucide--columns-2] size-3 text-accent" />
								2 分屏
							</span>
						</div>
					</div>

					{/* 终端分屏网格与 SFTP 抽屉 */}
					<div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-[1fr_156px] bg-term">
						{/* 左分屏：当前激活终端 */}
						<div className="relative overflow-hidden p-3.5 font-mono text-[12px] leading-[22px] text-term-ink shadow-[inset_0_0_0_1px_var(--color-accent)] ring-1 ring-accent/40">
							<div>
								<span className="text-ansi-green">deploy@order-api-01</span>
								<span className="text-muted">:</span>
								<span className="text-ansi-cyan">/var/log</span>
								<span>$ tail -f app.log</span>
							</div>
							<Line tone="text-ansi-green" tag="INFO" text="order created  id=88213  user=chen  amount=¥128.00" />
							<Line tone="text-ansi-green" tag="INFO" text="payment captured  stripe_ch_98213 ok" />
							<Line tone="text-ansi-yellow" tag="WARN" text="slow query  1.2s  orders.list threshold exceeded" />
							<Line tone="text-ansi-red" tag="ERROR" text="redis timeout  10.0.8.40:6379 node unreach" />
							<Line tone="text-ansi-green" tag="INFO" text="circuit breaker recovered  attempt=2 ok" />

							<div className="text-term-ink mt-1">
								<span className="text-ansi-green">deploy@order-api-01</span>
								<span className="text-muted">:</span>
								<span className="text-ansi-cyan">/var/log</span>
								<span>$&nbsp;</span>
								<span className="inline-block h-3.5 w-2 translate-y-0.5 bg-accent animate-pulse shadow-[0_0_8px_var(--color-accent)]" />
							</div>
						</div>

						{/* 右分屏：从属监控终端（htop） */}
						<div className="relative overflow-hidden border-l border-border/80 p-3.5 font-mono text-[12px] leading-[22px] text-muted bg-term/95">
							<div className="flex items-center justify-between text-[11px] text-faint pb-1 border-b border-border/30">
								<span>deploy@order-api-01 · 节点健康</span>
								<span className="font-mono text-ansi-green">UPTIME 41d</span>
							</div>
							<div className="mt-2 text-term-ink font-mono">
								<span className="text-faint">CPU </span>[<span className="text-ansi-cyan">████████░░░░░░░░</span>] <span className="tabular-nums text-surface-foreground">42.4%</span>
							</div>
							<div className="text-term-ink font-mono">
								<span className="text-faint">MEM </span>[<span className="text-ansi-green">███████░░░░░░░░░</span>] <span className="tabular-nums text-surface-foreground">3.1 / 8.0 GB</span>
							</div>
							<div className="text-term-ink font-mono">
								<span className="text-faint">SWP </span>[<span className="text-muted">░░░░░░░░░░░░░░░░</span>] <span className="tabular-nums text-faint">0 / 2.0 GB</span>
							</div>

							<div className="mt-3 grid grid-cols-[56px_1fr_64px] text-[10px] font-mono uppercase tracking-wider text-faint border-b border-border/20 pb-1">
								<span>PID</span>
								<span>COMMAND</span>
								<span className="text-right">CPU%</span>
							</div>
							<div className="grid grid-cols-[56px_1fr_64px] text-[11px] text-term-ink py-0.5">
								<span className="text-muted">1842</span>
								<span className="text-ansi-cyan truncate">java -jar order-api.jar</span>
								<span className="text-right tabular-nums text-ansi-green">18.4%</span>
							</div>
							<div className="grid grid-cols-[56px_1fr_64px] text-[11px] text-term-ink py-0.5">
								<span className="text-muted">902</span>
								<span className="truncate">redis-server *:6379</span>
								<span className="text-right tabular-nums text-muted">4.1%</span>
							</div>
						</div>

						{/* 底部 SFTP 抽屉：沉浸式深暗底色 */}
						<div className="col-span-2 flex flex-col border-t border-border bg-surface-sunk">
							<div className="flex h-8 items-center gap-2 border-b border-border/40 px-3.5 text-[12px]">
								<span className="icon-[lucide--folder-git-2] size-3.5 text-accent" />
								<span className="font-mono text-surface-foreground font-medium">/home/deploy/app</span>
								<span className="rounded bg-accent/10 px-1.5 py-0.2 font-mono text-[10px] text-accent">
									跟随终端同步中
								</span>
								<div className="ml-auto flex items-center gap-3 text-muted text-[11px]">
									<span>4 个项目</span>
									<Link to="/sftp" className="flex items-center gap-1 text-accent hover:underline">
										<span>展开双栏管理器</span>
										<span className="icon-[lucide--arrow-up-right] size-3" />
									</Link>
								</div>
							</div>

							<div className="grid grid-cols-[1fr_100px_140px] px-3.5 py-1 text-[10px] font-mono tracking-wider uppercase text-faint border-b border-border/20">
								<span>文件名称</span>
								<span className="text-right">大小</span>
								<span className="text-right">最近修改</span>
							</div>

							<div className="flex-1 overflow-y-auto">
								<File name="logs/" size="—" time="今天 09:14" folder />
								<File name="app.log" size="12.4 MB" time="今天 10:02" highlight />
								<File name="config.yml" size="2 KB" time="昨天 18:41" />
								<File name="release/" size="—" time="09-22" folder />
							</div>
						</div>
					</div>
				</section>

				{/* 右侧实时指标监控坞 */}
				<aside className="flex w-[210px] shrink-0 flex-col gap-3.5 border-l border-border bg-surface-sunk/70 p-3.5">
					<div className="flex items-center justify-between">
						<span className="font-display text-[12px] font-semibold text-surface-foreground">实时指标</span>
						<Link to="/monitor" className="text-[11px] text-accent hover:underline font-mono">详情 ↗</Link>
					</div>
					<div className="font-mono text-[10px] text-faint">order-api-01 · Ubuntu 22.04</div>

					<Meter label="CPU 使用率" value="42%" width="42%" />
					<Meter label="物理内存" value="3.1 / 8G" width="39%" />
					<Meter label="根磁盘 /" value="71%" width="71%" warn />
					<Meter label="15m 负载" value="1.84" width="46%" />

					<div className="mt-2 rounded-lg border border-white/[0.06] bg-surface-raised/50 p-2.5 font-mono text-[11px] text-muted">
						<div className="flex justify-between py-0.5">
							<span className="text-faint">↓ 下行速率</span>
							<span className="tabular-nums text-surface-foreground font-semibold">2.1 MB/s</span>
						</div>
						<div className="flex justify-between py-0.5">
							<span className="text-faint">↑ 上行速率</span>
							<span className="tabular-nums text-surface-foreground font-semibold">0.4 MB/s</span>
						</div>
						<div className="flex justify-between py-0.5">
							<span className="text-faint">延迟抖动</span>
							<span className="tabular-nums text-success font-semibold">0.8 ms</span>
						</div>
					</div>
				</aside>
			</div>
		</WindowChrome>
	);
}

function Group({ label }: { label: string }) {
	return <div className="px-3 pt-3 pb-1 text-[10px] font-mono tracking-wider uppercase text-faint">{label}</div>;
}

function Host({ name, env, live, selected }: { name: string; env: "PROD" | "STG" | "TEST" | "DEV"; live?: boolean; selected?: boolean }) {
	return (
		<div
			className={`mx-1.5 flex h-7 items-center gap-2 rounded-lg px-2 text-[12px] transition-colors cursor-pointer ${
				selected
					? "bg-accent/10 font-medium text-accent ring-1 ring-accent/30 shadow-[0_0_8px_-2px_var(--color-accent)]"
					: "text-muted hover:bg-white/[0.04] hover:text-surface-foreground"
			}`}
		>
			<span
				className={`size-1.5 shrink-0 rounded-full ${
					live ? "bg-success shadow-[0_0_6px_var(--color-success)]" : "bg-border"
				}`}
			/>
			<span className="min-w-0 flex-1 truncate">{name}</span>
			<EnvPill env={env} />
		</div>
	);
}

function Tab({ name, env, active }: { name: string; env: "PROD" | "STG" | "DEV"; active?: boolean }) {
	return (
		<div
			className={`relative flex h-8 items-center gap-2 rounded-t-lg px-3 text-[12px] transition-all cursor-pointer ${
				active
					? "bg-term text-term-ink font-medium shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] border-t border-x border-border/80 before:absolute before:top-0 before:left-2 before:right-2 before:h-[2px] before:bg-accent before:shadow-[0_0_8px_var(--color-accent)]"
					: "text-muted hover:bg-white/[0.03] hover:text-surface-foreground"
			}`}
		>
			<span
				className={`h-2.5 w-[3px] rounded-full ${
					env === "PROD"
						? "bg-env-prod shadow-[0_0_6px_var(--color-env-prod)]"
						: env === "STG"
						? "bg-env-stage"
						: "bg-faint"
				}`}
			/>
			<span>{name}</span>
			{active && <span className="icon-[lucide--x] size-3 text-faint hover:text-surface-foreground ml-1" />}
		</div>
	);
}

function Line({ tone, tag, text }: { tone: string; tag: string; text: string }) {
	return (
		<div className="flex items-baseline gap-2">
			<span className={`${tone} font-semibold font-mono text-[11px]`}>{tag}</span>
			<span className="text-term-ink/90">{text}</span>
		</div>
	);
}

function File({ name, size, time, folder, highlight }: { name: string; size: string; time: string; folder?: boolean; highlight?: boolean }) {
	return (
		<div className={`grid h-6 grid-cols-[1fr_100px_140px] items-center px-3.5 text-[12px] transition-colors hover:bg-white/[0.03] ${highlight ? "bg-accent/5 text-accent" : "text-surface-foreground"}`}>
			<span className="flex items-center gap-2 truncate">
				<span className={`${folder ? "icon-[lucide--folder] text-accent/80" : "icon-[lucide--file-text] text-faint"} size-3.5 shrink-0`} />
				<span className="truncate">{name}</span>
			</span>
			<span className="text-right font-mono text-[11px] tabular-nums text-muted">{size}</span>
			<span className="text-right font-mono text-[11px] text-faint">{time}</span>
		</div>
	);
}

function Meter({ label, value, width, warn }: { label: string; value: string; width: string; warn?: boolean }) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex justify-between font-mono text-[11px]">
				<span className="text-faint">{label}</span>
				<span className="tabular-nums font-semibold text-surface-foreground">{value}</span>
			</div>
			<div className="h-1.5 overflow-hidden rounded-full bg-surface-raised border border-white/[0.05]">
				<div
					className={`h-full rounded-full transition-all ${
						warn
							? "bg-gradient-to-r from-warning to-warning/80 shadow-[0_0_8px_var(--color-warning)]"
							: "bg-gradient-to-r from-accent to-accent/80 shadow-[0_0_8px_var(--color-accent)]"
					}`}
					style={{ width }}
				/>
			</div>
		</div>
	);
}
