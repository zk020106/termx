import { WindowChrome } from "@/components/chrome/WindowChrome";
import { AiAssistPanel } from "@/components/panels/AiAssistPanel";
import { SnippetsMiniPanel } from "@/components/panels/SnippetsMiniPanel";
import { Button } from "@/components/ui/Button";
import { EmptyState, MetricBar, StatusDot } from "@/components/ui/Display";
import { cn } from "@/lib/cn";
import { formatMs } from "@/lib/probe";
import { describeRtt, type SshRttReport } from "@/lib/ssh";
import { useHostsStore } from "@/store/hosts";
import { useProbeStore } from "@/store/probe";
import { useSessionsStore } from "@/store/sessions";
import { toast } from "@/store/toast";
import { useUiStore, type RightPanelTab } from "@/store/ui";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";

/* =============================================================================
 * 主机监控（路由 /monitor）。
 *
 * 核心网络性能监控：**SSH 端到端往返延迟 (SSH RTT)**
 * 通过远程连接真实的 SSH keepalive 全局往返进行高精度端到端延迟测量，
 * 包含两端协议栈真实耗时与网络抖动、丢包统计。
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

						{/* 系统资源采集规划说明 */}
						<section className="rounded-2xl border border-border/60 bg-surface-raised/40 p-4">
							<div className="flex items-center gap-2 text-[12px] font-medium text-surface-foreground">
								<span className="icon-[lucide--cpu] size-4 text-muted" />
								<span>系统资源监控 (CPU / 内存 / 磁盘 / 进程)</span>
							</div>
							<p className="mt-2 text-[11.5px] leading-5 text-muted">
								远程主机系统资源指标将走无代理 SSH 周期采样通道，在不安装额外 Daemon 的前提下实时反馈系统健康状态。
							</p>
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
					<div className={cn("min-h-0 flex-1", tab !== "monitor" && "hidden")}>
						<EmptyState icon="icon-[lucide--gauge]" title="实时指标未接入" />
					</div>

					{tab === "snippets" && <SnippetsMiniPanel hostName={hostName} />}
					{tab === "ai" && <AiAssistPanel hostName={hostName} />}

					{tab === "monitor" && (
						<div className="flex shrink-0 justify-between border-t border-border bg-surface-raised px-3 py-2 font-mono text-[10.5px] text-faint">
							<span>采样方式: SSH Keepalive RTT</span>
							<span>端到端在线</span>
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
