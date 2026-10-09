import { create } from "zustand";
import type { Identity } from "../data/types";

/* 钥匙串身份（Netcatty Identity）。密码在系统钥匙串 `identity:<id>`，这里只有 hasPassword 标记。 */

interface IdentitiesState {
	identities: Identity[];
	setAll: (identities: Identity[]) => void;
	upsert: (identity: Identity) => void;
	remove: (id: string) => void;
}

export const useIdentitiesStore = create<IdentitiesState>((set) => ({
	identities: [],
	setAll: (identities) => set({ identities }),
	upsert: (identity) =>
		set((s) => ({
			identities: s.identities.some((i) => i.id === identity.id)
				? s.identities.map((i) => (i.id === identity.id ? identity : i))
				: [...s.identities, identity],
		})),
	remove: (id) => set((s) => ({ identities: s.identities.filter((i) => i.id !== id) })),
}));

export const identitySecretAccount = (id: string) => `identity:${id}`;
