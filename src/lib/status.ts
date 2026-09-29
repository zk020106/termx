import type { ConnectionStatus } from "@/data/types";

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
