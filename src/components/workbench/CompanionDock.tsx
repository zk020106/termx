import { IconButton } from "@/components/ui/Button";
import { EmbeddedSftpDrawer } from "@/components/sftp/EmbeddedSftpDrawer";
import { CompanionForward } from "@/components/workbench/CompanionForward";
import { CompanionSnippets } from "@/components/workbench/CompanionSnippets";
import { CompanionMonitor } from "@/components/workbench/CompanionMonitor";
import type { ConnectionStatus, Host, SessionTab } from "@/data/types";
import { cn } from "@/lib/cn";
import { useSettingsStore } from "@/store/settings";
import { toast } from "@/store/toast";
import { useUiStore, type CompanionTab } from "@/store/ui";
import { useRef } from "react";

interface CompanionDockProps {
	activeTab: SessionTab | null;
	activeHost: Host | null;
	focusedPaneId: string;
	onWriteToTerminal: (data: string) => void;
	onClose: () => void;
	availableSessions?: Array<{
		tabId: string;
		sessionKey: string | null;
		hostId: string | null;
		title: string;
		status: ConnectionStatus;
	}>;
	onSelectSession?: (tabId: string) => void;
	onReconnect?: () => void;
}

const TABS: Array<{ id: CompanionTab; label: string; icon: string }> = [
	{ id: "sftp", label: "文件", icon: "icon-[lucide--folder-tree]" },
	{ id: "forward", label: "转发", icon: "icon-[lucide--waypoints]" },
	{ id: "snippets", label: "片段", icon: "icon-[lucide--code-xml]" },
	{ id: "monitor", label: "遥测", icon: "icon-[lucide--activity]" },
];

export function CompanionDock({
	activeTab,
	activeHost,
	onWriteToTerminal,
	onClose,
	availableSessions,
	onSelectSession,
	onReconnect,
}: CompanionDockProps) {
	const tab = useUiStore((s) => s.companionTab);
	const setTab = useUiStore((s) => s.setCompanionTab);
	const width = useUiStore((s) => s.companionWidth);
	const setWidth = useUiStore((s) => s.setCompanionWidth);

	const sftpFollowActiveTab = useSettingsStore((s) => s.sftpFollowActiveTab);
	const setTerminal = useSettingsStore((s) => s.setTerminal);

	const isDraggingRef = useRef(false);
	const startXRef = useRef(0);
	const startWidthRef = useRef(width);

	const handleMouseDown = (e: React.MouseEvent) => {
		isDraggingRef.current = true;
		startXRef.current = e.clientX;
		startWidthRef.current = width;

		const handleMouseMove = (moveEvent: MouseEvent) => {
			if (!isDraggingRef.current) return;
			const delta = startXRef.current - moveEvent.clientX;
			const newWidth = Math.max(300, Math.min(720, startWidthRef.current + delta));
			setWidth(newWidth);
		};

		const handleMouseUp = () => {
			isDraggingRef.current = false;
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
		};

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);
	};

	const hostLabel = activeHost
		? `${activeHost.username}@${activeHost.name}`
		: (activeTab?.title ?? "本地终端");

	return (
		<aside
			style={{ width: `${width}px` }}
			className="relative flex h-full shrink-0 flex-col border-l border-border bg-surface-sunk/95 select-none z-20 shadow-2xl backdrop-blur-md"
		>
			{/* 左侧可拖拽宽度调节手柄 */}
			<div
				onMouseDown={handleMouseDown}
				title="拖拽调节伴随面板宽度"
				className="group/resizer absolute -left-1.5 top-0 bottom-0 w-3 cursor-col-resize z-30 flex items-center justify-center"
			>
				<div className="h-10 w-0.75 rounded-full bg-border/80 group-hover/resizer:bg-accent transition-colors" />
			</div>

			{/* 顶栏：Tab 切换 + 关闭 */}
			<header className="flex h-8.5 shrink-0 items-center justify-between border-b border-border bg-surface px-2.5">
				{/* 4 个同屏伴随视窗 Tab */}
				<div className="flex items-center gap-1">
					{TABS.map((t) => {
						const active = tab === t.id;
						return (
							<button
								key={t.id}
								type="button"
								onClick={() => setTab(t.id)}
								className={cn(
									"flex h-6.5 items-center gap-1.5 rounded-control px-2 text-[11px] font-medium transition-colors cursor-pointer select-none",
									active
										? "border border-accent/40 bg-accent/15 text-accent shadow-2xs"
										: "text-muted hover:bg-surface-foreground/5 hover:text-surface-foreground",
								)}
							>
								<span className={cn(t.icon, "size-3.5", active ? "text-accent" : "text-faint")} />
								<span>{t.label}</span>
							</button>
						);
					})}
				</div>

				<IconButton
					icon="icon-[lucide--x]"
					label="收起伴随面板"
					className="size-6 text-muted hover:text-surface-foreground"
					onClick={onClose}
				/>
			</header>

			{/* 视窗主体内容 */}
			<div className="min-h-0 flex-1 flex flex-col bg-surface-sunk/40 overflow-hidden">
				{tab === "sftp" && (
					<EmbeddedSftpDrawer
						isDock={true}
						sessionKey={activeTab?.sessionKey ?? null}
						status={activeTab?.status}
						hostTitle={hostLabel}
						hostId={activeTab?.hostId ?? null}
						onClose={onClose}
						onReconnect={onReconnect}
						isFollowing={sftpFollowActiveTab}
						onToggleFollow={() => {
							setTerminal({ sftpFollowActiveTab: !sftpFollowActiveTab });
							toast({
								title: !sftpFollowActiveTab ? "SFTP 已开启跟随活跃终端" : "SFTP 已锁定当前会话",
								tone: "default",
							});
						}}
						availableSessions={availableSessions}
						onSelectSession={onSelectSession}
					/>
				)}

				{tab === "forward" && <CompanionForward activeHost={activeHost} />}

				{tab === "snippets" && (
					<CompanionSnippets
						activeHost={activeHost}
						onWriteToTerminal={onWriteToTerminal}
					/>
				)}

				{tab === "monitor" && (
					<CompanionMonitor
						sessionKey={activeTab?.sessionKey ?? null}
						activeHost={activeHost}
					/>
				)}
			</div>
		</aside>
	);
}
