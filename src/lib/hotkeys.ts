import { useMemo } from "react";
import { useSettingsStore } from "@/store/settings";
import { detectPlatform } from "@/lib/platform";
import { isMacScheme, matchKeyBinding, resolveKeyBindings, type KeyBinding, type HotkeyScheme } from "@/lib/keyBindings";

/* =============================================================================
 * 快捷键运行时：把 settings 里的方案 + 自定义覆盖合成生效键位表，
 * 供 WindowChrome（应用级）、Workspace（标签/分屏级）、Terminal（终端级）共用。
 * 对应 Netcatty application/state/useGlobalHotkeys + useSettingsState.keyBindings。
 * ========================================================================== */

export interface HotkeyContext {
	scheme: HotkeyScheme;
	isMac: boolean;
	bindings: KeyBinding[];
}

export function currentHotkeyContext(): HotkeyContext {
	const { hotkeyScheme, customKeyBindings } = useSettingsStore.getState();
	return {
		scheme: hotkeyScheme,
		isMac: isMacScheme(hotkeyScheme, detectPlatform() === "macos"),
		bindings: resolveKeyBindings(customKeyBindings),
	};
}

export function useHotkeyContext(): HotkeyContext {
	const scheme = useSettingsStore((s) => s.hotkeyScheme);
	const custom = useSettingsStore((s) => s.customKeyBindings);
	return useMemo(
		() => ({
			scheme,
			isMac: isMacScheme(scheme, detectPlatform() === "macos"),
			bindings: resolveKeyBindings(custom),
		}),
		[scheme, custom],
	);
}

/**
 * 当前方案下与事件匹配的绑定；方案为 disabled 时一律不匹配（同 Netcatty）。
 * 默认只看非 SFTP 分类：SFTP 键位（Ctrl+C / Ctrl+V / Delete / F5…）只在文件面板里生效，
 * 不能让它们在终端 / 工作区里抢先匹配。
 */
export function matchHotkey(
	event: KeyboardEvent,
	ctx: HotkeyContext = currentHotkeyContext(),
	category: "app" | "sftp" = "app",
): KeyBinding | null {
	if (ctx.scheme === "disabled") return null;
	const pool = ctx.bindings.filter((b) => (category === "sftp" ? b.category === "sftp" : b.category !== "sftp"));
	return matchKeyBinding(event, pool, ctx.isMac);
}

/* ---------------- 终端 → 工作区的请求（搜索栏挂在工作区上） ---------------- */

type TerminalRequest = { kind: "search"; paneId: string };
const listeners = new Set<(request: TerminalRequest) => void>();

export function emitTerminalRequest(request: TerminalRequest): void {
	for (const listener of listeners) listener(request);
}

export function onTerminalRequest(listener: (request: TerminalRequest) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Netcatty AppHandlers：焦点在输入框 / 文本域 / 可编辑区（且不是 xterm 的输入层）时不抢快捷键，
 * 例外是 Esc、快速切换与窗格缩放。
 */
export function shouldSkipHotkeyForTarget(event: KeyboardEvent, binding: KeyBinding | null): boolean {
	const target = event.target as HTMLElement | null;
	if (!target || typeof target.closest !== "function") return false;
	const isForm = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
	const isXterm = Boolean(target.closest(".xterm, .xterm-helper-textarea, .xterm-screen, .xterm-viewport"));
	if (!isForm || isXterm || event.key === "Escape") return false;
	return binding?.action !== "quickSwitch" && binding?.action !== "togglePaneZoom";
}
