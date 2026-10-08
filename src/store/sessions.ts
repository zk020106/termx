import { create } from "zustand";
import type { ConnectionStatus, SessionTab, SplitLayout, TerminalLine, TerminalPane } from "@/data/types";
import { sshSessionAlive, newSshSessionKey, closeSshSession, writeSsh } from "@/components/terminal/sshCache";
import { closePty, writePty } from "@/components/terminal/ptyCache";
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
	 */
	openSession: (hostId: string | null, sessionKey?: string | null, customTitle?: string) => string;
	closeTab: (tabId: string) => void;
	reopenTab: (tab: SessionTab) => void;
	reconnectTab: (tabId: string) => void;
	setActiveTab: (tabId: string) => void;
	setTabTitle: (tabId: string, title: string) => void;
	setStatus: (tabId: string, status: ConnectionStatus) => void;
	setLayout: (tabId: string, layout: SplitLayout) => void;
	toggleBroadcast: (tabId: string) => void;
	focusPane: (paneId: string) => void;
	appendLine: (paneId: string, line: TerminalLine) => void;
	splitPane: (tabId?: string, direction?: "horizontal" | "vertical") => string | null;
	closePane: (paneId: string) => void;
}

let seq = 0;

export const useSessionsStore = create<SessionsState>((set, get) => ({
	tabs: [],
	panes: [],
	activeTabId: "vaults",
	focusedPaneId: "",

	openSession: (hostId, sessionKey = null, customTitle) => {
		const host = hostId ? useHostsStore.getState().hosts.find((h) => h.id === hostId) : null;
		const id = `tab-${++seq}`;
		const paneId = `pane-${++seq}`;
		const key = sessionKey ?? (hostId ? newSshSessionKey(hostId) : null);

		const tabTitle = customTitle ?? (host ? host.name : "本地终端");
		const tab: SessionTab = {
			id,
			hostId,
			sessionKey: key,
			title: tabTitle,
			status: hostId ? "connecting" : "connected",
			layout: "single",
			broadcasting: false,
		};

		const pane: TerminalPane = {
			id: paneId,
			tabId: id,
			hostId,
			sessionKey: key,
			title: host ? `${host.username}@${host.name}` : "本地终端",
			subtitle: host ? `${host.username}@${host.hostname}:${host.port}` : "本地 shell",
			status: hostId ? "connecting" : "connected",
			lines: [],
		};

		set((s) => ({
			tabs: [...s.tabs, tab],
			panes: [...s.panes, pane],
			activeTabId: id,
			focusedPaneId: paneId,
		}));
		return id;
	},

	closeTab: (tabId) => {
		const s = get();
		const tab = s.tabs.find((t) => t.id === tabId);
		if (!tab) return;

		// 销毁属于该标签的全部 PTY 与 SSH 会话
		const tabPanes = s.panes.filter((p) => p.tabId === tabId);
		for (const p of tabPanes) {
			if (p.sessionKey) void closeSshSession(p.sessionKey);
			else closePty(p.id);
		}

		const tabs = s.tabs.filter((t) => t.id !== tabId);
		const panes = s.panes.filter((p) => p.tabId !== tabId);
		const activeTabId = s.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? "vaults") : s.activeTabId;
		const focusedPaneId = panes.find((p) => p.tabId === activeTabId)?.id ?? panes[0]?.id ?? "";

		set({ tabs, panes, activeTabId, focusedPaneId });
	},

	reopenTab: (tab) => set((s) => ({ tabs: [...s.tabs, tab] })),

	reconnectTab: (tabId) => {
		const s = get();
		const tab = s.tabs.find((t) => t.id === tabId);
		if (!tab) return;

		// 销毁旧会话，派发新 sessionKey，状态重置为 connecting
		const updatedPanes = s.panes.map((p) => {
			if (p.tabId !== tabId) return p;
			if (p.sessionKey) void closeSshSession(p.sessionKey);
			else closePty(p.id);
			const newKey = p.hostId ? newSshSessionKey(p.hostId) : null;
			return {
				...p,
				sessionKey: newKey,
				status: (p.hostId ? "connecting" : "connected") as ConnectionStatus,
				lines: [],
			};
		});

		const newTabKey = tab.hostId
			? (updatedPanes.find((p) => p.tabId === tabId)?.sessionKey ?? newSshSessionKey(tab.hostId))
			: null;
		const updatedTabs = s.tabs.map((t) => {
			if (t.id !== tabId) return t;
			return {
				...t,
				sessionKey: newTabKey,
				status: (t.hostId ? "connecting" : "connected") as ConnectionStatus,
			};
		});

		set({ tabs: updatedTabs, panes: updatedPanes });
	},

	setActiveTab: (activeTabId) => {
		const s = get();
		const focusedPaneId =
			activeTabId === "vaults"
				? s.focusedPaneId
				: (s.panes.find((p) => p.tabId === activeTabId)?.id ?? s.focusedPaneId);
		set({ activeTabId, focusedPaneId });
	},

	setTabTitle: (tabId, title) =>
		set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)) })),

	setStatus: (tabId, status) =>
		set((s) => {
			const tab = s.tabs.find((t) => t.id === tabId);
			if (!tab) return {};
			return {
				tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, status } : t)),
				panes: s.panes.map((p) => (p.tabId === tabId ? { ...p, status } : p)),
			};
		}),

	setLayout: (tabId, layout) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, layout } : t)) })),

	toggleBroadcast: (tabId) =>
		set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, broadcasting: !t.broadcasting } : t)) })),

	focusPane: (focusedPaneId) => set({ focusedPaneId }),

	appendLine: (paneId, line) =>
		set((s) => ({ panes: s.panes.map((p) => (p.id === paneId ? { ...p, lines: [...p.lines, line] } : p)) })),

	splitPane: (targetTabId, direction = "horizontal") => {
		const s = get();
		const tabId = targetTabId ?? s.activeTabId;
		const tab = s.tabs.find((t) => t.id === tabId);
		if (!tab) return null;

		const currentPanes = s.panes.filter((p) => p.tabId === tabId);
		if (currentPanes.length >= 4) return null; // 最多 4 分屏

		const id = `pane-${++seq}`;
		// 新分屏格建立独立会话：本地终端则启动新本地 shell，远程主机则建立独立连接
		const sessionKey = tab.hostId ? newSshSessionKey(tab.hostId) : null;
		const host = tab.hostId ? useHostsStore.getState().hosts.find((h) => h.id === tab.hostId) : null;

		const pane: TerminalPane = {
			id,
			tabId,
			hostId: tab.hostId,
			sessionKey,
			title: host ? `${host.username}@${host.name}` : "本地终端",
			subtitle: host ? `${host.username}@${host.hostname}:${host.port}` : "本地 shell",
			status: tab.hostId ? "connecting" : "connected",
			lines: [],
		};

		const nextCount = currentPanes.length + 1;
		const nextLayout: SplitLayout =
			nextCount <= 1 ? "single" : nextCount === 2 ? (direction === "vertical" ? "vertical" : "horizontal") : "grid";

		set((state) => ({
			panes: [...state.panes, pane],
			focusedPaneId: id,
			tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, layout: nextLayout } : t)),
		}));

		return id;
	},

	closePane: (paneId) => {
		const s = get();
		const pane = s.panes.find((p) => p.id === paneId);
		if (!pane) return;

		// 销毁 PTY 或 SSH 会话
		if (pane.sessionKey) void closeSshSession(pane.sessionKey);
		else closePty(pane.id);

		const tabId = pane.tabId;
		const tab = s.tabs.find((t) => t.id === tabId);
		const remainingInTab = s.panes.filter((p) => p.tabId === tabId && p.id !== paneId);

		// 如果此标签下的所有分屏都关完了，直接关闭标签
		if (remainingInTab.length === 0 && tabId) {
			s.closeTab(tabId);
			return;
		}

		const nextLayout: SplitLayout = remainingInTab.length <= 1 ? "single" : remainingInTab.length === 2 ? "horizontal" : "grid";
		const nextPanes = s.panes.filter((p) => p.id !== paneId);
		const focusedPaneId = s.focusedPaneId === paneId ? (remainingInTab[0]?.id ?? nextPanes[0]?.id ?? "") : s.focusedPaneId;

		set((state) => ({
			panes: nextPanes,
			focusedPaneId,
			tabs: tab ? state.tabs.map((t) => (t.id === tabId ? { ...t, layout: nextLayout } : t)) : state.tabs,
		}));
	},
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

/**
 * 向当前焦点终端输入数据（字符串或控制序列）。
 * 如果聚焦的是 SSH 格，则写入 SSH 会话；如果是本地终端，写入 PTY。
 */
export function writeToActiveTerminal(data: string): boolean {
	const s = useSessionsStore.getState();
	if (!s.focusedPaneId) return false;
	const pane = s.panes.find((p) => p.id === s.focusedPaneId);
	if (!pane) return false;
	if (pane.sessionKey) {
		return writeSsh(pane.sessionKey, data);
	}
	return writePty(pane.id, data);
}

