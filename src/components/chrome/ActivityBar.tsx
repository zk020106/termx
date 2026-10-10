import { activities, activityFromPath, settingsActivity, type ActivityDef } from "@/components/chrome/activities";
import { cn } from "@/lib/cn";
import { useSessionsStore } from "@/store/sessions";
import { useUiStore } from "@/store/ui";
import { Link, useLocation, useNavigate } from "react-router";

/** 活动栏：44px 宽，全局一级资产导航（主机库、命令片段、密钥、代理、转发、传输）与设置 */
export function ActivityBar() {
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const tabs = useSessionsStore((s) => s.tabs);
	const toggleSidebar = useUiStore((s) => s.toggleSidebar);
	const setActivity = useUiStore((s) => s.setActivity);
	const companionOpen = useUiStore((s) => s.companionOpen);
	const companionTab = useUiStore((s) => s.companionTab);
	const toggleCompanion = useUiStore((s) => s.toggleCompanion);

	const isWorkspace = pathname.startsWith("/workspace") || pathname.startsWith("/hosts") || pathname === "/";
	const active = activityFromPath(pathname) ?? "hosts";

	const handleItemClick = (item: ActivityDef) => {
		if (item.id === "hosts") {
			if (isWorkspace) {
				// 已在工作区：若处于终端分屏标签，点击可便捷展开/收起左侧主机列表抽屉
				if (tabs.length > 0) {
					setActivity("hosts");
					toggleSidebar();
				}
			} else {
				navigate("/workspace");
			}
			return;
		}

		// 单舞台一体化工作台：用户在终端会话中时，点击文件/转发/片段直接唤起同屏伴随面板，零打断
		if (isWorkspace && tabs.length > 0) {
			if (item.id === "sftp" || item.id === "forward" || item.id === "snippets") {
				toggleCompanion(item.id);
				return;
			}
		}

		// 全局一级资产：直接切换到对应的全功能管理页面
		navigate(item.to);
	};

	return (
		<nav aria-label="全局资产导航" className="flex w-11 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-surface-sunk py-2.5">
			{activities.map((item) => {
				const isOn =
					isWorkspace && tabs.length > 0 && companionOpen
						? item.id === companionTab
						: item.id === active;

				return (
					<button
						key={item.id}
						type="button"
						title={item.label}
						aria-label={item.label}
						aria-current={isOn ? "page" : undefined}
						onClick={() => handleItemClick(item)}
						className={cn(
							"group relative flex size-7 items-center justify-center rounded-control transition-[color,background-color] duration-150 ease-out cursor-pointer",
							isOn
								? "bg-accent/15 text-accent shadow-xs"
								: "text-muted hover:bg-surface-raised hover:text-surface-foreground",
						)}
					>
						{isOn && <span className="absolute -left-1.5 h-3.5 w-0.5 rounded-r-full bg-accent shadow-[0_0_8px_var(--tx-accent)]" />}
						<span className={cn(item.icon, "size-4")} />
						{item.id === "hosts" && tabs.length > 0 && (
							<span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-accent font-mono text-[8.5px] font-bold text-accent-foreground shadow-2xs">
								{tabs.length}
							</span>
						)}
					</button>
				);
			})}

			<div className="mt-auto flex flex-col items-center gap-1.5">
				<Link
					to={settingsActivity.to}
					title={settingsActivity.label}
					aria-label={settingsActivity.label}
					aria-current={pathname.startsWith("/settings") ? "page" : undefined}
					className={cn(
						"group relative flex size-7 items-center justify-center rounded-control transition-[color,background-color] duration-150 ease-out cursor-pointer",
						pathname.startsWith("/settings")
							? "bg-accent/15 text-accent shadow-xs"
							: "text-muted hover:bg-surface-raised hover:text-surface-foreground",
					)}
				>
					{pathname.startsWith("/settings") && (
						<span className="absolute -left-1.5 h-3.5 w-0.5 rounded-r-full bg-accent shadow-[0_0_8px_var(--tx-accent)]" />
					)}
					<span className={cn(settingsActivity.icon, "size-4")} />
				</Link>
			</div>
		</nav>
	);
}
