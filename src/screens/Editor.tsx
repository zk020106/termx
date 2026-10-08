import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState } from "@/components/ui/Display";
import { cn } from "@/lib/cn";
import { fsLocalReadFile, fsLocalWriteFile, getFileIcon, sftpReadFile, sftpWriteFile } from "@/lib/sftp";
import { toast } from "@/store/toast";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router";

interface EditorTab {
	id: string;
	name: string;
	path: string;
	side: "remote" | "local";
	sessionKey?: string;
	content: string;
	savedContent: string;
	loading: boolean;
	saving: boolean;
}

export default function Editor() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();

	const [tabs, setTabs] = useState<EditorTab[]>([]);
	const [activeTabId, setActiveTabId] = useState<string>("");

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
				};
				setActiveTabId(tabId);
				return [...prev, newTab];
			});

			// 异步读取远程文件
			sftpReadFile(sessionKey, path)
				.then((text) => {
					setTabs((prev) =>
						prev.map((t) =>
							t.id === tabId ? { ...t, content: text, savedContent: text, loading: false } : t,
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
										content: `/* 读取文件失败: ${err} */`,
										savedContent: "",
										loading: false,
									}
								: t,
						),
					);
				});
		}
	}, [searchParams]);

	const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);

	// 保存文件
	const handleSave = async (tab: EditorTab = activeTab!) => {
		if (!tab || tab.saving) return;

		setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, saving: true } : t)));
		try {
			if (tab.side === "remote" && tab.sessionKey) {
				await sftpWriteFile(tab.sessionKey, tab.path, tab.content);
			} else {
				await fsLocalWriteFile(tab.path, tab.content);
			}
			setTabs((prev) =>
				prev.map((t) =>
					t.id === tab.id ? { ...t, savedContent: t.content, saving: false } : t,
				),
			);
			toast({
				title: `已成功保存: ${tab.name}`,
				description: tab.path,
				tone: "success",
			});
		} catch (e) {
			setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, saving: false } : t)));
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

			const content = await fsLocalReadFile(filePath);
			const newTab: EditorTab = {
				id: tabId,
				name: fileName,
				path: filePath,
				side: "local",
				content,
				savedContent: content,
				loading: false,
				saving: false,
			};
			setTabs((prev) => [...prev, newTab]);
			setActiveTabId(tabId);
		} catch (e) {
			toast({ title: "打开本地文件失败", description: String(e), tone: "danger" });
		}
	};

	// 关闭标签
	const handleCloseTab = (tabId: string) => {
		setTabs((prev) => {
			const filtered = prev.filter((t) => t.id !== tabId);
			if (activeTabId === tabId) {
				setActiveTabId(filtered[filtered.length - 1]?.id ?? "");
			}
			return filtered;
		});
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
										<span className="size-2 rounded-full bg-primary animate-pulse" title="未保存更改" />
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
									disabled={activeTab.saving}
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
		</WindowChrome>
	);
}
