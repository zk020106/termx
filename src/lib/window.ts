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

/* ---------------- 多窗口（Netcatty「复制标签页到新窗口」，见 src-tauri/src/app_window.rs） ---------------- */

/** 当前窗口标签；浏览器里没有窗口概念，按主窗口算 */
export function currentWindowLabel(): string {
	const meta = (globalThis as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
		.__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
	return typeof meta === "string" && meta ? meta : "main";
}

/** Netcatty isPeerSessionWindow：由「复制标签页到新窗口」打开的窗口 */
export function isSessionWindow(): boolean {
	return /^session-\d+$/.test(currentWindowLabel());
}

/** 新窗口载荷：要克隆的标签与它的分屏格（只有布局与主机 id，不含任何凭据） */
export interface SessionWindowPayload {
	tab: import("@/data/types").SessionTab;
	panes: import("@/data/types").TerminalPane[];
}

/** Netcatty bridge.openSessionInNewWindow */
export async function openSessionInNewWindow(title: string, payload: SessionWindowPayload): Promise<void> {
	if (!isTauri()) throw new Error("新窗口需要在桌面端运行");
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("window_open_session", { title, payload });
}

/** 会话窗口启动时取走自己的载荷（只能取一次） */
export async function takeSessionWindowPayload(): Promise<SessionWindowPayload | null> {
	if (!isTauri() || !isSessionWindow()) return null;
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<SessionWindowPayload | null>("window_take_session_payload");
}

/** 登记会话归属：窗口关闭时后端把它名下的会话一并断开 */
export function ownSession(kind: "ssh" | "pty", key: string): void {
	if (!isTauri()) return;
	void import("@tauri-apps/api/core")
		.then(({ invoke }) => invoke("window_own_session", { kind, key }))
		.catch(() => undefined);
}
