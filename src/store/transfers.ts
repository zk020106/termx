import { create } from "zustand";
import type { Transfer } from "@/data/types";

/* 传输队列：只承载真实发生的传输。
 * SFTP 还没接入，所以这里初始为空——界面上出现的每一条都将是真实任务。 */

interface TransfersState {
	items: Transfer[];
	upsert: (transfer: Transfer) => void;
	setState: (id: string, state: Transfer["state"]) => void;
	retry: (id: string) => void;
	remove: (id: string) => void;
	clearDone: () => void;
}

export const useTransfersStore = create<TransfersState>((set) => ({
	items: [],

	upsert: (transfer) =>
		set((s) => ({
			items: s.items.some((t) => t.id === transfer.id)
				? s.items.map((t) => (t.id === transfer.id ? transfer : t))
				: [...s.items, transfer],
		})),

	setState: (id, state) => set((s) => ({ items: s.items.map((t) => (t.id === id ? { ...t, state } : t)) })),

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
