import { activities, activityFromPath, settingsActivity } from "@/components/chrome/activities";
import { cn } from "@/lib/cn";
import { useSessionsStore } from "@/store/sessions";
import { Link, useLocation } from "react-router";

/** 活动栏：44px 宽，主机/文件/转发/片段/密钥/传输，设置固定底部 */
export function ActivityBar() {
	const { pathname } = useLocation();
	const tabs = useSessionsStore((s) => s.tabs);
	const active = activityFromPath(pathname) ?? "hosts";

	return (
		<nav className="flex w-11 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-surface-sunk py-2.5">
			{activities.map((item) => {
				const on = item.id === active;
				return (
					<Link
						key={item.id}
						to={item.to}
						title={item.label}
						aria-label={item.label}
						onClick={() => {
							if (item.id === "hosts") {
								useSessionsStore.getState().setActiveTab("vaults");
							}
						}}
						className={cn(
							"group relative flex size-7.5 items-center justify-center rounded-xl transition-all duration-150 cursor-pointer",
							on
								? "bg-primary/15 text-primary shadow-xs"
								: "text-muted hover:bg-surface-raised hover:text-surface-foreground",
						)}
					>
						{on && <span className="absolute -left-1.5 h-4 w-0.5 rounded-r-full bg-primary" />}
						<span className={cn(item.icon, "size-4")} />
						{item.id === "hosts" && tabs.length > 0 && (
							<span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary font-mono text-[8.5px] font-bold text-white shadow-2xs">
								{tabs.length}
							</span>
						)}
					</Link>
				);
			})}

			<Link
				to={settingsActivity.to}
				title={settingsActivity.label}
				aria-label={settingsActivity.label}
				className={cn(
					"group relative mt-auto flex size-7.5 items-center justify-center rounded-xl transition-all duration-150 cursor-pointer",
					active === "settings"
						? "bg-primary/15 text-primary shadow-xs"
						: "text-muted hover:bg-surface-raised hover:text-surface-foreground",
				)}
			>
				{active === "settings" && <span className="absolute -left-1.5 h-4 w-0.5 rounded-r-full bg-primary" />}
				<span className={cn(settingsActivity.icon, "size-4")} />
			</Link>
		</nav>
	);
}
