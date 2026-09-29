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
	identityId?: string;
	/** 密码是否记住，默认不勾选（需求书 07-连接流程） */
	rememberPassword?: boolean;
}

export interface HostTerminalPrefs {
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

export type ForwardState = "running" | "stopped" | "error";

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
	hostId: string | null;
	title: string;
	subtitle?: string;
	status: ConnectionStatus;
	lines: TerminalLine[];
}

export interface SessionTab {
	id: string;
	hostId: string | null;
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
