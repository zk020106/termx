import { IconButton, Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Display";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Overlay";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import {
	formatUnixTime,
	getFileIcon,
	posixDirname,
	posixJoin,
	sftpDownload,
	sftpList,
	sftpMkdir,
	sftpRealPath,
	sftpRemove,
	sftpRename,
	sftpUpload,
	sftpWriteFile,
	type SftpFileEntry,
} from "@/lib/sftp";
import type { ConnectionStatus } from "@/data/types";
import { toast } from "@/store/toast";
import { useTransfersStore } from "@/store/transfers";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

interface EmbeddedSftpDrawerProps {
	sessionKey: string | null;
	status?: ConnectionStatus;
	hostTitle: string;
	hostId: string | null;
	onClose: () => void;
	onReconnect?: () => void;
}

export function EmbeddedSftpDrawer({
	sessionKey,
	status = "connected",
	hostTitle,
	hostId,
	onClose,
	onReconnect,
}: EmbeddedSftpDrawerProps) {
	const navigate = useNavigate();

	// 抽屉高度与拖拽缩放
	const [height, setHeight] = useState<number>(270);
	const isDraggingRef = useRef<boolean>(false);
	const startYRef = useRef<number>(0);
	const startHeightRef = useRef<number>(270);

	const [remotePath, setRemotePath] = useState<string>("");
	const [remoteInputPath, setRemoteInputPath] = useState<string>("");
	const [isEditingPath, setIsEditingPath] = useState<boolean>(false);
	const [entries, setEntries] = useState<SftpFileEntry[]>([]);
	const [loading, setLoading] = useState<boolean>(false);
	const [filter, setFilter] = useState<string>("");
	const [selected, setSelected] = useState<string | null>(null);

	// 模态弹窗状态
	const [modalMode, setModalMode] = useState<"mkdir" | "touch" | "rename" | "delete" | null>(null);
	const [targetEntry, setTargetEntry] = useState<SftpFileEntry | null>(null);
	const [inputName, setInputName] = useState<string>("");

	// 右键菜单
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry?: SftpFileEntry } | null>(null);

	// 拖拽改变高度
	const handleMouseDown = useCallback((e: React.MouseEvent) => {
		isDraggingRef.current = true;
		startYRef.current = e.clientY;
		startHeightRef.current = height;
		document.body.style.cursor = "row-resize";
		document.body.style.userSelect = "none";

		const handleMouseMove = (ev: MouseEvent) => {
			if (!isDraggingRef.current) return;
			const delta = startYRef.current - ev.clientY;
			const newH = Math.max(160, Math.min(560, startHeightRef.current + delta));
			setHeight(newH);
		};

		const handleMouseUp = () => {
			isDraggingRef.current = false;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
		};

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);
	}, [height]);

	const loadDir = useCallback(async (path: string) => {
		if (!sessionKey) return;
		setLoading(true);
		try {
			const resolved = await sftpRealPath(sessionKey, path);
			const list = await sftpList(sessionKey, resolved);
			setEntries(list);
			setRemotePath(resolved);
			setRemoteInputPath(resolved);
			setIsEditingPath(false);
			setSelected(null);
		} catch (e) {
			toast({ title: "读取远程目录失败", description: String(e), tone: "danger" });
		} finally {
			setLoading(false);
		}
	}, [sessionKey]);

	// 仅在 SSH 连接成功且 sessionKey 存在时才加载远程文件
	useEffect(() => {
		if (sessionKey && status === "connected") {
			loadDir(".");
		} else if (!sessionKey || status === "disconnected" || status === "failed") {
			setEntries([]);
			setRemotePath("");
		}
	}, [sessionKey, status, loadDir]);

	// 过滤与排序
	const filteredEntries = useMemo(() => {
		const list = entries.filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()));
		list.sort((a, b) => {
			if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		return list;
	}, [entries, filter]);

	// 上传文件
	const handleUpload = async () => {
		if (!sessionKey || !remotePath) return;
		try {
			const res = await openFileDialog({ multiple: true });
			if (!res) return;
			const paths = Array.isArray(res) ? res : [res];
			for (const p of paths) {
				const fileName = p.replace(/\\/g, "/").split("/").pop() || "file";
				const targetPath = posixJoin(remotePath, fileName);
				const transferId = `trans-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
				useTransfersStore.getState().upsert({
					id: transferId,
					name: fileName,
					direction: "upload",
					hostId: hostId ?? "",
					localPath: p,
					remotePath: targetPath,
					size: 0,
					transferred: 0,
					speedBps: 0,
					state: "running",
				});
				try {
					const size = await sftpUpload(sessionKey, p, targetPath);
					useTransfersStore.getState().upsert({
						id: transferId,
						name: fileName,
						direction: "upload",
						hostId: hostId ?? "",
						localPath: p,
						remotePath: targetPath,
						size,
						transferred: size,
						speedBps: 0,
						state: "done",
					});
					toast({ title: `上传完成: ${fileName}`, tone: "success" });
				} catch (e) {
					useTransfersStore.getState().setState(transferId, "failed");
					toast({ title: `上传失败: ${fileName}`, description: String(e), tone: "danger" });
				}
			}
			loadDir(remotePath);
		} catch (e) {
			toast({ title: "选择文件失败", description: String(e), tone: "danger" });
		}
	};

	// 下载文件
	const handleDownload = async (entry: SftpFileEntry) => {
		if (!sessionKey || entry.is_dir) return;
		try {
			const dest = await saveFileDialog({ defaultPath: entry.name });
			if (!dest) return;
			const transferId = `trans-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			useTransfersStore.getState().upsert({
				id: transferId,
				name: entry.name,
				direction: "download",
				hostId: hostId ?? "",
				localPath: dest,
				remotePath: entry.path,
				size: entry.size,
				transferred: 0,
				speedBps: 0,
				state: "running",
			});
			try {
				const size = await sftpDownload(sessionKey, entry.path, dest);
				useTransfersStore.getState().upsert({
					id: transferId,
					name: entry.name,
					direction: "download",
					hostId: hostId ?? "",
					localPath: dest,
					remotePath: entry.path,
					size,
					transferred: size,
					speedBps: 0,
					state: "done",
				});
				toast({ title: `下载完成: ${entry.name}`, tone: "success" });
			} catch (e) {
				useTransfersStore.getState().setState(transferId, "failed");
				toast({ title: `下载失败: ${entry.name}`, description: String(e), tone: "danger" });
			}
		} catch (e) {
			toast({ title: "保存文件失败", description: String(e), tone: "danger" });
		}
	};

	// 弹窗提交（新建目录、新建文件、重命名、删除）
	const handleModalSubmit = async () => {
		if (!modalMode || !sessionKey) return;
		try {
			if (modalMode === "mkdir") {
				if (!inputName.trim()) return;
				const newP = posixJoin(remotePath, inputName.trim());
				await sftpMkdir(sessionKey, newP);
				toast({ title: `已创建目录: ${inputName}`, tone: "success" });
				loadDir(remotePath);
			} else if (modalMode === "touch") {
				if (!inputName.trim()) return;
				const newP = posixJoin(remotePath, inputName.trim());
				await sftpWriteFile(sessionKey, newP, "");
				toast({ title: `已创建空文件: ${inputName}`, tone: "success" });
				loadDir(remotePath);
			} else if (modalMode === "rename" && targetEntry) {
				if (!inputName.trim()) return;
				const parent = posixDirname(targetEntry.path);
				const newP = posixJoin(parent, inputName.trim());
				await sftpRename(sessionKey, targetEntry.path, newP);
				toast({ title: `已重命名为: ${inputName}`, tone: "success" });
				loadDir(remotePath);
			} else if (modalMode === "delete" && targetEntry) {
				await sftpRemove(sessionKey, targetEntry.path, targetEntry.is_dir);
				toast({ title: `已删除: ${targetEntry.name}`, tone: "success" });
				loadDir(remotePath);
			}
		} catch (e) {
			toast({ title: "操作失败", description: String(e), tone: "danger" });
		} finally {
			setModalMode(null);
			setTargetEntry(null);
			setInputName("");
		}
	};

	// 关闭右键菜单
	useEffect(() => {
		const onClick = () => setContextMenu(null);
		window.addEventListener("click", onClick);
		return () => window.removeEventListener("click", onClick);
	}, []);

	// 分割路径为面包屑
	const pathSegments = useMemo(() => {
		if (!remotePath) return [];
		const parts = remotePath.split("/").filter(Boolean);
		return parts.map((part, index) => {
			const subPath = "/" + parts.slice(0, index + 1).join("/");
			return { name: part, path: subPath };
		});
	}, [remotePath]);

	// 待连接或连接中状态渲染
	if (status === "connecting" || status === "reconnecting") {
		return (
			<div
				style={{ height }}
				className="relative flex shrink-0 flex-col border-t border-border bg-surface select-none z-10"
			>
				<div
					onMouseDown={handleMouseDown}
					className="group/resizer absolute -top-1 left-0 right-0 h-2 cursor-row-resize z-20 flex items-center justify-center"
				>
					<div className="h-0.5 w-12 rounded-full bg-border group-hover/resizer:bg-primary transition-colors" />
				</div>
				<div className="flex h-7.5 shrink-0 items-center justify-between border-b border-border bg-surface-raised px-3 text-[11px]">
					<div className="flex items-center gap-2">
						<span className="icon-[lucide--folder-tree] size-3.5 text-primary" />
						<span className="font-medium text-surface-foreground">{hostTitle}</span>
						<span className="text-border">·</span>
						<span className="font-sans text-faint">内嵌 SFTP</span>
					</div>
					<IconButton icon="icon-[lucide--x]" label="关闭" className="size-5" onClick={onClose} />
				</div>
				<div className="flex flex-1 flex-col items-center justify-center p-6 text-muted">
					<span className="icon-[lucide--loader-2] size-5 animate-spin text-primary mb-2" />
					<span className="text-[12px] font-medium text-surface-foreground">正在建立 SSH 会话并挂载 SFTP 文件系统…</span>
					<span className="text-[10px] text-faint mt-1">连接完成后将自动载入目录</span>
				</div>
			</div>
		);
	}

	if (!sessionKey || status === "disconnected" || status === "failed") {
		return (
			<div
				style={{ height }}
				className="relative flex shrink-0 flex-col border-t border-border bg-surface select-none z-10"
			>
				<div
					onMouseDown={handleMouseDown}
					className="group/resizer absolute -top-1 left-0 right-0 h-2 cursor-row-resize z-20 flex items-center justify-center"
				>
					<div className="h-0.5 w-12 rounded-full bg-border group-hover/resizer:bg-primary transition-colors" />
				</div>
				<div className="flex h-7.5 shrink-0 items-center justify-between border-b border-border bg-surface-raised px-3 text-[11px]">
					<div className="flex items-center gap-2">
						<span className="icon-[lucide--folder-tree] size-3.5 text-muted" />
						<span className="font-medium text-surface-foreground">{hostTitle}</span>
						<span className="text-border">·</span>
						<span className="font-sans text-faint">内嵌 SFTP (离线)</span>
					</div>
					<IconButton icon="icon-[lucide--x]" label="关闭" className="size-5" onClick={onClose} />
				</div>
				<div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
					<EmptyState
						icon="icon-[lucide--plug-zap]"
						title="SSH 会话已离线"
						description="当前终端未保持活跃 SSH 连接，SFTP 文件传输已暂停。"
						action={
							onReconnect ? (
								<Button size="sm" variant="primary" icon="icon-[lucide--refresh-cw]" onClick={onReconnect}>
									重新连接终端
								</Button>
							) : undefined
						}
					/>
				</div>
			</div>
		);
	}

	return (
		<div
			style={{ height }}
			className="relative flex shrink-0 flex-col border-t border-border bg-surface select-none z-10 shadow-lg"
			onContextMenu={(e) => {
				// 点击空白区呼出上下文菜单
				if ((e.target as HTMLElement).closest(".file-row")) return;
				e.preventDefault();
				setContextMenu({ x: e.clientX, y: e.clientY });
			}}
		>
			{/* 拖拽高度调节手柄 */}
			<div
				onMouseDown={handleMouseDown}
				title="拖拽调节 SFTP 面板高度"
				className="group/resizer absolute -top-1 left-0 right-0 h-2 cursor-row-resize z-20 flex items-center justify-center"
			>
				<div className="h-0.75 w-12 rounded-full bg-border/80 group-hover/resizer:bg-primary transition-colors" />
			</div>

			{/* 头部控制条 */}
			<div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-surface-raised px-2.5 text-[11px]">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<span className="icon-[lucide--folder-tree] size-3.5 text-primary shrink-0" />
					<span className="font-medium text-surface-foreground truncate max-w-[120px]">{hostTitle}</span>
					<span className="text-border/80">/</span>

					{/* 路径与面包屑 */}
					{isEditingPath ? (
						<form
							onSubmit={(e) => {
								e.preventDefault();
								loadDir(remoteInputPath);
							}}
							className="flex items-center flex-1 max-w-[360px]"
						>
							<input
								autoFocus
								type="text"
								value={remoteInputPath}
								onBlur={() => setIsEditingPath(false)}
								onChange={(e) => setRemoteInputPath(e.target.value)}
								className="h-6 w-full rounded border border-primary bg-surface px-2 font-mono text-[10.5px] text-surface-foreground outline-none shadow-2xs"
							/>
						</form>
					) : (
						<div
							onClick={() => setIsEditingPath(true)}
							title="点击直接输入路径"
							className="flex items-center gap-0.5 font-mono text-[11px] text-surface-foreground overflow-x-auto py-0.5 px-1 rounded hover:bg-surface cursor-text border border-transparent hover:border-border/60 transition-colors"
						>
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									loadDir("/");
								}}
								className="hover:text-primary px-0.5 rounded"
							>
								/
							</button>
							{pathSegments.map((seg, i) => (
								<div key={seg.path} className="flex items-center">
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											loadDir(seg.path);
										}}
										className={cn(
											"hover:text-primary px-1 py-0.2 rounded hover:bg-surface-raised transition-colors",
											i === pathSegments.length - 1 && "font-semibold text-primary",
										)}
									>
										{seg.name}
									</button>
									{i < pathSegments.length - 1 && <span className="text-faint">/</span>}
								</div>
							))}
						</div>
					)}

					{/* 常用路径快捷书签 */}
					<div className="hidden lg:flex items-center gap-1 ml-2 text-[10px] text-faint">
						<button
							type="button"
							onClick={() => loadDir(".")}
							className="rounded px-1.5 py-0.5 hover:bg-surface hover:text-surface-foreground transition-colors cursor-pointer"
							title="用户主目录 (~)"
						>
							~
						</button>
						<button
							type="button"
							onClick={() => loadDir("/etc")}
							className="rounded px-1.5 py-0.5 hover:bg-surface hover:text-surface-foreground transition-colors cursor-pointer"
							title="配置文件目录 (/etc)"
						>
							/etc
						</button>
						<button
							type="button"
							onClick={() => loadDir("/var/log")}
							className="rounded px-1.5 py-0.5 hover:bg-surface hover:text-surface-foreground transition-colors cursor-pointer"
							title="系统日志目录 (/var/log)"
						>
							/var/log
						</button>
					</div>
				</div>

				{/* 右侧动作工具栏 */}
				<div className="flex items-center gap-1 text-muted">
					<div className="relative">
						<input
							type="text"
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="过滤项…"
							className="h-6 w-24 rounded border border-border/70 bg-surface px-1.5 text-[10.5px] outline-none focus:w-36 focus:border-primary transition-all"
						/>
						{filter && (
							<button
								type="button"
								onClick={() => setFilter("")}
								className="absolute right-1 top-1 text-faint hover:text-surface-foreground"
							>
								×
							</button>
						)}
					</div>

					<IconButton
						icon="icon-[lucide--arrow-up]"
						label="上一级目录"
						className="size-6"
						onClick={() => loadDir(posixDirname(remotePath))}
					/>
					<IconButton
						icon="icon-[lucide--folder-plus]"
						label="新建文件夹"
						className="size-6"
						onClick={() => {
							setModalMode("mkdir");
							setInputName("");
						}}
					/>
					<IconButton
						icon="icon-[lucide--file-plus]"
						label="新建文本文件"
						className="size-6"
						onClick={() => {
							setModalMode("touch");
							setInputName("");
						}}
					/>
					<IconButton
						icon="icon-[lucide--upload]"
						label="上传文件到此目录"
						className="size-6 text-primary hover:bg-primary/10"
						onClick={handleUpload}
					/>
					<IconButton
						icon="icon-[lucide--refresh-cw]"
						label="刷新"
						className={cn("size-6", loading && "animate-spin text-primary")}
						onClick={() => loadDir(remotePath)}
					/>
					<div className="h-3.5 w-px bg-border mx-1" />
					<Link
						to={`/sftp?hostId=${hostId ?? ""}`}
						className="flex items-center gap-1 rounded px-1.5 py-1 text-[10.5px] font-medium text-primary hover:bg-primary/10 transition-colors"
						title="在全屏双栏模式中打开 SFTP"
					>
						<span>双栏全屏</span>
						<span className="icon-[lucide--external-link] size-3" />
					</Link>
					<IconButton
						icon="icon-[lucide--x]"
						label="收起面板 (Ctrl Shift S)"
						className="size-6 hover:text-danger"
						onClick={onClose}
					/>
				</div>
			</div>

			{/* 表头 */}
			<div className="grid shrink-0 grid-cols-[1fr_80px_120px_75px] border-b border-border/60 bg-surface-sunk/60 px-3 py-1 text-[10px] tracking-wider text-faint uppercase font-medium">
				<span>名称</span>
				<span className="text-right">大小</span>
				<span className="text-right">修改时间</span>
				<span className="text-right">权限</span>
			</div>

			{/* 文件列表 */}
			<div className="relative min-h-0 flex-1 overflow-y-auto">
				{filteredEntries.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center p-6 text-center text-faint">
						<span className="icon-[lucide--folder-open] size-7 opacity-40 mb-1" />
						<span className="text-[11px]">{loading ? "正在读取远程文件…" : "当前目录为空"}</span>
						{!loading && (
							<div className="mt-2 flex items-center gap-2">
								<button
									type="button"
									onClick={() => {
										setModalMode("touch");
										setInputName("");
									}}
									className="text-[10.5px] text-primary hover:underline cursor-pointer"
								>
									+ 新建文件
								</button>
								<span>·</span>
								<button
									type="button"
									onClick={handleUpload}
									className="text-[10.5px] text-primary hover:underline cursor-pointer"
								>
									上传文件
								</button>
							</div>
						)}
					</div>
				) : (
					<div className="divide-y divide-border/20 text-[11px]">
						{filteredEntries.map((entry) => {
							const isSelected = selected === entry.name;
							const iconClass = getFileIcon(entry.name, entry.is_dir, entry.is_symlink);
							return (
								<div
									key={entry.name}
									onClick={() => setSelected(entry.name)}
									onDoubleClick={() => {
										if (entry.is_dir) {
											loadDir(entry.path);
										} else {
											navigate(
												`/editor?sessionKey=${sessionKey}&path=${encodeURIComponent(
													entry.path,
												)}&name=${encodeURIComponent(entry.name)}&hostId=${hostId ?? ""}`,
											);
										}
									}}
									onContextMenu={(e) => {
										e.preventDefault();
										e.stopPropagation();
										setSelected(entry.name);
										setContextMenu({ x: e.clientX, y: e.clientY, entry });
									}}
									className={cn(
										"file-row grid grid-cols-[1fr_80px_120px_75px] items-center px-3 py-1 cursor-pointer transition-colors select-none",
										isSelected
											? "bg-primary/15 text-primary font-medium"
											: "hover:bg-surface-raised text-surface-foreground",
									)}
								>
									<div className="flex min-w-0 items-center gap-1.5">
										<span
											className={cn(
												iconClass,
												"size-3.5 shrink-0",
												entry.is_dir ? "text-primary" : "text-muted",
											)}
										/>
										<span className="truncate">{entry.name}</span>
									</div>
									<div className="text-right font-mono text-[10.5px] tabular-nums text-faint">
										{entry.is_dir ? "—" : formatBytes(entry.size)}
									</div>
									<div className="text-right font-mono text-[10px] tabular-nums text-faint">
										{formatUnixTime(entry.mtime)}
									</div>
									<div className="text-right font-mono text-[9.5px] text-faint">
										{entry.permissions_str || "—"}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>

			{/* 底部微型状态栏 */}
			<div className="flex h-5.5 shrink-0 items-center justify-between border-t border-border bg-surface-sunk px-3 text-[10px] text-faint font-mono">
				<span className="truncate max-w-[60%]">
					{filteredEntries.length} 项 · {remotePath}
				</span>
				<span>双击目录进入 · 双击文件编辑 · 右键查看更多操作</span>
			</div>

			{/* 右键上下文菜单 */}
			{contextMenu && (
				<div
					style={{
						left: Math.min(contextMenu.x, window.innerWidth - 200),
						top: Math.min(contextMenu.y - 120, window.innerHeight - 240),
					}}
					onClick={(e) => e.stopPropagation()}
					className="fixed z-50 flex w-48 flex-col rounded-card border border-border bg-surface-raised py-1 text-[11px] shadow-xl animate-in fade-in zoom-in-95 duration-75"
				>
					{contextMenu.entry ? (
						<>
							{!contextMenu.entry.is_dir ? (
								<>
									<button
										type="button"
										onClick={() => {
											navigate(
												`/editor?sessionKey=${sessionKey}&path=${encodeURIComponent(
													contextMenu.entry!.path,
												)}&name=${encodeURIComponent(contextMenu.entry!.name)}&hostId=${hostId ?? ""}`,
											);
											setContextMenu(null);
										}}
										className="flex items-center gap-2 px-3 py-1.5 text-left text-surface-foreground hover:bg-primary/10 hover:text-primary transition-colors"
									>
										<span className="icon-[lucide--file-code] size-3.5 text-primary" />
										<span>在编辑器中编辑</span>
									</button>
									<button
										type="button"
										onClick={() => {
											handleDownload(contextMenu.entry!);
											setContextMenu(null);
										}}
										className="flex items-center gap-2 px-3 py-1.5 text-left text-surface-foreground hover:bg-primary/10 hover:text-primary transition-colors"
									>
										<span className="icon-[lucide--download] size-3.5" />
										<span>下载到本地…</span>
									</button>
								</>
							) : (
								<button
									type="button"
									onClick={() => {
										loadDir(contextMenu.entry!.path);
										setContextMenu(null);
									}}
									className="flex items-center gap-2 px-3 py-1.5 text-left text-surface-foreground hover:bg-primary/10 hover:text-primary transition-colors"
								>
									<span className="icon-[lucide--folder-open] size-3.5 text-primary" />
									<span>进入该目录</span>
								</button>
							)}

							<div className="my-1 border-t border-border/60" />

							<button
								type="button"
								onClick={() => {
									setTargetEntry(contextMenu.entry!);
									setInputName(contextMenu.entry!.name);
									setModalMode("rename");
									setContextMenu(null);
								}}
								className="flex items-center gap-2 px-3 py-1.5 text-left text-surface-foreground hover:bg-surface transition-colors"
							>
								<span className="icon-[lucide--edit-3] size-3.5" />
								<span>重命名</span>
							</button>
							<button
								type="button"
								onClick={() => {
									navigator.clipboard.writeText(contextMenu.entry!.path);
									toast({ title: "已复制远程路径", tone: "default" });
									setContextMenu(null);
								}}
								className="flex items-center gap-2 px-3 py-1.5 text-left text-surface-foreground hover:bg-surface transition-colors"
							>
								<span className="icon-[lucide--copy] size-3.5" />
								<span>复制路径</span>
							</button>

							<div className="my-1 border-t border-border/60" />

							<button
								type="button"
								onClick={() => {
									setTargetEntry(contextMenu.entry!);
									setModalMode("delete");
									setContextMenu(null);
								}}
								className="flex items-center gap-2 px-3 py-1.5 text-left text-danger hover:bg-danger/10 transition-colors"
							>
								<span className="icon-[lucide--trash-2] size-3.5" />
								<span>删除</span>
							</button>
						</>
					) : (
						/* 空白区域右键菜单 */
						<>
							<button
								type="button"
								onClick={() => {
									setModalMode("touch");
									setInputName("");
									setContextMenu(null);
								}}
								className="flex items-center gap-2 px-3 py-1.5 text-left text-surface-foreground hover:bg-surface transition-colors"
							>
								<span className="icon-[lucide--file-plus] size-3.5 text-primary" />
								<span>新建文本文件</span>
							</button>
							<button
								type="button"
								onClick={() => {
									setModalMode("mkdir");
									setInputName("");
									setContextMenu(null);
								}}
								className="flex items-center gap-2 px-3 py-1.5 text-left text-surface-foreground hover:bg-surface transition-colors"
							>
								<span className="icon-[lucide--folder-plus] size-3.5" />
								<span>新建目录</span>
							</button>
							<button
								type="button"
								onClick={() => {
									handleUpload();
									setContextMenu(null);
								}}
								className="flex items-center gap-2 px-3 py-1.5 text-left text-surface-foreground hover:bg-surface transition-colors"
							>
								<span className="icon-[lucide--upload] size-3.5" />
								<span>上传文件到此目录</span>
							</button>
							<div className="my-1 border-t border-border/60" />
							<button
								type="button"
								onClick={() => {
									loadDir(remotePath);
									setContextMenu(null);
								}}
								className="flex items-center gap-2 px-3 py-1.5 text-left text-surface-foreground hover:bg-surface transition-colors"
							>
								<span className="icon-[lucide--refresh-cw] size-3.5" />
								<span>刷新</span>
							</button>
						</>
					)}
				</div>
			)}

			{/* 模态弹窗 */}
			<Modal
				open={modalMode !== null}
				onClose={() => {
					setModalMode(null);
					setTargetEntry(null);
				}}
				title={
					modalMode === "mkdir"
						? "新建远程目录"
						: modalMode === "touch"
						? "新建文本文件"
						: modalMode === "rename"
						? "重命名"
						: "确认删除"
				}
				footer={
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => {
								setModalMode(null);
								setTargetEntry(null);
							}}
							className="rounded px-2.5 py-1 text-[11px] text-muted hover:bg-surface"
						>
							取消
						</button>
						<button
							type="button"
							onClick={handleModalSubmit}
							className={cn(
								"rounded px-3 py-1 text-[11px] font-medium text-white shadow-xs",
								modalMode === "delete" ? "bg-danger hover:bg-danger/90" : "bg-primary hover:bg-primary/90",
							)}
						>
							{modalMode === "delete" ? "确认删除" : "确定"}
						</button>
					</div>
				}
			>
				{modalMode === "mkdir" && (
					<div className="space-y-3">
						<div className="text-muted">请输入新目录名称：</div>
						<Input
							autoFocus
							value={inputName}
							onChange={(e) => setInputName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") handleModalSubmit();
							}}
							placeholder="例如 logs 或 www"
						/>
					</div>
				)}

				{modalMode === "touch" && (
					<div className="space-y-3">
						<div className="text-muted">请输入新文件名：</div>
						<Input
							autoFocus
							value={inputName}
							onChange={(e) => setInputName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") handleModalSubmit();
							}}
							placeholder="例如 config.json 或 test.txt"
						/>
					</div>
				)}

				{modalMode === "rename" && (
					<div className="space-y-3">
						<div className="text-muted">请输入新名称：</div>
						<Input
							autoFocus
							value={inputName}
							onChange={(e) => setInputName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") handleModalSubmit();
							}}
						/>
					</div>
				)}

				{modalMode === "delete" && targetEntry && (
					<div className="space-y-2">
						<div className="text-surface-foreground">
							确认删除「<span className="font-semibold text-danger">{targetEntry.name}</span>」吗？
						</div>
						<div className="text-[11px] text-faint">此操作不可撤销。</div>
					</div>
				)}
			</Modal>
		</div>
	);
}
