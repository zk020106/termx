import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState, EnvPill, Segmented } from "@/components/ui/Display";
import { editorTabs } from "@/data/mock";
import type { EditorTab } from "@/data/types";
import { cn } from "@/lib/cn";
import { toast } from "@/store/toast";
import { useEffect, useMemo, useRef, useState } from "react";

/* =============================================================================
 * 内置编辑器 —— 设计帧 termx.vetd/frames/editor.tsx 的交互版。
 * 状态：多文件标签 / 未保存圆点 / 保存冲突（左右分栏 Diff + 手动合并）。
 * 语法高亮按 lines[].type 走 token（comment / key / string / number / pair）。
 * ========================================================================== */

type Line = EditorTab["lines"][number];
type EditorMode = "edit" | "diff" | "merge";

const STATE_OPTIONS: { value: EditorMode; label: string }[] = [
	{ value: "edit", label: "编辑" },
	{ value: "diff", label: "保存冲突" },
	{ value: "merge", label: "手动合并" },
];

/** 只读的日志标签（界面内演示数据；mock 里的 editorTabs 只有两个文件） */
const APP_LOG_TAB: EditorTab = {
	id: "ed-applog",
	path: "/home/deploy/app/logs/app.log",
	hostId: "order-api-01",
	modified: false,
	lines: [
		{ num: 1, text: "# 尾部 10 行 · 只读打开（超过 5 MB 的文件默认只读）", type: "comment" },
		{ num: 2, text: "2026-09-23 14:41:02 INFO  [main] OrderService started on port 8080" },
		{ num: 3, text: "2026-09-23 14:41:03 INFO  [http-nio-8080] created id=88213 user=chen" },
		{ num: 4, text: "2026-09-23 14:41:05 WARN  [db-pool-2] Slow query 1.2s: SELECT * FROM orders" },
		{ num: 5, text: "2026-09-23 14:41:08 ERROR [redis-client] Connection timeout to 10.0.8.40:6379" },
		{ num: 6, text: "2026-09-23 14:41:09 INFO  [retry-worker] Failover to redis replica 10.0.8.41: OK" },
		{ num: 7, text: "2026-09-23 14:41:12 INFO  [http-nio-8080] GET /api/orders 200 34ms" },
	],
};

/** 远端在编辑期间被改写过的那一份（局部演示数据） */
const REMOTE_VERSION: Record<string, string[]> = {
	"ed-app-yml": [
		"server:",
		"  port: 8090",
		"  shutdown: graceful",
		"  compression:",
		"    enabled: true",
		"",
		"spring:",
		"  profiles:",
		"    active: ${SPRING_PROFILES_ACTIVE:prod}",
		"  datasource:",
		"    url: jdbc:postgresql://10.2.0.11:5432/orders",
		"    hikari:",
		"      maximum-pool-size: 16",
		"      connection-timeout: 3000",
		"",
		"# 由运维 sidecar 在 10:06 自动写入",
	],
	"ed-nginx": [
		"upstream order_api {",
		"    server 10.0.3.21:8080;",
		"    server 10.0.3.22:8080;",
		"    keepalive 32;",
		"}",
		"",
		"server {",
		"    listen 443 ssl http2;",
		"    server_name order.example.com;",
		"    client_max_body_size 20m;",
		"}",
	],
};

/** 语言标签 */
function langLabel(path: string): string {
	if (path.endsWith(".yml") || path.endsWith(".yaml")) return "YAML";
	if (path.endsWith(".conf") || path.endsWith(".nginx")) return "Nginx";
	if (path.endsWith(".log")) return "Log";
	if (path.endsWith(".sh")) return "Shell";
	if (path.endsWith(".json")) return "JSON";
	return "Plain";
}

function baseName(path: string): string {
	return path.split("/").pop() ?? path;
}

/* ------------------------------ 语法高亮 ------------------------------ */

function valueTone(value: string): string {
	if (/^(true|false|null|~)$/.test(value)) return "text-warning";
	if (/^-?[\d._]+[a-z%]*$/i.test(value)) return "text-warning";
	return "text-accent";
}

function CodeLine({ line }: { line: Line }) {
	if (line.type === "comment") return <span className="text-muted italic">{line.text}</span>;
	if (line.type === "key") return <span className="font-medium text-primary">{line.text}</span>;
	if (line.type === "string") return <span className="text-accent">{line.text}</span>;
	if (line.type === "number") return <span className="text-warning">{line.text}</span>;
	if (line.type === "pair") {
		const at = line.text.indexOf(": ");
		if (at < 0) return <span className="text-term-ink">{line.text}</span>;
		return (
			<>
				<span className="text-term-ink">{line.text.slice(0, at + 2)}</span>
				<span className={valueTone(line.text.slice(at + 2))}>{line.text.slice(at + 2)}</span>
			</>
		);
	}
	return <span className="text-term-ink">{line.text}</span>;
}

/* ------------------------------ 行级 Diff ------------------------------ */

type DiffKind = "same" | "add" | "del" | "change";

interface DiffRow {
	kind: DiffKind;
	left: string | null;
	right: string | null;
	leftNum: number | null;
	rightNum: number | null;
}

/** LCS 行差：先求最长公共子序列，再把相邻的删除 + 新增合并成「修改」 */
function diffLines(a: string[], b: string[]): DiffRow[] {
	const n = a.length;
	const m = b.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i -= 1) {
		for (let j = m - 1; j >= 0; j -= 1) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const raw: DiffRow[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			raw.push({ kind: "same", left: a[i], right: b[j], leftNum: i + 1, rightNum: j + 1 });
			i += 1;
			j += 1;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			raw.push({ kind: "del", left: a[i], right: null, leftNum: i + 1, rightNum: null });
			i += 1;
		} else {
			raw.push({ kind: "add", left: null, right: b[j], leftNum: null, rightNum: j + 1 });
			j += 1;
		}
	}
	while (i < n) {
		raw.push({ kind: "del", left: a[i], right: null, leftNum: i + 1, rightNum: null });
		i += 1;
	}
	while (j < m) {
		raw.push({ kind: "add", left: null, right: b[j], leftNum: null, rightNum: j + 1 });
		j += 1;
	}

	// 相邻的 del + add 合并为 change，视觉上更像「同一处被改写」
	const merged: DiffRow[] = [];
	for (let k = 0; k < raw.length; k += 1) {
		const cur = raw[k];
		const next = raw[k + 1];
		if (cur.kind === "del" && next?.kind === "add") {
			merged.push({
				kind: "change",
				left: cur.left,
				right: next.right,
				leftNum: cur.leftNum,
				rightNum: next.rightNum,
			});
			k += 1;
		} else {
			merged.push(cur);
		}
	}
	return merged;
}

type MergeBlock = { kind: "same"; lines: string[] } | { kind: "conflict"; left: string[]; right: string[] };

function toBlocks(rows: DiffRow[]): MergeBlock[] {
	const blocks: MergeBlock[] = [];
	let same: string[] = [];
	let left: string[] = [];
	let right: string[] = [];

	const flushSame = () => {
		if (same.length > 0) {
			blocks.push({ kind: "same", lines: same });
			same = [];
		}
	};
	const flushConflict = () => {
		if (left.length > 0 || right.length > 0) {
			blocks.push({ kind: "conflict", left, right });
			left = [];
			right = [];
		}
	};

	for (const row of rows) {
		if (row.kind === "same") {
			flushConflict();
			same.push(row.left ?? "");
		} else {
			flushSame();
			if (row.left !== null) left.push(row.left);
			if (row.right !== null) right.push(row.right);
		}
	}
	flushSame();
	flushConflict();
	return blocks;
}

/* ------------------------------- 界面 ------------------------------- */

export default function Editor() {
	const [mode, setMode] = useState<EditorMode>("edit");
	const [tabs, setTabs] = useState<EditorTab[]>(() => [...editorTabs, APP_LOG_TAB]);
	const [activeId, setActiveId] = useState("ed-app-yml");
	const [conflicts, setConflicts] = useState<string[]>(["ed-app-yml"]);
	const [dirtyIds, setDirtyIds] = useState<string[]>(() => editorTabs.filter((t) => t.modified).map((t) => t.id));
	const [cursor, setCursor] = useState({ line: 4, col: 18 });
	const [editing, setEditing] = useState<{ num: number; text: string } | null>(null);
	const [choices, setChoices] = useState<Record<number, "mine" | "theirs">>({});

	const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
	const name = baseName(active.path);
	const readOnly = active.id === APP_LOG_TAB.id;
	const dirty = dirtyIds.includes(active.id);
	const hasConflict = conflicts.includes(active.id);
	const remoteLines = REMOTE_VERSION[active.id];

	const rows = useMemo(
		() => (remoteLines ? diffLines(active.lines.map((l) => l.text), remoteLines) : []),
		[active.lines, remoteLines],
	);
	const blocks = useMemo(() => toBlocks(rows), [rows]);
	const stats = useMemo(
		() => ({
			add: rows.filter((r) => r.kind === "add").length,
			del: rows.filter((r) => r.kind === "del").length,
			change: rows.filter((r) => r.kind === "change").length,
		}),
		[rows],
	);

	const markDirty = (id: string) => setDirtyIds((ids) => (ids.includes(id) ? ids : [...ids, id]));

	const save = () => {
		if (readOnly) {
			toast({ title: "只读文件无法保存", description: `${name} 超过只读阈值，已在只读模式下打开`, tone: "warning" });
			return;
		}
		if (hasConflict) {
			toast({
				title: "保存被拦截：远端文件已被并发修改",
				description: "请先查看差异，选择保留我的版本或远端版本",
				tone: "warning",
			});
			return;
		}
		setDirtyIds((ids) => ids.filter((id) => id !== active.id));
		toast({ title: `已保存 ${name}`, description: `${active.path} · ${active.lines.length} 行`, tone: "success" });
	};

	const saveRef = useRef(save);
	saveRef.current = save;

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				saveRef.current();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const commitLine = (text: string) => {
		if (!editing) return;
		const num = editing.num;
		setTabs((prev) =>
			prev.map((t) => (t.id === active.id ? { ...t, lines: t.lines.map((l) => (l.num === num ? { ...l, text } : l)) } : t)),
		);
		markDirty(active.id);
		setEditing(null);
	};

	const resolveConflict = (choice: "mine" | "theirs") => {
		setConflicts((ids) => ids.filter((id) => id !== active.id));
		setDirtyIds((ids) => ids.filter((id) => id !== active.id));
		setMode("edit");
		toast({
			title: choice === "mine" ? "已强制覆盖远端文件" : "已放弃本地修改",
			description: `${name} · ${active.path}`,
			tone: choice === "mine" ? "success" : "default",
		});
	};

	const closeTab = (id: string) => {
		if (tabs.length === 1) {
			toast({ title: "至少保留一个标签", tone: "warning" });
			return;
		}
		const next = tabs.filter((t) => t.id !== id);
		setTabs(next);
		setConflicts((ids) => ids.filter((x) => x !== id));
		if (activeId === id) setActiveId(next[0].id);
	};

	const openMore = () => {
		const missing = [APP_LOG_TAB, ...editorTabs].find((t) => !tabs.some((x) => x.id === t.id));
		if (!missing) {
			toast({ title: "没有更多可打开的文件", description: "从 SFTP 面板双击文件可继续打开", tone: "default" });
			return;
		}
		setTabs((prev) => [...prev, missing]);
		setActiveId(missing.id);
	};

	return (
		<WindowChrome>
			<div className="relative flex min-h-0 flex-1 flex-col bg-term">
				{/* 编辑器标签栏（Linear 极简风） */}
				<div className="flex h-8.5 shrink-0 items-end justify-between border-b border-border bg-surface-sunk px-2">
					<div className="flex min-w-0 items-center gap-1">
						{tabs.map((tab) => {
							const on = tab.id === active.id;
							const tabDirty = dirtyIds.includes(tab.id);
							return (
								<div
									key={tab.id}
									role="button"
									tabIndex={0}
									onClick={() => setActiveId(tab.id)}
									onKeyDown={(e) => e.key === "Enter" && setActiveId(tab.id)}
									className={cn(
										"flex h-7.5 shrink-0 cursor-pointer items-center gap-2 rounded-t border-x border-t px-3 text-[12px] transition-colors",
										on
											? "border-border bg-term text-surface-foreground"
											: "border-transparent text-muted hover:text-surface-foreground",
									)}
								>
									{tabDirty && <span className="size-1.5 shrink-0 rounded-full bg-warning" title="已修改未保存" />}
									<span className="font-mono">{baseName(tab.path)}</span>
									{tab.id === APP_LOG_TAB.id ? (
										<span className="font-mono text-[10px] text-faint">只读</span>
									) : (
										<span className="font-mono text-[10px] text-faint">{tab.hostId}</span>
									)}
									<button
										type="button"
										aria-label={`关闭 ${baseName(tab.path)}`}
										onClick={(e) => {
											e.stopPropagation();
											closeTab(tab.id);
										}}
										className="ml-1 rounded text-muted transition-colors hover:text-surface-foreground"
									>
										<span className="icon-[lucide--x] size-3" />
									</button>
								</div>
							);
						})}

						<button
							type="button"
							onClick={openMore}
							title="打开更多文件"
							aria-label="打开更多文件"
							className="mb-1 flex size-6 items-center justify-center rounded text-muted hover:bg-surface hover:text-surface-foreground"
						>
							<span className="icon-[lucide--plus] size-3" />
						</button>
					</div>

					{/* 快捷操作 + 状态切换器 */}
					<div className="flex shrink-0 items-center gap-3 pb-1 text-[11px] text-muted">
						<span className="font-mono">UTF-8</span>
						<span className="font-mono">{langLabel(active.path)}</span>
						{readOnly ? (
							<span className="font-sans text-faint">只读打开</span>
						) : (
							<button
								type="button"
								onClick={save}
								className={cn(
									"font-sans font-medium transition-colors hover:underline",
									dirty ? "text-warning" : "text-primary",
								)}
							>
								{dirty ? "Ctrl + S 保存 ·" : "Ctrl + S 已保存"}
							</button>
						)}
						<span className="h-3.5 w-px bg-border" />
						<span className="font-mono text-[10.5px] text-faint">状态</span>
						<Segmented value={mode} onChange={setMode} options={STATE_OPTIONS} />
					</div>
				</div>

				{/* 路径与只读标识面包屑 */}
				<div className="flex h-6.5 shrink-0 items-center justify-between border-b border-border/40 bg-surface/80 px-3 font-mono text-[11px] text-muted">
					<div className="flex min-w-0 items-center gap-1.5">
						<span className="icon-[lucide--server] size-3 shrink-0 text-primary" />
						<span className="shrink-0 text-surface-foreground">{active.hostId}</span>
						<span>:</span>
						<span className="truncate text-muted">{active.path}</span>
						<EnvPill env="prod" size="xs" />
						{readOnly && <Badge className="border-faint/40">只读</Badge>}
					</div>
					<div className="flex shrink-0 items-center gap-2 tabular-nums text-faint">
						<span>
							{mode === "edit"
								? `行 ${cursor.line}, 列 ${cursor.col}`
								: mode === "diff"
									? "冲突对比中"
									: "手动合并中"}
						</span>
						<span>·</span>
						<span>{active.lines.length} 行</span>
					</div>
				</div>

				{mode === "edit" && (
					<CodeView
						lines={active.lines}
						cursorLine={cursor.line}
						editing={editing}
						readOnly={readOnly}
						onCursor={(num) => setCursor({ line: num, col: 1 })}
						onEdit={(num, text) => setEditing({ num, text })}
						onDraft={(text) => setEditing((prev) => (prev ? { ...prev, text } : prev))}
						onCommit={commitLine}
						onCancel={() => setEditing(null)}
						notice={
							hasConflict
								? {
										onDiscard: () => resolveConflict("theirs"),
										onDiff: () => setMode("diff"),
										onForce: () => resolveConflict("mine"),
									}
								: null
						}
					/>
				)}

				{mode === "diff" &&
					(remoteLines ? (
						<DiffView
							rows={rows}
							stats={stats}
							name={name}
							mineCount={active.lines.length}
							theirsCount={remoteLines.length}
							onKeepMine={() => resolveConflict("mine")}
							onKeepTheirs={() => resolveConflict("theirs")}
							onMerge={() => {
								setChoices({});
								setMode("merge");
							}}
						/>
					) : (
						<div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
							<EmptyState
								icon="icon-[lucide--check-check]"
								title="该文件没有保存冲突"
								description={`${name} 的远端内容与本地缓冲区一致，可以直接保存。`}
								action={
									<Button size="sm" icon="icon-[lucide--arrow-left]" onClick={() => setMode("edit")}>
										返回编辑器
									</Button>
								}
							/>
						</div>
					))}

				{mode === "merge" &&
					(remoteLines ? (
						<MergeView
							blocks={blocks}
							choices={choices}
							onChoose={(index, side) => setChoices((prev) => ({ ...prev, [index]: side }))}
							onCancel={() => setMode("diff")}
							onSave={() => {
								resolveConflict("mine");
								toast({ title: "已保存合并结果", description: `${name} · 合并冲突已全部解决`, tone: "success" });
							}}
						/>
					) : (
						<div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
							<EmptyState
								icon="icon-[lucide--git-merge]"
								title="没有需要合并的内容"
								description="切换到一个与远端不一致的标签后再试。"
								action={
									<Button size="sm" icon="icon-[lucide--arrow-left]" onClick={() => setMode("edit")}>
										返回编辑器
									</Button>
								}
							/>
						</div>
					))}
			</div>
		</WindowChrome>
	);
}

/* ------------------------------- 代码视图 ------------------------------- */

function CodeView({
	lines,
	cursorLine,
	editing,
	readOnly,
	onCursor,
	onEdit,
	onDraft,
	onCommit,
	onCancel,
	notice,
}: {
	lines: Line[];
	cursorLine: number;
	editing: { num: number; text: string } | null;
	readOnly: boolean;
	onCursor: (num: number) => void;
	onEdit: (num: number, text: string) => void;
	onDraft: (text: string) => void;
	onCommit: (text: string) => void;
	onCancel: () => void;
	notice: { onDiscard: () => void; onDiff: () => void; onForce: () => void } | null;
}) {
	return (
		<div className="relative min-h-0 flex-1 overflow-y-auto p-3 font-mono text-[12.5px] leading-6">
			{lines.map((line) => (
				<div
					key={line.num}
					onMouseDown={() => onCursor(line.num)}
					onDoubleClick={() =>
						readOnly
							? toast({ title: "只读文件无法编辑", description: "可先用 SFTP 下载后用本地编辑器打开", tone: "warning" })
							: onEdit(line.num, line.text)
					}
					className={cn(
						"grid cursor-text grid-cols-[40px_1fr] rounded-[3px]",
						line.num === cursorLine ? "bg-primary/10" : "hover:bg-surface-raised/40",
					)}
				>
					<span className="select-none pr-4 text-right text-[11px] tabular-nums text-faint/60">{line.num}</span>
					{editing?.num === line.num ? (
						<input
							autoFocus
							value={editing.text}
							onChange={(e) => onDraft(e.target.value)}
							onBlur={() => onCancel()}
							onKeyDown={(e) => {
								if (e.key === "Enter") onCommit(editing.text);
								if (e.key === "Escape") onCancel();
							}}
							className="w-full bg-surface-sunk px-1 font-mono text-[12.5px] text-surface-foreground outline-none"
						/>
					) : (
						<span className="min-w-0 truncate">
							<CodeLine line={line} />
						</span>
					)}
				</div>
			))}

			<div className="mt-3 flex items-center gap-2 pl-10 font-sans text-[11px] text-faint">
				<span className="icon-[lucide--mouse-pointer-click] size-3" />
				<span>双击任意行可原地修改，回车提交后标签上出现未保存圆点</span>
			</div>

			{/* 浮动冲突提示卡片 */}
			{notice && (
				<div className="absolute right-4 bottom-4 w-[380px] rounded-card border border-warning/40 bg-surface-raised p-4 shadow-2xl">
					<div className="flex items-center gap-2.5">
						<div className="flex size-6 shrink-0 items-center justify-center rounded bg-warning/15 text-warning">
							<span className="icon-[lucide--triangle-alert] size-3.5" />
						</div>
						<div className="min-w-0 flex-1">
							<div className="flex items-center justify-between gap-2">
								<h4 className="text-[12.5px] font-semibold text-surface-foreground">远端文件已被并发修改</h4>
								<span className="font-mono text-[10px] tabular-nums text-faint">10:06:12</span>
							</div>
							<p className="mt-1 text-[11.5px] leading-relaxed text-muted">
								在您打开编辑期间，远端服务器该文件被其他进程或运维人员写入了新的内容。
							</p>
						</div>
					</div>

					<div className="mt-3.5 flex items-center justify-end gap-2 border-t border-border pt-3">
						<Button size="sm" onClick={notice.onDiscard}>
							放弃本地修改
						</Button>
						<Button size="sm" className="border-primary/40 bg-primary/10 text-primary hover:bg-primary/20" onClick={notice.onDiff}>
							查看 Diff 差异
						</Button>
						<Button size="sm" variant="primary" onClick={notice.onForce}>
							强制覆盖远端
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

/* ------------------------------- 分栏 Diff ------------------------------- */

function DiffCell({ row, side }: { row: DiffRow; side: "left" | "right" }) {
	const text = side === "left" ? row.left : row.right;
	const num = side === "left" ? row.leftNum : row.rightNum;

	if (text === null) {
		return (
			<div className="grid grid-cols-[40px_1fr] items-center bg-surface-sunk/40">
				<span className="select-none pr-4 text-right text-[11px] tabular-nums text-faint/40">{""}</span>
				<span className="text-[11px] text-faint/50">{row.kind === "change" ? "—" : "⋯"}</span>
			</div>
		);
	}

	const tone =
		row.kind === "same"
			? ""
			: row.kind === "change"
				? "bg-warning/10 text-warning"
				: side === "left"
					? "bg-danger/10 text-danger"
					: "bg-success/10 text-success";
	const bar =
		row.kind === "same"
			? "border-transparent"
			: row.kind === "change"
				? "border-warning/70"
				: side === "left"
					? "border-danger/70"
					: "border-success/70";

	return (
		<div className={cn("grid grid-cols-[40px_1fr] items-center border-l-2", tone, bar)}>
			<span className="select-none pr-4 text-right text-[11px] tabular-nums text-faint/60">{num}</span>
			<span className="flex min-w-0 items-center gap-1.5 truncate pr-3">
				{row.kind !== "same" && (
					<span className="shrink-0 font-mono text-[10px] opacity-70">
						{row.kind === "change" ? "±" : side === "left" ? "−" : "+"}
					</span>
				)}
				<span className="truncate">{text === "" ? " " : text}</span>
			</span>
		</div>
	);
}

function DiffView({
	rows,
	stats,
	name,
	mineCount,
	theirsCount,
	onKeepMine,
	onKeepTheirs,
	onMerge,
}: {
	rows: DiffRow[];
	stats: { add: number; del: number; change: number };
	name: string;
	mineCount: number;
	theirsCount: number;
	onKeepMine: () => void;
	onKeepTheirs: () => void;
	onMerge: () => void;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* 冲突摘要 */}
			<div className="flex h-8 shrink-0 items-center justify-between gap-3 border-b border-border bg-warning/10 px-3 text-[11.5px]">
				<div className="flex min-w-0 items-center gap-2 text-warning">
					<span className="icon-[lucide--git-compare] size-3.5 shrink-0" />
					<span className="truncate font-medium">
						保存冲突：<span className="font-mono">{name}</span> 的远端内容在您编辑期间被改写
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-3 font-mono text-[10.5px] tabular-nums text-muted">
					<span className="flex items-center gap-1">
						<span className="size-2 rounded-[2px] bg-success/70" />新增 {stats.add}
					</span>
					<span className="flex items-center gap-1">
						<span className="size-2 rounded-[2px] bg-danger/70" />删除 {stats.del}
					</span>
					<span className="flex items-center gap-1">
						<span className="size-2 rounded-[2px] bg-warning/70" />修改 {stats.change}
					</span>
				</div>
			</div>

			{/* 两栏表头 */}
			<div className="grid h-7 shrink-0 grid-cols-2 border-b border-border bg-surface-sunk">
				<div className="flex items-center gap-1.5 border-r border-border px-3 text-[11px]">
					<span className="icon-[lucide--monitor] size-3 text-primary" />
					<span className="text-surface-foreground">我的版本（本地缓冲区）</span>
					<span className="ml-auto font-mono text-[10px] tabular-nums text-faint">{mineCount} 行</span>
				</div>
				<div className="flex items-center gap-1.5 px-3 text-[11px]">
					<span className="icon-[lucide--cloud] size-3 text-accent" />
					<span className="text-surface-foreground">远端最新（10:06:12 由 ops 写入）</span>
					<span className="ml-auto font-mono text-[10px] tabular-nums text-faint">{theirsCount} 行</span>
				</div>
			</div>

			{/* 差异正文：单滚动容器，两栏严格对齐 */}
			<div className="min-h-0 flex-1 overflow-y-auto py-1 font-mono text-[12px] leading-6">
				{rows.map((row, index) => (
					<div key={index} className="grid grid-cols-2">
						<DiffCell row={row} side="left" />
						<DiffCell row={row} side="right" />
					</div>
				))}
			</div>

			{/* 处理动作 */}
			<div className="flex h-12 shrink-0 items-center justify-between gap-3 border-t border-border bg-surface-raised px-3">
				<div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
					<span className="icon-[lucide--info] size-3 shrink-0 text-faint" />
					<span className="truncate">
						保存时若直接覆盖，运维在 10:06 写入的 <span className="font-mono">compression</span> 配置会丢失
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Button size="sm" icon="icon-[lucide--monitor-check]" onClick={onKeepMine}>
						保留我的
					</Button>
					<Button size="sm" icon="icon-[lucide--cloud-download]" onClick={onKeepTheirs}>
						保留远端
					</Button>
					<Button size="sm" variant="primary" icon="icon-[lucide--git-merge]" onClick={onMerge}>
						手动合并
					</Button>
				</div>
			</div>
		</div>
	);
}

/* ------------------------------- 手动合并 ------------------------------- */

function MergeView({
	blocks,
	choices,
	onChoose,
	onCancel,
	onSave,
}: {
	blocks: MergeBlock[];
	choices: Record<number, "mine" | "theirs">;
	onChoose: (index: number, side: "mine" | "theirs") => void;
	onCancel: () => void;
	onSave: () => void;
}) {
	const pending = blocks.filter((b, i) => b.kind === "conflict" && !choices[i]).length;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-8 shrink-0 items-center justify-between gap-3 border-b border-border bg-warning/10 px-3 text-[11.5px]">
				<div className="flex items-center gap-2 text-warning">
					<span className="icon-[lucide--git-merge] size-3.5" />
					<span className="font-medium">手动合并 · 每处冲突单独选择保留哪一侧</span>
				</div>
				<span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted">
					冲突 {blocks.filter((b) => b.kind === "conflict").length} 处 · 待决定 {pending} 处
				</span>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-3 font-mono text-[12.5px] leading-6">
				{blocks.map((block, index) =>
					block.kind === "same" ? (
						<div key={`same-${index}`}>
							{block.lines.map((text, i) => (
								<div key={i} className="grid grid-cols-[40px_1fr]">
									<span className="select-none pr-4 text-right text-[11px] tabular-nums text-faint/50">{""}</span>
									<span className="truncate text-term-ink">{text === "" ? " " : text}</span>
								</div>
							))}
						</div>
					) : (
						<div key={`conflict-${index}`} className="my-2 overflow-hidden rounded-card border border-warning/40">
							<div className="flex items-center justify-between gap-2 border-b border-warning/30 bg-warning/10 px-2 py-1">
								<span className="font-mono text-[10.5px] text-warning">
									冲突 #{index} · 我的版本 {block.left.length} 行 / 远端 {block.right.length} 行
								</span>
								<div className="flex items-center gap-1.5">
									<Button
										size="sm"
										variant={choices[index] === "theirs" ? "default" : "primary"}
										icon="icon-[lucide--monitor]"
										onClick={() => onChoose(index, "mine")}
									>
										采用我的
									</Button>
									<Button
										size="sm"
										variant={choices[index] === "theirs" ? "primary" : "default"}
										icon="icon-[lucide--cloud]"
										onClick={() => onChoose(index, "theirs")}
									>
										采用远端
									</Button>
								</div>
							</div>

							<div className={cn("px-2 py-1.5", choices[index] === "theirs" && "opacity-45")}>
								<div className="flex items-center gap-1.5 font-mono text-[10px] text-danger">
									<span className="icon-[lucide--minus] size-3" />
									<span>&lt;&lt;&lt;&lt;&lt;&lt;&lt; 我的版本</span>
								</div>
								{block.left.map((text, i) => (
									<div key={i} className="truncate pl-4 text-danger/90">
										{text === "" ? " " : text}
									</div>
								))}
							</div>

							<div className={cn("border-t border-border/60 px-2 py-1.5", choices[index] !== "theirs" && "opacity-45")}>
								<div className="flex items-center gap-1.5 font-mono text-[10px] text-success">
									<span className="icon-[lucide--plus] size-3" />
									<span>&gt;&gt;&gt;&gt;&gt;&gt;&gt; 远端最新</span>
								</div>
								{block.right.map((text, i) => (
									<div key={i} className="truncate pl-4 text-success/90">
										{text === "" ? " " : text}
									</div>
								))}
							</div>
						</div>
					),
				)}
			</div>

			<div className="flex h-12 shrink-0 items-center justify-between gap-3 border-t border-border bg-surface-raised px-3">
				<span className="font-mono text-[11px] text-faint">
					合并结果写回后，标签页的未保存圆点会清除
				</span>
				<div className="flex shrink-0 items-center gap-2">
					<Button size="sm" icon="icon-[lucide--arrow-left]" onClick={onCancel}>
						返回差异对比
					</Button>
					<Button size="sm" variant="primary" icon="icon-[lucide--check]" onClick={onSave}>
						完成合并并保存
					</Button>
				</div>
			</div>
		</div>
	);
}
