import type { HostTerminalPrefs } from "@/data/types";
import type { CursorStyle, TerminalSchemeId } from "@/data/preferences";

/* 主机级终端外观 → 实际生效的 xterm 选项。
 * 只有主机标记了 custom（用户在主机编辑的「终端外观」里改过）才覆盖全局设置。 */

/** 主机编辑里的配色名 → 设置页的配色方案 id */
const SCHEME_BY_NAME: Record<string, TerminalSchemeId> = {
	"one dark": "one-dark",
	dracula: "dracula",
	nord: "nord",
	"solarized dark": "solarized",
	solarized: "solarized",
	"gruvbox dark": "gruvbox",
	gruvbox: "gruvbox",
	monokai: "monokai",
	"tokyo night": "tokyo-night",
	catppuccin: "catppuccin",
	"github dark": "github-dark",
};

export function schemeIdFromName(name: string | undefined): TerminalSchemeId | null {
	if (!name) return null;
	return SCHEME_BY_NAME[name.trim().toLowerCase()] ?? null;
}

export interface TerminalLook {
	scheme: TerminalSchemeId;
	fontFamily: string;
	fontSize: number;
	lineHeight: number;
	cursorStyle: CursorStyle;
}

export function effectiveLook(global: TerminalLook, host: HostTerminalPrefs | undefined | null): TerminalLook {
	if (!host?.custom) return global;
	const fontFamily = host.fontFamily && host.fontFamily !== "系统等宽字体" ? host.fontFamily : host.fontFamily ? "ui-monospace" : global.fontFamily;
	const fontSize = Number(host.fontSize);
	const lineHeight = Number(host.lineHeight);
	return {
		scheme: schemeIdFromName(host.colorScheme) ?? global.scheme,
		fontFamily,
		fontSize: Number.isFinite(fontSize) && fontSize >= 6 && fontSize <= 48 ? fontSize : global.fontSize,
		lineHeight: Number.isFinite(lineHeight) && lineHeight >= 0.8 && lineHeight <= 3 ? lineHeight : global.lineHeight,
		cursorStyle: host.cursorStyle ?? global.cursorStyle,
	};
}
