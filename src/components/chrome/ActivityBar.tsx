import { activities, settingsActivity, type ActivityId } from "@/components/chrome/activities";
import { cn } from "@/lib/cn";
import { useUiStore } from "@/store/ui";
import { Link, useLocation } from "react-router";

/** 活动栏（需求书 04-②）：44px 宽，主机库/文件/转发/片段/密钥/传输，设置固定底部 */
export function ActivityBar({ current }: { current?: ActivityId }) {
	const { pathname } = useLocation();
	const setActivity = useUiStore((s) => s.setActivity);
	const sidebarOpen = useUiStore((s) => s.sidebarOpen);
	const toggleSidebar = useUiStore((s) => s.toggleSidebar);

	const active: ActivityId | undefined =
		current ??
		(activities.find((a) => a.to === pathname)?.id ??
			(pathname.startsWith("/settings") || pathname.startsWith("/updater") ? "settings" : undefined));

	return (
		<nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface-sunk py-2">
			{activities.map((item) => {
				const on = item.id === active;
				return (
					<Link
						key={item.id}
						to={item.to}
						title={item.label}
						aria-label={item.label}
						onClick={() => {
							setActivity(item.id);
							// 点击当前项 = 收起/展开侧边面板（与 VS Code 一致）
							if (on) toggleSidebar();
						}}
						className={cn(
							"group relative flex size-7 items-center justify-center rounded-control transition-colors",
							on
								? "bg-surface-raised text-surface-foreground"
								: "text-muted hover:bg-surface-raised/60 hover:text-surface-foreground",
						)}
					>
						{on && sidebarOpen && <span className="absolute -left-2 h-3.5 w-0.5 rounded-r bg-primary" />}
						<span className={cn(item.icon, "size-3.5")} />
					</Link>
				);
			})}

			<Link
				to={settingsActivity.to}
				title={settingsActivity.label}
				aria-label={settingsActivity.label}
				className={cn(
					"group relative mt-auto flex size-7 items-center justify-center rounded-control transition-colors",
					active === "settings"
						? "bg-surface-raised text-surface-foreground"
						: "text-muted hover:bg-surface-raised/60 hover:text-surface-foreground",
				)}
			>
				{active === "settings" && <span className="absolute -left-2 h-3.5 w-0.5 rounded-r bg-primary" />}
				<span className={cn(settingsActivity.icon, "size-3.5")} />
			</Link>
		</nav>
	);
}
