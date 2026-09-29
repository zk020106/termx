import type { TerminalSchemeId } from "@/data/preferences";

/* =============================================================================
 * 终端配色方案的真实色板。
 *
 * 这里的十六进制不是界面 token，而是各家方案**对外公布**的终端色板：
 * 它只喂给 xterm 的 theme 与设置页的方案预览，不参与任何界面样式
 * （界面颜色仍然全部走 theme.css 的 token，深/浅主题与终端配色互不干扰）。
 * ========================================================================== */

/** xterm 的 16 色 + 背景/前景/光标 */
export interface SchemeColors {
	background: string;
	foreground: string;
	cursor: string;
	black: string;
	red: string;
	green: string;
	yellow: string;
	blue: string;
	magenta: string;
	cyan: string;
	white: string;
	brightBlack: string;
	brightRed: string;
	brightGreen: string;
	brightYellow: string;
	brightBlue: string;
	brightMagenta: string;
	brightCyan: string;
	brightWhite: string;
}

export interface TerminalScheme {
	/** "theme" 之外的具体方案 id */
	id: Exclude<TerminalSchemeId, "theme">;
	name: string;
	colors: SchemeColors;
}

export const TERMINAL_SCHEMES: readonly TerminalScheme[] = [
	{
		id: "one-dark",
		name: "One Dark",
		colors: {
			background: "#282c34",
			foreground: "#abb2bf",
			cursor: "#528bff",
			black: "#282c34",
			red: "#e06c75",
			green: "#98c379",
			yellow: "#e5c07b",
			blue: "#61afef",
			magenta: "#c678dd",
			cyan: "#56b6c2",
			white: "#abb2bf",
			brightBlack: "#5c6370",
			brightRed: "#e06c75",
			brightGreen: "#98c379",
			brightYellow: "#e5c07b",
			brightBlue: "#61afef",
			brightMagenta: "#c678dd",
			brightCyan: "#56b6c2",
			brightWhite: "#ffffff",
		},
	},
	{
		id: "dracula",
		name: "Dracula",
		colors: {
			background: "#282a36",
			foreground: "#f8f8f2",
			cursor: "#f8f8f2",
			black: "#21222c",
			red: "#ff5555",
			green: "#50fa7b",
			yellow: "#f1fa8c",
			blue: "#bd93f9",
			magenta: "#ff79c6",
			cyan: "#8be9fd",
			white: "#f8f8f2",
			brightBlack: "#6272a4",
			brightRed: "#ff6e6e",
			brightGreen: "#69ff94",
			brightYellow: "#ffffa5",
			brightBlue: "#d6acff",
			brightMagenta: "#ff92df",
			brightCyan: "#a4ffff",
			brightWhite: "#ffffff",
		},
	},
	{
		id: "solarized",
		name: "Solarized Dark",
		colors: {
			background: "#002b36",
			foreground: "#839496",
			cursor: "#93a1a1",
			black: "#073642",
			red: "#dc322f",
			green: "#859900",
			yellow: "#b58900",
			blue: "#268bd2",
			magenta: "#d33682",
			cyan: "#2aa198",
			white: "#eee8d5",
			brightBlack: "#002b36",
			brightRed: "#cb4b16",
			brightGreen: "#586e75",
			brightYellow: "#657b83",
			brightBlue: "#839496",
			brightMagenta: "#6c71c4",
			brightCyan: "#93a1a1",
			brightWhite: "#fdf6e3",
		},
	},
	{
		id: "nord",
		name: "Nord",
		colors: {
			background: "#2e3440",
			foreground: "#d8dee9",
			cursor: "#d8dee9",
			black: "#3b4252",
			red: "#bf616a",
			green: "#a3be8c",
			yellow: "#ebcb8b",
			blue: "#81a1c1",
			magenta: "#b48ead",
			cyan: "#88c0d0",
			white: "#e5e9f0",
			brightBlack: "#4c566a",
			brightRed: "#bf616a",
			brightGreen: "#a3be8c",
			brightYellow: "#ebcb8b",
			brightBlue: "#81a1c1",
			brightMagenta: "#b48ead",
			brightCyan: "#8fbcbb",
			brightWhite: "#eceff4",
		},
	},
	{
		id: "gruvbox",
		name: "Gruvbox Dark",
		colors: {
			background: "#282828",
			foreground: "#ebdbb2",
			cursor: "#ebdbb2",
			black: "#282828",
			red: "#cc241d",
			green: "#98971a",
			yellow: "#d79921",
			blue: "#458588",
			magenta: "#b16286",
			cyan: "#689d6a",
			white: "#a89984",
			brightBlack: "#928374",
			brightRed: "#fb4934",
			brightGreen: "#b8bb26",
			brightYellow: "#fabd2f",
			brightBlue: "#83a598",
			brightMagenta: "#d3869b",
			brightCyan: "#8ec07c",
			brightWhite: "#ebdbb2",
		},
	},
	{
		id: "tokyo-night",
		name: "Tokyo Night",
		colors: {
			background: "#1a1b26",
			foreground: "#c0caf5",
			cursor: "#c0caf5",
			black: "#15161e",
			red: "#f7768e",
			green: "#9ece6a",
			yellow: "#e0af68",
			blue: "#7aa2f7",
			magenta: "#bb9af7",
			cyan: "#7dcfff",
			white: "#a9b1d6",
			brightBlack: "#414868",
			brightRed: "#f7768e",
			brightGreen: "#9ece6a",
			brightYellow: "#e0af68",
			brightBlue: "#7aa2f7",
			brightMagenta: "#bb9af7",
			brightCyan: "#7dcfff",
			brightWhite: "#c0caf5",
		},
	},
	{
		id: "catppuccin",
		name: "Catppuccin Mocha",
		colors: {
			background: "#1e1e2e",
			foreground: "#cdd6f4",
			cursor: "#f5e0dc",
			black: "#45475a",
			red: "#f38ba8",
			green: "#a6e3a1",
			yellow: "#f9e2af",
			blue: "#89b4fa",
			magenta: "#f5c2e7",
			cyan: "#94e2d5",
			white: "#bac2de",
			brightBlack: "#585b70",
			brightRed: "#f38ba8",
			brightGreen: "#a6e3a1",
			brightYellow: "#f9e2af",
			brightBlue: "#89b4fa",
			brightMagenta: "#f5c2e7",
			brightCyan: "#94e2d5",
			brightWhite: "#a6adc8",
		},
	},
	{
		id: "github-dark",
		name: "GitHub Dark",
		colors: {
			background: "#0d1117",
			foreground: "#c9d1d9",
			cursor: "#58a6ff",
			black: "#484f58",
			red: "#ff7b72",
			green: "#3fb950",
			yellow: "#d29922",
			blue: "#58a6ff",
			magenta: "#bc8cff",
			cyan: "#39c5cf",
			white: "#b1bac4",
			brightBlack: "#6e7681",
			brightRed: "#ffa198",
			brightGreen: "#56d364",
			brightYellow: "#e3b341",
			brightBlue: "#79c0ff",
			brightMagenta: "#d2a8ff",
			brightCyan: "#56d4dd",
			brightWhite: "#f0f6fc",
		},
	},
	{
		id: "monokai",
		name: "Monokai Pro",
		colors: {
			background: "#2d2a2e",
			foreground: "#fcfcfa",
			cursor: "#ffd866",
			black: "#403e41",
			red: "#ff6188",
			green: "#a9dc76",
			yellow: "#ffd866",
			blue: "#78dce8",
			magenta: "#ab9df2",
			cyan: "#78dce8",
			white: "#fcfcfa",
			brightBlack: "#727072",
			brightRed: "#ff6188",
			brightGreen: "#a9dc76",
			brightYellow: "#ffd866",
			brightBlue: "#78dce8",
			brightMagenta: "#ab9df2",
			brightCyan: "#78dce8",
			brightWhite: "#fcfcfa",
		},
	},
];

/** 具体方案的色板；"theme"（跟随界面主题）返回 null，由 token 派生 */
export function schemeColors(id: TerminalSchemeId): SchemeColors | null {
	return TERMINAL_SCHEMES.find((scheme) => scheme.id === id)?.colors ?? null;
}

/** 设置页方案预览用的 5 段色条 */
export function schemeTones(colors: SchemeColors): string[] {
	return [colors.red, colors.green, colors.yellow, colors.blue, colors.magenta];
}
