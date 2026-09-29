/** 活动栏定义。顺序与需求书 04-② 一致：主机库、文件、转发、片段、密钥、传输；设置固定在底部。 */

export type ActivityId = "hosts" | "sftp" | "forward" | "snippets" | "keys" | "transfers" | "settings";

export interface ActivityDef {
	id: ActivityId;
	to: string;
	icon: string;
	label: string;
	shortcut?: string;
}

export const activities: ActivityDef[] = [
	{ id: "hosts", to: "/hosts", icon: "icon-[lucide--server]", label: "主机库" },
	{ id: "sftp", to: "/sftp", icon: "icon-[lucide--folder-tree]", label: "文件" },
	{ id: "forward", to: "/forward", icon: "icon-[lucide--waypoints]", label: "转发" },
	{ id: "snippets", to: "/snippets", icon: "icon-[lucide--square-terminal]", label: "片段" },
	{ id: "keys", to: "/keys", icon: "icon-[lucide--key-round]", label: "密钥" },
	{ id: "transfers", to: "/transfers", icon: "icon-[lucide--arrow-down-up]", label: "传输" },
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
	// 工作区自带主机侧栏，跟主机库算同一项
	if (pathname.startsWith("/hosts") || pathname.startsWith("/workspace")) return "hosts";
	if (pathname.startsWith("/sftp") || pathname.startsWith("/editor")) return "sftp";
	if (pathname.startsWith("/forward")) return "forward";
	if (pathname.startsWith("/snippets")) return "snippets";
	if (pathname.startsWith("/keys")) return "keys";
	if (pathname.startsWith("/transfers")) return "transfers";
	if (pathname.startsWith("/settings") || pathname.startsWith("/updater")) return "settings";
	return undefined;
}
