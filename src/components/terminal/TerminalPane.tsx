import { Button, Kbd } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/Display";
import { CONNECTION_LABEL, type ConnectionStatus, type TerminalPane as TerminalPaneModel } from "@/data/types";
import { cn } from "@/lib/cn";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Terminal, panePrompt, type TerminalHandle } from "./Terminal";

/* =============================================================================
 * 分屏格的「窗框」：标题行 + 终端本体 + 各种评审态覆盖物。
 *
 * 视觉基准 = termx.vetd/frames/index.tsx 的焦点分屏格：
 *   标题行 11px（提示符主色 / 右侧副标题 faint），正文 12px 等宽，
 *   焦点格 1px 主色内描边，非焦点格文字略暗。
 * 叠加态（需求书 06-终端工作区）：广播中 / 已断开覆盖层 / 生产环境 2px 红描边。 * ========================================================================== */

export function TerminalPane({
	pane,
	focused,
	broadcasting,
	offline,
	prod,
	status,
	registerTerminal,
	onFocus,
	onContextMenu,
	onReconnect,
}: {
	pane: TerminalPaneModel;
	focused: boolean;
	broadcasting: boolean;
	offline: boolean;
	prod: boolean;
	status: ConnectionStatus;
	registerTerminal: (paneId: string, handle: TerminalHandle | null) => void;
	onFocus: () => void;
	onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
	onReconnect: () => void;
}) {
	const prompt = panePrompt(pane.hostId, pane.title);
	const showStatus = status !== "connected";

	return (
		<div
			onMouseDown={onFocus}
			onContextMenu={onContextMenu}
			className={cn(
				"relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-term",
				// 生产环境提示：整格 2px 内描边
				prod && "shadow-[inset_0_0_0_2px_var(--color-danger)]",
			)}
		>
			{/* 广播输入中：顶部 2px 警告条 + 标题行胶囊，两道标识保证一眼可见 */}
			{broadcasting && <span className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[2px] bg-warning" />}
			{/* 焦点格 1px 主色描边（需求书 06） */}
			{focused && (
				<span className="pointer-events-none absolute inset-0 z-20 shadow-[inset_0_0_0_1px_var(--color-primary)]" />
			)}

			<div className="flex h-7 shrink-0 items-center justify-between gap-2 px-3 pt-1.5 text-[11px]">
				<span className="flex min-w-0 items-center gap-1.5">
					<span className={cn("truncate font-mono", focused ? "text-primary" : "text-primary/75")}>{prompt}</span>
					{broadcasting && (
						<span className="flex shrink-0 items-center gap-1 rounded-[3px] bg-warning/20 px-1 py-px text-[9.5px] font-medium text-warning">
							<span className="icon-[lucide--radio] size-2.5" />
							广播中
						</span>
					)}
					{showStatus && (
						<span className="flex shrink-0 items-center gap-1 text-[10px]">
							<StatusDot status={status} size={5} />
							<span className={status === "disconnected" ? "text-muted" : "text-warning"}>
								{CONNECTION_LABEL[status]}
							</span>
						</span>
					)}
				</span>
				<span className="shrink-0 text-[10px] text-faint">{pane.subtitle}</span>
			</div>

			{/* 终端本体：非焦点格压暗一档，焦点格保持全亮 */}
			<div className={cn("min-h-0 flex-1 px-3 pb-2.5", !focused && "opacity-80")}>
				<Terminal
					paneId={pane.id}
					hostId={pane.hostId}
					className="h-full w-full overflow-hidden"
					ref={(handle) => registerTerminal(pane.id, handle)}
				/>
			</div>

			{/* 已断开：半透明遮罩压灰终端内容（内容保留），回车/按钮重连 */}
			{offline && (
				<div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-surface-sunk/80 px-4 text-center backdrop-blur-[1px]">
					<span className="icon-[lucide--unplug] size-5 text-danger" />
					<div className="text-[12.5px] font-medium text-surface-foreground">连接已断开</div>
					<div className="text-[11.5px] leading-5 text-muted">
						终端内容已保留 · 按 <Kbd>Enter</Kbd> 重新连接
					</div>
					<Button size="sm" variant="primary" icon="icon-[lucide--refresh-cw]" onClick={onReconnect}>
						重新连接
					</Button>
				</div>
			)}
		</div>
	);
}
