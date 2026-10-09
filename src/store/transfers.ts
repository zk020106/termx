import { create } from "zustand";
import type { Transfer } from "@/data/types";

/* 传输队列：只承载真实发生的传输（运行逻辑在 lib/transferManager.ts）。
 * 队列只在内存里：应用重启后不保留（未完成的部分文件留在目标旁边，重新传同一文件时可续传）。 */

interface TransfersState {
	items: Transfer[];
	/** 全局限速（MB/s，0 = 不限），上传与下载分别生效 */
	limitMb: number;
	upsert: (transfer: Transfer) => void;
	patch: (id: string, patch: Partial<Transfer>) => void;
	setState: (id: string, state: Transfer["state"]) => void;
	remove: (id: string) => void;
	clearDone: () => void;
	setLimitMb: (mb: number) => void;
}

export const useTransfersStore = create<TransfersState>((set) => ({
	items: [],
	limitMb: 0,

	upsert: (transfer) =>
		set((s) => ({
			items: s.items.some((t) => t.id === transfer.id)
				? s.items.map((t) => (t.id === transfer.id ? transfer : t))
				: [...s.items, transfer],
		})),

	patch: (id, patch) => set((s) => ({ items: s.items.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),

	setState: (id, state) => set((s) => ({ items: s.items.map((t) => (t.id === id ? { ...t, state } : t)) })),

	remove: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),

	clearDone: () => set((s) => ({ items: s.items.filter((t) => t.state !== "done") })),

	setLimitMb: (limitMb) => set({ limitMb }),
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
