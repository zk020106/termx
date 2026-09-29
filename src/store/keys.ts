import { create } from "zustand";
import type { SshKey } from "@/data/types";

/* SSH 密钥：只保存密钥的元数据与公钥。
 * 私钥材料不进配置文件（配置文件是明文的），口令交操作系统钥匙串。
 * 真正生成/导入密钥需要密码学实现，尚未接入，界面会如实说明。 */

interface KeysState {
	keys: SshKey[];
	setAll: (keys: SshKey[]) => void;
	upsert: (key: SshKey) => void;
	remove: (id: string) => void;
	markDeployed: (id: string, hostId: string) => void;
}

export const useKeysStore = create<KeysState>((set) => ({
	keys: [],

	setAll: (keys) => set({ keys }),

	upsert: (key) =>
		set((s) => ({
			keys: s.keys.some((k) => k.id === key.id) ? s.keys.map((k) => (k.id === key.id ? key : k)) : [...s.keys, key],
		})),

	remove: (id) => set((s) => ({ keys: s.keys.filter((k) => k.id !== id) })),

	markDeployed: (id, hostId) =>
		set((s) => ({
			keys: s.keys.map((k) =>
				k.id === id && !k.deployedTo.includes(hostId) ? { ...k, deployedTo: [...k.deployedTo, hostId] } : k,
			),
		})),
}));
