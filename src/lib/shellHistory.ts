import { isSensitiveCommand } from "./sensitive";

/* =============================================================================
 * Shell 历史 —— 移植自 Netcatty domain/globalHistory.ts（mergeGlobalHistoryOnAppend 等）
 * 与 domain/models/history.ts 的 ShellHistoryEntry。记录在终端里真正执行过的命令（按时间倒序），
 * 区别于自动补全用的 frecency 统计（store/commands.ts）。
 * TermX 额外保留自己的隐私规则：疑似带密钥 / 口令的命令（isSensitiveCommand）不记录。
 * ========================================================================== */

export interface ShellHistoryEntry {
	id: string;
	command: string;
	hostId: string;
	hostLabel: string;
	sessionId: string;
	timestamp: number;
}

const makeId = (): string =>
	typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `gh-${Date.now()}-${Math.random().toString(16).slice(2)}`;

/** Netcatty shouldRecordGlobalHistoryCommand + TermX 敏感命令过滤 */
export function shouldRecordGlobalHistoryCommand(command: string): boolean {
	const cmd = command.trim();
	if (!cmd) return false;
	if (isSensitiveCommand(cmd)) return false;
	return true;
}

export function sanitizeGlobalHistoryEntries(entries: ShellHistoryEntry[]): ShellHistoryEntry[] {
	return entries.filter(
		(entry) =>
			entry &&
			typeof entry.command === "string" &&
			typeof entry.id === "string" &&
			typeof entry.timestamp === "number" &&
			shouldRecordGlobalHistoryCommand(entry.command),
	);
}

export function removeGlobalHistoryEntry(entries: ShellHistoryEntry[], entryId: string): ShellHistoryEntry[] {
	if (!entries.some((entry) => entry.id === entryId)) return entries;
	return entries.filter((entry) => entry.id !== entryId);
}

/** 追加一条：去空白、丢噪声；与最近一条相同时只刷新时间而不新增一行（Netcatty 同款） */
export function mergeGlobalHistoryOnAppend(
	prev: ShellHistoryEntry[],
	entry: Omit<ShellHistoryEntry, "id" | "timestamp">,
	max = 1000,
	now = Date.now(),
): ShellHistoryEntry[] {
	const cmd = entry.command.trim();
	if (!shouldRecordGlobalHistoryCommand(cmd)) return prev;
	const normalized = { ...entry, command: cmd };
	if (prev[0]?.command === cmd) {
		return [
			{ ...prev[0], timestamp: now, hostId: normalized.hostId, hostLabel: normalized.hostLabel, sessionId: normalized.sessionId },
			...prev.slice(1),
		].slice(0, max);
	}
	return [{ ...normalized, id: makeId(), timestamp: now }, ...prev].slice(0, max);
}

/** Netcatty SnippetsHistoryItem.formatTime */
export function formatHistoryTime(timestamp: number, now = Date.now()): string {
	const diffMs = now - timestamp;
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);
	if (diffMins < 1) return "刚刚";
	if (diffMins < 60) return `${diffMins} 分钟前`;
	if (diffHours < 24) return `${diffHours} 小时前`;
	if (diffDays < 7) return `${diffDays} 天前`;
	return new Date(timestamp).toLocaleDateString();
}
