import { Kbd } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Display";
import type { CommandItem } from "@/data/types";
import { cn } from "@/lib/cn";
import { useHostsStore } from "@/store/hosts";
import { useSnippetsStore } from "@/store/snippets";
import { toast } from "@/store/toast";
import { useUiStore } from "@/store/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

/* 命令面板浮层（需求书 04-① / 06）。
 * - 真实入口：由 WindowChrome 挂载，Ctrl+K 打开、Esc 关闭，用 useUiStore().paletteOpen 控制显隐。
 * - 复用入口：/palette 设计稿比对路由直接渲染 <CommandPalettePanel>（受控）。
 * 结果集全部来自真实数据：主机库 + 片段库 + 应用真实存在的静态动作，没有任何示例条目。 */

type PaletteGroupKey = "recent" | "host" | "command" | "setting";

interface PaletteGroup {
	key: PaletteGroupKey;
	items: CommandItem[];
}

const GROUP_TITLE: Record<PaletteGroupKey, string> = {
	recent: "最近连接",
	host: "主机",
	command: "命令片段与操作",
	setting: "设置",
};

/** 应用真实存在的快捷动作与设置入口（不是示例数据，是产品自身的功能清单） */
const STATIC_ACTIONS: CommandItem[] = [
	{ id: "act-new-tab", group: "command", title: "新建标签", shortcut: "Ctrl Shift T", icon: "icon-[lucide--square-plus]", keywords: ["tab", "标签"] },
	{ id: "act-split-right", group: "command", title: "向右分屏", shortcut: "Ctrl Shift D", icon: "icon-[lucide--columns-2]", keywords: ["split", "分屏"] },
	{ id: "act-split-down", group: "command", title: "向下分屏", shortcut: "Ctrl Shift E", icon: "icon-[lucide--rows-2]" },
	{ id: "act-toggle-sftp", group: "command", title: "显示 / 隐藏 SFTP 面板", shortcut: "Ctrl Shift S", icon: "icon-[lucide--folder-tree]", keywords: ["sftp", "文件"] },
	{ id: "act-broadcast", group: "command", title: "广播输入到全部终端", shortcut: "Ctrl Shift I", icon: "icon-[lucide--radio]" },
	{ id: "act-new-forward", group: "command", title: "新建端口转发规则", icon: "icon-[lucide--waypoints]", keywords: ["forward", "转发"] },
	{ id: "act-probe", group: "command", title: "对主机库测速", icon: "icon-[lucide--gauge]", keywords: ["测速", "延迟", "ping"] },
	{ id: "act-lock", group: "command", title: "锁定应用", shortcut: "Ctrl Shift L", icon: "icon-[lucide--lock]" },
	{ id: "set-appearance", group: "setting", title: "外观与主题", icon: "icon-[lucide--palette]", keywords: ["主题", "深色", "浅色"] },
	{ id: "set-terminal", group: "setting", title: "终端字体与配色", icon: "icon-[lucide--type]" },
	{ id: "set-shortcuts", group: "setting", title: "快捷键", shortcut: "Ctrl ,", icon: "icon-[lucide--keyboard]" },
	{ id: "set-security", group: "setting", title: "安全与应用锁", icon: "icon-[lucide--shield]" },
	{ id: "set-data", group: "setting", title: "数据与备份", icon: "icon-[lucide--database-backup]" },
	{ id: "set-keys", group: "setting", title: "密钥库", icon: "icon-[lucide--key-round]" },
];

/** 面板条目：主机（含真实最近连接） + 片段 + 静态动作 */
function usePaletteItems(): CommandItem[] {
	const hosts = useHostsStore((s) => s.hosts);
	const snippets = useSnippetsStore((s) => s.snippets);

	return useMemo(() => {
		const hostItems: CommandItem[] = hosts.map((h) => ({
			id: `host-${h.id}`,
			// 有真实连接时间的主机归入「最近连接」，其余归入「主机」
			group: h.lastConnectedAt ? "recent" : "host",
			title: h.name,
			subtitle: `${h.username}@${h.hostname}:${h.port}`,
			icon: h.os?.icon ?? "icon-[lucide--server]",
			env: h.env,
			keywords: [h.hostname, h.username, ...h.tags],
		}));

		const snippetItems: CommandItem[] = snippets.map((s) => ({
			id: `snippet-${s.id}`,
			group: "command",
			title: s.name,
			subtitle: s.command,
			icon: "icon-[lucide--terminal]",
			keywords: [s.group, ...s.variables],
		}));

		return [...hostItems, ...snippetItems, ...STATIC_ACTIONS];
	}, [hosts, snippets]);
}

/** 命中判定：标题 / 副标题 / 关键词 / 快捷键 */
function hit(item: CommandItem, term: string) {
	if (!term) return true;
	const hay = [item.title, item.subtitle ?? "", item.shortcut ?? "", ...(item.keywords ?? [])].join(" ").toLowerCase();
	return hay.includes(term);
}

/** 构造分组结果：`>` 前缀只搜命令，空查询展示最近连接 */
function buildGroups(items: CommandItem[], query: string): PaletteGroup[] {
	const raw = query.trim();
	const commandOnly = raw.startsWith(">");
	const term = (commandOnly ? raw.slice(1) : raw).trim().toLowerCase();

	if (commandOnly) {
		const found = items.filter((item) => item.group === "command" && hit(item, term));
		return found.length ? [{ key: "command", items: found }] : [];
	}

	// 空查询：优先展示真实有连接记录的最近主机；一台都没有就退回全部主机
	if (!term) {
		const recent = items.filter((item) => item.group === "recent");
		if (recent.length) return [{ key: "recent", items: recent }];
		const hosts = items.filter((item) => item.group === "host").slice(0, 8);
		return hosts.length ? [{ key: "host", items: hosts }] : [];
	}

	// 搜索：按 主机 / 命令 / 设置 分组（recent 本质是主机，归入主机组）
	const order: PaletteGroupKey[] = ["host", "command", "setting"];
	return order
		.map((key) => ({
			key,
			items: items.filter(
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

	const items = usePaletteItems();
	const groups = useMemo(() => buildGroups(items, query), [items, query]);
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
			// 主机项：直接进入连接流程（需求书设计目标：Ctrl+K → 输入几个字母 → 回车即连接）
			if (item.id.startsWith("host-")) {
				const hostId = item.id.slice("host-".length);
				navigate(`/connect?host=${encodeURIComponent(hostId)}`);
				return;
			}
			if (item.id.startsWith("snippet-")) {
				toast({
					title: `片段：${item.title}`,
					description: "到「命令片段」界面选择发送目标后使用。",
					tone: "default",
				});
				navigate("/snippets");
				return;
			}
			// 其余是静态快捷动作：目前只做提示，具体实现随对应能力接入
			toast({
				title: item.title,
				description: item.shortcut ? `快捷键 ${item.shortcut}` : "该动作尚未接入。",
				tone: "default",
			});
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
