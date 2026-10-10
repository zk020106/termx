import { cn } from "@/lib/cn";
import type { CommandSuggestion } from "@/store/commands";
import { useEffect, useRef } from "react";

/* =============================================================================
 * CommandCompletionPopup — Warp / VS Code 风格的终端光标悬浮命令补全气泡
 * ========================================================================== */

export function CommandCompletionPopup({
	suggestions,
	selectedIndex,
	onSelect,
	onHoverIndex,
	position,
	currentInput,
}: {
	suggestions: CommandSuggestion[];
	selectedIndex: number;
	onSelect: (suggestion: CommandSuggestion) => void;
	onHoverIndex: (index: number) => void;
	position: { x: number; y: number };
	currentInput: string;
}) {
	const listRef = useRef<HTMLDivElement | null>(null);

	// 选中项滚动进可视区域
	useEffect(() => {
		const activeEl = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
		if (activeEl) {
			activeEl.scrollIntoView({ block: "nearest" });
		}
	}, [selectedIndex]);

	if (suggestions.length === 0) return null;

	return (
		<div
			style={{
				left: Math.max(8, Math.min(position.x - 8, window.innerWidth - 350)),
				top: position.y + 4,
			}}
			className="absolute z-30 flex w-[330px] flex-col overflow-hidden rounded-card border border-border/80 bg-surface/96 shadow-popover backdrop-blur-md ring-1 ring-black/5 animate-in fade-in-0 zoom-in-95 duration-100 select-none text-[11.5px]"
			onClick={(e) => e.stopPropagation()}
		>
			{/* 列表项 */}
			<div ref={listRef} className="max-h-[210px] overflow-y-auto overscroll-contain p-1 space-y-0.5">
				{suggestions.map((item, index) => {
					const isSelected = index === selectedIndex;
					return (
						<div
							key={item.id}
							data-index={index}
							onClick={() => onSelect(item)}
							onMouseEnter={() => onHoverIndex(index)}
							className={cn(
								"group flex items-center justify-between gap-2 rounded-control px-2 py-1.5 cursor-pointer transition-colors",
								isSelected
									? "bg-surface-foreground/10 text-surface-foreground font-medium"
									: "text-surface-foreground hover:bg-surface-foreground/5",
							)}
						>
							<div className="flex items-center gap-1.5 min-w-0 flex-1">
								{/* 图标 */}
								<span
									className={cn(
										"size-3.5 shrink-0 transition-colors",
										item.source === "history" && (isSelected ? "text-primary" : "text-primary/70"),
										item.source === "snippet" && "text-amber-500",
										item.source === "preset" && "text-cyan-500",
										item.source === "history" && "icon-[lucide--history]",
										item.source === "snippet" && "icon-[lucide--code-2]",
										item.source === "preset" && "icon-[lucide--sparkles]",
									)}
								/>

								{/* 命令内容（高亮匹配前缀） */}
								<div className="min-w-0 flex-1 truncate font-mono text-[11px]">
									{renderHighlightedCommand(item.command, currentInput, isSelected)}
								</div>
							</div>

							{/* 右侧类别/频次指示 */}
							<div className="flex items-center gap-1 shrink-0">
								{item.source === "history" && item.count !== undefined && (
									<span className="font-mono text-[9px] text-faint group-hover:text-muted">
										{item.count > 1 ? `${item.count}次` : "历史"}
									</span>
								)}
								{item.source === "snippet" && (
									<span className="rounded bg-amber-500/10 px-1 py-0.2 text-[9px] font-sans font-medium text-amber-500 border border-amber-500/20">
										{item.description || "片段"}
									</span>
								)}
								{item.source === "preset" && (
									<span className="rounded bg-cyan-500/10 px-1 py-0.2 text-[9px] font-sans font-medium text-cyan-500 border border-cyan-500/20">
										常用
									</span>
								)}
							</div>
						</div>
					);
				})}
			</div>

			{/* 底栏：快捷键提示 */}
			<div className="flex items-center justify-between border-t border-border/60 bg-surface-sunk/60 px-2.5 py-1 text-[9.5px] text-faint font-mono">
				<div className="flex items-center gap-2">
					<span>
						<kbd className="rounded bg-surface px-1 py-0.2 border border-border/60">Tab</kbd> /{" "}
						<kbd className="rounded bg-surface px-1 py-0.2 border border-border/60">↵</kbd> 采纳
					</span>
					<span>
						<kbd className="rounded bg-surface px-1 py-0.2 border border-border/60">↑</kbd>{" "}
						<kbd className="rounded bg-surface px-1 py-0.2 border border-border/60">↓</kbd> 挑选
					</span>
				</div>
				<kbd className="rounded bg-surface px-1 py-0.2 border border-border/60">Esc</kbd>
			</div>
		</div>
	);
}

function renderHighlightedCommand(command: string, input: string, isSelected: boolean) {
	const trimmed = input.trimStart();
	if (trimmed && command.toLowerCase().startsWith(trimmed.toLowerCase())) {
		const matchPart = command.slice(0, trimmed.length);
		const restPart = command.slice(trimmed.length);
		return (
			<span className="whitespace-pre">
				<span className={cn(isSelected ? "text-primary font-bold" : "text-surface-foreground font-bold")}>
					{matchPart.replace(/ /g, "\u00A0")}
				</span>
				<span className="opacity-80">{restPart.replace(/ /g, "\u00A0")}</span>
			</span>
		);
	}
	return <span className="whitespace-pre">{command.replace(/ /g, "\u00A0")}</span>;
}
