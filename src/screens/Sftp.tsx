import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState, StatusText } from "@/components/ui/Display";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Overlay";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import {
	fsLocalDrives,
	fsLocalHome,
	fsLocalList,
	fsLocalMkdir,
	fsLocalCreateEmptyFile,
	formatUnixTime,
	getFileIcon,
	localDirname,
	localJoin,
	posixDirname,
	posixJoin,
	sftpList,
	sftpMkdir,
	sftpRealPath,
	sftpCreateEmptyFile,
	type SftpFileEntry,
} from "@/lib/sftp";
import { useSftpPaneActions, type SftpPaneRef } from "@/components/sftp/useSftpPaneActions";
import { transferEntries } from "@/lib/sftpOps";
import { useHostsStore } from "@/store/hosts";
import { useSettingsStore } from "@/store/settings";
import { useSessionsStore } from "@/store/sessions";
import { enqueueTransfers } from "@/lib/transferManager";
import { toast } from "@/store/toast";
import { transferSummary, useTransfersStore } from "@/store/transfers";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

/* =============================================================================
 * SFTP 双栏文件管理器（本地 ↔ 远程）
 * ========================================================================== */

type SortField = "name" | "size" | "mtime";
type SortDirection = "asc" | "desc";


export default function Sftp() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const hostIdParam = searchParams.get("hostId");
	const sessionKeyParam = searchParams.get("sessionKey");

	const queue = useTransfersStore((s) => s.items);
	const { count: queueCount } = transferSummary(queue);

	const tabs = useSessionsStore((s) => s.tabs);
	const openSession = useSessionsStore((s) => s.openSession);
	const hosts = useHostsStore((s) => s.hosts);

	// 找出所有已连接且具备 SSH sessionKey 的活跃会话
	const liveSessions = useMemo(
		() => tabs.filter((t) => t.sessionKey && t.status === "connected"),
		[tabs],
	);

	// 未连接的主机（供下拉框快速直连）
	const connectedHostIds = useMemo(
		() => new Set(liveSessions.map((s) => s.hostId).filter(Boolean)),
		[liveSessions],
	);
	const unconnectedHosts = useMemo(
		() => hosts.filter((h) => !connectedHostIds.has(h.id)),
		[hosts, connectedHostIds],
	);

	const [selectedSessionKey, setSelectedSessionKey] = useState<string>("");

	// 支持根据 hostIdParam 或 sessionKeyParam 自动选取或连接会话
	useEffect(() => {
		if (sessionKeyParam) {
			setSelectedSessionKey(sessionKeyParam);
			return;
		}
		if (hostIdParam) {
			const existing = liveSessions.find((s) => s.hostId === hostIdParam);
			if (existing?.sessionKey) {
				setSelectedSessionKey(existing.sessionKey);
				return;
			}
			// 如果已有正在连接的标签，等待其连接
			const pending = tabs.find((t) => t.hostId === hostIdParam);
			if (!pending) {
				openSession(hostIdParam);
				toast({ title: "正在连接远程主机并挂载 SFTP…", tone: "default" });
			}
		}
	}, [hostIdParam, sessionKeyParam, liveSessions, tabs, openSession]);

	// 默认选中第一个可用会话
	useEffect(() => {
		if (liveSessions.length > 0) {
			if (!selectedSessionKey || !liveSessions.some((s) => s.sessionKey === selectedSessionKey)) {
				setSelectedSessionKey(liveSessions[0].sessionKey ?? "");
			}
		} else {
			setSelectedSessionKey("");
		}
	}, [liveSessions, selectedSessionKey]);

	const currentTab = liveSessions.find((s) => s.sessionKey === selectedSessionKey) ?? null;

	/* ------------------------------ 本地文件状态 ------------------------------ */
	const [localPath, setLocalPath] = useState<string>("");
	const [localInputPath, setLocalInputPath] = useState<string>("");
	const [localEntries, setLocalEntries] = useState<SftpFileEntry[]>([]);
	const [localLoading, setLocalLoading] = useState<boolean>(false);
	const [localSelected, setLocalSelected] = useState<Set<string>>(new Set());
	const [localFilter, setLocalFilter] = useState<string>("");
	const [localDrivesList, setLocalDrivesList] = useState<string[]>([]);
	const [localSort, setLocalSort] = useState<{ field: SortField; dir: SortDirection }>({
		field: "name",
		dir: "asc",
	});

	/* ------------------------------ 远端文件状态 ------------------------------ */
	const [remotePath, setRemotePath] = useState<string>("");
	const [remoteInputPath, setRemoteInputPath] = useState<string>("");
	const [remoteEntries, setRemoteEntries] = useState<SftpFileEntry[]>([]);
	const [remoteLoading, setRemoteLoading] = useState<boolean>(false);
	const [remoteSelected, setRemoteSelected] = useState<Set<string>>(new Set());
	const [remoteFilter, setRemoteFilter] = useState<string>("");
	const [remoteSort, setRemoteSort] = useState<{ field: SortField; dir: SortDirection }>({
		field: "name",
		dir: "asc",
	});

	/* ------------------------------ 弹窗与菜单 ------------------------------ */
	const [modalMode, setModalMode] = useState<"mkdir" | "touch" | null>(null);
	const [modalSide, setModalSide] = useState<"local" | "remote">("remote");
	const [inputName, setInputName] = useState<string>("");

	/* ------------------------------ 本地加载 ------------------------------ */
	const loadLocalDir = async (target: string) => {
		setLocalLoading(true);
		try {
			const list = await fsLocalList(target);
			setLocalEntries(list);
			setLocalPath(target);
			setLocalInputPath(target);
			setLocalSelected(new Set());
		} catch (e) {
			toast({ title: "读取本地目录失败", description: String(e), tone: "danger" });
		} finally {
			setLocalLoading(false);
		}
	};

	// 初始加载本地主目录与盘符
	useEffect(() => {
		fsLocalDrives().then((drives) => setLocalDrivesList(drives)).catch(() => {});
		fsLocalHome()
			.then((home) => {
				loadLocalDir(home);
			})
			.catch(() => {
				loadLocalDir(".");
			});
	}, []);

	/* ------------------------------ 远端加载 ------------------------------ */
	const loadRemoteDir = async (key: string, target: string) => {
		if (!key) return;
		setRemoteLoading(true);
		try {
			const resolved = await sftpRealPath(key, target);
			const list = await sftpList(key, resolved);
			setRemoteEntries(list);
			setRemotePath(resolved);
			setRemoteInputPath(resolved);
			setRemoteSelected(new Set());
		} catch (e) {
			toast({ title: "读取远程目录失败", description: String(e), tone: "danger" });
		} finally {
			setRemoteLoading(false);
		}
	};

	// 当选中的 sessionKey 变化时，重新加载远端目录
	useEffect(() => {
		if (selectedSessionKey) {
			loadRemoteDir(selectedSessionKey, ".");
		} else {
			setRemoteEntries([]);
			setRemotePath("");
			setRemoteInputPath("");
		}
	}, [selectedSessionKey]);

	/* ------------------------------ 排序与过滤 ------------------------------ */
	// Netcatty sftpShowHiddenFiles：默认隐藏点开头的文件
	const showHidden = useSettingsStore((s) => s.sftpShowHiddenFiles);
	const filteredLocalEntries = useMemo(() => {
		let list = localEntries.filter(
			(e) => (showHidden || !e.name.startsWith(".")) && e.name.toLowerCase().includes(localFilter.toLowerCase()),
		);
		list.sort((a, b) => {
			if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
			let comp = 0;
			if (localSort.field === "name") comp = a.name.localeCompare(b.name);
			else if (localSort.field === "size") comp = a.size - b.size;
			else if (localSort.field === "mtime") comp = a.mtime - b.mtime;
			return localSort.dir === "asc" ? comp : -comp;
		});
		return list;
	}, [localEntries, localFilter, localSort, showHidden]);

	const filteredRemoteEntries = useMemo(() => {
		let list = remoteEntries.filter(
			(e) => (showHidden || !e.name.startsWith(".")) && e.name.toLowerCase().includes(remoteFilter.toLowerCase()),
		);
		list.sort((a, b) => {
			if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
			let comp = 0;
			if (remoteSort.field === "name") comp = a.name.localeCompare(b.name);
			else if (remoteSort.field === "size") comp = a.size - b.size;
			else if (remoteSort.field === "mtime") comp = a.mtime - b.mtime;
			return remoteSort.dir === "asc" ? comp : -comp;
		});
		return list;
	}, [remoteEntries, remoteFilter, remoteSort, showHidden]);

	/* ------------------------------ 右键菜单 / 键盘（对齐 Netcatty） ------------------------------ */
	const localPane: SftpPaneRef = useMemo(
		() => ({ target: { side: "local" }, currentPath: localPath, reload: () => loadLocalDir(localPath) }),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[localPath],
	);
	const remotePane: SftpPaneRef = useMemo(
		() => ({
			target: { side: "remote", sessionKey: selectedSessionKey || null, hostId: currentTab?.hostId ?? null },
			currentPath: remotePath,
			reload: () => loadRemoteDir(selectedSessionKey, remotePath),
		}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[selectedSessionKey, remotePath, currentTab?.hostId],
	);
	const localActions = useSftpPaneActions({
		pane: localPane,
		entries: filteredLocalEntries,
		selected: localSelected,
		setSelected: setLocalSelected,
		navigate: (path) => void loadLocalDir(path),
		other: selectedSessionKey && remotePath ? remotePane : null,
	});
	const remoteActions = useSftpPaneActions({
		pane: remotePane,
		entries: filteredRemoteEntries,
		selected: remoteSelected,
		setSelected: setRemoteSelected,
		navigate: (path) => void loadRemoteDir(selectedSessionKey, path),
		other: localPath ? localPane : null,
		hostLabel: currentTab?.title,
	});

	/* ------------------------------ 传输操作 ------------------------------ */
	// 目录递归传输（Netcatty 的文件夹上传 / 下载），文件进 termx 传输队列
	const handleUploadEntries = async (entries: SftpFileEntry[]) => {
		if (!selectedSessionKey || !remotePath) {
			toast({ title: "无法上传", description: "未连接到远程 SFTP 会话", tone: "warning" });
			return;
		}
		const key = selectedSessionKey;
		const dir = remotePath;
		try {
			await transferEntries({
				from: localPane.target,
				to: remotePane.target,
				entries,
				destDir: dir,
				onFinished: () => loadRemoteDir(key, dir),
			});
		} catch (e) {
			toast({ title: "上传失败", description: String(e), tone: "danger" });
		}
	};

	const handleDownloadEntries = async (entries: SftpFileEntry[]) => {
		if (!selectedSessionKey || !localPath) {
			toast({ title: "无法下载", description: "未选择本地下载目标目录", tone: "warning" });
			return;
		}
		const dir = localPath;
		try {
			await transferEntries({
				from: remotePane.target,
				to: localPane.target,
				entries,
				destDir: dir,
				onFinished: () => loadLocalDir(dir),
			});
		} catch (e) {
			toast({ title: "下载失败", description: String(e), tone: "danger" });
		}
	};

	const handlePickUpload = async () => {
		if (!selectedSessionKey || !remotePath) return;
		const key = selectedSessionKey;
		const dir = remotePath;
		let paths: string[];
		try {
			const selected = await openFileDialog({
				multiple: true,
				directory: false,
			});
			if (!selected) return;
			paths = Array.isArray(selected) ? selected : [selected];
		} catch (e) {
			toast({ title: "选择文件失败", description: String(e), tone: "danger" });
			return;
		}
		await enqueueTransfers(
			paths.map((p) => {
				const fileName = p.replace(/\\/g, "/").split("/").pop() || "file";
				return {
					name: fileName,
					direction: "upload" as const,
					hostId: currentTab?.hostId ?? "",
					sessionKey: key,
					localPath: p,
					remotePath: posixJoin(dir, fileName),
				};
			}),
			{
				onItemDone: (item) => toast({ title: `已上传 ${item.name}`, tone: "success" }),
				onItemFailed: (item, error) => toast({ title: `上传失败: ${item.name}`, description: error, tone: "danger" }),
				onFinished: () => loadRemoteDir(key, dir),
			},
		);
	};

	/* ------------------------------ 弹窗提交 ------------------------------ */
	const handleModalSubmit = async () => {
		if (!modalMode) return;
		try {
			if (modalMode === "mkdir") {
				if (!inputName.trim()) return;
				if (modalSide === "local") {
					const newP = localJoin(localPath, inputName.trim());
					await fsLocalMkdir(newP);
					toast({ title: `已创建本地文件夹: ${inputName}`, tone: "success" });
					loadLocalDir(localPath);
				} else {
					if (!selectedSessionKey) return;
					const newP = posixJoin(remotePath, inputName.trim());
					await sftpMkdir(selectedSessionKey, newP);
					toast({ title: `已创建远程文件夹: ${inputName}`, tone: "success" });
					loadRemoteDir(selectedSessionKey, remotePath);
				}
			} else if (modalMode === "touch") {
				if (!inputName.trim()) return;
				if (modalSide === "local") {
					const newP = localJoin(localPath, inputName.trim());
					await fsLocalCreateEmptyFile(newP);
					toast({ title: `已创建本地文本文件: ${inputName}`, tone: "success" });
					loadLocalDir(localPath);
				} else {
					if (!selectedSessionKey) return;
					const newP = posixJoin(remotePath, inputName.trim());
					await sftpCreateEmptyFile(selectedSessionKey, newP);
					toast({ title: `已创建远程文本文件: ${inputName}`, tone: "success" });
					loadRemoteDir(selectedSessionKey, remotePath);
				}
			}
		} catch (e) {
			toast({ title: "操作失败", description: String(e), tone: "danger" });
		} finally {
			setModalMode(null);
			setInputName("");
		}
	};


	return (
		<WindowChrome>
			<div className="relative flex min-h-0 flex-1 flex-col bg-surface">
				{/* 顶栏控制栏 */}
				<div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface-sunk px-3 text-[12px]">
					<div className="flex min-w-0 items-center gap-2.5">
						<span className="shrink-0 font-medium text-surface-foreground">SFTP 远程文件传输</span>
						<span className="text-border">/</span>

						{/* 会话选择器 */}
						{liveSessions.length > 0 ? (
							<div className="flex items-center gap-1.5">
								<span className="size-2 rounded-full bg-success" />
								<select
									value={selectedSessionKey}
									onChange={(e) => {
										const val = e.target.value;
										if (val.startsWith("connect-host:")) {
											const hid = val.replace("connect-host:", "");
											openSession(hid);
											toast({ title: "正在连接主机并挂载 SFTP…", tone: "default" });
										} else {
											setSelectedSessionKey(val);
										}
									}}
									className="h-6.5 max-w-[280px] rounded-control border border-border bg-surface px-2 font-mono text-[11px] text-surface-foreground outline-none focus:border-primary cursor-pointer"
								>
									<optgroup label="已连接的 SSH 会话">
										{liveSessions.map((s) => (
											<option key={s.sessionKey} value={s.sessionKey ?? ""}>
												{s.title} ({s.sessionKey})
											</option>
										))}
									</optgroup>
									{unconnectedHosts.length > 0 && (
										<optgroup label="连接到其他主机…">
											{unconnectedHosts.map((h) => (
												<option key={h.id} value={`connect-host:${h.id}`}>
													+ 连接 {h.name} ({h.username}@{h.hostname})
												</option>
											))}
										</optgroup>
									)}
								</select>
							</div>
						) : (
							<div className="flex items-center gap-2">
								<StatusText status="idle" label="暂无活跃 SSH 会话" className="text-[11px]" />
								{hosts.length > 0 && (
									<select
										defaultValue=""
										onChange={(e) => {
											if (e.target.value) {
												openSession(e.target.value);
												toast({ title: "正在连接主机并挂载 SFTP…", tone: "default" });
											}
										}}
										className="h-6.5 rounded-control border border-border bg-surface px-2 text-[11px] text-primary outline-none cursor-pointer"
									>
										<option value="" disabled>
											选择并连接主机…
										</option>
										{hosts.map((h) => (
											<option key={h.id} value={h.id}>
												{h.name} ({h.username}@{h.hostname})
											</option>
										))}
									</select>
								)}
							</div>
						)}
					</div>

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

				{/* 双栏结构 */}
				<div className="relative flex min-h-0 flex-1">
					{/* ===================== 本地文件系统 (左栏) ===================== */}
					<div
						className="relative flex min-h-0 flex-1 flex-col border-r border-border bg-surface"
						onDragOver={(e) => e.preventDefault()}
						onDrop={(e) => {
							e.preventDefault();
							const remoteJson = e.dataTransfer.getData("application/termx-remote-file");
							if (remoteJson) {
								try {
									const entry: SftpFileEntry = JSON.parse(remoteJson);
									handleDownloadEntries([entry]);
								} catch {}
							}
						}}
					>
						{/* 栏头控制 */}
						<div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-sunk px-3 text-[11.5px]">
							<div className="flex min-w-0 items-center gap-1.5 text-muted">
								<span className="icon-[lucide--laptop] size-3.5 shrink-0 text-primary" />
								<span className="truncate font-medium text-surface-foreground">本地文件系统</span>
							</div>

							<div className="flex items-center gap-1">
								{/* 盘符切换（Windows） */}
								{localDrivesList.length > 0 && (
									<select
										value={localDrivesList.find((d) => localPath.startsWith(d)) || localDrivesList[0]}
										onChange={(e) => loadLocalDir(e.target.value)}
										className="h-6 rounded border border-border bg-surface px-1.5 font-mono text-[10.5px] text-surface-foreground outline-none"
									>
										{localDrivesList.map((d) => (
											<option key={d} value={d}>
												{d}
											</option>
										))}
									</select>
								)}
								<IconButton
									icon="icon-[lucide--home]"
									label="主目录"
									className="size-6"
									onClick={() => fsLocalHome().then(loadLocalDir)}
								/>
								<IconButton
									icon="icon-[lucide--arrow-up]"
									label="上一级目录"
									className="size-6"
									onClick={() => loadLocalDir(localDirname(localPath))}
								/>
								<IconButton
									icon="icon-[lucide--folder-plus]"
									label="新建文件夹"
									className="size-6"
									onClick={() => {
										setModalSide("local");
										setModalMode("mkdir");
										setInputName("");
									}}
								/>
								<IconButton
									icon="icon-[lucide--file-plus]"
									label="新建文本文件"
									className="size-6"
									onClick={() => {
										setModalSide("local");
										setModalMode("touch");
										setInputName("");
									}}
								/>
								<IconButton
									icon="icon-[lucide--refresh-cw]"
									label="刷新"
									className={cn("size-6", localLoading && "animate-spin text-primary")}
									onClick={() => loadLocalDir(localPath)}
								/>
							</div>
						</div>

						{/* 路径与过滤栏 */}
						<div className="flex h-7.5 shrink-0 items-center gap-2 border-b border-border/80 bg-surface-raised/40 px-2 text-[11px]">
							<form
								className="flex min-w-0 flex-1 items-center"
								onSubmit={(e) => {
									e.preventDefault();
									loadLocalDir(localInputPath);
								}}
							>
								<input
									type="text"
									value={localInputPath}
									onChange={(e) => setLocalInputPath(e.target.value)}
									className="h-6 w-full rounded border border-border/70 bg-surface px-2 font-mono text-[11px] text-surface-foreground outline-none focus:border-primary"
									placeholder="本地路径..."
								/>
							</form>
							<div className="relative w-28 shrink-0">
								<input
									type="text"
									value={localFilter}
									onChange={(e) => setLocalFilter(e.target.value)}
									placeholder="筛选..."
									className="h-6 w-full rounded border border-border/70 bg-surface px-2 text-[10.5px] outline-none focus:border-primary"
								/>
								{localFilter && (
									<button
										type="button"
										onClick={() => setLocalFilter("")}
										className="absolute right-1 top-1 text-faint hover:text-surface-foreground"
									>
										×
									</button>
								)}
							</div>
						</div>

						{/* 表头 */}
						<div className="grid shrink-0 grid-cols-[1fr_80px_110px] border-b border-border/60 bg-surface-sunk/40 px-3 py-1 text-[10.5px] tracking-wider text-faint uppercase">
							<button
								type="button"
								onClick={() =>
									setLocalSort((s) => ({
										field: "name",
										dir: s.field === "name" && s.dir === "asc" ? "desc" : "asc",
									}))
								}
								className="flex items-center gap-1 text-left font-medium hover:text-surface-foreground"
							>
								<span>名称</span>
								{localSort.field === "name" && (
									<span
										className={cn(
											"size-3",
											localSort.dir === "asc"
												? "icon-[lucide--chevron-up]"
												: "icon-[lucide--chevron-down]",
										)}
									/>
								)}
							</button>
							<button
								type="button"
								onClick={() =>
									setLocalSort((s) => ({
										field: "size",
										dir: s.field === "size" && s.dir === "asc" ? "desc" : "asc",
									}))
								}
								className="flex items-center justify-end gap-1 font-medium hover:text-surface-foreground"
							>
								<span>大小</span>
								{localSort.field === "size" && (
									<span
										className={cn(
											"size-3",
											localSort.dir === "asc"
												? "icon-[lucide--chevron-up]"
												: "icon-[lucide--chevron-down]",
										)}
									/>
								)}
							</button>
							<button
								type="button"
								onClick={() =>
									setLocalSort((s) => ({
										field: "mtime",
										dir: s.field === "mtime" && s.dir === "asc" ? "desc" : "asc",
									}))
								}
								className="flex items-center justify-end gap-1 font-medium hover:text-surface-foreground"
							>
								<span>修改时间</span>
								{localSort.field === "mtime" && (
									<span
										className={cn(
											"size-3",
											localSort.dir === "asc"
												? "icon-[lucide--chevron-up]"
												: "icon-[lucide--chevron-down]",
										)}
									/>
								)}
							</button>
						</div>

						{/* 文件列表区 */}
						<div
							ref={(el) => {
								localActions.containerRef.current = el;
							}}
							tabIndex={0}
							onKeyDown={localActions.handleKeyDown}
							onContextMenu={(e) => localActions.openContextMenu(e, null)}
							className="relative min-h-0 flex-1 overflow-y-auto outline-none"
						>
							{filteredLocalEntries.length === 0 ? (
								<EmptyState
									icon="icon-[lucide--folder-open]"
									title={localLoading ? "正在读取本地目录..." : "空目录"}
									className="py-12"
								/>
							) : (
								<div className="divide-y divide-border/20 text-[11.5px]">
									{filteredLocalEntries.map((entry) => {
										const isSelected = localSelected.has(entry.name);
										const iconClass = getFileIcon(entry.name, entry.is_dir, entry.is_symlink);
										return (
											<div
												key={entry.name}
												draggable
												onDragStart={(e) => {
													e.dataTransfer.setData(
														"application/termx-local-file",
														JSON.stringify(entry),
													);
												}}
												onClick={(e) => {
													if (e.ctrlKey || e.metaKey) {
														setLocalSelected((prev) => {
															const next = new Set(prev);
															if (next.has(entry.name)) next.delete(entry.name);
															else next.add(entry.name);
															return next;
														});
													} else {
														setLocalSelected(new Set([entry.name]));
													}
												}}
												data-sftp-row={entry.name}
												onDoubleClick={() => localActions.openEntry(entry)}
												onContextMenu={(e) => localActions.openContextMenu(e, entry)}
												className={cn(
													"grid grid-cols-[1fr_80px_110px] items-center px-3 py-1.5 cursor-pointer select-none transition-colors",
													isSelected
														? "bg-primary/15 text-primary font-medium"
														: "hover:bg-surface-raised text-surface-foreground",
												)}
											>
												<div className="flex min-w-0 items-center gap-2">
													<span
														className={cn(
															iconClass,
															"size-4 shrink-0",
															entry.is_dir ? "text-primary" : "text-muted",
														)}
													/>
													<span className="truncate">{entry.name}</span>
												</div>
												<div className="text-right font-mono text-[11px] tabular-nums text-faint">
													{entry.is_dir ? "—" : formatBytes(entry.size)}
												</div>
												<div className="text-right font-mono text-[10.5px] tabular-nums text-faint">
													{formatUnixTime(entry.mtime)}
												</div>
											</div>
										);
									})}
								</div>
							)}
						</div>

						{/* 底部状态 */}
						<div className="flex h-6 shrink-0 items-center justify-between border-t border-border bg-surface-sunk px-3 text-[10.5px] text-faint">
							<span>
								{filteredLocalEntries.length} 项 (已选中 {localSelected.size} 项)
							</span>
							{localSelected.size > 0 && selectedSessionKey && (
								<button
									type="button"
									onClick={() => {
										const selected = localEntries.filter((e) => localSelected.has(e.name));
										handleUploadEntries(selected);
									}}
									className="flex items-center gap-1 font-medium text-primary hover:underline"
								>
									<span>上传选中项至远端</span>
									<span className="icon-[lucide--arrow-right] size-3" />
								</button>
							)}
						</div>
					</div>

					{/* ===================== 中间操作轴 ===================== */}
					<div className="flex w-9 shrink-0 flex-col items-center justify-center gap-3 border-r border-border bg-surface-sunk/60">
						<IconButton
							icon="icon-[lucide--arrow-right]"
							label="上传选中的本地项至远程 (->)"
							className="size-7 rounded-full bg-surface shadow-xs hover:border-primary hover:text-primary"
							disabled={localSelected.size === 0 || !selectedSessionKey}
							onClick={() => {
								const selected = localEntries.filter((e) => localSelected.has(e.name));
								handleUploadEntries(selected);
							}}
						/>
						<IconButton
							icon="icon-[lucide--arrow-left]"
							label="下载选中的远程项至本地 (<-)"
							className="size-7 rounded-full bg-surface shadow-xs hover:border-primary hover:text-primary"
							disabled={remoteSelected.size === 0 || !selectedSessionKey}
							onClick={() => {
								const selected = remoteEntries.filter((e) => remoteSelected.has(e.name));
								handleDownloadEntries(selected);
							}}
						/>
					</div>

					{/* ===================== 远程 SFTP 文件系统 (右栏) ===================== */}
					<div
						className="relative flex min-h-0 flex-1 flex-col bg-surface-raised/20"
						onDragOver={(e) => e.preventDefault()}
						onDrop={(e) => {
							e.preventDefault();
							const localJson = e.dataTransfer.getData("application/termx-local-file");
							if (localJson) {
								try {
									const entry: SftpFileEntry = JSON.parse(localJson);
									handleUploadEntries([entry]);
								} catch {}
							}
						}}
					>
						{/* 栏头控制 */}
						<div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-sunk px-3 text-[11.5px]">
							<div className="flex min-w-0 items-center gap-1.5 text-muted">
								<span className="icon-[lucide--server] size-3.5 shrink-0 text-primary" />
								<span className="truncate font-medium text-surface-foreground">
									{currentTab ? `远程主机: ${currentTab.title}` : "远程主机 (未连接)"}
								</span>
							</div>

							{selectedSessionKey ? (
								<div className="flex items-center gap-1">
									<IconButton
										icon="icon-[lucide--upload]"
										label="从本地挑选文件上传"
										className="size-6 text-primary"
										onClick={handlePickUpload}
									/>
									<IconButton
										icon="icon-[lucide--home]"
										label="远程主目录 (~)"
										className="size-6"
										onClick={() => loadRemoteDir(selectedSessionKey, ".")}
									/>
									<IconButton
										icon="icon-[lucide--arrow-up]"
										label="上一级目录"
										className="size-6"
										onClick={() => loadRemoteDir(selectedSessionKey, posixDirname(remotePath))}
									/>
									<IconButton
										icon="icon-[lucide--folder-plus]"
										label="新建远程文件夹"
										className="size-6"
										onClick={() => {
											setModalSide("remote");
											setModalMode("mkdir");
											setInputName("");
										}}
									/>
									<IconButton
										icon="icon-[lucide--file-plus]"
										label="新建远程文本文件"
										className="size-6"
										onClick={() => {
											setModalSide("remote");
											setModalMode("touch");
											setInputName("");
										}}
									/>
									<IconButton
										icon="icon-[lucide--refresh-cw]"
										label="刷新"
										className={cn("size-6", remoteLoading && "animate-spin text-primary")}
										onClick={() => loadRemoteDir(selectedSessionKey, remotePath)}
									/>
								</div>
							) : null}
						</div>

						{selectedSessionKey ? (
							<>
								{/* 路径与过滤栏 */}
								<div className="flex h-7.5 shrink-0 items-center gap-2 border-b border-border/80 bg-surface-raised/40 px-2 text-[11px]">
									<form
										className="flex min-w-0 flex-1 items-center"
										onSubmit={(e) => {
											e.preventDefault();
											loadRemoteDir(selectedSessionKey, remoteInputPath);
										}}
									>
										<input
											type="text"
											value={remoteInputPath}
											onChange={(e) => setRemoteInputPath(e.target.value)}
											className="h-6 w-full rounded border border-border/70 bg-surface px-2 font-mono text-[11px] text-surface-foreground outline-none focus:border-primary"
											placeholder="远程路径 (例如 /etc/nginx)..."
										/>
									</form>
									<div className="relative w-28 shrink-0">
										<input
											type="text"
											value={remoteFilter}
											onChange={(e) => setRemoteFilter(e.target.value)}
											placeholder="筛选..."
											className="h-6 w-full rounded border border-border/70 bg-surface px-2 text-[10.5px] outline-none focus:border-primary"
										/>
										{remoteFilter && (
											<button
												type="button"
												onClick={() => setRemoteFilter("")}
												className="absolute right-1 top-1 text-faint hover:text-surface-foreground"
											>
												×
											</button>
										)}
									</div>
								</div>

								{/* 表头 */}
								<div className="grid shrink-0 grid-cols-[1fr_80px_110px_70px] border-b border-border/60 bg-surface-sunk/40 px-3 py-1 text-[10.5px] tracking-wider text-faint uppercase">
									<button
										type="button"
										onClick={() =>
											setRemoteSort((s) => ({
												field: "name",
												dir: s.field === "name" && s.dir === "asc" ? "desc" : "asc",
											}))
										}
										className="flex items-center gap-1 text-left font-medium hover:text-surface-foreground"
									>
										<span>名称</span>
										{remoteSort.field === "name" && (
											<span
												className={cn(
													"size-3",
													remoteSort.dir === "asc"
														? "icon-[lucide--chevron-up]"
														: "icon-[lucide--chevron-down]",
												)}
											/>
										)}
									</button>
									<button
										type="button"
										onClick={() =>
											setRemoteSort((s) => ({
												field: "size",
												dir: s.field === "size" && s.dir === "asc" ? "desc" : "asc",
											}))
										}
										className="flex items-center justify-end gap-1 font-medium hover:text-surface-foreground"
									>
										<span>大小</span>
										{remoteSort.field === "size" && (
											<span
												className={cn(
													"size-3",
													remoteSort.dir === "asc"
														? "icon-[lucide--chevron-up]"
														: "icon-[lucide--chevron-down]",
												)}
											/>
										)}
									</button>
									<button
										type="button"
										onClick={() =>
											setRemoteSort((s) => ({
												field: "mtime",
												dir: s.field === "mtime" && s.dir === "asc" ? "desc" : "asc",
											}))
										}
										className="flex items-center justify-end gap-1 font-medium hover:text-surface-foreground"
									>
										<span>修改时间</span>
										{remoteSort.field === "mtime" && (
											<span
												className={cn(
													"size-3",
													remoteSort.dir === "asc"
														? "icon-[lucide--chevron-up]"
														: "icon-[lucide--chevron-down]",
												)}
											/>
										)}
									</button>
									<span className="text-right">权限</span>
								</div>

								{/* 文件列表区 */}
								<div
									ref={(el) => {
										remoteActions.containerRef.current = el;
									}}
									tabIndex={0}
									onKeyDown={remoteActions.handleKeyDown}
									onContextMenu={(e) => remoteActions.openContextMenu(e, null)}
									className="relative min-h-0 flex-1 overflow-y-auto outline-none"
								>
									{filteredRemoteEntries.length === 0 ? (
										<EmptyState
											icon="icon-[lucide--folder-open]"
											title={remoteLoading ? "正在读取远程目录..." : "空目录"}
											className="py-12"
										/>
									) : (
										<div className="divide-y divide-border/20 text-[11.5px]">
											{filteredRemoteEntries.map((entry) => {
												const isSelected = remoteSelected.has(entry.name);
												const iconClass = getFileIcon(entry.name, entry.is_dir, entry.is_symlink);
												return (
													<div
														key={entry.name}
														draggable
														onDragStart={(e) => {
															e.dataTransfer.setData(
																"application/termx-remote-file",
																JSON.stringify(entry),
															);
														}}
														onClick={(e) => {
															if (e.ctrlKey || e.metaKey) {
																setRemoteSelected((prev) => {
																	const next = new Set(prev);
																	if (next.has(entry.name)) next.delete(entry.name);
																	else next.add(entry.name);
																	return next;
																});
															} else {
																setRemoteSelected(new Set([entry.name]));
															}
														}}
														data-sftp-row={entry.name}
														onDoubleClick={() => remoteActions.openEntry(entry)}
														onContextMenu={(e) => remoteActions.openContextMenu(e, entry)}
														className={cn(
															"grid grid-cols-[1fr_80px_110px_70px] items-center px-3 py-1.5 cursor-pointer select-none transition-colors",
															isSelected
																? "bg-primary/15 text-primary font-medium"
																: "hover:bg-surface-raised text-surface-foreground",
														)}
													>
														<div className="flex min-w-0 items-center gap-2">
															<span
																className={cn(
																	iconClass,
																	"size-4 shrink-0",
																	entry.is_dir ? "text-primary" : "text-muted",
																)}
															/>
															<span className="truncate">{entry.name}</span>
														</div>
														<div className="text-right font-mono text-[11px] tabular-nums text-faint">
															{entry.is_dir ? "—" : formatBytes(entry.size)}
														</div>
														<div className="text-right font-mono text-[10.5px] tabular-nums text-faint">
															{formatUnixTime(entry.mtime)}
														</div>
														<div className="text-right font-mono text-[10px] text-faint">
															{entry.permissions_str || "—"}
														</div>
													</div>
												);
											})}
										</div>
									)}
								</div>

								{/* 底部状态 */}
								<div className="flex h-6 shrink-0 items-center justify-between border-t border-border bg-surface-sunk px-3 text-[10.5px] text-faint">
									<span>
										{filteredRemoteEntries.length} 项 (已选中 {remoteSelected.size} 项)
									</span>
									{remoteSelected.size > 0 && (
										<button
											type="button"
											onClick={() => {
												const selected = remoteEntries.filter((e) => remoteSelected.has(e.name));
												handleDownloadEntries(selected);
											}}
											className="flex items-center gap-1 font-medium text-primary hover:underline"
										>
											<span className="icon-[lucide--arrow-left] size-3" />
											<span>下载选中项至本地</span>
										</button>
									)}
								</div>
							</>
						) : (
							<div className="flex min-h-0 flex-1 items-center justify-center p-6">
								<div className="max-w-md w-full rounded-2xl border border-border bg-surface p-6 text-center shadow-sm">
									<div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary mb-3">
										<span className="icon-[lucide--folder-tree] size-6" />
									</div>
									<h3 className="text-[14px] font-semibold text-surface-foreground">SFTP 远程文件管理</h3>
									<p className="mt-1 text-[11.5px] text-muted leading-relaxed">
										SFTP 挂载在活跃 SSH 会话之上。请选择一台远程服务器建立连接以开启双栏文件传输。
									</p>

									{hosts.length > 0 ? (
										<div className="mt-4 space-y-2">
											<div className="text-left text-[11px] font-medium text-faint">选择要管理的主机：</div>
											<div className="max-h-52 overflow-y-auto divide-y divide-border/40 rounded-xl border border-border bg-surface-sunk text-left text-[11.5px]">
												{hosts.map((host) => (
													<div
														key={host.id}
														onClick={() => openSession(host.id)}
														className="flex items-center justify-between p-2.5 hover:bg-surface-raised cursor-pointer transition-colors"
													>
														<div className="min-w-0">
															<div className="font-medium text-surface-foreground truncate">{host.name}</div>
															<div className="font-mono text-[10.5px] text-faint truncate">
																{host.username}@{host.hostname}:{host.port}
															</div>
														</div>
														<button
															type="button"
															className="flex shrink-0 items-center gap-1 rounded bg-primary/15 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/25 transition-colors cursor-pointer"
														>
															<span>连接并挂载</span>
															<span className="icon-[lucide--arrow-right] size-3" />
														</button>
													</div>
												))}
											</div>
										</div>
									) : (
										<Button
											size="sm"
											variant="primary"
											className="mt-4"
											icon="icon-[lucide--server]"
											onClick={() => {
												useSessionsStore.getState().setActiveTab("vaults");
												navigate("/workspace");
											}}
										>
											前往主机库配置主机
										</Button>
									)}
								</div>
							</div>
						)}
					</div>
				</div>

				{/* ===================== 模态弹窗 ===================== */}
				<Modal
					open={modalMode !== null}
					onClose={() => {
						setModalMode(null);
					}}
					title={
						modalMode === "mkdir"
							? `新建文件夹 (${modalSide === "local" ? "本地" : "远程"})`
							: `新建文本文件 (${modalSide === "local" ? "本地" : "远程"})`
					}
					footer={
						<div className="flex items-center gap-2">
							<Button
								size="sm"
								onClick={() => {
									setModalMode(null);
								}}
							>
								取消
							</Button>
							<Button
								size="sm"
								variant="primary"
								onClick={handleModalSubmit}
							>
								确定
							</Button>
						</div>
					}
				>
					{(modalMode === "mkdir" || modalMode === "touch") && (
						<div className="space-y-3">
							<div className="text-muted">
								{modalMode === "mkdir" ? "请输入新文件夹名称：" : "请输入新文件名："}
							</div>
							<Input
								autoFocus
								value={inputName}
								onChange={(e) => setInputName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleModalSubmit();
								}}
								placeholder={modalMode === "mkdir" ? "例如 new_folder" : "例如 config.ini 或 script.sh"}
							/>
						</div>
					)}

				</Modal>
				{localActions.element}
				{remoteActions.element}
			</div>
		</WindowChrome>
	);
}
