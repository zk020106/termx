import type { Snippet } from "@/data/types";

/* =============================================================================
 * 片段导入 / 导出 —— 移植自 Netcatty domain/snippetTransfer.ts（GPL-3.0-or-later），
 * 文件格式与 Netcatty 相同（kind = "netcatty.snippets"，version 2，兼容 1），两边可以互相导入。
 * 字段对应：termx name ↔ label，group ↔ package，description ↔ description；
 * termx 没有的字段（tags / targetGroups…）导出时给默认值，导入时忽略；shortkey 双向保留。
 * 冲突判定与 Netcatty 一样按命令文本：skip 跳过，overwrite 覆盖原片段（保留 id）。
 * ========================================================================== */

export const SNIPPET_EXPORT_KIND = "netcatty.snippets" as const;
export const SNIPPET_EXPORT_VERSION = 2 as const;
export const SNIPPET_EXPORT_VERSION_LEGACY = 1 as const;

export type SnippetImportConflictAction = "skip" | "overwrite";

export interface SnippetExportItem {
	label: string;
	command: string;
	tags?: string[];
	package?: string;
	description?: string;
	shortkey?: string;
}

export interface SnippetExportPayload {
	kind: typeof SNIPPET_EXPORT_KIND;
	version: typeof SNIPPET_EXPORT_VERSION | typeof SNIPPET_EXPORT_VERSION_LEGACY;
	exportedAt: string;
	snippetPackages: string[];
	snippets: SnippetExportItem[];
}

export interface SnippetImportStats {
	imported: number;
	overwritten: number;
	skipped: number;
	conflicts: number;
}

const DEFAULT_GROUP = "默认";

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

function uniqueStrings(values: unknown[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function packageAncestors(path: string): string[] {
	const normalized = path.trim().replace(/\/+$/g, "");
	if (!normalized) return [];
	const absolute = normalized.startsWith("/");
	const parts = normalized.split("/").filter(Boolean);
	return parts.map((_, i) => {
		const joined = parts.slice(0, i + 1).join("/");
		return absolute ? `/${joined}` : joined;
	});
}

export function collectSnippetPackagePaths(items: Pick<SnippetExportItem, "package">[], known: string[] = []): string[] {
	const referenced = new Set<string>();
	for (const item of items) {
		const path = item.package?.trim();
		if (path) for (const a of packageAncestors(path)) referenced.add(a);
	}
	return uniqueStrings([...known.filter((p) => referenced.has(p)), ...referenced]);
}

const toExportItem = (snippet: Snippet): SnippetExportItem => ({
	label: snippet.name,
	command: snippet.command,
	tags: [],
	package: snippet.group === DEFAULT_GROUP ? "" : snippet.group,
	...(snippet.description ? { description: snippet.description } : {}),
	...(snippet.shortkey ? { shortkey: snippet.shortkey } : {}),
});

export function buildSnippetExportPayload(snippets: Snippet[], exportedAt = new Date().toISOString()): SnippetExportPayload {
	const items = snippets.map(toExportItem);
	return {
		kind: SNIPPET_EXPORT_KIND,
		version: SNIPPET_EXPORT_VERSION,
		exportedAt,
		snippetPackages: collectSnippetPackagePaths(items),
		snippets: items,
	};
}

/** 导出文件名片段（Netcatty sanitizeTransferFileNamePart） */
export function sanitizeTransferFileNamePart(value: string): string {
	const normalized = value
		.trim()
		.replace(/[\\/:*?"<>|]+/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase();
	return normalized.slice(0, 80) || "snippets";
}

export const snippetExportFileName = (part: string) => `netcatty-snippets-${sanitizeTransferFileNamePart(part)}.json`;

function fallbackLabel(command: string): string {
	const first = command.split(/\r?\n/).find((line) => line.trim());
	return first?.trim().slice(0, 80) || "Imported snippet";
}

function sanitizeImportItem(value: unknown): SnippetExportItem | null {
	if (!isObjectRecord(value) || typeof value.command !== "string") return null;
	if (!value.command.trim()) return null;
	const label = typeof value.label === "string" && value.label.trim() ? value.label.trim() : fallbackLabel(value.command);
	return {
		label,
		command: value.command,
		tags: Array.isArray(value.tags) ? uniqueStrings(value.tags) : [],
		package: typeof value.package === "string" ? value.package.trim() : "",
		description: typeof value.description === "string" && value.description.trim() ? value.description.trim() : undefined,
		shortkey: typeof value.shortkey === "string" && value.shortkey.trim() ? value.shortkey.trim() : undefined,
	};
}

function parseObject(parsed: Record<string, unknown>): SnippetExportPayload {
	const version = parsed.version;
	if (parsed.kind !== SNIPPET_EXPORT_KIND) throw new Error("不支持的片段导入文件（kind 不是 netcatty.snippets）");
	if (version !== SNIPPET_EXPORT_VERSION && version !== SNIPPET_EXPORT_VERSION_LEGACY) throw new Error("不支持的片段导入文件版本");
	if (!Array.isArray(parsed.snippets)) throw new Error("导入文件里没有片段");
	const snippets = parsed.snippets.map(sanitizeImportItem).filter((x): x is SnippetExportItem => Boolean(x));
	return {
		kind: SNIPPET_EXPORT_KIND,
		version: version === SNIPPET_EXPORT_VERSION ? SNIPPET_EXPORT_VERSION : SNIPPET_EXPORT_VERSION_LEGACY,
		exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : "",
		snippetPackages: collectSnippetPackagePaths(snippets, Array.isArray(parsed.snippetPackages) ? uniqueStrings(parsed.snippetPackages) : []),
		snippets,
	};
}

/** 支持：标准导出对象、多个导出对象组成的数组、裸片段数组（与 Netcatty 一致） */
export function parseSnippetImportPayload(json: string): SnippetExportPayload {
	const parsed = JSON.parse(json) as unknown;
	if (Array.isArray(parsed)) {
		const nested = parsed.filter(isObjectRecord).filter((item) => Array.isArray(item.snippets)).map(parseObject);
		if (nested.length > 0 && nested.length === parsed.length) {
			const snippets = nested.flatMap((p) => p.snippets);
			return {
				kind: SNIPPET_EXPORT_KIND,
				version: SNIPPET_EXPORT_VERSION,
				exportedAt: new Date().toISOString(),
				snippetPackages: collectSnippetPackagePaths(snippets, nested.flatMap((p) => p.snippetPackages)),
				snippets,
			};
		}
		const snippets = parsed.map(sanitizeImportItem).filter((x): x is SnippetExportItem => Boolean(x));
		return { kind: SNIPPET_EXPORT_KIND, version: SNIPPET_EXPORT_VERSION, exportedAt: "", snippetPackages: collectSnippetPackagePaths(snippets), snippets };
	}
	if (!isObjectRecord(parsed)) throw new Error("无效的片段导入文件");
	return parseObject(parsed);
}

export function countImportConflicts(existing: Snippet[], payload: SnippetExportPayload): number {
	const commands = new Set(existing.map((s) => s.command));
	return payload.snippets.filter((item) => commands.has(item.command)).length;
}

export function mergeSnippetImportPayload(input: {
	existing: Snippet[];
	payload: SnippetExportPayload;
	conflictAction: SnippetImportConflictAction;
	createId: () => string;
	extractVariables: (command: string) => string[];
}): { snippets: Snippet[]; stats: SnippetImportStats } {
	const next = [...input.existing];
	const commandToIndex = new Map<string, number>();
	next.forEach((s, i) => {
		if (!commandToIndex.has(s.command)) commandToIndex.set(s.command, i);
	});
	const stats: SnippetImportStats = { imported: 0, overwritten: 0, skipped: 0, conflicts: 0 };
	const toSnippet = (item: SnippetExportItem, id: string): Snippet => ({
		id,
		name: item.label,
		group: item.package?.trim() || DEFAULT_GROUP,
		command: item.command,
		variables: input.extractVariables(item.command),
		...(item.description ? { description: item.description } : {}),
		...(item.shortkey ? { shortkey: item.shortkey } : {}),
	});
	for (const item of input.payload.snippets) {
		const idx = commandToIndex.get(item.command);
		if (idx !== undefined) {
			stats.conflicts += 1;
			if (input.conflictAction === "skip") {
				stats.skipped += 1;
				continue;
			}
			next[idx] = toSnippet(item, next[idx].id);
			stats.overwritten += 1;
			continue;
		}
		const created = toSnippet(item, input.createId());
		commandToIndex.set(created.command, next.length);
		next.push(created);
		stats.imported += 1;
	}
	return { snippets: next, stats };
}
