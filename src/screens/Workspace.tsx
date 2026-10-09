import { WindowChrome } from "@/components/chrome/WindowChrome";
import { useScreenActive } from "@/lib/screenActive";
import { startForward, stopForward } from "@/lib/forwardManager";
import { HostEditModal } from "@/components/host/HostEditModal";
import { EmbeddedSftpDrawer } from "@/components/sftp/EmbeddedSftpDrawer";
import { SftpSidebar } from "@/components/sftp/SftpSidebar";
import { observeSshLifecycle } from "@/components/terminal/sshCache";
import { type TerminalHandle, type TerminalMatchInfo } from "@/components/terminal/Terminal";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { Button, IconButton, Kbd } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/Display";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Overlay";
import {
	type Host,
	type SessionTab,
	type SplitLayout,
	type TerminalPane as TerminalPaneModel,
} from "@/data/types";
import { cn } from "@/lib/cn";
import { getHostVisual } from "@/lib/hostVisual";
import { probeHost } from "@/lib/probe";
import { useHostStatus } from "@/lib/status";
import { useForwardsStore } from "@/store/forwards";
import { filterHosts, useHostsStore } from "@/store/hosts";
import { useKeysStore } from "@/store/keys";
import { liveTabForHost, panesOfTab, useSessionsStore, writeToActiveTerminal } from "@/store/sessions";
import { useSettingsStore } from "@/store/settings";
import { useSnippetsStore } from "@/store/snippets";
import { toast } from "@/store/toast";
import { useTransfersStore } from "@/store/transfers";
import { useUiStore } from "@/store/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link, useNavigate } from "react-router";

/* =============================================================================
 * 终端工作区（核心工作台 /workspace）
 *
 * 现代化一体化工作台架构：
 * - 左侧活动抽屉：主机库 / 命令片段 / 端口转发 / 密钥管理 / 传输队列 / SFTP，由活动栏无缝切换。
 * - 多标签与独立分屏：每个分屏格拥有独立 Shell / SSH 通道，互不干扰，支持自由分屏与关闭。
 * - 标签内连接：SSH 认证（密码、密钥、指纹确认、2FA）直接在标签内就地完成。
 * - 底部内嵌 SFTP：随需展开或收起，不占用额外窗口。
 * ========================================================================== */

/** 分屏数 → 网格模板 */
const PANE_GRID_CLASS: Record<SplitLayout, string> = {
	single: "grid-cols-1 grid-rows-1",
	horizontal: "grid-cols-2 grid-rows-1",
	vertical: "grid-cols-1 grid-rows-2",
	grid: "grid-cols-2 grid-rows-2",
};

const LAYOUT_CHIP: Record<SplitLayout, { icon: string; label: string }> = {
	single: { icon: "icon-[lucide--square]", label: "单屏" },
	horizontal: { icon: "icon-[lucide--columns-2]", label: "2 分屏" },
	vertical: { icon: "icon-[lucide--rows-2]", label: "上下分屏" },
	grid: { icon: "icon-[lucide--layout-grid]", label: "4 分屏" },
};

interface MenuState {
	x: number;
	y: number;
	paneId: string;
	canCopy: boolean;
}

interface TabMenuState {
	x: number;
	y: number;
	tabId: string;
}

interface HostMenuState {
	x: number;
	y: number;
	host: Host;
}

export default function Workspace() {
	const tabs = useSessionsStore((s) => s.tabs);
	const panes = useSessionsStore((s) => s.panes);
	const activeTabId = useSessionsStore((s) => s.activeTabId);
	const focusedPaneId = useSessionsStore((s) => s.focusedPaneId);
	const setActiveTab = useSessionsStore((s) => s.setActiveTab);
	const focusPane = useSessionsStore((s) => s.focusPane);
	const toggleBroadcast = useSessionsStore((s) => s.toggleBroadcast);
	const closeTab = useSessionsStore((s) => s.closeTab);
	const reopenTab = useSessionsStore((s) => s.reopenTab);

	// 只订阅用得到的两项，避免主机库里任何无关状态（搜索词、视图）变化都让整个工作区重渲染
	const hostStore = {
		hosts: useHostsStore((s) => s.hosts),
		removeHost: useHostsStore((s) => s.removeHost),
	};
	const screenActive = useScreenActive();

	const sidebarOpen = useUiStore((s) => s.sidebarOpen);
	const activity = useUiStore((s) => s.activity);
	const embeddedSftpOpen = useUiStore((s) => s.embeddedSftpOpen);
	const toggleEmbeddedSftp = useUiStore((s) => s.toggleEmbeddedSftp);
	const rightClick = useSettingsStore((s) => s.rightClick);
	const sftpFollowActiveTab = useSettingsStore((s) => s.sftpFollowActiveTab);
	const setTerminal = useSettingsStore((s) => s.setTerminal);

	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [match, setMatch] = useState<TerminalMatchInfo>({ index: -1, count: 0 });
	const [menu, setMenu] = useState<MenuState | null>(null);
	const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);
	const [hostMenu, setHostMenu] = useState<HostMenuState | null>(null);
	const [deleteConfirmHost, setDeleteConfirmHost] = useState<Host | null>(null);
	const [forwardHostFilter, setForwardHostFilter] = useState<string | null>(null);
	const [pinnedSftpTabId, setPinnedSftpTabId] = useState<string | null>(null);
	const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);
	const [editingHostId, setEditingHostId] = useState<string | null | "new">(null);
	const [editingGroupId, setEditingGroupId] = useState<string | null>(null);

	const sectionRef = useRef<HTMLElement | null>(null);
	const hostSearchRef = useRef<HTMLInputElement | null>(null);
	const terminals = useRef(new Map<string, TerminalHandle>());

	const isVaults = activeTabId === "vaults" || tabs.length === 0;
	const activeTab = isVaults ? null : (tabs.find((t) => t.id === activeTabId) ?? tabs[0]);
	const activeHost = hostStore.hosts.find((h) => h.id === activeTab?.hostId) ?? null;
	const gridPanes = activeTab ? panesForTab(activeTab, panes) : [];
	const focusId = gridPanes.some((p) => p.id === focusedPaneId) ? focusedPaneId : (gridPanes[0]?.id ?? "");
	const broadcasting = Boolean(activeTab?.broadcasting);

	/** SFTP 挂载的实际会话：受 settings.sftpFollowActiveTab 影响 */
	const effectiveSftpTab = useMemo(() => {
		if (sftpFollowActiveTab) {
			return activeTab ?? tabs[0] ?? null;
		}
		if (pinnedSftpTabId) {
			const found = tabs.find((t) => t.id === pinnedSftpTabId);
			if (found) return found;
		}
		return activeTab ?? tabs[0] ?? null;
	}, [sftpFollowActiveTab, pinnedSftpTabId, activeTab, tabs]);

	const effectiveSftpHost = useMemo(() => {
		if (!effectiveSftpTab?.hostId) return null;
		return hostStore.hosts.find((h) => h.id === effectiveSftpTab.hostId) ?? null;
	}, [effectiveSftpTab?.hostId, hostStore.hosts]);

	const effectiveSftpHostLabel = effectiveSftpHost
		? `${effectiveSftpHost.username}@${effectiveSftpHost.name}`
		: (effectiveSftpTab?.title ?? "本地终端");

	const isMaximized = Boolean(maximizedPaneId && gridPanes.some((p) => p.id === maximizedPaneId));
	const effectiveMaximizedPaneId = isMaximized ? maximizedPaneId : null;
	const displayPanes = effectiveMaximizedPaneId
		? gridPanes.filter((p) => p.id === effectiveMaximizedPaneId)
		: gridPanes;

	/** 终端实例的命令式句柄登记表：右键菜单 / 搜索栏 / 快捷键都从这里取 */
	const registerTerminal = useCallback((paneId: string, handle: TerminalHandle | null) => {
		if (handle) terminals.current.set(paneId, handle);
		else terminals.current.delete(paneId);
	}, []);
	const handleFor = (paneId: string) => terminals.current.get(paneId) ?? null;

	const closeMenu = () => setMenu(null);

	const closeSearch = () => {
		setSearchOpen(false);
		setQuery("");
	};

	const toggleMaximize = (paneId: string = focusId) => {
		setMaximizedPaneId((cur) => (cur === paneId ? null : paneId));
	};

	const splitRight = () => {
		if (!activeTab) return;
		if (effectiveMaximizedPaneId) setMaximizedPaneId(null);
		const newPaneId = useSessionsStore.getState().splitPane(activeTab.id, "horizontal");
		if (!newPaneId) {
			toast({ title: "已经是 4 格分屏", description: "最多支持 4 分屏", tone: "warning" });
			return;
		}
		toast({ title: "已新增向右分屏", tone: "default" });
	};

	const splitDown = () => {
		if (!activeTab) return;
		if (effectiveMaximizedPaneId) setMaximizedPaneId(null);
		const newPaneId = useSessionsStore.getState().splitPane(activeTab.id, "vertical");
		if (!newPaneId) {
			toast({ title: "已经是 4 格分屏", description: "最多支持 4 分屏", tone: "warning" });
			return;
		}
		toast({ title: "已新增向下分屏", tone: "default" });
	};

	const selectAll = (paneId: string = focusId) => {
		handleFor(paneId)?.selectAll();
		closeMenu();
		toast({ title: "已全选终端内容", tone: "default" });
	};

	const openMenuAt = (event: ReactMouseEvent<HTMLDivElement>, paneId: string) => {
		event.preventDefault();
		if (!terminals.current.has(paneId)) return;
		focusPane(paneId);
		setMenu({
			x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)),
			y: Math.max(8, Math.min(event.clientY, window.innerHeight - 380)),
			paneId,
			canCopy: (handleFor(paneId)?.getSelection() ?? "").length > 0,
		});
	};

	const toggleBroadcastNow = () => {
		if (!activeTab) return;
		toggleBroadcast(activeTab.id);
	};

	/* ------------------------------ 搜索栏 ------------------------------ */

	useEffect(() => {
		if (!searchOpen) {
			terminals.current.forEach((handle) => handle.endSearch());
			return;
		}
		const handle = terminals.current.get(focusId);
		setMatch(handle ? handle.search(query) : { index: -1, count: 0 });
	}, [searchOpen, query, focusId, activeTabId]);

	/* ---------------------------- 全局快捷键 ---------------------------- */

	useEffect(() => {
		// 工作区常驻：隐藏时（在别的界面）不响应自己的快捷键
		if (!screenActive) return;
		const onKey = (event: KeyboardEvent) => {
			const key = event.key.toLowerCase();
			if (event.key === "Escape") {
				if (menu) {
					closeMenu();
					return;
				}
				if (tabMenu) {
					setTabMenu(null);
					return;
				}
				if (hostMenu) {
					setHostMenu(null);
					return;
				}
				if (deleteConfirmHost) {
					setDeleteConfirmHost(null);
					return;
				}
				if (renamingTabId) {
					setRenamingTabId(null);
					return;
				}
				if (searchOpen) {
					closeSearch();
					return;
				}
				if (effectiveMaximizedPaneId) {
					setMaximizedPaneId(null);
					return;
				}
				return;
			}
			if (!(event.ctrlKey || event.metaKey)) return;

			if (event.shiftKey && key === "f") {
				event.preventDefault();
				if (searchOpen) closeSearch();
				else setSearchOpen(true);
				return;
			}
			if (event.shiftKey && key === "i") {
				event.preventDefault();
				toggleBroadcastNow();
				return;
			}
			if (event.shiftKey && key === "d") {
				event.preventDefault();
				splitRight();
				return;
			}
			if (event.shiftKey && key === "e") {
				event.preventDefault();
				splitDown();
				return;
			}
			if (event.shiftKey && key === "m") {
				event.preventDefault();
				toggleMaximize(focusId);
				return;
			}
			if (event.shiftKey && key === "a") {
				event.preventDefault();
				selectAll(focusId);
				return;
			}
			if (event.shiftKey && key === "s") {
				event.preventDefault();
				toggleEmbeddedSftp();
				return;
			}
			if (event.shiftKey && key === "w") {
				event.preventDefault();
				if (gridPanes.length > 1) {
					useSessionsStore.getState().closePane(focusId);
				} else if (activeTab) {
					onCloseTab(activeTab);
				}
				return;
			}
			if (!event.shiftKey && key === "p") {
				event.preventDefault();
				hostSearchRef.current?.focus();
				return;
			}
			if (!event.shiftKey && key === "l") {
				event.preventDefault();
				handleFor(focusId)?.clear();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [menu, tabMenu, renamingTabId, searchOpen, focusId, activeTab, effectiveMaximizedPaneId, gridPanes.length, screenActive]);

	/* ------------------------------ 交互动作 ---------------------------- */

	const onCloseTab = (tab: SessionTab) => {
		// 会话由 store 挂起几秒再销毁：撤销时能原样找回真实会话（输出不丢）
		closeTab(tab.id);
		toast({
			title: `已关闭 ${tab.title}`,
			tone: "default",
			action: { label: "撤销", run: () => reopenTab(tab) },
		});
	};

	const onNewTab = () => {
		const newTabId = useSessionsStore.getState().openSession(null);
		setActiveTab(newTabId);
	};

	const duplicateTab = (tabId: string) => {
		const tab = tabs.find((t) => t.id === tabId);
		if (!tab) return;
		const newId = useSessionsStore.getState().openSession(tab.hostId);
		setActiveTab(newId);
		setTabMenu(null);
		toast({ title: `已复制标签：${tab.title}`, tone: "default" });
	};

	const reconnectTab = (tabId: string) => {
		useSessionsStore.getState().reconnectTab(tabId);
		setTabMenu(null);
		toast({ title: "正在重新连接", tone: "default" });
	};

	const closeOtherTabs = (tabId: string) => {
		const others = tabs.filter((t) => t.id !== tabId);
		others.forEach((t) => onCloseTab(t));
		setActiveTab(tabId);
		setTabMenu(null);
	};

	const handleRenameSubmit = () => {
		if (renamingTabId && renameValue.trim()) {
			useSessionsStore.getState().setTabTitle(renamingTabId, renameValue.trim());
		}
		setRenamingTabId(null);
	};

	const onTabContextMenu = (event: ReactMouseEvent<HTMLDivElement>, tabId: string) => {
		event.preventDefault();
		event.stopPropagation();
		setTabMenu({
			x: Math.min(event.clientX, window.innerWidth - 190),
			y: Math.min(event.clientY, window.innerHeight - 250),
			tabId,
		});
	};

	/**
	 * 点击主机库中的主机：
	 *  - 已有会话 → 切换到该标签
	 *  - 无会话 → 创建新标签，就地在标签内发起连接
	 */
	const onOpenHost = useCallback(
		(host: Host) => {
			const live = liveTabForHost(host.id);
			if (live) {
				setActiveTab(live.id);
				const first = panesOfTab(live.id)[0];
				if (first) focusPane(first.id);
				setPinnedSftpTabId(live.id);
				toast({ title: `已切到 ${host.name} 的会话`, tone: "default" });
				return;
			}
			const newTabId = useSessionsStore.getState().openSession(host.id);
			setActiveTab(newTabId);
			setPinnedSftpTabId(newTabId);
			toast({ title: `正在连接 ${host.name}`, description: `${host.username}@${host.hostname}:${host.port}`, tone: "default" });
		},
		[setActiveTab, focusPane],
	);

	const onOpenHostInNewTab = useCallback(
		(host: Host) => {
			const newTabId = useSessionsStore.getState().openSession(host.id);
			setActiveTab(newTabId);
			setPinnedSftpTabId(newTabId);
			toast({ title: `已在新标签连接 ${host.name}`, tone: "default" });
		},
		[setActiveTab],
	);

	const onSplitWithHost = useCallback(
		(host: Host, direction: "horizontal" | "vertical") => {
			if (!activeTab) {
				onOpenHostInNewTab(host);
				return;
			}
			if (effectiveMaximizedPaneId) setMaximizedPaneId(null);
			const newPaneId = useSessionsStore.getState().splitPaneWithHost(activeTab.id, host.id, direction);
			if (!newPaneId) {
				toast({ title: "已达到最大分屏数 (最多 4 格)", tone: "warning" });
				return;
			}
			toast({
				title: direction === "horizontal" ? `已向右分屏连接 ${host.name}` : `已向下分屏连接 ${host.name}`,
				tone: "default",
			});
		},
		[activeTab, effectiveMaximizedPaneId, onOpenHostInNewTab],
	);

	const handleOpenSftp = useCallback(
		(host: Host) => {
			let target = liveTabForHost(host.id);
			if (!target) {
				const newTabId = useSessionsStore.getState().openSession(host.id);
				target = useSessionsStore.getState().tabs.find((t) => t.id === newTabId) ?? null;
			}
			if (target) {
				setPinnedSftpTabId(target.id);
				if (sftpFollowActiveTab) {
					setActiveTab(target.id);
				}
			}
			if (!useUiStore.getState().embeddedSftpOpen) {
				useUiStore.getState().toggleEmbeddedSftp();
			}
			toast({ title: `已激活 ${host.name} 的 SFTP 文件管理`, tone: "default" });
		},
		[sftpFollowActiveTab, setActiveTab],
	);

	const handleOpenForward = useCallback((host: Host) => {
		setForwardHostFilter(host.id);
		useUiStore.getState().setSidebarOpen(true);
		useUiStore.getState().setActivity("forward");
		toast({ title: `已切换至 ${host.name} 的端口转发`, tone: "default" });
	}, []);

	const handleProbeHost = useCallback(
		async (host: Host) => {
			toast({ title: `正在探测 ${host.name} 的网络连通性…`, tone: "default" });
			try {
				const report = await probeHost({ id: host.id, host: host.hostname, port: host.port });
				if (report) {
					if (report.reachable) {
						const latency = Math.round(report.median_ms);
						useHostsStore.getState().upsertHost({ ...host, reachable: true, latencyMs: latency });
						toast({
							title: `${host.name} 探测成功`,
							description: `TCP 建连 ${latency}ms (丢包 ${Math.round(report.loss * 100)}%)`,
							tone: "success",
						});
					} else {
						useHostsStore.getState().upsertHost({ ...host, reachable: false });
						toast({
							title: `${host.name} 无法连接`,
							description: report.error ?? "连接超时或对端关闭",
							tone: "danger",
						});
					}
				} else {
					toast({ title: "已在网页模式中模拟探测", description: "原生探测需在客户端运行", tone: "warning" });
				}
			} catch (e) {
				toast({ title: "探测失败", description: String(e), tone: "danger" });
			}
		},
		[],
	);

	const handleHostContextMenu = useCallback((event: ReactMouseEvent, host: Host) => {
		event.preventDefault();
		event.stopPropagation();
		setHostMenu({
			x: Math.min(event.clientX, window.innerWidth - 220),
			y: Math.min(event.clientY, window.innerHeight - 380),
			host,
		});
	}, []);

	/* 真实会话的生命周期 → 标签状态更新 */
	useEffect(
		() =>
			observeSshLifecycle((key, event) => {
				const store = useSessionsStore.getState();
				const tab = store.tabs.find((t) => t.sessionKey === key);
				if (!tab) return;
				store.setStatus(tab.id, event === "connected" ? "connected" : event === "failed" ? "failed" : "disconnected");
			}),
		[],
	);

	const copySelection = async (paneId: string = focusId) => {
		const handle = handleFor(paneId);
		const ok = handle ? await handle.copySelection() : false;
		closeMenu();
		toast(
			ok
				? { title: "已复制终端选区", tone: "success" }
				: { title: "没有可复制的内容", description: "先在终端里拖选一段文本", tone: "warning" },
		);
	};

	const pasteIntoTerminal = async (paneId: string = focusId) => {
		const handle = handleFor(paneId);
		const ok = handle ? await handle.paste() : false;
		closeMenu();
		toast(
			ok
				? { title: "已粘贴到终端", tone: "success" }
				: { title: "没有可粘贴的终端", description: "剪贴板为空，或当前格未就绪", tone: "warning" },
		);
	};

	const onPaneContextMenu = (event: ReactMouseEvent<HTMLDivElement>, paneId: string) => {
		if (rightClick === "menu") {
			openMenuAt(event, paneId);
			return;
		}
		event.preventDefault();
		focusPane(paneId);
		if (rightClick === "paste") void pasteIntoTerminal(paneId);
		else void copySelection(paneId);
	};

	const splitFromMenu = () => {
		closeMenu();
		splitRight();
	};

	/* ------------------------------- 渲染 ------------------------------- */

	const gridClass = effectiveMaximizedPaneId
		? "grid-cols-1 grid-rows-1"
		: activeTab
		? PANE_GRID_CLASS[activeTab.layout]
		: "grid-cols-1 grid-rows-1";
	const activeHostLabel = activeHost ? `${activeHost.username}@${activeHost.name}` : "本地终端";

	const navigate = useNavigate();

	const sidebarContent = useMemo(() => {
		switch (activity) {
			case "snippets":
				return <SnippetsSidebar activeHost={activeHost} />;
			case "forward":
				return (
					<ForwardSidebar
						activeHost={activeHost}
						filterHostId={forwardHostFilter}
						onClearFilter={() => setForwardHostFilter(null)}
						onOpenAddRule={(hostId) => navigate(`/forward?hostId=${hostId ?? activeHost?.id ?? ""}`)}
					/>
				);
			case "keys":
				return <KeysSidebar activeHost={activeHost} />;
			case "transfers":
				return <TransfersSidebar />;
			case "sftp":
				return <SftpSidebar activeTab={activeTab} activeHost={activeHost} onOpenHost={onOpenHost} />;
			case "hosts":
			default:
				return (
					<HostsSidebar
						hostSearchRef={hostSearchRef}
						activeHostId={activeTab?.hostId}
						onOpenHost={onOpenHost}
						onOpenHostInNewTab={onOpenHostInNewTab}
						onOpenSftp={handleOpenSftp}
						onOpenForward={handleOpenForward}
						onHostContextMenu={handleHostContextMenu}
						onAddHost={() => setEditingHostId("new")}
						onEditHost={(h) => setEditingHostId(h.id)}
					/>
				);
		}
	}, [
		activity,
		activeTab,
		activeHost,
		forwardHostFilter,
		onOpenHost,
		onOpenHostInNewTab,
		handleOpenSftp,
		handleOpenForward,
		handleHostContextMenu,
		navigate,
	]);

	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1">
				{/* 动态抽屉侧边栏 (240px，在活动终端会话中按需展开，主机库大本营不需要侧边栏抽屉) */}
				{sidebarOpen && !isVaults && (
					<aside className="flex w-[240px] shrink-0 flex-col border-r border-border bg-surface-sunk">
						{sidebarContent}
					</aside>
				)}

				{/* 终端与主机工作台综合主区 */}
				<section ref={sectionRef} className="relative flex min-w-0 flex-1 flex-col bg-surface">
					{/* 统一标签栏：常驻主机库主标签 + 动态终端会话标签 */}
					<div className="flex h-8.5 items-end gap-1 border-b border-border bg-surface-sunk px-2 shrink-0">
						{/* 常驻的主机库大本营标签 (Pinned Vaults Tab) */}
						<button
							type="button"
							role="tab"
							aria-selected={isVaults}
							onClick={() => setActiveTab("vaults")}
							className={cn(
								"group relative mb-[-1px] flex h-7 items-center gap-1.5 rounded-t-lg px-3 text-[11.5px] transition-all cursor-pointer select-none",
								isVaults
									? "border-t border-x border-border bg-surface font-semibold text-primary shadow-2xs z-10"
									: "text-muted hover:bg-surface-raised/70 hover:text-surface-foreground",
							)}
						>
							<span className="icon-[lucide--server] size-3.5 text-primary" />
							<span>主机库</span>
							<span className="rounded-full bg-surface-raised px-1.5 py-0.2 font-mono text-[9px] text-faint">
								{hostStore.hosts.length}
							</span>
						</button>

						{tabs.map((tab) => (
							<TabItem
								key={tab.id}
								tab={tab}
								active={tab.id === activeTab?.id && !isVaults}
								isRenaming={renamingTabId === tab.id}
								renameValue={renameValue}
								onRenameChange={setRenameValue}
								onRenameSubmit={handleRenameSubmit}
								onRenameCancel={() => setRenamingTabId(null)}
								onSelect={() => setActiveTab(tab.id)}
								onClose={() => onCloseTab(tab)}
								onContextMenu={(e) => onTabContextMenu(e, tab.id)}
								onDoubleClick={() => {
									setRenamingTabId(tab.id);
									setRenameValue(tab.title);
								}}
							/>
						))}

						<button
							type="button"
							onClick={onNewTab}
							className="mb-1 ml-1 flex size-6.5 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-raised hover:text-surface-foreground cursor-pointer"
							title="新建本地终端"
							aria-label="新建标签"
						>
							<span className="icon-[lucide--plus] size-3.5" />
						</button>

						{/* 处于终端会话时的右侧工具栏 */}
						{!isVaults && activeTab && (
							<div className="mb-1 ml-auto flex items-center gap-1.5 text-[11px] text-muted">
								{broadcasting && (
									<button
										type="button"
										onClick={toggleBroadcastNow}
										className="flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning"
										title="广播输入到全部终端（Ctrl Shift I）"
									>
										<span className="icon-[lucide--radio] size-3" />
										广播中 · {gridPanes.length} 个终端
									</button>
								)}

								<IconButton
									icon="icon-[lucide--columns-2]"
									label="向右分屏 (Ctrl Shift D)"
									className="size-5.5"
									onClick={splitRight}
								/>

								<IconButton
									icon="icon-[lucide--rows-2]"
									label="向下分屏 (Ctrl Shift E)"
									className="size-5.5"
									onClick={splitDown}
								/>

								<IconButton
									icon="icon-[lucide--folder-tree]"
									label="切换 SFTP 面板 (Ctrl Shift S)"
									className={cn("size-5.5", embeddedSftpOpen && "text-primary")}
									onClick={toggleEmbeddedSftp}
								/>

								<div className="flex items-center rounded border border-border bg-surface p-0.5" title="切换分屏布局">
									{(["single", "horizontal", "vertical", "grid"] as SplitLayout[]).map((mode) => {
										const info = LAYOUT_CHIP[mode];
										const isCurrent = activeTab?.layout === mode && !effectiveMaximizedPaneId;
										return (
											<button
												key={mode}
												type="button"
												onClick={() => {
													if (effectiveMaximizedPaneId) setMaximizedPaneId(null);
													if (activeTab) useSessionsStore.getState().setLayout(activeTab.id, mode);
												}}
												className={cn(
													"flex size-5 items-center justify-center rounded transition-colors",
													isCurrent
														? "bg-surface-raised text-primary shadow-xs font-semibold"
														: "text-muted hover:text-surface-foreground",
												)}
												title={`布局：${info.label}`}
											>
												<span className={cn(info.icon, "size-3")} />
											</button>
										);
									})}
								</div>
							</div>
						)}
					</div>

					{/* 标签栏下方主体内容：主机库大本营 or 终端分屏 */}
					{isVaults ? (
						<div className="min-h-0 flex-1 overflow-hidden">
							<HostWorkbench
								onOpenHost={onOpenHost}
								onOpenHostInNewTab={onOpenHostInNewTab}
								onSplitWithHost={onSplitWithHost}
								onOpenSftp={handleOpenSftp}
								onOpenForward={handleOpenForward}
								onHostContextMenu={handleHostContextMenu}
								onNewTerminal={onNewTab}
								onAddHost={(groupId) => {
									setEditingGroupId(groupId ?? null);
									setEditingHostId("new");
								}}
								onEditHost={(h) => {
									setEditingGroupId(h.groupId);
									setEditingHostId(h.id);
								}}
								hasActiveSessions={tabs.length > 0}
								activeTabCount={tabs.length}
								onReturnToTerminal={() => {
									if (tabs.length > 0) setActiveTab(tabs[0].id);
								}}
							/>
						</div>
					) : (
						<div className="relative flex min-h-0 flex-1 flex-col">
							{/* 终端搜索栏（Ctrl Shift F）：结果计数 + 上一个 / 下一个 */}
							{searchOpen && (
								<div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-surface-raised px-3">
									<span className="icon-[lucide--search] size-3.5 shrink-0 text-muted" />
									<input
										autoFocus
										value={query}
										onChange={(event) => setQuery(event.target.value)}
										onKeyDown={(event) => {
											if (event.key === "Enter") {
												event.preventDefault();
												setMatch(handleFor(focusId)?.stepMatch(event.shiftKey ? -1 : 1) ?? { index: -1, count: 0 });
											}
											if (event.key === "Escape") {
												event.preventDefault();
												closeSearch();
											}
										}}
										placeholder="在终端输出中搜索…"
										className="h-5.5 w-[260px] rounded border border-border bg-surface px-2 font-mono text-[11px] text-surface-foreground transition-colors placeholder:text-faint focus:border-primary focus:outline-none"
									/>
									<span className={cn("font-mono text-[10.5px] tabular-nums", match.count === 0 ? "text-faint" : "text-muted")}>
										{match.count === 0 ? "无匹配" : `${match.index + 1} / ${match.count}`}
									</span>
									<IconButton
										icon="icon-[lucide--chevron-up]"
										label="上一个匹配 (Shift Enter)"
										className="size-5.5"
										onClick={() => setMatch(handleFor(focusId)?.stepMatch(-1) ?? { index: -1, count: 0 })}
									/>
									<IconButton
										icon="icon-[lucide--chevron-down]"
										label="下一个匹配 (Enter)"
										className="size-5.5"
										onClick={() => setMatch(handleFor(focusId)?.stepMatch(1) ?? { index: -1, count: 0 })}
									/>
									<span className="text-[10px] text-faint">{activeHostLabel} · 当前分屏格</span>
									<div className="ml-auto flex items-center gap-2">
										<Kbd>Ctrl Shift F</Kbd>
										<IconButton icon="icon-[lucide--x]" label="关闭搜索 (Esc)" className="size-5.5" onClick={closeSearch} />
									</div>
								</div>
							)}

							{/* 终端分屏网格 + 底部内嵌 SFTP */}
							<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
								<div className={cn("grid min-h-0 flex-1 gap-px bg-border/40", gridClass)}>
									{displayPanes.map((pane) => (
										<TerminalPane
											key={pane.id}
											pane={pane}
											focused={pane.id === focusId}
											isSplit={gridPanes.length > 1}
											broadcasting={broadcasting}
											offline={pane.status === "disconnected" || pane.status === "failed"}
											status={pane.status}
											registerTerminal={registerTerminal}
											onFocus={() => focusPane(pane.id)}
											onContextMenu={(event) => onPaneContextMenu(event, pane.id)}
											onReconnect={() => {
												useSessionsStore.getState().reconnectTab(pane.tabId ?? activeTab?.id ?? "");
											}}
											onClose={gridPanes.length > 1 ? () => useSessionsStore.getState().closePane(pane.id) : undefined}
											onSplitRight={splitRight}
											onSplitDown={splitDown}
											onToggleMaximize={() => toggleMaximize(pane.id)}
											isMaximized={effectiveMaximizedPaneId === pane.id}
											onOpenSftp={toggleEmbeddedSftp}
											onClear={() => handleFor(pane.id)?.clear()}
										/>
									))}
								</div>

								{embeddedSftpOpen && (
									<EmbeddedSftpDrawer
										sessionKey={effectiveSftpTab?.sessionKey ?? null}
										status={effectiveSftpTab?.status}
										hostTitle={effectiveSftpHostLabel}
										hostId={effectiveSftpTab?.hostId ?? null}
										onClose={toggleEmbeddedSftp}
										onReconnect={() => {
											if (effectiveSftpTab) useSessionsStore.getState().reconnectTab(effectiveSftpTab.id);
										}}
										isFollowing={sftpFollowActiveTab}
										onToggleFollow={() => {
											setTerminal({ sftpFollowActiveTab: !sftpFollowActiveTab });
											toast({
												title: !sftpFollowActiveTab ? "SFTP 已开启跟随活跃终端" : "SFTP 已锁定当前会话",
												tone: "default",
											});
										}}
										availableSessions={tabs.map((t) => ({
											tabId: t.id,
											sessionKey: t.sessionKey,
											hostId: t.hostId,
											title: t.title,
											status: t.status,
										}))}
										onSelectSession={(tabId) => {
											setPinnedSftpTabId(tabId);
											if (sftpFollowActiveTab) {
												setActiveTab(tabId);
											}
										}}
									/>
								)}
							</div>
						</div>
					)}

					{/* 终端右键菜单 */}
					{menu && (
						<>
							<div
								className="fixed inset-0 z-40"
								onMouseDown={closeMenu}
								onContextMenu={(event) => {
									event.preventDefault();
									closeMenu();
								}}
							/>
							<div
								className="fixed z-50 w-[215px] rounded-2xl border border-border/80 bg-surface/98 p-1.5 shadow-popover backdrop-blur-md ring-1 ring-black/5"
								style={{ left: menu.x, top: menu.y }}
							>
								<MenuHeader title="终端" subtitle={activeHost?.name ?? "本地终端"} />
								<MenuItem icon="icon-[lucide--copy]" label="复制" kbd="Ctrl Shift C" disabled={!menu.canCopy} onClick={() => void copySelection(menu.paneId)} />
								<MenuItem icon="icon-[lucide--clipboard-paste]" label="粘贴" kbd="Ctrl Shift V" onClick={() => void pasteIntoTerminal(menu.paneId)} />
								<MenuItem icon="icon-[lucide--check-check]" label="全选" kbd="Ctrl Shift A" onClick={() => selectAll(menu.paneId)} />
								<MenuSeparator />
								<MenuItem
									icon="icon-[lucide--search]"
									label="在终端中查找…"
									kbd="Ctrl Shift F"
									onClick={() => {
										closeMenu();
										setSearchOpen(true);
									}}
								/>
								<MenuSeparator />
								<MenuItem icon="icon-[lucide--columns-2]" label="向右分屏" kbd="Ctrl Shift D" onClick={splitFromMenu} />
								<MenuItem icon="icon-[lucide--rows-2]" label="向下分屏" kbd="Ctrl Shift E" onClick={() => { closeMenu(); splitDown(); }} />
								<MenuItem
									icon={effectiveMaximizedPaneId === menu.paneId ? "icon-[lucide--minimize-2]" : "icon-[lucide--maximize-2]"}
									label={effectiveMaximizedPaneId === menu.paneId ? "还原分屏" : "最大化分屏"}
									kbd="Ctrl Shift M"
									onClick={() => {
										toggleMaximize(menu.paneId);
										closeMenu();
									}}
								/>
								<MenuSeparator />
								<MenuItem
									icon="icon-[lucide--folder-tree]"
									label="打开 SFTP 面板"
									kbd="Ctrl Shift S"
									onClick={() => {
										if (!embeddedSftpOpen) toggleEmbeddedSftp();
										closeMenu();
									}}
								/>
								<MenuItem
									icon="icon-[lucide--eraser]"
									label="清空屏幕"
									kbd="Ctrl L"
									onClick={() => {
										handleFor(menu.paneId)?.clear();
										closeMenu();
										toast({ title: "已清屏", tone: "default" });
									}}
								/>
								<MenuItem
									icon="icon-[lucide--download]"
									label="导出屏幕文本…"
									onClick={() => {
										handleFor(menu.paneId)?.saveScreen();
										closeMenu();
										toast({ title: "已保存屏幕内容", tone: "success" });
									}}
								/>
								<MenuSeparator />
								<MenuItem
									icon="icon-[lucide--refresh-cw]"
									label="重新连接"
									onClick={() => {
										const p = panes.find((pane) => pane.id === menu.paneId);
										if (p) useSessionsStore.getState().setStatus(p.tabId ?? activeTab?.id ?? "", "connecting");
										closeMenu();
									}}
								/>
								<MenuItem
									icon="icon-[lucide--x]"
									label="关闭分屏"
									kbd="Ctrl Shift W"
									onClick={() => {
										closeMenu();
										if (gridPanes.length > 1) {
											useSessionsStore.getState().closePane(menu.paneId);
										} else if (activeTab) {
											onCloseTab(activeTab);
										}
									}}
								/>
							</div>
						</>
					)}

					{/* 标签右键菜单 */}
					{tabMenu && (
						<>
							<div
								className="fixed inset-0 z-40"
								onMouseDown={() => setTabMenu(null)}
								onContextMenu={(event) => {
									event.preventDefault();
									setTabMenu(null);
								}}
							/>
							<div
								className="fixed z-50 w-[185px] rounded-2xl border border-border/80 bg-surface/98 p-1.5 shadow-popover backdrop-blur-md ring-1 ring-black/5"
								style={{ left: tabMenu.x, top: tabMenu.y }}
							>
								<MenuHeader title="会话标签" subtitle={tabs.find((t) => t.id === tabMenu.tabId)?.title ?? ""} />
								<MenuItem
									icon="icon-[lucide--copy]"
									label="复制会话"
									onClick={() => duplicateTab(tabMenu.tabId)}
								/>
								<MenuItem
									icon="icon-[lucide--refresh-cw]"
									label="重新连接"
									onClick={() => reconnectTab(tabMenu.tabId)}
								/>
								<MenuItem
									icon="icon-[lucide--edit-3]"
									label="重命名…"
									onClick={() => {
										const tab = tabs.find((t) => t.id === tabMenu.tabId);
										if (tab) {
											setRenamingTabId(tab.id);
											setRenameValue(tab.title);
										}
										setTabMenu(null);
									}}
								/>
								<MenuSeparator />
								<MenuItem
									icon="icon-[lucide--columns-2]"
									label="向右分屏"
									kbd="Ctrl Shift D"
									onClick={() => {
										setTabMenu(null);
										splitRight();
									}}
								/>
								<MenuItem
									icon="icon-[lucide--rows-2]"
									label="向下分屏"
									kbd="Ctrl Shift E"
									onClick={() => {
										setTabMenu(null);
										splitDown();
									}}
								/>
								<MenuSeparator />
								<MenuItem
									icon="icon-[lucide--x]"
									label="关闭标签"
									kbd="Ctrl Shift W"
									onClick={() => {
										const t = tabs.find((t) => t.id === tabMenu.tabId);
										if (t) onCloseTab(t);
										setTabMenu(null);
									}}
								/>
								<MenuItem
									icon="icon-[lucide--x-circle]"
									label="关闭其他标签"
									disabled={tabs.length <= 1}
									onClick={() => closeOtherTabs(tabMenu.tabId)}
								/>
							</div>
						</>
					)}

					{/* 主机全局右键上下文菜单 */}
					{hostMenu && (
						<>
							<div
								className="fixed inset-0 z-40"
								onMouseDown={() => setHostMenu(null)}
								onContextMenu={(event) => {
									event.preventDefault();
									setHostMenu(null);
								}}
							/>
							<div
								className="fixed z-50 w-[215px] rounded-2xl border border-border/80 bg-surface/98 p-1.5 shadow-popover backdrop-blur-md ring-1 ring-black/5"
								style={{ left: hostMenu.x, top: hostMenu.y }}
							>
								<MenuHeader title="主机" subtitle={`${hostMenu.host.username}@${hostMenu.host.name}`} />
								<MenuItem
									icon="icon-[lucide--terminal]"
									label="连接终端"
									onClick={() => {
										onOpenHost(hostMenu.host);
										setHostMenu(null);
									}}
								/>
								<MenuItem
									icon="icon-[lucide--plus-square]"
									label="在新标签打开"
									onClick={() => {
										onOpenHostInNewTab(hostMenu.host);
										setHostMenu(null);
									}}
								/>
								{!isVaults && (
									<>
										<MenuItem
											icon="icon-[lucide--columns-2]"
											label="向右分屏打开"
											onClick={() => {
												onSplitWithHost(hostMenu.host, "horizontal");
												setHostMenu(null);
											}}
										/>
										<MenuItem
											icon="icon-[lucide--rows-2]"
											label="向下分屏打开"
											onClick={() => {
												onSplitWithHost(hostMenu.host, "vertical");
												setHostMenu(null);
											}}
										/>
									</>
								)}
								<MenuSeparator />
								<MenuItem
									icon="icon-[lucide--folder-tree]"
									label="打开 SFTP 文件"
									onClick={() => {
										handleOpenSftp(hostMenu.host);
										setHostMenu(null);
									}}
								/>
								<MenuItem
									icon="icon-[lucide--arrow-left-right]"
									label="端口转发规则"
									onClick={() => {
										handleOpenForward(hostMenu.host);
										setHostMenu(null);
									}}
								/>
								<MenuItem
									icon="icon-[lucide--activity]"
									label="网络测速 (TCP 探测)"
									onClick={() => {
										void handleProbeHost(hostMenu.host);
										setHostMenu(null);
									}}
								/>
								<MenuSeparator />
								<MenuItem
									icon="icon-[lucide--copy]"
									label="复制 IP 地址"
									onClick={() => {
										void navigator.clipboard?.writeText(hostMenu.host.hostname).catch(() => undefined);
										toast({ title: `已复制 IP：${hostMenu.host.hostname}`, tone: "success" });
										setHostMenu(null);
									}}
								/>
								<MenuItem
									icon="icon-[lucide--terminal-square]"
									label="复制 SSH 登录命令"
									onClick={() => {
										const cmd = `ssh -p ${hostMenu.host.port} ${hostMenu.host.username}@${hostMenu.host.hostname}`;
										void navigator.clipboard?.writeText(cmd).catch(() => undefined);
										toast({ title: "已复制 SSH 命令", description: cmd, tone: "success" });
										setHostMenu(null);
									}}
								/>
								<MenuSeparator />
								<MenuItem
									icon="icon-[lucide--settings-2]"
									label="编辑主机配置…"
									onClick={() => {
										setEditingHostId(hostMenu.host.id);
										setHostMenu(null);
									}}
								/>
								<MenuItem
									icon="icon-[lucide--trash-2]"
									label="删除主机"
									danger
									onClick={() => {
										setDeleteConfirmHost(hostMenu.host);
										setHostMenu(null);
									}}
								/>
							</div>
						</>
					)}
				</section>
			</div>

			{/* 规范的主机配置就地编辑模态框 */}
			<HostEditModal
				open={editingHostId !== null}
				hostId={editingHostId === "new" ? null : editingHostId}
				initialGroupId={editingGroupId}
				onClose={() => {
					setEditingHostId(null);
					setEditingGroupId(null);
				}}
				onSaved={(savedHost, andConnect) => {
					setEditingHostId(null);
					setEditingGroupId(null);
					if (andConnect) {
						onOpenHost(savedHost);
					}
				}}
			/>

			{/* 主机删除确认弹窗 */}
			<Modal
				open={deleteConfirmHost !== null}
				onClose={() => setDeleteConfirmHost(null)}
				title="删除主机"
				footer={
					<div className="flex items-center gap-2">
						<Button size="sm" onClick={() => setDeleteConfirmHost(null)}>
							取消
						</Button>
						<Button
							size="sm"
							variant="danger"
							onClick={() => {
								if (deleteConfirmHost) {
									hostStore.removeHost(deleteConfirmHost.id);
									toast({ title: `已删除主机「${deleteConfirmHost.name}」`, tone: "default" });
								}
								setDeleteConfirmHost(null);
							}}
						>
							确认删除
						</Button>
					</div>
				}
			>
				<div className="space-y-2">
					<div className="text-surface-foreground">
						确认从主机库中删除「<span className="font-semibold text-danger">{deleteConfirmHost?.name}</span>」吗？
					</div>
					<div className="text-[11px] text-faint">
						连接地址：{deleteConfirmHost?.username}@{deleteConfirmHost?.hostname}:{deleteConfirmHost?.port}。
						此操作不可撤销，正在进行的终端会话仍可保留至关闭。
					</div>
				</div>
			</Modal>
		</WindowChrome>
	);
}

/* ============================== 侧边栏子组件 ============================== */

function HostsSidebar({
	activeHostId,
	onOpenHost,
	onOpenHostInNewTab,
	onOpenSftp,
	onOpenForward,
	onHostContextMenu,
	hostSearchRef,
	onAddHost,
	onEditHost,
}: {
	activeHostId?: string | null;
	onOpenHost: (host: Host) => void;
	onOpenHostInNewTab?: (host: Host) => void;
	onOpenSftp?: (host: Host) => void;
	onOpenForward?: (host: Host) => void;
	onHostContextMenu?: (event: ReactMouseEvent, host: Host) => void;
	hostSearchRef: React.RefObject<HTMLInputElement | null>;
	onAddHost?: () => void;
	onEditHost?: (host: Host) => void;
}) {
	const navigate = useNavigate();
	const hostStore = useHostsStore();
	const toggleEmbeddedSftp = useUiStore((s) => s.toggleEmbeddedSftp);
	const embeddedSftpOpen = useUiStore((s) => s.embeddedSftpOpen);

	const liveSessions = useSessionsStore((s) => s.tabs);
	const liveHostIds = useMemo(
		() => new Set(liveSessions.filter((t) => t.status === "connected").map((t) => t.hostId)),
		[liveSessions],
	);

	const [filterScope, setFilterScope] = useState<"all" | "online">("all");
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

	const toggleCollapse = (key: string) => {
		setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
	};

	const onlineCount = useMemo(
		() => hostStore.hosts.filter((h) => liveHostIds.has(h.id) || h.reachable).length,
		[hostStore.hosts, liveHostIds],
	);

	const allFiltered = filterHosts(hostStore);
	const displayHosts = useMemo(() => {
		if (filterScope === "online") {
			return allFiltered.filter((h) => liveHostIds.has(h.id) || h.reachable);
		}
		return allFiltered;
	}, [allFiltered, filterScope, liveHostIds]);

	const groupedIds = useMemo(() => new Set(hostStore.groups.map((g) => g.id)), [hostStore.groups]);
	const ungroupedHosts = useMemo(
		() => displayHosts.filter((h) => !h.groupId || !groupedIds.has(h.groupId)),
		[displayHosts, groupedIds],
	);

	const handleOpenSftp = (host: Host) => {
		if (onOpenSftp) {
			onOpenSftp(host);
		} else {
			onOpenHost(host);
			if (!embeddedSftpOpen) {
				toggleEmbeddedSftp();
			}
		}
	};

	return (
		<div className="flex h-full flex-col bg-surface-sunk">
			{/* 顶栏：标题 + 数量徽标 + 新建/工作台视图 */}
			<div className="flex h-10 shrink-0 items-center justify-between border-b border-border/70 px-3 bg-surface-sunk/60">
				<div className="flex items-center gap-2">
					<span className="icon-[lucide--server] size-4 text-primary" />
					<span className="text-[12px] font-semibold text-surface-foreground">主机列表</span>
					<span className="rounded-full bg-surface px-1.5 py-0.2 font-mono text-[9px] font-medium text-faint border border-border/50">
						{hostStore.hosts.length}
					</span>
				</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={onAddHost ? onAddHost : () => navigate("/hosts/new")}
						className="flex size-6 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-primary transition-colors cursor-pointer"
						title="新建主机"
					>
						<span className="icon-[lucide--plus] size-3.5" />
					</button>
					<button
						type="button"
						onClick={() => useSessionsStore.getState().setActiveTab("vaults")}
						className="flex size-6 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-primary transition-colors cursor-pointer"
						title="切换至主机工作台网格大视图"
					>
						<span className="icon-[lucide--layout-grid] size-3.5" />
					</button>
				</div>
			</div>

			{/* 搜索与分段筛选条 */}
			<div className="border-b border-border/60 p-2 space-y-1.5 bg-surface/30">
				<div className="relative">
					<span className="icon-[lucide--search] pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
					<input
						ref={hostSearchRef}
						value={hostStore.query}
						onChange={(e) => hostStore.setQuery(e.target.value)}
						placeholder="搜索主机名、IP、标签…"
						className="h-7.5 w-full rounded-lg border border-border/70 bg-surface pr-12 pl-8 font-sans text-[11.5px] text-surface-foreground transition-all placeholder:text-faint focus:border-primary focus:bg-surface-raised focus:outline-none shadow-2xs"
					/>
					{hostStore.query ? (
						<button
							type="button"
							onClick={() => hostStore.setQuery("")}
							className="absolute top-1/2 right-2 -translate-y-1/2 flex size-4 items-center justify-center rounded-full text-muted hover:bg-surface-raised hover:text-surface-foreground cursor-pointer"
						>
							<span className="icon-[lucide--x] size-2.5" />
						</button>
					) : (
						<kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-[9px] text-faint bg-surface-raised px-1 py-0.2 rounded border border-border/40">
							Ctrl P
						</kbd>
					)}
				</div>

				{/* 现代分段切换胶囊 (Segmented Control) */}
				<div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-sunk p-0.5 border border-border/50 text-[10.5px]">
					<button
						type="button"
						onClick={() => setFilterScope("all")}
						className={cn(
							"flex h-5.5 items-center justify-center gap-1.5 rounded-md font-medium transition-all cursor-pointer select-none",
							filterScope === "all"
								? "bg-surface text-surface-foreground font-semibold shadow-2xs border border-border/40"
								: "text-muted hover:text-surface-foreground",
						)}
					>
						<span>全部</span>
						<span className="font-mono text-[9.5px] opacity-70">({hostStore.hosts.length})</span>
					</button>
					<button
						type="button"
						onClick={() => setFilterScope("online")}
						className={cn(
							"flex h-5.5 items-center justify-center gap-1.5 rounded-md font-medium transition-all cursor-pointer select-none",
							filterScope === "online"
								? "bg-surface text-surface-foreground font-semibold shadow-2xs border border-border/40"
								: "text-muted hover:text-surface-foreground",
						)}
					>
						<span className="size-1.5 rounded-full bg-success inline-block shrink-0" />
						<span>在线</span>
						<span className="font-mono text-[9.5px] opacity-70">({onlineCount})</span>
					</button>
				</div>
			</div>

			{/* 可滚动的主机列表主体 */}
			<div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
				{hostStore.query ? (
					<>
						<GroupLabel
							label={`搜索结果 · ${displayHosts.length}`}
							icon="icon-[lucide--search]"
						/>
						{displayHosts.length === 0 ? (
							<div className="px-2 py-4 text-center text-[11px] text-faint">没有匹配的主机</div>
						) : (
							<div className="mt-1">
								{displayHosts.map((host) => (
									<HostItem
										key={host.id}
										host={host}
										selected={host.id === activeHostId}
										onOpen={() => onOpenHost(host)}
										onOpenInNewTab={() => onOpenHostInNewTab?.(host)}
										onOpenSftp={() => handleOpenSftp(host)}
										onOpenForward={() => onOpenForward?.(host)}
										onEdit={() => (onEditHost ? onEditHost(host) : navigate(`/hosts/${host.id}/edit`))}
										onContextMenu={(e) => onHostContextMenu?.(e, host)}
									/>
								))}
							</div>
						)}
					</>
				) : (
					<>
						{hostStore.groups.map((group) => {
							const members = displayHosts.filter((h) => h.groupId === group.id);
							if (members.length === 0) return null;
							const isCollapsed = collapsed[group.id];
							return (
								<div key={group.id} className="mb-2">
									<GroupLabel
										label={group.name}
										icon="icon-[lucide--folder] text-amber-500"
										count={members.length}
										collapsed={isCollapsed}
										onToggle={() => toggleCollapse(group.id)}
									/>
									{!isCollapsed && (
										<div className="mt-1">
											{members.map((host) => (
												<HostItem
													key={host.id}
													host={host}
													selected={host.id === activeHostId}
													onOpen={() => onOpenHost(host)}
													onOpenInNewTab={() => onOpenHostInNewTab?.(host)}
													onOpenSftp={() => handleOpenSftp(host)}
													onOpenForward={() => onOpenForward?.(host)}
													onEdit={() => (onEditHost ? onEditHost(host) : navigate(`/hosts/${host.id}/edit`))}
													onContextMenu={(e) => onHostContextMenu?.(e, host)}
												/>
											))}
										</div>
									)}
								</div>
							);
						})}

						{ungroupedHosts.length > 0 && (
							<div className="mb-2">
								<GroupLabel
									label="未分组"
									icon="icon-[lucide--layers] text-muted"
									count={ungroupedHosts.length}
									collapsed={collapsed["ungrouped"]}
									onToggle={() => toggleCollapse("ungrouped")}
								/>
								{!collapsed["ungrouped"] && (
									<div className="mt-1">
										{ungroupedHosts.map((host) => (
											<HostItem
												key={host.id}
												host={host}
												selected={host.id === activeHostId}
												onOpen={() => onOpenHost(host)}
												onOpenInNewTab={() => onOpenHostInNewTab?.(host)}
												onOpenSftp={() => handleOpenSftp(host)}
												onOpenForward={() => onOpenForward?.(host)}
												onEdit={() => (onEditHost ? onEditHost(host) : navigate(`/hosts/${host.id}/edit`))}
												onContextMenu={(e) => onHostContextMenu?.(e, host)}
											/>
										))}
									</div>
								)}
							</div>
						)}

						{hostStore.hosts.length === 0 && (
							<div className="rounded-lg border border-dashed border-border/80 p-3 text-center my-2">
								<div className="text-[11px] font-medium text-surface-foreground">主机库还是空的</div>
								<div className="text-[10px] text-faint mt-0.5">添加常用服务器开始快速连接</div>
								<button
									type="button"
									onClick={onAddHost ? onAddHost : () => navigate("/hosts/new")}
									className="mt-2 inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-[10px] font-medium text-white hover:bg-primary-hover transition-colors cursor-pointer"
								>
									<span className="icon-[lucide--plus] size-3" />
									新建主机
								</button>
							</div>
						)}
					</>
				)}
			</div>

			{/* 底部活跃连接简报 */}
			<div className="mt-auto border-t border-border/80 bg-surface/40 px-3 py-2 text-[10.5px]">
				<div className="flex items-center justify-between text-muted">
					<span className="flex items-center gap-1.5 font-medium">
						<span
							className={cn(
								"size-1.5 rounded-full",
								liveHostIds.size > 0 ? "bg-success animate-pulse" : "bg-muted",
							)}
						/>
						<span className="text-[10px]">
							{liveHostIds.size > 0 ? `${liveHostIds.size} 个会话在线` : "无活跃会话"}
						</span>
					</span>
					<button
						type="button"
						onClick={toggleEmbeddedSftp}
						className={cn(
							"flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors cursor-pointer",
							embeddedSftpOpen ? "bg-primary/10 text-primary font-medium" : "text-muted hover:text-surface-foreground hover:bg-surface-raised",
						)}
						title="展开/收起底部 SFTP 面板"
					>
						<span className="icon-[lucide--folder-tree] size-3" />
						SFTP
					</button>
				</div>
			</div>
		</div>
	);
}

function SnippetsSidebar({ activeHost }: { activeHost?: Host | null }) {
	const snippets = useSnippetsStore((s) => s.snippets);
	const [query, setQuery] = useState("");

	const filtered = snippets.filter(
		(s) =>
			s.name.toLowerCase().includes(query.toLowerCase()) ||
			s.command.toLowerCase().includes(query.toLowerCase()) ||
			s.group.toLowerCase().includes(query.toLowerCase()),
	);

	const handleSendSnippet = (command: string, name: string) => {
		const ok = writeToActiveTerminal(command + "\n");
		if (ok) {
			toast({ title: `已发送命令：${name}`, tone: "success" });
		} else {
			void navigator.clipboard?.writeText(command).catch(() => undefined);
			toast({ title: "已复制到剪贴板", description: command, tone: "default" });
		}
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
				<div className="flex items-center gap-1.5">
					<span className="icon-[lucide--code-2] size-3.5 text-primary" />
					<span className="text-[12px] font-medium tracking-tight text-surface-foreground">命令片段</span>
				</div>
				<Link to="/snippets" className="text-[11px] text-muted hover:text-surface-foreground">
					管理 &gt;
				</Link>
			</div>

			<div className="p-2">
				<input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="搜索命令片段…"
					className="h-7 w-full rounded border border-border bg-surface px-2.5 font-sans text-[11px] text-surface-foreground transition-colors placeholder:text-faint focus:border-primary focus:outline-none"
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 space-y-1">
				{filtered.length === 0 ? (
					<div className="px-2 py-4 text-center text-[11px] text-faint">没有匹配的片段</div>
				) : (
					filtered.map((s) => (
						<div
							key={s.id}
							className="group relative rounded border border-border/60 bg-surface/40 p-2 text-[11.5px] transition-colors hover:border-border hover:bg-surface"
						>
							<div className="flex items-center justify-between">
								<span className="truncate font-medium text-surface-foreground">{s.name}</span>
								<span className="rounded bg-surface-raised px-1 py-0.5 text-[9px] text-faint">{s.group}</span>
							</div>
							<div className="mt-1 truncate font-mono text-[10px] text-muted">{s.command}</div>
							<div className="mt-2 flex items-center gap-1.5">
								<Button
									size="sm"
									variant="primary"
									className="h-5 px-2 text-[10px]"
									icon="icon-[lucide--play]"
									onClick={() => handleSendSnippet(s.command, s.name)}
									title={`发送到当前活跃终端${activeHost ? ` (${activeHost.name})` : ""}`}
								>
									执行
								</Button>
								<Button
									size="sm"
									variant="ghost"
									className="h-5 px-2 text-[10px]"
									onClick={() => {
										void navigator.clipboard?.writeText(s.command).catch(() => undefined);
										toast({ title: "已复制到剪贴板", description: s.command });
									}}
								>
									复制
								</Button>
							</div>
						</div>
					))
				)}
			</div>
		</div>
	);
}

function ForwardSidebar({
	activeHost,
	filterHostId,
	onClearFilter,
	onOpenAddRule,
}: {
	activeHost?: Host | null;
	filterHostId?: string | null;
	onClearFilter?: () => void;
	onOpenAddRule?: (hostId?: string) => void;
}) {
	const rules = useForwardsStore((s) => s.rules);
	const hostStore = useHostsStore();

	const effectiveHostId = filterHostId ?? activeHost?.id ?? null;
	const [scope, setScope] = useState<"all" | "host">(effectiveHostId ? "host" : "all");

	useEffect(() => {
		if (filterHostId) setScope("host");
	}, [filterHostId]);

	const hostInfo = effectiveHostId ? hostStore.hosts.find((h) => h.id === effectiveHostId) : null;
	const hostRulesCount = effectiveHostId ? rules.filter((r) => r.hostId === effectiveHostId).length : 0;

	const displayedRules = useMemo(() => {
		if (scope === "host" && effectiveHostId) {
			return rules.filter((r) => r.hostId === effectiveHostId);
		}
		return rules;
	}, [rules, scope, effectiveHostId]);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
				<div className="flex items-center gap-1.5">
					<span className="icon-[lucide--arrow-left-right] size-3.5 text-primary" />
					<span className="text-[12px] font-medium tracking-tight text-surface-foreground">端口转发</span>
				</div>
				<div className="flex items-center gap-1">
					{onOpenAddRule && (
						<button
							type="button"
							onClick={() => onOpenAddRule(effectiveHostId ?? undefined)}
							className="flex size-5.5 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-surface-foreground transition-colors cursor-pointer"
							title="新建转发规则"
						>
							<span className="icon-[lucide--plus] size-3.5" />
						</button>
					)}
					<Link to="/forward" className="text-[11px] text-muted hover:text-surface-foreground">
						管理 &gt;
					</Link>
				</div>
			</div>

			{/* 范围切换胶囊 */}
			<div className="flex items-center gap-1 border-b border-border/60 p-2">
				<button
					type="button"
					onClick={() => {
						setScope("all");
						onClearFilter?.();
					}}
					className={cn(
						"flex h-5 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium transition-all cursor-pointer border select-none",
						scope === "all"
							? "border-primary/40 bg-primary/15 text-primary font-semibold"
							: "border-transparent text-muted hover:bg-surface hover:text-surface-foreground",
					)}
				>
					全部规则
					<span className="font-mono text-[9px] opacity-75">{rules.length}</span>
				</button>

				{hostInfo && (
					<button
						type="button"
						onClick={() => setScope("host")}
						className={cn(
							"flex h-5 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium transition-all cursor-pointer border select-none truncate max-w-[130px]",
							scope === "host"
								? "border-primary/40 bg-primary/15 text-primary font-semibold"
								: "border-transparent text-muted hover:bg-surface hover:text-surface-foreground",
						)}
						title={`当前主机：${hostInfo.name}`}
					>
						<span className="truncate">{hostInfo.name}</span>
						<span className="font-mono text-[9px] opacity-75 shrink-0">{hostRulesCount}</span>
					</button>
				)}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2 space-y-1">
				{displayedRules.length === 0 ? (
					<div className="px-2 py-6 text-center text-[11px] text-faint">
						{scope === "host" && hostInfo ? (
							<>
								主机「{hostInfo.name}」暂无转发规则
								<div className="mt-2">
									<Button
										size="sm"
										variant="primary"
										className="h-6 px-2 text-[10.5px]"
										icon="icon-[lucide--plus]"
										onClick={() => onOpenAddRule?.(hostInfo.id)}
									>
										为该主机添加规则
									</Button>
								</div>
							</>
						) : (
							<>
								暂无转发规则。
								<Link to="/forward" className="text-primary hover:underline ml-1">
									添加规则
								</Link>
							</>
						)}
					</div>
				) : (
					displayedRules.map((rule) => {
						const ruleHost = hostStore.hosts.find((h) => h.id === rule.hostId);
						return (
							<div
								key={rule.id}
								className="rounded border border-border bg-surface p-2 text-[11.5px] transition-colors"
							>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-1.5 min-w-0">
										<span
											className={cn(
												"size-1.5 rounded-full shrink-0",
												rule.state === "running"
													? "bg-success"
													: rule.state === "starting"
														? "bg-warning"
														: rule.state === "error"
															? "bg-danger"
															: "bg-muted",
											)}
										/>
										<span className="font-medium text-surface-foreground truncate">{rule.name || "未命名规则"}</span>
									</div>
									<span className="font-mono text-[9.5px] text-faint uppercase shrink-0">{rule.type}</span>
								</div>
								<div className="mt-1 flex items-center justify-between font-mono text-[10px] text-muted">
									<span className="truncate">
										:{rule.bindPort} → {rule.type === "dynamic" ? "SOCKS5" : `${rule.targetHost}:${rule.targetPort}`}
										{rule.state === "running" && ` · ${rule.connections} 连接`}
									</span>
									{ruleHost && scope === "all" && (
										<span className="rounded bg-surface-raised px-1 py-0.2 text-[8.5px] text-faint shrink-0 max-w-[80px] truncate">
											{ruleHost.name}
										</span>
									)}
								</div>
								<div className="mt-2 flex items-center justify-end">
									<Button
										size="sm"
										variant={rule.state === "running" || rule.state === "starting" ? "danger" : "default"}
										className="h-5 px-2 text-[10px]"
										title={rule.state === "error" ? rule.error : undefined}
										onClick={async () => {
											if (rule.state === "running" || rule.state === "starting") {
												await stopForward(rule.id);
												toast({ title: `已停止 ${rule.name}`, tone: "default" });
												return;
											}
											const result = await startForward(rule.id);
											if (result.ok) toast({ title: `已启动 ${rule.name}`, tone: "success" });
											else if (result.error)
												toast({ title: `${rule.name} 启动失败`, description: result.error, tone: "danger" });
										}}
									>
										{rule.state === "running" ? "停止" : rule.state === "starting" ? "取消" : "启动"}
									</Button>
								</div>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}

function KeysSidebar({ activeHost }: { activeHost?: Host | null }) {
	const keys = useKeysStore((s) => s.keys);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
				<div className="flex items-center gap-1.5">
					<span className="icon-[lucide--key] size-3.5 text-primary" />
					<span className="text-[12px] font-medium tracking-tight text-surface-foreground">密钥管理</span>
				</div>
				<Link to="/keys" className="text-[11px] text-muted hover:text-surface-foreground">
					管理 &gt;
				</Link>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2 space-y-1">
				{keys.length === 0 ? (
					<div className="px-2 py-4 text-center text-[11px] text-faint">
						暂无密钥。
						<Link to="/keys" className="text-primary hover:underline ml-1">
							添加密钥
						</Link>
					</div>
				) : (
					keys.map((k) => {
						const isHostUsing = Boolean(
							activeHost?.auth?.method === "key" && activeHost.auth.keyId === k.id,
						);
						return (
							<div
								key={k.id}
								className={cn(
									"rounded border bg-surface p-2 text-[11.5px] transition-colors",
									isHostUsing ? "border-primary/50 shadow-2xs" : "border-border",
								)}
							>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-1.5 min-w-0">
										<span className="font-medium text-surface-foreground truncate">{k.name}</span>
										{isHostUsing && (
											<span className="rounded bg-primary/15 px-1 py-0.2 font-mono text-[8.5px] text-primary shrink-0">
												当前主机使用
											</span>
										)}
									</div>
									<span className="font-mono text-[9.5px] text-primary shrink-0">{k.type}</span>
								</div>
								<div className="mt-1 truncate font-mono text-[10px] text-muted">{k.fingerprint}</div>
								<div className="mt-2 flex items-center justify-end">
									<Button
										size="sm"
										variant="ghost"
										className="h-5 px-2 text-[10px]"
										icon="icon-[lucide--copy]"
										onClick={() => {
											void navigator.clipboard?.writeText(k.publicKey).catch(() => undefined);
											toast({ title: "已复制公钥", tone: "success" });
										}}
									>
										复制公钥
									</Button>
								</div>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}

function TransfersSidebar() {
	const items = useTransfersStore((s) => s.items);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
				<span className="text-[12px] font-medium tracking-tight text-surface-foreground">传输队列</span>
				<Link to="/transfers" className="text-[11px] text-muted hover:text-surface-foreground">
					详情 &gt;
				</Link>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2 space-y-1">
				{items.length === 0 ? (
					<div className="px-2 py-4 text-center text-[11px] text-faint">暂无进行中的传输</div>
				) : (
					items.map((t) => (
						<div key={t.id} className="rounded border border-border bg-surface p-2 text-[11.5px]">
							<div className="flex items-center justify-between">
								<span className="truncate font-medium text-surface-foreground">{t.name}</span>
								<span className="text-[10px] text-muted">{t.state}</span>
							</div>
							<div className="mt-1 font-mono text-[10px] text-faint truncate">
								{t.direction === "upload" ? "上传" : "下载"}: {t.remotePath}
							</div>
						</div>
					))
				)}
			</div>
		</div>
	);
}


/* ============================== 辅助小零件 ============================== */

function panesForTab(tab: SessionTab, panes: TerminalPaneModel[]): TerminalPaneModel[] {
	const owned = panes.filter((p) => p.tabId === tab.id);
	if (owned.length > 0) return owned;
	return [
		{
			id: tab.id,
			tabId: tab.id,
			hostId: tab.hostId,
			sessionKey: tab.sessionKey,
			title: tab.title,
			status: tab.status,
			lines: [],
		},
	];
}

function GroupLabel({
	label,
	icon,
	count,
	collapsed,
	onToggle,
}: {
	label: string;
	icon?: string;
	count?: number;
	collapsed?: boolean;
	onToggle?: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			className="group flex w-full items-center justify-between rounded-lg px-2 py-1 text-left select-none text-[11px] font-semibold tracking-tight text-muted hover:bg-surface hover:text-surface-foreground transition-all cursor-pointer"
		>
			<div className="flex items-center gap-1.5 min-w-0">
				{onToggle && (
					<span
						className={cn(
							"icon-[lucide--chevron-right] size-3 shrink-0 text-faint transition-transform duration-150",
							!collapsed && "rotate-90 text-muted",
						)}
					/>
				)}
				{icon && <span className={cn(icon, "size-3.5 shrink-0")} />}
				<span className="truncate">{label}</span>
			</div>
			{typeof count === "number" && (
				<span className="rounded-full bg-surface-raised px-1.5 py-0.2 font-mono text-[9px] text-faint group-hover:text-muted border border-border/40">
					{count}
				</span>
			)}
		</button>
	);
}

function HostItem({
	host,
	selected,
	onOpen,
	onOpenInNewTab,
	onOpenSftp,
	onOpenForward,
	onEdit,
	onContextMenu,
}: {
	host: Host;
	selected: boolean;
	onOpen: () => void;
	onOpenInNewTab?: () => void;
	onOpenSftp?: () => void;
	onOpenForward?: () => void;
	onEdit?: () => void;
	onContextMenu?: (e: ReactMouseEvent) => void;
}) {
	const status = useHostStatus(host.id, host.reachable);
	const visual = getHostVisual(host);
	const forwardCount = useForwardsStore((s) => s.rules.filter((r) => r.hostId === host.id).length);

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onOpen}
			onAuxClick={(e) => {
				if (e.button === 1 && onOpenInNewTab) {
					e.preventDefault();
					onOpenInNewTab();
				}
			}}
			onContextMenu={onContextMenu}
			onKeyDown={(event) => event.key === "Enter" && onOpen()}
			className={cn(
				"group relative mb-1.5 flex flex-col gap-1 rounded-xl p-2 text-[11.5px] transition-all cursor-pointer border select-none",
				selected
					? "border-primary/60 bg-primary/10 text-surface-foreground shadow-host-active ring-1 ring-primary/30"
					: "border-border/60 bg-surface/60 hover:border-primary/50 hover:bg-surface hover:shadow-host-hover text-muted hover:text-surface-foreground",
			)}
		>
			{selected && (
				<span className="absolute left-0 top-2 bottom-2 w-0.75 rounded-r-full bg-primary" />
			)}

			{/* 顶行：状态点 + 系统/云平台图标 + 主机名 + 星标 + 转发胶囊/悬浮操作 */}
			<div className="flex items-center gap-1.5 min-w-0">
				<StatusDot status={status} size={6} className="shrink-0" />
				<span className={cn(visual.icon, visual.color, "size-3.5 shrink-0")} title={visual.platformName} />
				<span
					className={cn(
						"min-w-0 flex-1 truncate font-sans text-[11.5px] tracking-tight",
						selected ? "font-semibold text-primary" : "font-medium text-surface-foreground group-hover:text-primary transition-colors",
					)}
				>
					{host.name}
				</span>

				{host.favorite && (
					<span className="icon-[lucide--star] size-3 shrink-0 text-amber-500 fill-amber-500" />
				)}

				{/* 默认态：仅在配置了端口转发时显露轻量胶囊 */}
				{forwardCount > 0 && (
					<div className="flex items-center gap-1 group-hover:hidden shrink-0">
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onOpenForward?.();
							}}
							className="text-[9px] font-mono px-1.5 py-0.2 rounded-full bg-surface text-primary border border-primary/20 hover:bg-primary/10 transition-colors cursor-pointer"
							title={onOpenForward ? "查看/配置端口转发" : undefined}
						>
							{forwardCount} 转发
						</button>
					</div>
				)}

				{/* 悬浮态：精炼快捷动作（SFTP、新标签、编辑、更多） */}
				<div className="hidden group-hover:flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
					{onOpenSftp && (
						<button
							type="button"
							onClick={onOpenSftp}
							title="打开 SFTP 文件"
							className="flex size-5 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-primary transition-colors cursor-pointer"
						>
							<span className="icon-[lucide--folder-tree] size-3" />
						</button>
					)}
					{onOpenInNewTab && (
						<button
							type="button"
							onClick={onOpenInNewTab}
							title="在新标签打开终端"
							className="flex size-5 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-primary transition-colors cursor-pointer"
						>
							<span className="icon-[lucide--plus-square] size-3" />
						</button>
					)}
					{onEdit && (
						<button
							type="button"
							onClick={onEdit}
							title="编辑主机配置"
							className="flex size-5 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-primary transition-colors cursor-pointer"
						>
							<span className="icon-[lucide--pencil] size-3" />
						</button>
					)}
					{onContextMenu && (
						<button
							type="button"
							onClick={(e) => onContextMenu(e)}
							title="更多选项"
							className="flex size-5 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-surface-foreground transition-colors cursor-pointer"
						>
							<span className="icon-[lucide--more-horizontal] size-3" />
						</button>
					)}
				</div>
			</div>

			{/* 底行：主机网络连接地址与标签 */}
			<div className="flex items-center justify-between gap-1 text-[10px] text-muted">
				<span className="truncate font-mono text-faint group-hover:text-muted">
					{host.username}@{host.hostname}:{host.port}
				</span>
				<div className="flex items-center gap-1 shrink-0">
					{host.latencyMs !== undefined && host.latencyMs > 0 && (
						<span className="rounded bg-surface px-1.5 py-0.2 font-mono text-[9px] text-faint border border-border/50">
							{host.latencyMs}ms
						</span>
					)}
					{host.tags && host.tags.length > 0 && (
						<span className="rounded bg-surface px-1.5 py-0.2 text-[9px] font-medium text-faint border border-border/50">
							{host.tags[0]}
						</span>
					)}
				</div>
			</div>
		</div>
	);
}

function TabItem({
	tab,
	active,
	isRenaming,
	renameValue,
	onRenameChange,
	onRenameSubmit,
	onRenameCancel,
	onSelect,
	onClose,
	onContextMenu,
	onDoubleClick,
}: {
	tab: SessionTab;
	active: boolean;
	isRenaming?: boolean;
	renameValue?: string;
	onRenameChange?: (val: string) => void;
	onRenameSubmit?: () => void;
	onRenameCancel?: () => void;
	onSelect: () => void;
	onClose: () => void;
	onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
	onDoubleClick?: () => void;
}) {
	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onSelect}
			onDoubleClick={onDoubleClick}
			onContextMenu={onContextMenu}
			onKeyDown={(event) => event.key === "Enter" && onSelect()}
			className={cn(
				"group relative flex h-7.5 cursor-pointer items-center gap-2 rounded-t-lg border-x border-t px-3 text-[12px] transition-all select-none",
				active
					? "border-border bg-surface-raised font-semibold text-surface-foreground shadow-2xs"
					: "border-transparent bg-transparent text-muted hover:bg-surface-raised/40 hover:text-surface-foreground",
			)}
		>
			{active && <span className="absolute top-0 inset-x-0 h-0.5 rounded-t-full bg-primary" />}
			<StatusDot status={tab.status} size={5} />
			{isRenaming ? (
				<input
					autoFocus
					value={renameValue}
					onChange={(e) => onRenameChange?.(e.target.value)}
					onBlur={onRenameSubmit}
					onKeyDown={(e) => {
						if (e.key === "Enter") onRenameSubmit?.();
						if (e.key === "Escape") onRenameCancel?.();
					}}
					onClick={(e) => e.stopPropagation()}
					className="h-5 w-24 rounded border border-primary bg-surface px-1 text-[11px] text-surface-foreground outline-none"
				/>
			) : (
				<span className="max-w-[120px] truncate">{tab.title}</span>
			)}
			<button
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					onClose();
				}}
				className="ml-0.5 text-muted transition-colors hover:text-surface-foreground"
				title={`关闭 ${tab.title}`}
				aria-label="关闭标签"
			>
				<span className="icon-[lucide--x] size-3" />
			</button>
		</div>
	);
}

function MenuHeader({ title, subtitle }: { title: string; subtitle: string }) {
	return (
		<div className="flex items-center gap-2 border-b border-border px-2.5 pt-1 pb-1.5 text-[10px] text-faint">
			<span className="icon-[lucide--square-terminal] size-3 text-muted" />
			<span className="text-muted">{title}</span>
			<span className="truncate font-mono">{subtitle}</span>
		</div>
	);
}

function MenuSeparator() {
	return <div className="my-1 border-t border-border" />;
}

function MenuItem({
	icon,
	label,
	kbd,
	disabled,
	danger,
	onClick,
}: {
	icon: string;
	label: string;
	kbd?: string;
	disabled?: boolean;
	danger?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"group flex h-7.5 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[11.5px] transition-all cursor-pointer select-none",
				disabled && "cursor-not-allowed opacity-40 text-faint",
				!disabled && !danger && "text-surface-foreground hover:bg-primary/15 hover:text-primary font-normal hover:font-medium",
				!disabled && danger && "text-danger hover:bg-danger/15 hover:text-danger font-normal hover:font-medium",
			)}
		>
			<span
				className={cn(
					icon,
					"size-3.5 shrink-0 transition-colors",
					disabled ? "text-faint" : danger ? "text-danger" : "text-muted group-hover:text-primary",
				)}
			/>
			<span className="flex-1 truncate">{label}</span>
			{kbd && <span className="font-mono text-[9.5px] text-faint group-hover:text-primary/80">{kbd}</span>}
		</button>
	);
}

/* ============================ 主机工作台视图 ============================ */

function HostWorkbench({
	onOpenHost,
	onOpenHostInNewTab,
	onSplitWithHost,
	onOpenSftp,
	onOpenForward,
	onHostContextMenu,
	onNewTerminal,
	onAddHost,
	onEditHost,
	hasActiveSessions,
	activeTabCount = 0,
	onReturnToTerminal,
}: {
	onOpenHost: (host: Host) => void;
	onOpenHostInNewTab?: (host: Host) => void;
	onSplitWithHost?: (host: Host, direction: "horizontal" | "vertical") => void;
	onOpenSftp?: (host: Host) => void;
	onOpenForward?: (host: Host) => void;
	onHostContextMenu?: (event: ReactMouseEvent, host: Host) => void;
	onNewTerminal: () => void;
	onAddHost?: (groupId?: string | null) => void;
	onEditHost?: (host: Host) => void;
	hasActiveSessions?: boolean;
	activeTabCount?: number;
	onReturnToTerminal?: () => void;
}) {
	const hostStore = useHostsStore();
	const navigate = useNavigate();
	const [selectedGroup, setSelectedGroup] = useState<string>("all");
	const [searchQuery, setSearchQuery] = useState("");
	const [createGroupModalOpen, setCreateGroupModalOpen] = useState(false);
	const [renameGroupModal, setRenameGroupModal] = useState<{ id: string; name: string } | null>(null);
	const [deleteGroupModal, setDeleteGroupModal] = useState<{ id: string; name: string } | null>(null);
	const [groupNameInput, setGroupNameInput] = useState("");
	const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

	const toggleCollapse = (id: string) => {
		setCollapsedGroups((prev) => ({ ...prev, [id]: !prev[id] }));
	};

	const allHosts = hostStore.hosts;
	const groups = hostStore.groups;

	const searchedHosts = useMemo(() => {
		if (!searchQuery.trim()) return allHosts;
		const q = searchQuery.toLowerCase().trim();
		return allHosts.filter(
			(h) =>
				h.name.toLowerCase().includes(q) ||
				h.hostname.toLowerCase().includes(q) ||
				h.username.toLowerCase().includes(q) ||
				h.tags.some((t) => t.toLowerCase().includes(q)),
		);
	}, [allHosts, searchQuery]);

	const validGroupIds = useMemo(() => new Set(groups.map((g) => g.id)), [groups]);
	const ungroupedHosts = useMemo(() => searchedHosts.filter((h) => !h.groupId || !validGroupIds.has(h.groupId)), [searchedHosts, validGroupIds]);

	const handleOpenSftp = (host: Host) => {
		if (onOpenSftp) {
			onOpenSftp(host);
		} else {
			onOpenHost(host);
			if (!useUiStore.getState().embeddedSftpOpen) {
				useUiStore.getState().toggleEmbeddedSftp();
			}
		}
	};

	const handleCreateGroup = () => {
		const trimmed = groupNameInput.trim();
		if (!trimmed) return;
		const newG = hostStore.addGroup(trimmed);
		toast({ title: `已创建分组「${trimmed}」`, tone: "success" });
		setGroupNameInput("");
		setCreateGroupModalOpen(false);
		setSelectedGroup(newG.id);
	};

	const handleRenameGroup = () => {
		if (!renameGroupModal) return;
		const trimmed = groupNameInput.trim();
		if (!trimmed) return;
		hostStore.renameGroup(renameGroupModal.id, trimmed);
		toast({ title: `分组已重命名为「${trimmed}」`, tone: "success" });
		setGroupNameInput("");
		setRenameGroupModal(null);
	};

	const handleDeleteGroup = () => {
		if (!deleteGroupModal) return;
		hostStore.removeGroup(deleteGroupModal.id);
		toast({ title: `已删除分组「${deleteGroupModal.name}」`, tone: "default" });
		if (selectedGroup === deleteGroupModal.id) {
			setSelectedGroup("all");
		}
		setDeleteGroupModal(null);
	};

	const handleQuickConnect = () => {
		const trimmed = searchQuery.trim();
		if (!trimmed) return;
		const parsed = parseQuickSsh(trimmed);
		if (parsed) {
			const existing = allHosts.find(
				(h) => h.hostname === parsed.hostname && h.username === parsed.username && h.port === parsed.port,
			);
			if (existing) {
				onOpenHost(existing);
				return;
			}
			const tempHost: Host = {
				id: `quick-${Date.now()}`,
				name: `${parsed.username}@${parsed.hostname}`,
				groupId: null,
				hostname: parsed.hostname,
				port: parsed.port,
				username: parsed.username,
				auth: { method: "password" },
				reachable: true,
				favorite: false,
				jumpHostIds: [],
				tags: ["快速连接"],
			};
			useHostsStore.getState().upsertHost(tempHost);
			onOpenHost(tempHost);
			return;
		}
		if (searchedHosts.length > 0) {
			onOpenHost(searchedHosts[0]);
		}
	};

	return (
		<div className="flex h-full w-full flex-col overflow-hidden bg-surface text-surface-foreground select-none">
			{/* 顶栏：工作台标题 + 快捷操作 */}
			<div className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface-sunk/40 px-6">
				<div className="flex items-center gap-3">
					<div className="flex size-8 items-center justify-center rounded-full bg-primary text-white shadow-xs">
						<span className="icon-[lucide--server] size-4" />
					</div>
					<div>
						<h1 className="text-[13.5px] font-bold tracking-tight text-surface-foreground">主机工作台</h1>
						<p className="text-[11px] text-muted">点击或双击主机卡片就地连接终端</p>
					</div>
				</div>

				<div className="flex items-center gap-2">
					{hasActiveSessions && onReturnToTerminal && (
						<Button
							size="sm"
							variant="default"
							icon="icon-[lucide--terminal]"
							onClick={onReturnToTerminal}
							className="h-8 text-xs border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
						>
							返回终端会话 ({activeTabCount})
						</Button>
					)}

					{/* 搜索框 */}
					<div className="relative">
						<span className="icon-[lucide--search] pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted" />
						<input
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleQuickConnect()}
							placeholder="查找主机或 ssh user@host…"
							className="h-8 w-[240px] rounded-full border border-border/80 bg-surface-raised pl-9 pr-3 text-[12px] text-surface-foreground placeholder:text-faint focus:border-primary focus:outline-none transition-all shadow-2xs"
						/>
					</div>

					<Button
						size="sm"
						variant="primary"
						icon="icon-[lucide--play]"
						onClick={handleQuickConnect}
						className="h-8 text-xs shadow-xs"
					>
						快速连接
					</Button>

					<Button
						size="sm"
						variant="default"
						icon="icon-[lucide--square-terminal]"
						onClick={onNewTerminal}
						className="h-8 text-xs"
					>
						新建本地终端
					</Button>

					<Button
						size="sm"
						variant="default"
						icon="icon-[lucide--folder-plus]"
						onClick={() => {
							setGroupNameInput("");
							setCreateGroupModalOpen(true);
						}}
						className="h-8 text-xs cursor-pointer"
					>
						新建分组
					</Button>

					<Button
						size="sm"
						variant="default"
						icon="icon-[lucide--plus]"
						onClick={() => (onAddHost ? onAddHost() : navigate("/hosts/new"))}
						className="h-8 text-xs cursor-pointer"
					>
						添加主机
					</Button>
				</div>
			</div>

			{/* 胶囊过滤芯片 (按组过滤) */}
			<div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-surface-sunk/40 px-6 text-[12px] overflow-x-auto no-scrollbar">
				<button
					type="button"
					onClick={() => setSelectedGroup("all")}
					className={cn(
						"flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-semibold transition-all duration-150 cursor-pointer shrink-0",
						selectedGroup === "all"
							? "bg-primary text-primary-foreground shadow-xs"
							: "border border-border/80 bg-surface text-muted hover:border-border hover:text-surface-foreground hover:bg-surface-raised",
					)}
				>
					<span>全部主机</span>
					<span className={cn("font-mono text-[10.5px]", selectedGroup === "all" ? "text-primary-foreground/80" : "text-faint")}>
						({allHosts.length})
					</span>
				</button>

				{groups.map((group) => {
					const count = allHosts.filter((h) => h.groupId === group.id).length;
					const active = selectedGroup === group.id;
					return (
						<button
							key={group.id}
							type="button"
							onClick={() => setSelectedGroup(group.id)}
							className={cn(
								"flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 cursor-pointer shrink-0",
								active
									? "bg-primary text-primary-foreground font-semibold shadow-xs"
									: "border border-border/80 bg-surface text-muted hover:border-border hover:text-surface-foreground hover:bg-surface-raised",
							)}
						>
							<span className={cn("icon-[lucide--folder] size-3.5", active ? "text-primary-foreground" : "text-amber-500")} />
							<span>{group.name}</span>
							<span className={cn("font-mono text-[10.5px]", active ? "text-primary-foreground/80" : "text-faint")}>
								({count})
							</span>
						</button>
					);
				})}

				{ungroupedHosts.length > 0 && groups.length > 0 && (
					<button
						type="button"
						onClick={() => setSelectedGroup("ungrouped")}
						className={cn(
							"flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 cursor-pointer shrink-0",
							selectedGroup === "ungrouped"
								? "bg-primary text-primary-foreground font-semibold shadow-xs"
								: "border border-border/80 bg-surface text-muted hover:border-border hover:text-surface-foreground hover:bg-surface-raised",
						)}
					>
						<span className="icon-[lucide--layers] size-3.5" />
						<span>未分组</span>
						<span className={cn("font-mono text-[10.5px]", selectedGroup === "ungrouped" ? "text-primary-foreground/80" : "text-faint")}>
							({allHosts.filter((h) => !h.groupId || !validGroupIds.has(h.groupId)).length})
						</span>
					</button>
				)}

				<button
					type="button"
					onClick={() => {
						setGroupNameInput("");
						setCreateGroupModalOpen(true);
					}}
					className="flex items-center gap-1 rounded-full border border-dashed border-border/80 bg-surface px-2.5 py-1 text-xs text-muted hover:border-primary hover:text-primary transition-colors cursor-pointer shrink-0 ml-1"
					title="新建分组"
				>
					<span className="icon-[lucide--plus] size-3" />
					<span>新建组</span>
				</button>
			</div>

			{/* 主内容区域：按组分区渲染 */}
			<div className="min-h-0 flex-1 overflow-y-auto p-6 space-y-6">
				{searchedHosts.length === 0 ? (
					<div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16 text-center">
						<span className="icon-[lucide--server] size-9 text-faint mb-2.5" />
						<p className="text-[13px] font-semibold text-surface-foreground">没有找到匹配的主机</p>
						<p className="mt-1 text-[11.5px] text-muted">点击上方「添加主机」或输入 ssh 连接指令</p>
					</div>
				) : groups.length === 0 ? (
					/* 尚无自定义分组：默认平铺全部主机，并提示可以创建分组 */
					<div>
						<div className="mb-3 flex items-center justify-between">
							<div className="flex items-center gap-2">
								<span className="text-[12.5px] font-bold text-surface-foreground">全部主机</span>
								<span className="rounded-full bg-surface-raised px-2 py-0.5 font-mono text-[10.5px] text-faint border border-border/50">
									{searchedHosts.length} 台
								</span>
							</div>
							<button
								type="button"
								onClick={() => {
									setGroupNameInput("");
									setCreateGroupModalOpen(true);
								}}
								className="flex items-center gap-1 text-[11.5px] font-medium text-primary hover:underline cursor-pointer"
							>
								<span className="icon-[lucide--folder-plus] size-3.5" />
								<span>创建分组进行归类</span>
							</button>
						</div>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
							{searchedHosts.map((host) => (
								<WorkbenchHostCard
									key={host.id}
									host={host}
									onConnect={() => onOpenHost(host)}
									onOpenInNewTab={() => onOpenHostInNewTab?.(host)}
									onSplitWithHost={(dir) => onSplitWithHost?.(host, dir)}
									onOpenSftp={() => handleOpenSftp(host)}
									onOpenForward={() => onOpenForward?.(host)}
									onEdit={() => (onEditHost ? onEditHost(host) : navigate(`/hosts/${host.id}/edit`))}
									onContextMenu={(e) => onHostContextMenu?.(e, host)}
								/>
							))}
						</div>
					</div>
				) : (
					/* 存在分组：按组分区渲染 */
					<>
						{groups
							.filter((g) => selectedGroup === "all" || selectedGroup === g.id)
							.map((group) => {
								const members = searchedHosts.filter((h) => h.groupId === group.id);
								const isCollapsed = Boolean(collapsedGroups[group.id]);

								return (
									<div key={group.id} className="space-y-3">
										{/* 分组头部 */}
										<div className="flex items-center justify-between border-b border-border/60 pb-2">
											<div className="flex items-center gap-2">
												<button
													type="button"
													onClick={() => toggleCollapse(group.id)}
													className="flex size-5 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-surface-foreground transition-colors cursor-pointer"
													title={isCollapsed ? "展开分组" : "折叠分组"}
												>
													<span
														className={cn(
															"size-3.5 transition-transform duration-150",
															isCollapsed ? "icon-[lucide--chevron-right]" : "icon-[lucide--chevron-down]",
														)}
													/>
												</button>
												<span className="icon-[lucide--folder] size-4 text-amber-500" />
												<span className="text-[13px] font-bold text-surface-foreground">
													{group.name}
												</span>
												<span className="rounded-full bg-surface-raised px-2 py-0.5 font-mono text-[10.5px] text-faint border border-border/50">
													{members.length} 台
												</span>
											</div>

											{/* 分组管理快捷按钮 */}
											<div className="flex items-center gap-1">
												<button
													type="button"
													onClick={() => onAddHost?.(group.id)}
													className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-raised hover:text-primary transition-colors cursor-pointer"
													title="在此分组下添加主机"
												>
													<span className="icon-[lucide--plus] size-3" />
													<span>添加主机</span>
												</button>
												<button
													type="button"
													onClick={() => {
														setGroupNameInput(group.name);
														setRenameGroupModal({ id: group.id, name: group.name });
													}}
													className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-surface-foreground transition-colors cursor-pointer"
													title="重命名分组"
												>
													<span className="icon-[lucide--pencil] size-3" />
												</button>
												<button
													type="button"
													onClick={() => setDeleteGroupModal({ id: group.id, name: group.name })}
													className="flex size-6 items-center justify-center rounded text-muted hover:bg-danger/10 hover:text-danger transition-colors cursor-pointer"
													title="删除分组"
												>
													<span className="icon-[lucide--trash-2] size-3" />
												</button>
											</div>
										</div>

										{/* 分组主机卡片网格 */}
										{!isCollapsed && (
											<>
												{members.length === 0 ? (
													<div className="flex items-center justify-between rounded-xl border border-dashed border-border/80 bg-surface-sunk/30 px-4 py-3.5 text-[11.5px] text-muted">
														<div className="flex items-center gap-2">
															<span className="icon-[lucide--folder-open] size-4 text-faint" />
															<span>该分组下暂无主机</span>
														</div>
														<button
															type="button"
															onClick={() => onAddHost?.(group.id)}
															className="flex items-center gap-1 font-medium text-primary hover:underline cursor-pointer"
														>
															<span className="icon-[lucide--plus] size-3.5" />
															<span>添加主机至此组</span>
														</button>
													</div>
												) : (
													<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
														{members.map((host) => (
															<WorkbenchHostCard
																key={host.id}
																host={host}
																onConnect={() => onOpenHost(host)}
																onOpenInNewTab={() => onOpenHostInNewTab?.(host)}
																onSplitWithHost={(dir) => onSplitWithHost?.(host, dir)}
																onOpenSftp={() => handleOpenSftp(host)}
																onOpenForward={() => onOpenForward?.(host)}
																onEdit={() => (onEditHost ? onEditHost(host) : navigate(`/hosts/${host.id}/edit`))}
																onContextMenu={(e) => onHostContextMenu?.(e, host)}
															/>
														))}
													</div>
												)}
											</>
										)}
									</div>
								);
							})}

						{/* 未分组主机 */}
						{(selectedGroup === "all" || selectedGroup === "ungrouped") && ungroupedHosts.length > 0 && (
							<div className="space-y-3 pt-2">
								<div className="flex items-center justify-between border-b border-border/60 pb-2">
									<div className="flex items-center gap-2">
										<button
											type="button"
											onClick={() => toggleCollapse("ungrouped")}
											className="flex size-5 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-surface-foreground transition-colors cursor-pointer"
											title={collapsedGroups["ungrouped"] ? "展开分组" : "折叠分组"}
										>
											<span
												className={cn(
													"size-3.5 transition-transform duration-150",
													collapsedGroups["ungrouped"] ? "icon-[lucide--chevron-right]" : "icon-[lucide--chevron-down]",
												)}
											/>
										</button>
										<span className="icon-[lucide--layers] size-4 text-muted" />
										<span className="text-[13px] font-bold text-surface-foreground">未分组主机</span>
										<span className="rounded-full bg-surface-raised px-2 py-0.5 font-mono text-[10.5px] text-faint border border-border/50">
											{ungroupedHosts.length} 台
										</span>
									</div>

									<button
										type="button"
										onClick={() => onAddHost?.(null)}
										className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-raised hover:text-primary transition-colors cursor-pointer"
									>
										<span className="icon-[lucide--plus] size-3" />
										<span>添加主机</span>
									</button>
								</div>

								{!collapsedGroups["ungrouped"] && (
									<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
										{ungroupedHosts.map((host) => (
											<WorkbenchHostCard
												key={host.id}
												host={host}
												onConnect={() => onOpenHost(host)}
												onOpenInNewTab={() => onOpenHostInNewTab?.(host)}
												onSplitWithHost={(dir) => onSplitWithHost?.(host, dir)}
												onOpenSftp={() => handleOpenSftp(host)}
												onOpenForward={() => onOpenForward?.(host)}
												onEdit={() => (onEditHost ? onEditHost(host) : navigate(`/hosts/${host.id}/edit`))}
												onContextMenu={(e) => onHostContextMenu?.(e, host)}
											/>
										))}
									</div>
								)}
							</div>
						)}
					</>
				)}
			</div>

			{/* 新建分组弹窗 */}
			<Modal
				open={createGroupModalOpen}
				onClose={() => setCreateGroupModalOpen(false)}
				title="新建主机分组"
				footer={
					<div className="flex items-center gap-2">
						<Button size="sm" onClick={() => setCreateGroupModalOpen(false)}>
							取消
						</Button>
						<Button size="sm" variant="primary" onClick={handleCreateGroup}>
							创建
						</Button>
					</div>
				}
			>
				<div className="space-y-3">
					<div className="text-muted">请输入新分组名称（如：生产集群、测试服务器、海外节点）：</div>
					<Input
						autoFocus
						value={groupNameInput}
						onChange={(e) => setGroupNameInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleCreateGroup();
						}}
						placeholder="分组名称..."
					/>
				</div>
			</Modal>

			{/* 重命名分组弹窗 */}
			<Modal
				open={renameGroupModal !== null}
				onClose={() => setRenameGroupModal(null)}
				title="重命名主机分组"
				footer={
					<div className="flex items-center gap-2">
						<Button size="sm" onClick={() => setRenameGroupModal(null)}>
							取消
						</Button>
						<Button size="sm" variant="primary" onClick={handleRenameGroup}>
							保存
						</Button>
					</div>
				}
			>
				<div className="space-y-3">
					<div className="text-muted">修改「{renameGroupModal?.name}」的名称：</div>
					<Input
						autoFocus
						value={groupNameInput}
						onChange={(e) => setGroupNameInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleRenameGroup();
						}}
						placeholder="新分组名称..."
					/>
				</div>
			</Modal>

			{/* 删除分组确认弹窗 */}
			<Modal
				open={deleteGroupModal !== null}
				onClose={() => setDeleteGroupModal(null)}
				title="删除主机分组"
				footer={
					<div className="flex items-center gap-2">
						<Button size="sm" onClick={() => setDeleteGroupModal(null)}>
							取消
						</Button>
						<Button size="sm" variant="danger" onClick={handleDeleteGroup}>
							确认删除
						</Button>
					</div>
				}
			>
				<div className="space-y-2">
					<div className="text-surface-foreground">
						确认删除分组「<span className="font-semibold text-danger">{deleteGroupModal?.name}</span>」吗？
					</div>
					<div className="text-[11px] text-faint">
						删除分组后，该组内的主机将自动移至「未分组」，不会被删除或影响已有会话。
					</div>
				</div>
			</Modal>
		</div>
	);
}

function WorkbenchHostCard({
	host,
	onConnect,
	onOpenInNewTab,
	onSplitWithHost,
	onOpenSftp,
	onOpenForward,
	onEdit,
	onContextMenu,
}: {
	host: Host;
	onConnect: () => void;
	onOpenInNewTab?: () => void;
	onSplitWithHost?: (direction: "horizontal" | "vertical") => void;
	onOpenSftp?: () => void;
	onOpenForward?: () => void;
	onEdit: () => void;
	onContextMenu?: (e: ReactMouseEvent) => void;
}) {
	const status = useHostStatus(host.id, host.reachable);
	const visual = getHostVisual(host);
	const forwardCount = useForwardsStore((s) => s.rules.filter((r) => r.hostId === host.id).length);
	const isConnected = status === "connected";
	const isConnecting = status === "connecting" || status === "reconnecting";

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onConnect}
			onAuxClick={(e) => {
				if (e.button === 1 && onOpenInNewTab) {
					e.preventDefault();
					onOpenInNewTab();
				}
			}}
			onContextMenu={onContextMenu}
			onKeyDown={(e) => e.key === "Enter" && onConnect()}
			className="group relative flex cursor-pointer flex-col justify-between rounded-2xl border border-border/80 bg-surface-raised/70 p-4 transition-all duration-200 hover:-translate-y-1 hover:border-primary hover:bg-surface hover:shadow-host-hover"
		>
			{/* 卡片头部：图标 + 名称 + 状态 + 地址，右上角仅在悬浮时显示极简的 [编辑] 与 [更多] */}
			<div className="flex items-start gap-3 min-w-0">
				<div className="flex size-9.5 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-surface text-muted transition-colors group-hover:border-primary/40 group-hover:text-primary">
					<span className={cn(visual.icon, visual.color, "size-4.5")} />
				</div>
				<div className="min-w-0 flex-1 group-hover:pr-12 transition-all">
					<div className="flex items-center gap-1.5 min-w-0">
						<span className="truncate text-[13px] font-semibold text-surface-foreground group-hover:text-primary transition-colors">
							{host.name}
						</span>
						<StatusDot status={status} size={6} className="shrink-0" />
					</div>
					<div className="mt-1 font-mono text-[11px] text-muted truncate">
						{host.username}@{host.hostname}:{host.port}
					</div>
				</div>

				{/* 右上角快捷操作：极简尺寸（仅编辑与更多菜单），绝不遮挡标题和状态 */}
				<div
					className="absolute top-3 right-3 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
					onClick={(e) => e.stopPropagation()}
				>
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onEdit();
						}}
						className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface hover:text-surface-foreground transition-colors cursor-pointer"
						title="编辑配置"
					>
						<span className="icon-[lucide--pencil] size-3.5" />
					</button>
					{onContextMenu && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onContextMenu(e);
							}}
							className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface hover:text-surface-foreground transition-colors cursor-pointer"
							title="更多选项 (右键菜单)"
						>
							<span className="icon-[lucide--more-horizontal] size-3.5" />
						</button>
					)}
				</div>
			</div>

			{/* 卡片底栏：左侧属性胶囊 + 右侧快速连接与联动动作组 */}
			<div className="mt-4 flex items-center justify-between pt-3 border-t border-border/50 text-[11px]">
				<div className="flex items-center gap-1.5 overflow-hidden">
					{forwardCount > 0 && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onOpenForward?.();
							}}
							className="rounded-full bg-surface px-2.5 py-0.5 font-mono text-[10px] text-primary border border-primary/30 hover:bg-primary/10 transition-colors cursor-pointer"
							title={`查看/配置 ${forwardCount} 条端口转发`}
						>
							{forwardCount} 转发
						</button>
					)}
					{host.latencyMs !== undefined && host.latencyMs > 0 && (
						<span className="rounded-full bg-surface px-2 py-0.5 font-mono text-[10px] text-faint border border-border/60">
							{host.latencyMs}ms
						</span>
					)}
					{host.tags.slice(0, 2).map((tag) => (
						<span key={tag} className="rounded-full bg-surface px-2.5 py-0.5 font-mono text-[10px] text-faint border border-border/60">
							{tag}
						</span>
					))}
					{host.tags.length === 0 && forwardCount === 0 && (!host.latencyMs || host.latencyMs === 0) && (
						<span className="rounded-full bg-surface px-2.5 py-0.5 font-mono text-[10px] text-faint border border-border/60">
							默认
						</span>
					)}
				</div>

				{/* 右侧动作区：悬浮时自然显露 SFTP、分屏、新标签快速操作，右侧为进入/连接主按钮 */}
				<div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
					<div className="hidden group-hover:flex items-center gap-0.5 mr-0.5">
						{onOpenSftp && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									onOpenSftp();
								}}
								className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface hover:text-primary transition-colors cursor-pointer"
								title="打开 SFTP 文件管理"
							>
								<span className="icon-[lucide--folder-tree] size-3.5" />
							</button>
						)}
						{onSplitWithHost && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									onSplitWithHost("horizontal");
								}}
								className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface hover:text-primary transition-colors cursor-pointer"
								title="向右分屏打开终端"
							>
								<span className="icon-[lucide--columns-2] size-3.5" />
							</button>
						)}
						{onOpenInNewTab && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									onOpenInNewTab();
								}}
								className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface hover:text-primary transition-colors cursor-pointer"
								title="在新标签打开终端 (鼠标中键也可触发)"
							>
								<span className="icon-[lucide--plus-square] size-3.5" />
							</button>
						)}
					</div>

					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onConnect();
						}}
						className={cn(
							"flex items-center gap-1 font-medium transition-all cursor-pointer rounded px-1.5 py-0.5",
							isConnected
								? "bg-primary/10 text-primary hover:bg-primary/20"
								: "text-muted hover:text-primary group-hover:translate-x-0.5",
						)}
					>
						<span>{isConnected ? "进入终端" : isConnecting ? "连接中…" : "连接"}</span>
						<span className={cn("size-3.5", isConnected ? "icon-[lucide--terminal]" : "icon-[lucide--arrow-right]")} />
					</button>
				</div>
			</div>
		</div>
	);
}

function parseQuickSsh(input: string): { username: string; hostname: string; port: number } | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	let str = trimmed;
	if (str.startsWith("ssh ")) str = str.slice(4).trim();
	let port = 22;
	const portMatch = str.match(/-p\s+(\d+)/);
	if (portMatch) {
		port = parseInt(portMatch[1], 10) || 22;
		str = str.replace(/-p\s+\d+/, "").trim();
	}
	if (str.includes("@")) {
		const [username, rest] = str.split("@");
		const [hostname, p] = (rest || "").split(":");
		return { username: username || "root", hostname: hostname || "localhost", port: p ? parseInt(p, 10) : port };
	}
	return null;
}

