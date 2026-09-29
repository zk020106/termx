import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState, StatusText } from "@/components/ui/Display";
import { cn } from "@/lib/cn";
import { useSessionsStore } from "@/store/sessions";
import { toast } from "@/store/toast";
import { transferSummary, useTransfersStore } from "@/store/transfers";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";

/* =============================================================================
 * SFTP —— 设计帧 termx.vetd/frames/sftp.tsx 的骨架版本。
 * 本地目录浏览、SFTP 子系统（目录列表 / 权限编辑 / 拖拽上传 / 同名冲突）都还没有数据源，
 * 所以这里只保留顶栏控制栏与双栏结构，两侧列表区一律是空状态：
 * 没有会话时说明「远程列表挂在会话上」并引导去主机库。
 * ========================================================================== */

export default function Sftp() {
	const navigate = useNavigate();
	/** 传输队列是真实 store（首次启动为空） */
	const queue = useTransfersStore((s) => s.items);
	const { count: queueCount } = transferSummary(queue);
	/** 真实的第一个会话标签；SFTP 面板挂在会话上，没有会话时远程栏没有目标 */
	const session = useSessionsStore((s) => s.tabs[0] ?? null);

	return (
		<WindowChrome>
			<div className="relative flex min-h-0 flex-1 flex-col bg-surface">
				{/* 顶栏控制栏 */}
				<div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface-sunk px-3 text-[12px]">
					<div className="flex min-w-0 items-center gap-2">
						<span className="shrink-0 font-medium text-surface-foreground">SFTP 远程文件传输</span>
						<span className="text-border">/</span>
						<StatusText status="idle" label="未选择会话" className="text-[11px]" />
						<span className="truncate font-mono text-[11px] text-faint">
							{session ? session.title : "先在主机库连接一台主机"}
						</span>
					</div>

					<div className="flex shrink-0 items-center gap-2">
						<Link
							to="/editor"
							className="flex h-6.5 items-center gap-1.5 rounded-control border border-border bg-surface px-2 text-[11px] font-medium text-muted transition-colors hover:bg-surface-raised hover:text-surface-foreground"
						>
							<span className="icon-[lucide--file-pen-line] size-3 text-primary" />
							<span>内置编辑器</span>
						</Link>
						<Link
							to="/transfers"
							className="flex h-6.5 items-center gap-1.5 rounded-control bg-primary px-2.5 text-[11px] font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
						>
							<span className="icon-[lucide--arrow-down-up] size-3" />
							<span className="tabular-nums">传输队列 ({queueCount})</span>
						</Link>
					</div>
				</div>

				{/* 双栏骨架（本地 ↔ 远程）：两侧数据源都还没接入 */}
				<div className="grid min-h-0 flex-1 grid-cols-2">
					<FileColumnShell
						title="本地文件系统"
						icon="icon-[lucide--laptop]"
						side="local"
						empty={{
							icon: "icon-[lucide--folder-off]",
							title: "本地目录浏览尚未接入",
							action: (
								<Button
									size="sm"
									icon="icon-[lucide--folder-open]"
									onClick={() =>
										toast({
											title: "本地目录浏览尚未接入",
											tone: "default",
										})
									}
								>
									打开本地目录
								</Button>
							),
						}}
					/>
					<FileColumnShell
						title={session ? `远程主机 (${session.title})` : "远程主机"}
						icon="icon-[lucide--server]"
						side="remote"
						empty={
							session
								? {
										icon: "icon-[lucide--folder-off]",
										title: "远程文件列表尚未接入",
									}
								: {
										icon: "icon-[lucide--plug-zap]",
										title: "SFTP 需要先选中一个已连接的会话",
										action: (
											<Button
												size="sm"
												variant="primary"
												icon="icon-[lucide--server]"
												onClick={() => navigate("/hosts")}
											>
												去主机库连接一台
											</Button>
										),
									}
						}
					/>
				</div>
			</div>
		</WindowChrome>
	);
}

/* ------------------------------- 文件栏 ------------------------------- */

/** 单侧文件栏骨架：栏头 + 路径/表头结构 + 列表区空状态 */
function FileColumnShell({
	title,
	icon,
	side,
	empty,
}: {
	title: string;
	icon: string;
	side: "local" | "remote";
	empty: { icon: string; title: string; description?: string; action?: ReactNode };
}) {
	const sideLabel = side === "remote" ? "远程" : "本地";

	return (
		<div
			className={cn(
				"relative flex min-h-0 flex-col",
				side === "remote" ? "border-l border-border bg-surface-raised/40" : "bg-surface",
			)}
		>
			{/* 栏头部 */}
			<div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-sunk px-3 text-[11.5px]">
				<div className="flex min-w-0 items-center gap-1.5 text-muted">
					<span className={cn(icon, "size-3.5 shrink-0 text-primary")} />
					<span className="truncate font-medium text-surface-foreground">{title}</span>
				</div>
				<div className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-faint">
					<span className="tabular-nums">0 项</span>
					<IconButton
						icon="icon-[lucide--refresh-cw]"
						label="刷新目录"
						className="size-5"
						onClick={() =>
							toast({
								title: `${sideLabel}目录列表尚未接入`,
								tone: "default",
							})
						}
					/>
				</div>
			</div>

			{/* 表头：结构保留，等接入后填真实文件名 / 大小 / 时间 / 权限 */}
			<div className="grid shrink-0 grid-cols-[1fr_80px_110px_70px] border-b border-border/60 bg-surface-sunk/40 px-3 py-1 text-[10.5px] tracking-wider text-faint uppercase">
				<span>名称</span>
				<span className="text-right">大小</span>
				<span className="text-right">修改时间</span>
				<span className="text-right">权限</span>
			</div>

			{/* 列表区：数据源未接入 */}
			<div className="relative min-h-0 flex-1 overflow-y-auto">
				<EmptyState icon={empty.icon} title={empty.title} description={empty.description} action={empty.action} />
			</div>
		</div>
	);
}
