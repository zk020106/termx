import { create } from "zustand";
import type { Host, HostGroup } from "@/data/types";

export type HostView = "card" | "list" | "tree";

/** 左侧特殊视图（需求书 05-A：最近与收藏 / 在线状态） */
export type HostScope = "all" | "online" | "favorites" | "jump";

/* 主机库只承载**用户自己录入**的数据：首次启动是空的，所有变更会落盘。
 * 这里不再有任何种子数据——界面上出现的主机一定是你真的加过的。 */

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
	/** 配置是否已从磁盘载入完成，未完成前界面显示载入中 */
	hydrated: boolean;

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
	moveHost: (id: string, groupId: string | null) => void;
	setDragging: (id: string | null) => void;
	hostById: (id: string) => Host | undefined;

	setAll: (hosts: Host[], groups: HostGroup[]) => void;
	addGroup: (name: string) => HostGroup;
	renameGroup: (id: string, name: string) => void;
	removeGroup: (id: string) => void;
}

export const useHostsStore = create<HostsState>((set, get) => ({
	hosts: [],
	groups: [],
	view: "card",
	query: "",
	scope: "all",
	activeGroupId: null,
	selectedIds: [],
	draggingId: null,
	hydrated: false,

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
		set((s) => ({ hosts: s.hosts.map((h) => (h.id === id ? { ...h, favorite: !h.favorite } : h)) })),

	removeHost: (id) =>
		set((s) => ({
			hosts: s.hosts.filter((h) => h.id !== id),
			selectedIds: s.selectedIds.filter((x) => x !== id),
		})),

	moveHost: (id, groupId) =>
		set((s) => ({ hosts: s.hosts.map((h) => (h.id === id ? { ...h, groupId } : h)) })),

	upsertHost: (host) =>
		set((s) => ({
			hosts: s.hosts.some((h) => h.id === host.id)
				? s.hosts.map((h) => (h.id === host.id ? host : h))
				: [...s.hosts, host],
		})),

	hostById: (id) => get().hosts.find((h) => h.id === id),

	setAll: (hosts, groups) => set({ hosts, groups, hydrated: true }),

	addGroup: (name) => {
		const group: HostGroup = { id: `g-${Date.now().toString(36)}`, name, parentId: null, expanded: true };
		set((s) => ({ groups: [...s.groups, group] }));
		return group;
	},

	renameGroup: (id, name) =>
		set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)) })),

	removeGroup: (id) =>
		set((s) => ({
			groups: s.groups.filter((g) => g.id !== id),
			// 组没了，组里的主机回到未分组，避免出现指向不存在分组的孤儿
			hosts: s.hosts.map((h) => (h.groupId === id ? { ...h, groupId: null } : h)),
		})),
}));

/** 搜索 + 分组 + 快速视图过滤。搜索命中名称、IP、用户名、标签（需求书 05-A） */
export function filterHosts(state: HostsState): Host[] {
	const q = state.query.trim().toLowerCase();
	let list = state.hosts;

	if (state.scope === "online") list = list.filter((h) => h.reachable);
	if (state.scope === "favorites") list = list.filter((h) => h.favorite);
	if (state.scope === "jump") {
		// 跳板节点 = 被别的主机当作跳板引用的那些
		list = list.filter((h) => h.jumpHostIds.length === 0 && state.hosts.some((x) => x.jumpHostIds.includes(h.id)));
	}
	if (state.activeGroupId) list = list.filter((h) => h.groupId === state.activeGroupId);

	if (q) {
		list = list.filter((h) =>
			[h.name, h.hostname, h.username, ...h.tags].some((field) => field.toLowerCase().includes(q)),
		);
	}
	return list;
}
