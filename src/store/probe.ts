import { create } from "zustand";
import { probeHosts, type ProbeReport } from "@/lib/probe";

/* 测速结果集中放在这里：主机库、状态栏、工作区都读同一份，
 * 避免每个界面各自探测造成重复流量。 */

interface ProbeState {
	/** hostId -> 最近一次探测结果 */
	results: Record<string, ProbeReport>;
	/** 正在探测的 hostId 集合 */
	probing: string[];
	/** 最近一次批量测速的结束时间（展示用） */
	lastRunAt: string | null;

	run: (
		targets: { id: string; host: string; port: number }[],
		options?: { attempts?: number; timeoutMs?: number },
	) => Promise<{ ok: number; fail: number } | null>;
	clear: () => void;
}

export const useProbeStore = create<ProbeState>((set) => ({
	results: {},
	probing: [],
	lastRunAt: null,

	run: async (targets, options) => {
		if (targets.length === 0) return null;

		const ids = targets.map((t) => t.id);
		set((s) => ({ probing: [...new Set([...s.probing, ...ids])] }));

		try {
			const reports = await probeHosts(targets, options);
			if (!reports) return null;

			set((s) => {
				const results = { ...s.results };
				for (const report of reports) results[report.id] = report;
				return {
					results,
					probing: s.probing.filter((id) => !ids.includes(id)),
					lastRunAt: new Date().toISOString(),
				};
			});

			const ok = reports.filter((r) => r.reachable).length;
			return { ok, fail: reports.length - ok };
		} catch {
			set((s) => ({ probing: s.probing.filter((id) => !ids.includes(id)) }));
			return null;
		}
	},

	clear: () => set({ results: {}, probing: [], lastRunAt: null }),
}));

/** 某个主机是否正在测速 */
export function isProbing(state: ProbeState, hostId: string): boolean {
	return state.probing.includes(hostId);
}

/** 取实测延迟，没有实测结果时返回 undefined（调用方回落到种子数据） */
export function measuredFor(state: ProbeState, hostId: string): ProbeReport | undefined {
	return state.results[hostId];
}

/** 供状态栏使用：优先实测，其次种子数据 */
export function effectiveLatency(
	state: ProbeState,
	hostId: string | null | undefined,
	seed?: number,
): { ms: number | undefined; measured: boolean; tier?: ProbeReport } {
	if (hostId) {
		const report = state.results[hostId];
		if (report) {
			return { ms: report.reachable ? Math.round(report.avg_ms) : undefined, measured: true, tier: report };
		}
	}
	return { ms: seed, measured: false };
}
