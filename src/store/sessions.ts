import { create } from "zustand";
import type { ConnectionStatus, SessionTab, SplitLayout, TerminalLine, TerminalPane } from "@/data/types";
import { useHostsStore } from "./hosts";

/* 会话：只承载真实打开的标签与分屏格。
 * 首次启动没有任何会话——工作区会显示空状态并引导去主机库挑一台。 */

interface SessionsState {
	tabs: SessionTab[];
	panes: TerminalPane[];
	activeTabId: string;
	focusedPaneId: string;

	openSession: (hostId: string) => string;
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

export const useSessionsStore = create<SessionsState>((set, get) => ({
	tabs: [],
	panes: [],
	activeTabId: "",
	focusedPaneId: "",

	openSession: (hostId) => {
		const existing = get().tabs.find((t) => t.hostId === hostId);
		if (existing) {
			set({ activeTabId: existing.id });
			return existing.id;
		}

		const host = useHostsStore.getState().hosts.find((h) => h.id === hostId);
		const id = `tab-${++seq}`;
		const paneId = `pane-${++seq}`;

		const tab: SessionTab = {
			id,
			hostId,
			title: host?.name ?? "新会话",
			status: "connecting",
			layout: "single",
			broadcasting: false,
		};

		const pane: TerminalPane = {
			id: paneId,
			hostId,
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
			const closed = s.tabs.find((t) => t.id === tabId);
			// 关标签要把这一格对应的 pane 也一起清掉，避免残留
			const panes = s.panes.filter((p) => (closed?.hostId ? p.hostId !== closed.hostId : true));
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
				// 同一主机的分屏格一起更新，避免标签显示已连接而格子里还写着连接中
				panes: s.panes.map((p) => (tab.hostId && p.hostId === tab.hostId ? { ...p, status } : p)),
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
			const pane: TerminalPane = {
				id,
				hostId: current?.hostId ?? null,
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
