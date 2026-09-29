import { create } from "zustand";

export type ToastTone = "default" | "success" | "warning" | "danger";

export interface ToastAction {
	label: string;
	run: () => void;
}

export interface Toast {
	id: string;
	title: string;
	description?: string;
	tone: ToastTone;
	/** 「可撤销优于确认」：删除类操作给撤销按钮（需求书 03-6） */
	action?: ToastAction;
	/** 毫秒；带 action 的 toast 停留更久 */
	duration: number;
}

/** toast() 的入参：tone 可省略，默认 default；带 action 的提示停留更久 */
export type ToastInput = Omit<Toast, "id" | "duration" | "tone"> & {
	tone?: ToastTone;
	duration?: number;
};

interface ToastState {
	toasts: Toast[];
	push: (toast: ToastInput) => string;
	dismiss: (id: string) => void;
	clear: () => void;
}

let seq = 0;

export const useToastStore = create<ToastState>((set, get) => ({
	toasts: [],

	push: ({ duration, tone = "default", ...rest }) => {
		const id = `toast-${++seq}`;
		const ms = duration ?? (rest.action ? 6000 : 3200);
		set((s) => ({ toasts: [...s.toasts, { ...rest, tone, id, duration: ms }] }));

		window.setTimeout(() => get().dismiss(id), ms);
		return id;
	},

	dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

	clear: () => set({ toasts: [] }),
}));

/** 便捷入口：toast({ title: "已删除主机", action: { label: "撤销", run } }) */
export function toast(input: ToastInput) {
	return useToastStore.getState().push(input);
}
