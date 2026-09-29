import { Kbd } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Display";
import { commandItems } from "@/data/mock";
import type { CommandItem } from "@/data/types";
import { cn } from "@/lib/cn";
import { toast } from "@/store/toast";
import { useUiStore } from "@/store/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

/* 命令面板浮层（需求书 04-① / 06）。
 * - 真实入口：由 WindowChrome 挂载，Ctrl+K 打开、Esc 关闭，用 useUiStore().paletteOpen 控制显隐。
 * - 复用入口：/palette 设计稿比对路由直接渲染 <CommandPalettePanel>（受控）。
 * 状态覆盖：默认「最近使用」/ 搜索按主机·命令·设置分组 / `>` 前缀只搜命令 / 无结果。 */

type PaletteGroupKey = "recent" | "host" | "command" | "setting";

interface PaletteGroup {
	key: PaletteGroupKey;
	items: CommandItem[];
}

const GROUP_TITLE: Record<PaletteGroupKey, string> = {
	recent: "最近使用",
	host: "匹配的主机",
	command: "命令片段",
	setting: "快捷操作与设置",
};

/** 命中判定：标题 / 副标题 / 关键词 / 快捷键 */
function hit(item: CommandItem, term: string) {
	if (!term) return true;
	const hay = [item.title, item.subtitle ?? "", item.shortcut ?? "", ...(item.keywords ?? [])].join(" ").toLowerCase();
	return hay.includes(term);
}

/** 构造分组结果：`>` 前缀只搜命令，空查询展示最近使用 */
function buildGroups(query: string): PaletteGroup[] {
	const raw = query.trim();
	const commandOnly = raw.startsWith(">");
	const term = (commandOnly ? raw.slice(1) : raw).trim().toLowerCase();

	if (commandOnly) {
		const items = commandItems.filter((item) => item.group === "command" && hit(item, term));
		return items.length ? [{ key: "command", items }] : [];
	}

	// 空查询：默认展示最近使用
	if (!term) {
		const recent = commandItems.filter((item) => item.group === "recent");
		return recent.length ? [{ key: "recent", items: recent }] : [];
	}

	// 搜索：按 主机 / 命令 / 设置 分组（recent 本质是主机，归入主机组）
	const order: PaletteGroupKey[] = ["host", "command", "setting"];
	return order
		.map((key) => ({
			key,
			items: commandItems.filter(
				(item) => (key === "host" ? item.group === "host" || item.group === "recent" : item.group === key) && hit(item, term),
			),
		}))
		.filter((group) => group.items.length > 0);
}

export function CommandPalette() {
	const open = useUiStore((s) => s.paletteOpen);
	const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
	const close = useCallback(() => setPaletteOpen(false), [setPaletteOpen]);

	if (!open) return null;

	return <CommandPalettePanel onClose={close} />;
}

/** 面板本体：遮罩 + 输入框 + 结果列表 + 快捷键提示 */
export function CommandPalettePanel({
	open = true,
	onClose,
	initialQuery = "",
	className,
}: {
	open?: boolean;
	onClose?: () => void;
	initialQuery?: string;
	className?: string;
}) {
	const navigate = useNavigate();
	const [query, setQuery] = useState(initialQuery);
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	const groups = useMemo(() => buildGroups(query), [query]);
	const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
	const indexOf = useMemo(() => new Map(flat.map((item, index) => [item.id, index])), [flat]);

	// 结果集变化后把高亮收回到第一项
	useEffect(() => {
		setActiveIndex(0);
	}, [query]);

	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	const run = useCallback(
		(item?: CommandItem) => {
			if (!item) return;
			onClose?.();

			if (item.group === "setting") {
				toast({ title: `打开设置：${item.title}`, tone: "default" });
				navigate("/settings");
				return;
			}
			if (item.group === "command") {
				toast({
					title: `已执行：${item.title}`,
					description: item.shortcut ? `快捷键 ${item.shortcut}` : undefined,
					tone: "success",
				});
				return;
			}
			toast({ title: `正在连接 ${item.title}`, description: item.subtitle, tone: "default" });
			navigate("/");
		},
		[navigate, onClose],
	);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose?.();
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveIndex((index) => (flat.length ? (index + 1) % flat.length : 0));
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveIndex((index) => (flat.length ? (index - 1 + flat.length) % flat.length : 0));
				return;
			}
			if (e.key === "Enter") {
				e.preventDefault();
				run(flat[activeIndex]);
			}
		};

		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, flat, activeIndex, onClose, run]);

	if (!open) return null;

	const commandOnly = query.trim().startsWith(">");

	return (
		<div className={cn("absolute inset-0 z-50 flex items-start justify-center pt-[12vh]", className)}>
			{/* 半透明遮罩：点击关闭 */}
			<button
				type="button"
				aria-label="关闭命令面板"
				onClick={onClose}
				className="absolute inset-0 cursor-default bg-black/50"
			/>

			<div className="relative flex max-h-[76vh] w-[580px] flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-2xl">
				{/* 搜索输入栏 */}
				<div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border bg-surface px-3.5">
					<span className={cn("size-4 shrink-0", commandOnly ? "icon-[lucide--terminal] text-accent" : "icon-[lucide--search] text-primary")} />
					<input
						ref={inputRef}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="搜索主机、命令、设置…"
						spellCheck={false}
						className="h-full min-w-0 flex-1 bg-transparent font-mono text-[13px] text-surface-foreground placeholder:text-faint focus:outline-none"
					/>
					{commandOnly && <span className="shrink-0 font-mono text-[10px] text-accent">仅搜命令</span>}
					<button
						type="button"
						onClick={onClose}
						className="flex shrink-0 items-center rounded border border-border bg-surface-raised px-1.5 py-0.5 font-mono text-[9px] text-muted transition-colors hover:text-surface-foreground"
					>
						ESC
					</button>
				</div>

				{/* 结果列表 */}
				<div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-1.5">
					{flat.length === 0 ? (
						<EmptyState
							icon="icon-[lucide--search-x]"
							title="没有匹配的结果"
							description="换一个主机名、IP 或命令关键词试试；输入 > 只搜命令，输入为空时回到最近使用。"
						/>
					) : (
						groups.map((group) => (
							<div key={group.key}>
								<div className="px-2 py-1 font-mono text-[10px] font-semibold tracking-wider text-faint uppercase">
									{GROUP_TITLE[group.key]} ({group.items.length})
								</div>
								<div className="space-y-0.5">
									{group.items.map((item) => (
										<ResultRow
											key={item.id}
											item={item}
											selected={indexOf.get(item.id) === activeIndex}
											onHover={() => setActiveIndex(indexOf.get(item.id) ?? 0)}
											onRun={() => run(item)}
										/>
									))}
								</div>
							</div>
						))
					)}
				</div>

				{/* 底部快捷键提示 */}
				<div className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-surface-sunk px-3 font-mono text-[10.5px] text-faint">
					<div className="flex items-center gap-3">
						<span>
							<Kbd className="text-muted">↑↓</Kbd> 选择
						</span>
						<span>
							<Kbd className="text-muted">↵</Kbd> 执行
						</span>
						<span>
							输入 <Kbd className="text-muted">&gt;</Kbd> 仅搜命令
						</span>
					</div>
					<button type="button" onClick={onClose} className="font-sans text-primary hover:underline">
						关闭面板
					</button>
				</div>
			</div>
		</div>
	);
}

function ResultRow({
	item,
	selected,
	onHover,
	onRun,
}: {
	item: CommandItem;
	selected: boolean;
	onHover: () => void;
	onRun: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onRun}
			onMouseMove={onHover}
			className={cn(
				"flex h-9 w-full items-center justify-between gap-2 rounded border px-2.5 text-left text-[12px] transition-colors",
				selected
					? "border-border bg-surface text-surface-foreground"
					: "border-transparent text-muted hover:bg-surface hover:text-surface-foreground",
			)}
		>
			<span className="flex min-w-0 flex-1 items-center gap-2">
				<span className={cn(item.icon ?? "icon-[lucide--square-terminal]", "size-3.5 shrink-0", selected ? "text-primary" : "text-muted")} />
				<span className="truncate font-mono font-medium text-surface-foreground">{item.title}</span>
				{item.subtitle && <span className="truncate font-mono text-[11px] text-faint">{item.subtitle}</span>}
			</span>

			<span className="flex shrink-0 items-center gap-2">
				{item.keywords?.[0] && (
					<span className="rounded border border-border bg-surface px-1 py-px font-mono text-[9px] text-muted">
						{item.keywords[0]}
					</span>
				)}
				{item.shortcut ? (
					<span className="font-mono text-[9.5px] text-muted">{item.shortcut}</span>
				) : (
					selected && <span className="font-mono text-[9.5px] text-muted">回车</span>
				)}
			</span>
		</button>
	);
}
