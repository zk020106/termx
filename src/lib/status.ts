import type { ConnectionStatus, Env } from "@/data/types";

/* 状态与环境的视觉映射集中在这里，保证「标签 / 主机库 / 状态栏」三处完全一致
 * （需求书 03-3 状态始终可见、03-5 环境有辨识度）。
 * 类名必须是完整字面量，Tailwind 才能扫描到。 */

export const connVisual: Record<ConnectionStatus, { dot: string; text: string; pulse?: boolean }> = {
	idle: { dot: "bg-border", text: "text-muted" },
	connecting: { dot: "bg-primary", text: "text-primary", pulse: true },
	connected: { dot: "bg-success", text: "text-success" },
	reconnecting: { dot: "bg-warning", text: "text-warning", pulse: true },
	disconnected: { dot: "bg-muted", text: "text-muted" },
	failed: { dot: "bg-danger", text: "text-danger" },
};

/** 环境实心条 / 胶囊底色 */
export const envBg: Record<Env, string> = {
	prod: "bg-env-prod",
	stage: "bg-env-stage",
	test: "bg-env-test",
	dev: "bg-env-dev",
};

/** 环境前景色 */
export const envText: Record<Env, string> = {
	prod: "text-env-prod",
	stage: "text-env-stage",
	test: "text-env-test",
	dev: "text-env-dev",
};

export const envBorder: Record<Env, string> = {
	prod: "border-env-prod",
	stage: "border-env-stage",
	test: "border-env-test",
	dev: "border-env-dev",
};
