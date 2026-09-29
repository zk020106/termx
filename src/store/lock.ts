import { create } from "zustand";
import { verifyPassword } from "@/lib/lock";
import { useSettingsStore } from "./settings";

/* =============================================================================
 * 锁屏（运行时状态，不入配置文件）。
 *
 * 真锁：锁上之后整个界面被覆盖层挡住，解不开就进不去 —— 靠的是设置页里
 * 「解锁密码」的 PBKDF2 摘要，密码本身不落盘。
 * 没有设置解锁密码时锁不上（lock() 返回 false），设置页据此禁掉自动锁定的开关。
 * ========================================================================== */

interface LockState {
	locked: boolean;
	/** 立即锁定；返回 false 表示还没有设置解锁密码 */
	lock: () => boolean;
	/** 用密码解锁；返回是否成功 */
	unlock: (password: string) => Promise<boolean>;
}

export const useLockStore = create<LockState>((set) => ({
	locked: false,

	lock: () => {
		if (!useSettingsStore.getState().lockVerifier) return false;
		set({ locked: true });
		return true;
	},

	unlock: async (password) => {
		const verifier = useSettingsStore.getState().lockVerifier;
		if (!verifier) {
			// 密码被清掉了（例如在别的窗口重设），不该把用户关在外面
			set({ locked: false });
			return true;
		}
		const ok = await verifyPassword(password, verifier);
		if (ok) set({ locked: false });
		return ok;
	},
}));
