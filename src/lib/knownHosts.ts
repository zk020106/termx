/**
 * 已知主机（known_hosts）列表与删除 —— 对应 Netcatty KnownHostsManager。
 * Netcatty 在自己的 vault 里维护一份 KnownHost 列表；TermX 直接读真正参与校验的文件：
 * TermX 自己的 known_hosts（可删）+ ~/.ssh/known_hosts（只读沿用，不改用户的 OpenSSH 文件）。
 */
import { isTauri } from "./tauri";

export interface KnownHostEntry {
	source: "termx" | "openssh";
	lineNo: number;
	line: string;
	patterns: string[];
	host: string | null;
	port: number;
	keyType: string;
	fingerprint: string | null;
	marker: string | null;
	hashed: boolean;
}

export async function knownHostsList(): Promise<KnownHostEntry[]> {
	if (!isTauri()) return [];
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<KnownHostEntry[]>("known_hosts_list");
}

/** 按整行精确删除 TermX 自己的记录，返回删掉的行数 */
export async function knownHostsRemove(line: string): Promise<number> {
	if (!isTauri()) throw new Error("仅桌面端可用");
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<number>("known_hosts_remove", { line });
}

/** 能否「转换为主机」：哈希过的、通配 / 否定模式、@revoked 等都无法还原出一个可连接的地址 */
export function convertibleHost(entry: KnownHostEntry): { hostname: string; port: number } | null {
	if (entry.hashed || !entry.host || entry.marker) return null;
	if (/[*?!]/.test(entry.host)) return null;
	return { hostname: entry.host, port: entry.port };
}

export function knownHostLabel(entry: KnownHostEntry): string {
	if (entry.hashed) return "（哈希的主机名）";
	return entry.patterns.join(", ");
}

export interface KnownHostsImportResult {
	noFile: boolean;
	parsed: number;
	imported: number;
	filteredPublic: number;
}

/**
 * Netcatty「扫描系统」（path 省略 → ~/.ssh/known_hosts）/「导入文件」。
 * 文件由 Rust 读取并解析；写入 TermX 的 known_hosts 前 Rust 会弹原生确认框。
 */
export async function knownHostsImport(path?: string): Promise<KnownHostsImportResult> {
	if (!isTauri()) throw new Error("仅桌面端可用");
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<KnownHostsImportResult>("known_hosts_import", { path: path ?? null });
}
