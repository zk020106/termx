/* =============================================================================
 * TermX 领域模型（骨架版）
 *
 * 这份文件是所有界面共用的契约：界面只依赖这里导出的类型，不各自造结构。
 * 字段取舍依据 termx-design-brief 「05 功能清单」的 P0/P1 项。
 * ========================================================================== */

/** 连接状态：标签、主机库、状态栏三处共用同一套语义（需求书 07-连接状态） */
export type ConnectionStatus =
	| "idle"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "disconnected"
	| "failed";

export const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
	idle: "未连接",
	connecting: "连接中",
	connected: "已连接",
	reconnecting: "重连中",
	disconnected: "已断开",
	failed: "连接失败",
};

/* ------------------------------- 主机库 ------------------------------- */

export interface HostGroup {
	id: string;
	name: string;
	parentId: string | null;
	expanded?: boolean;
}

export type AuthMethod = "password" | "key" | "key-passphrase" | "agent" | "keyboard-interactive";

export const AUTH_LABEL: Record<AuthMethod, string> = {
	password: "密码",
	key: "私钥",
	"key-passphrase": "私钥 + 口令",
	agent: "SSH Agent",
	"keyboard-interactive": "键盘交互（二次验证）",
};

export interface HostAuth {
	method: AuthMethod;
	keyId?: string;
	keyPath?: string;
	identityId?: string;
	/**
	 * 密码是否记住。记住的密码**只存系统钥匙串**（lib/secret.ts，账户名为主机 id），
	 * 绝不写进 termx.json / 导出文件；旧版本留在配置里的明文会在启动时迁走（lib/configSecrets.ts）。
	 */
	rememberPassword?: boolean;
}

export interface HostTerminalPrefs {
	/**
	 * 用户确实在「终端外观」里改过这台主机的外观：只有这时才覆盖全局终端设置。
	 * （主机编辑会给每台主机都写一份默认外观，没有这个标记就分不清是默认值还是用户选的）
	 */
	custom?: boolean;
	colorScheme?: string;
	fontFamily?: string;
	fontSize?: number;
	lineHeight?: number;
	cursorStyle?: "block" | "bar" | "underline";
}

export interface ProxyConfig {
	type: "socks5" | "http";
	host: string;
	port: number;
	/**
	 * 代理认证（可选）：SOCKS5 用户名/口令（RFC 1929）或 HTTP Basic。
	 * 口令存系统钥匙串（账户名 `proxy:<主机 id>`），不进配置文件。
	 */
	username?: string;
}

export interface Host {
	id: string;
	name: string;
	groupId: string | null;
	hostname: string;
	port: number;
	username: string;
	tags: string[];
	favorite: boolean;
	/** 首次连接后识别到的发行版 */
	os?: { name: string; icon: string };
	/** 规格描述，例如 8C 32G · 华东1 */
	spec?: string;
	auth: HostAuth;
	/** 跳板链，按顺序逐跳（P0） */
	jumpHostIds: string[];
	proxy?: ProxyConfig | null;
	encoding?: string;
	termType?: string;
	envVars?: { key: string; value: string }[];
	/** 登录后自动执行的命令 */
	loginScript?: string;
	terminal?: HostTerminalPrefs;
	lastConnectedAt?: string;
	latencyMs?: number;
	reachable: boolean;
}

/* ------------------------------- 密钥库 ------------------------------- */

export type KeyType = "ed25519" | "rsa" | "ecdsa";

export interface SshKey {
	id: string;
	name: string;
	type: KeyType;
	bits?: number;
	fingerprint: string;
	publicKey: string;
	comment?: string;
	createdAt: string;
	/** 已部署到哪些主机 */
	deployedTo: string[];
	hasPassphrase: boolean;
}

/* ------------------------------ 命令片段 ------------------------------ */

export interface Snippet {
	id: string;
	name: string;
	group: string;
	command: string;
	/** 形如 ${service} 的占位变量 */
	variables: string[];
	description?: string;
}

export type SnippetTarget = "current" | "selected" | "all";

export const SNIPPET_TARGET_LABEL: Record<SnippetTarget, string> = {
	current: "当前终端",
	selected: "选中的终端",
	all: "全部终端",
};

/* ------------------------------ 端口转发 ------------------------------ */

export type ForwardType = "local" | "remote" | "dynamic";

export const FORWARD_LABEL: Record<ForwardType, string> = {
	local: "本地 -L",
	remote: "远程 -R",
	dynamic: "动态 SOCKS5 -D",
};

/** starting 只存在于运行期（落盘时归为 stopped） */
export type ForwardState = "starting" | "running" | "stopped" | "error";

export interface ForwardRule {
	id: string;
	name: string;
	hostId: string;
	type: ForwardType;
	bindAddress: string;
	bindPort: number;
	/** -L / -R 的目标；-D 时为 null */
	targetHost: string | null;
	targetPort: number | null;
	autoStart: boolean;
	state: ForwardState;
	connections: number;
	trafficIn: number;
	trafficOut: number;
	error?: string;
}

/* ------------------------------- 传输队列 ------------------------------ */

export type TransferState = "queued" | "running" | "paused" | "failed" | "done";

export interface Transfer {
	id: string;
	name: string;
	direction: "upload" | "download";
	hostId: string;
	localPath: string;
	remotePath: string;
	size: number;
	transferred: number;
	speedBps: number;
	state: TransferState;
	etaSec?: number;
	error?: string;
	/** 同名冲突处理策略 */
	conflict?: "overwrite" | "skip" | "rename";
	/* ---- 以下为运行期字段（不落盘） ---- */
	/** 发起传输所用的会话键（重试 / 续传要用） */
	sessionKey?: string;
	/** 等用户决定的同名冲突（两侧文件的真实信息） */
	pendingConflict?: TransferConflict;
	/** 已传完、正在远端复算 SHA-256 */
	verifying?: boolean;
	/** 本地计算的 SHA-256（传完后） */
	sha256?: string;
	/** true 远端复算一致；false 不一致；null 未能比对 */
	verified?: boolean | null;
	verifyNote?: string;
	/** 累计实际传输耗时（毫秒，不含暂停与排队） */
	activeMs?: number;
	/** 本次运行开始的时间戳（毫秒） */
	runStartedAt?: number;
	/** 本次运行开始时已有的字节数（续传起点），用于算平均速度 */
	runStartBytes?: number;
	/** 最近的吞吐采样（字节/秒，约每秒一个，最多 16 个） */
	samples?: number[];
}

export interface TransferSideInfo {
	exists: boolean;
	isDir: boolean;
	size: number;
	/** 秒 */
	mtime: number;
}

export interface TransferConflict {
	source: TransferSideInfo;
	target: TransferSideInfo;
	/** 目标旁边上次未完成的部分文件大小（0 = 没有） */
	partial: number;
}

/* ------------------------------- SFTP ------------------------------- */

export type FileKind = "file" | "dir" | "link";

export interface FileEntry {
	name: string;
	kind: FileKind;
	size: number;
	/** 展示用的时间串，例如 09-23 14:12 */
	mtime: string;
	/** 权限串，例如 drwxr-xr-x */
	mode: string;
	owner?: string;
}

/* ------------------------------ 终端工作区 ----------------------------- */

export type SplitLayout = "single" | "horizontal" | "vertical" | "grid";

export interface TerminalLine {
	kind: "input" | "info" | "warn" | "error" | "ok" | "plain";
	text: string;
}

export interface TerminalPane {
	id: string;
	/**
	 * 所属标签。分屏格按**标签**归属，而不是按主机归属：
	 * 同一台主机可以有多条会话（多个标签），按主机归属会让关掉一个标签
	 * 把另一个标签的格子一起清掉。
	 */
	tabId: string | null;
	hostId: string | null;
	/**
	 * 本格接的 SSH 会话键（每次连接一个，见 sshCache 的 newSshSessionKey）。
	 * null = 本地 PTY，或者这台主机还没有建立会话（界面会如实说明）。
	 */
	sessionKey: string | null;
	title: string;
	subtitle?: string;
	status: ConnectionStatus;
	lines: TerminalLine[];
}

export interface SessionTab {
	id: string;
	hostId: string | null;
	/**
	 * 本标签占用的 SSH 会话键；null = 本地终端。
	 * 会话身份是**键**不是主机：同一台主机的两个标签各有一个键、两条独立连接。
	 */
	sessionKey: string | null;
	title: string;
	status: ConnectionStatus;
	latencyMs?: number;
	layout: SplitLayout;
	/** 广播输入是否命中此标签（需求书 07-生产防误操作） */
	broadcasting: boolean;
	dirty?: boolean;
}

/* ------------------------------ 连接过程 ------------------------------ */

export type StepState = "pending" | "active" | "done" | "failed";

export interface ConnectionStep {
	id: string;
	label: string;
	state: StepState;
	detail?: string;
}

/* ------------------------------- 监控 ------------------------------- */

export interface MetricSeries {
	label: string;
	value: number;
	max: number;
	unit: string;
	samples: number[];
	threshold?: number;
}

export interface ProcessRow {
	pid: number;
	command: string;
	cpu: number;
	mem: number;
	user?: string;
}

/* ------------------------------ 命令面板 ------------------------------ */

export type CommandGroup = "host" | "command" | "setting" | "recent";

export interface CommandItem {
	id: string;
	group: CommandGroup;
	title: string;
	subtitle?: string;
	icon?: string;
	shortcut?: string;
	keywords?: string[];
}

/* ------------------------------- 编辑器 ------------------------------- */

export interface EditorTab {
	id: string;
	path: string;
	hostId: string;
	lines: { num: number; text: string; type?: "comment" | "key" | "string" | "number" | "pair" }[];
	modified: boolean;
	conflict?: boolean;
}

/* ------------------------------- 更新 ------------------------------- */

export interface ReleaseNote {
	version: string;
	date: string;
	items: string[];
	current?: boolean;
}

export interface UpdateInfo {
	currentVersion: string;
	latestVersion: string;
	sizeText: string;
	channel: "stable" | "beta";
	releases: ReleaseNote[];
}

/* ------------------------------- 外观设置 ------------------------------ */

export type ThemeMode = "dark" | "light" | "system";
export type Density = "compact" | "standard";

/** 强调色：六套预置色板，id 与 theme.css 里的 --tx-swatch-* 一一对应 */
export type Accent = "indigo" | "cyan" | "emerald" | "amber" | "rose" | "steel";

export const ACCENT_IDS: readonly Accent[] = ["indigo", "cyan", "emerald", "amber", "rose", "steel"];

/** 配置文件里读回来的 accent 可能是任意值（手改过 / 旧版本），校验后再用 */
export function isAccent(value: unknown): value is Accent {
	return typeof value === "string" && (ACCENT_IDS as readonly string[]).includes(value);
}
