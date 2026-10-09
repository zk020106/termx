/**
 * SFTP 列布局 / 排序 / 标签复制 —— 移植自 Netcatty：
 *   application/state/sftp/columnLayout.ts（列宽、列可见性与规范化）
 *   components/sftp/utils.ts（buildSftpColumnTemplate、sortSftpEntries、isSftpColumnMenuKey）
 *   components/sftp/sftpTabDuplication.ts（复制标签页的两种模式与请求构造）
 * 字段名换成 termx 的 SftpFileEntry（mtime 秒、is_dir、is_symlink），逻辑不变。
 */
import type { SftpFileEntry } from "./sftp";

export type SortField = "name" | "size" | "modified" | "type" | "owner";
export type SortOrder = "asc" | "desc";

export interface ColumnWidths {
	name: number;
	modified: number;
	size: number;
	type: number;
	owner: number;
}

export type SftpColumnVisibility = Record<keyof ColumnWidths, boolean>;

export const DEFAULT_SFTP_COLUMN_VISIBILITY: SftpColumnVisibility = {
	name: true,
	modified: true,
	size: true,
	type: true,
	owner: true,
};

/** Netcatty useSftpPaneSorting 的初始列宽 */
export const DEFAULT_SFTP_COLUMN_WIDTHS: ColumnWidths = { name: 50, modified: 24, size: 7, type: 9, owner: 10 };

/** Netcatty applyColumnWidth 的列宽上下限（单位 fr） */
export const SFTP_COLUMN_WIDTH_LIMITS: Record<keyof ColumnWidths, { min: number; max: number }> = {
	name: { min: 36, max: 78 },
	modified: { min: 18, max: 42 },
	size: { min: 5, max: 16 },
	type: { min: 6, max: 18 },
	owner: { min: 6, max: 20 },
};

export const normalizeSftpColumnVisibility = (value: unknown): SftpColumnVisibility => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return DEFAULT_SFTP_COLUMN_VISIBILITY;
	}
	const stored = value as Partial<Record<keyof ColumnWidths, unknown>>;
	return {
		name: true,
		modified: stored.modified !== false,
		size: stored.size !== false,
		type: stored.type !== false,
		owner: stored.owner !== false,
	};
};

export const isSftpColumnMenuKey = (key: string, shiftKey: boolean): boolean =>
	key === "ContextMenu" || (key === "F10" && shiftKey);

export const buildSftpColumnTemplate = (
	columnWidths: ColumnWidths,
	visibleColumns: SftpColumnVisibility = DEFAULT_SFTP_COLUMN_VISIBILITY,
): string => {
	const columns = [`minmax(140px, ${columnWidths.name}fr)`];
	if (visibleColumns.modified) columns.push(`minmax(0, ${columnWidths.modified}fr)`);
	if (visibleColumns.size) columns.push(`minmax(52px, ${columnWidths.size}fr)`);
	if (visibleColumns.type) columns.push(`minmax(64px, ${columnWidths.type}fr)`);
	if (visibleColumns.owner) columns.push(`minmax(56px, ${columnWidths.owner}fr)`);
	return columns.join(" ");
};

/** 「类型」列（Netcatty SftpFileRow：folder / link / 扩展名小写 / file） */
export const sftpKindLabel = (entry: Pick<SftpFileEntry, "name" | "is_dir" | "is_symlink">): string => {
	if (entry.is_dir && entry.is_symlink) return "link → folder";
	if (entry.is_dir) return "folder";
	if (entry.is_symlink) return "link";
	const dot = entry.name.lastIndexOf(".");
	return dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "file";
};

const typeKey = (e: SftpFileEntry) =>
	e.is_dir ? "folder" : e.name.includes(".") ? (e.name.split(".").pop()?.toLowerCase() ?? "") : e.name.toLowerCase();

export const sortSftpEntries = (
	entries: SftpFileEntry[],
	sortField: SortField,
	sortOrder: SortOrder,
	directoriesFirst = true,
): SftpFileEntry[] => {
	if (!entries.length) return entries;
	return [...entries].sort((a, b) => {
		if (directoriesFirst) {
			if (a.is_dir && !b.is_dir) return -1;
			if (!a.is_dir && b.is_dir) return 1;
		}
		let cmp = 0;
		switch (sortField) {
			case "name":
				cmp = a.name.localeCompare(b.name);
				break;
			case "size":
				cmp = (a.size || 0) - (b.size || 0);
				break;
			case "modified":
				cmp = (a.mtime || 0) - (b.mtime || 0);
				break;
			case "type":
				cmp = typeKey(a).localeCompare(typeKey(b));
				break;
			case "owner":
				cmp = (a.owner || "").localeCompare(b.owner || "");
				break;
		}
		return sortOrder === "asc" ? cmp : -cmp;
	});
};

/** Netcatty filterSftpTreeEntriesByName：树形视图里按名称过滤（大小写不敏感） */
export const filterEntriesByName = (entries: SftpFileEntry[], filter: string): SftpFileEntry[] => {
	const term = filter.trim().toLowerCase();
	if (!term) return entries;
	return entries.filter((e) => e.name.toLowerCase().includes(term));
};

/* ------------------------------ 标签复制（sftpTabDuplication.ts） ------------------------------ */

export type SftpTabDuplicateMode = "defaultPath" | "currentPath";

export const SFTP_TAB_DUPLICATE_MENU_ITEMS: ReadonlyArray<{ mode: SftpTabDuplicateMode; label: string }> = Object.freeze([
	{ mode: "defaultPath", label: "复制标签页（默认路径）" },
	{ mode: "currentPath", label: "复制并跳转到当前路径" },
]);

export interface SftpPaneConnectionInfo {
	status: "connected" | "connecting" | "disconnected";
	isLocal: boolean;
	hostId: string | null;
	currentPath: string;
}

export type SftpTabDuplicateRequest = { kind: "local"; path?: string } | { kind: "remote"; hostId: string; path?: string };

export function canDuplicateSftpTab(connection: SftpPaneConnectionInfo | null | undefined, hasDuplicateHandler: boolean): boolean {
	if (!hasDuplicateHandler || !connection) return false;
	return connection.status === "connected";
}

export function getSftpTabDuplicateRequest(
	connection: SftpPaneConnectionInfo | null | undefined,
	mode: SftpTabDuplicateMode,
): SftpTabDuplicateRequest | null {
	if (!connection || connection.status !== "connected") return null;
	const path = mode === "currentPath" && connection.currentPath ? { path: connection.currentPath } : {};
	if (connection.isLocal) return { kind: "local", ...path };
	if (!connection.hostId) return null;
	return { kind: "remote", hostId: connection.hostId, ...path };
}

export function isSftpTabKeyboardContextMenuShortcut(key: string, shiftKey = false): boolean {
	return key === "ContextMenu" || (shiftKey && key === "F10");
}

export function isSftpTabKeyboardSelectShortcut(key: string): boolean {
	return key === "Enter" || key === " ";
}

/** Netcatty SftpTabBar onReorderTabs：把 dragged 挪到 target 的前 / 后 */
export function reorderTabs<T extends { id: string }>(tabs: T[], draggedId: string, targetId: string, position: "before" | "after"): T[] {
	if (draggedId === targetId) return tabs;
	const dragged = tabs.find((t) => t.id === draggedId);
	if (!dragged) return tabs;
	const rest = tabs.filter((t) => t.id !== draggedId);
	const idx = rest.findIndex((t) => t.id === targetId);
	if (idx < 0) return tabs;
	rest.splice(position === "before" ? idx : idx + 1, 0, dragged);
	return rest;
}
