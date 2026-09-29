import type { ForwardRule, Host, HostGroup, Snippet, SshKey } from "@/data/types";
import { normalizePreferences, type Preferences } from "@/data/preferences";
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
		// 每次都给一份全新的默认偏好，避免共享对象被就地改坏
		preferences: normalizePreferences(null),
	};
}

const LS_KEY = "termx.config";

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
		forwards: Array.isArray(raw.forwards) ? raw.forwards : [],
		// 偏好逐项校验：老配置文件只有 accent，也能补齐成完整结构
		preferences: normalizePreferences(raw.preferences),
	};
}

export async function loadConfig(): Promise<PersistedConfig> {
	if (isTauri()) {
		const { invoke } = await import("@tauri-apps/api/core");
		const raw = await invoke<Partial<PersistedConfig> | null>("config_load");
		return normalizeConfig(raw);
	}

	try {
		const text = localStorage.getItem(LS_KEY);
		return normalizeConfig(text ? (JSON.parse(text) as Partial<PersistedConfig>) : null);
	} catch {
		return emptyConfig();
	}
}

export async function saveConfig(config: PersistedConfig): Promise<void> {
	if (isTauri()) {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("config_save", { data: config });
		return;
	}

	try {
		localStorage.setItem(LS_KEY, JSON.stringify(config));
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
