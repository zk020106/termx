import { ContextMenu, MenuItem } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";
import {
	isSftpTabKeyboardContextMenuShortcut,
	isSftpTabKeyboardSelectShortcut,
	SFTP_TAB_DUPLICATE_MENU_ITEMS,
	type SftpTabDuplicateMode,
} from "@/lib/sftpColumns";
import { useEffect, useRef, useState, type DragEvent } from "react";

/* =============================================================================
 * SFTP 标签栏 —— 移植自 Netcatty components/sftp/SftpTabBar.tsx：
 * - 每个标签：本地（Monitor）/ 远程（HardDrive）图标 + 名称 + 关闭；中键关闭；
 * - 拖动排序（前 / 后插入指示线），拖到另一侧的标签栏 = 移到另一侧；
 * - 右键：复制标签页（默认路径）/ 复制并跳转到当前路径（未连接时禁用）；
 * - 键盘：Enter / 空格选中，ContextMenu / Shift+F10 打开右键菜单；
 * - 右侧「+」新建标签页。
 * ========================================================================== */

export interface SftpTabInfo {
	id: string;
	label: string;
	isLocal: boolean;
	canDuplicate: boolean;
}

const TAB_MIME = "sftp-tab-id";
const SIDE_MIME = "sftp-tab-side";
/** dragover 时读不到 dataTransfer 的内容，用模块级变量记住正在拖的标签（Netcatty draggedTabIdRef） */
let draggingTab: { id: string; side: "left" | "right" } | null = null;

export function SftpTabBar({
	side,
	tabs,
	activeTabId,
	onSelectTab,
	onCloseTab,
	onAddTab,
	onReorderTabs,
	onMoveTabToOtherSide,
	onDuplicateTab,
}: {
	side: "left" | "right";
	tabs: SftpTabInfo[];
	activeTabId: string | null;
	onSelectTab: (tabId: string) => void;
	onCloseTab: (tabId: string) => void;
	onAddTab: (anchor: { x: number; y: number }) => void;
	onReorderTabs: (draggedId: string, targetId: string, position: "before" | "after") => void;
	onMoveTabToOtherSide: (tabId: string) => void;
	onDuplicateTab: (tabId: string, mode: SftpTabDuplicateMode) => void;
}) {
	const [dropIndicator, setDropIndicator] = useState<{ tabId: string; position: "before" | "after" } | null>(null);
	const [crossOver, setCrossOver] = useState(false);
	const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
	const scroller = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const reset = () => {
			draggingTab = null;
			setDropIndicator(null);
			setCrossOver(false);
		};
		document.addEventListener("dragend", reset);
		return () => document.removeEventListener("dragend", reset);
	}, []);

	// 激活标签滚动到可见
	useEffect(() => {
		const el = scroller.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId ?? "")}"]`);
		el?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [activeTabId]);

	const onTabDragOver = (e: DragEvent, tabId: string) => {
		if (!draggingTab) return;
		e.preventDefault();
		if (draggingTab.side !== side || draggingTab.id === tabId) return;
		e.stopPropagation();
		const rect = e.currentTarget.getBoundingClientRect();
		setDropIndicator({ tabId, position: e.clientX < rect.left + rect.width / 2 ? "before" : "after" });
	};
	const onTabDrop = (e: DragEvent, tabId: string) => {
		if (!draggingTab || draggingTab.side !== side) return;
		e.preventDefault();
		e.stopPropagation();
		const dragged = e.dataTransfer.getData(TAB_MIME) || draggingTab.id;
		if (dragged && dragged !== tabId && dropIndicator) onReorderTabs(dragged, tabId, dropIndicator.position);
		draggingTab = null;
		setDropIndicator(null);
	};

	return (
		<div
			className={cn(
				"flex h-8 shrink-0 items-stretch border-b border-border bg-surface-sunk/60 transition-colors",
				crossOver && "bg-primary/10 ring-1 ring-inset ring-primary/40",
			)}
			onDragOver={(e) => {
				if (!draggingTab || draggingTab.side === side) return;
				e.preventDefault();
				setCrossOver(true);
			}}
			onDragLeave={() => setCrossOver(false)}
			onDrop={(e) => {
				setCrossOver(false);
				const id = e.dataTransfer.getData(TAB_MIME);
				const from = e.dataTransfer.getData(SIDE_MIME);
				if (id && from && from !== side) {
					e.preventDefault();
					onMoveTabToOtherSide(id);
				}
				draggingTab = null;
				setDropIndicator(null);
			}}
		>
			<div ref={scroller} className="flex min-w-0 flex-1 items-stretch overflow-x-auto" style={{ scrollbarWidth: "none" }}>
				{tabs.map((tab) => {
					const active = tab.id === activeTabId;
					return (
						<div
							key={tab.id}
							data-tab-id={tab.id}
							tabIndex={0}
							aria-haspopup="menu"
							aria-label={tab.label}
							draggable
							onDragStart={(e) => {
								e.dataTransfer.effectAllowed = "move";
								e.dataTransfer.setData(TAB_MIME, tab.id);
								e.dataTransfer.setData(SIDE_MIME, side);
								draggingTab = { id: tab.id, side };
							}}
							onDragOver={(e) => onTabDragOver(e, tab.id)}
							onDrop={(e) => onTabDrop(e, tab.id)}
							onClick={() => onSelectTab(tab.id)}
							onMouseDown={(e) => {
								if (e.button === 1) e.preventDefault();
							}}
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									onCloseTab(tab.id);
								}
							}}
							onContextMenu={(e) => {
								e.preventDefault();
								setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
							}}
							onKeyDown={(e) => {
								if (e.target !== e.currentTarget) return;
								if (isSftpTabKeyboardSelectShortcut(e.key)) {
									e.preventDefault();
									onSelectTab(tab.id);
								} else if (isSftpTabKeyboardContextMenuShortcut(e.key, e.shiftKey)) {
									e.preventDefault();
									const rect = e.currentTarget.getBoundingClientRect();
									setMenu({ x: rect.left + Math.min(rect.width / 2, 24), y: rect.bottom, tabId: tab.id });
								}
							}}
							className={cn(
								"relative flex min-w-[100px] max-w-[180px] shrink-0 cursor-pointer items-center justify-between gap-2 border-r border-border px-3 text-[11.5px] font-medium outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/50",
								active ? "border-b-2 border-b-primary text-surface-foreground" : "text-muted hover:text-surface-foreground",
								draggingTab?.id === tab.id && "opacity-50",
							)}
						>
							{dropIndicator?.tabId === tab.id && (
								<div className={cn("absolute top-1 bottom-1 w-0.5 animate-pulse bg-primary", dropIndicator.position === "before" ? "left-0" : "right-0")} />
							)}
							<div className="flex min-w-0 flex-1 items-center gap-1.5">
								<span className={cn(tab.isLocal ? "icon-[lucide--monitor]" : "icon-[lucide--hard-drive]", "size-3 shrink-0", active ? "text-primary" : "text-faint")} />
								<span className="truncate">{tab.label}</span>
							</div>
							<button
								type="button"
								aria-label="关闭标签页"
								title="关闭标签页"
								onClick={(e) => {
									e.stopPropagation();
									onCloseTab(tab.id);
								}}
								className="shrink-0 p-0.5 transition-colors hover:bg-danger/10 hover:text-danger"
							>
								<span className="icon-[lucide--x] size-3" />
							</button>
						</div>
					);
				})}
			</div>
			<button
				type="button"
				title="新建标签页"
				aria-label="新建标签页"
				className="flex cursor-pointer items-center justify-center border-l border-border px-2 text-muted transition-colors hover:bg-primary/15 hover:text-surface-foreground"
				onClick={(e) => {
					const rect = e.currentTarget.getBoundingClientRect();
					onAddTab({ x: rect.left, y: rect.bottom + 2 });
				}}
			>
				<span className="icon-[lucide--plus] size-3.5" />
			</button>
			{menu && (
				<ContextMenu x={menu.x} y={menu.y} width={220} onClose={() => setMenu(null)} label="SFTP 标签菜单">
					{SFTP_TAB_DUPLICATE_MENU_ITEMS.map((item) => (
						<MenuItem
							key={item.mode}
							icon="icon-[lucide--copy]"
							label={item.label}
							disabled={!tabs.find((t) => t.id === menu.tabId)?.canDuplicate}
							onClick={() => {
								const id = menu.tabId;
								setMenu(null);
								onDuplicateTab(id, item.mode);
							}}
						/>
					))}
				</ContextMenu>
			)}
		</div>
	);
}
