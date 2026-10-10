import { MetricBar, StatusDot } from "@/components/ui/Display";
import type { Host } from "@/data/types";
import {
	cpuPercent,
	formatKib,
	hasLinuxMetrics,
	METRICS_COMMAND,
	parseMetrics,
	type HostMetrics,
} from "@/lib/hostMetrics";
import { describeRtt, sshExec } from "@/lib/ssh";
import { formatMs } from "@/lib/probe";
import { useProbeStore } from "@/store/probe";
import { toast } from "@/store/toast";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

interface CompanionMonitorProps {
	sessionKey: string | null;
	activeHost?: Host | null;
}

export function CompanionMonitor({ sessionKey, activeHost: _activeHost }: CompanionMonitorProps) {
	const navigate = useNavigate();
	const [measuring, setMeasuring] = useState(false);
	const rtt = useProbeStore((s) => (sessionKey ? s.rtt[sessionKey] : undefined));

	// 远程指标采样
	const [metrics, setMetrics] = useState<HostMetrics | null>(null);
	const [cpu, setCpu] = useState<number | null>(null);
	const [metricsError, setMetricsError] = useState<string | null>(null);
	const [lastUpdate, setLastUpdate] = useState<number | null>(null);
	const prevCpu = useRef<{ idle: number; total: number } | null>(null);

	// 定时轮询监控数据
	useEffect(() => {
		setMetrics(null);
		setCpu(null);
		setMetricsError(null);
		prevCpu.current = null;
		if (!sessionKey) return;

		let stopped = false;
		const tick = async () => {
			try {
				const out = await sshExec(sessionKey, METRICS_COMMAND, 6000);
				if (stopped) return;
				const data = parseMetrics(out.stdout);
				if (!hasLinuxMetrics(data)) {
					setMetricsError("当前主机非 Linux 或只读受限");
					return;
				}
				if (prevCpu.current && data.cpuTimes) {
					setCpu(cpuPercent(prevCpu.current, data.cpuTimes));
				}
				prevCpu.current = data.cpuTimes;
				setMetrics(data);
				setMetricsError(null);
				setLastUpdate(Date.now());
			} catch (e) {
				if (!stopped) setMetricsError("采样超时或会话忙碌");
			}
		};

		void tick();
		const timer = setInterval(() => void tick(), 3000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [sessionKey]);

	const handleMeasureRtt = async () => {
		if (!sessionKey) return;
		setMeasuring(true);
		try {
			const report = await useProbeStore.getState().measureRtt(sessionKey, {
				samples: 5,
				timeoutMs: 1500,
			});
			if (!report || report.received === 0) {
				toast({ title: "SSH keepalive 无响应", tone: "danger" });
			} else {
				toast({
					title: `往返延迟: ${formatMs(report.median_ms)} ms`,
					description: `抖动 ±${report.jitter_ms.toFixed(1)} ms`,
					tone: "success",
				});
			}
		} finally {
			setMeasuring(false);
		}
	};

	const percent = (used: number | null, total: number | null) =>
		used !== null && total && total > 0 ? (used / total) * 100 : null;

	const mem = metrics ? percent(metrics.memUsed, metrics.memTotal) : null;
	const disk = metrics ? percent(metrics.diskUsed, metrics.diskTotal) : null;
	const loadPerCore =
		metrics?.load && metrics.cores ? (metrics.load[0] / metrics.cores) * 100 : null;

	return (
		<div className="flex h-full flex-col p-3 space-y-3">
			{/* 顶栏控制 */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<span className="text-[12px] font-semibold text-surface-foreground">主机遥测 HUD</span>
					<StatusDot status={sessionKey ? "connected" : "idle"} size={6} />
				</div>

				<button
					type="button"
					onClick={() => navigate("/monitor")}
					className="flex items-center gap-1 text-[11px] text-muted hover:text-surface-foreground cursor-pointer"
					title="打开高级主机监控页"
				>
					<span className="icon-[lucide--activity] size-3.5" />
					<span>完整大盘</span>
				</button>
			</div>

			<div className="flex-1 overflow-y-auto space-y-3 pr-0.5">
				{/* 1. SSH RTT 网络延迟卡片 */}
				<div className="rounded-card border border-border/70 bg-surface/50 p-3 space-y-2">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-1.5">
							<span className="icon-[lucide--zap] size-3.5 text-emerald-500" />
							<span className="text-[11.5px] font-medium text-surface-foreground">SSH 往返延迟 (RTT)</span>
						</div>

						<button
							type="button"
							onClick={handleMeasureRtt}
							disabled={measuring || !sessionKey}
							className="flex h-5 items-center gap-1 rounded-control border border-surface-foreground/20 bg-surface-foreground/10 px-1.5 text-[10px] text-surface-foreground hover:bg-surface-foreground/20 transition-colors disabled:opacity-40 cursor-pointer"
						>
							{measuring ? (
								<span className="icon-[lucide--loader-2] size-2.5 animate-spin" />
							) : (
								<span className="icon-[lucide--refresh-cw] size-2.5" />
							)}
							<span>测速</span>
						</button>
					</div>

					{rtt ? (
						<div className="space-y-1.5">
							<div className="flex items-baseline justify-between">
								<span className="font-mono text-[18px] font-bold text-surface-foreground tracking-tight">
									{formatMs(rtt.median_ms)} <span className="text-[11px] font-normal text-muted">ms</span>
								</span>
								<span className="font-mono text-[10px] text-emerald-500">
									±{rtt.jitter_ms.toFixed(1)}ms 抖动 · 丢包 {Math.round(rtt.loss * 100)}%
								</span>
							</div>
							<p className="font-mono text-[10px] text-faint truncate">
								{describeRtt(rtt)}
							</p>
						</div>
					) : (
						<div className="flex items-center justify-between py-1 text-[11px] text-muted">
							<span>点击「测速」获取端到端延迟</span>
							<span className="font-mono text-[10px] text-faint">— ms</span>
						</div>
					)}
				</div>

				{/* 2. 主机系统指标 (CPU / MEM / DISK) */}
				<div className="rounded-card border border-border/70 bg-surface/50 p-3 space-y-2.5">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-1.5">
							<span className="icon-[lucide--cpu] size-3.5 text-sky-500" />
							<span className="text-[11.5px] font-medium text-surface-foreground">系统核心负载</span>
						</div>
						{lastUpdate && (
							<span className="font-mono text-[9.5px] text-faint">
								3s 轮询
							</span>
						)}
					</div>

					{metricsError ? (
						<p className="text-[11px] text-muted py-2">{metricsError}</p>
					) : !metrics ? (
						<div className="flex items-center justify-center py-6 text-muted text-[11px]">
							<span className="icon-[lucide--loader-2] size-4 animate-spin mr-1.5" />
							<span>正在采集远程系统指标…</span>
						</div>
					) : (
						<div className="space-y-2 text-[11px]">
							<MetricBar
								label={`CPU${metrics.cores ? ` (${metrics.cores}核)` : ""}`}
								value={cpu === null ? "计算中…" : `${cpu.toFixed(1)}%`}
								progress={cpu ?? 0}
								warn={(cpu ?? 0) > 85}
							/>
							<MetricBar
								label="内存"
								value={mem === null ? "—" : `${formatKib(metrics.memUsed)} / ${formatKib(metrics.memTotal)}`}
								progress={mem ?? 0}
								warn={(mem ?? 0) > 90}
							/>
							<MetricBar
								label={`磁盘 (${metrics.diskMount ?? "/"})`}
								value={disk === null ? "—" : `${formatKib(metrics.diskUsed)} / ${formatKib(metrics.diskTotal)}`}
								progress={disk ?? 0}
								warn={(disk ?? 0) > 90}
							/>
							<MetricBar
								label="系统负载 (1/5/15m)"
								value={metrics.load ? metrics.load.map((v) => v.toFixed(2)).join(" / ") : "—"}
								progress={Math.min(100, loadPerCore ?? 0)}
								warn={(loadPerCore ?? 0) > 100}
							/>
						</div>
					)}
				</div>

				{/* 3. Top 进程速览 */}
				{metrics && metrics.processes.length > 0 && (
					<div className="rounded-card border border-border/70 bg-surface/50 p-2.5 space-y-1.5 font-mono text-[10px]">
						<div className="flex items-center justify-between text-faint pb-1 border-b border-border/40 font-sans text-[10.5px]">
							<span>Top 进程</span>
							<span>CPU%</span>
						</div>
						{metrics.processes.slice(0, 4).map((p) => (
							<div key={p.pid} className="flex items-center justify-between text-muted">
								<span className="truncate pr-2 text-surface-foreground/80">{p.command}</span>
								<span className="tabular-nums text-emerald-400 font-semibold">{p.cpu.toFixed(1)}%</span>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
