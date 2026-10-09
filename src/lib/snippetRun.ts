import { create } from "zustand";
import type { Snippet } from "@/data/types";

/* =============================================================================
 * 片段执行前的变量填写 —— 对应 Netcatty SnippetExecutionProvider（resolveSnippetCommand /
 * promptSnippetVariablesSingleton / applySnippetVariables）。没有 ${var} 的片段原样返回；
 * 有变量时弹出填写框，取消返回 null。
 * ========================================================================== */

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_-]*)\}/g;

export const snippetHasVariables = (command: string) => new RegExp(VAR.source).test(command);

export function snippetVariableNames(command: string): string[] {
	const names: string[] = [];
	for (const m of command.matchAll(VAR)) if (!names.includes(m[1])) names.push(m[1]);
	return names;
}

export function applySnippetVariables(command: string, values: Record<string, string>): { ok: true; command: string } | { ok: false; missing: string[] } {
	const missing = snippetVariableNames(command).filter((n) => !(values[n] ?? "").trim());
	if (missing.length) return { ok: false, missing };
	return { ok: true, command: command.replace(VAR, (_, name: string) => values[name].trim()) };
}

interface PromptState {
	pending: { snippet: Snippet; resolve: (values: Record<string, string> | null) => void } | null;
}

export const useSnippetPromptStore = create<PromptState>(() => ({ pending: null }));

function promptSnippetVariables(snippet: Snippet): Promise<Record<string, string> | null> {
	return new Promise((resolve) => {
		useSnippetPromptStore.getState().pending?.resolve(null);
		useSnippetPromptStore.setState({ pending: { snippet, resolve } });
	});
}

export async function resolveSnippetCommand(snippet: Snippet): Promise<string | null> {
	if (!snippetHasVariables(snippet.command)) return snippet.command;
	const values = await promptSnippetVariables(snippet);
	if (values === null) return null;
	const result = applySnippetVariables(snippet.command, values);
	return result.ok ? result.command : null;
}
