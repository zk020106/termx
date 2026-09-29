import { WindowChrome } from "@/components/chrome/WindowChrome";
import { AiAssistPanel } from "@/components/panels/AiAssistPanel";
import { SnippetsMiniPanel } from "@/components/panels/SnippetsMiniPanel";
import { Button, IconButton } from "@/components/ui/Button";
import { Badge, EmptyState, EnvPill, MetricBar, ProgressBar, StatusDot, StatusText } from "@/components/ui/Display";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Overlay";
import { hosts, metrics, topProcesses } from "@/data/mock";
import type { MetricSeries, ProcessRow } from "@/data/types";
import { cn } from "@/lib/cn";
import { formatSpeed } from "@/lib/format";
import { toast } from "@/store/toast";
import { useUiStore, type RightPanelTab } from "@/store/ui";
import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router";

/* =============================================================================
 * 主机监控 —— 设计帧 termx.vetd/frames/monitor.tsx 的交互版。
 * 覆盖状态（需求书 06-主机监控）：正常 / 有指标超出阈值（磁盘 71% > 70%）/ 无法获取数据（连接中断 + 重试）。
 * 指标曲线全部用手写 SVG / div 绘制，不引入图表依赖；数据来自 @/data/mock 的 metrics 与 topProcesses。
 * ========================================================================== */

type MonitorState = "normal" | "alert" | "unavailable";
type SortKey = "pid" | "cpu" | "mem";

const STATE_OPTIONS: { value: MonitorState; label: string }[] = [
	{ value: "normal", label: "正常" },
	{ value: "alert", label: "超阈值" },
	{ value: "unavailable", label: "中断" },
];

const SORT_LABEL: Record<SortKey, string> = { pid: "PID", cpu: "CPU", mem: "内存" };

/** 右侧工具面板的三个页签（需求书 04-⑦：主机监控 / 命令片段 / AI 预留） */
const PANEL_TABS: { id: RightPanelTab; label: string }[] = [
	{ id: "monitor", label: "监控" },
	{ id: "snippets", label: "片段" },
	{ id: "ai", label: "AI 助手" },
];

const PANEL_TITLE: Record<RightPanelTab, string> = {
	monitor: "实时指标",
	snippets: "命令片段",
	ai: "AI 助手",
};

const GRID_COLS = "grid-cols-[72px_minmax(0,1fr)_96px_84px_80px_40px]";

const MONITORED_HOST = hosts.find((h) => h.id === "order-api-01") ?? hosts[0];

/** mock 里没有网络序列，这里用界面内的采样值兜底（单位 MB/s） */
const NETWORK_RX = [1.42, 1.68, 1.55, 1.72, 1.94, 2.02, 1.88, 2.11, 2.24, 2.08, 1.96, 2.14];
const NETWORK_TX = [0.28, 0.31, 0.26, 0.33, 0.36, 0.34, 0.38, 0.4, 0.37, 0.41, 0.39, 0.42];
const MB = 1024 * 1024;

const CPU = metrics[0];
const MEM = metrics[1];
const DISK = metrics[2];
const LOAD = metrics[3];

function isOver(metric: MetricSeries): boolean {
	return metric.threshold !== undefined && metric.value > metric.threshold;
}

function formatMetric(metric: MetricSeries): string {
	if (metric.unit === "G") return `${metric.value} / ${metric.max} G`;
	return `${metric.value}${metric.unit}`;
}

function percent(metric: MetricSeries): number {
	return Math.round(Math.min(100, (metric.value / metric.max) * 100));
}

/** 迷你折线：手写 SVG，配色走 token（currentColor） */
function Sparkline({
	samples,
	max,
	className,
	strokeClass,
}: {
	samples: number[];
	max: number;
	className?: string;
	strokeClass?: string;
}) {
	const w = 100;
	const h = 24;
	const peak = max > 0 ? max : 1;
	const points = samples
		.map((value, index) => {
			const x = samples.length > 1 ? (index / (samples.length - 1)) * w : w / 2;
			const y = h - Math.min(1, Math.max(0, value / peak)) * (h - 2) - 1;
			return `${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(" ");
	return (
		<svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn("h-6 w-full", strokeClass ?? className)} aria-hidden="true">
			<polygon points={`0,${h} ${points} ${w},${h}`} fill="currentColor" opacity={0.14} />
			<polyline
				points={points}
				fill="none"
				stroke="currentColor"
				strokeWidth={1.4}
				strokeLinecap="round"
				strokeLinejoin="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

/** 迷你柱状：设计帧「CPU 负载历史」那种柱子 */
function MiniBars({ samples, max, tone }: { samples: number[]; max: number; tone: "primary" | "warning" | "danger" }) {
	const peak = max > 0 ? max : 1;
	const barClass = { primary: "bg-primary", warning: "bg-warning", danger: "bg-danger" }[tone];
	return (
		<div className="flex h-11 items-end gap-[3px]">
			{samples.map((value, index) => (
				<div
					key={index}
					title={`${value}`}
					className={cn("flex-1 rounded-t", barClass)}
					style={{
						height: `${Math.max(5, Math.round(Math.min(1, value / peak) * 100))}%`,
						opacity: index === samples.length - 1 ? 1 : 0.45 + index / (samples.length * 2),
					}}
				/>
			))}
		</div>
	);
}

/** 指标卡片：当前值用 MetricBar 呈现；超阈值时整卡转成危险色 */
function MetricCard({
	metric,
	tone,
	chart,
}: {
	metric: MetricSeries;
	tone: "primary" | "warning" | "danger";
	chart: ReactNode;
}) {
	const progress = percent(metric);
	return (
		<div className={cn("rounded border bg-surface p-2.5", tone === "danger" ? "border-danger/50 bg-danger/10" : "border-border")}>
			{tone === "danger" ? (
				<div className="space-y-1">
					<div className="flex items-baseline justify-between gap-2 text-[11px]">
						<span className="flex items-center gap-1 text-danger">
							<span className="icon-[lucide--triangle-alert] size-3" />
							{metric.label}
						</span>
						<span className="font-mono font-medium tabular-nums text-danger">{formatMetric(metric)}</span>
					</div>
					<ProgressBar value={progress} tone="danger" />
				</div>
			) : (
				<MetricBar label={metric.label} value={formatMetric(metric)} progress={progress} warn={tone === "warning"} />
			)}
			<div className={cn("mt-1.5", tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-primary")}>
				{chart}
			</div>
			<div className="mt-1 font-mono text-[10px] text-faint">
				{metric.threshold !== undefined ? `阈值 ${metric.threshold}${metric.unit} · ` : ""}
				峰值 {Math.max(...metric.samples)}
				{metric.unit}
			</div>
		</div>
	);
}

export default function Monitor() {
	const [state, setState] = useState<MonitorState>("normal");
	const [procs, setProcs] = useState<ProcessRow[]>(topProcesses);
	const [query, setQuery] = useState("");
	const [sortKey, setSortKey] = useState<SortKey>("cpu");
	const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
	const [killTarget, setKillTarget] = useState<ProcessRow | null>(null);
	const [retrying, setRetrying] = useState(false);
	const [lastSampleAt, setLastSampleAt] = useState("10:14:28");
	const tab = useUiStore((s) => s.rightPanelTab);
	const setRightPanelTab = useUiStore((s) => s.setRightPanelTab);

	// 深链：#/monitor?panel=ai|snippets，便于直接切到某个页签核对
	const panelParam = new URLSearchParams(useLocation().search).get("panel") as RightPanelTab | null;
	useEffect(() => {
		if (panelParam && PANEL_TABS.some((t) => t.id === panelParam)) setRightPanelTab(panelParam);
	}, [panelParam, setRightPanelTab]);

	const down = state === "unavailable";
	const alert = state === "alert";
	const overMetrics = metrics.filter(isOver);
	const diskWarn = isOver(DISK);
	const rxNow = (NETWORK_RX.at(-1) ?? 0) * MB;
	const txNow = (NETWORK_TX.at(-1) ?? 0) * MB;
	const linkSpeed = 100 * MB;

	const visible = procs
		.filter((proc) => {
			const q = query.trim().toLowerCase();
			if (!q) return true;
			return (
				proc.command.toLowerCase().includes(q) ||
				String(proc.pid).includes(q) ||
				(proc.user ?? "").toLowerCase().includes(q)
			);
		})
		.sort((a, b) => {
			const dir = sortDir === "asc" ? 1 : -1;
			if (sortKey === "pid") return (a.pid - b.pid) * dir;
			if (sortKey === "cpu") return (a.cpu - b.cpu) * dir;
			return (a.mem - b.mem) * dir;
		});

	const topByCpu = [...procs].sort((a, b) => b.cpu - a.cpu).slice(0, 4);

	function toggleSort(key: SortKey) {
		if (key === sortKey) {
			setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
			return;
		}
		setSortKey(key);
		setSortDir(key === "pid" ? "asc" : "desc");
	}

	function retry() {
		setRetrying(true);
		window.setTimeout(() => {
			setRetrying(false);
			setState("normal");
			setLastSampleAt(new Date().toTimeString().slice(0, 8));
			toast({ title: "已恢复监控采集", description: `SSH 连接重建成功 · ${MONITORED_HOST.name}`, tone: "success" });
		}, 1200);
	}

	function confirmKill() {
		if (!killTarget) return;
		const victim = killTarget;
		setProcs((prev) => prev.filter((proc) => proc.pid !== victim.pid));
		setKillTarget(null);
		toast({
			title: `已结束进程 ${victim.pid}`,
			description: victim.command,
			tone: "warning",
			action: {
				label: "撤销",
				run: () => setProcs((prev) => (prev.some((proc) => proc.pid === victim.pid) ? prev : [...prev, victim])),
			},
		});
	}

	function sortHeader(key: SortKey, label: string, align: "left" | "right" = "left") {
		const active = sortKey === key;
		return (
			<button
				type="button"
				onClick={() => toggleSort(key)}
				className={cn(
					"flex items-center gap-1 uppercase transition-colors",
					align === "right" && "justify-end",
					active ? "text-surface-foreground" : "hover:text-muted",
				)}
			>
				{label}
				{active && (
					<span className={cn(sortDir === "asc" ? "icon-[lucide--arrow-up]" : "icon-[lucide--arrow-down]", "size-2.5")} />
				)}
			</button>
		);
	}

	return (
		<WindowChrome>
			<div className="relative flex min-h-0 flex-1 bg-surface">
				{/* 左侧：终端采样输出 + 进程列表 */}
				<div className="flex min-w-0 flex-1 flex-col">
					{/* 工具栏 */}
					<div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
						<div className="flex min-w-0 items-center gap-2">
							<span className="icon-[lucide--activity] size-3.5 text-primary" />
							<h1 className="text-[12px] font-semibold text-surface-foreground">主机监控</h1>
							<EnvPill env={MONITORED_HOST.env} size="xs" />
							<span className="truncate font-mono text-[11px] text-muted">
								{MONITORED_HOST.name} ({MONITORED_HOST.hostname})
							</span>
							{down ? (
								<span className="flex items-center gap-1.5 text-[11px] text-danger">
									<StatusDot status="failed" />
									连接已中断
								</span>
							) : (
								<StatusText status="connected" label="采集中" className="text-[11px]" />
							)}
							{alert && <Badge className="border-danger/40 text-danger">{overMetrics.length} 项指标超阈值</Badge>}
						</div>
						<div className="flex shrink-0 items-center gap-2">
							<span className="font-mono text-[10.5px] text-faint">最近采样 {lastSampleAt}</span>
							<Button size="sm" variant="ghost" icon="icon-[lucide--refresh-cw]" disabled={retrying} onClick={retry}>
								刷新
							</Button>

							{/* 状态切换器（骨架期评审工具） */}
							<div className="flex items-center gap-2 rounded-card border border-border bg-surface-raised px-2 py-1">
								<span className="text-[10px] font-medium tracking-wider text-faint uppercase">状态</span>
								<div className="flex items-center gap-0.5">
									{STATE_OPTIONS.map((option) => (
										<button
											key={option.value}
											type="button"
											onClick={() => {
												setState(option.value);
												if (option.value !== "unavailable") setRetrying(false);
											}}
											className={cn(
												"rounded px-1.5 py-0.5 text-[11px] transition-colors",
												state === option.value
													? "bg-primary/15 font-medium text-primary"
													: "text-muted hover:text-surface-foreground",
											)}
										>
											{option.label}
										</button>
									))}
								</div>
							</div>
						</div>
					</div>

					{/* 终端采样快照 */}
					<div className="shrink-0 border-b border-border bg-term px-4 py-3 font-mono text-[12px] leading-relaxed text-term-ink">
						<div className="flex items-center justify-between border-b border-border/50 pb-2 text-[11px] text-muted">
							<div className="flex items-center gap-2">
								<span className="font-medium text-primary">
									{MONITORED_HOST.username}@{MONITORED_HOST.name}:~$
								</span>
								<span>top -b -n 1 | head -n 12</span>
							</div>
							<span className="text-faint">{lastSampleAt}</span>
						</div>

						{down ? (
							<div className="mt-3 space-y-1">
								<div className="text-danger">Connection to {MONITORED_HOST.hostname} closed by remote host.</div>
								<div className="text-muted">监控采样已停止：实时指标与进程列表均不可用，请重试连接。</div>
							</div>
						) : (
							<div className="mt-3 space-y-1 text-muted">
								<div>
									top - {lastSampleAt} up 41 days, 6:18, 2 users, load average: {LOAD.value}, 1.42, 1.10
								</div>
								<div>Tasks: 168 total, 1 running, 167 sleeping, 0 stopped, 0 zombie</div>
								<div>
									%Cpu(s): <span className="text-surface-foreground">{CPU.value} us</span>, 2.1 sy, 0.0 ni,{" "}
									{(100 - CPU.value).toFixed(1)} id, 0.7 wa, 0.0 hi, 0.0 si
								</div>
								<div>
									MiB Mem : 7924.2 total, 1240.1 free,{" "}
									<span className={cn(diskWarn ? "text-warning" : "text-primary")}>
										{(MEM.value * 1024).toFixed(1)} used
									</span>
									, 3541.3 buff/cache
								</div>
								<div>MiB Swap: 2048.0 total, 2048.0 free, 0.0 used. 4412.0 avail Mem</div>
							</div>
						)}
					</div>

					{/* 进程列表 */}
					<div className="flex min-h-0 flex-1 flex-col bg-surface">
						<div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
							<div className="flex items-center gap-2">
								<span className="icon-[lucide--list-tree] size-3.5 text-muted" />
								<span className="text-[12px] font-medium text-surface-foreground">进程列表</span>
								<Badge>
									{visible.length} / {procs.length}
								</Badge>
								<span className="font-mono text-[10.5px] text-faint">
									按 {SORT_LABEL[sortKey]} {sortDir === "asc" ? "升序" : "降序"}
								</span>
							</div>
							<div className="flex items-center gap-2">
								<div className="relative">
									<span className="icon-[lucide--search] absolute top-1/2 left-2 size-3 -translate-y-1/2 text-faint" />
									<Input
										value={query}
										onChange={(e) => setQuery(e.target.value)}
										placeholder="搜索命令 / PID / 用户"
										className="h-6.5 w-56 pl-7 text-[11px]"
									/>
								</div>
								<Button
									size="sm"
									variant="ghost"
									icon="icon-[lucide--rotate-ccw]"
									onClick={() => {
										setQuery("");
										setSortKey("cpu");
										setSortDir("desc");
									}}
								>
									重置
								</Button>
							</div>
						</div>

						{/* 表头 */}
						<div
							className={cn(
								"grid shrink-0 items-center gap-2 border-b border-border bg-surface-sunk px-3 py-1.5 font-mono text-[10px] tracking-wider text-faint",
								GRID_COLS,
							)}
						>
							{sortHeader("pid", "PID")}
							<span className="uppercase">命令</span>
							<span className="uppercase">用户</span>
							{sortHeader("cpu", "CPU", "right")}
							{sortHeader("mem", "内存", "right")}
							<span className="text-right uppercase">操作</span>
						</div>

						<div className="min-h-0 flex-1 overflow-y-auto">
							{down ? (
								<EmptyState
									icon="icon-[lucide--plug-zap]"
									title="无法获取进程列表"
									description={`与 ${MONITORED_HOST.name} (${MONITORED_HOST.hostname}) 的连接已中断，采样进程列表失败。`}
									action={
										<Button size="sm" variant="primary" icon="icon-[lucide--refresh-cw]" disabled={retrying} onClick={retry}>
											{retrying ? "重连中…" : "重试"}
										</Button>
									}
								/>
							) : visible.length === 0 ? (
								<EmptyState
									icon="icon-[lucide--search-x]"
									title={procs.length === 0 ? "进程列表为空" : "没有匹配的进程"}
									description={procs.length === 0 ? "本次采样没有返回任何进程。" : `没有命令、PID 或用户匹配「${query}」。`}
									action={
										procs.length > 0 ? (
											<Button size="sm" icon="icon-[lucide--eraser]" onClick={() => setQuery("")}>
												清空搜索
											</Button>
										) : undefined
									}
								/>
							) : (
								visible.map((proc) => (
									<div
										key={proc.pid}
										className={cn(
											"grid items-center gap-2 border-b border-border/60 px-3 py-1.5 transition-colors hover:bg-surface-raised",
											GRID_COLS,
										)}
									>
										<span className="font-mono text-[11px] tabular-nums text-faint">{proc.pid}</span>
										<span className="truncate font-mono text-[11.5px] text-surface-foreground" title={proc.command}>
											{proc.command}
										</span>
										<span className="truncate font-mono text-[11px] text-muted">{proc.user ?? "—"}</span>
										<span className="text-right font-mono text-[11.5px] tabular-nums text-primary">
											{proc.cpu.toFixed(1)}%
										</span>
										<span className="text-right font-mono text-[11px] tabular-nums text-muted">
											{proc.mem.toFixed(1)}%
										</span>
										<div className="flex justify-end">
											<IconButton
												icon="icon-[lucide--x-circle]"
												label={`结束进程 ${proc.pid}`}
												className="size-6 hover:text-danger"
												onClick={() => setKillTarget(proc)}
											/>
										</div>
									</div>
								))
							)}
						</div>

						<div className="flex h-7 shrink-0 items-center justify-between border-t border-border px-3 font-mono text-[10.5px] text-faint">
							<span>
								采样周期 2.0s · {MONITORED_HOST.username}@{MONITORED_HOST.hostname}
							</span>
							<span>{down ? "连接中断，数据已冻结" : `最近更新 ${lastSampleAt}`}</span>
						</div>
					</div>
				</div>

				{/* 右侧遥测面板 (Linear 风格 340px) */}
				<aside className="flex w-[340px] shrink-0 flex-col border-l border-border bg-surface-sunk">
					<div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3 text-[12px]">
						<div className="flex items-center gap-2">
							<span className="font-medium text-surface-foreground">{PANEL_TITLE[tab]}</span>
							<span className="text-border">/</span>
							<span className="font-mono text-[11px] text-muted">{MONITORED_HOST.name}</span>
						</div>
						{/* 可切换的右侧工具面板，不再只是装饰标签 */}
						<div className="flex items-center gap-1">
							{PANEL_TABS.map((t) => (
								<button
									key={t.id}
									type="button"
									onClick={() => setRightPanelTab(t.id)}
									className={cn(
										"rounded px-2 py-0.5 text-[11px] transition-colors",
										tab === t.id
											? "border border-border bg-surface-raised font-medium text-primary"
											: "text-muted hover:bg-surface-raised hover:text-surface-foreground",
									)}
								>
									{t.label}
								</button>
							))}
						</div>
					</div>

					{/* 遥测内容：切到别的页签时隐藏而不卸载，保留滚动位置与采样状态 */}
					<div className={cn("min-h-0 flex-1 space-y-4 overflow-y-auto p-3", tab !== "monitor" && "hidden")}>
						{down ? (
							<>
								<div className="rounded border border-danger/40 bg-danger/10 p-3">
									<div className="flex items-center gap-1.5 text-[11.5px] font-medium text-danger">
										<span className="icon-[lucide--plug-zap] size-3.5" />
										无法获取监控数据
									</div>
									<p className="mt-1.5 text-[11px] leading-4 text-muted">
										{MONITORED_HOST.name}（{MONITORED_HOST.hostname}）的 SSH 连接在 {lastSampleAt} 中断，
										Agentless SSH 采样已停止。
									</p>
									<div className="mt-2.5 flex items-center gap-2">
										<Button
											size="sm"
											variant="primary"
											icon="icon-[lucide--refresh-cw]"
											disabled={retrying}
											onClick={retry}
										>
											{retrying ? "重连中…" : "重试"}
										</Button>
										<span className="font-mono text-[10.5px] text-faint">上次成功采样 {lastSampleAt}</span>
									</div>
								</div>

								<div className="grid grid-cols-2 gap-2">
									{metrics.map((metric) => (
										<div key={metric.label} className="rounded border border-border bg-surface p-2.5">
											<div className="text-[10.5px] text-muted">{metric.label}</div>
											<div className="mt-1 font-mono text-[15px] font-semibold text-faint">—</div>
											<div className="mt-1 h-1 rounded bg-surface-sunk" />
											<div className="mt-1 font-mono text-[10px] text-faint">等待重连</div>
										</div>
									))}
								</div>

								<div className="rounded border border-border bg-surface p-3 text-[11px] leading-4 text-muted">
									<div className="mb-1 flex items-center gap-1.5 font-medium text-surface-foreground">
										<span className="icon-[lucide--info] size-3.5 text-faint" />
										可能的原因
									</div>
									<ul className="space-y-0.5">
										<li>· 远程 sshd 重启或主机网络抖动</li>
										<li>· 跳板链路 bastion-sh 会话过期</li>
										<li>· 远程负载过高导致采样命令超时</li>
									</ul>
								</div>
							</>
						) : (
							<>
								{/* 2x2 核心指标卡片 + 迷你趋势 */}
								<div className="grid grid-cols-2 gap-2">
									<MetricCard
										metric={CPU}
										tone="primary"
										chart={<MiniBars samples={CPU.samples} max={CPU.max} tone="primary" />}
									/>
									<MetricCard
										metric={MEM}
										tone="primary"
										chart={<Sparkline samples={MEM.samples} max={MEM.max} strokeClass="text-accent" />}
									/>
									<MetricCard
										metric={DISK}
										tone={alert ? "danger" : "warning"}
										chart={
											<MiniBars samples={DISK.samples} max={DISK.max} tone={alert ? "danger" : "warning"} />
										}
									/>
									<MetricCard
										metric={LOAD}
										tone="primary"
										chart={<Sparkline samples={LOAD.samples} max={LOAD.max} strokeClass="text-primary" />}
									/>
								</div>

								{/* 网络吞吐 */}
								<div className="rounded border border-border bg-surface p-3">
									<div className="mb-2 flex items-center justify-between">
										<span className="font-sans text-[10.5px] font-medium tracking-wider text-faint uppercase">
											网络流量 (eth0)
										</span>
										<span className="font-mono text-[10.5px] text-faint">千兆链路</span>
									</div>
									<svg viewBox="0 0 100 26" preserveAspectRatio="none" className="h-6 w-full" aria-hidden="true">
										<polyline
											points={NETWORK_RX.map((value, index) => {
												const x = (index / (NETWORK_RX.length - 1)) * 100;
												const y = 25 - (value / 3) * 24;
												return `${x.toFixed(2)},${y.toFixed(2)}`;
											}).join(" ")}
											className="text-success"
											fill="none"
											stroke="currentColor"
											strokeWidth={1.4}
											vectorEffect="non-scaling-stroke"
										/>
										<polyline
											points={NETWORK_TX.map((value, index) => {
												const x = (index / (NETWORK_TX.length - 1)) * 100;
												const y = 25 - (value / 3) * 24;
												return `${x.toFixed(2)},${y.toFixed(2)}`;
											}).join(" ")}
											className="text-primary"
											fill="none"
											stroke="currentColor"
											strokeWidth={1.4}
											vectorEffect="non-scaling-stroke"
										/>
									</svg>
									<div className="mt-2 space-y-1 font-mono text-[11.5px]">
										<div className="flex items-center justify-between">
											<span className="flex items-center gap-1.5 text-muted">
												<span className="icon-[lucide--arrow-down] size-3 text-success" />
												接收 (RX)
											</span>
											<span className="tabular-nums text-surface-foreground">{formatSpeed(rxNow)}</span>
										</div>
										<div className="flex items-center justify-between">
											<span className="flex items-center gap-1.5 text-muted">
												<span className="icon-[lucide--arrow-up] size-3 text-primary" />
												发送 (TX)
											</span>
											<span className="tabular-nums text-surface-foreground">{formatSpeed(txNow)}</span>
										</div>
									</div>
									<MetricBar
										className="mt-2.5"
										label="接收带宽占用"
										value={`${((rxNow / linkSpeed) * 100).toFixed(1)}%`}
										progress={Math.round((rxNow / linkSpeed) * 100)}
										warn={rxNow / linkSpeed > 0.8}
									/>
								</div>

								{/* 阈值报警横幅 */}
								{overMetrics.length > 0 && (
									<div
										className={cn(
											"rounded border p-2.5 text-[11.5px] leading-relaxed",
											alert ? "border-danger/40 bg-danger/10 text-danger" : "border-warning/40 bg-warning/10 text-warning",
										)}
									>
										<div className="flex items-center gap-1.5 font-medium">
											<span className="icon-[lucide--triangle-alert] size-3.5" />
											<span>{DISK.label}利用率超过 {DISK.threshold}% 阈值</span>
										</div>
										<p className="mt-1 text-[11px] opacity-90">
											/var/log 目录占用已达 41.2 GB，建议执行命令片段排查大日志文件。
										</p>
										{alert && (
											<p className="mt-1 font-mono text-[10.5px] opacity-90">
												当前 {DISK.value}% · 阈值 {DISK.threshold}% · 超出 {DISK.value - (DISK.threshold ?? 0)} 个百分点
											</p>
										)}
									</div>
								)}

								{/* Top 进程摘要 */}
								<div className="rounded border border-border bg-surface p-3">
									<div className="mb-2 flex items-center justify-between">
										<span className="text-[11.5px] font-medium text-surface-foreground">Top 进程占用</span>
										<span className="font-mono text-[10.5px] text-faint">按 CPU 排序</span>
									</div>
									<div className="space-y-1.5 font-mono text-[11px]">
										{topByCpu.map((proc) => (
											<div key={proc.pid} className="flex items-center justify-between">
												<div className="flex max-w-[200px] items-center gap-1.5 truncate">
													<span className="text-faint">{proc.pid}</span>
													<span className="truncate font-sans text-surface-foreground">{proc.command}</span>
												</div>
												<span className="tabular-nums text-primary">{proc.cpu.toFixed(1)}%</span>
											</div>
										))}
										{topByCpu.length === 0 && <span className="text-faint">暂无进程数据</span>}
									</div>
									<p className="mt-2 text-[10.5px] text-faint">完整列表与结束进程操作见左侧进程表。</p>
								</div>
							</>
						)}
					</div>

					{/* 另两个页签各自的内容 */}
					{tab === "snippets" && <SnippetsMiniPanel hostName={MONITORED_HOST.name} />}
					{tab === "ai" && <AiAssistPanel hostName={MONITORED_HOST.name} />}

					{tab === "monitor" && (
						<div className="flex shrink-0 justify-between border-t border-border bg-surface-raised px-3 py-2 font-mono text-[10.5px] text-faint">
							<span>采样周期: 2.0s</span>
							<span>Agentless SSH</span>
						</div>
					)}
				</aside>

				{/* 结束进程确认 */}
				<Modal
					open={killTarget !== null}
					onClose={() => setKillTarget(null)}
					title="结束进程"
					icon="icon-[lucide--octagon-alert]"
					width={420}
					footer={
						<>
							<Button onClick={() => setKillTarget(null)}>取消</Button>
							<Button variant="danger" icon="icon-[lucide--skull]" onClick={confirmKill}>
								结束进程
							</Button>
						</>
					}
				>
					{killTarget && (
						<>
							<p className="mb-2">
								将向进程发送 <span className="font-mono text-surface-foreground">SIGTERM</span>，进程未退出时再发送{" "}
								<span className="font-mono text-surface-foreground">SIGKILL</span>。
							</p>
							<div className="space-y-1 rounded border border-border bg-surface p-2.5 font-mono text-[11px]">
								<div className="flex items-center gap-2">
									<span className="text-faint">PID</span>
									<span className="text-surface-foreground">{killTarget.pid}</span>
								</div>
								<div className="flex items-center gap-2">
									<span className="text-faint">用户</span>
									<span className="text-surface-foreground">{killTarget.user ?? "—"}</span>
								</div>
								<div className="break-all text-surface-foreground">{killTarget.command}</div>
								<div className="flex items-center gap-2">
									<span className="text-faint">占用</span>
									<span className="text-primary">CPU {killTarget.cpu.toFixed(1)}%</span>
									<span className="text-muted">内存 {killTarget.mem.toFixed(1)}%</span>
								</div>
							</div>
							<p className="mt-2 flex items-center gap-1.5 text-[10.5px] text-faint">
								<span className="icon-[lucide--info] size-3" />
								结束系统关键进程可能导致服务中断，结束前请确认进程用途。
							</p>
						</>
					)}
				</Modal>
			</div>
		</WindowChrome>
	);
}
