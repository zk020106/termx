import { FileOpenerModal, SftpPermissionsModal, type FileOpenerChoice } from "@/components/sftp/SftpDialogs";
import { Button } from "@/components/ui/Button";
import { ContextMenu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Overlay";
import { PromptModal } from "@/components/ui/PromptModal";
import { currentHotkeyContext, matchHotkey } from "@/lib/hotkeys";
import { shortcutLabel } from "@/lib/keyBindings";
import { toSafeLocalName } from "@/lib/pathSafety";
import { detectPlatform } from "@/lib/platform";
import {
	fsLocalCreateEmptyFile,
	fsLocalMkdir,
	fsLocalRemove,
	fsLocalRename,
	sftpChmod,
	sftpCreateEmptyFile,
	sftpMkdir,
	sftpRemove,
	sftpRename,
	type SftpFileEntry,
} from "@/lib/sftp";
import {
	advanceTypeahead,
	getFileExtension,
	getNextUntitledName,
	isExtractableArchive,
	isKnownBinaryFile,
	resolveSamePanePaste,
	type TypeaheadState,
} from "@/lib/sftpArchive";
import {
	copyEntriesSameSide,
	directoryExists,
	extractArchive,
	joinIn,
	localEntriesFromPaths,
	localSaveCopy,
	moveEntries,
	openWithApplication,
	openWithSystemDefault,
	parentOf,
	pickApplication,
	transferEntries,
	type PaneTarget,
} from "@/lib/sftpOps";
import { enqueueTransfers } from "@/lib/transferManager";
import { useSettingsStore } from "@/store/settings";
import { toast } from "@/store/toast";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";

/* =============================================================================
 * 一个 SFTP 文件栏的右键菜单 / 对话框 / 键盘操作，对齐 Netcatty：
 * - 文件右键：SftpPaneFileList.tsx 的 ContextMenuContent（顺序、文案、显示条件逐项照搬）；
 * - 空白处右键：同文件 L711-733（刷新 / 新建文件夹 / 新建文件 / 上传文件... / 上传文件夹...）；
 * - 键盘：useSftpKeyboardShortcuts.ts（sftp-* 键位 + 方向键 + 输入查找）；
 * - 剪贴板：application/state/sftp/sftpClipboardStore.ts（模块级，跨栏共享）；
 * - 打开方式：FileOpenerDialog + useSftpFileAssociations（按扩展名记住）。
 * 双栏页（Sftp.tsx）、终端底部 SFTP 抽屉、SFTP 侧栏共用这一份。
 * ========================================================================== */

export interface SftpPaneRef {
	target: PaneTarget;
	currentPath: string;
	reload: () => void | Promise<void>;
}

interface ClipboardState {
	files: SftpFileEntry[];
	sourcePath: string;
	source: PaneTarget;
	operation: "copy" | "cut";
}
/** Netcatty sftpClipboardStore：模块级单例，两侧栏共享 */
let sftpClipboard: ClipboardState | null = null;

type Dialog =
	| { kind: "rename"; entry: SftpFileEntry }
	| { kind: "delete"; entries: SftpFileEntry[] }
	| { kind: "new-folder" }
	| { kind: "new-file"; initial: string }
	| { kind: "chmod"; entry: SftpFileEntry }
	| { kind: "move-to"; paths: string[] }
	| { kind: "opener"; entry: SftpFileEntry };

const isNavigableDirectory = (e: SftpFileEntry) => e.is_dir;

function sameTarget(a: PaneTarget, b: PaneTarget): boolean {
	return a.side === b.side && (a.side === "local" || a.sessionKey === b.sessionKey);
}

function isEditableTarget(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el) return false;
	return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

function invalidNameReason(name: string): string | null {
	if (!name.trim()) return "";
	if (name === "." || name === "..") return "名称不能是 . 或 ..";
	if (/[/\\]/.test(name) || name.includes("\0")) return "名称不能包含 / 或 \\";
	return null;
}

export function useSftpPaneActions(options: {
	pane: SftpPaneRef;
	/** 当前可见（过滤 / 排序后）的条目，方向键与输入查找按它走 */
	entries: SftpFileEntry[];
	selected: Set<string>;
	setSelected: (next: Set<string>) => void;
	navigate: (path: string) => void;
	/** 双栏时的另一侧；抽屉 / 侧栏没有 */
	other?: SftpPaneRef | null;
	/** 显示在删除确认里的主机名 */
	hostLabel?: string;
}) {
	const { pane, entries, selected, setSelected, other, hostLabel } = options;
	const routerNavigate = useNavigate();
	const autoSync = useSettingsStore((s) => s.sftpAutoSync);
	const doubleClick = useSettingsStore((s) => s.sftpDoubleClickBehavior);
	const fileOpeners = useSettingsStore((s) => s.sftpFileOpeners);
	const hotkeyScheme = useSettingsStore((s) => s.hotkeyScheme);
	const customKeyBindings = useSettingsStore((s) => s.customKeyBindings);

	const [menu, setMenu] = useState<{ x: number; y: number; entry: SftpFileEntry | null } | null>(null);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const [busy, setBusy] = useState(false);
	const typeahead = useRef<TypeaheadState | null>(null);
	const anchor = useRef<string | null>(null);
	const containerRef = useRef<HTMLElement | null>(null);

	const { target, currentPath } = pane;
	const isLocal = target.side === "local";
	const caseInsensitive = isLocal && detectPlatform() === "windows";
	const fullPath = useCallback((name: string) => joinIn(target, currentPath, name), [target, currentPath]);
	const byName = useMemo(() => new Map(entries.map((e) => [e.name, e])), [entries]);

	const kbd = useCallback(
		(id: string) => {
			const ctx = currentHotkeyContext();
			return shortcutLabel(ctx.bindings, id, hotkeyScheme);
		},
		// customKeyBindings 变了文案要跟着变
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[hotkeyScheme, customKeyBindings],
	);

	/** 右键作用对象：点在已选中项上 = 整个选区，否则只有这一项（Netcatty selectedFilesRef 逻辑） */
	const selectionFor = useCallback(
		(entry: SftpFileEntry): SftpFileEntry[] => {
			if (selected.has(entry.name) && selected.size > 1) {
				return [...selected].map((n) => byName.get(n)).filter((e): e is SftpFileEntry => Boolean(e));
			}
			return [entry];
		},
		[selected, byName],
	);
	const selectedEntries = useCallback(
		() => [...selected].map((n) => byName.get(n)).filter((e): e is SftpFileEntry => Boolean(e)),
		[selected, byName],
	);

	const run = useCallback(async (label: string, fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (error) {
			toast({ title: label, description: String(error), tone: "danger" });
		}
	}, []);

	/* ------------------------------ 打开 / 编辑 ------------------------------ */

	const editFile = useCallback(
		(entry: SftpFileEntry) => {
			if (isLocal) {
				routerNavigate(`/editor?localPath=${encodeURIComponent(entry.path)}`);
				return;
			}
			if (!target.sessionKey) return;
			routerNavigate(
				`/editor?sessionKey=${encodeURIComponent(target.sessionKey)}&path=${encodeURIComponent(entry.path)}&name=${encodeURIComponent(
					entry.name,
				)}&hostId=${encodeURIComponent(target.hostId ?? "")}`,
			);
		},
		[isLocal, routerNavigate, target.sessionKey, target.hostId],
	);

	const openSystemDefault = useCallback(
		(entry: SftpFileEntry) => run(`打开失败：${entry.name}`, () => openWithSystemDefault(target, entry, { autoSync })),
		[run, target, autoSync],
	);

	/** Netcatty handleOpenFileForSide：有记住的打开方式就直接用，否则弹「打开方式」 */
	const openFile = useCallback(
		(entry: SftpFileEntry) => {
			const saved = fileOpeners[getFileExtension(entry.name)];
			if (saved?.type === "builtin-editor") {
				editFile(entry);
				return;
			}
			if (saved?.type === "system-app" && saved.app) {
				const app = saved.app;
				void run(`打开失败：${entry.name}`, () => openWithApplication(target, entry, app.path, { autoSync }));
				return;
			}
			setDialog({ kind: "opener", entry });
		},
		[fileOpeners, editFile, run, target, autoSync],
	);

	const onOpenerSelect = useCallback(
		(entry: SftpFileEntry, choice: FileOpenerChoice, remember: boolean) => {
			setDialog(null);
			if (remember) {
				const ext = getFileExtension(entry.name);
				const state = useSettingsStore.getState();
				state.setTerminal({
					sftpFileOpeners: {
						...state.sftpFileOpeners,
						[ext]: choice.type === "system-app" ? { type: "system-app", app: choice.app } : { type: "builtin-editor" },
					},
				});
			}
			if (choice.type === "builtin-editor") editFile(entry);
			else void run(`打开失败：${entry.name}`, () => openWithApplication(target, entry, choice.app.path, { autoSync }));
		},
		[editFile, run, target, autoSync],
	);

	/* ------------------------------ 传输 ------------------------------ */

	const copyToOtherPane = useCallback(
		(items: SftpFileEntry[]) => {
			if (!other || (other.target.side === "remote" && !other.target.sessionKey)) {
				toast({ title: "请打开双栏 SFTP 文件管理，并连接目标侧后再复制文件。", tone: "warning" });
				return;
			}
			void run("复制到另一侧失败", () =>
				transferEntries({
					from: target,
					to: other.target,
					entries: items,
					destDir: other.currentPath,
					onFinished: () => void other.reload(),
				}),
			);
		},
		[other, run, target],
	);

	const openEntry = useCallback(
		(entry: SftpFileEntry) => {
			if (isNavigableDirectory(entry)) {
				options.navigate(entry.path);
				return;
			}
			// Netcatty sftpDoubleClickBehavior：transfer = 双击传到另一侧
			if (doubleClick === "transfer" && other) {
				copyToOtherPane([entry]);
				return;
			}
			openFile(entry);
		},
		[options, doubleClick, other, copyToOtherPane, openFile],
	);

	const download = useCallback(
		(entry: SftpFileEntry, many: SftpFileEntry[]) =>
			run("下载失败", async () => {
				const win = detectPlatform() === "windows";
				if (isLocal) {
					// 本地栏「下载」= 另存一份
					const dest = await saveDialog({ defaultPath: entry.name, title: "另存为" });
					if (!dest) return;
					await localSaveCopy(entry.path, dest);
					toast({ title: `已保存：${entry.name}`, description: dest, tone: "success" });
					return;
				}
				if (!target.sessionKey) throw new Error("远程 SFTP 会话未连接");
				if (many.length > 1 || entry.is_dir) {
					const dir = await openDialog({ directory: true, multiple: false, title: "选择下载目录" });
					if (!dir || Array.isArray(dir)) return;
					await transferEntries({ from: target, to: { side: "local" }, entries: many.length > 1 ? many : [entry], destDir: dir });
					return;
				}
				const dest = await saveDialog({ defaultPath: toSafeLocalName(entry.name, win), title: "下载到" });
				if (!dest) return;
				await enqueueTransfers(
					[
						{
							name: entry.name,
							direction: "download",
							hostId: target.hostId ?? "",
							sessionKey: target.sessionKey,
							localPath: dest,
							remotePath: entry.path,
							size: entry.size,
							overwriteConfirmed: true,
						},
					],
					{
						onItemFailed: (item, error) => toast({ title: `下载失败: ${item.name}`, description: error, tone: "danger" }),
						onItemDone: (item) => toast({ title: `下载完成: ${item.name}`, description: dest, tone: "success" }),
					},
				);
			}),
		[run, isLocal, target],
	);

	const uploadFiles = useCallback(
		(destDir: string, folder: boolean) =>
			run(folder ? "上传文件夹失败" : "上传文件失败", async () => {
				const picked = await openDialog({ directory: folder, multiple: true, title: folder ? "选择要上传的文件夹" : "选择要上传的文件" });
				if (!picked) return;
				const paths = Array.isArray(picked) ? picked : [picked];
				if (paths.length === 0) return;
				const items = await localEntriesFromPaths(paths);
				await transferEntries({ from: { side: "local" }, to: target, entries: items, destDir, onFinished: () => void pane.reload() });
			}),
		[run, target, pane],
	);

	const extract = useCallback(
		(entry: SftpFileEntry) => {
			toast({ title: `正在解压 ${entry.name}...`, tone: "default" });
			void extractArchive(target, entry).then(
				() => {
					toast({ title: `已解压 ${entry.name}`, tone: "success" });
					void pane.reload();
				},
				(error) => toast({ title: `解压 ${entry.name} 失败：${String(error)}`, tone: "danger" }),
			);
		},
		[target, pane],
	);

	const moveTo = useCallback(
		(paths: string[], destDir: string) =>
			run("移动失败", async () => {
				const moved = await moveEntries(target, paths, destDir);
				if (moved > 0) toast({ title: `已移动 ${moved} 项`, description: destDir, tone: "success" });
				setSelected(new Set());
				await pane.reload();
			}),
		[run, target, pane, setSelected],
	);

	/* ------------------------------ 剪贴板 ------------------------------ */

	const clipboardPut = useCallback(
		(operation: "copy" | "cut", items: SftpFileEntry[]) => {
			if (items.length === 0) return;
			sftpClipboard = { files: items, sourcePath: currentPath, source: target, operation };
			// Netcatty replaceSystemClipboardWithSftpPaths：系统剪贴板里放路径，方便贴到别处
			void navigator.clipboard.writeText(items.map((e) => e.path).join("\n")).catch(() => {});
			toast({ title: `${operation === "cut" ? "已剪切" : "已复制"} ${items.length} 项`, tone: "default" });
		},
		[currentPath, target],
	);

	const paste = useCallback(
		() =>
			run("粘贴失败", async () => {
				const clip = sftpClipboard;
				if (!clip || clip.files.length === 0) return;
				const destDir = currentPath;
				if (sameTarget(clip.source, target)) {
					const action = resolveSamePanePaste({
						operation: clip.operation,
						sourcePath: clip.sourcePath,
						targetPath: destDir,
						files: clip.files.map((f) => ({ name: f.name, isDirectory: f.is_dir })),
						caseInsensitive,
					});
					if (action === "block-same-folder") {
						toast({ title: "剪切的项目已经在此文件夹中。", tone: "default" });
						return;
					}
					if (action === "block-into-source") {
						toast({
							title:
								clip.operation === "cut"
									? "文件夹不能移动到自身内部，请选择其他文件夹。"
									: "文件夹不能复制到自身或其子文件夹中，请选择其他文件夹。",
							tone: "default",
						});
						return;
					}
					const paths = clip.files.map((f) => f.path);
					if (clip.operation === "cut") {
						await moveEntries(target, paths, destDir);
						sftpClipboard = null;
					} else {
						await copyEntriesSameSide(target, paths, destDir);
					}
					toast({ title: `已粘贴 ${paths.length} 项`, description: destDir, tone: "success" });
					await pane.reload();
					return;
				}
				if (clip.source.side === target.side) {
					throw new Error("两个不同远程会话之间不能直接粘贴，请先下载到本地");
				}
				const source = clip.source;
				const cut = clip.operation === "cut";
				await transferEntries({
					from: source,
					to: target,
					entries: clip.files,
					destDir,
					onFinished: ({ allDone }) => {
						void pane.reload();
						// 剪切跨栏：全部传完后再删源（Netcatty 同样在传输完成后删除）
						if (cut && allDone) {
							void (async () => {
								for (const f of clip.files) {
									if (source.side === "local") await fsLocalRemove(f.path, f.is_dir);
									else if (source.sessionKey) await sftpRemove(source.sessionKey, f.path, f.is_dir);
								}
								if (sftpClipboard === clip) sftpClipboard = null;
								if (other && sameTarget(other.target, source)) void other.reload();
							})().catch((error) => toast({ title: "删除源文件失败", description: String(error), tone: "danger" }));
						} else if (cut) {
							toast({ title: "部分文件未传输完成，源文件已保留", tone: "warning" });
						}
					},
				});
			}),
		[run, currentPath, target, caseInsensitive, pane, other],
	);

	/* ------------------------------ 对话框提交 ------------------------------ */

	const submitRename = (entry: SftpFileEntry, name: string) =>
		run("重命名失败", async () => {
			setDialog(null);
			if (name === entry.name) return;
			const dest = fullPath(name);
			if (isLocal) await fsLocalRename(entry.path, dest);
			else if (target.sessionKey) await sftpRename(target.sessionKey, entry.path, dest);
			await pane.reload();
		});

	const submitDelete = (items: SftpFileEntry[]) =>
		run("删除失败", async () => {
			setBusy(true);
			try {
				for (const e of items) {
					if (isLocal) await fsLocalRemove(e.path, e.is_dir);
					else if (target.sessionKey) await sftpRemove(target.sessionKey, e.path, e.is_dir);
				}
				toast({ title: `已删除 ${items.length} 项`, tone: "success" });
			} finally {
				setBusy(false);
				setDialog(null);
				setSelected(new Set());
				await pane.reload();
			}
		});

	const submitCreate = (kind: "new-folder" | "new-file", name: string) =>
		run(kind === "new-folder" ? "新建文件夹失败" : "新建文件失败", async () => {
			setDialog(null);
			const path = fullPath(name);
			if (kind === "new-folder") {
				if (isLocal) await fsLocalMkdir(path);
				else if (target.sessionKey) await sftpMkdir(target.sessionKey, path);
			} else if (isLocal) await fsLocalCreateEmptyFile(path);
			else if (target.sessionKey) await sftpCreateEmptyFile(target.sessionKey, path);
			await pane.reload();
			setSelected(new Set([name]));
		});

	const submitChmod = (entry: SftpFileEntry, mode: number) =>
		run("修改权限失败", async () => {
			setDialog(null);
			if (!target.sessionKey) return;
			await sftpChmod(target.sessionKey, entry.path, mode);
			await pane.reload();
		});

	const submitMoveTo = (paths: string[], dest: string) =>
		run("移动失败", async () => {
			if (!(await directoryExists(target, dest))) {
				toast({ title: "目录不存在或无法访问", description: dest, tone: "warning" });
				return;
			}
			setDialog(null);
			await moveTo(paths, dest);
		});

	/* ------------------------------ 右键菜单 ------------------------------ */

	const openContextMenu = useCallback(
		(event: ReactMouseEvent, entry: SftpFileEntry | null) => {
			event.preventDefault();
			event.stopPropagation();
			if (entry && !selected.has(entry.name)) setSelected(new Set([entry.name]));
			setMenu({ x: event.clientX, y: event.clientY, entry });
		},
		[selected, setSelected],
	);

	const closeMenu = useCallback(() => setMenu(null), []);
	const act = (fn: () => void) => () => {
		setMenu(null);
		fn();
	};

	const renderEntryMenu = (entry: SftpFileEntry) => {
		const items = selectionFor(entry);
		const dir = isNavigableDirectory(entry);
		const sourceParent = currentPath;
		const targetParent = parentOf(target, sourceParent);
		const showMoveToParent = targetParent !== sourceParent;
		const uploadTarget = dir ? entry.path : currentPath;
		return (
			<>
				<MenuItem icon={dir ? "icon-[lucide--folder]" : "icon-[lucide--external-link]"} label="打开" kbd={kbd("sftp-open")} onClick={act(() => openEntry(entry))} />
				{dir && <MenuItem icon="icon-[lucide--arrow-right]" label="跳转到这里" kbd={kbd("sftp-navigate-to")} onClick={act(() => options.navigate(entry.path))} />}
				{!dir && <MenuItem icon="icon-[lucide--app-window]" label="系统默认程序打开" onClick={act(() => void openSystemDefault(entry))} />}
				{!dir && <MenuItem icon="icon-[lucide--external-link]" label="打开方式..." onClick={act(() => setDialog({ kind: "opener", entry }))} />}
				{!dir && !isKnownBinaryFile(entry.name) && <MenuItem icon="icon-[lucide--edit-2]" label="编辑" onClick={act(() => editFile(entry))} />}
				{(!dir || !isLocal) && (
					<MenuItem
						icon="icon-[lucide--download]"
						label={items.length > 1 && !isLocal ? `下载选中项（${items.length}）` : "下载"}
						onClick={act(() => void download(entry, isLocal ? [entry] : items))}
					/>
				)}
				{!dir && isExtractableArchive(entry.name) && <MenuItem icon="icon-[lucide--archive]" label="解压到当前目录" onClick={act(() => extract(entry))} />}
				<MenuSeparator />
				<MenuItem icon="icon-[lucide--copy]" label="复制到另一侧" onClick={act(() => copyToOtherPane(items))} />
				<MenuItem
					icon="icon-[lucide--clipboard-copy]"
					label="复制文件路径"
					onClick={act(() => {
						void navigator.clipboard.writeText(entry.path).then(
							() => toast({ title: "已复制文件路径", description: entry.path, tone: "success" }),
							(error) => toast({ title: "复制失败", description: String(error), tone: "danger" }),
						);
					})}
				/>
				<MenuSeparator />
				{showMoveToParent && (
					<MenuItem icon="icon-[lucide--arrow-up]" label="移动到上级目录" onClick={act(() => void moveTo(items.map((e) => e.path), targetParent))} />
				)}
				<MenuItem icon="icon-[lucide--folder-input]" label="移动到..." onClick={act(() => setDialog({ kind: "move-to", paths: items.map((e) => e.path) }))} />
				<MenuItem icon="icon-[lucide--pencil]" label="重命名" kbd={kbd("sftp-rename")} onClick={act(() => setDialog({ kind: "rename", entry }))} />
				{!isLocal && <MenuItem icon="icon-[lucide--shield]" label="权限" onClick={act(() => setDialog({ kind: "chmod", entry }))} />}
				<MenuItem
					icon="icon-[lucide--trash-2]"
					label={items.length > 1 ? `删除选中项（${items.length}）` : "删除"}
					kbd={kbd("sftp-delete")}
					danger
					onClick={act(() => setDialog({ kind: "delete", entries: items }))}
				/>
				<MenuSeparator />
				{renderCommonItems(uploadTarget, dir)}
			</>
		);
	};

	const renderCommonItems = (uploadTarget: string, here: boolean) => (
		<>
			<MenuItem icon="icon-[lucide--refresh-cw]" label="刷新" kbd={kbd("sftp-refresh")} onClick={act(() => void pane.reload())} />
			<MenuItem icon="icon-[lucide--folder-plus]" label="新建文件夹" kbd={kbd("sftp-new-folder")} onClick={act(() => setDialog({ kind: "new-folder" }))} />
			<MenuItem
				icon="icon-[lucide--file-plus]"
				label="新建文件"
				onClick={act(() => setDialog({ kind: "new-file", initial: getNextUntitledName(entries.map((e) => e.name)) }))}
			/>
			{!isLocal && (
				<MenuItem icon="icon-[lucide--upload]" label={here ? "上传文件到这里..." : "上传文件..."} onClick={act(() => void uploadFiles(uploadTarget, false))} />
			)}
			{!isLocal && (
				<MenuItem icon="icon-[lucide--upload]" label={here ? "上传文件夹到这里..." : "上传文件夹..."} onClick={act(() => void uploadFiles(uploadTarget, true))} />
			)}
		</>
	);

	/* ------------------------------ 键盘 ------------------------------ */

	const scrollIntoView = (name: string) => {
		const root = containerRef.current;
		if (!root) return;
		const el = root.querySelector(`[data-sftp-row="${CSS.escape(name)}"]`);
		(el as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
	};

	const selectOnly = (name: string) => {
		anchor.current = name;
		setSelected(new Set([name]));
		scrollIntoView(name);
	};

	const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
		if (dialog || menu) return;
		if (isEditableTarget(event.target)) return;
		containerRef.current = event.currentTarget;
		const native = event.nativeEvent;
		const binding = matchHotkey(native, currentHotkeyContext(), "sftp");
		const current = selectedEntries();
		const single = current.length === 1 ? current[0] : null;
		const action =
			binding?.action ??
			// 键位方案关闭时 Enter / Backspace 仍可用（Netcatty 同样保留）
			(!event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Enter"
				? "sftpOpen"
				: !event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Backspace"
					? "sftpGoParent"
					: null);

		if (action) {
			event.preventDefault();
			event.stopPropagation();
			switch (action) {
				case "sftpCopy":
					clipboardPut("copy", current);
					return;
				case "sftpCut":
					clipboardPut("cut", current);
					return;
				case "sftpPaste":
					void paste();
					return;
				case "sftpSelectAll":
					setSelected(new Set(entries.map((e) => e.name)));
					return;
				case "sftpRename":
					if (single) setDialog({ kind: "rename", entry: single });
					return;
				case "sftpDelete":
					if (current.length) setDialog({ kind: "delete", entries: current });
					return;
				case "sftpRefresh":
					void pane.reload();
					return;
				case "sftpNewFolder":
					setDialog({ kind: "new-folder" });
					return;
				case "sftpOpen":
					if (single) openEntry(single);
					return;
				case "sftpGoParent": {
					const parent = parentOf(target, currentPath);
					if (parent !== currentPath) options.navigate(parent);
					return;
				}
				case "sftpNavigateTo":
					if (single && single.is_dir) options.navigate(single.path);
					return;
			}
			return;
		}

		if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.preventDefault();
			if (entries.length === 0) return;
			const names = entries.map((e) => e.name);
			const focus = anchor.current && names.includes(anchor.current) ? anchor.current : current[current.length - 1]?.name;
			const idx = focus ? names.indexOf(focus) : -1;
			const nextIdx =
				idx === -1 ? (event.key === "ArrowDown" ? 0 : names.length - 1) : Math.max(0, Math.min(names.length - 1, idx + (event.key === "ArrowDown" ? 1 : -1)));
			const name = names[nextIdx];
			if (event.shiftKey) {
				const next = new Set(selected);
				next.add(name);
				anchor.current = name;
				setSelected(next);
				scrollIntoView(name);
			} else selectOnly(name);
			return;
		}

		if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ") {
			const { state, matchIndex } = advanceTypeahead(
				entries.map((e) => e.name),
				typeahead.current,
				event.key,
				Date.now(),
			);
			typeahead.current = state;
			if (matchIndex >= 0) {
				event.preventDefault();
				selectOnly(entries[matchIndex].name);
			}
		}
	};

	/* ------------------------------ 渲染 ------------------------------ */

	const deleting = dialog?.kind === "delete" ? dialog.entries : null;
	const element = createPortal(
		<>
			{menu && (
				<ContextMenu x={menu.x} y={menu.y} width={225} onClose={closeMenu} label="SFTP 文件菜单">
					{menu.entry ? renderEntryMenu(menu.entry) : renderCommonItems(currentPath, false)}
				</ContextMenu>
			)}
			<PromptModal
				open={dialog?.kind === "rename"}
				title="重命名"
				label="新名称"
				placeholder="输入新名称"
				initialValue={dialog?.kind === "rename" ? dialog.entry.name : ""}
				validate={invalidNameReason}
				onClose={() => setDialog(null)}
				onSubmit={(name) => dialog?.kind === "rename" && void submitRename(dialog.entry, name)}
			/>
			<PromptModal
				open={dialog?.kind === "new-folder"}
				title="新建文件夹"
				label="文件夹名称"
				validate={(v) => invalidNameReason(v) ?? (byName.has(v.trim()) ? "已存在同名项目" : null)}
				onClose={() => setDialog(null)}
				onSubmit={(name) => void submitCreate("new-folder", name)}
			/>
			<PromptModal
				open={dialog?.kind === "new-file"}
				title="新建文件"
				label="文件名称"
				initialValue={dialog?.kind === "new-file" ? dialog.initial : ""}
				validate={(v) => invalidNameReason(v) ?? (byName.has(v.trim()) ? "已存在同名项目" : null)}
				onClose={() => setDialog(null)}
				onSubmit={(name) => void submitCreate("new-file", name)}
			/>
			<PromptModal
				open={dialog?.kind === "move-to"}
				title="移动到目录"
				placeholder="输入目标目录路径"
				initialValue={currentPath}
				confirmText="移动"
				onClose={() => setDialog(null)}
				onSubmit={(dest) => dialog?.kind === "move-to" && void submitMoveTo(dialog.paths, dest)}
			/>
			<SftpPermissionsModal
				entry={dialog?.kind === "chmod" ? dialog.entry : null}
				onClose={() => setDialog(null)}
				onSave={(entry, mode) => void submitChmod(entry, mode)}
			/>
			<FileOpenerModal
				fileName={dialog?.kind === "opener" ? dialog.entry.name : null}
				onClose={() => setDialog(null)}
				onPickApp={pickApplication}
				onSelect={(choice, remember) => dialog?.kind === "opener" && onOpenerSelect(dialog.entry, choice, remember)}
			/>
			<Modal
				open={deleting !== null}
				onClose={() => !busy && setDialog(null)}
				title={deleting && deleting.length === 1 ? `删除 "${deleting[0].name}"？` : `删除 ${deleting?.length ?? 0} 个项目？`}
				icon="icon-[lucide--trash-2]"
				footer={
					<div className="flex items-center gap-2">
						<Button size="sm" onClick={() => setDialog(null)} disabled={busy}>
							取消
						</Button>
						<Button size="sm" variant="danger" disabled={busy} onClick={() => deleting && void submitDelete(deleting)}>
							{busy ? "删除中…" : "删除"}
						</Button>
					</div>
				}
			>
				{deleting && (
					<div className="space-y-2 text-[11.5px]">
						<div className="text-muted">{deleting.length === 1 ? "此操作不可撤销。" : "此操作不可撤销，将删除以下内容："}</div>
						<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded border border-border bg-surface p-2">
							<span className="text-faint">主机</span>
							<span className="truncate">{isLocal ? "本地" : (hostLabel ?? "远程")}</span>
							<span className="text-faint">路径</span>
							<span className="truncate font-mono">{currentPath}</span>
						</div>
						{deleting.length > 1 && (
							<ul className="max-h-40 overflow-y-auto rounded border border-border bg-surface p-2 font-mono text-[11px]">
								{deleting.map((e) => (
									<li key={e.path} className="truncate">
										{e.is_dir ? "📁 " : ""}
										{e.name}
									</li>
								))}
							</ul>
						)}
					</div>
				)}
			</Modal>
		</>,
		document.body,
	);

	return {
		element,
		openContextMenu,
		handleKeyDown,
		/** 行双击 / 回车：目录进入，文件按双击行为设置处理 */
		openEntry,
		/** 给列表容器挂上，方向键 / 输入查找时滚动到可见 */
		containerRef,
		copyToOtherPane,
		uploadFiles,
	};
}
