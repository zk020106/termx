import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button, IconButton } from "@/components/ui/Button";
import { Badge, EmptyState, ProgressBar, Segmented } from "@/components/ui/Display";
import { ConflictBody } from "@/components/transfer/ConflictBody";
import type { Transfer, TransferState } from "@/data/types";
import { cn } from "@/lib/cn";
import { formatBytes, formatDuration, formatSpeed } from "@/lib/format";
import {
	cancelTransfer,
	pauseAllTransfers,
	pauseTransfer,
	resolveConflict,
	resumeTransfer,
	revealLocal,
	setTransferLimit,
	type ConflictChoice,
} from "@/lib/transferManager";
import { useHostsStore } from "@/store/hosts";
import { toast } from "@/store/toast";
import { transferSummary, useTransfersStore } from "@/store/transfers";
import { useState } from "react";
import { Link } from "react-router";

/* =============================================================================
 * 传输队列 —— 设计帧 termx.vetd/frames/transfers.tsx 的交互版。
 * 状态：进行中 / 已暂停 / 失败 / 已完成 / 空（需求书 06-传输队列），数据来自 useTransfersStore，
 * 运行与控制在 lib/transferManager.ts（真实的暂停 / 续传 / 取消 / 冲突处理 / SHA-256 复算 / 限速）。
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

/** 耗时（秒）：只算真正在传的时间，不含排队与暂停 */
function elapsedOf(item: Transfer): number {
	const running = item.state === "running" && item.runStartedAt ? Date.now() - item.runStartedAt : 0;
	return ((item.activeMs ?? 0) + running) / 1000;
}

/** 平均速度：传输字节 / 实际耗时；没有数据时为 0 */
function averageSpeed(item: Transfer): number {
	const elapsed = elapsedOf(item);
	return elapsed > 0 ? item.transferred / elapsed : 0;
}

function speedText(bps: number): string {
	return bps > 0 ? formatSpeed(bps) : "—";
}

function remainText(item: Transfer, bps: number): string {
	if (bps <= 0) return "—";
	return formatDuration(item.etaSec ?? (item.size - item.transferred) / bps);
}

function percentOf(item: Transfer): number {
	if (item.size <= 0) return 0;
	return Math.min(100, Math.round((item.transferred / item.size) * 100));
}

/** 每条任务的「进度 · 速度 · 剩余时间」摘要 */
function metaOf(item: Transfer): string {
	const progress = `${formatBytes(item.transferred)} / ${formatBytes(item.size)}`;
	const avg = averageSpeed(item);

	switch (item.state) {
		case "running":
			if (item.verifying) return `${progress} · 正在远端复算 SHA-256`;
			return `${progress} · ${speedText(item.speedBps)} · 剩余 ${remainText(item, item.speedBps)}`;
		case "paused":
			return `${progress} · ${speedText(avg)}（暂停前平均） · 可从断点继续`;
		case "failed":
			return `${progress} · ${speedText(avg)}（断流前平均）`;
		case "done":
			return `${formatBytes(item.size)} · 平均 ${speedText(avg)} · 耗时 ${formatDuration(elapsedOf(item))}`;
		default:
			if (item.pendingConflict) return `${formatBytes(item.size)} · 等待确认同名冲突`;
			return `${formatBytes(item.size)} 待传输 · 等待前面的任务完成`;
	}
}

function targetOf(item: Transfer): string {
	return item.direction === "upload" ? `↑ 上传至 ${item.remotePath}` : `↓ 下载至 ${item.localPath}`;
}

export default function Transfers() {
	const items = useTransfersStore((s) => s.items);
	const clearDone = useTransfersStore((s) => s.clearDone);
	const limitMb = useTransfersStore((s) => s.limitMb);
	const hosts = useHostsStore((s) => s.hosts);
	const hostName = (id: string) => hosts.find((h) => h.id === id)?.name ?? id;

	const [scope, setScope] = useState<Scope>("all");
	const [pickedId, setPickedId] = useState<string | null>(null);
	const [limitOpen, setLimitOpen] = useState(false);
	const [applyAll, setApplyAll] = useState(true);
	const [rule, setRule] = useState<"overwrite" | "skip" | "rename" | null>(null);

	const setLimitMb = (mb: number) => {
		setTransferLimit(mb).catch((error) =>
			toast({ title: "限速设置失败", description: String(error), tone: "danger" }),
		);
	};

	const summary = transferSummary(items);
	const visible = scope === "empty" ? [] : scope === "all" ? items : items.filter((t) => t.state === scope);
	const picked = visible.find((t) => t.id === pickedId) ?? visible[0] ?? null;
	const limitLabel = limitMb === 0 ? "不限速" : formatSpeed(limitMb * 1024 * 1024);
	const doneCount = items.filter((t) => t.state === "done").length;

	const cancel = (item: Transfer) => {
		const wasDone = item.state === "done";
		void cancelTransfer(item.id).then(() => {
			if (wasDone) toast({ title: `已移除 ${item.name}`, tone: "default" });
			else toast({ title: `已取消 ${item.name}`, description: "任务已从传输队列移除，未完成的部分文件已清理", tone: "default" });
		});
	};

	const pauseAll = () => {
		void pauseAllTransfers().then((count) =>
			toast({ title: count > 0 ? `已暂停 ${count} 个传输` : "没有进行中的传输", tone: count > 0 ? "warning" : "default" }),
		);
	};

	const pause = (item: Transfer) => void pauseTransfer(item.id);

	const resume = (item: Transfer, verb: "继续" | "重试") => {
		toast({ title: verb === "重试" ? `正在重试 ${item.name}` : `继续传输 ${item.name}`, description: "从断点续传", tone: "default" });
		void resumeTransfer(item.id, {
			onItemDone: (done) => toast({ title: `${done.direction === "upload" ? "已上传" : "已下载"} ${done.name}`, tone: "success" }),
			onItemFailed: (failed, error) => toast({ title: `传输失败: ${failed.name}`, description: error, tone: "danger" }),
		});
	};

	const reveal = (item: Transfer) => {
		revealLocal(item.localPath).catch((error) =>
			toast({ title: "无法打开所在目录", description: String(error), tone: "danger" }),
		);
	};

	const chooseRule = (item: Transfer, next: ConflictChoice) => {
		if (next !== "resume") setRule(next);
		resolveConflict(item.id, next, applyAll);
		const sideText = item.direction === "upload" ? "远端" : "本地";
		toast({
			title:
				next === "skip"
					? `已跳过 ${item.name}`
					: next === "overwrite"
						? `将覆盖${sideText} ${item.name}`
						: next === "resume"
							? `将从断点续传 ${item.name}`
							: `将重命名保留两份`,
			description:
				next === "skip" ? `${sideText}已存在的文件保持不变` : applyAll ? "本批后续同名文件均按此规则处理" : "仅对本次冲突生效",
			tone: next === "skip" ? "warning" : "success",
		});
	};

	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1 bg-surface">
				{/* 左侧任务列表 (280px) */}
				<aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-surface-sunk">
					<div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
						<div className="flex shrink-0 items-center gap-1.5 min-w-0">
							<span className="icon-[lucide--arrow-down-up] size-3.5 shrink-0 text-primary" />
							<h1 className="whitespace-nowrap text-[12px] font-semibold text-surface-foreground">传输队列</h1>
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
														pause(item);
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
														resume(item, "继续");
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
														resume(item, "重试");
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
														reveal(item);
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
												{hostName(item.hostId)}
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
								hostName={hostName(picked.hostId)}
								limitMb={limitMb}
								applyAll={applyAll}
								rule={rule}
								onApplyAll={setApplyAll}
								onRule={chooseRule}
								onPause={() => pause(picked)}
								onResume={() => resume(picked, "继续")}
								onRetry={() => resume(picked, "重试")}
								onReveal={() => reveal(picked)}
								onCancel={() => cancel(picked)}
							/>
						) : (
							<EmptyState
								icon="icon-[lucide--arrow-down-up]"
								title="暂无传输任务"
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
	hostName,
	limitMb,
	applyAll,
	rule,
	onApplyAll,
	onRule,
	onPause,
	onResume,
	onRetry,
	onReveal,
	onCancel,
}: {
	item: Transfer;
	hostName: string;
	limitMb: number;
	applyAll: boolean;
	rule: "overwrite" | "skip" | "rename" | null;
	onApplyAll: (value: boolean) => void;
	onRule: (item: Transfer, rule: ConflictChoice) => void;
	onPause: () => void;
	onResume: () => void;
	onRetry: () => void;
	onReveal: () => void;
	onCancel: () => void;
}) {
	const percent = percentOf(item);
	const avg = averageSpeed(item);
	const elapsed = elapsedOf(item);
	const samples = item.samples ?? [];
	const peak = Math.max(1, ...samples);

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
					</div>
					<p className="truncate font-mono text-[10.5px] text-faint">
						{hostName} · {targetOf(item)}
					</p>
				</div>
				<Badge className={cn("shrink-0", STATE_TONE[item.state])}>{STATE_LABEL[item.state]}</Badge>
			</div>

			{/* 状态相关内容 */}
			{item.pendingConflict ? (
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
						<Stat label="速度" value={item.state === "running" ? speedText(item.speedBps) : speedText(avg)} />
						<Stat
							label={item.state === "done" ? "耗时" : "剩余时间"}
							value={
								item.state === "done"
									? formatDuration(elapsed)
									: item.state === "running"
										? remainText(item, item.speedBps)
										: "—"
							}
						/>
						<Stat
							label={item.state === "done" ? "平均速度" : "已传输"}
							value={item.state === "done" ? speedText(avg) : formatBytes(item.transferred)}
						/>
					</div>

					{item.state === "running" && (
						<div className="mt-3.5">
							<div className="mb-1 flex items-center justify-between text-[10.5px] text-faint">
								<span>{item.verifying ? "数据已传完，正在远端复算 SHA-256…" : "吞吐趋势（近 16 秒）"}</span>
								<span className="font-mono tabular-nums">{speedText(item.speedBps)}</span>
							</div>
							<div className="flex h-9 items-end gap-0.5">
								{samples.length === 0 ? (
									<span className="self-center text-[10.5px] text-faint">采样中…</span>
								) : (
									samples.map((value, index) => (
										<span
											key={index}
											style={{ height: `${Math.max(4, Math.round((value / peak) * 100))}%` }}
											className={cn("flex-1 rounded-sm", index === samples.length - 1 ? "bg-primary" : "bg-primary/50")}
										/>
									))
								)}
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
								已传输 {formatBytes(item.transferred)} · 断流前平均 {speedText(avg)} · 可重试，续传会从断点继续
							</div>
						</div>
					)}

					{item.state === "done" && (
						<div
							className={cn(
								"mt-3.5 rounded-control border px-3 py-2",
								item.verified === false ? "border-danger/40 bg-danger/10" : "border-success/40 bg-success/10",
							)}
						>
							<div
								className={cn(
									"flex items-center gap-1.5 text-[11.5px] font-medium",
									item.verified === false ? "text-danger" : "text-success",
								)}
							>
								<span className={cn("size-3.5", item.verified === false ? "icon-[lucide--circle-alert]" : "icon-[lucide--check-check]")} />
								<span>
									{item.verified === true
										? "传输完成，已校验 SHA-256"
										: item.verified === false
											? "传输完成，但 SHA-256 校验不一致"
											: "传输完成（SHA-256 未比对）"}
								</span>
							</div>
							<div className="mt-1 font-mono text-[10.5px] text-muted">
								{item.direction === "upload" ? `${item.localPath} → ${item.remotePath}` : `${item.remotePath} → ${item.localPath}`}
							</div>
							{item.verifyNote && <div className="mt-1 text-[10.5px] text-muted">{item.verifyNote}</div>}
							{item.sha256 && <div className="mt-0.5 break-all font-mono text-[10px] text-faint">SHA-256 {item.sha256}</div>}
						</div>
					)}

					<div className="mt-3.5 space-y-1.5 border-t border-border pt-3 font-mono text-[10.5px]">
						<PathRow label="来源" value={item.direction === "upload" ? item.localPath : item.remotePath} />
						<PathRow label="目标" value={item.direction === "upload" ? item.remotePath : item.localPath} />
						<PathRow label="任务 ID" value={item.id} />
					</div>
				</div>
			)}

			{/* 卡片底部动作 */}
			<div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
				<span className="flex items-center gap-1.5 font-mono text-[10.5px] text-faint">
					<span className="icon-[lucide--gauge] size-3" />
					限速 {limitMb === 0 ? "不限速" : formatSpeed(limitMb * 1024 * 1024)}
					{item.pendingConflict ? "（等待冲突确认）" : ""}
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
						<Button size="sm" icon="icon-[lucide--folder-open]" onClick={onReveal}>
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

