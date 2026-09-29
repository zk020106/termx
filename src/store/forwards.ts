import { create } from "zustand";
import type { ForwardRule, ForwardState } from "@/data/types";

/* 端口转发规则：用户自己维护，落盘保存。
 * 规则能真实保存与开关；实际的转发隧道要等 SSH 层接入后才有流量。 */

interface ForwardState_ {
	rules: ForwardRule[];
	setAll: (rules: ForwardRule[]) => void;
	upsert: (rule: ForwardRule) => void;
	remove: (id: string) => void;
	setRuleState: (id: string, state: ForwardState, error?: string) => void;
	toggleAutoStart: (id: string) => void;
}

export const useForwardsStore = create<ForwardState_>((set) => ({
	rules: [],

	setAll: (rules) => set({ rules }),

	upsert: (rule) =>
		set((s) => ({
			rules: s.rules.some((r) => r.id === rule.id)
				? s.rules.map((r) => (r.id === rule.id ? rule : r))
				: [...s.rules, rule],
		})),

	remove: (id) => set((s) => ({ rules: s.rules.filter((r) => r.id !== id) })),

	setRuleState: (id, state, error) =>
		set((s) => ({ rules: s.rules.map((r) => (r.id === id ? { ...r, state, error } : r)) })),

	toggleAutoStart: (id) =>
		set((s) => ({ rules: s.rules.map((r) => (r.id === id ? { ...r, autoStart: !r.autoStart } : r)) })),
}));

/** 规则的新建骨架：只有地址和端口是有意义的默认值 */
export function draftForwardRule(): ForwardRule {
	return {
		id: `fw-${Date.now().toString(36)}`,
		name: "",
		hostId: "",
		type: "local",
		bindAddress: "127.0.0.1",
		bindPort: 0,
		targetHost: "",
		targetPort: 0,
		autoStart: false,
		state: "stopped",
		connections: 0,
		trafficIn: 0,
		trafficOut: 0,
	};
}
