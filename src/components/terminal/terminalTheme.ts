import type { ITheme } from "@xterm/xterm";

/* =============================================================================
 * 终端配色：全部来自 src/styles/theme.css 的设计 token。
 *
 * 做法：把 var(--color-*) 交给浏览器解析成 rgb()（oklch 之类的现代色彩空间
 * xterm 不认，必须先由浏览器归一化），再喂给 xterm 的 theme。
 * 因此本目录里不出现任何颜色字面量，换配色只改 theme.css。
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
