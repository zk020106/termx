import { activities, activityFromPath, settingsActivity, type ActivityDef } from "@/components/chrome/activities";
import { cn } from "@/lib/cn";
import { useSessionsStore } from "@/store/sessions";
import { useUiStore } from "@/store/ui";
import { Link, useLocation, useNavigate } from "react-router";

/** 活动栏：44px 宽，在终端工作区内无缝切换侧边抽屉与底部面板，不卸载终端 */
export function ActivityBar() {
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const tabs = useSessionsStore((s) => s.tabs);
	const sidebarOpen = useUiStore((s) => s.sidebarOpen);
	const toggleSidebar = useUiStore((s) => s.toggleSidebar);
	const uiActivity = useUiStore((s) => s.activity);
	const setActivity = useUiStore((s) => s.setActivity);
	const toggleEmbeddedSftp = useUiStore((s) => s.toggleEmbeddedSftp);
	const embeddedSftpOpen = useUiStore((s) => s.embeddedSftpOpen);

	const isWorkspace = pathname.startsWith("/workspace") || pathname === "/";
	const active = isWorkspace ? uiActivity : (activityFromPath(pathname) ?? "hosts");

	const handleItemClick = (item: ActivityDef) => {
		if (!isWorkspace) {
			setActivity(item.id);
			navigate("/workspace");
			return;
		}

		if (item.id === "sftp") {
			toggleEmbeddedSftp();
			return;
		}

		if (item.id === "hosts") {
			if (uiActivity === "hosts" && sidebarOpen) {
				useSessionsStore.getState().setActiveTab("vaults");
			} else {
				setActivity("hosts");
				if (!sidebarOpen) toggleSidebar();
			}
			return;
		}

		if (uiActivity === item.id && sidebarOpen) {
			toggleSidebar();
		} else {
			setActivity(item.id);
			if (!sidebarOpen) toggleSidebar();
		}
	};

	return (
		<nav className="flex w-11 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-surface-sunk py-2.5">
			{activities.map((item) => {
				const isOn = item.id === "sftp" ? (isWorkspace ? embeddedSftpOpen : active === "sftp") : item.id === active && (isWorkspace ? sidebarOpen : true);

				return (
					<button
						key={item.id}
						type="button"
						title={item.id === "sftp" ? "文件 (SFTP) · 展开/收起底部面板" : item.label}
						aria-label={item.label}
						onClick={() => handleItemClick(item)}
						className={cn(
							"group relative flex size-7.5 items-center justify-center rounded-xl transition-all duration-150 cursor-pointer",
							isOn
								? "bg-primary/15 text-primary shadow-xs"
								: "text-muted hover:bg-surface-raised hover:text-surface-foreground",
						)}
					>
						{isOn && <span className="absolute -left-1.5 h-4 w-0.5 rounded-r-full bg-primary" />}
						<span className={cn(item.icon, "size-4")} />
						{item.id === "hosts" && tabs.length > 0 && (
							<span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary font-mono text-[8.5px] font-bold text-white shadow-2xs">
								{tabs.length}
							</span>
						)}
					</button>
				);
			})}

			<Link
				to={settingsActivity.to}
				title={settingsActivity.label}
				aria-label={settingsActivity.label}
				className={cn(
					"group relative mt-auto flex size-7.5 items-center justify-center rounded-xl transition-all duration-150 cursor-pointer",
					pathname.startsWith("/settings")
						? "bg-primary/15 text-primary shadow-xs"
						: "text-muted hover:bg-surface-raised hover:text-surface-foreground",
				)}
			>
				{pathname.startsWith("/settings") && (
					<span className="absolute -left-1.5 h-4 w-0.5 rounded-r-full bg-primary" />
				)}
				<span className={cn(settingsActivity.icon, "size-4")} />
			</Link>
		</nav>
	);
}
