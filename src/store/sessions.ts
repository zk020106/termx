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
	/**
	 * 关闭标签。会话不立刻销毁：先挂起 UNDO_WINDOW_MS，期间「撤销」能把标签连同
	 * 真实会话原样找回（终端从回放缓冲接上，输出一点不丢）；过了窗口才真正断开。
	 */
	closeTab: (tabId: string) => void;
	/** 撤销关闭：会话还挂着就原样找回；已经销毁则按原主机重新连接 */
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
	splitPaneWithHost: (targetTabId: string, hostId: string | null, direction?: "horizontal" | "vertical") => string | null;
	closePane: (paneId: string) => void;
	/* ---- Netcatty 对齐 ---- */
	/** 只重连这一格（Netcatty 终端菜单「重新连接」针对的是这条会话） */
	reconnectPane: (paneId: string) => void;
	/** 「从工作区移出」：把分屏里的这一格（连同它的活会话）挪到紧挨着的新标签 */
	detachPane: (paneId: string) => string | null;
	/** 「复制标签页」：按原布局复制整个标签，每格各开一条新会话，插在原标签右侧 */
	copyTab: (tabId: string) => string | null;
	/** 「复制标签页到新窗口」的接收端：按传来的标签与分屏格克隆一份（每格新会话） */
	importTab: (source: SessionTab, sourcePanes: TerminalPane[]) => string;
	/** 「复制会话」：同主机开一条全新连接的单格标签，插在原标签右侧 */
	duplicateSession: (tabId: string) => string | null;
	setPaneTitle: (paneId: string, title: string) => void;
}

let seq = 0;

/** 关闭标签后会话还保留多久（比撤销提示 6 秒略长，避免点撤销的瞬间会话刚好被销毁） */
export const UNDO_WINDOW_MS = 8000;

interface ClosedTab {
	tab: SessionTab;
	panes: TerminalPane[];
	timer: ReturnType<typeof setTimeout>;
}

/** 刚关闭、还能撤销的标签：tabId → 原标签、原分屏格与销毁计时器 */
const recentlyClosed = new Map<string, ClosedTab>();

function destroyPaneSessions(panes: TerminalPane[]): void {
	for (const p of panes) {
		if (p.sessionKey) void closeSshSession(p.sessionKey);
		else closePty(p.id);
	}
}

/** 立刻销毁所有挂起的已关闭标签（应用退出、测试用） */
export function flushClosedTabs(): void {
	for (const [id, closed] of recentlyClosed) {
		clearTimeout(closed.timer);
		destroyPaneSessions(closed.panes);
		recentlyClosed.delete(id);
	}
}

/**
 * 按原布局克隆一个标签：每格各开一条新会话（新会话键），本地格开新的本地终端。
 * 「复制标签页」与「复制标签页到新窗口」的接收端共用。
 */
function cloneTab(source: SessionTab, sourcePanes: TerminalPane[]): { tab: SessionTab; panes: TerminalPane[] } {
	const id = `tab-${++seq}`;
	const panes: TerminalPane[] = sourcePanes.map((p) => ({
		...p,
		id: `pane-${++seq}`,
		tabId: id,
		sessionKey: p.hostId ? newSshSessionKey(p.hostId) : null,
		status: (p.hostId ? "connecting" : "connected") as ConnectionStatus,
		lines: [],
	}));
	const head = panes[0];
	const tab: SessionTab = {
		...source,
		id,
		sessionKey: head?.sessionKey ?? null,
		status: head?.status ?? "connected",
		broadcasting: false,
	};
	return { tab, panes };
}

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

		// 属于该标签的 PTY 与 SSH 会话先挂起，撤销窗口过后才销毁
		const tabPanes = s.panes.filter((p) => p.tabId === tabId);
		const previous = recentlyClosed.get(tabId);
		if (previous) clearTimeout(previous.timer);
		recentlyClosed.set(tabId, {
			tab,
			panes: tabPanes,
			timer: setTimeout(() => {
				recentlyClosed.delete(tabId);
				destroyPaneSessions(tabPanes);
			}, UNDO_WINDOW_MS),
		});

		const tabs = s.tabs.filter((t) => t.id !== tabId);
		const panes = s.panes.filter((p) => p.tabId !== tabId);
		const activeTabId = s.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? "vaults") : s.activeTabId;
		const focusedPaneId = panes.find((p) => p.tabId === activeTabId)?.id ?? panes[0]?.id ?? "";

		set({ tabs, panes, activeTabId, focusedPaneId });
	},

	reopenTab: (tab) => {
		if (get().tabs.some((t) => t.id === tab.id)) return;
		const closed = recentlyClosed.get(tab.id);
		if (closed) {
			// 会话还活着：原样放回，终端重新挂载时从回放缓冲接上
			clearTimeout(closed.timer);
			recentlyClosed.delete(tab.id);
			set((s) => ({
				tabs: [...s.tabs, closed.tab],
				panes: [...s.panes, ...closed.panes],
				activeTabId: closed.tab.id,
				focusedPaneId: closed.panes[0]?.id ?? s.focusedPaneId,
			}));
			return;
		}
		// 已经销毁：按原主机重新开一个标签并重连（本地终端则起新 shell）
		const id = get().openSession(tab.hostId, null, tab.title);
		set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, layout: "single" } : t)) }));
	},

	reconnectTab: (tabId) => {
		const s = get();
		const tab = s.tabs.find((t) => t.id === tabId);
		if (!tab) return;

		// 销毁旧会话，派发新 sessionKey，状态重置为 connecting。
		// 本地格换一个新的格子 id：PTY 以格子 id 为键，终端组件也以它为 key，
		// 不换的话组件不会重建，留下一个已经没有 shell 的死格子
		const renamed = new Map<string, string>();
		const updatedPanes = s.panes.map((p) => {
			if (p.tabId !== tabId) return p;
			if (p.sessionKey) void closeSshSession(p.sessionKey);
			else closePty(p.id);
			const newKey = p.hostId ? newSshSessionKey(p.hostId) : null;
			const id = p.hostId ? p.id : `pane-${++seq}`;
			if (id !== p.id) renamed.set(p.id, id);
			return {
				...p,
				id,
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

		set({
			tabs: updatedTabs,
			panes: updatedPanes,
			focusedPaneId: renamed.get(s.focusedPaneId) ?? s.focusedPaneId,
		});
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

	splitPaneWithHost: (targetTabId, hostId, direction = "horizontal") => {
		const s = get();
		const tabId = targetTabId ?? s.activeTabId;
		const tab = s.tabs.find((t) => t.id === tabId);
		if (!tab) return null;

		const currentPanes = s.panes.filter((p) => p.tabId === tabId);
		if (currentPanes.length >= 4) return null; // 最多 4 分屏

		const id = `pane-${++seq}`;
		const sessionKey = hostId ? newSshSessionKey(hostId) : null;
		const host = hostId ? useHostsStore.getState().hosts.find((h) => h.id === hostId) : null;

		const pane: TerminalPane = {
			id,
			tabId,
			hostId,
			sessionKey,
			title: host ? `${host.username}@${host.name}` : "本地终端",
			subtitle: host ? `${host.username}@${host.hostname}:${host.port}` : "本地 shell",
			status: hostId ? "connecting" : "connected",
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

	reconnectPane: (paneId) => {
		const s = get();
		const pane = s.panes.find((p) => p.id === paneId);
		if (!pane) return;
		if (pane.sessionKey) void closeSshSession(pane.sessionKey);
		else closePty(pane.id);
		const newKey = pane.hostId ? newSshSessionKey(pane.hostId) : null;
		// 本地格换一个 id，让终端组件重建并重新起 PTY
		const id = pane.hostId ? pane.id : `pane-${++seq}`;
		const status: ConnectionStatus = pane.hostId ? "connecting" : "connected";
		const tab = s.tabs.find((t) => t.id === pane.tabId);
		const firstOfTab = s.panes.find((p) => p.tabId === pane.tabId)?.id === pane.id;
		set({
			panes: s.panes.map((p) => (p.id === paneId ? { ...p, id, sessionKey: newKey, status, lines: [] } : p)),
			tabs:
				tab && firstOfTab
					? s.tabs.map((t) => (t.id === tab.id ? { ...t, sessionKey: newKey, status } : t))
					: s.tabs,
			focusedPaneId: s.focusedPaneId === paneId ? id : s.focusedPaneId,
		});
	},

	detachPane: (paneId) => {
		const s = get();
		const pane = s.panes.find((p) => p.id === paneId);
		if (!pane?.tabId) return null;
		const sourceTab = s.tabs.find((t) => t.id === pane.tabId);
		const siblings = s.panes.filter((p) => p.tabId === pane.tabId && p.id !== paneId);
		if (!sourceTab || siblings.length === 0) return null;
		const id = `tab-${++seq}`;
		const tab: SessionTab = {
			id,
			hostId: pane.hostId,
			sessionKey: pane.sessionKey,
			title: pane.title,
			status: pane.status,
			layout: "single",
			broadcasting: false,
		};
		const sourceLayout: SplitLayout = siblings.length <= 1 ? "single" : siblings.length === 2 ? sourceTab.layout === "vertical" ? "vertical" : "horizontal" : "grid";
		const index = s.tabs.findIndex((t) => t.id === sourceTab.id);
		const tabs = s.tabs.map((t) => {
			if (t.id !== sourceTab.id) return t;
			// 原标签的主会话被挪走时，改由剩下的第一格代表
			const head = siblings[0];
			return t.sessionKey === pane.sessionKey
				? { ...t, layout: sourceLayout, sessionKey: head.sessionKey, hostId: head.hostId, status: head.status }
				: { ...t, layout: sourceLayout };
		});
		tabs.splice(index + 1, 0, tab);
		set({
			tabs,
			panes: s.panes.map((p) => (p.id === paneId ? { ...p, tabId: id } : p)),
			activeTabId: id,
			focusedPaneId: paneId,
		});
		return id;
	},

	copyTab: (tabId) => {
		const s = get();
		const source = s.tabs.find((t) => t.id === tabId);
		if (!source) return null;
		const sourcePanes = s.panes.filter((p) => p.tabId === tabId);
		const { tab, panes } = cloneTab(source, sourcePanes);
		const tabs = [...s.tabs];
		tabs.splice(s.tabs.findIndex((t) => t.id === tabId) + 1, 0, tab);
		set({ tabs, panes: [...s.panes, ...panes], activeTabId: tab.id, focusedPaneId: panes[0]?.id ?? s.focusedPaneId });
		return tab.id;
	},

	importTab: (source, sourcePanes) => {
		const s = get();
		const { tab, panes } = cloneTab(source, sourcePanes);
		set({ tabs: [...s.tabs, tab], panes: [...s.panes, ...panes], activeTabId: tab.id, focusedPaneId: panes[0]?.id ?? s.focusedPaneId });
		return tab.id;
	},

	duplicateSession: (tabId) => {
		const s = get();
		const source = s.tabs.find((t) => t.id === tabId);
		if (!source) return null;
		const id = s.openSession(source.hostId, null, source.title);
		// openSession 追加在末尾；挪到原标签右侧（Netcatty insertCopiedTabOrderIdOnce）
		set((state) => {
			const created = state.tabs.find((t) => t.id === id);
			if (!created) return {};
			const rest = state.tabs.filter((t) => t.id !== id);
			rest.splice(rest.findIndex((t) => t.id === tabId) + 1, 0, created);
			return { tabs: rest };
		});
		return id;
	},

	setPaneTitle: (paneId, title) =>
		set((s) => ({ panes: s.panes.map((p) => (p.id === paneId ? { ...p, title } : p)) })),

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
	const ok = writeToPane(pane, data);
	// 广播中：同一标签里的其它格子也收到
	for (const other of broadcastPeers(pane.id)) writeToPane(other, data);
	return ok;
}

/** 写入某一格：有 SSH 会话写 SSH，否则写本地 PTY */
export function writeToPane(pane: Pick<TerminalPane, "id" | "sessionKey">, data: string): boolean {
	if (pane.sessionKey) return writeSsh(pane.sessionKey, data);
	return writePty(pane.id, data);
}

/**
 * 广播输入的对象：这一格所在标签开着广播时，返回同标签里的**其它**格子。
 * 设置页的说明是「同屏所有格同步输入」，所以范围就是当前标签的分屏格。
 */
export function broadcastPeers(paneId: string): TerminalPane[] {
	const s = useSessionsStore.getState();
	const pane = s.panes.find((p) => p.id === paneId);
	if (!pane) return [];
	const tab = s.tabs.find((t) => t.id === pane.tabId);
	if (!tab?.broadcasting) return [];
	return s.panes.filter((p) => p.tabId === pane.tabId && p.id !== paneId);
}

