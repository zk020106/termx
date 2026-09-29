import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState } from "@/components/ui/Display";
import { toast } from "@/store/toast";
import { useNavigate } from "react-router";

/* =============================================================================
 * 内置编辑器 —— 设计帧 termx.vetd/frames/editor.tsx 的骨架版本。
 * 标签、文件内容、语法高亮、保存冲突 Diff 与手动合并都依赖真实文件读取（SFTP / 本地 fs），
 * 这两条通道都还没接入，所以这里只保留标签栏与路径栏结构，正文是一个空状态。
 * ========================================================================== */

export default function Editor() {
	const navigate = useNavigate();

	return (
		<WindowChrome>
			<div className="relative flex min-h-0 flex-1 flex-col bg-term">
				{/* 编辑器标签栏（Linear 极简风）：当前没有任何标签 */}
				<div className="flex h-8.5 shrink-0 items-end justify-between border-b border-border bg-surface-sunk px-2">
					<div className="flex min-w-0 items-center gap-1 pb-1">
						<span className="px-1 font-mono text-[11px] text-faint">没有打开的文件</span>
						<button
							type="button"
							onClick={() =>
								toast({
									title: "编辑器尚未接入",
									description: "内置编辑器内核与文件读取还没有实现，暂时打不开新文件。",
									tone: "default",
								})
							}
							title="打开文件"
							aria-label="打开文件"
							className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface hover:text-surface-foreground"
						>
							<span className="icon-[lucide--plus] size-3" />
						</button>
					</div>

					{/* 快捷操作区：没有文件时只保留状态标识 */}
					<div className="flex shrink-0 items-center gap-3 pb-1 text-[11px] text-muted">
						<span className="font-mono text-[10.5px] text-faint">状态</span>
						<Badge>未接入</Badge>
					</div>
				</div>

				{/* 路径栏结构保留，但没有活动文件可显示 */}
				<div className="flex h-6.5 shrink-0 items-center justify-between border-b border-border/40 bg-surface/80 px-3 font-mono text-[11px] text-muted">
					<div className="flex min-w-0 items-center gap-1.5">
						<span className="icon-[lucide--file-code] size-3 shrink-0 text-primary" />
						<span className="truncate">未选择文件</span>
					</div>
					<div className="flex shrink-0 items-center gap-2 tabular-nums text-faint">
						<span>0 个标签</span>
						<span>·</span>
						<span>0 行</span>
					</div>
				</div>

				{/* 正文：文件读取通道未接入 */}
				<div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
					<EmptyState
						icon="icon-[lucide--file-code]"
						title="还没有打开的文件"
						action={
							<div className="flex items-center gap-2">
								<Button size="sm" icon="icon-[lucide--folder-open]" onClick={() => navigate("/sftp")}>
									去 SFTP 打开文件
								</Button>
								<Button
									size="sm"
									variant="primary"
									icon="icon-[lucide--file-plus]"
									onClick={() =>
										toast({
											title: "本地文件读取尚未接入",
											tone: "default",
										})
									}
								>
									打开本地文件
								</Button>
							</div>
						}
					/>
				</div>
			</div>
		</WindowChrome>
	);
}
