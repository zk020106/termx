import { create } from "zustand";
import {
	mergeGlobalHistoryOnAppend,
	removeGlobalHistoryEntry,
	sanitizeGlobalHistoryEntries,
	type ShellHistoryEntry,
} from "../lib/shellHistory";

/* Shell 历史（Netcatty shellHistoryStore + useVaultState.addShellHistoryEntry）：存 localStorage，同 Netcatty。 */

const STORAGE_KEY = "termx_shell_history";

function load(): ShellHistoryEntry[] {
	try {
		const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const clean = sanitizeGlobalHistoryEntries(parsed as ShellHistoryEntry[]);
		if (clean.length !== parsed.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
		return clean;
	} catch {
		return [];
	}
}

function save(entries: ShellHistoryEntry[]) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
	} catch {
		// 尽力而为
	}
}

interface ShellHistoryState {
	entries: ShellHistoryEntry[];
	add: (entry: Omit<ShellHistoryEntry, "id" | "timestamp">) => void;
	remove: (id: string) => void;
	clear: () => void;
}

export const useShellHistoryStore = create<ShellHistoryState>((set) => ({
	entries: load(),
	add: (entry) =>
		set((s) => {
			const next = mergeGlobalHistoryOnAppend(s.entries, entry);
			if (next === s.entries) return s;
			save(next);
			return { entries: next };
		}),
	remove: (id) =>
		set((s) => {
			const next = removeGlobalHistoryEntry(s.entries, id);
			if (next === s.entries) return s;
			save(next);
			return { entries: next };
		}),
	clear: () => {
		save([]);
		set({ entries: [] });
	},
}));

if (typeof window !== "undefined") {
	// 多窗口：别的窗口写了历史，这里跟着刷新（Netcatty storage 事件同步）
	window.addEventListener("storage", (event) => {
		if (event.key === STORAGE_KEY) useShellHistoryStore.setState({ entries: load() });
	});
}
