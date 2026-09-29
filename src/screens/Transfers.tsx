import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button, IconButton } from "@/components/ui/Button";
import { Badge, EmptyState, EnvPill, ProgressBar, Segmented } from "@/components/ui/Display";
import { Checkbox } from "@/components/ui/Toggle";
import type { Transfer, TransferState } from "@/data/types";
import { cn } from "@/lib/cn";
import { formatBytes, formatDuration, formatSpeed } from "@/lib/format";
import { toast } from "@/store/toast";
import { transferSummary, useTransfersStore } from "@/store/transfers";
import { useState } from "react";
import { Link } from "react-router";

/* =============================================================================
 * 传输队列 —— 设计帧 termx.vetd/frames/transfers.tsx 的交互版。
 * 状态：进行中 / 已暂停 / 失败 / 已完成 / 空（需求书 06-传输队列），数据来自 useTransfersStore。
 * ========================================================================== */

type Scope = "all" | "running" | "paused" | "failed" | "done" | "empty";

const SCOPE_OPTIONS: { value: Scope; label: string }[] = [
	{ value: "all", label: "全部" },
	{ value: "running", label: "进行中" },
	{ value: "paused", label: "已暂停" },
	{ value: "failed", label: "失败" },
	{ value: "done", label: "已完成" },
	{ value: "empty", label: "空" },
];

const STATE_LABEL: Record<TransferState, string> = {
	queued: "排队中",
	running: "进行中",
	paused: "已暂停",
	failed: "传输失败",
	done: "已完成",
};

const STATE_TONE: Record<TransferState, string> = {
	queued: "text-faint",
	running: "text-primary",
	paused: "text-warning",
	failed: "text-danger",
	done: "text-success",
};

const BAR_TONE: Record<TransferState, "primary" | "warning" | "danger" | "success"> = {
	queued: "primary",
	running: "primary",
	paused: "warning",
	failed: "danger",
	done: "success",
};

const BAR_CLASS: Record<TransferState, string> = {
	queued: "bg-primary",
	running: "bg-primary",
	paused: "bg-warning",
	failed: "bg-danger",
	done: "bg-success",
};

const CARD_BORDER: Record<TransferState, string> = {
	queued: "border-border",
	running: "border-primary/40",
	paused: "border-warning/40",
	failed: "border-danger/40",
	done: "border-success/40",
};

/** 界面内演示数据：mock 里没有速度/耗时的项补一个「上次速度」与「耗时」 */
const DEMO_TIMING: Record<string, { speed: number; elapsed: number }> = {
	"tr-app-log": { speed: 2_200_000, elapsed: 5.6 },
	"tr-config": { speed: 5_120, elapsed: 0.4 },
	"tr-release": { speed: 3_400_000, elapsed: 6.4 },
	"tr-dump": { speed: 5_600_000, elapsed: 71.8 },
};

/** 进行中任务的吞吐采样（演示用，单位 MB/s） */
const SAMPLES = [1.6, 1.9, 2.4, 2.1, 2.6, 2.2, 1.8, 2.3, 2.7, 2.4, 2.0, 2.2, 2.5, 2.1, 2.3, 2.2];

function timingOf(item: Transfer) {
	return DEMO_TIMING[item.id] ?? { speed: item.speedBps || 1_048_576, elapsed: 4 };
}

function percentOf(item: Transfer): number {
	if (item.size <= 0) return 0;
	return Math.min(100, Math.round((item.transferred / item.size) * 100));
}

/** 每条任务的「进度 · 速度 · 剩余时间」摘要 */
function metaOf(item: Transfer): string {
	const { speed, elapsed } = timingOf(item);
	const progress = `${formatBytes(item.transferred)} / ${formatBytes(item.size)}`;
	const remain = item.size - item.transferred;

	switch (item.state) {
		case "running":
			return `${progress} · ${formatSpeed(item.speedBps || speed)} · 剩余 ${formatDuration(item.etaSec ?? remain / speed)}`;
		case "paused":
			return `${progress} · ${formatSpeed(speed)}（暂停前） · 剩余 ${formatDuration(remain / speed)}`;
		case "failed":
			return `${progress} · ${formatSpeed(speed)}（断流前） · 剩余 ${formatDuration(remain / speed)}`;
		case "done":
			return `${formatBytes(item.size)} · 平均 ${formatSpeed(item.size / elapsed)} · 耗时 ${formatDuration(elapsed)}`;
		default:
			return `${formatBytes(item.size)} 待传输 · 等待空闲通道`;
	}
}

function targetOf(item: Transfer): string {
	return item.direction === "upload" ? `↑ 上传至 ${item.remotePath}` : `↓ 下载至 ${item.localPath}`;
}

export default function Transfers() {
	const items = useTransfersStore((s) => s.items);
	const setState = useTransfersStore((s) => s.setState);
	const retry = useTransfersStore((s) => s.retry);
	const remove = useTransfersStore((s) => s.remove);
	const clearDone = useTransfersStore((s) => s.clearDone);

	const [scope, setScope] = useState<Scope>("all");
	const [pickedId, setPickedId] = useState<string | null>("tr-release");
	const [limitMb, setLimitMb] = useState(8);
	const [limitOpen, setLimitOpen] = useState(false);
	const [applyAll, setApplyAll] = useState(true);
	const [rule, setRule] = useState<"overwrite" | "skip" | "rename" | null>(null);

	const summary = transferSummary(items);
	const visible = scope === "empty" ? [] : scope === "all" ? items : items.filter((t) => t.state === scope);
	const picked = visible.find((t) => t.id === pickedId) ?? visible[0] ?? null;
	const limitLabel = limitMb === 0 ? "不限速" : formatSpeed(limitMb * 1024 * 1024);
	const doneCount = items.filter((t) => t.state === "done").length;

	const cancel = (item: Transfer) => {
		remove(item.id);
		toast({ title: `已取消 ${item.name}`, description: "任务已从传输队列移除", tone: "default" });
	};

	const pauseAll = () => {
		items.forEach((t) => {
			if (t.state === "running") setState(t.id, "paused");
		});
		toast({ title: "已暂停全部传输", tone: "warning" });
	};

	const chooseRule = (item: Transfer, next: "overwrite" | "skip" | "rename") => {
		setRule(next);
		if (next === "skip") {
			remove(item.id);
			toast({ title: `已跳过 ${item.name}`, description: "远端已存在的文件保持不变", tone: "warning" });
			return;
		}
		retry(item.id);
		toast({
			title: next === "overwrite" ? `已覆盖远端 ${item.name}` : `已重命名为 ${item.name}.local`,
			description: applyAll ? "后续同名文件均按此规则处理" : "仅对本次冲突生效",
			tone: "success",
		});
	};

	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1 bg-surface">
				{/* 左侧任务列表 (280px) */}
				<aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-surface-sunk">
					<div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
						<div className="flex items-center gap-1.5">
							<span className="icon-[lucide--arrow-down-up] size-3.5 text-primary" />
							<h1 className="text-[12px] font-semibold text-surface-foreground">传输队列</h1>
						</div>
						<div className="flex items-center gap-2 font-mono text-[11px] tabular-nums text-muted">
							<span>{visible.length} 个任务</span>
							<button
								type="button"
								onClick={pauseAll}
								title="暂停全部"
								aria-label="暂停全部"
								className="flex size-5 items-center justify-center rounded transition-colors hover:bg-surface-raised hover:text-surface-foreground"
							>
								<span className="icon-[lucide--pause] size-3" />
							</button>
						</div>
					</div>

					{/* 队列项 */}
					{visible.length === 0 ? (
						<EmptyState
							icon="icon-[lucide--inbox]"
							title="队列为空"
							description={scope === "empty" ? "当前没有等待中的传输任务。" : "这个状态下暂时没有任务。"}
							action={
								<Link
									to="/sftp"
									className="flex h-6 items-center gap-1 rounded-control bg-primary px-2 text-[11.5px] font-medium text-primary-foreground"
								>
									<span className="icon-[lucide--folder-tree] size-3" />
									去 SFTP 传文件
								</Link>
							}
						/>
					) : (
						<div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
							{visible.map((item) => {
								const on = picked?.id === item.id;
								const percent = percentOf(item);
								return (
									<div
										key={item.id}
										role="button"
										tabIndex={0}
										onClick={() => setPickedId(item.id)}
										onKeyDown={(e) => e.key === "Enter" && setPickedId(item.id)}
										className={cn(
											"cursor-pointer rounded-control border p-2.5 transition-colors",
											on ? cn(CARD_BORDER[item.state], "bg-surface-raised shadow-sm") : "border-border bg-surface hover:border-muted/40",
										)}
									>
										<div className="flex items-center justify-between gap-2 text-[12px]">
											<span className="max-w-[170px] truncate font-mono font-medium text-surface-foreground">
												{item.name}
											</span>
											<span className={cn("shrink-0 font-mono text-[10px] tabular-nums", STATE_TONE[item.state])}>
												{STATE_LABEL[item.state]}
											</span>
										</div>

										<div className="mt-1 truncate font-mono text-[10.5px] text-faint">{targetOf(item)}</div>

										<div className="mt-2 h-1 overflow-hidden rounded-full border border-border bg-surface-sunk">
											<div className={cn("h-full", BAR_CLASS[item.state])} style={{ width: `${percent}%` }} />
										</div>

										<div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[10px] tabular-nums text-faint">
											<span className="truncate">{metaOf(item)}</span>
											<span className="shrink-0">{percent}%</span>
										</div>

										<div className="mt-1.5 flex items-center gap-0.5 border-t border-border/60 pt-1.5">
											{item.state === "running" && (
												<IconButton
													icon="icon-[lucide--pause]"
													label="暂停"
													className="size-5"
													onClick={(e) => {
														e.stopPropagation();
														setState(item.id, "paused");
													}}
												/>
											)}
											{item.state === "paused" && (
												<IconButton
													icon="icon-[lucide--play]"
													label="继续"
													className="size-5"
													onClick={(e) => {
														e.stopPropagation();
														setState(item.id, "running");
													}}
												/>
											)}
											{item.state === "failed" && (
												<IconButton
													icon="icon-[lucide--rotate-cw]"
													label="重试"
													className="size-5"
													onClick={(e) => {
														e.stopPropagation();
														retry(item.id);
														toast({ title: `正在重试 ${item.name}`, tone: "default" });
													}}
												/>
											)}
											{item.state === "done" && (
												<IconButton
													icon="icon-[lucide--folder-open]"
													label="打开所在目录"
													className="size-5"
													onClick={(e) => {
														e.stopPropagation();
														toast({ title: "已打开目录", description: item.localPath });
													}}
												/>
											)}
											<IconButton
												icon="icon-[lucide--x]"
												label={item.state === "done" ? "从列表移除" : "取消任务"}
												className="size-5"
												onClick={(e) => {
													e.stopPropagation();
													cancel(item);
												}}
											/>
											<span className="ml-auto flex items-center gap-1 font-mono text-[9.5px] text-faint">
												<span className="icon-[lucide--server] size-2.5" />
												{item.hostId}
											</span>
										</div>
									</div>
								);
							})}
						</div>
					)}

					{/* 底部限速调节器 */}
					{limitOpen && (
						<div className="border-t border-border bg-surface px-3 py-2.5">
							<div className="flex items-center justify-between text-[11px]">
								<span className="text-muted">全局带宽限速</span>
								<span className="font-mono tabular-nums text-surface-foreground">{limitLabel}</span>
							</div>
							<input
								type="range"
								min={0}
								max={20}
								step={1}
								value={limitMb}
								aria-label="全局带宽限速"
								onChange={(e) => setLimitMb(Number(e.target.value))}
								className="mt-2 h-1 w-full cursor-pointer accent-primary"
							/>
							<div className="mt-2 flex items-center gap-1">
								{[0, 1, 2, 4, 8, 16].map((value) => (
									<Button
										key={value}
										size="sm"
										variant={limitMb === value ? "primary" : "default"}
										className="flex-1 justify-center font-mono tabular-nums"
										onClick={() => setLimitMb(value)}
									>
										{value === 0 ? "不限" : `${value}M`}
									</Button>
								))}
							</div>
							<div className="mt-2 flex items-center gap-1.5 font-mono text-[10.5px] text-faint">
								<span className="icon-[lucide--info] size-3" />
								上传与下载分别限速，0 表示不限速
							</div>
						</div>
					)}

					<button
						type="button"
						onClick={() => setLimitOpen((open) => !open)}
						className="flex h-9 shrink-0 items-center justify-between border-t border-border bg-surface-raised px-3 text-[11px] text-muted transition-colors hover:text-surface-foreground"
					>
						<span className="flex items-center gap-1">
							<span className="icon-[lucide--gauge] size-3 text-primary" />
							<span>全局带宽限速</span>
							<span className={cn("icon-[lucide--chevron-up] size-3 transition-transform", limitOpen && "rotate-180")} />
						</span>
						<span className="font-mono tabular-nums text-surface-foreground">{limitLabel}</span>
					</button>
				</aside>

				{/* 右侧详情 */}
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface-sunk px-3 text-[11.5px]">
						<div className="flex min-w-0 items-center gap-2 text-muted">
							<span className="icon-[lucide--layers] size-3.5 shrink-0 text-primary" />
							<span className="shrink-0 text-surface-foreground">传输详情</span>
							<span className="text-border">/</span>
							<span className="truncate font-mono">{picked ? picked.name : "—"}</span>
							<span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">
								总进度 {summary.percent}% · 进行中 {summary.count}
							</span>
						</div>
						<div className="flex shrink-0 items-center gap-2">
							{doneCount > 0 && (
								<Button
									size="sm"
									variant="ghost"
									icon="icon-[lucide--eraser]"
									onClick={() => {
										clearDone();
										toast({ title: `已清空 ${doneCount} 个已完成任务`, tone: "default" });
									}}
								>
									清空已完成
								</Button>
							)}
							<span className="font-mono text-[10.5px] text-faint">状态</span>
							<Segmented value={scope} onChange={setScope} options={SCOPE_OPTIONS} />
						</div>
					</div>

					<div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto p-6">
						{picked ? (
							<DetailCard
								item={picked}
								applyAll={applyAll}
								rule={rule}
								onApplyAll={setApplyAll}
								onRule={chooseRule}
								onPause={() => setState(picked.id, "paused")}
								onResume={() => setState(picked.id, "running")}
								onRetry={() => {
									retry(picked.id);
									toast({ title: `正在重试 ${picked.name}`, tone: "default" });
								}}
								onCancel={() => cancel(picked)}
							/>
						) : (
							<EmptyState
								icon="icon-[lucide--arrow-down-up]"
								title="暂无传输任务"
								description="从 SFTP 面板拖拽文件到远程目录，或在文件管理器里拖入窗口，任务会立刻出现在这里。"
								action={
									<Link
										to="/sftp"
										className="flex h-7 items-center gap-1.5 rounded-control bg-primary px-2.5 text-[11.5px] font-medium text-primary-foreground"
									>
										<span className="icon-[lucide--folder-tree] size-3" />
										打开 SFTP
									</Link>
								}
							/>
						)}
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}

/* ------------------------------- 详情卡片 ------------------------------- */

function DetailCard({
	item,
	applyAll,
	rule,
	onApplyAll,
	onRule,
	onPause,
	onResume,
	onRetry,
	onCancel,
}: {
	item: Transfer;
	applyAll: boolean;
	rule: "overwrite" | "skip" | "rename" | null;
	onApplyAll: (value: boolean) => void;
	onRule: (item: Transfer, rule: "overwrite" | "skip" | "rename") => void;
	onPause: () => void;
	onResume: () => void;
	onRetry: () => void;
	onCancel: () => void;
}) {
	const percent = percentOf(item);
	const { speed, elapsed } = timingOf(item);

	return (
		<div className="w-[520px] max-w-full rounded-card border border-border bg-surface-raised shadow-lg">
			{/* 卡片头 */}
			<div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
				<span
					className={cn(
						"flex size-6 shrink-0 items-center justify-center rounded",
						item.state === "failed"
							? "bg-danger/15 text-danger"
							: item.state === "done"
								? "bg-success/15 text-success"
								: item.state === "paused"
									? "bg-warning/15 text-warning"
									: "bg-primary/15 text-primary",
					)}
				>
					<span
						className={cn(
							"size-3.5",
							item.direction === "upload" ? "icon-[lucide--upload]" : "icon-[lucide--download]",
						)}
					/>
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h2 className="truncate font-mono text-[13px] font-semibold text-surface-foreground">{item.name}</h2>
						<EnvPill env={item.hostId === "order-stage" ? "stage" : item.hostId === "pg-primary-01" ? "prod" : "prod"} size="xs" />
					</div>
					<p className="truncate font-mono text-[10.5px] text-faint">
						{item.hostId} · {targetOf(item)}
					</p>
				</div>
				<Badge className={cn("shrink-0", STATE_TONE[item.state])}>{STATE_LABEL[item.state]}</Badge>
			</div>

			{/* 状态相关内容 */}
			{item.state === "paused" ? (
				<ConflictBody
					item={item}
					applyAll={applyAll}
					rule={rule}
					onApplyAll={onApplyAll}
					onRule={onRule}
				/>
			) : (
				<div className="px-4 py-3.5">
					<div className="flex items-baseline justify-between">
						<span className="font-mono text-[12px] tabular-nums text-surface-foreground">
							{formatBytes(item.transferred)} / {formatBytes(item.size)}
						</span>
						<span className="font-mono text-[12px] tabular-nums text-muted">{percent}%</span>
					</div>
					<ProgressBar className="mt-2" value={percent} tone={BAR_TONE[item.state]} />

					<div className="mt-3 grid grid-cols-3 gap-2">
						<Stat label="速度" value={item.state === "running" ? formatSpeed(item.speedBps) : formatSpeed(speed)} />
						<Stat
							label={item.state === "done" ? "耗时" : "剩余时间"}
							value={
								item.state === "done"
									? formatDuration(elapsed)
									: formatDuration(item.etaSec ?? (item.size - item.transferred) / speed)
							}
						/>
						<Stat
							label={item.state === "done" ? "平均速度" : "已传输"}
							value={item.state === "done" ? formatSpeed(item.size / elapsed) : formatBytes(item.transferred)}
						/>
					</div>

					{item.state === "running" && (
						<div className="mt-3.5">
							<div className="mb-1 flex items-center justify-between text-[10.5px] text-faint">
								<span>吞吐趋势（近 16 秒）</span>
								<span className="font-mono tabular-nums">{formatSpeed(item.speedBps)}</span>
							</div>
							<div className="flex h-9 items-end gap-0.5">
								{SAMPLES.map((value, index) => (
									<span
										key={index}
										style={{ height: `${Math.round((value / 3) * 100)}%` }}
										className={cn("flex-1 rounded-sm", index === SAMPLES.length - 1 ? "bg-primary" : "bg-primary/50")}
									/>
								))}
							</div>
						</div>
					)}

					{item.state === "failed" && (
						<div className="mt-3.5 rounded-control border border-danger/40 bg-danger/10 px-3 py-2">
							<div className="flex items-center gap-1.5 text-[11.5px] font-medium text-danger">
								<span className="icon-[lucide--circle-alert] size-3.5" />
								<span>{item.error ?? "传输失败"}</span>
							</div>
							<div className="mt-1 font-mono text-[10.5px] text-muted">
								已传输 {formatBytes(item.transferred)} · 断流前速度 {formatSpeed(speed)} · 可重试，续传会从断点继续
							</div>
						</div>
					)}

					{item.state === "done" && (
						<div className="mt-3.5 rounded-control border border-success/40 bg-success/10 px-3 py-2">
							<div className="flex items-center gap-1.5 text-[11.5px] font-medium text-success">
								<span className="icon-[lucide--check-check] size-3.5" />
								<span>传输完成，已校验 SHA-256</span>
							</div>
							<div className="mt-1 font-mono text-[10.5px] text-muted">
								{item.localPath} → {item.remotePath}
							</div>
						</div>
					)}

					<div className="mt-3.5 space-y-1.5 border-t border-border pt-3 font-mono text-[10.5px]">
						<PathRow label="来源" value={item.localPath} />
						<PathRow label="目标" value={item.remotePath} />
						<PathRow label="任务 ID" value={item.id} />
					</div>
				</div>
			)}

			{/* 卡片底部动作 */}
			<div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
				<span className="flex items-center gap-1.5 font-mono text-[10.5px] text-faint">
					<span className="icon-[lucide--gauge] size-3" />
					限速 {limitTextFromContext(item)}
				</span>
				<div className="flex items-center gap-2">
					{item.state === "running" && (
						<Button size="sm" icon="icon-[lucide--pause]" onClick={onPause}>
							暂停
						</Button>
					)}
					{item.state === "paused" && (
						<Button size="sm" icon="icon-[lucide--play]" onClick={onResume}>
							继续
						</Button>
					)}
					{item.state === "failed" && (
						<Button size="sm" variant="primary" icon="icon-[lucide--rotate-cw]" onClick={onRetry}>
							重试
						</Button>
					)}
					{item.state === "done" && (
						<Button size="sm" icon="icon-[lucide--folder-open]" onClick={() => toast({ title: "已打开目录", description: item.localPath })}>
							打开所在目录
						</Button>
					)}
					<Button size="sm" variant="danger" icon="icon-[lucide--x]" onClick={onCancel}>
						{item.state === "done" ? "从列表移除" : "取消"}
					</Button>
				</div>
			</div>
		</div>
	);
}

function limitTextFromContext(item: Transfer): string {
	return item.state === "paused" ? "8.0 MB/s（等待冲突确认）" : "8.0 MB/s";
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-control border border-border bg-surface px-2.5 py-2">
			<div className="text-[10px] tracking-wider text-faint uppercase">{label}</div>
			<div className="mt-0.5 font-mono text-[12px] tabular-nums text-surface-foreground">{value}</div>
		</div>
	);
}

function PathRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center gap-2">
			<span className="w-14 shrink-0 font-sans text-muted">{label}</span>
			<span className="min-w-0 truncate text-surface-foreground">{value}</span>
		</div>
	);
}

/* --------------------------- 同名文件冲突确认 --------------------------- */

function ConflictBody({
	item,
	applyAll,
	rule,
	onApplyAll,
	onRule,
}: {
	item: Transfer;
	applyAll: boolean;
	rule: "overwrite" | "skip" | "rename" | null;
	onApplyAll: (value: boolean) => void;
	onRule: (item: Transfer, rule: "overwrite" | "skip" | "rename") => void;
}) {
	const localSize = item.size;
	const remoteSize = Math.max(1, localSize - 60);

	const rows = [
		{ label: "文件名称", local: item.name, remote: item.name, newer: false },
		{
			label: "文件大小",
			local: `${localSize.toLocaleString("en-US")} 字节 (${formatBytes(localSize)})`,
			remote: `${remoteSize.toLocaleString("en-US")} 字节 (${formatBytes(remoteSize)})`,
			newer: false,
		},
		{ label: "修改时间", local: "今天 09:40 (较新)", remote: "昨天 18:41", newer: true },
	];

	const ruleLabel =
		rule === "overwrite" ? "覆盖远端文件" : rule === "skip" ? "跳过本次传输" : rule === "rename" ? "重命名保留两份" : null;

	return (
		<div className="px-4 py-3.5">
			<div className="flex items-start gap-2.5">
				<span className="flex size-6 shrink-0 items-center justify-center rounded bg-warning/15 text-warning">
					<span className="icon-[lucide--triangle-alert] size-3.5" />
				</span>
				<div className="min-w-0">
					<h3 className="text-[12.5px] font-semibold text-surface-foreground">同名文件覆盖冲突</h3>
					<p className="mt-0.5 text-[11px] text-muted">
						目标路径 <span className="font-mono">{item.remotePath}</span> 已有同名文件，请确认处理方式
					</p>
				</div>
			</div>

			<div className="mt-3 overflow-hidden rounded-control border border-border bg-surface">
				<div className="grid grid-cols-[92px_1fr_1fr] border-b border-border bg-surface-sunk/60 px-3 py-1.5 font-mono text-[10.5px] tracking-wider text-faint uppercase">
					<span>属性</span>
					<span>本地待上传文件</span>
					<span>远程已有文件</span>
				</div>
				<div className="divide-y divide-border/40 font-mono text-[11.5px]">
					{rows.map((row) => (
						<div key={row.label} className="grid grid-cols-[92px_1fr_1fr] items-center px-3 py-1.5">
							<span className="font-sans text-muted">{row.label}</span>
							<span className={cn("truncate tabular-nums", row.newer ? "text-success" : "text-surface-foreground")}>
								{row.local}
							</span>
							<span className="truncate tabular-nums text-faint">{row.remote}</span>
						</div>
					))}
				</div>
			</div>

			<div className="mt-4 flex items-center gap-2">
				<Button
					size="sm"
					variant="primary"
					icon="icon-[lucide--check]"
					className="h-7.5 flex-1 justify-center"
					onClick={() => onRule(item, "overwrite")}
				>
					覆盖远端文件
				</Button>
				<Button size="sm" className="h-7.5 flex-1 justify-center" onClick={() => onRule(item, "skip")}>
					跳过本次传输
				</Button>
				<Button size="sm" className="h-7.5 flex-1 justify-center" onClick={() => onRule(item, "rename")}>
					重命名保留两份
				</Button>
			</div>

			<div className="mt-3.5 flex items-center justify-between gap-3 border-t border-border pt-3">
				<Checkbox checked={applyAll} onChange={onApplyAll} label="对本次传输队列中的后续所有冲突文件均应用此规则" />
				{ruleLabel && (
					<span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-success">
						<span className="icon-[lucide--check] size-3" />
						已选择：{ruleLabel}
					</span>
				)}
			</div>
		</div>
	);
}
