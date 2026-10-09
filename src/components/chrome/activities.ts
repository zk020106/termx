/** 活动栏定义。以主机库为大本营，包含主机、文件(SFTP)、转发、片段、密钥、传输；设置固定在底部。 */

export type ActivityId = "hosts" | "sftp" | "forward" | "snippets" | "keys" | "proxies" | "transfers" | "settings";

export interface ActivityDef {
	id: ActivityId;
	to: string;
	icon: string;
	label: string;
	shortcut?: string;
}

export const activities: ActivityDef[] = [
	{ id: "hosts", to: "/workspace", icon: "icon-[lucide--server]", label: "主机" },
	{ id: "sftp", to: "/sftp", icon: "icon-[lucide--folder-tree]", label: "文件 (SFTP)" },
	{ id: "forward", to: "/forward", icon: "icon-[lucide--waypoints]", label: "端口转发" },
	{ id: "snippets", to: "/snippets", icon: "icon-[lucide--code-xml]", label: "命令片段" },
	{ id: "keys", to: "/keys", icon: "icon-[lucide--key-round]", label: "密钥管理" },
	{ id: "proxies", to: "/proxies", icon: "icon-[lucide--route]", label: "代理" },
	{ id: "transfers", to: "/transfers", icon: "icon-[lucide--arrow-down-up]", label: "传输任务" },
];

export const settingsActivity: ActivityDef = {
	id: "settings",
	to: "/settings",
	icon: "icon-[lucide--settings]",
	label: "设置",
	shortcut: "Ctrl ,",
};

/** 路由 → 活动栏高亮项 */
export function activityFromPath(pathname: string): ActivityId | undefined {
	if (pathname.startsWith("/workspace") || pathname.startsWith("/hosts") || pathname === "/") return "hosts";
	if (pathname.startsWith("/sftp") || pathname.startsWith("/editor")) return "sftp";
	if (pathname.startsWith("/forward")) return "forward";
	if (pathname.startsWith("/snippets")) return "snippets";
	if (pathname.startsWith("/keys")) return "keys";
	if (pathname.startsWith("/proxies")) return "proxies";
	if (pathname.startsWith("/transfers")) return "transfers";
	if (pathname.startsWith("/settings") || pathname.startsWith("/updater")) return "settings";
	return undefined;
}
