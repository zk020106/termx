import { EnvPill, StatusDot } from "@/components/ui/Display";
import { CONNECTION_LABEL, ENV_LABEL, type ConnectionStatus, type Host } from "@/data/types";
import { cn } from "@/lib/cn";
import { connVisual } from "@/lib/status";
import { useHostsStore } from "@/store/hosts";
import { useSessionsStore } from "@/store/sessions";
import { transferSummary, useTransfersStore } from "@/store/transfers";
import { Link } from "react-router";

/* 状态栏（需求书 04-⑧）：连接状态、用户@地址、延迟、编码、传输进度、转发数。
 * 每一项都可点击跳转到对应界面；生产环境额外显示 PROD 标记（03-5 / 07）。 */

export function StatusBar() {
	const activeTabId = useSessionsStore((s) => s.activeTabId);
	const tab = useSessionsStore((s) => s.tabs.find((t) => t.id === activeTabId));
	const host = useHostsStore((s) => (tab?.hostId ? s.hosts.find((h) => h.id === tab.hostId) : undefined));
	const transfers = useTransfersStore((s) => s.items);
	const summary = transferSummary(transfers);

	const status: ConnectionStatus = tab?.status ?? "idle";
	const visual = connVisual[status];
	const reconnecting = status === "reconnecting";

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
					<span className={cn(host.env === "prod" && "text-env-prod")}>
						{host.username}@{host.hostname}:{host.port}
					</span>
				</>
			)}

			{host?.latencyMs != null && (
				<>
					<Divider />
					<span className="tabular-nums text-surface-foreground">{host.latencyMs} ms</span>
				</>
			)}

			{host?.encoding && (
				<>
					<Divider />
					<span className="text-faint">{host.encoding}</span>
				</>
			)}

			{/* 环境辨识：状态栏常驻 PROD 标记 */}
			{host && host.env === "prod" && (
				<>
					<Divider />
					<EnvPill env="prod" size="xs" />
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
				转发 3 条活跃
			</Link>

			<div className="ml-auto flex items-center gap-2">
				{host?.termType && <span className="text-[10px] text-faint">{host.termType}</span>}
				{host && <span className="text-[10px] text-faint">{ENV_LABEL[host.env]}</span>}
			</div>
		</footer>
	);
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
			<Divider />
			<span className="tabular-nums text-surface-foreground">{host.latencyMs ?? "—"} ms</span>
			{host.env === "prod" && <EnvPill env="prod" size="xs" className="ml-1" />}
			<div className="ml-auto text-[10px] text-faint">{host.termType ?? "xterm-256color"}</div>
		</footer>
	);
}
