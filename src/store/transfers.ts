import { create } from "zustand";
import { transfers as seedTransfers } from "@/data/mock";
import type { Transfer } from "@/data/types";

interface TransfersState {
	items: Transfer[];
	setState: (id: string, state: Transfer["state"]) => void;
	retry: (id: string) => void;
	remove: (id: string) => void;
	clearDone: () => void;
	/** 状态栏摘要：进行中的数量与整体进度 */
}

export const useTransfersStore = create<TransfersState>((set) => ({
	items: seedTransfers,

	setState: (id, state) =>
		set((s) => ({ items: s.items.map((t) => (t.id === id ? { ...t, state } : t)) })),

	retry: (id) =>
		set((s) => ({
			items: s.items.map((t) => (t.id === id ? { ...t, state: "running", error: undefined } : t)),
		})),

	remove: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),

	clearDone: () => set((s) => ({ items: s.items.filter((t) => t.state !== "done") })),
}));

/** 状态栏与侧栏共用：汇总进行中传输的进度 */
export function transferSummary(items: Transfer[]) {
	const active = items.filter((t) => t.state === "running" || t.state === "queued" || t.state === "paused");
	const total = active.reduce((sum, t) => sum + t.size, 0);
	const done = active.reduce((sum, t) => sum + t.transferred, 0);
	return {
		count: active.length,
		percent: total > 0 ? Math.round((done / total) * 100) : 0,
	};
}
