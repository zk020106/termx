import { IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Overlay";
import type { Host, SessionTab } from "@/data/types";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import {
	getFileIcon,
	posixDirname,
	posixJoin,
	sftpList,
	sftpMkdir,
	sftpRealPath,
	sftpCreateEmptyFile,
	type SftpFileEntry,
} from "@/lib/sftp";
import { useHostsStore } from "@/store/hosts";
import { enqueueTransfers } from "@/lib/transferManager";
import { toast } from "@/store/toast";
import { useUiStore } from "@/store/ui";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useSftpPaneActions, type SftpPaneRef } from "@/components/sftp/useSftpPaneActions";
import { useSettingsStore } from "@/store/settings";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

interface SftpSidebarProps {
	activeTab: SessionTab | null;
	activeHost: Host | null;
	onOpenHost: (host: Host) => void;
}

export function SftpSidebar({ activeTab, activeHost, onOpenHost }: SftpSidebarProps) {
	const hosts = useHostsStore((s) => s.hosts);
	const toggleEmbeddedSftp = useUiStore((s) => s.toggleEmbeddedSftp);
	const embeddedSftpOpen = useUiStore((s) => s.embeddedSftpOpen);

	const sessionKey = activeTab?.sessionKey ?? null;
	const isConnected = activeTab?.status === "connected" && Boolean(sessionKey);
	const isConnecting = activeTab?.status === "connecting" || activeTab?.status === "reconnecting";

	const [remotePath, setRemotePath] = useState<string>("");
	const [entries, setEntries] = useState<SftpFileEntry[]>([]);
	const [loading, setLoading] = useState<boolean>(false);
	const [filter, setFilter] = useState<string>("");
	const [selected, setSelected] = useState<Set<string>>(new Set());

	// 弹窗状态
	const [modalMode, setModalMode] = useState<"mkdir" | "touch" | null>(null);
	const [inputName, setInputName] = useState<string>("");


	const loadDir = useCallback(
		async (path: string) => {
			if (!sessionKey) return;
			setLoading(true);
			try {
				const resolved = await sftpRealPath(sessionKey, path);
				const list = await sftpList(sessionKey, resolved);
				setEntries(list);
				setRemotePath(resolved);
				setSelected(new Set());
			} catch (e) {
				toast({ title: "读取远程目录失败", description: String(e), tone: "danger" });
			} finally {
				setLoading(false);
			}
		},
		[sessionKey],
	);

	useEffect(() => {
		if (isConnected && sessionKey) {
			loadDir(".");
		} else if (!isConnected) {
			setEntries([]);
			setRemotePath("");
		}
	}, [isConnected, sessionKey, loadDir]);

	// 过滤与排序（Netcatty sftpShowHiddenFiles）
	const showHidden = useSettingsStore((s) => s.sftpShowHiddenFiles);
	const filteredEntries = useMemo(() => {
		const list = entries.filter((e) => (showHidden || !e.name.startsWith(".")) && e.name.toLowerCase().includes(filter.toLowerCase()));
		list.sort((a, b) => {
			if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		return list;
	}, [entries, filter, showHidden]);

	// 上传文件
	const handleUpload = async () => {
		if (!sessionKey || !remotePath) return;
		const key = sessionKey;
		const dir = remotePath;
		let paths: string[];
		try {
			const res = await openFileDialog({ multiple: true });
			if (!res) return;
			paths = Array.isArray(res) ? res : [res];
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
					hostId: activeHost?.id ?? "",
					sessionKey: key,
					localPath: p,
					remotePath: posixJoin(dir, fileName),
				};
			}),
			{
				onItemDone: (item) => toast({ title: `上传完成: ${item.name}`, tone: "success" }),
				onItemFailed: (item, error) => toast({ title: `上传失败: ${item.name}`, description: error, tone: "danger" }),
				onFinished: () => loadDir(dir),
			},
		);
	};

	// 弹窗提交
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
				await sftpCreateEmptyFile(sessionKey, newP);
				toast({ title: `已创建文本文件: ${inputName}`, tone: "success" });
				loadDir(remotePath);
			}
		} catch (e) {
			toast({ title: "操作失败", description: String(e), tone: "danger" });
		} finally {
			setModalMode(null);
			setInputName("");
		}
	};

	// 右键菜单 / 快捷键 / 打开方式 / 解压…（对齐 Netcatty SFTP 侧栏，没有「另一侧」）
	const pane: SftpPaneRef = useMemo(
		() => ({
			target: { side: "remote", sessionKey, hostId: activeHost?.id ?? null },
			currentPath: remotePath,
			reload: () => loadDir(remotePath),
		}),
		[sessionKey, activeHost?.id, remotePath, loadDir],
	);
	const actions = useSftpPaneActions({
		pane,
		entries: filteredEntries,
		selected,
		setSelected,
		navigate: (path) => void loadDir(path),
		hostLabel: activeHost?.name,
	});

	return (
		<div className="flex h-full flex-col bg-surface-sunk select-none text-[11px]">
			{/* 顶栏：标题 + 活动主机 + 双栏全屏 */}
			<div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-2.5">
				<div className="flex items-center gap-1.5 min-w-0">
					<span className="icon-[lucide--folder-tree] size-3.5 text-primary shrink-0" />
					<span className="font-semibold tracking-tight text-surface-foreground truncate">
						{activeHost ? activeHost.name : "文件 (SFTP)"}
					</span>
				</div>
				<div className="flex items-center gap-1 shrink-0">
					<button
						type="button"
						onClick={toggleEmbeddedSftp}
						className={cn(
							"flex size-5.5 items-center justify-center rounded transition-colors cursor-pointer",
							embeddedSftpOpen ? "bg-primary/20 text-primary" : "text-muted hover:bg-surface-raised hover:text-surface-foreground",
						)}
						title={embeddedSftpOpen ? "收起底部 SFTP 面板" : "展开底部 SFTP 面板"}
					>
						<span className="icon-[lucide--panel-bottom] size-3.5" />
					</button>
					<Link
						to={activeHost ? `/sftp?hostId=${activeHost.id}` : "/sftp"}
						className="flex size-5.5 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-primary transition-colors"
						title="前往双栏全屏传输"
					>
						<span className="icon-[lucide--external-link] size-3" />
					</Link>
				</div>
			</div>

			{/* 未连接状态或连接中状态 */}
			{isConnecting ? (
				<div className="flex flex-1 flex-col items-center justify-center p-4 text-center text-muted">
					<span className="icon-[lucide--loader-2] size-5 animate-spin text-primary mb-2" />
					<div className="font-medium text-surface-foreground">正在挂载 SFTP…</div>
					<div className="text-[10px] text-faint mt-1">连接 SSH 中，请稍候</div>
				</div>
			) : !isConnected ? (
				<div className="flex flex-1 flex-col p-3 text-muted">
					<div className="rounded-card border border-dashed border-border/80 bg-surface/50 p-3 text-center">
						<span className="icon-[lucide--plug-zap] size-6 text-muted/60 mx-auto mb-1.5" />
						<div className="font-medium text-surface-foreground text-[11.5px]">未连接远程主机</div>
						<div className="text-[10px] text-faint mt-1 leading-relaxed">
							连接任意 SSH 主机后，侧边栏将自动载入并展示远程文件树。
						</div>
					</div>

					{hosts.length > 0 && (
						<div className="mt-4 flex-1 min-h-0 flex flex-col">
							<div className="text-[10px] font-semibold uppercase tracking-wider text-faint mb-1.5 px-1">
								快速连接主机
							</div>
							<div className="space-y-1 overflow-y-auto flex-1 min-h-0">
								{hosts.map((host) => (
									<button
										key={host.id}
										type="button"
										onClick={() => onOpenHost(host)}
										className="w-full text-left rounded-lg border border-border/50 bg-surface/60 p-2 hover:bg-surface hover:border-primary/40 transition-colors duration-150 cursor-pointer group"
									>
										<div className="flex items-center justify-between">
											<span className="font-medium text-surface-foreground group-hover:text-primary truncate">
												{host.name}
											</span>
											<span className="icon-[lucide--arrow-right] size-3 text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
										</div>
										<div className="font-mono text-[9.5px] text-faint truncate mt-0.5">
											{host.username}@{host.hostname}:{host.port}
										</div>
									</button>
								))}
							</div>
						</div>
					)}
				</div>
			) : (
				/* 已连接状态：展示实时远程文件资源树 */
				<div
					className="flex flex-1 min-h-0 flex-col"
					onContextMenu={(e) => {
						if ((e.target as HTMLElement).closest(".file-row")) return;
						actions.openContextMenu(e, null);
					}}
				>
					{/* 路径与快捷操作条 */}
					<div className="border-b border-border/60 bg-surface p-1.5 space-y-1">
						<div className="flex items-center gap-1 font-mono text-[10px]">
							<span className="text-faint truncate flex-1" title={remotePath}>
								{remotePath || "/"}
							</span>
							<IconButton
								icon="icon-[lucide--arrow-up]"
								label="上一级目录"
								className="size-5 shrink-0"
								onClick={() => loadDir(posixDirname(remotePath))}
							/>
							<IconButton
								icon="icon-[lucide--folder-plus]"
								label="新建目录"
								className="size-5 shrink-0"
								onClick={() => {
									setModalMode("mkdir");
									setInputName("");
								}}
							/>
							<IconButton
								icon="icon-[lucide--file-plus]"
								label="新建文件"
								className="size-5 shrink-0"
								onClick={() => {
									setModalMode("touch");
									setInputName("");
								}}
							/>
							<IconButton
								icon="icon-[lucide--upload]"
								label="上传文件"
								className="size-5 shrink-0 text-primary"
								onClick={handleUpload}
							/>
							<IconButton
								icon="icon-[lucide--refresh-cw]"
								label="刷新"
								className={cn("size-5 shrink-0", loading && "animate-spin text-primary")}
								onClick={() => loadDir(remotePath)}
							/>
						</div>

						{/* 快捷跳转与搜索 */}
						<div className="flex items-center gap-1">
							<div className="relative flex-1">
								<input
									type="text"
									value={filter}
									onChange={(e) => setFilter(e.target.value)}
									placeholder="搜索文件…"
									className="h-5.5 w-full rounded border border-border/70 bg-surface-sunk px-1.5 text-[10px] outline-none focus:border-primary"
								/>
								{filter && (
									<button
										type="button"
										onClick={() => setFilter("")}
										className="absolute right-1 top-0.5 text-faint hover:text-surface-foreground"
									>
										×
									</button>
								)}
							</div>
							<button
								type="button"
								onClick={() => loadDir(".")}
								className="rounded bg-surface-sunk px-1 py-0.5 text-[9.5px] text-faint hover:text-surface-foreground cursor-pointer"
								title="主目录"
							>
								~
							</button>
							<button
								type="button"
								onClick={() => loadDir("/etc")}
								className="rounded bg-surface-sunk px-1 py-0.5 text-[9.5px] text-faint hover:text-surface-foreground cursor-pointer"
								title="/etc"
							>
								etc
							</button>
							<button
								type="button"
								onClick={() => loadDir("/var/log")}
								className="rounded bg-surface-sunk px-1 py-0.5 text-[9.5px] text-faint hover:text-surface-foreground cursor-pointer"
								title="/var/log"
							>
								log
							</button>
						</div>
					</div>

					{/* 文件条目列表 */}
					<div
						ref={(el) => {
							actions.containerRef.current = el;
						}}
						tabIndex={0}
						onKeyDown={actions.handleKeyDown}
						className="flex-1 min-h-0 overflow-y-auto px-1 py-1 outline-none"
					>
						{filteredEntries.length === 0 ? (
							<div className="flex h-32 items-center justify-center text-[10.5px] text-faint">
								{loading ? "正在读取…" : "当前目录为空"}
							</div>
						) : (
							<div className="space-y-0.5">
								{filteredEntries.map((entry) => {
									const isSelected = selected.has(entry.name);
									const iconClass = getFileIcon(entry.name, entry.is_dir, entry.is_symlink);
									return (
										<div
											key={entry.name}
											data-sftp-row={entry.name}
											onClick={(e) => {
												if (e.ctrlKey || e.metaKey) {
													const next = new Set(selected);
													if (next.has(entry.name)) next.delete(entry.name);
													else next.add(entry.name);
													setSelected(next);
												} else setSelected(new Set([entry.name]));
											}}
											onDoubleClick={() => actions.openEntry(entry)}
											onContextMenu={(e) => actions.openContextMenu(e, entry)}
											className={cn(
												"file-row group flex items-center justify-between rounded px-1.5 py-1 cursor-pointer transition-colors select-none",
												isSelected
													? "bg-primary/20 text-primary font-medium"
													: "hover:bg-surface text-surface-foreground",
											)}
										>
											<div className="flex items-center gap-1.5 min-w-0 flex-1">
												<span
													className={cn(
														iconClass,
														"size-3.5 shrink-0",
														entry.is_dir ? "text-primary" : "text-muted",
													)}
												/>
												<span className="truncate text-[11px]">{entry.name}</span>
											</div>
											<span className="font-mono text-[9px] tabular-nums text-faint shrink-0 ml-1">
												{entry.is_dir ? "" : formatBytes(entry.size)}
											</span>
										</div>
									);
								})}
							</div>
						)}
					</div>

					{/* 底部统计栏 */}
					<div className="flex h-5 shrink-0 items-center justify-between border-t border-border px-2 text-[9.5px] text-faint font-mono">
						<span>{filteredEntries.length} 项</span>
						<button
							type="button"
							onClick={toggleEmbeddedSftp}
							className="hover:text-primary transition-colors cursor-pointer"
						>
							{embeddedSftpOpen ? "收起底部面板" : "展开底部面板"}
						</button>
					</div>
				</div>
			)}

			{/* 模态弹窗 */}
			<Modal
				open={modalMode !== null}
				onClose={() => {
					setModalMode(null);
				}}
				title={
					modalMode === "mkdir"
						? "新建远程目录"
						: "新建文本文件"
				}
				footer={
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => {
								setModalMode(null);
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
								"bg-primary hover:bg-primary/90",
							)}
						>
							确定
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
							placeholder="例如 logs"
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
							placeholder="例如 test.txt"
						/>
					</div>
				)}

			</Modal>
		</div>
	);
}
