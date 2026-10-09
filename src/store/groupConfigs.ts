import { create } from "zustand";
import type { GroupConfig } from "../data/types";

/* 分组设置（Netcatty GroupConfig）。密码在系统钥匙串 `group:<groupId>`，这里只有 hasPassword 标记。 */

interface GroupConfigsState {
	configs: GroupConfig[];
	setAll: (configs: GroupConfig[]) => void;
	/** 保存一份分组设置；除 groupId 外全空时等同删除 */
	save: (config: GroupConfig) => void;
	remove: (groupId: string) => void;
}

function isEmpty(config: GroupConfig): boolean {
	return Object.entries(config).every(([k, v]) => k === "groupId" || v === undefined || (Array.isArray(v) && v.length === 0));
}

export const useGroupConfigsStore = create<GroupConfigsState>((set) => ({
	configs: [],
	setAll: (configs) => set({ configs }),
	save: (config) =>
		set((s) => {
			const rest = s.configs.filter((c) => c.groupId !== config.groupId);
			return { configs: isEmpty(config) ? rest : [...rest, config] };
		}),
	remove: (groupId) => set((s) => ({ configs: s.configs.filter((c) => c.groupId !== groupId) })),
}));

export const groupSecretAccount = (groupId: string) => `group:${groupId}`;
