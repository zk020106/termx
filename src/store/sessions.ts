import { create } from "zustand";
import type { ConnectionStatus, SessionTab, SplitLayout, TerminalLine, TerminalPane } from "@/data/types";
import { sshSessionAlive, newSshSessionKey } from "@/components/terminal/sshCache";
import { useHostsStore } from "./hosts";

/* 会话：只承载真实打开的标签与分屏格。
 * 首次启动没有任何会话——工作区会显示空状态并引导去主机库挑一台。
 *
 * 会话身份是**会话键**（每条连接一个），不是主机：
 * 同一台主机可以有多个标签、多条并发连接，各自的状态与分屏格互不影响。 */

interface SessionsState {
	tabs: SessionTab[];
	panes: TerminalPane[];
	activeTabId: string;
	focusedPaneId: string;

	/**
	 * 新建一个会话标签。**总是新建**：同一个 hostId 可以开多个标签，
	 * sessionKey 由发起连接的一方生成（见 sshCache.newSshSessionKey），
	 * 这里只负责把它随标签与分屏格一起记下来。
	 * 想「已经有了就聚焦」的调用方请先用 liveTabForHost 判断。
	 */
	openSession: (hostId: string, sessionKey?: string | null) => string;
	closeTab: (tabId: string) => void;
	reopenTab: (tab: SessionTab) => void;
	setActiveTab: (tabId: string) => void;
	setTabTitle: (tabId: string, title: string) => void;
	/** 会话建立/断开后同步标签与分屏格的状态（状态始终可见是需求书原则 3） */
	setStatus: (tabId: string, status: ConnectionStatus) => void;
	setLayout: (tabId: string, layout: SplitLayout) => void;
	toggleBroadcast: (tabId: string) => void;
	focusPane: (paneId: string) => void;
	appendLine: (paneId: string, line: TerminalLine) => void;
	splitPane: () => void;
	closePane: (paneId: string) => void;
}

let seq = 0;

export const useSessionsStore = create<SessionsState>((set) => ({
	tabs: [],
	panes: [],
	activeTabId: "",
	focusedPaneId: "",

	openSession: (hostId, sessionKey = null) => {
		const host = useHostsStore.getState().hosts.find((h) => h.id === hostId);
		const id = `tab-${++seq}`;
		const paneId = `pane-${++seq}`;

		const tab: SessionTab = {
			id,
			hostId,
			sessionKey,
			title: host?.name ?? "新会话",
			status: "connecting",
			layout: "single",
			broadcasting: false,
		};

		const pane: TerminalPane = {
			id: paneId,
			tabId: id,
			hostId,
			sessionKey,
			title: host ? `${host.username}@${host.name}` : "本地终端",
			subtitle: host ? `${host.username}@${host.hostname}:${host.port}` : "本地 shell",
			status: "connecting",
			lines: [],
		};

		set((s) => ({ tabs: [...s.tabs, tab], panes: [...s.panes, pane], activeTabId: id, focusedPaneId: paneId }));
		return id;
	},

	closeTab: (tabId) =>
		set((s) => {
			const tabs = s.tabs.filter((t) => t.id !== tabId);
			// 只清掉**这个标签自己的**分屏格。按 hostId 清会把同一台主机的
			// 另一条会话（另一个标签）的格子一起删掉 —— 那正是多会话下的误伤。
			const panes = s.panes.filter((p) => p.tabId !== tabId);
			const activeTabId = s.activeTabId === tabId ? (tabs[0]?.id ?? "") : s.activeTabId;
			return { tabs, panes, activeTabId };
		}),

	reopenTab: (tab) => set((s) => ({ tabs: [...s.tabs, tab] })),

	setActiveTab: (activeTabId) => set({ activeTabId }),

	setTabTitle: (tabId, title) =>
		set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)) })),

	setStatus: (tabId, status) =>
		set((s) => {
			const tab = s.tabs.find((t) => t.id === tabId);
			if (!tab) return {};
			return {
				tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, status } : t)),
				// 只更新本标签的分屏格：同一台主机的另一条会话是另一条连接，
				// 它的状态由它自己决定（按 hostId 批量更新会把别人的状态也改掉）
				panes: s.panes.map((p) => (p.tabId === tabId ? { ...p, status } : p)),
			};
		}),

	setLayout: (tabId, layout) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, layout } : t)) })),

	toggleBroadcast: (tabId) =>
		set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, broadcasting: !t.broadcasting } : t)) })),

	focusPane: (focusedPaneId) => set({ focusedPaneId }),

	appendLine: (paneId, line) =>
		set((s) => ({ panes: s.panes.map((p) => (p.id === paneId ? { ...p, lines: [...p.lines, line] } : p)) })),

	splitPane: () =>
		set((s) => {
			const current = s.panes.find((p) => p.id === s.focusedPaneId);
			const id = `pane-${++seq}`;
			// 新格子是**另一条独立会话**：给它一个新的会话键，绝不与已有格子共用。
			// 共用键就是「一台主机只能有一条连接」的老毛病。凭据不在这一层，
			// 新格子要等用户在连接页对它发起一次连接（终端会如实说明）。
			const sessionKey = current?.hostId ? newSshSessionKey(current.hostId) : null;
			const pane: TerminalPane = {
				id,
				tabId: current?.tabId ?? null,
				hostId: current?.hostId ?? null,
				sessionKey,
				title: current?.title ?? "新分屏",
				subtitle: current?.subtitle,
				status: current?.status ?? "connected",
				lines: [],
			};
			return { panes: [...s.panes, pane], focusedPaneId: id };
		}),

	closePane: (paneId) =>
		set((s) => {
			const panes = s.panes.filter((p) => p.id !== paneId);
			return { panes, focusedPaneId: panes[0]?.id ?? "" };
		}),
}));

/**
 * 这台主机「已经有会话」的标签：同主机多会话时返回最早打开的那个。
 *
 * 判活看的是 sshCache 里的会话（已连接或正在连接）。失败/已退出的标签不算，
 * 否则点主机会把用户带到一条死掉的标签上 —— 那比多开一条更让人莫名其妙。
 * 没有就返回 null，由调用方决定是发起新连接还是开一格占位。
 */
export function liveTabForHost(hostId: string): SessionTab | null {
	for (const tab of useSessionsStore.getState().tabs) {
		if (tab.hostId !== hostId) continue;
		if (tab.sessionKey && sshSessionAlive(tab.sessionKey)) return tab;
	}
	return null;
}

/** 某个标签占用的所有分屏格（按标签归属，不再按主机归属） */
export function panesOfTab(tabId: string): TerminalPane[] {
	return useSessionsStore.getState().panes.filter((p) => p.tabId === tabId);
}

/** 当前标签的分屏格数量 → 布局档位（需求书：最多 4 格） */
export function paneCountFor(layout: SplitLayout): number {
	switch (layout) {
		case "single":
			return 1;
		case "horizontal":
		case "vertical":
			return 2;
		case "grid":
			return 4;
	}
}
