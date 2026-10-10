import { ToolbarCustomizeContextMenu, ToolbarOverflowMenu } from "@/components/ui/ToolbarItemLayout";
import type { ToolbarItemLayoutDefaults } from "@/lib/toolbarItemLayout";
import { useToolbarItemLayout } from "@/lib/useToolbarItemLayout";
import { Fragment, useMemo, type ReactNode } from "react";

/* =============================================================================
 * 终端工具栏的可定制布局 —— 对应 Netcatty TerminalToolbar 的 TERMINAL_TOOLBAR_ITEM_IDS /
 * TERMINAL_TOOLBAR_LAYOUT_DEFAULTS + useToolbarItemLayout + ToolbarCustomizeContextMenu + ⋮ 折叠菜单。
 * 与 Netcatty 同名的项沿用它的 id（sftp / search / scripts / history / configureOsc7）与默认位置；
 * splitHorizontal / splitVertical / layout 是 TermX 自己的工具栏项（Netcatty 的分屏在标签菜单里）。
 * search 锁定不可隐藏（同 Netcatty）；layout 是一组切换按钮，同 Netcatty highlight 只能显示 / 隐藏。
 * ========================================================================== */

export const TERMINAL_TOOLBAR_ITEM_IDS = [
	"splitHorizontal",
	"splitVertical",
	"sftp",
	"forward",
	"scripts",
	"monitor",
	"search",
	"history",
	"configureOsc7",
	"layout",
] as const;
export type TerminalToolbarItemId = (typeof TERMINAL_TOOLBAR_ITEM_IDS)[number];

export const TERMINAL_TOOLBAR_ITEMS: Record<TerminalToolbarItemId, { label: string; icon: string }> = {
	splitHorizontal: { label: "水平分屏", icon: "icon-[lucide--columns-2]" },
	splitVertical: { label: "垂直分屏", icon: "icon-[lucide--rows-2]" },
	sftp: { label: "打开 SFTP", icon: "icon-[lucide--folder-tree]" },
	forward: { label: "端口转发", icon: "icon-[lucide--waypoints]" },
	scripts: { label: "命令片段", icon: "icon-[lucide--code-xml]" },
	monitor: { label: "主机监控", icon: "icon-[lucide--activity]" },
	search: { label: "搜索终端", icon: "icon-[lucide--search]" },
	history: { label: "历史", icon: "icon-[lucide--history]" },
	configureOsc7: { label: "配置目录追踪", icon: "icon-[lucide--folder-sync]" },
	layout: { label: "分屏布局", icon: "icon-[lucide--layout-grid]" },
};

export const TERMINAL_TOOLBAR_LAYOUT_DEFAULTS: ToolbarItemLayoutDefaults = {
	order: [...TERMINAL_TOOLBAR_ITEM_IDS],
	placement: {
		splitHorizontal: "show",
		splitVertical: "show",
		sftp: "show",
		forward: "show",
		scripts: "show",
		monitor: "show",
		search: "show",
		history: "collapse",
		configureOsc7: "collapse",
		layout: "show",
	},
	lockedIds: ["search"],
};

const STORAGE_KEY = "termx.terminalToolbarLayout";

export function TerminalToolbarItems({
	renderItem,
	available,
}: {
	renderItem: (id: TerminalToolbarItemId, mode: "inline" | "overflow") => ReactNode;
	/** 当前会话可用的项（Netcatty availableIds）；缺省 = 除 history / configureOsc7 外全部 */
	available?: TerminalToolbarItemId[];
}) {
	const toolbarLayout = useToolbarItemLayout(STORAGE_KEY, TERMINAL_TOOLBAR_LAYOUT_DEFAULTS);
	const availableIds = useMemo(
		() => available ?? TERMINAL_TOOLBAR_ITEM_IDS.filter((id) => id !== "history" && id !== "configureOsc7"),
		[available],
	);
	const customizeItems = useMemo(
		() =>
			toolbarLayout.layout.order
				.filter((id): id is TerminalToolbarItemId => (availableIds as string[]).includes(id))
				.map((id) => ({
					id,
					label: TERMINAL_TOOLBAR_ITEMS[id].label,
					icon: TERMINAL_TOOLBAR_ITEMS[id].icon,
					locked: id === "search",
					supportsCollapse: id !== "layout",
				})),
		[availableIds, toolbarLayout.layout.order],
	);
	const { shown, collapsed } = useMemo(() => {
		const avail = new Set<string>(availableIds);
		const shownIds: TerminalToolbarItemId[] = [];
		const collapsedIds: TerminalToolbarItemId[] = [];
		for (const id of toolbarLayout.layout.order) {
			if (!avail.has(id)) continue;
			let placement = toolbarLayout.layout.placement[id] ?? "show";
			if (id === "layout" && placement === "collapse") placement = "show";
			if (placement === "show") shownIds.push(id as TerminalToolbarItemId);
			else if (placement === "collapse") collapsedIds.push(id as TerminalToolbarItemId);
		}
		return { shown: shownIds, collapsed: collapsedIds };
	}, [availableIds, toolbarLayout.layout]);

	return (
		<ToolbarCustomizeContextMenu
			className="flex items-center gap-1.5"
			items={customizeItems}
			placementOf={(id) => toolbarLayout.layout.placement[id] ?? "show"}
			onSetPlacement={(id, placement) => toolbarLayout.setPlacement(id, placement, availableIds)}
			onMove={(id, direction) => toolbarLayout.move(id, direction, availableIds)}
			onReset={toolbarLayout.reset}
		>
			{shown.map((id) => (
				<Fragment key={id}>{renderItem(id, "inline")}</Fragment>
			))}
			<ToolbarOverflowMenu hasItems={collapsed.length > 0} buttonClassName="size-5.5">
				{collapsed.map((id) => (
					<Fragment key={id}>{renderItem(id, "overflow")}</Fragment>
				))}
			</ToolbarOverflowMenu>
		</ToolbarCustomizeContextMenu>
	);
}
