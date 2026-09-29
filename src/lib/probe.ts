import { isTauri } from "./tauri";

/* =============================================================================
 * 主机测速（TCP 建连探测）
 *
 * 口径：数值是**本机 TCP 建连耗时** —— connect() 从发起到返回的那一段，
 * 不是到主机的网络延迟。装了 TUN 类代理的机器上，握手会由本机协议栈就地完成，
 * 这个数字只反映本机（保留域名 `.invalid` 都能「连上」就是同一个原因）。
 * 因此主机库只用它分「可达 / 不可达」，不拿它判快慢；
 * 真正的往返延迟走 sshPingRtt —— 在已认证的 SSH 连接上发一次 keepalive 往返。
 *
 * 原生壳里调用 Rust 的 probe_hosts / probe_host；浏览器里返回 null，
 * 由调用方把测速入口置灰并说明「需在桌面端运行」。
 * ========================================================================== */

export interface ProbeReport {
	id: string;
	host: string;
	port: number;
	/** 口径标识：恒为 tcp_connect */
	caliber: "tcp_connect";
	/** 实际连接的对端地址（解析结果里的第一个） */
	addr: string | null;
	reachable: boolean;
	/** ok / refused / timeout / unresolved / error */
	outcome: "ok" | "refused" | "timeout" | "unresolved" | "error";
	/** 计时的连接次数（不含预热） */
	attempts: number;
	/** 预热连接次数；真正发起的连接数是 warmup + attempts */
	warmup: number;
	received: number;
	/** 被 RST 拒绝的次数（对端回了话，不算丢包） */
	refused: number;
	/** 完全没有回音的次数（这才是丢包） */
	timeouts: number;
	/** 丢包率 0..1，只统计没有回音的那部分 */
	loss: number;
	min_ms: number;
	avg_ms: number;
	/** 中位数：样本少时比平均值更稳，展示用它 */
	median_ms: number;
	max_ms: number;
	jitter_ms: number;
	/** 地址解析耗时；不在样本里 */
	dns_ms: number;
	samples: number[];
	error: string | null;
}

export interface ProbeTarget {
	id: string;
	host: string;
	port: number;
}

export interface ProbeOptions {
	/** 每个目标采样几次（不含预热那次），Rust 侧会 clamp 到 1..10 */
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

/** 建连耗时可能不到 1 ms，四舍五入会把 0.4 显示成「0 ms」，所以小数值留一位小数 */
export function formatMs(ms: number): string {
	if (!Number.isFinite(ms)) return "—";
	return ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
}

/** 把探测结果压成一句事实描述：口径、中位数、区间、抖动、丢包、对端地址 */
export function describeProbe(report: ProbeReport): string {
	if (!report.reachable) return report.error ?? "TCP 不可达";

	const head = `TCP 建连 ${formatMs(report.median_ms)} ms（最低 ${formatMs(report.min_ms)} / 最高 ${formatMs(
		report.max_ms,
	)}，${report.received}/${report.attempts} 次）`;
	const jitter = report.jitter_ms > 0 ? ` · 抖动 ±${report.jitter_ms.toFixed(1)} ms` : "";
	const loss = report.loss > 0 ? ` · 丢包 ${Math.round(report.loss * 100)}%` : "";
	const address = report.addr ? ` · ${report.addr}` : "";
	return `${head}${jitter}${loss}${address}`;
}

/** 延迟分档，用于上色 */
export type LatencyTier = "good" | "ok" | "slow" | "dead" | "unknown";

/**
 * 只给「真正的往返」上色用，也就是已认证连接上的 SSH 往返。
 * TCP 建连耗时可能被本机代理就地完成，拿它判快慢会给出错误信号。
 */
export function latencyTier(medianMs: number | null | undefined): LatencyTier {
	if (medianMs == null || !Number.isFinite(medianMs)) return "unknown";
	if (medianMs <= 60) return "good";
	if (medianMs <= 150) return "ok";
	return "slow";
}

export const latencyTierClass: Record<LatencyTier, string> = {
	good: "text-success",
	ok: "text-warning",
	slow: "text-danger",
	dead: "text-danger",
	unknown: "text-faint",
};
