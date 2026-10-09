import { create } from "zustand";
import type { Host, HostGroup } from "@/data/types";
import { effectiveHost, toRawHost } from "../lib/groupConfig";
import { useGroupConfigsStore } from "./groupConfigs";
import { useIdentitiesStore } from "./identities";

export type HostView = "card" | "list" | "tree";

/** 左侧特殊视图（需求书 05-A：最近与收藏 / 在线状态） */
export type HostScope = "all" | "online" | "favorites" | "jump";

/* 主机库只承载**用户自己录入**的数据：首次启动是空的，所有变更会落盘。
 * 这里不再有任何种子数据——界面上出现的主机一定是你真的加过的。 */

interface HostsState {
	/**
	 * 生效主机：原始主机 + 分组默认值（Netcatty applyGroupDefaults）+ 钥匙串身份。
	 * 界面与连接都读这一份；落盘与主机编辑用 rawHosts。
	 */
	hosts: Host[];
	/** 用户实际录入的主机（未设置的字段保持未设置，才能继承分组默认值） */
	rawHosts: Host[];
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
	/** 置顶 / 取消置顶（Netcatty toggleHostPinned） */
	togglePinned: (id: string) => void;
	renameHost: (id: string, name: string) => void;
	removeHost: (id: string) => void;
	/** 基于生效主机改出来的主机：继承来的值不会被固化（lib/groupConfig.ts toRawHost） */
	upsertHost: (host: Host) => void;
	/** 主机编辑弹窗：直接写原始主机 */
	upsertRawHost: (host: Host) => void;
	rawHostById: (id: string) => Host | undefined;
	/** 分组设置 / 身份变化后重算生效主机 */
	recompute: () => void;
	moveHost: (id: string, groupId: string | null) => void;
	setDragging: (id: string | null) => void;
	hostById: (id: string) => Host | undefined;

	setAll: (hosts: Host[], groups: HostGroup[]) => void;
	/** parentId 给出时建为子分组（Netcatty「新建子分组」） */
	addGroup: (name: string, parentId?: string | null) => HostGroup;
	renameGroup: (id: string, name: string) => void;
	/** 改父分组（Netcatty 分组详情「父分组」）；会重新计算继承 */
	moveGroup: (id: string, parentId: string | null) => void;
	/**
	 * 删除分组及其全部子分组。默认组内主机移到「未分组」（Netcatty：移动到根级别）；
	 * deleteHosts=true 时连同主机一起删（Netcatty 删除对话框的「同时删除该分组下的所有主机」）。
	 * 返回被删掉的主机 id，调用方据此清理钥匙串。
	 */
	removeGroup: (id: string, options?: { deleteHosts?: boolean }) => string[];
}

function derive(rawHosts: Host[], groups: HostGroup[]): Host[] {
	const ctx = {
		groups,
		groupConfigs: useGroupConfigsStore.getState().configs,
		identities: useIdentitiesStore.getState().identities,
	};
	return rawHosts.map((h) => effectiveHost(h, ctx));
}

export const useHostsStore = create<HostsState>((set, get) => {
	/** 改原始主机，同时重算生效主机 */
	const mutate = (fn: (raw: Host[]) => Host[], extra?: (s: HostsState) => Partial<HostsState>) =>
		set((s) => {
			const rawHosts = fn(s.rawHosts);
			return { rawHosts, hosts: derive(rawHosts, s.groups), ...(extra ? extra(s) : {}) };
		});
	return {
	hosts: [],
	rawHosts: [],
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

	toggleFavorite: (id) => mutate((raw) => raw.map((h) => (h.id === id ? { ...h, favorite: !h.favorite } : h))),

	togglePinned: (id) =>
		mutate((raw) =>
			raw.map((h) => {
				if (h.id !== id) return h;
				if (h.pinned) {
					const { pinned: _drop, ...rest } = h;
					return rest;
				}
				return { ...h, pinned: true };
			}),
		),

	renameHost: (id, name) => mutate((raw) => raw.map((h) => (h.id === id ? { ...h, name } : h))),

	removeHost: (id) =>
		mutate(
			(raw) => raw.filter((h) => h.id !== id),
			(s) => ({ selectedIds: s.selectedIds.filter((x) => x !== id) }),
		),

	moveHost: (id, groupId) => mutate((raw) => raw.map((h) => (h.id === id ? { ...h, groupId } : h))),

	upsertHost: (host) =>
		mutate((raw) => {
			const prevRaw = raw.find((h) => h.id === host.id);
			const prevEffective = get().hosts.find((h) => h.id === host.id);
			const next = toRawHost(host, prevRaw, prevEffective);
			return prevRaw ? raw.map((h) => (h.id === host.id ? next : h)) : [...raw, next];
		}),

	upsertRawHost: (host) =>
		mutate((raw) => (raw.some((h) => h.id === host.id) ? raw.map((h) => (h.id === host.id ? host : h)) : [...raw, host])),

	rawHostById: (id) => get().rawHosts.find((h) => h.id === id),

	recompute: () => set((s) => ({ hosts: derive(s.rawHosts, s.groups) })),

	hostById: (id) => get().hosts.find((h) => h.id === id),

	setAll: (hosts, groups) => set({ rawHosts: hosts, groups, hosts: derive(hosts, groups), hydrated: true }),

	addGroup: (name, parentId = null) => {
		const group: HostGroup = {
			id: `g-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
			name,
			parentId: parentId ?? null,
			expanded: true,
		};
		set((s) => ({ groups: [...s.groups, group] }));
		return group;
	},

	renameGroup: (id, name) =>
		set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)) })),

	moveGroup: (id, parentId) =>
		set((s) => {
			const groups = s.groups.map((g) => (g.id === id ? { ...g, parentId } : g));
			return { groups, hosts: derive(s.rawHosts, groups) };
		}),

	removeGroup: (id, options) => {
		const doomed = groupWithDescendants(get().groups, id);
		const removedHostIds = options?.deleteHosts
			? get().hosts.filter((h) => h.groupId && doomed.has(h.groupId)).map((h) => h.id)
			: [];
		// 分组设置随分组一起删除（Netcatty 删除分组时同样移除该路径下的 groupConfigs）
		const configs = useGroupConfigsStore.getState();
		const doomedConfigs = configs.configs.filter((c) => doomed.has(c.groupId));
		configs.setAll(configs.configs.filter((c) => !doomed.has(c.groupId)));
		// 它们在钥匙串里的分组密码 / 分组代理口令一并清理
		if (doomedConfigs.length > 0) {
			void import("../lib/secret")
				.then(({ secretDelete }) =>
					Promise.all(
						doomedConfigs.flatMap((c) => [secretDelete(`group:${c.groupId}`), secretDelete(`group-proxy:${c.groupId}`)].map((p) => p.catch(() => undefined))),
					),
				)
				.catch(() => undefined);
		}
		set((s) => {
			const groups = s.groups.filter((g) => !doomed.has(g.id));
			// 组没了，组里的主机回到未分组（或按选项一起删），避免出现指向不存在分组的孤儿
			const rawHosts = options?.deleteHosts
				? s.rawHosts.filter((h) => !(h.groupId && doomed.has(h.groupId)))
				: s.rawHosts.map((h) => (h.groupId && doomed.has(h.groupId) ? { ...h, groupId: null } : h));
			return {
				groups,
				rawHosts,
				hosts: derive(rawHosts, groups),
				selectedIds: s.selectedIds.filter((x) => !removedHostIds.includes(x)),
			};
		});
		return removedHostIds;
	},
	};
});

// 分组设置 / 身份变化时重算生效主机
useGroupConfigsStore.subscribe(() => useHostsStore.getState().recompute());
useIdentitiesStore.subscribe(() => useHostsStore.getState().recompute());

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

/** 分组本身 + 全部后代分组的 id */
export function groupWithDescendants(groups: HostGroup[], id: string): Set<string> {
	const out = new Set<string>([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const g of groups) {
			if (g.parentId && out.has(g.parentId) && !out.has(g.id)) {
				out.add(g.id);
				grew = true;
			}
		}
	}
	return out;
}

/** 分组的完整路径名，如「生产 / 数据库」（子分组显示用；环引用时截断） */
export function groupPathLabel(groups: HostGroup[], id: string): string {
	const byId = new Map(groups.map((g) => [g.id, g]));
	const parts: string[] = [];
	const seen = new Set<string>();
	let cur = byId.get(id);
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		parts.unshift(cur.name);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return parts.join(" / ");
}

/** 按树的先序排列分组：父分组后面紧跟它的子分组，同级保持原顺序 */
export function orderGroupsAsTree(groups: HostGroup[]): { group: HostGroup; depth: number }[] {
	const ids = new Set(groups.map((g) => g.id));
	const children = new Map<string | null, HostGroup[]>();
	for (const g of groups) {
		const parent = g.parentId && ids.has(g.parentId) && g.parentId !== g.id ? g.parentId : null;
		const list = children.get(parent) ?? [];
		list.push(g);
		children.set(parent, list);
	}
	const out: { group: HostGroup; depth: number }[] = [];
	const seen = new Set<string>();
	const walk = (parent: string | null, depth: number) => {
		for (const g of children.get(parent) ?? []) {
			if (seen.has(g.id)) continue;
			seen.add(g.id);
			out.push({ group: g, depth });
			walk(g.id, depth + 1);
		}
	};
	walk(null, 0);
	// 环里的分组（理论上不会有）兜底追加，别让它们消失
	for (const g of groups) if (!seen.has(g.id)) out.push({ group: g, depth: 0 });
	return out;
}

/** Netcatty handleCopyCredentials 的文本格式：非默认端口追加 :port，IPv6 加方括号 */
export function formatHostCredentials(host: Pick<Host, "hostname" | "port" | "username">, password: string): string {
	const port = host.port ?? 22;
	let address: string;
	if (port !== 22) {
		const isIPv6 = host.hostname.includes(":") && !host.hostname.startsWith("[");
		address = `${isIPv6 ? `[${host.hostname}]` : host.hostname}:${port}`;
	} else {
		address = host.hostname;
	}
	return `host: ${address}\nusername: ${host.username ?? ""}\npassword: ${password}`;
}
