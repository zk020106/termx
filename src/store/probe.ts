import { create } from "zustand";
import { probeHosts, type ProbeReport } from "@/lib/probe";
import { sshPingRtt, type SshRttReport } from "@/lib/ssh";

/* 测速结果集中放在这里：主机库、状态栏、工作区都读同一份，
 * 避免每个界面各自探测造成重复流量。
 *
 * 两种口径分开存，不要混在一起：
 *  - results：主机库的 **TCP 建连**探测（还没连接时就能做，只说明端口这边有回应）
 *  - rtt：**已认证连接上的 SSH 往返**（按会话键索引，连接建立之后才有）
 */

interface ProbeState {
	/** hostId -> 最近一次 TCP 建连探测结果 */
	results: Record<string, ProbeReport>;
	/** 会话键（就是标签页 id）-> 最近一次 SSH 往返结果 */
	rtt: Record<string, SshRttReport>;
	/** 正在探测的 hostId 集合 */
	probing: string[];
	/** 最近一次批量测速的结束时间（展示用） */
	lastRunAt: string | null;

	run: (
		targets: { id: string; host: string; port: number }[],
		options?: { attempts?: number; timeoutMs?: number },
	) => Promise<{ ok: number; fail: number } | null>;
	/** 在一条已认证会话上量一次 SSH 往返；会话不在或不应答时返回 null */
	measureRtt: (
		key: string,
		options?: { samples?: number; timeoutMs?: number },
	) => Promise<SshRttReport | null>;
	/** 会话断开时丢掉它的往返结果，别让旧数字留在界面上 */
	forgetRtt: (key: string) => void;
	clear: () => void;
}

export const useProbeStore = create<ProbeState>((set) => ({
	results: {},
	rtt: {},
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

	measureRtt: async (key, options) => {
		const report = await sshPingRtt(key, options);
		// 会话已经结束或对端不应答：如实返回「这一次没有结果」
		if (!report) return null;
		set((s) => ({ rtt: { ...s.rtt, [key]: report } }));
		return report;
	},

	forgetRtt: (key) =>
		set((s) => {
			if (!(key in s.rtt)) return s;
			const rtt = { ...s.rtt };
			delete rtt[key];
			return { rtt };
		}),

	clear: () => set({ results: {}, rtt: {}, probing: [], lastRunAt: null }),
}));

/** 某个主机是否正在测速 */
export function isProbing(state: ProbeState, hostId: string): boolean {
	return state.probing.includes(hostId);
}

/** 取实测结果，没有就返回 undefined（调用方自己决定怎么显示「没有」） */
export function measuredFor(state: ProbeState, hostId: string): ProbeReport | undefined {
	return state.results[hostId];
}

/** 取某个会话的 SSH 往返结果 */
export function rttFor(state: ProbeState, sessionKey: string | undefined): SshRttReport | undefined {
	return sessionKey ? state.rtt[sessionKey] : undefined;
}
