import type { ConnectionStatus } from "@/data/types";
import { useSessionsStore } from "@/store/sessions";

/* 状态的视觉映射集中在这里，保证「标签 / 主机库 / 状态栏」三处完全一致
 * （需求书 03-3 状态始终可见）。
 * 类名必须是完整字面量，Tailwind 才能扫描到。 */

export const connVisual: Record<ConnectionStatus, { dot: string; text: string; pulse?: boolean }> = {
	idle: { dot: "bg-border", text: "text-muted" },
	connecting: { dot: "bg-primary", text: "text-primary", pulse: true },
	connected: { dot: "bg-success", text: "text-success" },
	reconnecting: { dot: "bg-warning", text: "text-warning", pulse: true },
	disconnected: { dot: "bg-muted", text: "text-muted" },
	failed: { dot: "bg-danger", text: "text-danger" },
};

/**
 * 实时响应主机当前的真实会话状态，驱动各视图的状态点即时变色：
 * 1. 若当前会话列表中有对应主机的标签，返回该会话的真实状态（connecting / connected / failed / disconnected）；
 * 2. 否则按初始可达性返回 idle 或 disconnected。
 */
export function useHostStatus(hostId: string, fallbackReachable: boolean = true): ConnectionStatus {
	const tab = useSessionsStore((s) => s.tabs.find((t) => t.hostId === hostId));

	if (tab) {
		return tab.status;
	}
	return fallbackReachable ? "idle" : "disconnected";
}
