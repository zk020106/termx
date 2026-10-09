import type { RightClickAction } from "@/data/preferences";

/* =============================================================================
 * 终端右键菜单的判定逻辑 —— 移植自 Netcatty
 *   components/terminal/TerminalContextMenu.tsx（shouldOpenTerminalContextMenu 等）
 *   components/terminal/runtime/middleClickBehavior.ts（中键菜单标记、鼠标跟踪判定）
 * termx 的右键行为取值：menu = Netcatty 'context-menu'，select-word 同名，
 * paste 同名；select 是 termx 原有的「复制选区」。
 * ========================================================================== */

const MIDDLE_CONTEXT_MENU_EVENT_KEY = "__termxMiddleContextMenu";

type MarkedMouseEvent = MouseEvent & { [MIDDLE_CONTEXT_MENU_EVENT_KEY]?: boolean };

export const markMiddleClickContextMenuEvent = (event: MouseEvent): MouseEvent => {
	Object.defineProperty(event, MIDDLE_CONTEXT_MENU_EVENT_KEY, { value: true, configurable: true });
	return event;
};

export const isMiddleClickContextMenuEvent = (event: MouseEvent): boolean =>
	(event as MarkedMouseEvent)[MIDDLE_CONTEXT_MENU_EVENT_KEY] === true;

/** Netcatty isMouseTrackingActive：拿得到 xterm 的模式就以它为准，否则看是否在备用屏 */
export const isMouseTrackingActive = ({
	mouseTracking,
	terminalMouseTrackingMode,
}: {
	mouseTracking: boolean;
	terminalMouseTrackingMode?: string;
}): boolean => (terminalMouseTrackingMode === undefined ? mouseTracking : terminalMouseTrackingMode !== "none");

export interface TerminalMenuDecisionInput {
	shiftKey?: boolean;
	middleClick?: boolean;
	isAlternateScreen?: boolean;
	terminalMouseTrackingMode?: string;
	/** 断线可重连时菜单永远要能弹出（里面有「重新连接」） */
	showReconnectAction?: boolean;
	/** 设置「在全屏应用中也显示菜单」 */
	forceMenuInAlternateScreen?: boolean;
	rightClickBehavior?: RightClickAction;
}

/** Netcatty shouldSuppressMouseTrackingContextMenu */
export const shouldSuppressMouseTrackingContextMenu = ({
	isAlternateScreen,
	terminalMouseTrackingMode,
	showReconnectAction,
	forceMenuInAlternateScreen,
}: TerminalMenuDecisionInput): boolean =>
	isMouseTrackingActive({ mouseTracking: Boolean(isAlternateScreen), terminalMouseTrackingMode }) &&
	!showReconnectAction &&
	!forceMenuInAlternateScreen;

/** Netcatty shouldOpenTerminalContextMenu：中键菜单 / Shift+右键永远弹；全屏应用抓鼠标时不弹；否则看右键行为 */
export const shouldOpenTerminalContextMenu = (input: TerminalMenuDecisionInput): boolean => {
	if (input.middleClick) return true;
	if (input.shiftKey) return true;
	if (shouldSuppressMouseTrackingContextMenu(input)) return false;
	return (input.rightClickBehavior ?? "menu") === "menu";
};

export type TerminalRightClickOutcome = "menu" | "suppress" | "paste" | "select-word" | "copy";

/** 一次右键（或中键菜单）最终做什么 */
export const resolveTerminalRightClick = (input: TerminalMenuDecisionInput): TerminalRightClickOutcome => {
	if (shouldOpenTerminalContextMenu(input)) return "menu";
	if (shouldSuppressMouseTrackingContextMenu(input)) return "suppress";
	switch (input.rightClickBehavior) {
		case "paste":
			return "paste";
		case "select-word":
			return "select-word";
		case "select":
			return "copy";
		default:
			return "menu";
	}
};

/** Netcatty TerminalContextMenu.getShortcut 的显示格式在 lib/keyBindings.shortcutLabel 里 */
