/**
 * ZMODEM 进度条与覆盖确认 —— 移植自 Netcatty components/terminal/ZmodemProgressIndicator.tsx
 * 与 ZmodemOverwriteDialog.tsx（文案取 Netcatty zh-CN：上传中 / 下载中 / 等待远端... / 取消传输 (Ctrl+C) /
 * 远端已存在同名文件 / 应用到其余冲突文件 / 覆盖 / 跳过 / 取消）。
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Overlay";
import { cancelZmodem, respondZmodemOverwrite, useZmodemStore } from "@/lib/zmodem/sessionZmodem";

function formatBytes(bytes: number): string {
	if (bytes <= 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
	return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatSpeed(bytesPerSecond: number | null): string | null {
	if (!bytesPerSecond || bytesPerSecond <= 0) return null;
	return `${formatBytes(bytesPerSecond)}/s`;
}

export function ZmodemOverlay({ sessionKey }: { sessionKey: string | null | undefined }) {
	const transfer = useZmodemStore((s) => (sessionKey ? s.transfers[sessionKey] : undefined));
	const overwrite = useZmodemStore((s) => (sessionKey ? s.overwrite[sessionKey] : undefined));
	if (!sessionKey) return null;
	return (
		<>
			{transfer?.active && (
				<div className="pointer-events-auto absolute bottom-4 right-4 z-[25]">
					<ZmodemProgressIndicator
						transferType={transfer.transferType}
						filename={transfer.filename}
						transferred={transfer.transferred}
						total={transfer.total}
						fileIndex={transfer.fileIndex}
						fileCount={transfer.fileCount}
						finalizing={transfer.finalizing}
						bytesPerSecond={transfer.bytesPerSecond}
						onCancel={() => cancelZmodem(sessionKey)}
					/>
				</div>
			)}
			{overwrite && (
				<ZmodemOverwriteDialog
					filename={overwrite.filename}
					onRespond={(action, applyToRest) => respondZmodemOverwrite(sessionKey, action, applyToRest)}
				/>
			)}
		</>
	);
}

function ZmodemProgressIndicator({
	transferType,
	filename,
	transferred,
	total,
	fileIndex,
	fileCount,
	finalizing,
	bytesPerSecond,
	onCancel,
}: {
	transferType: "upload" | "download" | null;
	filename: string | null;
	transferred: number;
	total: number;
	fileIndex: number;
	fileCount: number;
	finalizing: boolean;
	bytesPerSecond: number | null;
	onCancel: () => void;
}) {
	const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
	const icon = transferType === "upload" ? "icon-[lucide--arrow-up-from-line]" : "icon-[lucide--arrow-down-to-line]";
	const label = finalizing ? "等待远端..." : transferType === "upload" ? "上传中" : "下载中";
	const fileInfo = fileCount > 0 ? ` (${fileIndex + 1}/${fileCount})` : "";
	const speed = formatSpeed(bytesPerSecond);
	return (
		<div
			className="flex min-w-[240px] max-w-[360px] items-center gap-2.5 rounded-lg border border-border bg-surface/90 px-3 py-2 text-surface-foreground shadow-lg backdrop-blur-sm"
			onClick={(e) => e.stopPropagation()}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<span className={`${icon} size-4 shrink-0 opacity-60`} />
			<div className="min-w-0 flex-1">
				<div className="mb-1 flex items-center justify-between gap-2">
					<span className="truncate text-xs font-medium">
						{filename || label}
						{fileInfo}
					</span>
					<span className="shrink-0 text-[10px] opacity-60">{percent}%</span>
				</div>
				<div className="h-1 w-full overflow-hidden rounded-full bg-surface-raised">
					<div
						className={`h-full rounded-full transition-all duration-150 ${transferType === "upload" ? "bg-primary" : "bg-success"}`}
						style={{ width: `${percent}%` }}
					/>
				</div>
				<div className="mt-0.5 text-[10px] opacity-50">
					{finalizing ? label : `${formatBytes(transferred)} / ${formatBytes(total)}${speed ? ` · ${speed}` : ""}`}
				</div>
			</div>
			<button
				type="button"
				onClick={onCancel}
				title="取消传输 (Ctrl+C)"
				aria-label="取消传输 (Ctrl+C)"
				className="shrink-0 cursor-pointer rounded p-1 transition-colors hover:bg-surface-raised"
			>
				<span className="icon-[lucide--x] size-3.5 opacity-60" />
			</button>
		</div>
	);
}

function ZmodemOverwriteDialog({
	filename,
	onRespond,
}: {
	filename: string;
	onRespond: (action: "overwrite" | "skip" | "cancel", applyToRest: boolean) => void;
}) {
	const [applyToRest, setApplyToRest] = useState(false);
	return (
		<Modal
			open
			onClose={() => onRespond("cancel", false)}
			title="远端已存在同名文件"
			footer={
				<div className="flex items-center gap-2">
					<Button size="sm" variant="ghost" onClick={() => onRespond("cancel", applyToRest)}>
						取消
					</Button>
					<Button size="sm" variant="ghost" onClick={() => onRespond("skip", applyToRest)}>
						跳过
					</Button>
					<Button size="sm" variant="primary" onClick={() => onRespond("overwrite", applyToRest)}>
						覆盖
					</Button>
				</div>
			}
		>
			<p className="break-all text-sm text-muted">{filename}</p>
			<label className="mt-2 flex items-center gap-2 text-sm">
				<input type="checkbox" checked={applyToRest} onChange={(e) => setApplyToRest(e.target.checked)} />
				应用到其余冲突文件
			</label>
		</Modal>
	);
}
