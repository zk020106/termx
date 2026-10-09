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
	/**
	 * 只出现在「生效主机」上（store/hosts.ts 由 lib/groupConfig.ts 算出，不落盘）：
	 * 凭据来自身份 / 分组时，密码在钥匙串里的账户（`identity:<id>` / `group:<id>`）。
	 */
	secretAccount?: string;
	/** 只出现在生效主机上：凭据来自哪里（界面提示用） */
	credentialSource?: "host" | "identity" | "group";
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
	/** command = ProxyCommand（Netcatty proxyConfig.type === 'command'） */
	type: "socks5" | "http" | "command";
	host: string;
	port: number;
	/** ProxyCommand 模板：%h 目标主机、%p 目标端口、%% 字面百分号 */
	command?: string;
	/**
	 * 用钥匙串身份作为代理凭据（Netcatty「钥匙串身份」/ ProxyConfig.identityId）：
	 * 用户名取身份的用户名，口令取钥匙串 `identity:<id>`；与手填用户名二选一。
	 */
	identityId?: string;
	/**
	 * 代理认证（可选）：SOCKS5 用户名/口令（RFC 1929）或 HTTP Basic。
	 * 口令存系统钥匙串（账户名 `proxy:<主机 id>`），不进配置文件。
	 */
	username?: string;
}

/**
 * 可复用的代理配置（Netcatty domain/models/connection.ts ProxyProfile）。
 * 主机通过 proxyProfileId 引用；口令存系统钥匙串（账户名 `proxy-profile:<id>`），不进配置文件。
 */
export interface ProxyProfile {
	id: string;
	label: string;
	config: ProxyConfig;
	createdAt: number;
	updatedAt?: number;
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
	/** 置顶（Netcatty「置顶 / 取消置顶」）：在主机列表最上方单独成组 */
	pinned?: boolean;
	/** 首次连接后识别到的发行版 */
	os?: { name: string; icon: string };
	/** 规格描述，例如 8C 32G · 华东1 */
	spec?: string;
	auth: HostAuth;
	/** 跳板链，按顺序逐跳（P0） */
	jumpHostIds: string[];
	proxy?: ProxyConfig | null;
	/** 引用已保存的代理配置（与 proxy 互斥，同 Netcatty proxyProfileId / proxyConfig） */
	proxyProfileId?: string;
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
	/**
	 * 私钥在本机密钥库里（Netcatty SSHKey.privateKey）。私钥本体由 Rust 信封加密保存
	 * （数据密钥在系统钥匙串），配置文件里只有这个标记。
	 */
	hasPrivateKey?: boolean;
	/** Netcatty source：generated / imported（只导入了公钥的是 public） */
	source?: "generated" | "imported" | "public";
	/** 口令记在系统钥匙串里（Netcatty savePassphrase） */
	savePassphrase?: boolean;
}

/* ------------------------------- 身份 ------------------------------- */

/**
 * 钥匙串身份（Netcatty domain/models/connection.ts Identity）：用户名 + 密码或密钥的组合，
 * 主机 / 分组 / 代理都可以引用。密码存系统钥匙串（账户 `identity:<id>`），不进配置文件。
 */
export interface Identity {
	id: string;
	label: string;
	username: string;
	authMethod: "password" | "key";
	keyId?: string;
	/** 钥匙串里存了密码 */
	hasPassword?: boolean;
	created: number;
}

/* ------------------------------- 分组设置 ------------------------------- */

/**
 * 分组默认值（Netcatty GroupConfig）。Netcatty 用分组路径做键，TermX 的分组有 id/parentId，
 * 所以用 groupId 做键、按 parentId 链从根到叶合并（子分组覆盖父分组）。
 * 密码存系统钥匙串（账户 `group:<groupId>`），配置文件里只有 hasPassword 标记。
 */
export interface GroupConfig {
	groupId: string;
	username?: string;
	authMethod?: AuthMethod;
	hasPassword?: boolean;
	identityId?: string;
	/** Netcatty identityFileId：钥匙串里的密钥 */
	keyId?: string;
	/** Netcatty identityFilePaths：本地私钥文件 */
	keyPath?: string;
	port?: number;
	proxyProfileId?: string;
	proxyConfig?: ProxyConfig;
	/** Netcatty hostChain.hostIds */
	jumpHostIds?: string[];
	startupCommand?: string;
	environmentVariables?: { key: string; value: string }[];
	charset?: string;
	termType?: string;
	theme?: string;
	themeOverride?: boolean;
	fontFamily?: string;
	fontFamilyOverride?: boolean;
	fontSize?: number;
	fontSizeOverride?: boolean;
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
	/** 快捷键（Netcatty snippet.shortkey）：在终端里按下即发送这条命令 */
	shortkey?: string;
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
