import { create } from "zustand";
import type { ProxyProfile } from "@/data/types";

/* 可复用的代理配置（Netcatty ProxyProfilesManager 的数据）：落盘保存，口令在钥匙串。 */

interface ProxyProfilesState {
	profiles: ProxyProfile[];
	setAll: (profiles: ProxyProfile[]) => void;
	upsert: (profile: ProxyProfile) => void;
	remove: (id: string) => void;
}

export const useProxyProfilesStore = create<ProxyProfilesState>((set) => ({
	profiles: [],
	setAll: (profiles) => set({ profiles }),
	upsert: (profile) =>
		set((s) => ({
			profiles: s.profiles.some((p) => p.id === profile.id)
				? s.profiles.map((p) => (p.id === profile.id ? profile : p))
				: [...s.profiles, profile],
		})),
	remove: (id) => set((s) => ({ profiles: s.profiles.filter((p) => p.id !== id) })),
}));
