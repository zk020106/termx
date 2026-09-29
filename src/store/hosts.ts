import { create } from "zustand";
import { hostGroups as seedGroups, hosts as seedHosts } from "@/data/mock";
import type { Host, HostGroup } from "@/data/types";

export type HostView = "card" | "list" | "tree";

/** 左侧特殊视图（需求书 05-A：最近与收藏 / 在线状态） */
export type HostScope = "all" | "online" | "favorites" | "jump";

interface HostsState {
	hosts: Host[];
	groups: HostGroup[];
	view: HostView;
	query: string;
	scope: HostScope;
	activeGroupId: string | null;
	selectedIds: string[];
	/** 拖拽进行中（主机库状态之一） */
	draggingId: string | null;

	setView: (view: HostView) => void;
	setQuery: (query: string) => void;
	setScope: (scope: HostScope) => void;
	setActiveGroup: (groupId: string | null) => void;
	toggleSelect: (id: string) => void;
	setSelection: (ids: string[]) => void;
	clearSelection: () => void;
	toggleFavorite: (id: string) => void;
	removeHost: (id: string) => void;
	upsertHost: (host: Host) => void;
	setDragging: (id: string | null) => void;
	hostById: (id: string) => Host | undefined;
}

export const useHostsStore = create<HostsState>((set, get) => ({
	hosts: seedHosts,
	groups: seedGroups,
	view: "card",
	query: "",
	scope: "all",
	activeGroupId: null,
	selectedIds: [],
	draggingId: null,

	setView: (view) => set({ view }),
	setQuery: (query) => set({ query }),
	setScope: (scope) => set({ scope, activeGroupId: null }),
	setActiveGroup: (activeGroupId) => set({ activeGroupId }),
	setDragging: (draggingId) => set({ draggingId }),

	toggleSelect: (id) =>
		set((s) => ({
			selectedIds: s.selectedIds.includes(id) ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id],
		})),

	setSelection: (selectedIds) => set({ selectedIds }),
	clearSelection: () => set({ selectedIds: [] }),

	toggleFavorite: (id) =>
		set((s) => ({
			hosts: s.hosts.map((h) => (h.id === id ? { ...h, favorite: !h.favorite } : h)),
		})),

	removeHost: (id) =>
		set((s) => ({
			hosts: s.hosts.filter((h) => h.id !== id),
			selectedIds: s.selectedIds.filter((x) => x !== id),
		})),

	upsertHost: (host) =>
		set((s) => ({
			hosts: s.hosts.some((h) => h.id === host.id)
				? s.hosts.map((h) => (h.id === host.id ? host : h))
				: [...s.hosts, host],
		})),

	hostById: (id) => get().hosts.find((h) => h.id === id),
}));

/** 搜索 + 分组 + 快速视图过滤。搜索命中名称、IP、用户名、标签（需求书 05-A） */
export function filterHosts(state: HostsState): Host[] {
	const q = state.query.trim().toLowerCase();
	let list = state.hosts;

	if (state.scope === "online") list = list.filter((h) => h.reachable);
	if (state.scope === "favorites") list = list.filter((h) => h.favorite);
	if (state.scope === "jump") list = list.filter((h) => h.jumpHostIds.length === 0 && state.hosts.some((x) => x.jumpHostIds.includes(h.id)));
	if (state.activeGroupId) list = list.filter((h) => h.groupId === state.activeGroupId);

	if (q) {
		list = list.filter((h) =>
			[h.name, h.hostname, h.username, ...h.tags].some((field) => field.toLowerCase().includes(q)),
		);
	}
	return list;
}
