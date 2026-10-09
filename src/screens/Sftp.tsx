import { WindowChrome } from "@/components/chrome/WindowChrome";
import { IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Display";
import { ContextMenu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { SftpPane, type SftpPaneConn, type SftpPaneHandle } from "@/components/sftp/SftpPane";
import { SftpTabBar, type SftpTabInfo } from "@/components/sftp/SftpTabBar";
import { cn } from "@/lib/cn";
import {
	canDuplicateSftpTab,
	getSftpTabDuplicateRequest,
	reorderTabs,
	type SftpPaneConnectionInfo,
	type SftpTabDuplicateMode,
} from "@/lib/sftpColumns";
import { transferEntries } from "@/lib/sftpOps";
import { useHostsStore } from "@/store/hosts";
import { useSessionsStore } from "@/store/sessions";
import { useSettingsStore } from "@/store/settings";
import { toast } from "@/store/toast";
import { transferSummary, useTransfersStore } from "@/store/transfers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

/* =============================================================================
 * SFTP 双栏文件管理器 —— 对齐 Netcatty SftpView：左右两栏各有一排标签（SftpTabBar），
 * 每个标签可以是本地文件系统或任意一台主机；标签可新建 / 关闭 / 拖动排序 / 拖到另一侧，
 * 右键「复制标签页（默认路径）」「复制并跳转到当前路径」。
 *
 * termx 的 SFTP 挂在 SSH 会话上（会话键）：远程标签绑定一个已连接的会话；
 * 选择未连接的主机时先发起连接（打开终端标签），连上后标签自动挂上去。
 * 复制远程标签复用同一条会话的 SFTP（Netcatty 会另开一条连接，见对齐文档）。
 * ========================================================================== */

type TabConn = { kind: "local" } | { kind: "remote"; hostId: string; sessionKey: string | null };
interface PaneTab {
	id: string;
	conn: TabConn;
	initialPath?: string;
}
interface SideState {
	tabs: PaneTab[];
	active: string | null;
}
type Side = "left" | "right";

let tabSeq = 0;
const newTab = (conn: TabConn, initialPath?: string): PaneTab => ({ id: `sftp-tab-${++tabSeq}`, conn, initialPath });

export default function Sftp() {
	const [searchParams] = useSearchParams();
	const hostIdParam = searchParams.get("hostId");
	const sessionKeyParam = searchParams.get("sessionKey");

	const queue = useTransfersStore((s) => s.items);
	const { count: queueCount } = transferSummary(queue);
	const sessionTabs = useSessionsStore((s) => s.tabs);
	const openSession = useSessionsStore((s) => s.openSession);
	const hosts = useHostsStore((s) => s.hosts);
	const showHidden = useSettingsStore((s) => s.sftpShowHiddenFiles);

	const liveSessions = useMemo(() => sessionTabs.filter((t) => t.sessionKey && t.status === "connected"), [sessionTabs]);

	const initialRemote = (): PaneTab[] => {
		if (sessionKeyParam) {
			const t = sessionTabs.find((s) => s.sessionKey === sessionKeyParam);
			if (t?.hostId) return [newTab({ kind: "remote", hostId: t.hostId, sessionKey: sessionKeyParam })];
		}
		if (hostIdParam) return [newTab({ kind: "remote", hostId: hostIdParam, sessionKey: null })];
		const first = liveSessions[0];
		if (first?.hostId) return [newTab({ kind: "remote", hostId: first.hostId, sessionKey: first.sessionKey })];
		return [];
	};
	const [sides, setSides] = useState<Record<Side, SideState>>(() => {
		const left = [newTab({ kind: "local" })];
		const right = initialRemote();
		return { left: { tabs: left, active: left[0].id }, right: { tabs: right, active: right[0]?.id ?? null } };
	});

	// 链接里带了主机但还没连：发起连接（Netcatty：选主机即建 SFTP 连接）
	useEffect(() => {
		if (!hostIdParam || sessionKeyParam) return;
		if (sessionTabs.some((t) => t.hostId === hostIdParam)) return;
		openSession(hostIdParam);
		toast({ title: "正在连接远程主机并挂载 SFTP…", tone: "default" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hostIdParam, sessionKeyParam]);

	// 等待连接的远程标签：主机连上后挂到它的会话上
	useEffect(() => {
		setSides((prev) => {
			let changed = false;
			const fix = (s: SideState): SideState => {
				const tabs = s.tabs.map((t) => {
					if (t.conn.kind !== "remote") return t;
					const conn = t.conn;
					if (conn.sessionKey && sessionTabs.some((x) => x.sessionKey === conn.sessionKey)) return t;
					const live = liveSessions.find((x) => x.hostId === conn.hostId);
					if (!live?.sessionKey || live.sessionKey === conn.sessionKey) return t;
					changed = true;
					return { ...t, conn: { ...conn, sessionKey: live.sessionKey } };
				});
				return { ...s, tabs };
			};
			const next = { left: fix(prev.left), right: fix(prev.right) };
			return changed ? next : prev;
		});
	}, [liveSessions, sessionTabs]);

	const paneConn = useCallback(
		(conn: TabConn): SftpPaneConn => {
			if (conn.kind === "local") return conn;
			const host = hosts.find((h) => h.id === conn.hostId);
			const session = conn.sessionKey ? sessionTabs.find((t) => t.sessionKey === conn.sessionKey) : undefined;
			const connected = session?.status === "connected";
			return {
				kind: "remote",
				hostId: conn.hostId,
				sessionKey: connected ? conn.sessionKey : null,
				title: host?.name ?? session?.title ?? conn.hostId,
				connecting: sessionTabs.some((t) => t.hostId === conn.hostId && t.status === "connecting"),
			};
		},
		[hosts, sessionTabs],
	);

	/* ------------------------------ 栏句柄 / 连接信息 ------------------------------ */
	const [handles, setHandles] = useState<Record<string, SftpPaneHandle | null>>({});
	const onHandle = useCallback((paneId: string, h: SftpPaneHandle | null) => {
		setHandles((prev) => (prev[paneId] === h ? prev : { ...prev, [paneId]: h }));
	}, []);
	const infos = useRef<Record<string, SftpPaneConnectionInfo>>({});
	const [infoTick, setInfoTick] = useState(0);
	const onConnectionInfo = useCallback((paneId: string, info: SftpPaneConnectionInfo) => {
		infos.current[paneId] = info;
		setInfoTick((n) => n + 1);
	}, []);

	const activeHandle = (side: Side) => {
		const id = sides[side].active;
		return id ? (handles[id] ?? null) : null;
	};
	const leftHandle = activeHandle("left");
	const rightHandle = activeHandle("right");

	/* ------------------------------ 标签操作 ------------------------------ */
	const addTabTo = (side: Side, tab: PaneTab, after?: string) =>
		setSides((prev) => {
			const tabs = [...prev[side].tabs];
			const idx = after ? tabs.findIndex((t) => t.id === after) : -1;
			tabs.splice(idx >= 0 ? idx + 1 : tabs.length, 0, tab);
			return { ...prev, [side]: { tabs, active: tab.id } };
		});
	const closeTab = (side: Side, id: string) =>
		setSides((prev) => {
			const tabs = prev[side].tabs.filter((t) => t.id !== id);
			const idx = prev[side].tabs.findIndex((t) => t.id === id);
			const active = prev[side].active === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : prev[side].active;
			return { ...prev, [side]: { tabs, active } };
		});
	const moveToOther = (from: Side, id: string) =>
		setSides((prev) => {
			const to: Side = from === "left" ? "right" : "left";
			const tab = prev[from].tabs.find((t) => t.id === id);
			if (!tab) return prev;
			const rest = prev[from].tabs.filter((t) => t.id !== id);
			return {
				[from]: { tabs: rest, active: prev[from].active === id ? (rest[0]?.id ?? null) : prev[from].active },
				[to]: { tabs: [...prev[to].tabs, tab], active: tab.id },
			} as Record<Side, SideState>;
		});
	const duplicateTab = (side: Side, id: string, mode: SftpTabDuplicateMode) => {
		const req = getSftpTabDuplicateRequest(infos.current[id], mode);
		const source = sides[side].tabs.find((t) => t.id === id);
		if (!req || !source) return;
		if (req.kind === "local") addTabTo(side, newTab({ kind: "local" }, req.path), id);
		else {
			const sessionKey = source.conn.kind === "remote" ? source.conn.sessionKey : null;
			addTabTo(side, newTab({ kind: "remote", hostId: req.hostId, sessionKey }, req.path), id);
		}
	};

	/* 「+」新建标签页：本地 / 已连接的会话 / 连接其它主机（Netcatty HostSelectModal 的等价物） */
	const [addMenu, setAddMenu] = useState<{ side: Side; x: number; y: number } | null>(null);
	const unconnectedHosts = useMemo(() => {
		const live = new Set(liveSessions.map((s) => s.hostId));
		return hosts.filter((h) => !live.has(h.id));
	}, [hosts, liveSessions]);
	const pickConn = (side: Side, conn: TabConn) => {
		setAddMenu(null);
		addTabTo(side, newTab(conn));
		if (conn.kind === "remote" && !conn.sessionKey) {
			if (!sessionTabs.some((t) => t.hostId === conn.hostId && t.status !== "disconnected")) {
				openSession(conn.hostId);
				toast({ title: "正在连接主机并挂载 SFTP…", tone: "default" });
			}
		}
	};

	/* ------------------------------ 两栏之间传输 ------------------------------ */
	const transferBetween = (from: SftpPaneHandle | null, to: SftpPaneHandle | null) => {
		if (!from || !to || !from.connected || !to.connected || !to.currentPath) {
			toast({ title: "两侧都需要已连接的标签", tone: "warning" });
			return;
		}
		const entries = from.selectedEntries();
		if (entries.length === 0) return;
		void transferEntries({
			from: from.target,
			to: to.target,
			entries,
			destDir: to.currentPath,
			onFinished: () => void to.reload(),
		}).catch((e) => toast({ title: "传输失败", description: String(e), tone: "danger" }));
	};

	const tabInfos = (side: Side): SftpTabInfo[] => {
		void infoTick;
		return sides[side].tabs.map((t) => {
			const conn = paneConn(t.conn);
			return {
				id: t.id,
				label: conn.kind === "local" ? "本地" : conn.title,
				isLocal: conn.kind === "local",
				canDuplicate: canDuplicateSftpTab(infos.current[t.id], true),
			};
		});
	};

	const renderSide = (side: Side) => {
		const other = side === "left" ? rightHandle : leftHandle;
		const state = sides[side];
		return (
			<div className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface", side === "left" && "border-r border-border")}>
				<SftpTabBar
					side={side}
					tabs={tabInfos(side)}
					activeTabId={state.active}
					onSelectTab={(id) => setSides((prev) => ({ ...prev, [side]: { ...prev[side], active: id } }))}
					onCloseTab={(id) => closeTab(side, id)}
					onAddTab={(anchor) => setAddMenu({ side, ...anchor })}
					onReorderTabs={(dragged, target, position) =>
						setSides((prev) => ({ ...prev, [side]: { ...prev[side], tabs: reorderTabs(prev[side].tabs, dragged, target, position) } }))
					}
					onMoveTabToOtherSide={(id) => moveToOther(side === "left" ? "right" : "left", id)}
					onDuplicateTab={(id, mode) => duplicateTab(side, id, mode)}
				/>
				{state.tabs.length === 0 ? (
					<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
						<EmptyState icon="icon-[lucide--folder-tree]" title="没有打开的标签页" description="点击「+」选择本地文件系统或一台主机" className="py-6" />
						<button
							type="button"
							className="rounded-control bg-primary/15 px-3 py-1.5 text-[11.5px] font-medium text-primary hover:bg-primary/25"
							onClick={(e) => {
								const rect = e.currentTarget.getBoundingClientRect();
								setAddMenu({ side, x: rect.left, y: rect.bottom + 2 });
							}}
						>
							新建标签页
						</button>
					</div>
				) : (
					state.tabs.map((t) => (
						<SftpPane
							key={t.id}
							paneId={t.id}
							conn={paneConn(t.conn)}
							initialPath={t.initialPath}
							visible={t.id === state.active}
							other={other}
							onHandle={onHandle}
							onConnectionInfo={onConnectionInfo}
						/>
					))
				)}
			</div>
		);
	};

	return (
		<WindowChrome>
			<div className="relative flex min-h-0 flex-1 flex-col bg-surface">
				{/* 顶栏 */}
				<div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface-sunk px-3 text-[12px]">
					<span className="shrink-0 font-medium text-surface-foreground">SFTP 远程文件传输</span>
					<div className="flex shrink-0 items-center gap-2">
						<IconButton
							icon={showHidden ? "icon-[lucide--eye]" : "icon-[lucide--eye-off]"}
							label={showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}
							className={cn("size-6.5", showHidden && "text-primary")}
							onClick={() => useSettingsStore.getState().setTerminal({ sftpShowHiddenFiles: !showHidden })}
						/>
						<Link
							to="/editor"
							className="flex h-6.5 items-center gap-1.5 rounded-control border border-border bg-surface px-2 text-[11px] font-medium text-muted transition-colors hover:bg-surface-raised hover:text-surface-foreground"
						>
							<span className="icon-[lucide--file-pen-line] size-3 text-primary" />
							<span>内置编辑器</span>
						</Link>
						<Link
							to="/transfers"
							className="flex h-6.5 items-center gap-1.5 rounded-control bg-primary px-2.5 text-[11px] font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
						>
							<span className="icon-[lucide--arrow-down-up] size-3" />
							<span className="tabular-nums">传输队列 ({queueCount})</span>
						</Link>
					</div>
				</div>

				<div className="relative flex min-h-0 flex-1">
					{renderSide("left")}
					{/* 中间操作轴：左右两栏当前标签之间互传 */}
					<div className="flex w-9 shrink-0 flex-col items-center justify-center gap-3 border-r border-border bg-surface-sunk/60">
						<IconButton
							icon="icon-[lucide--arrow-right]"
							label="把左侧选中项传到右侧"
							className="size-7 rounded-full bg-surface shadow-xs hover:border-primary hover:text-primary"
							disabled={!leftHandle?.connected || !rightHandle?.connected}
							onClick={() => transferBetween(leftHandle, rightHandle)}
						/>
						<IconButton
							icon="icon-[lucide--arrow-left]"
							label="把右侧选中项传到左侧"
							className="size-7 rounded-full bg-surface shadow-xs hover:border-primary hover:text-primary"
							disabled={!leftHandle?.connected || !rightHandle?.connected}
							onClick={() => transferBetween(rightHandle, leftHandle)}
						/>
					</div>
					{renderSide("right")}
				</div>

				{addMenu && (
					<ContextMenu x={addMenu.x} y={addMenu.y} width={260} onClose={() => setAddMenu(null)} label="新建标签页">
						<MenuItem icon="icon-[lucide--monitor]" label="本地文件系统" onClick={() => pickConn(addMenu.side, { kind: "local" })} />
						{liveSessions.length > 0 && (
							<>
								<MenuSeparator />
								<MenuLabel label="已连接的 SSH 会话" />
								{liveSessions.map((s) => (
									<MenuItem
										key={s.sessionKey}
										icon="icon-[lucide--hard-drive]"
										label={s.title}
										onClick={() => s.hostId && pickConn(addMenu.side, { kind: "remote", hostId: s.hostId, sessionKey: s.sessionKey })}
									/>
								))}
							</>
						)}
						{unconnectedHosts.length > 0 && (
							<>
								<MenuSeparator />
								<MenuLabel label="连接到其他主机…" />
								{unconnectedHosts.map((h) => (
									<MenuItem
										key={h.id}
										icon="icon-[lucide--plug]"
										label={`${h.name} (${h.username}@${h.hostname})`}
										onClick={() => pickConn(addMenu.side, { kind: "remote", hostId: h.id, sessionKey: null })}
									/>
								))}
							</>
						)}
					</ContextMenu>
				)}
			</div>
		</WindowChrome>
	);
}
