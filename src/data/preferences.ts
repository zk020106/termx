import { DEFAULT_SFTP_COLUMN_VISIBILITY, normalizeSftpColumnVisibility, type SftpColumnVisibility } from "@/lib/sftpColumns";
import { isAccent, type Accent } from "./types";
import { DEFAULT_KEYWORD_HIGHLIGHT_RULES, normalizeKeywordHighlightRules, type KeywordHighlightRule } from "@/components/terminal/netcatty/keywordHighlightRules";
import type { CustomKeyBindings, HotkeyScheme } from "@/lib/keyBindings";

/* =============================================================================
 * 用户偏好（随配置文件持久化）
 *
 * 与 types.ts 的分工：types.ts 是数据模型（主机、片段、会话…），这里是设置页
 * 那些「会影响真实行为」的偏好。每一项都必须有真实消费方：
 *   终端偏好 → components/terminal/Terminal.tsx（xterm 运行时选项）
 *   安全偏好 → lib/secret.ts（钥匙串）、components/chrome/LockGate.tsx（锁屏）
 *   数据偏好 → ~/.ssh/config 导入
 * 读盘时逐项校验：缺字段或类型不对一律退回默认值，手改坏的配置文件不会炸。
 * ========================================================================== */

export type CursorStyle = "block" | "bar" | "underline";
/** menu = Netcatty context-menu；select-word = Netcatty 的「选择单词」（实为全选，照搬其行为）；select = termx 原有「复制选区」 */
export type RightClickAction = "paste" | "menu" | "select" | "select-word";
/** Netcatty MiddleClickBehavior */
export type MiddleClickAction = "context-menu" | "paste" | "disabled";
/** Netcatty TerminalTabDoubleClickBehavior + termx 原有的 rename（默认） */
export type TabDoubleClickAction = "rename" | "duplicate" | "copy" | "disabled";
export type ScrollbackChoice = "1000" | "5000" | "10000" | "50000" | "unlimited";
export type AutoLockChoice = "never" | "1" | "5" | "15" | "30" | "60";

/** 终端配色方案；theme = 跟随界面主题（由 theme.css 的 token 派生） */
export const TERMINAL_SCHEME_IDS = [
	"theme",
	"one-dark",
	"dracula",
	"solarized",
	"nord",
	"gruvbox",
	"tokyo-night",
	"catppuccin",
	"github-dark",
	"monokai",
] as const;

export type TerminalSchemeId = (typeof TERMINAL_SCHEME_IDS)[number];

export const FONT_FAMILIES: readonly string[] = [
	"JetBrains Mono",
	"Fira Code",
	"Cascadia Code",
	"SF Mono",
	"Menlo",
	"Consolas",
	"Sarasa Mono SC",
];

export const FONT_SIZES: readonly number[] = [11, 12, 13, 14, 15, 16, 18];
export const LINE_HEIGHTS: readonly number[] = [1, 1.2, 1.4, 1.6];
export const SCROLLBACK_CHOICES: readonly ScrollbackChoice[] = ["1000", "5000", "10000", "50000", "unlimited"];
export const CURSOR_STYLES: readonly CursorStyle[] = ["block", "bar", "underline"];
export const RIGHT_CLICK_ACTIONS: readonly RightClickAction[] = ["paste", "menu", "select", "select-word"];
export const MIDDLE_CLICK_ACTIONS: readonly MiddleClickAction[] = ["context-menu", "paste", "disabled"];
export const TAB_DOUBLE_CLICK_ACTIONS: readonly TabDoubleClickAction[] = ["rename", "duplicate", "copy", "disabled"];
export const HOTKEY_SCHEMES: readonly HotkeyScheme[] = ["disabled", "mac", "pc"];
/** Netcatty DEFAULT_TERMINAL_WORD_SEPARATORS */
export const DEFAULT_WORD_SEPARATORS = ' ()[]{}\'"';
export const FONT_WEIGHTS: readonly number[] = [100, 200, 300, 400, 500, 600, 700, 800, 900];
export const AUTO_LOCK_CHOICES: readonly AutoLockChoice[] = ["never", "1", "5", "15", "30", "60"];

export interface TerminalPreferences {
	/** 等宽字体族名；终端里会补上 monospace 兜底 */
	fontFamily: string;
	fontSize: number;
	lineHeight: number;
	scrollback: ScrollbackChoice;
	cursorStyle: CursorStyle;
	/** 输出 BEL 字符时是否发声 */
	bell: boolean;
	rightClick: RightClickAction;
	/** 复制终端选区时去掉末尾换行 */
	trimNewline: boolean;
	scheme: TerminalSchemeId;
	/** 底部内嵌 SFTP 是否随当前活跃终端标签自动切换主机目录 */
	sftpFollowActiveTab: boolean;
	/** 是否开启命令智能补全与预测 (Warp / VS Code 风格) */
	commandSuggestions: boolean;
	/** 是否在光标后呈现行内幽灵文本 (Ghost Text) */
	ghostText: boolean;
	/* ---- 以下移植自 Netcatty TerminalSettings（字段名、默认值一致） ---- */
	middleClick: MiddleClickAction;
	showContextMenuOverFullscreenApps: boolean;
	copyOnSelect: boolean;
	cursorBlink: boolean;
	drawBoldInBrightColors: boolean;
	fontWeight: number;
	fontWeightBold: number;
	minimumContrastRatio: number;
	altAsMeta: boolean;
	wordSeparators: string;
	smoothScrolling: boolean;
	scrollOnInput: boolean;
	disableBracketedPaste: boolean;
	/** Netcatty autoUploadClipboardImageOnPaste：远端会话粘贴时剪贴板图片优先上传（默认关） */
	autoUploadClipboardImageOnPaste: boolean;
	clearWipesScrollback: boolean;
	keywordHighlightEnabled: boolean;
	keywordHighlightRules: KeywordHighlightRule[];
	tabDoubleClick: TabDoubleClickAction;
	hotkeyScheme: HotkeyScheme;
	customKeyBindings: CustomKeyBindings;
	disableTerminalFontZoom: boolean;
	/** SFTP 双击文件：打开 / 传到另一侧（Netcatty sftpDoubleClickBehavior） */
	sftpDoubleClickBehavior: SftpDoubleClickBehavior;
	/** 用外部程序打开的远程文件，保存后自动传回（Netcatty sftpAutoSync） */
	sftpAutoSync: boolean;
	/** 显示以 . 开头的隐藏文件（Netcatty sftpShowHiddenFiles） */
	sftpShowHiddenFiles: boolean;
	/** Netcatty sftpFollowTerminalCwd：侧栏 SFTP 跟随终端 cwd（OSC 7）变化 */
	sftpFollowTerminalCwd: boolean;
	/** 按扩展名记住的打开方式（Netcatty FileOpenerDialog「始终使用此方式打开」） */
	sftpFileOpeners: Record<string, SftpFileOpener>;
	/** SFTP 列表显示哪些列（Netcatty STORAGE_KEY_SFTP_VISIBLE_COLUMNS；名称列恒显示） */
	sftpVisibleColumns: SftpColumnVisibility;
	/** 目录置顶（Netcatty STORAGE_KEY_SFTP_DIRECTORIES_FIRST，默认开） */
	sftpDirectoriesFirst: boolean;
	/** 每台主机记住的视图模式：列表 / 树形（Netcatty STORAGE_KEY_SFTP_HOST_VIEW_MODES；本地栏键为 "local"） */
	sftpHostViewModes: Record<string, "list" | "tree">;
	/** 自定义全局 CSS 样式（实时注入到 document） */
	customCss: string;
	/** 自定义 UI 界面字体 */
	uiFontFamily: string;
	/** 启动时是否恢复未关闭的会话标签页 */
	sessionRestore: boolean;
}

export type SftpDoubleClickBehavior = "open" | "transfer";
export const SFTP_DOUBLE_CLICK_BEHAVIORS: readonly SftpDoubleClickBehavior[] = ["open", "transfer"];

export interface SftpFileOpener {
	type: "builtin-editor" | "system-app";
	app?: { path: string; name: string };
}

/** 解锁密码的校验材料：只存盐与 PBKDF2 摘要，不存密码本身 */
export interface LockVerifier {
	salt: string;
	hash: string;
	iterations: number;
}

export interface SecurityPreferences {
	/** 是否使用系统钥匙串保存密码 */
	keychain: boolean;
	/** 复制敏感字段后自动清空剪贴板 */
	clearClipboard: boolean;
	autoLock: AutoLockChoice;
	startLocked: boolean;
	/** null = 没有设置解锁密码，此时锁屏与自动锁定都不可用 */
	lockVerifier: LockVerifier | null;
}

export interface DataPreferences {
	sshConfigPath: string;
}

export interface Preferences {
	accent: Accent;
	terminal: TerminalPreferences;
	security: SecurityPreferences;
	data: DataPreferences;
}

/** 默认值与改造前的写死行为一致，避免升级后观感突变 */
export const DEFAULT_TERMINAL: TerminalPreferences = {
	fontFamily: "JetBrains Mono",
	fontSize: 12,
	lineHeight: 1.6,
	scrollback: "5000",
	cursorStyle: "bar",
	bell: true,
	rightClick: "menu",
	trimNewline: true,
	scheme: "theme",
	sftpFollowActiveTab: true,
	commandSuggestions: true,
	ghostText: true,
	middleClick: "paste",
	showContextMenuOverFullscreenApps: false,
	copyOnSelect: false,
	cursorBlink: true,
	drawBoldInBrightColors: true,
	fontWeight: 400,
	fontWeightBold: 700,
	minimumContrastRatio: 1,
	altAsMeta: false,
	wordSeparators: DEFAULT_WORD_SEPARATORS,
	smoothScrolling: false,
	scrollOnInput: true,
	disableBracketedPaste: false,
	autoUploadClipboardImageOnPaste: false,
	clearWipesScrollback: true,
	keywordHighlightEnabled: true,
	keywordHighlightRules: DEFAULT_KEYWORD_HIGHLIGHT_RULES.map((rule) => ({ ...rule, patterns: [...rule.patterns] })),
	tabDoubleClick: "rename",
	hotkeyScheme: defaultHotkeyScheme(),
	customKeyBindings: {},
	disableTerminalFontZoom: false,
	sftpDoubleClickBehavior: "open",
	sftpAutoSync: false,
	sftpShowHiddenFiles: false,
	sftpFollowTerminalCwd: false,
	sftpFileOpeners: {},
	sftpVisibleColumns: { ...DEFAULT_SFTP_COLUMN_VISIBILITY },
	sftpDirectoriesFirst: true,
	sftpHostViewModes: {},
	customCss: "",
	uiFontFamily: "",
	sessionRestore: true,
};

export const DEFAULT_SECURITY: SecurityPreferences = {
	keychain: true,
	clearClipboard: true,
	autoLock: "never",
	startLocked: false,
	lockVerifier: null,
};

export const DEFAULT_DATA: DataPreferences = {
	sshConfigPath: "~/.ssh/config",
};

export const DEFAULT_PREFERENCES: Preferences = {
	accent: "indigo",
	terminal: DEFAULT_TERMINAL,
	security: DEFAULT_SECURITY,
	data: DEFAULT_DATA,
};

/** 回滚行数 → xterm 的 scrollback（不限制用 Infinity，xterm 支持） */
export function scrollbackLines(choice: ScrollbackChoice): number {
	return choice === "unlimited" ? Number.POSITIVE_INFINITY : Number(choice);
}

/** 字体族名 → xterm 的 fontFamily（补 monospace 兜底，缺字形也能退到系统字体） */
export function fontStack(family: string): string {
	return `"${family}", ui-monospace, monospace`;
}

/** 闲置自动锁定的毫秒数；never 返回 null */
export function autoLockMs(choice: AutoLockChoice): number | null {
	return choice === "never" ? null : Number(choice) * 60_000;
}

/** Netcatty 按平台给默认方案：macOS 用 ⌘，其它用 Ctrl */
function defaultHotkeyScheme(): HotkeyScheme {
	if (typeof navigator === "undefined") return "pc";
	return /mac/i.test(`${navigator.userAgent} ${navigator.platform ?? ""}`) ? "mac" : "pc";
}

function pickRange(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function normalizeCustomKeyBindings(value: unknown): CustomKeyBindings {
	if (!value || typeof value !== "object") return {};
	const out: CustomKeyBindings = {};
	for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object") continue;
		const { mac, pc } = raw as { mac?: unknown; pc?: unknown };
		const entry: { mac?: string; pc?: string } = {};
		if (typeof mac === "string") entry.mac = mac;
		if (typeof pc === "string") entry.pc = pc;
		if (entry.mac !== undefined || entry.pc !== undefined) out[id] = entry;
	}
	return out;
}

function normalizeHighlightRules(value: unknown): KeywordHighlightRule[] {
	if (!Array.isArray(value)) return normalizeKeywordHighlightRules(undefined);
	const rules = value.filter(
		(rule): rule is KeywordHighlightRule =>
			Boolean(rule) &&
			typeof rule === "object" &&
			typeof (rule as KeywordHighlightRule).id === "string" &&
			typeof (rule as KeywordHighlightRule).label === "string" &&
			typeof (rule as KeywordHighlightRule).color === "string" &&
			typeof (rule as KeywordHighlightRule).enabled === "boolean" &&
			Array.isArray((rule as KeywordHighlightRule).patterns) &&
			(rule as KeywordHighlightRule).patterns.every((p) => typeof p === "string"),
	);
	return normalizeKeywordHighlightRules(rules);
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickNumber(value: unknown, allowed: readonly number[], fallback: number): number {
	return typeof value === "number" && allowed.includes(value) ? value : fallback;
}

function normalizeHostViewModes(value: unknown): Record<string, "list" | "tree"> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, "list" | "tree"> = {};
	for (const [key, mode] of Object.entries(value as Record<string, unknown>)) {
		if (key && key.length <= 256 && (mode === "list" || mode === "tree")) out[key] = mode;
	}
	return out;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function pickText(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function normalizeVerifier(value: unknown): LockVerifier | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Partial<LockVerifier>;
	if (typeof raw.salt !== "string" || typeof raw.hash !== "string") return null;
	if (raw.salt === "" || raw.hash === "") return null;
	return {
		salt: raw.salt,
		hash: raw.hash,
		iterations: typeof raw.iterations === "number" && raw.iterations > 0 ? raw.iterations : 120_000,
	};
}

/** 磁盘上的 preferences 可能是老版本（只有 accent）或手改坏的，全部逐项兜底 */
export function normalizePreferences(raw: unknown): Preferences {
	const source = (raw ?? {}) as Partial<Preferences> & { terminal?: unknown; security?: unknown; data?: unknown };
	const terminal = (source.terminal ?? {}) as Partial<TerminalPreferences>;
	const security = (source.security ?? {}) as Partial<SecurityPreferences>;
	const data = (source.data ?? {}) as Partial<DataPreferences>;

	return {
		accent: isAccent(source.accent) ? source.accent : DEFAULT_PREFERENCES.accent,
		terminal: {
			fontFamily: pickText(terminal.fontFamily, DEFAULT_TERMINAL.fontFamily),
			fontSize: pickNumber(terminal.fontSize, FONT_SIZES, DEFAULT_TERMINAL.fontSize),
			lineHeight: pickNumber(terminal.lineHeight, LINE_HEIGHTS, DEFAULT_TERMINAL.lineHeight),
			scrollback: pick(terminal.scrollback, SCROLLBACK_CHOICES, DEFAULT_TERMINAL.scrollback),
			cursorStyle: pick(terminal.cursorStyle, CURSOR_STYLES, DEFAULT_TERMINAL.cursorStyle),
			bell: pickBoolean(terminal.bell, DEFAULT_TERMINAL.bell),
			rightClick: pick(terminal.rightClick, RIGHT_CLICK_ACTIONS, DEFAULT_TERMINAL.rightClick),
			trimNewline: pickBoolean(terminal.trimNewline, DEFAULT_TERMINAL.trimNewline),
			scheme: pick(terminal.scheme, TERMINAL_SCHEME_IDS, DEFAULT_TERMINAL.scheme),
			sftpFollowActiveTab: pickBoolean(terminal.sftpFollowActiveTab, DEFAULT_TERMINAL.sftpFollowActiveTab),
			commandSuggestions: pickBoolean(terminal.commandSuggestions, DEFAULT_TERMINAL.commandSuggestions),
			ghostText: pickBoolean(terminal.ghostText, DEFAULT_TERMINAL.ghostText),
			middleClick: pick(terminal.middleClick, MIDDLE_CLICK_ACTIONS, DEFAULT_TERMINAL.middleClick),
			showContextMenuOverFullscreenApps: pickBoolean(terminal.showContextMenuOverFullscreenApps, DEFAULT_TERMINAL.showContextMenuOverFullscreenApps),
			copyOnSelect: pickBoolean(terminal.copyOnSelect, DEFAULT_TERMINAL.copyOnSelect),
			cursorBlink: pickBoolean(terminal.cursorBlink, DEFAULT_TERMINAL.cursorBlink),
			drawBoldInBrightColors: pickBoolean(terminal.drawBoldInBrightColors, DEFAULT_TERMINAL.drawBoldInBrightColors),
			fontWeight: pickNumber(terminal.fontWeight, FONT_WEIGHTS, DEFAULT_TERMINAL.fontWeight),
			fontWeightBold: pickNumber(terminal.fontWeightBold, FONT_WEIGHTS, DEFAULT_TERMINAL.fontWeightBold),
			minimumContrastRatio: pickRange(terminal.minimumContrastRatio, 1, 21, DEFAULT_TERMINAL.minimumContrastRatio),
			altAsMeta: pickBoolean(terminal.altAsMeta, DEFAULT_TERMINAL.altAsMeta),
			wordSeparators: typeof terminal.wordSeparators === "string" ? terminal.wordSeparators : DEFAULT_TERMINAL.wordSeparators,
			smoothScrolling: pickBoolean(terminal.smoothScrolling, DEFAULT_TERMINAL.smoothScrolling),
			scrollOnInput: pickBoolean(terminal.scrollOnInput, DEFAULT_TERMINAL.scrollOnInput),
			disableBracketedPaste: pickBoolean(terminal.disableBracketedPaste, DEFAULT_TERMINAL.disableBracketedPaste),
			autoUploadClipboardImageOnPaste: pickBoolean(terminal.autoUploadClipboardImageOnPaste, DEFAULT_TERMINAL.autoUploadClipboardImageOnPaste),
			clearWipesScrollback: pickBoolean(terminal.clearWipesScrollback, DEFAULT_TERMINAL.clearWipesScrollback),
			keywordHighlightEnabled: pickBoolean(terminal.keywordHighlightEnabled, DEFAULT_TERMINAL.keywordHighlightEnabled),
			keywordHighlightRules: normalizeHighlightRules(terminal.keywordHighlightRules),
			tabDoubleClick: pick(terminal.tabDoubleClick, TAB_DOUBLE_CLICK_ACTIONS, DEFAULT_TERMINAL.tabDoubleClick),
			hotkeyScheme: pick(terminal.hotkeyScheme, HOTKEY_SCHEMES, DEFAULT_TERMINAL.hotkeyScheme),
			customKeyBindings: normalizeCustomKeyBindings(terminal.customKeyBindings),
			disableTerminalFontZoom: pickBoolean(terminal.disableTerminalFontZoom, DEFAULT_TERMINAL.disableTerminalFontZoom),
			sftpDoubleClickBehavior: pick(terminal.sftpDoubleClickBehavior, SFTP_DOUBLE_CLICK_BEHAVIORS, DEFAULT_TERMINAL.sftpDoubleClickBehavior),
			sftpAutoSync: pickBoolean(terminal.sftpAutoSync, DEFAULT_TERMINAL.sftpAutoSync),
			sftpShowHiddenFiles: pickBoolean(terminal.sftpShowHiddenFiles, DEFAULT_TERMINAL.sftpShowHiddenFiles),
			sftpFollowTerminalCwd: pickBoolean(terminal.sftpFollowTerminalCwd, DEFAULT_TERMINAL.sftpFollowTerminalCwd),
			sftpFileOpeners: normalizeFileOpeners(terminal.sftpFileOpeners),
			sftpVisibleColumns: normalizeSftpColumnVisibility(terminal.sftpVisibleColumns),
			sftpDirectoriesFirst: pickBoolean(terminal.sftpDirectoriesFirst, DEFAULT_TERMINAL.sftpDirectoriesFirst),
			sftpHostViewModes: normalizeHostViewModes(terminal.sftpHostViewModes),
			customCss: typeof terminal.customCss === "string" ? terminal.customCss : DEFAULT_TERMINAL.customCss,
			uiFontFamily: typeof terminal.uiFontFamily === "string" ? terminal.uiFontFamily : DEFAULT_TERMINAL.uiFontFamily,
			sessionRestore: pickBoolean(terminal.sessionRestore, DEFAULT_TERMINAL.sessionRestore),
		},
		security: {
			keychain: pickBoolean(security.keychain, DEFAULT_SECURITY.keychain),
			clearClipboard: pickBoolean(security.clearClipboard, DEFAULT_SECURITY.clearClipboard),
			autoLock: pick(security.autoLock, AUTO_LOCK_CHOICES, DEFAULT_SECURITY.autoLock),
			startLocked: pickBoolean(security.startLocked, DEFAULT_SECURITY.startLocked),
			lockVerifier: normalizeVerifier(security.lockVerifier),
		},
		data: {
			sshConfigPath: pickText(data.sshConfigPath, DEFAULT_DATA.sshConfigPath),
		},
	};
}

function normalizeFileOpeners(value: unknown): Record<string, SftpFileOpener> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, SftpFileOpener> = {};
	for (const [ext, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object") continue;
		const r = raw as { type?: unknown; app?: { path?: unknown; name?: unknown } };
		if (r.type === "builtin-editor") out[ext.toLowerCase()] = { type: "builtin-editor" };
		else if (r.type === "system-app" && r.app && typeof r.app.path === "string" && r.app.path) {
			out[ext.toLowerCase()] = {
				type: "system-app",
				app: { path: r.app.path, name: typeof r.app.name === "string" ? r.app.name : r.app.path },
			};
		}
	}
	return out;
}
