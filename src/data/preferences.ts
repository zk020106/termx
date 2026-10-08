import { isAccent, type Accent } from "./types";

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
export type RightClickAction = "paste" | "menu" | "select";
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
export const RIGHT_CLICK_ACTIONS: readonly RightClickAction[] = ["paste", "menu", "select"];
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

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickNumber(value: unknown, allowed: readonly number[], fallback: number): number {
	return typeof value === "number" && allowed.includes(value) ? value : fallback;
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
