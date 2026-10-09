import { create } from "zustand";
import type { AuthPromptRequest } from "@/lib/ssh";

/* 不属于某个连接页面的认证提问（后台启动的端口转发、跳板机的「连接时再问」等）。
 * 谁发起的连接谁把提问塞进来，全局的 AuthPromptHost 负责弹窗、提交、取消。 */

export interface PendingAuthPrompt {
	/** 后端会话键（作答时原样交回去） */
	key: string;
	/** 弹窗里告诉用户「这是哪条连接在问」 */
	origin: string;
	request: AuthPromptRequest;
	/** 用户取消时调用：由发起方决定怎么收尾（例如停止这条转发） */
	onCancel: () => void;
}

interface AuthPromptState {
	queue: PendingAuthPrompt[];
	push: (prompt: PendingAuthPrompt) => void;
	/** 同一个会话的新一轮提问替换旧的那一轮 */
	resolve: (key: string) => void;
}

export const useAuthPromptStore = create<AuthPromptState>((set) => ({
	queue: [],
	push: (prompt) =>
		set((s) => {
			const rest = s.queue.filter((p) => p.key !== prompt.key);
			const index = s.queue.findIndex((p) => p.key === prompt.key);
			if (index < 0) return { queue: [...rest, prompt] };
			const next = [...s.queue];
			next[index] = prompt;
			return { queue: next };
		}),
	resolve: (key) => set((s) => ({ queue: s.queue.filter((p) => p.key !== key) })),
}));
