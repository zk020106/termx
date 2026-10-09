import { EmptyState } from "@/components/ui/Display";
import { IconButton } from "@/components/ui/Button";
import { ContextMenu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { useSftpPaneActions, type SftpPaneRef } from "@/components/sftp/useSftpPaneActions";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import {
	fsLocalCreateEmptyFile,
	fsLocalDrives,
	fsLocalHome,
	fsLocalList,
	fsLocalMkdir,
	formatUnixTime,
	getFileIcon,
	sftpCreateEmptyFile,
	sftpList,
	sftpMkdir,
	sftpRealPath,
	type SftpFileEntry,
} from "@/lib/sftp";
import {
	buildSftpColumnTemplate,
	DEFAULT_SFTP_COLUMN_WIDTHS,
	filterEntriesByName,
	isSftpColumnMenuKey,
	SFTP_COLUMN_WIDTH_LIMITS,
	sftpKindLabel,
	sortSftpEntries,
	type ColumnWidths,
	type SftpPaneConnectionInfo,
	type SortField,
	type SortOrder,
} from "@/lib/sftpColumns";
import { joinIn, moveEntries, parentOf, transferEntries, type PaneTarget } from "@/lib/sftpOps";
import { getNextUntitledName } from "@/lib/sftpArchive";
import { PromptModal } from "@/components/ui/PromptModal";
import { useSettingsStore } from "@/store/settings";
import { toast } from "@/store/toast";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";

/* =============================================================================
 * 一个 SFTP 文件栏（双栏页里每个标签各一个）。对齐 Netcatty components/sftp/SftpPaneView.tsx：
 * - 列表视图（SftpPaneFileList）与树形视图（SftpPaneTreeView / SftpPaneTreeNode）可切换，
 *   视图模式按主机记住（sftpHostViewModeStore）；
 * - 表头可排序、可拖宽，右键 / ContextMenu / Shift+F10 打开「选择显示的列」菜单
 *   （名称 / 修改时间 / 大小 / 类型 / 所有者 + 目录置顶，SftpColumnMenuItems）；
 * - 本地或远程都可以出现在任一侧（Netcatty 标签可以选「本地」或任意主机）。
 * 右键菜单 / 键盘 / 剪贴板沿用 useSftpPaneActions（与抽屉、侧栏共用）。
 * ========================================================================== */

export type SftpPaneConn =
	| { kind: "local" }
	| { kind: "remote"; hostId: string | null; sessionKey: string | null; title: string; connecting?: boolean };

export interface SftpPaneHandle extends SftpPaneRef {
	connected: boolean;
	selectedEntries: () => SftpFileEntry[];
}

/** 栏间拖拽的源（Netcatty draggedFiles）：模块级，两栏共享 */
let dragSource: { paneId: string; handle: SftpPaneHandle; entries: SftpFileEntry[] } | null = null;
const DRAG_MIME = "application/termx-sftp-entries";

interface TreeChildren {
	status: "loading" | "error" | "ok";
	entries: SftpFileEntry[];
}

type TreeRow =
	| { type: "node"; entry: SftpFileEntry; depth: number; dir: string }
	| { type: "loading" | "error"; key: string; depth: number; path: string };

const viewModeKey = (conn: SftpPaneConn) => (conn.kind === "local" ? "local" : conn.hostId ?? "");

export function SftpPane({
	paneId,
	conn,
	initialPath,
	visible,
	other,
	onHandle,
	onConnectionInfo,
}: {
	paneId: string;
	conn: SftpPaneConn;
	initialPath?: string;
	visible: boolean;
	other: SftpPaneHandle | null;
	onHandle: (paneId: string, handle: SftpPaneHandle | null) => void;
	onConnectionInfo?: (paneId: string, info: SftpPaneConnectionInfo) => void;
}) {
	const isLocal = conn.kind === "local";
	const sessionKey = conn.kind === "remote" ? conn.sessionKey : null;
	const target: PaneTarget = useMemo(
		() => (conn.kind === "local" ? { side: "local" } : { side: "remote", sessionKey: conn.sessionKey, hostId: conn.hostId }),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[conn.kind, sessionKey, conn.kind === "remote" ? conn.hostId : null],
	);
	const connected = isLocal || !!sessionKey;

	const [path, setPath] = useState("");
	const [inputPath, setInputPath] = useState("");
	const [entries, setEntries] = useState<SftpFileEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [filter, setFilter] = useState("");
	const [drives, setDrives] = useState<string[]>([]);
	const [sortField, setSortField] = useState<SortField>("name");
	const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
	const [columnWidths, setColumnWidths] = useState<ColumnWidths>(DEFAULT_SFTP_COLUMN_WIDTHS);
	const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
	const [create, setCreate] = useState<"mkdir" | "touch" | null>(null);
	const [dropTarget, setDropTarget] = useState<string | null>(null);

	const showHidden = useSettingsStore((s) => s.sftpShowHiddenFiles);
	const visibleColumns = useSettingsStore((s) => s.sftpVisibleColumns);
	const directoriesFirst = useSettingsStore((s) => s.sftpDirectoriesFirst);
	const hostViewModes = useSettingsStore((s) => s.sftpHostViewModes);
	const setTerminal = useSettingsStore((s) => s.setTerminal);
	const viewMode = hostViewModes[viewModeKey(conn)] ?? "list";
	const setViewMode = (mode: "list" | "tree") =>
		setTerminal({ sftpHostViewModes: { ...useSettingsStore.getState().sftpHostViewModes, [viewModeKey(conn)]: mode } });

	/* ------------------------------ 读目录 ------------------------------ */
	const listDir = useCallback(
		async (dir: string): Promise<{ resolved: string; list: SftpFileEntry[] }> => {
			if (isLocal) return { resolved: dir, list: await fsLocalList(dir) };
			if (!sessionKey) throw new Error("远程 SFTP 会话未连接");
			const resolved = await sftpRealPath(sessionKey, dir);
			return { resolved, list: await sftpList(sessionKey, resolved) };
		},
		[isLocal, sessionKey],
	);

	const [tree, setTree] = useState<Map<string, TreeChildren>>(new Map());
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [treeSel, setTreeSel] = useState<{ dir: string; names: Set<string> }>({ dir: "", names: new Set() });

	const load = useCallback(
		async (dir: string) => {
			setLoading(true);
			try {
				const { resolved, list } = await listDir(dir);
				setEntries(list.filter((e) => e.name !== "." && e.name !== ".."));
				setPath(resolved);
				setInputPath(resolved);
				setSelected(new Set());
				// 换了根目录：树形视图从新根开始
				setTree(new Map());
				setExpanded(new Set());
				setTreeSel({ dir: resolved, names: new Set() });
			} catch (e) {
				toast({ title: isLocal ? "读取本地目录失败" : "读取远程目录失败", description: String(e), tone: "danger" });
			} finally {
				setLoading(false);
			}
		},
		[listDir, isLocal],
	);

	useEffect(() => {
		if (!connected) {
			setEntries([]);
			setPath("");
			setInputPath("");
			return;
		}
		if (isLocal) {
			fsLocalDrives().then(setDrives).catch(() => {});
			if (initialPath) void load(initialPath);
			else fsLocalHome().then(load, () => load("."));
		} else {
			void load(initialPath || ".");
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [connected, isLocal, sessionKey]);

	const reloadTreeDir = useCallback(
		async (dir: string) => {
			setTree((m) => new Map(m).set(dir, { status: "loading", entries: m.get(dir)?.entries ?? [] }));
			try {
				const { list } = await listDir(dir);
				setTree((m) => new Map(m).set(dir, { status: "ok", entries: list.filter((e) => e.name !== "." && e.name !== "..") }));
			} catch {
				setTree((m) => new Map(m).set(dir, { status: "error", entries: [] }));
			}
		},
		[listDir],
	);

	const reloadAll = useCallback(async () => {
		await load(path);
	}, [load, path]);

	/* ------------------------------ 排序 / 过滤 ------------------------------ */
	const prepare = useCallback(
		(list: SftpFileEntry[]) =>
			sortSftpEntries(
				filterEntriesByName(
					list.filter((e) => showHidden || !e.name.startsWith(".")),
					filter,
				),
				sortField,
				sortOrder,
				directoriesFirst,
			),
		[showHidden, filter, sortField, sortOrder, directoriesFirst],
	);
	const visibleEntries = useMemo(() => prepare(entries), [prepare, entries]);

	// 隐藏某列后若正按它排序，回到按名称（Netcatty useSftpPaneSorting）
	useEffect(() => {
		if (sortField !== "name" && !visibleColumns[sortField]) {
			setSortField("name");
			setSortOrder("asc");
		}
	}, [sortField, visibleColumns]);

	const handleSort = (field: SortField) => {
		if (sortField === field) setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
		else {
			setSortField(field);
			setSortOrder("asc");
		}
	};

	/* ------------------------------ 拖宽列（Netcatty handleResizeStart，rAF 节流） ------------------------------ */
	const resizing = useRef<{ field: keyof ColumnWidths; startX: number; startWidth: number } | null>(null);
	const handleResizeStart = (field: keyof ColumnWidths, e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		resizing.current = { field, startX: e.clientX, startWidth: columnWidths[field] };
		let raf: number | null = null;
		let lastX = e.clientX;
		const apply = () => {
			const r = resizing.current;
			if (!r) return;
			const { min, max } = SFTP_COLUMN_WIDTH_LIMITS[r.field];
			const width = Math.max(min, Math.min(max, r.startWidth + (lastX - r.startX) / 8));
			setColumnWidths((prev) => ({ ...prev, [r.field]: width }));
		};
		const onMove = (ev: globalThis.MouseEvent) => {
			lastX = ev.clientX;
			if (raf !== null) return;
			raf = requestAnimationFrame(() => {
				raf = null;
				apply();
			});
		};
		const onUp = () => {
			if (raf !== null) cancelAnimationFrame(raf);
			apply();
			resizing.current = null;
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	};

	/* ------------------------------ 动作（列表 / 树形各一份） ------------------------------ */
	const pane: SftpPaneRef = useMemo(() => ({ target, currentPath: path, reload: reloadAll }), [target, path, reloadAll]);
	const listActions = useSftpPaneActions({
		pane,
		entries: visibleEntries,
		selected,
		setSelected,
		navigate: (p) => void load(p),
		other,
		hostLabel: conn.kind === "remote" ? conn.title : undefined,
	});

	// 树形视图：选择限定在同一目录内（右键 / 快捷键按该目录执行，路径都是真实路径）
	const treeDir = treeSel.dir || path;
	const treeDirEntries = useMemo(
		() => prepare(treeDir === path ? entries : (tree.get(treeDir)?.entries ?? [])),
		[prepare, treeDir, path, entries, tree],
	);
	const treePane: SftpPaneRef = useMemo(
		() => ({
			target,
			currentPath: treeDir,
			reload: () => (treeDir === path ? reloadAll() : reloadTreeDir(treeDir)),
		}),
		[target, treeDir, path, reloadAll, reloadTreeDir],
	);
	const treeActions = useSftpPaneActions({
		pane: treePane,
		entries: treeDirEntries,
		selected: treeSel.names,
		setSelected: (names) => setTreeSel((s) => ({ dir: s.dir || path, names })),
		navigate: (p) => void load(p),
		other,
		hostLabel: conn.kind === "remote" ? conn.title : undefined,
	});

	/* ------------------------------ 向父组件汇报 ------------------------------ */
	const selectedEntries = useCallback(() => {
		if (viewMode === "tree") return treeDirEntries.filter((e) => treeSel.names.has(e.name));
		return visibleEntries.filter((e) => selected.has(e.name));
	}, [viewMode, treeDirEntries, treeSel, visibleEntries, selected]);
	const handle: SftpPaneHandle = useMemo(
		() => ({ target, currentPath: path, reload: reloadAll, connected, selectedEntries }),
		[target, path, reloadAll, connected, selectedEntries],
	);
	useEffect(() => {
		onHandle(paneId, handle);
	}, [onHandle, paneId, handle]);
	useEffect(() => () => onHandle(paneId, null), [onHandle, paneId]);
	useEffect(() => {
		onConnectionInfo?.(paneId, {
			status: connected ? (path ? "connected" : "connecting") : conn.kind === "remote" && conn.connecting ? "connecting" : "disconnected",
			isLocal,
			hostId: conn.kind === "remote" ? conn.hostId : null,
			currentPath: path,
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onConnectionInfo, paneId, connected, path, isLocal]);

	/* ------------------------------ 拖放（Netcatty draggedFiles / onMoveEntriesToPath） ------------------------------ */
	const startDrag = (e: DragEvent, entry: SftpFileEntry, pool: SftpFileEntry[], names: Set<string>) => {
		const items = names.has(entry.name) ? pool.filter((x) => names.has(x.name)) : [entry];
		dragSource = { paneId, handle, entries: items };
		e.dataTransfer.effectAllowed = "copyMove";
		e.dataTransfer.setData(DRAG_MIME, paneId);
	};
	const acceptsDrop = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_MIME);
	const dropInto = (e: DragEvent, destDir: string) => {
		e.preventDefault();
		e.stopPropagation();
		setDropTarget(null);
		const src = dragSource;
		dragSource = null;
		if (!src || !connected || !destDir) return;
		if (src.paneId === paneId) {
			// 同一栏：拖到某个文件夹上 = 移动进去
			const paths = src.entries.map((x) => x.path).filter((p) => p !== destDir);
			if (paths.length === 0 || parentOf(target, paths[0]) === destDir) return;
			void moveEntries(target, paths, destDir).then(
				() => void reloadAll(),
				(err) => toast({ title: "移动失败", description: String(err), tone: "danger" }),
			);
			return;
		}
		void transferEntries({
			from: src.handle.target,
			to: target,
			entries: src.entries,
			destDir,
			onFinished: () => void (destDir === path ? reloadAll() : reloadTreeDir(destDir)),
		}).catch((err) => toast({ title: "传输失败", description: String(err), tone: "danger" }));
	};

	/* ------------------------------ 树形视图 ------------------------------ */
	const toggleExpand = (entry: SftpFileEntry) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(entry.path)) next.delete(entry.path);
			else {
				next.add(entry.path);
				if (!tree.has(entry.path) || tree.get(entry.path)?.status === "error") void reloadTreeDir(entry.path);
			}
			return next;
		});
	};
	const treeRows = useMemo(() => {
		const rows: TreeRow[] = [];
		const walk = (list: SftpFileEntry[], dir: string, depth: number) => {
			for (const entry of prepare(list)) {
				rows.push({ type: "node", entry, depth, dir });
				if (entry.is_dir && expanded.has(entry.path)) {
					const kids = tree.get(entry.path);
					if (!kids || kids.status === "loading") rows.push({ type: "loading", key: `${entry.path}#loading`, depth: depth + 1, path: entry.path });
					else if (kids.status === "error") rows.push({ type: "error", key: `${entry.path}#error`, depth: depth + 1, path: entry.path });
					else walk(kids.entries, entry.path, depth + 1);
				}
			}
		};
		walk(entries, path, 0);
		return rows;
	}, [prepare, entries, path, expanded, tree]);

	const onTreeClick = (row: Extract<TreeRow, { type: "node" }>, e: MouseEvent) => {
		setTreeSel((s) => {
			if ((e.ctrlKey || e.metaKey) && s.dir === row.dir) {
				const names = new Set(s.names);
				if (names.has(row.entry.name)) names.delete(row.entry.name);
				else names.add(row.entry.name);
				return { dir: row.dir, names };
			}
			return { dir: row.dir, names: new Set([row.entry.name]) };
		});
	};
	const onTreeKeyDown = (e: KeyboardEvent<HTMLElement>) => {
		const only = treeSel.names.size === 1 ? treeDirEntries.find((x) => treeSel.names.has(x.name)) : undefined;
		if (only?.is_dir && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
			const open = expanded.has(only.path);
			if ((e.key === "ArrowRight") !== open) toggleExpand(only);
			e.preventDefault();
			return;
		}
		treeActions.handleKeyDown(e);
	};

	/* ------------------------------ 新建 ------------------------------ */
	const submitCreate = async (name: string) => {
		const kind = create;
		setCreate(null);
		if (!kind || !name.trim()) return;
		const full = joinIn(target, path, name.trim());
		try {
			if (kind === "mkdir") {
				if (isLocal) await fsLocalMkdir(full);
				else if (sessionKey) await sftpMkdir(sessionKey, full);
			} else if (isLocal) await fsLocalCreateEmptyFile(full);
			else if (sessionKey) await sftpCreateEmptyFile(sessionKey, full);
			void reloadAll();
		} catch (e) {
			toast({ title: "操作失败", description: String(e), tone: "danger" });
		}
	};

	/* ------------------------------ 渲染 ------------------------------ */
	const columnTemplate = buildSftpColumnTemplate(columnWidths, visibleColumns);
	const sortMark = (field: SortField) =>
		sortField === field ? <span className="shrink-0 text-primary">{sortOrder === "asc" ? "↑" : "↓"}</span> : null;
	const resizer = (field: keyof ColumnWidths) => (
		<div
			className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize transition-colors hover:bg-primary/50"
			onMouseDown={(e) => handleResizeStart(field, e)}
			onClick={(e) => e.stopPropagation()}
		/>
	);
	const cells = (entry: SftpFileEntry) => (
		<>
			{visibleColumns.modified && <span className="min-w-0 truncate font-mono text-[10.5px] tabular-nums text-faint">{formatUnixTime(entry.mtime)}</span>}
			{visibleColumns.size && (
				<span className="min-w-0 truncate text-right font-mono text-[11px] tabular-nums text-faint">{entry.is_dir ? "--" : formatBytes(entry.size)}</span>
			)}
			{visibleColumns.type && <span className="min-w-0 truncate text-right text-[11px] capitalize text-faint">{sftpKindLabel(entry)}</span>}
			{visibleColumns.owner && <span className="min-w-0 truncate text-right text-[11px] text-faint">{entry.owner || "--"}</span>}
		</>
	);

	return (
		<div className={cn("relative min-h-0 flex-1 flex-col", visible ? "flex" : "hidden")}>
			{/* 工具栏 */}
			<div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-sunk px-3 text-[11.5px]">
				<div className="flex min-w-0 items-center gap-1.5 text-muted">
					<span className={cn(isLocal ? "icon-[lucide--laptop]" : "icon-[lucide--server]", "size-3.5 shrink-0 text-primary")} />
					<span className="truncate font-medium text-surface-foreground">
						{isLocal ? "本地文件系统" : conn.kind === "remote" ? `${conn.title}${connected ? "" : conn.connecting ? "（连接中…）" : "（未连接）"}` : ""}
					</span>
				</div>
				{connected && (
					<div className="flex items-center gap-1">
						{isLocal && drives.length > 0 && (
							<select
								value={drives.find((d) => path.startsWith(d)) || drives[0]}
								onChange={(e) => void load(e.target.value)}
								className="h-6 rounded border border-border bg-surface px-1.5 font-mono text-[10.5px] text-surface-foreground outline-none"
							>
								{drives.map((d) => (
									<option key={d} value={d}>
										{d}
									</option>
								))}
							</select>
						)}
						<IconButton
							icon={viewMode === "list" ? "icon-[lucide--list-tree]" : "icon-[lucide--list]"}
							label={viewMode === "list" ? "切换到树形视图" : "切换到列表视图"}
							className="size-6"
							onClick={() => setViewMode(viewMode === "list" ? "tree" : "list")}
						/>
						{!isLocal && (
							<IconButton icon="icon-[lucide--upload]" label="上传文件..." className="size-6 text-primary" onClick={() => void listActions.uploadFiles(path, false)} />
						)}
						<IconButton
							icon="icon-[lucide--home]"
							label={isLocal ? "主目录" : "远程主目录 (~)"}
							className="size-6"
							onClick={() => (isLocal ? fsLocalHome().then(load) : load("."))}
						/>
						<IconButton icon="icon-[lucide--arrow-up]" label="上一级目录" className="size-6" onClick={() => void load(parentOf(target, path))} />
						<IconButton icon="icon-[lucide--folder-plus]" label="新建文件夹" className="size-6" onClick={() => setCreate("mkdir")} />
						<IconButton icon="icon-[lucide--file-plus]" label="新建文件" className="size-6" onClick={() => setCreate("touch")} />
						<IconButton
							icon="icon-[lucide--refresh-cw]"
							label="刷新"
							className={cn("size-6", loading && "animate-spin text-primary")}
							onClick={() => void reloadAll()}
						/>
					</div>
				)}
			</div>

			{!connected ? (
				<EmptyState
					icon={conn.kind === "remote" && conn.connecting ? "icon-[lucide--loader-circle]" : "icon-[lucide--plug-zap]"}
					title={conn.kind === "remote" && conn.connecting ? "正在连接远程主机并挂载 SFTP…" : "远程会话未连接"}
					className="py-16"
				/>
			) : (
				<>
					{/* 路径与过滤 */}
					<div className="flex h-7.5 shrink-0 items-center gap-2 border-b border-border/80 bg-surface-raised/40 px-2 text-[11px]">
						<form
							className="flex min-w-0 flex-1 items-center"
							onSubmit={(e) => {
								e.preventDefault();
								void load(inputPath);
							}}
						>
							<input
								type="text"
								value={inputPath}
								onChange={(e) => setInputPath(e.target.value)}
								className="h-6 w-full rounded border border-border/70 bg-surface px-2 font-mono text-[11px] text-surface-foreground outline-none focus:border-primary"
								placeholder={isLocal ? "本地路径..." : "远程路径 (例如 /etc/nginx)..."}
							/>
						</form>
						<div className="relative w-28 shrink-0">
							<input
								type="text"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								placeholder="筛选..."
								className="h-6 w-full rounded border border-border/70 bg-surface px-2 text-[10.5px] outline-none focus:border-primary"
							/>
							{filter && (
								<button type="button" onClick={() => setFilter("")} className="absolute right-1 top-1 text-faint hover:text-surface-foreground">
									×
								</button>
							)}
						</div>
					</div>

					{/* 表头（右键：选择显示的列） */}
					<div
						tabIndex={0}
						aria-label="选择显示的列"
						className="grid shrink-0 select-none border-b border-border/60 bg-surface-sunk/40 px-3 py-1 text-[10.5px] uppercase tracking-wider text-faint outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
						style={{ gridTemplateColumns: columnTemplate }}
						onContextMenu={(e) => {
							e.preventDefault();
							setHeaderMenu({ x: e.clientX, y: e.clientY });
						}}
						onKeyDown={(e) => {
							if (!isSftpColumnMenuKey(e.key, e.shiftKey)) return;
							e.preventDefault();
							const rect = e.currentTarget.getBoundingClientRect();
							setHeaderMenu({ x: rect.left + 16, y: rect.top + rect.height / 2 });
						}}
					>
						<div className="relative flex min-w-0 cursor-pointer items-center gap-1 overflow-hidden pr-2 hover:text-surface-foreground" onClick={() => handleSort("name")}>
							<span className="truncate whitespace-nowrap">名称</span>
							{sortMark("name")}
							{resizer("name")}
						</div>
						{visibleColumns.modified && (
							<div className="relative flex min-w-0 cursor-pointer items-center gap-1 overflow-hidden pr-2 hover:text-surface-foreground" onClick={() => handleSort("modified")}>
								<span className="truncate whitespace-nowrap">修改时间</span>
								{sortMark("modified")}
								{resizer("modified")}
							</div>
						)}
						{visibleColumns.size && (
							<div className="relative flex min-w-0 cursor-pointer items-center justify-end gap-1 overflow-hidden pr-2 hover:text-surface-foreground" onClick={() => handleSort("size")}>
								{sortMark("size")}
								<span className="truncate whitespace-nowrap">大小</span>
								{resizer("size")}
							</div>
						)}
						{visibleColumns.type && (
							<div className="relative flex min-w-0 cursor-pointer items-center justify-end gap-1 overflow-hidden pr-2 hover:text-surface-foreground" onClick={() => handleSort("type")}>
								{sortMark("type")}
								<span className="truncate whitespace-nowrap">类型</span>
								{resizer("type")}
							</div>
						)}
						{visibleColumns.owner && (
							<div className="flex min-w-0 cursor-pointer items-center justify-end gap-1 overflow-hidden hover:text-surface-foreground" onClick={() => handleSort("owner")}>
								{sortMark("owner")}
								<span className="truncate whitespace-nowrap">所有者</span>
							</div>
						)}
					</div>

					{/* 文件区 */}
					<div
						ref={(el) => {
							listActions.containerRef.current = el;
							treeActions.containerRef.current = el;
						}}
						tabIndex={0}
						onKeyDown={viewMode === "tree" ? onTreeKeyDown : listActions.handleKeyDown}
						onContextMenu={(e) => {
							if (viewMode === "tree") setTreeSel({ dir: path, names: new Set() });
							(viewMode === "tree" ? treeActions : listActions).openContextMenu(e, null);
						}}
						onDragOver={(e) => {
							if (!acceptsDrop(e)) return;
							e.preventDefault();
							setDropTarget(path);
						}}
						onDragLeave={() => setDropTarget(null)}
						onDrop={(e) => dropInto(e, path)}
						className={cn(
							"relative min-h-0 flex-1 overflow-y-auto outline-none",
							dropTarget === path && dragSource?.paneId !== paneId && "ring-2 ring-inset ring-primary/30",
						)}
					>
						{viewMode === "list" ? (
							visibleEntries.length === 0 ? (
								<EmptyState icon="icon-[lucide--folder-open]" title={loading ? "正在读取目录..." : "空目录"} className="py-12" />
							) : (
								<div className="divide-y divide-border/20 text-[11.5px]">
									{visibleEntries.map((entry) => {
										const isSel = selected.has(entry.name);
										return (
											<div
												key={entry.name}
												data-sftp-row={entry.name}
												draggable
												onDragStart={(e) => startDrag(e, entry, visibleEntries, selected)}
												onDragOver={(e) => {
													if (!entry.is_dir || !acceptsDrop(e)) return;
													e.preventDefault();
													e.stopPropagation();
													setDropTarget(entry.path);
												}}
												onDrop={(e) => (entry.is_dir ? dropInto(e, entry.path) : undefined)}
												onClick={(e) => {
													if (e.ctrlKey || e.metaKey) {
														const next = new Set(selected);
														if (next.has(entry.name)) next.delete(entry.name);
														else next.add(entry.name);
														setSelected(next);
													} else setSelected(new Set([entry.name]));
												}}
												onDoubleClick={() => listActions.openEntry(entry)}
												onContextMenu={(e) => listActions.openContextMenu(e, entry)}
												className={cn(
													"grid cursor-pointer select-none items-center gap-x-1 px-3 py-1.5 transition-colors",
													isSel ? "bg-primary/15 font-medium text-primary" : "text-surface-foreground hover:bg-surface-raised",
													dropTarget === entry.path && "bg-primary/10 ring-2 ring-inset ring-primary/50",
												)}
												style={{ gridTemplateColumns: columnTemplate }}
											>
												<div className="flex min-w-0 items-center gap-2">
													<span className={cn(getFileIcon(entry.name, entry.is_dir, entry.is_symlink), "size-4 shrink-0", entry.is_dir ? "text-primary" : "text-muted")} />
													<span className="truncate">{entry.name}</span>
												</div>
												{cells(entry)}
											</div>
										);
									})}
								</div>
							)
						) : treeRows.length === 0 ? (
							<EmptyState icon="icon-[lucide--folder-open]" title={loading ? "加载中..." : "空目录"} className="py-12" />
						) : (
							<div className="text-[11.5px]">
								{treeRows.map((row) => {
									if (row.type !== "node") {
										return (
											<div key={row.key} className="flex h-7 items-center gap-2 text-[11px] text-faint" style={{ paddingLeft: row.depth * 16 + 28 }}>
												{row.type === "loading" ? (
													<>
														<span className="icon-[lucide--loader-circle] size-3 animate-spin" />
														加载中...
													</>
												) : (
													<>
														<span className="icon-[lucide--circle-alert] size-3 text-danger" />
														加载目录失败
														<button type="button" className="text-primary hover:underline" onClick={() => void reloadTreeDir(row.path)}>
															重试
														</button>
													</>
												)}
											</div>
										);
									}
									const { entry, depth, dir } = row;
									const isOpen = entry.is_dir && expanded.has(entry.path);
									const isSel = treeSel.dir === dir && treeSel.names.has(entry.name);
									const kids = tree.get(entry.path);
									return (
										<Fragment key={entry.path}>
											<div
												data-sftp-row={dir === treeDir ? entry.name : undefined}
												draggable
												onDragStart={(e) => startDrag(e, entry, prepare(dir === path ? entries : (tree.get(dir)?.entries ?? [])), treeSel.dir === dir ? treeSel.names : new Set())}
												onDragOver={(e) => {
													if (!entry.is_dir || !acceptsDrop(e)) return;
													e.preventDefault();
													e.stopPropagation();
													setDropTarget(entry.path);
												}}
												onDrop={(e) => (entry.is_dir ? dropInto(e, entry.path) : undefined)}
												onClick={(e) => onTreeClick(row, e)}
												onDoubleClick={() => (entry.is_dir ? toggleExpand(entry) : treeActions.openEntry(entry))}
												onContextMenu={(e) => {
													e.stopPropagation();
													if (!isSel) setTreeSel({ dir, names: new Set([entry.name]) });
													// 选择是异步生效的：本次右键先按单个条目开菜单
													treeActions.openContextMenu(e, entry);
												}}
												className={cn(
													"grid h-7 cursor-pointer select-none items-center gap-x-1 px-2 transition-colors",
													isSel ? "bg-primary/15 font-medium text-primary" : "text-surface-foreground hover:bg-surface-raised",
													dropTarget === entry.path && "bg-primary/10 ring-2 ring-inset ring-primary/50",
												)}
												style={{ gridTemplateColumns: columnTemplate }}
											>
												<div className="flex min-w-0 items-center gap-1" style={{ paddingLeft: depth * 16 + 8 }}>
													<span className="flex w-4 shrink-0 items-center justify-center" onDoubleClick={(e) => entry.is_dir && e.stopPropagation()}>
														{entry.is_dir &&
															(kids?.status === "loading" && isOpen ? (
																<span className="icon-[lucide--loader-circle] size-3 animate-spin text-faint" />
															) : (
																<span
																	className={cn("icon-[lucide--chevron-right] size-3.5 text-faint transition-transform", isOpen && "rotate-90")}
																	onClick={(e) => {
																		e.stopPropagation();
																		toggleExpand(entry);
																	}}
																/>
															))}
													</span>
													<span
														className={cn(
															entry.is_dir ? (isOpen ? "icon-[lucide--folder-open]" : "icon-[lucide--folder]") : getFileIcon(entry.name, false, entry.is_symlink),
															"size-3.5 shrink-0",
															entry.is_dir ? "text-warning" : "text-muted",
														)}
													/>
													<span className="min-w-0 flex-1 truncate">{entry.name}</span>
												</div>
												{cells(entry)}
											</div>
										</Fragment>
									);
								})}
							</div>
						)}
					</div>

					{/* 底部 */}
					<div className="flex h-6 shrink-0 items-center justify-between gap-2 border-t border-border bg-surface-sunk px-3 text-[10.5px] text-faint">
						<span>
							{visibleEntries.length} 项
							{(viewMode === "tree" ? treeSel.names.size : selected.size) > 0 && ` - 已选中 ${viewMode === "tree" ? treeSel.names.size : selected.size} 项`}
						</span>
						<span className="max-w-[240px] truncate font-mono">{path}</span>
					</div>
				</>
			)}

			{headerMenu && (
				<ContextMenu x={headerMenu.x} y={headerMenu.y} width={190} onClose={() => setHeaderMenu(null)} label="选择显示的列">
					<MenuItem icon="icon-[lucide--columns-3]" label="名称" checked disabled onClick={() => undefined} />
					{(["modified", "size", "type", "owner"] as const).map((field) => (
						<MenuItem
							key={field}
							icon="icon-[lucide--columns-3]"
							label={{ modified: "修改时间", size: "大小", type: "类型", owner: "所有者" }[field]}
							checked={visibleColumns[field]}
							onClick={() => setTerminal({ sftpVisibleColumns: { ...visibleColumns, name: true, [field]: !visibleColumns[field] } })}
						/>
					))}
					<MenuSeparator />
					<MenuItem
						icon="icon-[lucide--folder-up]"
						label="目录置顶"
						checked={directoriesFirst}
						onClick={() => setTerminal({ sftpDirectoriesFirst: !directoriesFirst })}
					/>
				</ContextMenu>
			)}
			<PromptModal
				open={create !== null}
				title={create === "mkdir" ? "新建文件夹" : "新建文件"}
				label={create === "mkdir" ? "文件夹名称" : "文件名"}
				initialValue={create === "touch" ? getNextUntitledName(entries.map((e) => e.name)) : ""}
				onClose={() => setCreate(null)}
				onSubmit={(name) => void submitCreate(name)}
			/>
			{listActions.element}
			{treeActions.element}
		</div>
	);
}
