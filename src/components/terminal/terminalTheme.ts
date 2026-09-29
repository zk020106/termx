import type { ITheme } from "@xterm/xterm";
import type { TerminalSchemeId } from "@/data/preferences";
import { schemeColors, type SchemeColors } from "./terminalSchemes";

/* =============================================================================
 * 终端配色。
 *
 * 两套来源：
 *   1. scheme = "theme"（默认）：全部来自 src/styles/theme.css 的设计 token。
 *      做法：把 var(--color-*) 交给浏览器解析成 rgb()（oklch 之类的现代色彩空间
 *      xterm 不认，必须先由浏览器归一化），再喂给 xterm 的 theme。
 *   2. scheme = 具体方案：用 terminalSchemes.ts 里各家公布的真实色板。
 *      选择的方案与界面深/浅主题互不干扰：换主题不会动终端方案。
 * ========================================================================== */

export interface TerminalPalette {
	/** 终端画布 */
	background: string;
	/** 默认前景 */
	foreground: string;
	muted: string;
	faint: string;
	primary: string;
	accent: string;
	success: string;
	warning: string;
	danger: string;
	border: string;
}

/** 用探针元素解析 CSS 变量：变量缺失时浏览器会退回继承色，不会抛错 */
function readVar(name: string): string {
	if (typeof document === "undefined") return "";
	const probe = document.createElement("span");
	probe.style.position = "absolute";
	probe.style.visibility = "hidden";
	probe.style.pointerEvents = "none";
	probe.style.color = `var(${name})`;
	document.body.appendChild(probe);
	const value = getComputedStyle(probe).color;
	probe.remove();
	return value;
}

/** 读取设计 token → 终端调色板。主题切换时重新调用即可。 */
export function readPalette(): TerminalPalette {
	return {
		background: readVar("--color-term"),
		foreground: readVar("--color-term-ink"),
		muted: readVar("--color-muted"),
		faint: readVar("--color-faint"),
		primary: readVar("--color-primary"),
		accent: readVar("--color-accent"),
		success: readVar("--color-success"),
		warning: readVar("--color-warning"),
		danger: readVar("--color-danger"),
		border: readVar("--color-border"),
	};
}

/** 终端字体沿用界面等宽字体 token（JetBrains Mono） */
export function readMonoFont(): string {
	if (typeof document === "undefined") return "monospace";
	const value = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
	return value || "monospace";
}

export function parseRgb(value: string): [number, number, number] | null {
	const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
	if (!match) return null;
	return [Math.round(Number(match[1])), Math.round(Number(match[2])), Math.round(Number(match[3]))];
}

/** rgb() → rgba()，给选区等需要透明度的场景用 */
export function withAlpha(rgb: string, alpha: number): string {
	const parts = parseRgb(rgb);
	if (!parts) return rgb;
	return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
}

/** 24 位前景色 ANSI 序列：演示输出按 token 上色，不走 16 色板 */
export function fg(rgb: string, text: string): string {
	const parts = parseRgb(rgb);
	if (!parts) return text;
	return `\u001b[38;2;${parts[0]};${parts[1]};${parts[2]}m${text}\u001b[39m`;
}

/** 24 位背景色 ANSI 序列 */
export function bg(rgb: string, text: string): string {
	const parts = parseRgb(rgb);
	if (!parts) return text;
	return `\u001b[48;2;${parts[0]};${parts[1]};${parts[2]}m${text}\u001b[49m`;
}

/** 组装 xterm 主题：16 色板也映射到设计 token，真实 PTY 输出同样不跑偏 */
export function buildXtermTheme(palette: TerminalPalette): ITheme {
	return {
		background: palette.background,
		foreground: palette.foreground,
		cursor: palette.primary,
		cursorAccent: palette.background,
		selectionBackground: withAlpha(palette.primary, 0.35),
		selectionInactiveBackground: withAlpha(palette.primary, 0.18),
		black: palette.border,
		red: palette.danger,
		green: palette.success,
		yellow: palette.warning,
		blue: palette.primary,
		magenta: palette.accent,
		cyan: palette.accent,
		white: palette.muted,
		brightBlack: palette.faint,
		brightRed: palette.danger,
		brightGreen: palette.success,
		brightYellow: palette.warning,
		brightBlue: palette.primary,
		brightMagenta: palette.accent,
		brightCyan: palette.accent,
		brightWhite: palette.foreground,
	};
}

/** 组装具体配色方案的 xterm 主题：直接用方案自己的色板 */
export function buildSchemeTheme(colors: SchemeColors): ITheme {
	return {
		background: colors.background,
		foreground: colors.foreground,
		cursor: colors.cursor,
		cursorAccent: colors.background,
		selectionBackground: withAlpha(colors.cursor, 0.3),
		selectionInactiveBackground: withAlpha(colors.cursor, 0.15),
		black: colors.black,
		red: colors.red,
		green: colors.green,
		yellow: colors.yellow,
		blue: colors.blue,
		magenta: colors.magenta,
		cyan: colors.cyan,
		white: colors.white,
		brightBlack: colors.brightBlack,
		brightRed: colors.brightRed,
		brightGreen: colors.brightGreen,
		brightYellow: colors.brightYellow,
		brightBlue: colors.brightBlue,
		brightMagenta: colors.brightMagenta,
		brightCyan: colors.brightCyan,
		brightWhite: colors.brightWhite,
	};
}

/** 当前该用哪套主题：选了具体方案就用它，否则跟随界面 token */
export function xtermThemeFor(scheme: TerminalSchemeId, palette: TerminalPalette): ITheme {
	const colors = schemeColors(scheme);
	return colors ? buildSchemeTheme(colors) : buildXtermTheme(palette);
}

/** 终端里那几行说明文字的颜色：跟着当前方案走，避免在方案底色上糊成一团 */
export function noteColor(scheme: TerminalSchemeId, palette: TerminalPalette): string {
	return schemeColors(scheme)?.brightBlack ?? palette.faint;
}
