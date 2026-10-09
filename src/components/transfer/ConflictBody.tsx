import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Toggle";
import type { Transfer } from "@/data/types";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { formatUnixTime } from "@/lib/sftp";
import type { ConflictChoice } from "@/lib/transferManager";

/* --------------------------- 同名文件冲突确认 --------------------------- */

export function ConflictBody({
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
	onRule: (item: Transfer, rule: ConflictChoice) => void;
}) {
	const conflict = item.pendingConflict;
	if (!conflict) return null;
	const upload = item.direction === "upload";
	const { source, target, partial } = conflict;
	const targetPath = upload ? item.remotePath : item.localPath;
	const sideText = upload ? "远端" : "本地";
	const bytes = (n: number) => `${n.toLocaleString("en-US")} 字节 (${formatBytes(n)})`;
	const time = (sec: number) => (sec ? formatUnixTime(sec) : "—");
	const sourceNewer = target.exists && source.mtime > target.mtime;
	const targetNewer = target.exists && target.mtime > source.mtime;

	const rows = target.exists
		? [
				{ label: "文件名称", local: item.name, remote: item.name, newer: false, older: false },
				{ label: "文件大小", local: bytes(source.size), remote: bytes(target.size), newer: false, older: false },
				{
					label: "修改时间",
					local: `${time(source.mtime)}${sourceNewer ? " (较新)" : ""}`,
					remote: `${time(target.mtime)}${targetNewer ? " (较新)" : ""}`,
					newer: sourceNewer,
					older: targetNewer,
				},
			]
		: [];

	const ruleLabel =
		rule === "overwrite" ? `覆盖${sideText}文件` : rule === "skip" ? "跳过本次传输" : rule === "rename" ? "重命名保留两份" : null;

	return (
		<div className="px-4 py-3.5">
			<div className="flex items-start gap-2.5">
				<span className="flex size-6 shrink-0 items-center justify-center rounded bg-warning/15 text-warning">
					<span className="icon-[lucide--triangle-alert] size-3.5" />
				</span>
				<div className="min-w-0">
					<h3 className="text-[12.5px] font-semibold text-surface-foreground">
						{target.exists ? "同名文件覆盖冲突" : "发现上次未完成的传输"}
					</h3>
					<p className="mt-0.5 text-[11px] text-muted">
						{target.exists ? (
							<>
								目标路径 <span className="font-mono">{targetPath}</span> 已有同名文件，请确认处理方式
							</>
						) : (
							<>
								<span className="font-mono">{targetPath}</span> 旁边有上次留下的 {formatBytes(partial)} 部分文件
							</>
						)}
					</p>
				</div>
			</div>

			{rows.length > 0 && (
				<div className="mt-3 overflow-hidden rounded-control border border-border bg-surface">
					<div className="grid grid-cols-[92px_1fr_1fr] border-b border-border bg-surface-sunk/60 px-3 py-1.5 font-mono text-[10.5px] tracking-wider text-faint uppercase">
						<span>属性</span>
						<span>{upload ? "本地待上传文件" : "远程待下载文件"}</span>
						<span>{upload ? "远程已有文件" : "本地已有文件"}</span>
					</div>
					<div className="divide-y divide-border/40 font-mono text-[11.5px]">
						{rows.map((row) => (
							<div key={row.label} className="grid grid-cols-[92px_1fr_1fr] items-center px-3 py-1.5">
								<span className="font-sans text-muted">{row.label}</span>
								<span className={cn("truncate tabular-nums", row.newer ? "text-success" : "text-surface-foreground")}>
									{row.local}
								</span>
								<span className={cn("truncate tabular-nums", row.older ? "text-success" : "text-faint")}>{row.remote}</span>
							</div>
						))}
					</div>
				</div>
			)}

			{partial > 0 && (
				<p className="mt-2 text-[11px] text-muted">
					另有上次未完成的 {formatBytes(partial)}（共 {formatBytes(source.size)}），可以从断点继续，完成后会复算 SHA-256。
				</p>
			)}

			<div className="mt-4 flex items-center gap-2">
				{partial > 0 && (
					<Button
						size="sm"
						variant="primary"
						icon="icon-[lucide--step-forward]"
						className="h-7.5 flex-1 justify-center"
						onClick={() => onRule(item, "resume")}
					>
						从断点续传
					</Button>
				)}
				<Button
					size="sm"
					variant={partial > 0 ? "default" : "primary"}
					icon="icon-[lucide--check]"
					className="h-7.5 flex-1 justify-center"
					onClick={() => onRule(item, "overwrite")}
				>
					{target.exists ? `覆盖${sideText}文件` : "重新开始"}
				</Button>
				<Button size="sm" className="h-7.5 flex-1 justify-center" onClick={() => onRule(item, "skip")}>
					跳过本次传输
				</Button>
				{target.exists && (
					<Button size="sm" className="h-7.5 flex-1 justify-center" onClick={() => onRule(item, "rename")}>
						重命名保留两份
					</Button>
				)}
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
