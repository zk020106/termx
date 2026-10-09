import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState } from "@/components/ui/Display";
import { Modal } from "@/components/ui/Overlay";
import { cn } from "@/lib/cn";
import {
	conflictMtime,
	formatUnixTime,
	fsLocalReadFile,
	fsLocalStat,
	fsLocalWriteFile,
	getFileIcon,
	sftpReadFile,
	sftpStat,
	sftpWriteFile,
} from "@/lib/sftp";
import { useEditorStore, type EditorFileTab } from "@/store/editor";
import { toast } from "@/store/toast";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router";

type EditorTab = EditorFileTab;

/** 读取内容并记下当时的修改时间（之后保存时据此判断文件有没有被别人改过） */
async function readWithMtime(tab: Pick<EditorTab, "side" | "sessionKey" | "path">): Promise<{ text: string; mtime: number }> {
	if (tab.side === "remote" && tab.sessionKey) {
		const key = tab.sessionKey;
		const [stat, text] = await Promise.all([sftpStat(key, tab.path).catch(() => null), sftpReadFile(key, tab.path)]);
		return { text, mtime: stat?.exists ? stat.mtime : 0 };
	}
	const [stat, text] = await Promise.all([fsLocalStat(tab.path).catch(() => null), fsLocalReadFile(tab.path)]);
	return { text, mtime: stat?.exists ? stat.mtime : 0 };
}

export default function Editor() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();

	// 打开的文件放在 store 里：离开编辑器再回来，未保存的修改还在
	const tabs = useEditorStore((s) => s.tabs);
	const setTabs = useEditorStore((s) => s.setTabs);
	const activeTabId = useEditorStore((s) => s.activeTabId);
	const setActiveTabId = useEditorStore((s) => s.setActiveTabId);
	/** 保存时发现文件已被别人改过 */
	const [conflict, setConflict] = useState<{ tabId: string; diskMtime: number } | null>(null);
	/** 关闭有未保存修改的标签前确认 */
	const [closing, setClosing] = useState<string | null>(null);

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const lineNumbersRef = useRef<HTMLDivElement>(null);

	// 从 URL 参数初始化远程打开的文件
	useEffect(() => {
		const sessionKey = searchParams.get("sessionKey");
		const path = searchParams.get("path");
		const name = searchParams.get("name") || (path ? path.split("/").pop() : "") || "untitled";

		if (sessionKey && path) {
			const tabId = `remote-${sessionKey}-${path}`;
			setTabs((prev) => {
				const existing = prev.find((t) => t.id === tabId);
				if (existing) {
					setActiveTabId(tabId);
					return prev;
				}
				const newTab: EditorTab = {
					id: tabId,
					name,
					path,
					side: "remote",
					sessionKey,
					content: "",
					savedContent: "",
					loading: true,
					saving: false,
					mtime: 0,
				};
				setActiveTabId(tabId);
				return [...prev, newTab];
			});
			// 已经打开过（可能有未保存修改）：只切过去，不重新读、不覆盖
			if (useEditorStore.getState().tabs.some((t) => t.id === tabId && !t.loading)) return;

			// 异步读取远程文件
			readWithMtime({ side: "remote", sessionKey, path })
				.then(({ text, mtime }) => {
					setTabs((prev) =>
						prev.map((t) =>
							t.id === tabId
								? { ...t, content: text, savedContent: text, loading: false, mtime, readError: undefined }
								: t,
						),
					);
				})
				.catch((err) => {
					toast({
						title: `读取文件失败: ${name}`,
						description: String(err),
						tone: "danger",
					});
					setTabs((prev) =>
						prev.map((t) =>
							t.id === tabId
								? {
										...t,
										content: "",
										savedContent: "",
										loading: false,
										readError: String(err),
									}
								: t,
						),
					);
				});
		}
	}, [searchParams]);

	const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);

	// 保存文件
	// force = 用户已确认覆盖别人对磁盘文件的修改
	const handleSave = async (tab: EditorTab = activeTab!, force = false) => {
		if (!tab || tab.saving || tab.loading || tab.readError) return;

		setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, saving: true } : t)));
		const content = tab.content;
		const expected = force || !tab.mtime ? null : tab.mtime;
		try {
			// 先写临时文件再原子替换（后端实现），中途失败不会留下半截文件
			const mtime =
				tab.side === "remote" && tab.sessionKey
					? await sftpWriteFile(tab.sessionKey, tab.path, content, expected)
					: await fsLocalWriteFile(tab.path, content, expected);
			setTabs((prev) =>
				prev.map((t) =>
					// 保存期间用户又改了内容：只把「保存时的那份」记为已保存
					t.id === tab.id ? { ...t, savedContent: content, saving: false, mtime } : t,
				),
			);
			toast({
				title: `已成功保存: ${tab.name}`,
				description: tab.path,
				tone: "success",
			});
		} catch (e) {
			setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, saving: false } : t)));
			const diskMtime = conflictMtime(e);
			if (diskMtime !== null) {
				setConflict({ tabId: tab.id, diskMtime });
				return;
			}
			toast({
				title: `保存失败: ${tab.name}`,
				description: String(e),
				tone: "danger",
			});
		}
	};

	// 打开本地文件
	const handleOpenLocalFile = async () => {
		try {
			const res = await openFileDialog({ multiple: false });
			if (!res || Array.isArray(res)) return;
			const filePath = res;
			const fileName = filePath.replace(/\\/g, "/").split("/").pop() || "untitled";
			const tabId = `local-${filePath}`;

			const existing = tabs.find((t) => t.id === tabId);
			if (existing) {
				setActiveTabId(tabId);
				return;
			}

			const { text: content, mtime } = await readWithMtime({ side: "local", path: filePath });
			const newTab: EditorTab = {
				id: tabId,
				name: fileName,
				path: filePath,
				side: "local",
				content,
				savedContent: content,
				loading: false,
				saving: false,
				mtime,
			};
			setTabs((prev) => [...prev, newTab]);
			setActiveTabId(tabId);
		} catch (e) {
			toast({ title: "打开本地文件失败", description: String(e), tone: "danger" });
		}
	};

	// 关闭标签：有未保存修改先确认
	const handleCloseTab = (tabId: string, confirmed = false) => {
		const tab = tabs.find((t) => t.id === tabId);
		if (!confirmed && tab && !tab.readError && tab.content !== tab.savedContent) {
			setClosing(tabId);
			return;
		}
		setTabs((prev) => {
			const filtered = prev.filter((t) => t.id !== tabId);
			if (activeTabId === tabId) {
				setActiveTabId(filtered[filtered.length - 1]?.id ?? "");
			}
			return filtered;
		});
	};

	/** 冲突时选择「重新载入」：丢弃本地修改，读磁盘上的新版本 */
	const reloadFromDisk = async (tabId: string) => {
		const tab = tabs.find((t) => t.id === tabId);
		if (!tab) return;
		setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, loading: true } : t)));
		try {
			const { text, mtime } = await readWithMtime(tab);
			setTabs((prev) =>
				prev.map((t) =>
					t.id === tabId ? { ...t, content: text, savedContent: text, mtime, loading: false, readError: undefined } : t,
				),
			);
			toast({ title: `已重新载入: ${tab.name}`, description: tab.path, tone: "default" });
		} catch (e) {
			setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, loading: false } : t)));
			toast({ title: `重新载入失败: ${tab.name}`, description: String(e), tone: "danger" });
		}
	};

	// 键盘快捷键监听 (Ctrl+S)
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				if (activeTab) {
					handleSave(activeTab);
				}
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [activeTab]);

	// 行号计算
	const lineCount = useMemo(() => {
		if (!activeTab || activeTab.loading) return 1;
		return Math.max(1, activeTab.content.split("\n").length);
	}, [activeTab]);

	const lineNumbers = useMemo(() => {
		return Array.from({ length: lineCount }, (_, i) => i + 1);
	}, [lineCount]);

	// 同步滚动
	const handleScroll = () => {
		if (textareaRef.current && lineNumbersRef.current) {
			lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
		}
	};

	// Tab 键输入 2 空格
	const handleKeyDownTextarea = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Tab") {
			e.preventDefault();
			const textarea = e.currentTarget;
			const start = textarea.selectionStart;
			const end = textarea.selectionEnd;
			const val = textarea.value;
			const updated = val.substring(0, start) + "  " + val.substring(end);
			if (activeTab) {
				setTabs((prev) =>
					prev.map((t) => (t.id === activeTab.id ? { ...t, content: updated } : t)),
				);
			}
			setTimeout(() => {
				textarea.selectionStart = textarea.selectionEnd = start + 2;
			}, 0);
		}
	};

	return (
		<WindowChrome>
			<div className="relative flex min-h-0 flex-1 flex-col bg-surface">
				{/* 编辑器标签栏 */}
				<div className="flex h-8.5 shrink-0 items-end justify-between border-b border-border bg-surface-sunk px-2">
					<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-1 no-scrollbar">
						{tabs.map((tab) => {
							const isActive = tab.id === activeTabId;
							const isDirty = tab.content !== tab.savedContent;
							const iconClass = getFileIcon(tab.name, false, false);
							return (
								<div
									key={tab.id}
									onClick={() => setActiveTabId(tab.id)}
									className={cn(
										"group flex h-6.5 shrink-0 items-center gap-1.5 rounded-t px-2.5 text-[11px] font-medium transition-colors cursor-pointer select-none",
										isActive
											? "bg-surface text-surface-foreground border-t border-x border-border shadow-xs"
											: "text-muted hover:bg-surface/50 hover:text-surface-foreground",
									)}
								>
									<span className={cn(iconClass, "size-3 shrink-0 text-primary")} />
									<span className="truncate max-w-[140px]">{tab.name}</span>
									{isDirty ? (
										<span className="relative flex size-4 items-center justify-center">
											<span
												className="size-2 rounded-full bg-primary animate-pulse group-hover:hidden"
												title="未保存更改"
											/>
											<button
												type="button"
												title="关闭（有未保存更改）"
												onClick={(e) => {
													e.stopPropagation();
													handleCloseTab(tab.id);
												}}
												className="hidden size-4 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-surface-foreground group-hover:flex"
											>
												×
											</button>
										</span>
									) : (
										<button
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												handleCloseTab(tab.id);
											}}
											className="opacity-0 group-hover:opacity-100 size-4 flex items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-surface-foreground transition-opacity"
										>
											×
										</button>
									)}
								</div>
							);
						})}

						{/* 新建 / 打开文件按钮 */}
						<button
							type="button"
							onClick={handleOpenLocalFile}
							title="打开本地文本文件"
							aria-label="打开本地文本文件"
							className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface hover:text-surface-foreground"
						>
							<span className="icon-[lucide--plus] size-3" />
						</button>
					</div>

					{/* 快捷操作区 */}
					<div className="flex shrink-0 items-center gap-2 pb-1 text-[11px] text-muted">
						{activeTab && (
							<>
								<Button
									size="sm"
									variant={activeTab.content !== activeTab.savedContent ? "primary" : "default"}
									onClick={() => handleSave(activeTab)}
									disabled={activeTab.saving || activeTab.loading || !!activeTab.readError}
									className="h-6 text-[10.5px]"
								>
									<span className="icon-[lucide--save] size-3" />
									<span>{activeTab.saving ? "保存中..." : "保存 (Ctrl+S)"}</span>
								</Button>
								<div className="h-3 w-px bg-border" />
							</>
						)}
						<Link
							to="/sftp"
							className="flex h-6 items-center gap-1 rounded px-1.5 text-[10.5px] text-muted hover:bg-surface hover:text-surface-foreground"
						>
							<span className="icon-[lucide--folder-tree] size-3" />
							<span>SFTP 浏览</span>
						</Link>
					</div>
				</div>

				{/* 路径与属性状态栏 */}
				{activeTab ? (
					<div className="flex h-6.5 shrink-0 items-center justify-between border-b border-border/40 bg-surface/80 px-3 font-mono text-[11px] text-muted">
						<div className="flex min-w-0 items-center gap-1.5">
							<Badge className="text-[9.5px]">
								{activeTab.side === "remote" ? "远程 SFTP" : "本地文件"}
							</Badge>
							<span className="truncate text-surface-foreground">{activeTab.path}</span>
							{activeTab.content !== activeTab.savedContent && (
								<span className="text-warning text-[10px]">● 已修改</span>
							)}
						</div>
						<div className="flex shrink-0 items-center gap-2 tabular-nums text-faint">
							<span>{lineCount} 行</span>
							<span>·</span>
							<span>{activeTab.content.length} 字符</span>
							<span>·</span>
							<span>UTF-8</span>
						</div>
					</div>
				) : null}

				{/* 编辑器主画布 */}
				{activeTab ? (
					<div className="relative flex min-h-0 flex-1 bg-surface font-mono text-[12px]">
						{activeTab.loading ? (
							<div className="flex h-full w-full items-center justify-center gap-2 text-muted">
								<span className="icon-[lucide--refresh-cw] size-4 animate-spin text-primary" />
								<span>正在加载文件内容...</span>
							</div>
						) : activeTab.readError ? (
							<div className="flex h-full w-full items-center justify-center">
								<EmptyState
									icon="icon-[lucide--file-x]"
									title="读取文件失败"
									description={activeTab.readError}
									action={
										<Button size="sm" icon="icon-[lucide--refresh-cw]" onClick={() => void reloadFromDisk(activeTab.id)}>
											重试
										</Button>
									}
								/>
							</div>
						) : (
							<div className="relative flex min-h-0 flex-1 overflow-hidden">
								{/* 行号区 */}
								<div
									ref={lineNumbersRef}
									className="w-12 shrink-0 select-none overflow-hidden border-r border-border/40 bg-surface-sunk/30 py-3 pr-2 text-right font-mono text-[11.5px] leading-6 text-faint/70"
								>
									{lineNumbers.map((n) => (
										<div key={n}>{n}</div>
									))}
								</div>

								{/* 文本输入区 */}
								<textarea
									ref={textareaRef}
									value={activeTab.content}
									onChange={(e) => {
										const val = e.target.value;
										setTabs((prev) =>
											prev.map((t) => (t.id === activeTab.id ? { ...t, content: val } : t)),
										);
									}}
									onScroll={handleScroll}
									onKeyDown={handleKeyDownTextarea}
									spellCheck={false}
									autoCapitalize="off"
									autoComplete="off"
									autoCorrect="off"
									className="min-h-0 flex-1 resize-none border-0 bg-transparent p-3 font-mono text-[12px] leading-6 text-surface-foreground outline-none selection:bg-primary/20"
									placeholder="开始在此编辑代码或文本..."
								/>
							</div>
						)}
					</div>
				) : (
					<div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
						<EmptyState
							icon="icon-[lucide--file-code]"
							title="还没有打开的文件"
							description="在 SFTP 面板中双击文件即可在此直接查看与编辑，支持 Ctrl+S 实时保存至远程。"
							action={
								<div className="flex items-center gap-2">
									<Button size="sm" icon="icon-[lucide--folder-open]" onClick={() => navigate("/sftp")}>
										去 SFTP 浏览远程文件
									</Button>
									<Button
										size="sm"
										variant="primary"
										icon="icon-[lucide--file-plus]"
										onClick={handleOpenLocalFile}
									>
										打开本地文件
									</Button>
								</div>
							}
						/>
					</div>
				)}
			</div>

			{/* 保存冲突：文件在打开后被别人改过 */}
			<Modal
				open={conflict !== null}
				onClose={() => setConflict(null)}
				title="文件已被其他程序修改"
				icon="icon-[lucide--git-compare]"
				width={440}
				footer={
					<>
						<Button size="sm" onClick={() => setConflict(null)}>
							取消
						</Button>
						<Button
							size="sm"
							icon="icon-[lucide--refresh-cw]"
							onClick={() => {
								const id = conflict?.tabId;
								setConflict(null);
								if (id) void reloadFromDisk(id);
							}}
						>
							放弃我的修改并重新载入
						</Button>
						<Button
							size="sm"
							variant="danger"
							onClick={() => {
								const tab = tabs.find((t) => t.id === conflict?.tabId);
								setConflict(null);
								if (tab) void handleSave(tab, true);
							}}
						>
							仍然覆盖
						</Button>
					</>
				}
			>
				{conflict && (
					<p>
						{tabs.find((t) => t.id === conflict.tabId)?.path} 在你打开之后被修改过
						{conflict.diskMtime ? `（磁盘上的版本修改于 ${formatUnixTime(conflict.diskMtime)}）` : ""}
						。直接保存会覆盖对方的修改。
					</p>
				)}
			</Modal>

			{/* 关闭未保存的标签 */}
			<Modal
				open={closing !== null}
				onClose={() => setClosing(null)}
				title="有未保存的修改"
				icon="icon-[lucide--alert-triangle]"
				width={400}
				footer={
					<>
						<Button size="sm" onClick={() => setClosing(null)}>
							取消
						</Button>
						<Button
							size="sm"
							variant="danger"
							onClick={() => {
								const id = closing;
								setClosing(null);
								if (id) handleCloseTab(id, true);
							}}
						>
							放弃修改并关闭
						</Button>
						<Button
							size="sm"
							variant="primary"
							onClick={async () => {
								const tab = tabs.find((t) => t.id === closing);
								setClosing(null);
								if (!tab) return;
								await handleSave(tab);
								const after = useEditorStore.getState().tabs.find((t) => t.id === tab.id);
								if (after && after.content === after.savedContent) handleCloseTab(tab.id, true);
							}}
						>
							保存并关闭
						</Button>
					</>
				}
			>
				<p>{tabs.find((t) => t.id === closing)?.name} 还有未保存的修改。</p>
			</Modal>
		</WindowChrome>
	);
}
