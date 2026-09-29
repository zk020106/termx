import { create } from "zustand";
import type { Snippet } from "@/data/types";

/* 命令片段：用户自己维护，落盘保存。 */

interface SnippetsState {
	snippets: Snippet[];
	setAll: (snippets: Snippet[]) => void;
	upsert: (snippet: Snippet) => void;
	remove: (id: string) => void;
}

export const useSnippetsStore = create<SnippetsState>((set) => ({
	snippets: [],

	setAll: (snippets) => set({ snippets }),

	upsert: (snippet) =>
		set((s) => ({
			snippets: s.snippets.some((x) => x.id === snippet.id)
				? s.snippets.map((x) => (x.id === snippet.id ? snippet : x))
				: [...s.snippets, snippet],
		})),

	remove: (id) => set((s) => ({ snippets: s.snippets.filter((x) => x.id !== id) })),
}));

/** 从命令文本里抽出 ${var} 占位变量，去重保序 */
export function extractVariables(command: string): string[] {
	const found = command.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g);
	const names: string[] = [];
	for (const match of found) {
		if (!names.includes(match[1])) names.push(match[1]);
	}
	return names;
}

export function draftSnippet(): Snippet {
	return {
		id: `sn-${Date.now().toString(36)}`,
		name: "",
		group: "默认",
		command: "",
		variables: [],
	};
}
