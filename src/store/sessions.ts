import { create } from "zustand";
import { sessionTabs, terminalPanes } from "@/data/mock";
import type { SessionTab, SplitLayout, TerminalLine, TerminalPane } from "@/data/types";
import { useHostsStore } from "./hosts";

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
	setLayout: (tabId: string, layout: SplitLayout) => void;
	toggleBroadcast: (tabId: string) => void;
	focusPane: (paneId: string) => void;
	appendLine: (paneId: string, line: TerminalLine) => void;
	splitPane: () => void;
	closePane: (paneId: string) => void;
}

let paneSeq = 100;

export const useSessionsStore = create<SessionsState>((set, get) => ({
	tabs: sessionTabs,
	panes: terminalPanes,
	activeTabId: sessionTabs[0]?.id ?? "",
	focusedPaneId: terminalPanes[0]?.id ?? "",

	openSession: (hostId) => {
		const existing = get().tabs.find((t) => t.hostId === hostId);
		if (existing) {
			set({ activeTabId: existing.id });
			return existing.id;
		}
		const host = useHostsStore.getState().hosts.find((h) => h.id === hostId);
		const id = `tab-${++paneSeq}`;
		const tab: SessionTab = {
			id,
			hostId,
			title: host?.name ?? "新会话",
			env: host?.env ?? "dev",
			status: "connecting",
			layout: "single",
			broadcasting: false,
		};
		set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
		return id;
	},

	closeTab: (tabId) =>
		set((s) => {
			const tabs = s.tabs.filter((t) => t.id !== tabId);
			const activeTabId = s.activeTabId === tabId ? (tabs[0]?.id ?? "") : s.activeTabId;
			return { tabs, activeTabId };
		}),

	reopenTab: (tab) => set((s) => ({ tabs: [...s.tabs, tab] })),

	setActiveTab: (activeTabId) => set({ activeTabId }),

	setTabTitle: (tabId, title) =>
		set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)) })),

	setLayout: (tabId, layout) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, layout } : t)) })),

	toggleBroadcast: (tabId) =>
		set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, broadcasting: !t.broadcasting } : t)) })),

	focusPane: (focusedPaneId) => set({ focusedPaneId }),

	appendLine: (paneId, line) =>
		set((s) => ({ panes: s.panes.map((p) => (p.id === paneId ? { ...p, lines: [...p.lines, line] } : p)) })),

	splitPane: () =>
		set((s) => {			const current = s.panes.find((p) => p.id === s.focusedPaneId);
			const id = `pane-${++paneSeq}`;
			const pane: TerminalPane = {
				id,
				hostId: current?.hostId ?? null,
				title: current?.title ?? "新分屏",
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
