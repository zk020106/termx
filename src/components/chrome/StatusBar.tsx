import { StatusDot } from "@/components/ui/Display";
import { CONNECTION_LABEL, type ConnectionStatus, type Host } from "@/data/types";
import { cn } from "@/lib/cn";
import { describeProbe, formatMs, latencyTier, latencyTierClass, type ProbeReport } from "@/lib/probe";
import { describeRtt, type SshRttReport } from "@/lib/ssh";
import { connVisual } from "@/lib/status";
import { useHostsStore } from "@/store/hosts";
import { useForwardsStore } from "@/store/forwards";
import { useProbeStore } from "@/store/probe";
import { useSessionsStore } from "@/store/sessions";
import { transferSummary, useTransfersStore } from "@/store/transfers";
import { useEffect } from "react";
import { Link } from "react-router";

/* 状态栏（需求书 04-⑧）：连接状态、用户@地址、延迟、编码、传输进度、转发数。
 * 每一项都可点击跳转到对应界面。 */

export function StatusBar() {
	const activeTabId = useSessionsStore((s) => s.activeTabId);
	const tab = useSessionsStore((s) => s.tabs.find((t) => t.id === activeTabId));
	const host = useHostsStore((s) => (tab?.hostId ? s.hosts.find((h) => h.id === tab.hostId) : undefined));
	const transfers = useTransfersStore((s) => s.items);
	const summary = transferSummary(transfers);
	// 真实转发规则里处于 running 的条数；一条都没有就如实说「未启用」
	const runningForwards = useForwardsStore((s) => s.rules.filter((r) => r.state === "running").length);

	const status: ConnectionStatus = tab?.status ?? "idle";
	const visual = connVisual[status];
	const reconnecting = status === "reconnecting";

	// 连接建立后量真正的往返（SSH keepalive 往返）；没连上时退回主机库的 TCP 建连耗时
	const rtt = useProbeStore((s) => (tab?.id ? s.rtt[tab.id] : undefined));
	const probe = useProbeStore((s) => (host ? s.results[host.id] : undefined));
	// 只有真的挂着主机的会话才量往返：本地终端会话没有 SSH 连接可发 keepalive
	useSshRttPolling(tab?.id, status === "connected" && Boolean(tab?.hostId));

	const latency = latencyReading(rtt, probe, status === "connected", host);

	return (
		<footer className="flex h-6 shrink-0 items-center gap-2 border-t border-border bg-surface-sunk px-3 font-mono text-[11px] text-muted">
			{/* 连接状态 */}
			<div className="flex items-center gap-1.5">
				<StatusDot status={status} />
				<span className={cn("font-sans font-medium", visual.text)}>
					{CONNECTION_LABEL[status]}
					{reconnecting && " · 剩 18s"}
				</span>
			</div>

			{host && (
				<>
					<Divider />
					<span>
						{host.username}@{host.hostname}:{host.port}
					</span>
				</>
			)}

			{latency && (
				<>
					<Divider />
					<span className={cn("tabular-nums", latency.className)} title={latency.title}>
						{latency.text}
					</span>
				</>
			)}

			{host?.encoding && (
				<>
					<Divider />
					<span className="text-faint">{host.encoding}</span>
				</>
			)}

			{summary.count > 0 && (
				<>
					<Divider />
					<Link to="/transfers" className="flex items-center gap-1 text-warning hover:underline">
						<span className="icon-[lucide--arrow-down-up] size-3" />
						<span className="font-sans">
							传输 {summary.count} 项 · {summary.percent}%
						</span>
					</Link>
				</>
			)}

			<Divider />
			<Link to="/forward" className="font-sans text-faint hover:text-surface-foreground">
				{runningForwards > 0 ? `转发 ${runningForwards} 条活跃` : "转发未启用"}
			</Link>

			<div className="ml-auto flex items-center gap-2">
				{host?.termType && <span className="text-[10px] text-faint">{host.termType}</span>}
			</div>
		</footer>
	);
}

/**
 * 状态栏的延迟读数。
 *
 * 两个口径的前缀必须带出来，不能都写成「ms」：
 *  - 连上以后报 **SSH 往返**，这才是真正走了一趟网络的端到端时间；
 *  - 没连上时只能报主机库的 **TCP 建连**耗时，它可能被本机代理就地完成。
 */
function latencyReading(
	rtt: SshRttReport | undefined,
	probe: ProbeReport | undefined,
	connected: boolean,
	host: Host | undefined,
): { text: string; className: string; title: string | undefined } | null {
	if (connected && rtt) {
		if (rtt.received === 0) {
			return { text: "SSH 无响应", className: "text-danger", title: describeRtt(rtt) };
		}
		return {
			text: `SSH ${formatMs(rtt.median_ms)} ms`,
			className: latencyTierClass[latencyTier(rtt.median_ms)],
			title: describeRtt(rtt),
		};
	}

	if (probe) {
		return probe.reachable
			? {
					text: `TCP ${formatMs(probe.median_ms)} ms`,
					className: "text-surface-foreground",
					title: describeProbe(probe),
				}
			: { text: "不可达", className: "text-danger", title: describeProbe(probe) };
	}

	if (host?.latencyMs != null) {
		return { text: `${host.latencyMs} ms`, className: "text-surface-foreground", title: undefined };
	}

	return null;
}

/**
 * 连接期间定期在已有连接上量一次 SSH 往返，断开即停。
 * 发的就是 SSH 的 keepalive 全局请求，与 sshd 自己的 ServerAliveInterval 同类；
 * 它不会在服务端日志里留下预认证失败记录，也不会另开连接。
 */
function useSshRttPolling(sessionKey: string | undefined, connected: boolean, intervalMs = 5000) {
	useEffect(() => {
		if (!sessionKey || !connected) return;

		const tick = async () => {
			const report = await useProbeStore.getState().measureRtt(sessionKey, { samples: 3, timeoutMs: 1000 });
			// 会话在这一轮里结束了：把结果清掉，别让旧数字留在状态栏
			if (!report) useProbeStore.getState().forgetRtt(sessionKey);
		};

		void tick();
		const timer = window.setInterval(() => void tick(), intervalMs);
		return () => window.clearInterval(timer);
	}, [sessionKey, connected, intervalMs]);

	// 断开时顺手清掉这个会话的往返结果
	useEffect(() => {
		if (!sessionKey || connected) return;
		useProbeStore.getState().forgetRtt(sessionKey);
	}, [sessionKey, connected]);
}

function Divider() {
	return <span className="text-border">/</span>;
}

/** 独立会话视图可直接用：给一个 host 就渲染完整状态栏 */
export function StatusBarForHost({ host, status }: { host: Host; status: ConnectionStatus }) {
	return (
		<footer className="flex h-6 shrink-0 items-center gap-2 border-t border-border bg-surface-sunk px-3 font-mono text-[11px] text-muted">
			<StatusDot status={status} />
			<span className={cn("font-sans font-medium", connVisual[status].text)}>{CONNECTION_LABEL[status]}</span>
			<Divider />
			<span>
				{host.username}@{host.hostname}:{host.port}
			</span>
			<div className="ml-auto text-[10px] text-faint">{host.termType ?? "xterm-256color"}</div>
		</footer>
	);
}
