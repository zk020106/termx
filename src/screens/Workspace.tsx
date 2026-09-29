import { WindowChrome } from "@/components/chrome/WindowChrome";
import { type TerminalHandle, type TerminalMatchInfo } from "@/components/terminal/Terminal";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { Button, IconButton, Kbd } from "@/components/ui/Button";
import { EmptyState, EnvPill, EnvStripe, MetricBar, StatusDot } from "@/components/ui/Display";
import {
	ENV_NAME,
	type ConnectionStatus,
	type Host,
	type SessionTab,
	type SplitLayout,
	type TerminalPane as TerminalPaneModel,
} from "@/data/types";
import { cn } from "@/lib/cn";
import { describeProbe, probeSupported } from "@/lib/probe";
import { filterHosts, useHostsStore } from "@/store/hosts";
import { useProbeStore } from "@/store/probe";
import { paneCountFor, useSessionsStore } from "@/store/sessions";
import { toast } from "@/store/toast";
import { useUiStore } from "@/store/ui";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link, useNavigate } from "react-router";

/* =============================================================================
 * 终端工作区（路由 /） —— 设计帧 termx.vetd/frames/index.tsx 的交互版。
 *
 * 布局逐帧复刻：左侧主机库 220px · 标签栏 34px · 分屏网格 + 底部 SFTP 面板 150px
 * · 右侧主机监控 200px。终端本体见 @/components/terminal/Terminal。
 *
 * 只呈现真实数据：标签 / 分屏 / 焦点 / 广播来自 useSessionsStore（首次启动为空，
 * 此时给出「去主机库」的空状态），主机来自 useHostsStore，监控面板只显示
 * useProbeStore 的实测 TCP 结果 —— 没有结果就写「未接入」，不填任何假数字。
 * 右上角的「状态」切换器是骨架期评审工具，逐个复现需求书 06-终端工作区要求的状态：
 * 单屏 / 2 格 / 4 格、搜索栏、右键菜单、广播中、重连宽限期横幅、已断开覆盖层、生产环境三重标识。
 * ========================================================================== */

type ReviewState = "split-1" | "split-2" | "split-4" | "search" | "menu" | "broadcast" | "reconnect" | "offline" | "prod";

const REVIEW_STATES: { value: ReviewState; label: string; title: string }[] = [
	{ value: "split-1", label: "单屏", title: "单屏（1 格）" },
	{ value: "split-2", label: "2 格", title: "水平 2 格分屏（设计帧基准态）" },
	{ value: "split-4", label: "4 格", title: "2×2 四格分屏" },
	{ value: "search", label: "搜索", title: "终端搜索栏（Ctrl Shift F，带结果计数与上一个 / 下一个）" },
	{ value: "menu", label: "菜单", title: "终端右键菜单（复制 / 粘贴 / 分屏 / 清屏 / 保存屏幕内容）" },
	{ value: "broadcast", label: "广播", title: "广播输入到全部终端（被广播的终端有明显标识）" },
	{ value: "reconnect", label: "重连", title: "断线重连宽限期：顶部横幅 + 立即重连 / 关闭" },
	{ value: "offline", label: "断开", title: "已断开覆盖层：终端变灰，按回车重新连接" },
	{ value: "prod", label: "生产", title: "生产环境：标签红色色条 + 终端区 2px 红描边 + 状态栏 PROD" },
];

/** 分屏数 → 网格模板（SFTP 面板占满一行，收起时少一行） */
const GRID_CLASS: Record<SplitLayout, { sftp: string; bare: string }> = {
	single: { sftp: "grid-cols-1 grid-rows-[1fr_150px]", bare: "grid-cols-1 grid-rows-1" },
	horizontal: { sftp: "grid-cols-2 grid-rows-[1fr_150px]", bare: "grid-cols-2 grid-rows-1" },
	vertical: { sftp: "grid-cols-1 grid-rows-[1fr_1fr_150px]", bare: "grid-cols-1 grid-rows-2" },
	grid: { sftp: "grid-cols-2 grid-rows-[1fr_1fr_150px]", bare: "grid-cols-2 grid-rows-2" },
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
	canCopy: boolean;
}

export default function Workspace() {
	const tabs = useSessionsStore((s) => s.tabs);
	const panes = useSessionsStore((s) => s.panes);
	const activeTabId = useSessionsStore((s) => s.activeTabId);
	const focusedPaneId = useSessionsStore((s) => s.focusedPaneId);
	const setActiveTab = useSessionsStore((s) => s.setActiveTab);
	const setLayout = useSessionsStore((s) => s.setLayout);
	const focusPane = useSessionsStore((s) => s.focusPane);
	const toggleBroadcast = useSessionsStore((s) => s.toggleBroadcast);
	const closeTab = useSessionsStore((s) => s.closeTab);
	const reopenTab = useSessionsStore((s) => s.reopenTab);
	const openSession = useSessionsStore((s) => s.openSession);

	const hostStore = useHostsStore();
	const probeStore = useProbeStore();
	const navigate = useNavigate();
	const embeddedSftpOpen = useUiStore((s) => s.embeddedSftpOpen);
	const toggleEmbeddedSftp = useUiStore((s) => s.toggleEmbeddedSftp);

	const [review, setReview] = useState<ReviewState>("split-2");
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [match, setMatch] = useState<TerminalMatchInfo>({ index: -1, count: 0 });
	const [menu, setMenu] = useState<MenuState | null>(null);
	const [grace, setGrace] = useState(18);

	const sectionRef = useRef<HTMLElement | null>(null);
	const hostSearchRef = useRef<HTMLInputElement | null>(null);
	const terminals = useRef(new Map<string, TerminalHandle>());

	const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
	const activeHost = hostStore.hosts.find((h) => h.id === activeTab?.hostId) ?? null;
	const gridPanes = activeTab ? panesForTab(activeTab, panes) : [];
	const focusId = gridPanes.some((p) => p.id === focusedPaneId) ? focusedPaneId : (gridPanes[0]?.id ?? "");
	const broadcasting = Boolean(activeTab?.broadcasting);
	const prodGuard = review === "prod" && activeTab?.env === "prod";
	const paneStatus: ConnectionStatus =
		review === "offline" ? "disconnected" : review === "reconnect" ? "reconnecting" : (activeTab?.status ?? "idle");

	const visibleHosts = filterHosts(hostStore);
	const recentHosts = [...hostStore.hosts]
		.filter((h) => h.lastConnectedAt)
		.sort((a, b) => (b.lastConnectedAt ?? "").localeCompare(a.lastConnectedAt ?? ""))
		.slice(0, 2);
	/** 不属于任何现有分组的主机（新建主机的默认状态就是没有分组） */
	const groupedIds = new Set(hostStore.groups.map((g) => g.id));
	const ungroupedHosts = hostStore.hosts.filter((h) => !h.groupId || !groupedIds.has(h.groupId));

	/** 监控面板唯一的数据源：本机对该主机的实测 TCP 结果（没有就是没有） */
	const monitorReport = activeHost ? probeStore.results[activeHost.id] : undefined;
	const probingActiveHost = activeHost ? probeStore.probing.includes(activeHost.id) : false;

	const runProbe = async () => {
		if (!activeHost) return;
		if (!probeSupported()) {
			toast({ title: "浏览器内无法测速", description: "TCP 探测走 Rust 端，请在桌面端运行 pnpm tauri:dev", tone: "warning" });
			return;
		}
		const summary = await probeStore.run([{ id: activeHost.id, host: activeHost.hostname, port: activeHost.port }]);
		if (!summary) {
			toast({ title: "测速没有返回结果", description: "探测被中断，请稍后重试", tone: "danger" });
			return;
		}
		toast({
			title: summary.ok > 0 ? "TCP 可达" : "TCP 不可达",
			description: `${activeHost.hostname}:${activeHost.port} · 这不代表 SSH 一定可用`,
			tone: summary.ok > 0 ? "success" : "danger",
		});
	};

	/** 终端实例的命令式句柄登记表：右键菜单 / 搜索栏 / 快捷键都从这里取 */
	const registerTerminal = useCallback((paneId: string, handle: TerminalHandle | null) => {
		if (handle) terminals.current.set(paneId, handle);
		else terminals.current.delete(paneId);
	}, []);
	const handleFor = (paneId: string) => terminals.current.get(paneId) ?? null;

	/* --------------------------- 评审状态切换 --------------------------- */

	const applyReview = useCallback((next: ReviewState) => {
		const store = useSessionsStore.getState();
		// 上一次状态留下的开关先收干净
		store.tabs.filter((t) => t.broadcasting).forEach((t) => store.toggleBroadcast(t.id));
		setMenu(next === "menu" ? { x: 96, y: 96, canCopy: false } : null);
		setSearchOpen(next === "search");
		setQuery(next === "search" ? "redis" : "");
		setReview(next);

		// 评审状态只切换真实会话的布局；没有会话时什么都不做（界面会走空状态）
		const primary = store.tabs[0];
		const stage = store.tabs[1] ?? primary;

		if (next === "reconnect" || next === "offline") {
			setGrace(18);
			if (stage) {
				store.setActiveTab(stage.id);
				store.setLayout(stage.id, "single");
			}
			return;
		}
		if (!primary) return;
		store.setActiveTab(primary.id);
		if (next === "split-1") store.setLayout(primary.id, "single");
		if (next === "split-2" || next === "search" || next === "menu" || next === "prod") store.setLayout(primary.id, "horizontal");
		if (next === "split-4") store.setLayout(primary.id, "grid");
		if (next === "broadcast") {
			store.setLayout(primary.id, "horizontal");
			const fresh = useSessionsStore.getState().tabs.find((t) => t.id === primary.id);
			if (fresh && !fresh.broadcasting) store.toggleBroadcast(primary.id);
		}
		const owned = useSessionsStore.getState().panes.find((p) => p.hostId === primary.hostId);
		if (owned) store.focusPane(owned.id);
	}, []);

	// 重连宽限期：每秒递减，归零即视为重连成功
	useEffect(() => {
		if (review !== "reconnect") return;
		if (grace <= 0) {
			applyReview("split-2");
			toast({ title: "重连宽限期结束", description: "评审状态演示：真实重连由会话层决定", tone: "default" });
			return;
		}
		const timer = window.setTimeout(() => setGrace((value) => value - 1), 1000);
		return () => window.clearTimeout(timer);
	}, [review, grace, applyReview]);

	const closeMenu = () => {
		setMenu(null);
		setReview((value) => (value === "menu" ? "split-2" : value));
	};

	const closeSearch = () => {
		setSearchOpen(false);
		setQuery("");
		setReview((value) => (value === "search" ? "split-2" : value));
	};

	const splitRight = () => {
		if (!activeTab) return;
		const next: SplitLayout =
			activeTab.layout === "single" ? "horizontal" : activeTab.layout === "horizontal" ? "grid" : activeTab.layout;
		if (next === activeTab.layout) {
			toast({ title: "已经是 4 格分屏", description: "需求书限定最多 4 格", tone: "warning" });
			return;
		}
		setLayout(activeTab.id, next);
		toast({ title: next === "grid" ? "已分成 4 格" : "已向右分屏", tone: "default" });
	};

	const openMenuAt = (event: ReactMouseEvent<HTMLDivElement>, paneId: string) => {
		event.preventDefault();
		if (!terminals.current.has(paneId)) return;
		focusPane(paneId);
		const rect = sectionRef.current?.getBoundingClientRect();
		const rawX = rect ? event.clientX - rect.left : event.clientX;
		const rawY = rect ? event.clientY - rect.top : event.clientY;
		const width = rect?.width ?? 640;
		const height = rect?.height ?? 480;
		setMenu({
			x: Math.max(4, Math.min(rawX, width - 208)),
			y: Math.max(4, Math.min(rawY, height - 196)),
			canCopy: (handleFor(paneId)?.getSelection() ?? "").length > 0,
		});
	};

	const reconnectNow = () => {
		applyReview("split-2");
		toast({ title: "已离开重连宽限期", description: "评审状态演示：会话是否恢复由真实存储层决定", tone: "default" });
	};

	const startReconnect = () => {
		if (!activeTab) return;
		applyReview("reconnect");
		toast({ title: "重连宽限期", description: "评审状态演示：终端内容保留与否由真实会话决定", tone: "warning" });
	};

	const dropToOffline = () => {
		applyReview("offline");
		toast({ title: "已断开覆盖层", description: "评审状态演示：真实连接状态由会话层决定", tone: "danger" });
	};

	const toggleBroadcastNow = () => {
		if (!activeTab) return;
		toggleBroadcast(activeTab.id);
		setReview((value) => (value === "broadcast" ? "split-2" : "broadcast"));
	};

	/* ------------------------------ 搜索栏 ------------------------------ */

	useEffect(() => {
		if (!searchOpen) {
			terminals.current.forEach((handle) => handle.endSearch());
			return;
		}
		const handle = terminals.current.get(focusId);
		setMatch(handle ? handle.search(query) : { index: -1, count: 0 });
	}, [searchOpen, query, focusId, activeTabId, review]);

	/* ---------------------------- 全局快捷键 ---------------------------- */

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const key = event.key.toLowerCase();
			if (event.key === "Escape") {
				if (menu) closeMenu();
				else if (searchOpen) closeSearch();
				return;
			}
			if (!(event.ctrlKey || event.metaKey)) {
				if (event.key === "Enter" && review === "offline") {
					event.preventDefault();
					startReconnect();
				}
				return;
			}
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
	}, [menu, searchOpen, review, focusId, activeTab, applyReview]);

	/* ------------------------------ 交互动作 ---------------------------- */

	const onCloseTab = (tab: SessionTab) => {
		closeTab(tab.id);
		toast({
			title: `已关闭 ${tab.title}`,
			description: ENV_NAME[tab.env],
			tone: "default",
			action: { label: "撤销", run: () => reopenTab(tab) },
		});
	};

	const onNewTab = () => {
		const id = `tab-local-${Date.now()}`;
		reopenTab({
			id,
			hostId: null,
			title: "本地终端",
			env: "dev",
			status: "connected",
			layout: "single",
			broadcasting: false,
		});
		setActiveTab(id);
	};

	const onOpenHost = (host: Host) => {
		const tabId = openSession(host.id);
		setActiveTab(tabId);
		const owned = useSessionsStore.getState().panes.find((p) => p.hostId === host.id);
		if (owned) focusPane(owned.id);
	};

	const copySelection = async () => {
		const handle = handleFor(focusId);
		const ok = handle ? await handle.copySelection() : false;
		closeMenu();
		toast(
			ok
				? { title: "已复制终端选区", tone: "success" }
				: { title: "没有可复制的内容", description: "先在终端里拖选一段文本", tone: "warning" },
		);
	};

	const pasteIntoTerminal = async () => {
		const handle = handleFor(focusId);
		const ok = handle ? await handle.paste() : false;
		closeMenu();
		toast(
			ok
				? { title: "已粘贴到终端", tone: "success" }
				: { title: "没有可粘贴的终端", description: "剪贴板为空，或当前这格没有真实 PTY 会话", tone: "warning" },
		);
	};

	const clearScreen = () => {
		handleFor(focusId)?.clear();
		closeMenu();
		toast({ title: "已清屏", description: "滚动缓冲已清空", tone: "default" });
	};

	const saveScreen = () => {
		handleFor(focusId)?.saveScreen();
		closeMenu();
		toast({ title: "已保存屏幕内容", description: "下载为 .txt 文本", tone: "success" });
	};

	const splitFromMenu = () => {
		closeMenu();
		splitRight();
	};

	/* ------------------------------- 渲染 ------------------------------- */

	const gridClass = activeTab ? (embeddedSftpOpen ? GRID_CLASS[activeTab.layout].sftp : GRID_CLASS[activeTab.layout].bare) : GRID_CLASS.single.bare;
	const layoutChip = LAYOUT_CHIP[activeTab?.layout ?? "single"];
	const activeHostLabel = activeHost ? `${activeHost.username}@${activeHost.name}` : "本地终端";

	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1">
				{/* 左侧主机侧边栏：Linear 紧凑分组列表 (220px) */}
				<aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-surface-sunk">
					<div className="flex h-9 items-center justify-between border-b border-border px-3">
						<span className="text-[12px] font-medium tracking-tight text-surface-foreground">主机库</span>
						<Link to="/hosts" className="text-[11px] text-muted hover:text-surface-foreground">
							全部主机 &gt;
						</Link>
					</div>

					<div className="p-2">
						<div className="relative">
							<span className="icon-[lucide--search] pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted" />
							<input
								ref={hostSearchRef}
								value={hostStore.query}
								onChange={(event) => hostStore.setQuery(event.target.value)}
								placeholder="搜索主机…"
								className="h-7 w-full rounded border border-border bg-surface pr-11 pl-7 font-sans text-[11px] text-surface-foreground transition-colors placeholder:text-faint focus:border-primary focus:outline-none"
							/>
							<kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 font-mono text-[9px] text-muted">
								Ctrl P
							</kbd>
						</div>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
						{hostStore.query ? (
							<>
								<GroupLabel label={`搜索结果 · ${visibleHosts.length}`} />
								{visibleHosts.length === 0 ? (
									<div className="px-2 py-3 text-[11px] text-faint">没有匹配的主机</div>
								) : (
									visibleHosts.map((host) => (
										<HostItem
											key={host.id}
											host={host}
											selected={host.id === activeTab?.hostId}
											onOpen={() => onOpenHost(host)}
										/>
									))
								)}
							</>
						) : (
							<>
								{recentHosts.length > 0 && <GroupLabel label="最近连接" />}
								{recentHosts.map((host) => (
									<HostItem
										key={`recent-${host.id}`}
										host={host}
										selected={host.id === activeTab?.hostId}
										onOpen={() => onOpenHost(host)}
									/>
								))}

								{hostStore.groups.map((group) => {
									const members = hostStore.hosts.filter((h) => h.groupId === group.id);
									if (members.length === 0) return null;
									return (
										<div key={group.id}>
											<GroupLabel label={group.name} />
											{members.map((host) => (
												<HostItem
													key={host.id}
													host={host}
													selected={host.id === activeTab?.hostId}
													onOpen={() => onOpenHost(host)}
												/>
											))}
										</div>
									);
								})}

								{/* 没有分组的主机也必须列出来，否则新建的主机在工作区里会凭空消失 */}
								{ungroupedHosts.length > 0 && (
									<div>
										<GroupLabel label="未分组" />
										{ungroupedHosts.map((host) => (
											<HostItem
												key={host.id}
												host={host}
												selected={host.id === activeTab?.hostId}
												onOpen={() => onOpenHost(host)}
											/>
										))}
									</div>
								)}

								{hostStore.hosts.length === 0 && (
									<div className="px-2 py-3 text-[11px] leading-4 text-faint">
										主机库还是空的。去
										<Link to="/hosts" className="mx-0.5 text-primary hover:underline">
											主机库
										</Link>
										新建或导入主机，它们会出现在这里。
									</div>
								)}
							</>
						)}
					</div>
				</aside>

				{/* 终端主工作区 */}
				<section ref={sectionRef} className="relative flex min-w-0 flex-1 flex-col bg-surface">
					{/* 标签栏：高 34px，环境色条 + 状态点 + 新建标签，右侧是布局 / 评审状态 */}
					<div className="flex h-8.5 items-end gap-1 border-b border-border bg-surface-sunk px-2">
						{tabs.map((tab) => (
							<TabItem
								key={tab.id}
								tab={tab}
								active={tab.id === activeTab?.id}
								onSelect={() => setActiveTab(tab.id)}
								onClose={() => onCloseTab(tab)}
							/>
						))}

						<button
							type="button"
							onClick={onNewTab}
							className="mb-1 ml-1 flex size-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface-raised hover:text-surface-foreground"
							title="新建本地终端"
							aria-label="新建标签"
						>
							<span className="icon-[lucide--plus] size-3.5" />
						</button>

						<div className="mb-1 ml-auto flex items-center gap-2 text-[11px] text-muted">
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

							{!embeddedSftpOpen && (
								<IconButton
									icon="icon-[lucide--folder-tree]"
									label="显示 SFTP 面板 (Ctrl Shift S)"
									className="size-5.5"
									onClick={toggleEmbeddedSftp}
								/>
							)}

							<span className="flex items-center gap-1 rounded border border-border bg-surface-raised px-1.5 py-0.5 font-mono text-[10px]">
								<span className={cn(layoutChip.icon, "size-3 text-primary")} />
								{layoutChip.label}
							</span>

							<ReviewSwitcher value={review} onChange={applyReview} />
						</div>
					</div>

					{/* 断线重连宽限期横幅：终端内容保留，可立即重连或关闭 */}
					{review === "reconnect" && (
						<div className="flex h-8 shrink-0 items-center gap-2 border-b border-warning/40 bg-warning-soft px-3 text-[11.5px]">
							<span className="icon-[lucide--refresh-cw] size-3.5 shrink-0 animate-spin text-warning" />
							<span className="text-surface-foreground">
								连接已中断，正在重连（剩 <span className="font-mono tabular-nums">{grace}</span> 秒）
							</span>
							<span className="text-faint">{activeHostLabel} · 评审状态演示：重连宽限期</span>
							<div className="ml-auto flex items-center gap-1.5">
								<Button size="sm" variant="primary" icon="icon-[lucide--zap]" onClick={reconnectNow}>
									立即重连
								</Button>
								<Button size="sm" variant="ghost" onClick={dropToOffline}>
									关闭
								</Button>
							</div>
						</div>
					)}

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

					{/* 没有会话时不留白、也不造假终端：说清怎么才能有会话 */}
					{!activeTab ? (
						<EmptyState
							className="min-h-0 flex-1"
							icon="icon-[lucide--square-terminal]"
							title="还没有打开的会话"
							description="TermX 不会凭空造出终端。去主机库挑一台主机，点开就会建立真实会话；标签栏的 + 可以起一个本地终端。"
							action={
								<Button variant="primary" icon="icon-[lucide--server]" onClick={() => navigate("/hosts")}>
									去主机库
								</Button>
							}
						/>
					) : (
						/* 分屏网格 + 底部 SFTP 面板；生产环境下整片终端区 2px 红描边 */
						<div
							className={cn(
								"grid min-h-0 flex-1 gap-px bg-border",
								gridClass,
								prodGuard && "shadow-[inset_0_0_0_2px_var(--color-env-prod)]",
							)}
						>
							{gridPanes.map((pane) => (
								<TerminalPane
									key={pane.id}
									pane={pane}
									focused={pane.id === focusId}
									broadcasting={broadcasting}
									offline={review === "offline"}
									prod={prodGuard}
									status={paneStatus}
									registerTerminal={registerTerminal}
									onFocus={() => focusPane(pane.id)}
									onContextMenu={(event) => openMenuAt(event, pane.id)}
									onReconnect={startReconnect}
								/>
							))}

							{embeddedSftpOpen && (
								<div className="col-span-full flex min-h-0 flex-col bg-surface">
									<div className="flex h-7 shrink-0 items-center justify-between border-b border-border bg-surface-raised px-3 text-[11px]">
										<div className="flex items-center gap-2 font-mono">
											<span className="icon-[lucide--folder] size-3.5 text-primary" />
											<span className="text-surface-foreground">{activeHostLabel}</span>
											<span className="text-border">·</span>
											<span className="font-sans text-faint">远程目录未知</span>
										</div>
										<div className="flex items-center gap-3 text-muted">
											<span>SFTP 尚未接入</span>
											<Link to="/sftp" className="flex items-center gap-1 text-primary hover:underline">
												<span>展开双栏模式</span>
												<span className="icon-[lucide--external-link] size-3" />
											</Link>
											<IconButton
												icon="icon-[lucide--chevron-down]"
												label="收起 SFTP 面板 (Ctrl Shift S)"
												className="size-5"
												onClick={toggleEmbeddedSftp}
											/>
										</div>
									</div>

									<EmptyState
										className="min-h-0 flex-1"
										icon="icon-[lucide--folder-x]"
										title="SFTP 面板还没有数据"
										description="列目录与传输文件需要 SSH/SFTP 通道；会话层接入后，这里显示的就是主机上的真实文件。"
									/>
								</div>
							)}
						</div>
					)}

					{/* 终端右键菜单：复制 / 粘贴 / 分屏 / 清屏 / 保存屏幕内容 */}
					{menu && (
						<>
							<div
								className="absolute inset-0 z-40"
								onMouseDown={closeMenu}
								onContextMenu={(event) => {
									event.preventDefault();
									closeMenu();
								}}
							/>
							<div
								className="absolute z-50 w-[200px] rounded-card border border-border bg-surface-raised py-1 shadow-xl shadow-black/30"
								style={{ left: menu.x, top: menu.y }}
							>
								<MenuHeader title="终端" subtitle={activeHost?.name ?? "本地终端"} />
								<MenuItem icon="icon-[lucide--copy]" label="复制" kbd="Ctrl Shift C" disabled={!menu.canCopy} onClick={() => void copySelection()} />
								<MenuItem icon="icon-[lucide--clipboard-paste]" label="粘贴" kbd="Ctrl Shift V" onClick={() => void pasteIntoTerminal()} />
								<MenuSeparator />
								<MenuItem icon="icon-[lucide--columns-2]" label="分屏" kbd="Ctrl Shift D" onClick={splitFromMenu} />
								<MenuItem icon="icon-[lucide--eraser]" label="清屏" kbd="Ctrl L" onClick={clearScreen} />
								<MenuItem icon="icon-[lucide--download]" label="保存屏幕内容…" onClick={saveScreen} />
							</div>
						</>
					)}
				</section>

				{/* 右侧工具抽屉：主机实时遥测指标 (200px) */}
				<aside className="flex w-[200px] shrink-0 flex-col border-l border-border bg-surface-sunk p-3">
					<div className="flex items-center justify-between border-b border-border pb-2">
						<span className="text-[12px] font-semibold text-surface-foreground">主机监控</span>
						<Link to="/monitor" className="font-sans text-[11px] text-primary hover:underline">
							详情
						</Link>
					</div>

					{/* 只有实测 TCP 结果才算数据；系统指标没有来源，一律写「未接入」 */}
					{monitorReport ? (
						<div className="mt-2.5 space-y-3">
							<MetricBar
								label="TCP 延迟（实测）"
								value={`${Math.round(monitorReport.avg_ms)} ms`}
								progress={Math.min(100, (monitorReport.avg_ms / 300) * 100)}
								warn={!monitorReport.reachable || monitorReport.avg_ms > 150}
							/>
							<div className="space-y-1 font-mono text-[10.5px] text-muted">
								<div className="flex justify-between">
									<span className="text-faint">最低 / 最高</span>
									<span className="tabular-nums">
										{Math.round(monitorReport.min_ms)} / {Math.round(monitorReport.max_ms)} ms
									</span>
								</div>
								<div className="flex justify-between">
									<span className="text-faint">抖动</span>
									<span className="tabular-nums">±{monitorReport.jitter_ms.toFixed(1)} ms</span>
								</div>
								<div className="flex justify-between">
									<span className="text-faint">丢包</span>
									<span className="tabular-nums">{Math.round(monitorReport.loss * 100)}%</span>
								</div>
							</div>
							<div className="text-[10.5px] leading-4 text-faint">{describeProbe(monitorReport)}</div>
						</div>
					) : (
						<div className="mt-2.5 rounded border border-border bg-surface-raised p-2.5">
							<div className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
								<span className="icon-[lucide--plug-zap] size-3.5 text-faint" />
								未接入
							</div>
							<p className="mt-1 text-[10.5px] leading-4 text-faint">
								CPU、内存、磁盘等系统指标需要 SSH 会话建立后才能采集，当前没有数据源。
							</p>
						</div>
					)}

					{activeHost && (
						<Button
							className="mt-2"
							size="sm"
							variant="ghost"
							icon="icon-[lucide--gauge]"
							disabled={probingActiveHost}
							onClick={() => void runProbe()}
						>
							{probingActiveHost ? "正在测速…" : "测一次 TCP 延迟"}
						</Button>
					)}

					<div className="mt-auto rounded border border-border bg-surface-raised p-2 font-mono text-[10px] text-muted">
						<div className="flex justify-between">
							<span className="text-faint">远端系统</span>
							<span>未接入</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span className="text-faint">运行时间</span>
							<span>未接入</span>
						</div>
					</div>
				</aside>
			</div>
		</WindowChrome>
	);
}

/* ============================== 局部零件 ============================== */

/** 分屏格：优先取本标签主机名下的真实分屏；布局要求更多格时补出空位（不编造提示符文案） */
function panesForTab(tab: SessionTab, panes: TerminalPaneModel[]): TerminalPaneModel[] {
	const count = paneCountFor(tab.layout);
	const owned = panes.filter((p) => p.hostId === tab.hostId);
	const list = owned.slice(0, count);
	while (list.length < count) {
		list.push({
			id: `${tab.id}-split-${list.length}`,
			hostId: tab.hostId,
			title: "",
			status: tab.status,
			lines: [],
		});
	}
	return list;
}

function GroupLabel({ label }: { label: string }) {
	return <div className="mt-2 mb-1 px-2 text-[10px] font-medium tracking-wider text-faint uppercase">{label}</div>;
}

function HostItem({ host, selected, onOpen }: { host: Host; selected: boolean; onOpen: () => void }) {
	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onOpen}
			onKeyDown={(event) => event.key === "Enter" && onOpen()}
			className={cn(
				"group flex h-7 cursor-pointer items-center gap-2 rounded px-2 text-[12px] transition-colors",
				selected
					? "border border-border bg-surface-raised font-medium text-surface-foreground"
					: "text-muted hover:bg-surface hover:text-surface-foreground",
			)}
		>
			<span
				className={cn("size-1.5 shrink-0 rounded-full", host.reachable ? "bg-success" : "bg-border")}
				title={host.reachable ? "在线" : "离线"}
			/>
			<span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{host.name}</span>
			{host.env === "prod" && <span className="size-1 shrink-0 rounded-full bg-env-prod" title="生产环境" />}
		</div>
	);
}

function TabItem({
	tab,
	active,
	onSelect,
	onClose,
}: {
	tab: SessionTab;
	active: boolean;
	onSelect: () => void;
	onClose: () => void;
}) {
	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onSelect}
			onKeyDown={(event) => event.key === "Enter" && onSelect()}
			className={cn(
				"flex h-7.5 cursor-pointer items-center gap-1.5 rounded-t border-x border-t px-2 text-[12px] transition-colors",
				active
					? "border-border bg-term font-medium text-surface-foreground shadow-sm"
					: "border-transparent bg-transparent text-muted hover:bg-surface-raised/40 hover:text-surface-foreground",
			)}
		>
			{/* 环境色条：生产红、预发橙、测试绿、开发灰（需求书 03-5） */}
			<EnvStripe env={tab.env} />
			<StatusDot status={tab.status} size={5} />
			<span className="max-w-[120px] truncate">{tab.title}</span>
			{tab.env === "prod" && <EnvPill env="prod" size="xs" />}
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
	onClick,
}: {
	icon: string;
	label: string;
	kbd?: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"flex h-6.5 w-full items-center gap-2 px-2.5 text-left text-[11.5px] transition-colors",
				disabled ? "cursor-not-allowed text-faint" : "text-surface-foreground hover:bg-surface-sunk",
			)}
		>
			<span className={cn(icon, "size-3.5 shrink-0", disabled ? "text-faint" : "text-muted")} />
			<span className="flex-1 truncate">{label}</span>
			{kbd && <span className="font-mono text-[9.5px] text-faint">{kbd}</span>}
		</button>
	);
}

/** 评审状态切换器（骨架期工具）：一组小按钮，标注「状态」 */
function ReviewSwitcher({ value, onChange }: { value: ReviewState; onChange: (next: ReviewState) => void }) {
	return (
		<div className="flex items-center gap-1">
			<span className="text-[10px] font-medium tracking-wider text-faint uppercase">状态</span>
			<div className="flex items-center gap-0.5 rounded-control border border-border bg-surface-sunk p-0.5">
				{REVIEW_STATES.map((state) => (
					<button
						key={state.value}
						type="button"
						title={state.title}
						onClick={() => onChange(state.value)}
						className={cn(
							"h-5 rounded-[4px] px-1.5 text-[10.5px] transition-colors",
							value === state.value
								? "bg-surface-raised font-medium text-surface-foreground shadow-sm"
								: "text-muted hover:text-surface-foreground",
						)}
					>
						{state.label}
					</button>
				))}
			</div>
		</div>
	);
}
