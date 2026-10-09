import { WindowChrome } from "@/components/chrome/WindowChrome";
import { AiAssistPanel } from "@/components/panels/AiAssistPanel";
import { SnippetsMiniPanel } from "@/components/panels/SnippetsMiniPanel";
import { Button } from "@/components/ui/Button";
import { EmptyState, MetricBar, StatusDot } from "@/components/ui/Display";
import { cn } from "@/lib/cn";
import { formatMs } from "@/lib/probe";
import {
	cpuPercent,
	formatKib,
	formatUptime,
	hasLinuxMetrics,
	METRICS_COMMAND,
	parseMetrics,
	type CpuTimes,
	type HostMetrics,
} from "@/lib/hostMetrics";
import { describeRtt, sshExec, type SshRttReport } from "@/lib/ssh";
import { useHostsStore } from "@/store/hosts";
import { useProbeStore } from "@/store/probe";
import { useSessionsStore } from "@/store/sessions";
import { toast } from "@/store/toast";
import { useUiStore, type RightPanelTab } from "@/store/ui";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

/* =============================================================================
 * 主机监控（路由 /monitor）。
 *
 * 核心网络性能监控：**SSH 端到端往返延迟 (SSH RTT)**
 * 通过远程连接真实的 SSH keepalive 全局往返进行高精度端到端延迟测量，
 * 包含两端协议栈真实耗时与网络抖动、丢包统计。
 *
 * 系统资源（CPU / 内存 / 磁盘 / 负载 / 进程）：在同一条 SSH 连接上另开 exec 通道，
 * 每 3 秒读一次 /proc、df、ps（只读，无需安装代理；仅支持 Linux 主机）。
 * ========================================================================== */

/** 右侧工具面板的三个页签（主机监控 / 命令片段 / AI 预留） */
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

export default function Monitor() {
	const navigate = useNavigate();
	const tab = useUiStore((s) => s.rightPanelTab);
	const setRightPanelTab = useUiStore((s) => s.setRightPanelTab);

	const tabs = useSessionsStore((s) => s.tabs);
	const hosts = useHostsStore((s) => s.hosts);
	const connectedTabs = tabs.filter((t) => t.hostId && t.sessionKey && t.status === "connected");

	const [selectedSessionKey, setSelectedSessionKey] = useState<string>("");
	const [measuring, setMeasuring] = useState(false);

	const activeTab = connectedTabs.find((t) => t.sessionKey === selectedSessionKey) ?? connectedTabs[0] ?? null;
	const activeHost = activeTab ? hosts.find((h) => h.id === activeTab.hostId) ?? null : null;
	const currentSessionKey = activeTab?.sessionKey ?? null;

	const rtt = useProbeStore((s) => (currentSessionKey ? s.rtt[currentSessionKey] : undefined));

	// 深链：#/monitor?panel=ai|snippets
	const panelParam = new URLSearchParams(useLocation().search).get("panel") as RightPanelTab | null;
	useEffect(() => {
		if (panelParam && PANEL_TABS.some((t) => t.id === panelParam)) setRightPanelTab(panelParam);
	}, [panelParam, setRightPanelTab]);

	const metrics = useHostMetrics(currentSessionKey);

	const hostName = activeHost ? `${activeHost.name} (${activeHost.hostname})` : activeTab?.title ?? "未选择连接";

	/** 在活跃 SSH 通道上量一次真实往返 */
	const measureSshRtt = async () => {
		if (!currentSessionKey) return;
		setMeasuring(true);
		try {
			const report = await useProbeStore.getState().measureRtt(currentSessionKey, {
				samples: 5,
				timeoutMs: 1500,
			});
			if (!report || report.received === 0) {
				toast({ title: "SSH keepalive 无响应", description: report?.error ?? "测量超时", tone: "danger" });
			} else {
				toast({
					title: `SSH 往返延迟: ${formatMs(report.median_ms)} ms`,
					description: `抖动 ±${report.jitter_ms.toFixed(1)} ms · 丢包率 ${Math.round(report.loss * 100)}%`,
					tone: "success",
				});
			}
		} finally {
			setMeasuring(false);
		}
	};

	return (
		<WindowChrome>
			<div className="relative flex min-h-0 flex-1 bg-surface">
				{/* 左侧：SSH 往返测量 + 系统监控说明 */}
				<div className="flex min-w-0 flex-1 flex-col">
					{/* 工具栏 */}
					<div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
						<div className="flex min-w-0 items-center gap-2">
							<span className="icon-[lucide--activity] size-3.5 text-primary" />
							<h1 className="text-[12px] font-semibold text-surface-foreground">主机监控</h1>
							<StatusDot status={activeTab ? "connected" : "idle"} size={6} />
							<span className="truncate font-mono text-[11px] text-muted">{hostName}</span>
						</div>
						<span className="shrink-0 font-mono text-[10.5px] text-faint">SSH 端到端遥测</span>
					</div>

					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
						{/* SSH 延迟遥测核心卡片 */}
						<section className="shrink-0 rounded-2xl border border-border bg-surface-raised/70 p-4">
							<header className="flex h-9 items-center justify-between gap-2 border-b border-border/60 pb-3">
								<div className="flex items-center gap-2">
									<span className="icon-[lucide--zap] size-4 text-primary" />
									<span className="text-[13px] font-semibold text-surface-foreground">SSH 往返延迟 (RTT)</span>
									<span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">端到端实测</span>
								</div>

								<div className="flex items-center gap-2">
									{connectedTabs.length > 0 && (
										<select
											value={activeTab?.sessionKey ?? ""}
											onChange={(e) => setSelectedSessionKey(e.target.value)}
											className="h-7 max-w-[240px] rounded-lg border border-border bg-surface px-2 font-mono text-[11px] text-surface-foreground transition-colors focus:border-primary focus:outline-none"
											aria-label="选择测量会话"
										>
											{connectedTabs.map((t) => (
												<option key={t.sessionKey} value={t.sessionKey ?? ""}>
													{t.title}
												</option>
											))}
										</select>
									)}

									<Button
										size="sm"
										variant="primary"
										icon="icon-[lucide--activity]"
										disabled={!currentSessionKey || measuring}
										onClick={() => void measureSshRtt()}
									>
										{measuring ? "测量中…" : "测量 SSH 往返"}
									</Button>
								</div>
							</header>

							<div className="pt-3">
								{activeTab && rtt ? (
									<SshRttReadout report={rtt} />
								) : activeTab ? (
									<div className="flex flex-col items-center justify-center gap-2 py-6 text-center text-muted">
										<span className="icon-[lucide--activity] size-6 text-faint" />
										<div className="text-[12px] font-medium text-surface-foreground">已就绪，等待测量</div>
										<p className="text-[11px] text-faint">
											已连接到 {activeTab.title}，点击右上角「测量 SSH 往返」进行 5 次 keepalive 样本采样。
										</p>
									</div>
								) : (
									<div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-muted">
										<span className="icon-[lucide--unplug] size-6 text-faint" />
										<div className="text-[12px] font-medium text-surface-foreground">当前无活跃的 SSH 连接</div>
										<p className="text-[11px] text-faint">
											SSH 往返测量需在真实连接上进行，请先在终端工作区连接远程主机。
										</p>
										<Button size="sm" variant="primary" icon="icon-[lucide--terminal]" onClick={() => navigate("/workspace")} className="mt-1">
											进入终端工作区
										</Button>
									</div>
								)}
							</div>
						</section>

						{/* 系统资源：无代理 SSH 周期采样 */}
						<section className="rounded-2xl border border-border/60 bg-surface-raised/40 p-4">
							<div className="flex items-center gap-2 text-[12px] font-medium text-surface-foreground">
								<span className="icon-[lucide--cpu] size-4 text-muted" />
								<span>系统资源监控 (CPU / 内存 / 磁盘 / 进程)</span>
								{metrics.data && (
									<span className="ml-auto font-mono text-[10.5px] font-normal text-faint">
										已运行 {formatUptime(metrics.data.uptimeSec)}
									</span>
								)}
							</div>
							{!activeTab ? (
								<p className="mt-2 text-[11.5px] leading-5 text-muted">
									远程主机系统资源指标走无代理 SSH 周期采样通道，不安装额外 Daemon。连接主机后自动开始采样。
								</p>
							) : metrics.error ? (
								<p className="mt-2 text-[11.5px] leading-5 text-danger">{metrics.error}</p>
							) : !metrics.data ? (
								<p className="mt-2 text-[11.5px] leading-5 text-muted">正在采样…</p>
							) : (
								<ProcessTable metrics={metrics.data} />
							)}
						</section>
					</div>
				</div>

				{/* 右侧遥测面板 */}
				<aside className="flex w-[340px] shrink-0 flex-col border-l border-border bg-surface-sunk">
					<div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3 text-[12px]">
						<div className="flex items-center gap-2">
							<span className="font-medium text-surface-foreground">{PANEL_TITLE[tab]}</span>
							<span className="text-border">/</span>
							<span className="font-mono text-[11px] text-muted">{hostName}</span>
						</div>
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

					{/* 遥测内容 */}
					<div className={cn("min-h-0 flex-1 overflow-y-auto", tab !== "monitor" && "hidden")}>
						{!activeTab ? (
							<EmptyState icon="icon-[lucide--gauge]" title="没有已连接的主机" description="连接主机后自动采样实时指标。" />
						) : metrics.error ? (
							<EmptyState icon="icon-[lucide--gauge]" title="实时指标不可用" description={metrics.error} />
						) : !metrics.data ? (
							<EmptyState icon="icon-[lucide--gauge]" title="正在采样…" />
						) : (
							<LiveMetrics metrics={metrics.data} cpu={metrics.cpu} />
						)}
					</div>

					{tab === "snippets" && <SnippetsMiniPanel hostName={hostName} />}
					{tab === "ai" && <AiAssistPanel hostName={hostName} />}

					{tab === "monitor" && (
						<div className="flex shrink-0 justify-between border-t border-border bg-surface-raised px-3 py-2 font-mono text-[10.5px] text-faint">
							<span>采样方式: SSH exec · 每 3 秒</span>
							<span>{!activeTab ? "未连接" : metrics.error ? "采样失败" : metrics.updatedAt ? "端到端在线" : "采样中"}</span>
						</div>
					)}
				</aside>
			</div>
		</WindowChrome>
	);
}

/* ============================== SSH RTT 局部读数 ============================== */

function SshRttReadout({ report }: { report: SshRttReport }) {
	if (report.received === 0) {
		return (
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-danger">
				<span className="font-sans text-[11.5px] font-medium">SSH 无响应</span>
				<span>{describeRtt(report)}</span>
				{report.error && <span className="text-faint">{report.error}</span>}
			</div>
		);
	}

	return (
		<>
			<MetricBar
				label="SSH 往返延迟 (中位数)"
				value={`${formatMs(report.median_ms)} ms`}
				progress={Math.min(100, (report.median_ms / 300) * 100)}
				warn={report.median_ms > 150}
			/>
			<div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-[11px] text-muted">
				<MetricRow label="最低 / 最高" value={`${formatMs(report.min_ms)} / ${formatMs(report.max_ms)} ms`} />
				<MetricRow label="抖动 (Jitter)" value={`±${report.jitter_ms.toFixed(1)} ms`} />
				<MetricRow label="丢包率" value={`${Math.round(report.loss * 100)}%`} />
				<MetricRow label="成功采样" value={`${report.received}/${report.sent} 次`} />
				<div className="col-span-2 mt-1 rounded bg-surface p-2 text-[10px] text-faint">
					<span>样本序列：</span>
					<span>{report.samples.map((s) => `${formatMs(s)}ms`).join(" → ")}</span>
				</div>
			</div>
		</>
	);
}

function MetricRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 justify-between gap-2 border-b border-border/40 pb-1">
			<span className="shrink-0 text-faint">{label}</span>
			<span className="truncate tabular-nums font-medium text-surface-foreground">{value}</span>
		</div>
	);
}

/* ============================== 系统资源采样 ============================== */

const METRICS_INTERVAL_MS = 3000;

interface MetricsState {
	data: HostMetrics | null;
	cpu: number | null;
	error: string | null;
	updatedAt: number | null;
}

/** 每 3 秒在会话上跑一次只读采样命令；页面不可见或会话变化时停止。上一次没回来不会叠下一次。 */
function useHostMetrics(sessionKey: string | null): MetricsState {
	const [state, setState] = useState<MetricsState>({ data: null, cpu: null, error: null, updatedAt: null });
	const prevCpu = useRef<CpuTimes | null>(null);

	useEffect(() => {
		setState({ data: null, cpu: null, error: null, updatedAt: null });
		prevCpu.current = null;
		if (!sessionKey) return;
		let stopped = false;
		let timer: number | undefined;

		const tick = async () => {
			try {
				const out = await sshExec(sessionKey, METRICS_COMMAND, 8000);
				if (stopped) return;
				const data = parseMetrics(out.stdout);
				if (!hasLinuxMetrics(data)) {
					setState({
						data: null,
						cpu: null,
						error: "这台主机上读不到 /proc（目前只支持 Linux 主机的系统指标）",
						updatedAt: Date.now(),
					});
					return; // 不支持就不再轮询
				}
				const cpu = cpuPercent(prevCpu.current, data.cpuTimes);
				prevCpu.current = data.cpuTimes;
				setState((prev) => ({ data, cpu: cpu ?? prev.cpu, error: null, updatedAt: Date.now() }));
			} catch (error) {
				if (stopped) return;
				setState((prev) => ({ ...prev, error: `采样失败：${error instanceof Error ? error.message : String(error)}` }));
			}
			if (!stopped) timer = window.setTimeout(() => void tick(), METRICS_INTERVAL_MS);
		};
		void tick();
		return () => {
			stopped = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [sessionKey]);

	return state;
}

function percent(used: number | null, total: number | null): number | null {
	if (used === null || total === null || total <= 0) return null;
	return (used / total) * 100;
}

function LiveMetrics({ metrics, cpu }: { metrics: HostMetrics; cpu: number | null }) {
	const mem = percent(metrics.memUsed, metrics.memTotal);
	const disk = percent(metrics.diskUsed, metrics.diskTotal);
	const swap = percent(metrics.swapUsed, metrics.swapTotal);
	const loadPerCore = metrics.load && metrics.cores ? (metrics.load[0] / metrics.cores) * 100 : null;
	return (
		<div className="space-y-3 p-3">
			<MetricBar
				label={`CPU${metrics.cores ? `（${metrics.cores} 核）` : ""}`}
				value={cpu === null ? "采样中" : `${cpu.toFixed(1)}%`}
				progress={cpu ?? 0}
				warn={(cpu ?? 0) > 85}
			/>
			<MetricBar
				label="内存"
				value={mem === null ? "—" : `${formatKib(metrics.memUsed)} / ${formatKib(metrics.memTotal)}`}
				progress={mem ?? 0}
				warn={(mem ?? 0) > 90}
			/>
			{metrics.swapTotal ? (
				<MetricBar
					label="交换分区"
					value={`${formatKib(metrics.swapUsed)} / ${formatKib(metrics.swapTotal)}`}
					progress={swap ?? 0}
					warn={(swap ?? 0) > 50}
				/>
			) : null}
			<MetricBar
				label={`磁盘 ${metrics.diskMount ?? "/"}`}
				value={disk === null ? "—" : `${formatKib(metrics.diskUsed)} / ${formatKib(metrics.diskTotal)}`}
				progress={disk ?? 0}
				warn={(disk ?? 0) > 90}
			/>
			<MetricBar
				label="负载 (1 / 5 / 15 分钟)"
				value={metrics.load ? metrics.load.map((v) => v.toFixed(2)).join(" / ") : "—"}
				progress={Math.min(100, loadPerCore ?? 0)}
				warn={(loadPerCore ?? 0) > 100}
			/>
		</div>
	);
}

function ProcessTable({ metrics }: { metrics: HostMetrics }) {
	if (metrics.processes.length === 0) {
		return <p className="mt-2 text-[11.5px] leading-5 text-muted">读不到进程列表（服务器的 ps 不支持排序参数）。</p>;
	}
	return (
		<div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface font-mono text-[11px]">
			<div className="grid grid-cols-[64px_1fr_64px_64px] border-b border-border bg-surface-sunk/60 px-3 py-1.5 text-[10.5px] text-faint">
				<span>PID</span>
				<span>进程</span>
				<span className="text-right">CPU%</span>
				<span className="text-right">MEM%</span>
			</div>
			{metrics.processes.map((p) => (
				<div key={p.pid} className="grid grid-cols-[64px_1fr_64px_64px] border-b border-border/40 px-3 py-1 last:border-0">
					<span className="text-faint">{p.pid}</span>
					<span className="truncate text-surface-foreground">{p.command}</span>
					<span className="text-right tabular-nums">{p.cpu.toFixed(1)}</span>
					<span className="text-right tabular-nums">{p.mem.toFixed(1)}</span>
				</div>
			))}
		</div>
	);
}
