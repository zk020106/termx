import { WindowChrome } from "@/components/chrome/WindowChrome";
import { AiAssistPanel } from "@/components/panels/AiAssistPanel";
import { SnippetsMiniPanel } from "@/components/panels/SnippetsMiniPanel";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState, StatusText } from "@/components/ui/Display";
import { useHostsStore } from "@/store/hosts";
import { useSessionsStore } from "@/store/sessions";
import { toast } from "@/store/toast";
import { useUiStore, type RightPanelTab } from "@/store/ui";
import { cn } from "@/lib/cn";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";

/* =============================================================================
 * 主机监控 —— 设计帧 termx.vetd/frames/monitor.tsx 的骨架版本。
 * 覆盖状态（需求书 06-主机监控）：正常 / 有指标超出阈值 / 无法获取数据。
 * 这三种状态都需要真实采样数据才能成立，而 Agentless SSH 采样通道与进程列表尚未接入，
 * 因此数据区域统一是空状态：只保留工具栏、状态标识与右侧工具面板，不展示任何示例指标。
 * ========================================================================== */

/** 右侧工具面板的三个页签（需求书 04-⑦：主机监控 / 命令片段 / AI 预留） */
const PANEL_TABS: { id: RightPanelTab; label: string }[] = [
	{ id: "monitor", label: "监控" },
	{ id: "snippets", label: "片段" },
	{ id: "ai", label: "AI 助手" },
];

const PANEL_TITLE: Record<RightPanelTab, string> = {
	monitor: "实时指标",
	snippets: "命令片段",
	ai: "AI 助手",
};

export default function Monitor() {
	const navigate = useNavigate();
	const tab = useUiStore((s) => s.rightPanelTab);
	const setRightPanelTab = useUiStore((s) => s.setRightPanelTab);
	const hostCount = useHostsStore((s) => s.hosts.length);
	/** 真实的第一个会话标签；没有会话时为 null（监控目标只能来自真实会话） */
	const session = useSessionsStore((s) => s.tabs[0] ?? null);

	// 深链：#/monitor?panel=ai|snippets，便于直接切到某个页签核对
	const panelParam = new URLSearchParams(useLocation().search).get("panel") as RightPanelTab | null;
	useEffect(() => {
		if (panelParam && PANEL_TABS.some((t) => t.id === panelParam)) setRightPanelTab(panelParam);
	}, [panelParam, setRightPanelTab]);

	const hostName = session?.title;

	const refresh = () =>
		toast({
			title: "监控采集尚未接入",
			description: "Agentless SSH 采样通道还没有实现。",
			tone: "default",
		});

	/** 数据区域的空状态：按「有没有主机 / 有没有会话」给出不同的下一步指引 */
	function renderEmpty() {
		if (session) {
			return (
				<EmptyState
					icon="icon-[lucide--activity]"
					title="指标采集尚未接入"
					action={
						<Button size="sm" variant="primary" icon="icon-[lucide--layout-dashboard]" onClick={() => navigate("/")}>
							返回工作台
						</Button>
					}
				/>
			);
		}
		if (hostCount > 0) {
			return (
				<EmptyState
					icon="icon-[lucide--plug-zap]"
					title="监控需要先建立 SSH 连接"
					action={
						<Button size="sm" variant="primary" icon="icon-[lucide--server]" onClick={() => navigate("/hosts")}>
							去主机库连接一台
						</Button>
					}
				/>
			);
		}
		return (
			<EmptyState
				icon="icon-[lucide--server-off]"
				title="还没有可监控的主机"
				action={
					<Button size="sm" variant="primary" icon="icon-[lucide--plus]" onClick={() => navigate("/hosts/new")}>
						新建主机
					</Button>
				}
			/>
		);
	}

	return (
		<WindowChrome>
			<div className="relative flex min-h-0 flex-1 bg-surface">
				{/* 左侧：指标与进程区域（采样未接入，整块为空状态） */}
				<div className="flex min-w-0 flex-1 flex-col">
					{/* 工具栏 */}
					<div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
						<div className="flex min-w-0 items-center gap-2">
							<span className="icon-[lucide--activity] size-3.5 text-primary" />
							<h1 className="text-[12px] font-semibold text-surface-foreground">主机监控</h1>
							<StatusText status="idle" label="未接入" className="text-[11px]" />
							<span className="truncate font-mono text-[11px] text-muted">{hostName ?? "未选择采样目标"}</span>
						</div>
						<div className="flex shrink-0 items-center gap-2">
							<span className="font-mono text-[10.5px] text-faint">Agentless SSH 采样</span>
							<Button size="sm" variant="ghost" icon="icon-[lucide--refresh-cw]" onClick={refresh}>
								刷新
							</Button>
							<Badge>指标未接入</Badge>
						</div>
					</div>

					{/* 指标与进程列表：数据源未接入 */}
					<div className="flex min-h-0 flex-1 items-center justify-center bg-surface">{renderEmpty()}</div>
				</div>

				{/* 右侧遥测面板 (Linear 风格 340px) */}
				<aside className="flex w-[340px] shrink-0 flex-col border-l border-border bg-surface-sunk">
					<div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3 text-[12px]">
						<div className="flex items-center gap-2">
							<span className="font-medium text-surface-foreground">{PANEL_TITLE[tab]}</span>
							<span className="text-border">/</span>
							<span className="font-mono text-[11px] text-muted">{hostName ?? "未选择目标"}</span>
						</div>
						{/* 可切换的右侧工具面板，不再只是装饰标签 */}
						<div className="flex items-center gap-1">
							{PANEL_TABS.map((t) => (
								<button
									key={t.id}
									type="button"
									onClick={() => setRightPanelTab(t.id)}
									className={cn(
										"rounded px-2 py-0.5 text-[11px] transition-colors",
										tab === t.id
											? "border border-border bg-surface-raised font-medium text-primary"
											: "text-muted hover:bg-surface-raised hover:text-surface-foreground",
									)}
								>
									{t.label}
								</button>
							))}
						</div>
					</div>

					{/* 遥测内容：切到别的页签时隐藏而不卸载，保留滚动位置 */}
					<div className={cn("min-h-0 flex-1", tab !== "monitor" && "hidden")}>
						<EmptyState icon="icon-[lucide--gauge]" title="实时指标未接入" />
					</div>

					{/* 另两个页签各自的内容（片段与 AI 都读真实 store） */}
					{tab === "snippets" && <SnippetsMiniPanel hostName={hostName} />}
					{tab === "ai" && <AiAssistPanel hostName={hostName} />}

					{tab === "monitor" && (
						<div className="flex shrink-0 justify-between border-t border-border bg-surface-raised px-3 py-2 font-mono text-[10.5px] text-faint">
							<span>采样方式: Agentless SSH</span>
							<span>未接入</span>
						</div>
					)}
				</aside>
			</div>
		</WindowChrome>
	);
}
