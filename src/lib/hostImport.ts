import type { AuthMethod, Host } from "@/data/types";

/* =============================================================================
 * 主机导入（纯函数，便于单测）：
 *  - OpenSSH ~/.ssh/config：Host 块里的 HostName / User / Port / IdentityFile / ProxyJump；
 *    通配符块（Host * / Host *.corp）不是具体主机，跳过；Include / Match 不展开（如实计入 skipped）。
 *  - CSV：表头含 名称/name、地址/host/hostname、用户/user/username、端口/port（顺序不限）。
 * 密码一律不导入：首次连接时再输入。
 * ========================================================================== */

export interface ImportedHost {
	alias: string;
	hostname: string;
	port: number;
	username: string;
	identityFile?: string;
	/** ProxyJump 里引用的别名（导入后按别名映射成 jumpHostIds） */
	proxyJump?: string[];
}

export interface ImportResult {
	hosts: ImportedHost[];
	/** 没有导入的条目与原因 */
	skipped: string[];
}

export function parseSshConfig(text: string): ImportResult {
	const hosts: ImportedHost[] = [];
	const skipped: string[] = [];
	let current: { aliases: string[]; opts: Map<string, string> } | null = null;

	const flush = () => {
		if (!current) return;
		for (const alias of current.aliases) {
			if (/[*?!]/.test(alias)) {
				skipped.push(`Host ${alias}：通配符规则不是具体主机`);
				continue;
			}
			const port = Number(current.opts.get("port") ?? "22");
			const proxy = current.opts.get("proxyjump");
			hosts.push({
				alias,
				hostname: current.opts.get("hostname") ?? alias,
				port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
				username: current.opts.get("user") ?? "",
				identityFile: current.opts.get("identityfile"),
				proxyJump: proxy && proxy.toLowerCase() !== "none" ? proxy.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
			});
		}
		current = null;
	};

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const m = /^(\S+?)\s*(?:=\s*|\s+)(.*)$/.exec(line);
		if (!m) continue;
		const key = m[1].toLowerCase();
		const value = m[2].trim().replace(/^"(.*)"$/, "$1");
		if (key === "host") {
			flush();
			current = { aliases: value.split(/\s+/).filter(Boolean), opts: new Map() };
			continue;
		}
		if (key === "match") {
			flush();
			skipped.push(`Match ${value}：条件块不支持导入`);
			continue;
		}
		if (key === "include") {
			skipped.push(`Include ${value}：未展开被包含的文件`);
			continue;
		}
		// 同一选项以第一次出现为准（与 OpenSSH 一致）
		if (current && !current.opts.has(key)) current.opts.set(key, value);
	}
	flush();
	return { hosts, skipped };
}

/** 极简 CSV（支持双引号转义） */
export function parseCsvRows(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else field += ch;
			continue;
		}
		if (ch === '"') quoted = true;
		else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += ch;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const CSV_COLUMNS: Record<string, keyof ImportedHost> = {
	名称: "alias",
	name: "alias",
	地址: "hostname",
	主机: "hostname",
	host: "hostname",
	hostname: "hostname",
	用户: "username",
	用户名: "username",
	user: "username",
	username: "username",
	端口: "port",
	port: "port",
};

export function parseHostCsv(text: string): ImportResult {
	const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
	const skipped: string[] = [];
	if (rows.length === 0) return { hosts: [], skipped: ["文件是空的"] };
	const header = rows[0].map((h) => CSV_COLUMNS[h.trim().toLowerCase()] ?? CSV_COLUMNS[h.trim()]);
	if (!header.includes("hostname")) return { hosts: [], skipped: ["表头里没有「地址 / host / hostname」列"] };
	const hosts: ImportedHost[] = [];
	rows.slice(1).forEach((cells, index) => {
		const get = (field: keyof ImportedHost) => {
			const col = header.indexOf(field);
			return col >= 0 ? (cells[col] ?? "").trim() : "";
		};
		const hostname = get("hostname");
		if (!hostname) {
			skipped.push(`第 ${index + 2} 行：没有地址`);
			return;
		}
		const port = Number(get("port") || "22");
		hosts.push({
			alias: get("alias") || hostname,
			hostname,
			port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
			username: get("username"),
		});
	});
	return { hosts, skipped };
}

/** 展开 ~ / %d（OpenSSH 的家目录写法） */
export function expandHome(path: string | undefined, home: string): string | undefined {
	if (!path) return undefined;
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return `${home.replace(/[\\/]+$/, "")}/${path.slice(2)}`;
	return path.replace(/%d/g, home);
}

/**
 * 把导入结果变成主机记录：已存在同名（名称或 地址+端口+用户 相同）的跳过并计入冲突；
 * ProxyJump 别名映射到本次导入或已有的主机。
 */
export function toHosts(
	imported: ImportedHost[],
	existing: Host[],
	options: { home: string; defaultUser?: string; idPrefix?: string; now?: number },
): { hosts: Host[]; conflicts: string[] } {
	const now = options.now ?? Date.now();
	const conflicts: string[] = [];
	const byAlias = new Map<string, string>();
	for (const h of existing) byAlias.set(h.name, h.id);
	const hosts: Host[] = [];
	imported.forEach((item, index) => {
		const dup = existing.find(
			(h) =>
				h.name === item.alias ||
				(h.hostname === item.hostname && h.port === item.port && h.username === (item.username || h.username)),
		);
		if (dup) {
			conflicts.push(`${item.alias}（与已有主机「${dup.name}」重复）`);
			return;
		}
		const id = `${options.idPrefix ?? "host"}-${now.toString(36)}-${index}`;
		byAlias.set(item.alias, id);
		const keyPath = expandHome(item.identityFile, options.home);
		const method: AuthMethod = keyPath ? "key" : "agent";
		hosts.push({
			id,
			name: item.alias,
			groupId: null,
			hostname: item.hostname,
			port: item.port,
			username: item.username || options.defaultUser || "root",
			tags: [],
			favorite: false,
			auth: { method, keyPath },
			jumpHostIds: [],
			reachable: false,
		});
	});
	// 第二遍：解析 ProxyJump（只认得出的别名；user@host:port 写法无法对应到主机库条目，计入冲突说明）
	imported.forEach((item) => {
		if (!item.proxyJump) return;
		const host = hosts.find((h) => h.name === item.alias);
		if (!host) return;
		const ids: string[] = [];
		for (const hop of item.proxyJump) {
			const id = byAlias.get(hop);
			if (id) ids.push(id);
			else conflicts.push(`${item.alias}：跳板 ${hop} 不在主机库里，未设置`);
		}
		host.jumpHostIds = ids;
	});
	return { hosts, conflicts };
}
