import type { ForwardRule, GroupConfig, Host, HostGroup, Identity, ProxyProfile, Snippet, SshKey } from "@/data/types";
import { normalizePreferences, type Preferences } from "@/data/preferences";
import { stripHostSecrets } from "./configSecrets";
import { isTauri } from "./tauri";

/* =============================================================================
 * 配置持久化
 *
 * 桌面端：写进操作系统给应用的配置目录（Windows 上是
 *         %APPDATA%\dev.termx.app\termx.json），由 Rust 侧原子写入。
 * 浏览器：退化为 localStorage，语义一致（同样是本机持久化），便于纯前端调试。
 *
 * 只存用户自己的东西：主机、分组、密钥、片段、转发规则、界面与终端偏好。
 * 凭据类机密（密码、私钥口令）不进这个文件，交操作系统钥匙串。
 * ========================================================================== */

export interface PersistedConfig {
	version: 1;
	hosts: Host[];
	groups: HostGroup[];
	keys: SshKey[];
	snippets: Snippet[];
	forwards: ForwardRule[];
	/** 可复用代理配置（Netcatty「代理」）；口令不在这里 */
	proxyProfiles: ProxyProfile[];
	/** 钥匙串身份（Netcatty identities）；密码只在钥匙串 */
	identities: Identity[];
	/** 分组设置（Netcatty groupConfigs）；密码只在钥匙串 */
	groupConfigs: GroupConfig[];
	preferences: Preferences;
}

export function emptyConfig(): PersistedConfig {
	return {
		version: 1,
		hosts: [],
		groups: [],
		keys: [],
		snippets: [],
		forwards: [],
		proxyProfiles: [],
		identities: [],
		groupConfigs: [],
		// 每次都给一份全新的默认偏好，避免共享对象被就地改坏
		preferences: normalizePreferences(null),
	};
}

const LS_KEY = "termx.config";

/** 已知的顶层字段；其余字段（更新版本写入的新字段）原样保留，写回时不丢 */
const KNOWN_FIELDS = new Set(["version", "hosts", "groups", "keys", "snippets", "forwards", "proxyProfiles", "identities", "groupConfigs", "preferences"]);
let unknownFields: Record<string, unknown> = {};

/** 后端在「配置文件解析失败但已备份」时返回的错误前缀（见 src-tauri/src/config.rs） */
export const CORRUPT_PREFIX = "CORRUPT_BACKED_UP:";

export type ConfigLoadIssue =
	| { kind: "corrupt"; backupPath: string; message: string }
	| { kind: "failed"; message: string }
	| { kind: "newer"; version: number };

/** 解析 config_load 的错误：区分「已备份的损坏文件」与其他读失败 */
export function classifyLoadError(error: unknown): ConfigLoadIssue {
	const text = error instanceof Error ? error.message : String(error);
	if (text.startsWith(CORRUPT_PREFIX)) {
		const rest = text.slice(CORRUPT_PREFIX.length);
		const newline = rest.indexOf("\n");
		return {
			kind: "corrupt",
			backupPath: newline < 0 ? rest : rest.slice(0, newline),
			message: newline < 0 ? "配置文件解析失败" : rest.slice(newline + 1),
		};
	}
	return { kind: "failed", message: text };
}

/** 运行期状态不落盘：转发规则重启后一律从「已停止」开始，计数清零 */
export function persistableForward(rule: ForwardRule): ForwardRule {
	const state = rule.state === "running" || rule.state === "starting" ? "stopped" : rule.state;
	return { ...rule, state, connections: 0, trafficIn: 0, trafficOut: 0 };
}

function isProxyProfile(value: unknown): value is ProxyProfile {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<ProxyProfile>;
	return (
		typeof v.id === "string" &&
		typeof v.label === "string" &&
		!!v.config &&
		(v.config.type === "socks5" || v.config.type === "http" || v.config.type === "command") &&
		typeof v.config.host === "string" &&
		typeof v.config.port === "number"
	);
}

/** 代理配置里不允许留明文口令（只在钥匙串） */
function stripProfileSecret(profile: ProxyProfile): ProxyProfile {
	const { password: _password, ...config } = profile.config as ProxyProfile["config"] & { password?: unknown };
	return { ...profile, config };
}

function isIdentity(value: unknown): value is Identity {
	const v = value as Partial<Identity> | null;
	return !!v && typeof v.id === "string" && typeof v.label === "string" && typeof v.username === "string";
}

/** 身份 / 分组设置里不允许留明文密码（只在钥匙串） */
function stripIdentitySecret(identity: Identity): Identity {
	const { password: _p, ...rest } = identity as Identity & { password?: unknown };
	return { ...rest, authMethod: rest.authMethod === "key" ? "key" : "password" };
}

function stripGroupConfigSecret(config: GroupConfig): GroupConfig {
	const { password: _p, ...rest } = config as GroupConfig & { password?: unknown };
	if (rest.proxyConfig) {
		const { password: _pp, ...proxy } = rest.proxyConfig as GroupConfig["proxyConfig"] & { password?: unknown };
		return { ...rest, proxyConfig: proxy as GroupConfig["proxyConfig"] };
	}
	return rest;
}

/** 把读到的对象补齐成完整结构，旧文件缺字段也不至于炸（导入配置时也用它） */
export function normalizeConfig(raw: Partial<PersistedConfig> | null): PersistedConfig {
	const base = emptyConfig();
	if (!raw) return base;
	return {
		version: 1,
		hosts: Array.isArray(raw.hosts) ? raw.hosts : [],
		groups: Array.isArray(raw.groups) ? raw.groups : [],
		keys: Array.isArray(raw.keys) ? raw.keys : [],
		snippets: Array.isArray(raw.snippets) ? raw.snippets : [],
		forwards: Array.isArray(raw.forwards) ? raw.forwards.map(persistableForward) : [],
		proxyProfiles: Array.isArray(raw.proxyProfiles) ? raw.proxyProfiles.filter(isProxyProfile).map(stripProfileSecret) : [],
		identities: Array.isArray(raw.identities) ? raw.identities.filter(isIdentity).map(stripIdentitySecret) : [],
		groupConfigs: Array.isArray(raw.groupConfigs)
			? raw.groupConfigs.filter((c): c is GroupConfig => !!c && typeof (c as GroupConfig).groupId === "string").map(stripGroupConfigSecret)
			: [],
		// 偏好逐项校验：老配置文件只有 accent，也能补齐成完整结构
		preferences: normalizePreferences(raw.preferences),
	};
}

/** 记下读到的未知顶层字段，saveConfig 时合并回去 */
export function rememberUnknownFields(raw: unknown): void {
	unknownFields = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
	for (const [key, value] of Object.entries(raw)) {
		if (!KNOWN_FIELDS.has(key)) unknownFields[key] = value;
	}
}

/** 原始配置里的版本号（更高版本写的文件，本版本不应覆盖） */
export function rawVersion(raw: unknown): number | null {
	if (!raw || typeof raw !== "object") return null;
	const v = (raw as { version?: unknown }).version;
	return typeof v === "number" ? v : null;
}

export async function loadRawConfig(): Promise<unknown> {
	if (isTauri()) {
		const { invoke } = await import("@tauri-apps/api/core");
		return invoke<unknown>("config_load");
	}
	const text = localStorage.getItem(LS_KEY);
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch (error) {
		// 浏览器预览：同样不覆盖坏数据，先挪到旁边
		const backup = `${LS_KEY}.corrupt-${Date.now()}`;
		localStorage.setItem(backup, text);
		throw new Error(`${CORRUPT_PREFIX}localStorage:${backup}\n配置解析失败：${String(error)}`);
	}
}

export async function loadConfig(): Promise<PersistedConfig> {
	const raw = await loadRawConfig();
	rememberUnknownFields(raw);
	return normalizeConfig(raw as Partial<PersistedConfig> | null);
}

export async function saveConfig(config: PersistedConfig): Promise<void> {
	// 兜底：无论调用方传进来什么，落盘的配置里都不带密码（Rust 侧 config_save 还会再剥一次）
	const data = {
		...unknownFields,
		...config,
		hosts: stripHostSecrets(config.hosts).hosts,
		forwards: config.forwards.map(persistableForward),
		proxyProfiles: config.proxyProfiles.map(stripProfileSecret),
		identities: config.identities.map(stripIdentitySecret),
		groupConfigs: config.groupConfigs.map(stripGroupConfigSecret),
	};
	if (isTauri()) {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("config_save", { data });
		return;
	}

	try {
		localStorage.setItem(LS_KEY, JSON.stringify(data));
	} catch {
		/* 隐私模式下写不了就只在内存里存活 */
	}
}

/** 配置文件的真实路径（浏览器里为 null），设置页展示用 */
export async function configLocation(): Promise<string | null> {
	if (!isTauri()) return null;
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<string>("config_location");
}
