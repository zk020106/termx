import { isTauri } from "./tauri";

/* =============================================================================
 * 主机测速（TCP 延迟探测）
 *
 * 原生壳里调用 Rust 的 probe_hosts / probe_host；浏览器里返回 null，
 * 由调用方把测速入口置灰并说明「需在桌面端运行」。
 *
 * 结论的口径是「TCP 可达」，不等于 SSH 可用：实测环境里存在 DNS 劫持与透明中间盒，
 * 连保留域名都能连上。真正的可用性要等 SSH 握手成功才能判定。
 * ========================================================================== */

export interface ProbeReport {
	id: string;
	host: string;
	port: number;
	reachable: boolean;
	attempts: number;
	received: number;
	loss: number;
	min_ms: number;
	avg_ms: number;
	max_ms: number;
	jitter_ms: number;
	samples: number[];
	error: string | null;
}

export interface ProbeTarget {
	id: string;
	host: string;
	port: number;
}

export interface ProbeOptions {
	/** 每个目标探测几次，Rust 侧会 clamp 到 1..10 */
	attempts?: number;
	/** 单次连接超时（毫秒），Rust 侧会 clamp 到 200..10000 */
	timeoutMs?: number;
}

export function probeSupported(): boolean {
	return isTauri();
}

export async function probeHosts(
	targets: ProbeTarget[],
	options: ProbeOptions = {},
): Promise<ProbeReport[] | null> {
	if (!isTauri() || targets.length === 0) return null;
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<ProbeReport[]>("probe_hosts", {
		targets,
		attempts: options.attempts ?? 3,
		timeoutMs: options.timeoutMs ?? 1500,
	});
}

export async function probeHost(
	target: ProbeTarget,
	options: ProbeOptions = {},
): Promise<ProbeReport | null> {
	if (!isTauri()) return null;
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<ProbeReport>("probe_host", {
		id: target.id,
		host: target.host,
		port: target.port,
		attempts: options.attempts ?? 3,
		timeoutMs: options.timeoutMs ?? 1500,
	});
}

/** 把探测结果压成一句人话，供气泡与列表复用 */
export function describeProbe(report: ProbeReport): string {
	if (report.reachable) {
		const head = `TCP ${report.avg_ms.toFixed(0)} ms（最低 ${report.min_ms.toFixed(0)} / 最高 ${report.max_ms.toFixed(0)}）`;
		const jitter = report.jitter_ms > 0 ? ` · 抖动 ±${report.jitter_ms.toFixed(1)} ms` : "";
		const loss = report.loss > 0 ? ` · 丢包 ${Math.round(report.loss * 100)}%` : "";
		const note = isIntercepted(report)
			? " · 亚毫秒往返，疑似本地代理/中间盒接管了连接，不代表真的连到了该主机"
			: "";
		return `${head}${jitter}${loss}${note}`;
	}
	return report.error ?? "TCP 不可达";
}

/** 亚毫秒往返对远端主机不成立（光速不允许），出现即说明连接被本地设施接管 */
export function isIntercepted(report: ProbeReport): boolean {
	return report.reachable && report.avg_ms < 1;
}

/** 延迟分档，用于上色（沿用状态语义色） */
export type LatencyTier = "good" | "ok" | "slow" | "dead" | "intercepted" | "unknown";

export function latencyTier(report: ProbeReport | undefined): LatencyTier {
	if (!report) return "unknown";
	if (!report.reachable) return "dead";
	if (isIntercepted(report)) return "intercepted";
	if (report.avg_ms <= 60) return "good";
	if (report.avg_ms <= 150) return "ok";
	return "slow";
}

export const latencyTierClass: Record<LatencyTier, string> = {
	good: "text-success",
	ok: "text-warning",
	slow: "text-danger",
	dead: "text-danger",
	// 不算健康：连接被本地设施接管，真实可达性未知
	intercepted: "text-warning",
	unknown: "text-faint",
};
