import { isTauri } from "@/lib/tauri";

/** 原生窗口控制。浏览器里运行时是空操作，保证前端可独立跑起来自检。 */

export async function minimizeWindow() {
	if (!isTauri()) return;
	const { getCurrentWindow } = await import("@tauri-apps/api/window");
	await getCurrentWindow().minimize();
}

export async function toggleMaximizeWindow() {
	if (!isTauri()) return;
	const { getCurrentWindow } = await import("@tauri-apps/api/window");
	await getCurrentWindow().toggleMaximize();
}

export async function closeWindow() {
	if (!isTauri()) return;
	const { getCurrentWindow } = await import("@tauri-apps/api/window");
	await getCurrentWindow().close();
}

/** 窗口是否最大化，用于切换最大化/还原图标 */
export async function isMaximized(): Promise<boolean> {
	if (!isTauri()) return false;
	const { getCurrentWindow } = await import("@tauri-apps/api/window");
	return getCurrentWindow().isMaximized();
}
