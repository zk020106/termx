import { ContextMenu, MenuItem, MenuLabel, MenuSeparator, MenuSub } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";
import type { ToolbarItemPlacement } from "@/lib/toolbarItemLayout";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/* =============================================================================
 * 移植自 Netcatty components/ui/toolbar-item-layout.tsx：
 *  - ToolbarCustomizeContextMenu：右键工具栏 →「自定义工具栏」，每项 显示 / 折叠 / 隐藏 + 前移 / 后移，底部「恢复默认」
 *  - ToolbarOverflowMenu：⋮ 按钮，里面放折叠的项；没有折叠项时不渲染
 * 文案取 Netcatty zh-CN（toolbar.layout.*、terminal.toolbar.more）。
 * ========================================================================== */

export type ToolbarCustomizeItem = {
	id: string;
	label: string;
	icon?: string;
	/** 锁定项不能隐藏 */
	locked?: boolean;
	/** false = 只能显示 / 隐藏（不提供折叠） */
	supportsCollapse?: boolean;
};

const PLACEMENT_LABEL: Record<ToolbarItemPlacement, string> = { show: "显示", collapse: "折叠", hide: "隐藏" };
const PLACEMENT_ICON: Record<ToolbarItemPlacement, string> = {
	show: "icon-[lucide--eye]",
	collapse: "icon-[lucide--layout-list]",
	hide: "icon-[lucide--eye-off]",
};

export function ToolbarCustomizeContextMenu({
	items,
	placementOf,
	onSetPlacement,
	onMove,
	onReset,
	children,
	className,
	enabled = true,
}: {
	items: ToolbarCustomizeItem[];
	placementOf: (id: string) => ToolbarItemPlacement;
	onSetPlacement: (id: string, placement: ToolbarItemPlacement) => unknown;
	onMove?: (id: string, direction: "earlier" | "later") => void;
	onReset: () => void;
	children: ReactNode;
	className?: string;
	enabled?: boolean;
}) {
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	if (!enabled || items.length === 0) return <div className={className}>{children}</div>;
	return (
		<>
			<div
				className={className}
				data-toolbar-customize-root="true"
				onContextMenu={(event) => {
					event.preventDefault();
					event.stopPropagation();
					setMenu({ x: event.clientX, y: event.clientY });
				}}
			>
				{children}
			</div>
			{menu && (
				<ContextMenu x={menu.x} y={menu.y} width={230} onClose={() => setMenu(null)} label="自定义工具栏">
					<MenuLabel icon="icon-[lucide--panel-top]" label="自定义工具栏" />
					<MenuSeparator />
					{items.map((item, index) => {
						const raw = placementOf(item.id);
						const placement = item.supportsCollapse === false && raw === "collapse" ? "show" : raw;
						return (
							<MenuSub
								key={item.id}
								icon={item.icon}
								label={item.label}
								hint={
									<>
										<span className={cn(PLACEMENT_ICON[placement], "size-3")} />
										{PLACEMENT_LABEL[placement]}
									</>
								}
							>
								<MenuItem icon="icon-[lucide--eye]" label="显示" checked={placement === "show"} onClick={() => onSetPlacement(item.id, "show")} />
								{item.supportsCollapse !== false && (
									<MenuItem icon="icon-[lucide--layout-list]" label="折叠" checked={placement === "collapse"} onClick={() => onSetPlacement(item.id, "collapse")} />
								)}
								<MenuItem
									icon="icon-[lucide--eye-off]"
									label="隐藏"
									checked={placement === "hide"}
									disabled={item.locked}
									onClick={() => onSetPlacement(item.id, "hide")}
								/>
								{onMove && (
									<>
										<MenuSeparator />
										<MenuItem icon="icon-[lucide--chevron-up]" label="前移" disabled={index === 0} onClick={() => onMove(item.id, "earlier")} />
										<MenuItem icon="icon-[lucide--chevron-down]" label="后移" disabled={index === items.length - 1} onClick={() => onMove(item.id, "later")} />
									</>
								)}
							</MenuSub>
						);
					})}
					<MenuSeparator />
					<MenuItem
						icon="icon-[lucide--rotate-ccw]"
						label="恢复默认"
						onClick={() => {
							onReset();
							setMenu(null);
						}}
					/>
				</ContextMenu>
			)}
		</>
	);
}

const OverflowCloseContext = createContext<(() => void) | null>(null);

/** 折叠区里的叶子操作执行后关闭 ⋮ 菜单（Netcatty useToolbarOverflowClose） */
export function useToolbarOverflowClose(): () => void {
	return useContext(OverflowCloseContext) ?? (() => {});
}

export function ToolbarOverflowMenu({
	hasItems,
	label = "更多操作",
	children,
	orientation = "vertical",
	buttonClassName,
}: {
	hasItems: boolean;
	label?: string;
	children: ReactNode;
	orientation?: "horizontal" | "vertical";
	buttonClassName?: string;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);
	if (!hasItems) return null;
	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				aria-label={label}
				title={label}
				data-toolbar-overflow-trigger="true"
				onClick={() => setOpen((v) => !v)}
				className={cn("grid place-items-center rounded text-muted hover:bg-surface-raised hover:text-surface-foreground", open && "text-primary", buttonClassName)}
			>
				<span className={cn(orientation === "vertical" ? "icon-[lucide--more-vertical]" : "icon-[lucide--more-horizontal]", "size-3.5")} />
			</button>
			{open && (
				<div
					role="menu"
					data-toolbar-overflow-menu="true"
					className="absolute right-0 top-full z-50 mt-1 min-w-[190px] rounded-2xl border border-border/80 bg-surface/98 p-1.5 shadow-popover ring-1 ring-black/5"
					onClick={(e) => {
						const target = e.target as Element | null;
						if (target?.closest('[data-toolbar-overflow-keep-open="true"]')) return;
						if (target?.closest('button, [role="menuitem"], a')) requestAnimationFrame(() => setOpen(false));
					}}
				>
					<OverflowCloseContext.Provider value={() => setOpen(false)}>{children}</OverflowCloseContext.Provider>
				</div>
			)}
		</div>
	);
}
