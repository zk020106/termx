import { Button, Kbd } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/Display";
import { CONNECTION_LABEL, type ConnectionStatus, type TerminalPane as TerminalPaneModel } from "@/data/types";
import { cn } from "@/lib/cn";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Terminal, panePrompt, type TerminalHandle } from "./Terminal";
import { sshSessionWasConnected } from "./sshCache";
import { InTabConnect } from "./InTabConnect";
import { useSettingsStore } from "@/store/settings";
import { schemeColors } from "./terminalSchemes";

/* =============================================================================
 * 分屏格的「窗框」：标题行 + 终端本体 + 各种状态覆盖物。
 *
 * 视觉基准 = termx.vetd/frames/index.tsx 的焦点分屏格：
 *   标题行 11px（提示符主色 / 右侧副标题 faint），正文 12px 等宽，
 *   焦点格 1px 主色内描边，非焦点格文字略暗。
 * 叠加态：广播中 / 连接中（标签内认证） / 已断开覆盖层。
 * ========================================================================== */

export function TerminalPane({
	pane,
	focused,
	broadcasting,
	offline,
	status,
	registerTerminal,
	onFocus,
	onContextMenu,
	onReconnect,
	onClose,
	onSplitRight,
	onSplitDown,
	onToggleMaximize,
	isMaximized,
	onOpenSftp,
	onClear,
	isSplit = false,
}: {
	pane: TerminalPaneModel;
	focused: boolean;
	broadcasting: boolean;
	offline: boolean;
	status: ConnectionStatus;
	registerTerminal: (paneId: string, handle: TerminalHandle | null) => void;
	onFocus: () => void;
	onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
	onReconnect: () => void;
	onClose?: () => void;
	onSplitRight?: () => void;
	onSplitDown?: () => void;
	onToggleMaximize?: () => void;
	isMaximized?: boolean;
	onOpenSftp?: () => void;
	onClear?: () => void;
	isSplit?: boolean;
}) {
	const scheme = useSettingsStore((s) => s.scheme);
	const customColors = schemeColors(scheme);
	const prompt = panePrompt(pane.hostId, pane.title);
	const showStatus = status !== "connected";
	// 尚未成功建立连接的远程主机：停留在标签内连接/凭据认证页（包含错误提示、指纹确认与重连表单）
	const isConnecting = Boolean(
		pane.hostId &&
			pane.sessionKey &&
			!sshSessionWasConnected(pane.sessionKey),
	);

	return (
		<div
			onMouseDown={onFocus}
			onContextMenu={onContextMenu}
			style={customColors ? { backgroundColor: customColors.background, color: customColors.foreground } : undefined}
			className={cn(
				"group relative flex min-h-0 min-w-0 flex-col overflow-hidden transition-colors duration-150",
				!customColors && "bg-term text-term-ink",
			)}
		>
			{/* 广播输入中：顶部 2px 警告条 + 标题行胶囊，两道标识保证一眼可见 */}
			{broadcasting && <span className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[2px] bg-warning" />}

			{/* 分屏模式下才显示各格独立标题控制栏；单屏模式下全沉浸展示，由顶部标签栏承载信息 */}
			{isSplit && (
				<div className="flex h-6.5 shrink-0 items-center justify-between gap-2 border-b border-border/40 bg-surface-sunk/30 px-2.5 text-[10.5px]">
					<span className="flex min-w-0 items-center gap-1.5">
						<span className={cn("truncate font-mono", focused ? "text-surface-foreground font-medium" : "text-muted")}>{prompt}</span>
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
				<div className="flex shrink-0 items-center gap-0.5">
					{pane.subtitle && <span className="mr-1 text-[10px] text-faint">{pane.subtitle}</span>}
					{onSplitRight && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onSplitRight();
							}}
							className="flex size-5 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-surface-foreground transition-colors"
							title="向右分屏 (Ctrl+Shift+D)"
						>
							<span className="icon-[lucide--columns-2] size-3" />
						</button>
					)}
					{onSplitDown && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onSplitDown();
							}}
							className="flex size-5 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-surface-foreground transition-colors"
							title="向下分屏 (Ctrl+Shift+E)"
						>
							<span className="icon-[lucide--rows-2] size-3" />
						</button>
					)}
					{onToggleMaximize && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onToggleMaximize();
							}}
							className={cn(
								"flex size-5 items-center justify-center rounded transition-colors",
								isMaximized
									? "text-primary bg-primary/10"
									: "text-muted hover:bg-surface-raised hover:text-surface-foreground",
							)}
							title={isMaximized ? "还原分屏 (Ctrl+Shift+M / Esc)" : "最大化分屏 (Ctrl+Shift+M)"}
						>
							<span className={cn(isMaximized ? "icon-[lucide--minimize-2]" : "icon-[lucide--maximize-2]", "size-3")} />
						</button>
					)}
					{onOpenSftp && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onOpenSftp();
							}}
							className="flex size-5 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-surface-foreground transition-colors"
							title="切换底部 SFTP (Ctrl+Shift+S)"
						>
							<span className="icon-[lucide--folder-tree] size-3" />
						</button>
					)}
					{onClear && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onClear();
							}}
							className="flex size-5 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-surface-foreground transition-colors"
							title="清屏 (Ctrl+L)"
						>
							<span className="icon-[lucide--eraser] size-3" />
						</button>
					)}
					{onClose && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onClose();
							}}
							className="flex size-5 items-center justify-center rounded text-muted hover:bg-danger/20 hover:text-danger transition-colors"
							title="关闭此分屏"
						>
							<span className="icon-[lucide--x] size-3" />
						</button>
					)}
				</div>
			</div>
		)}

			{/* 终端本体 / 标签内连接认证 */}
			<div className={cn("min-h-0 flex-1", isConnecting ? "p-0" : "p-1.5", !focused && !isConnecting && "opacity-90")}>
				{isConnecting ? (
					<InTabConnect
						paneId={pane.id}
						hostId={pane.hostId!}
						sessionKey={pane.sessionKey!}
						onConnected={() => {}}
						onCancel={onClose}
					/>
				) : (
					<Terminal
						paneId={pane.id}
						hostId={pane.hostId}
						sessionKey={pane.sessionKey}
						className="h-full w-full overflow-hidden"
						ref={(handle) => registerTerminal(pane.id, handle)}
					/>
				)}
			</div>

			{/* 已断开：半透明遮罩压灰终端内容（内容保留），回车/按钮重连 */}
			{(offline || status === "disconnected" || status === "failed") && !isConnecting && (
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
