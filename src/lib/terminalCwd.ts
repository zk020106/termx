/**
 * 终端当前目录（cwd）追踪 —— 对应 Netcatty：
 *   - createXTermRuntime.ts 的 OSC 7 处理器（file://host/path 或裸路径）→ parseOsc7Cwd
 *   - Terminal.tsx 的 terminalCwdTracker / knownCwdRef → 这里按 SSH 会话键记住最近一次上报
 *   - sessionOps.cjs getSessionPwd（exec 通道探测交互 shell 的 cwd）→ Rust ssh_session_pwd
 *   - systemManagerBridge.setupOsc7Tracking（exec 通道，10s）→ setupOsc7Tracking（ssh_exec）
 *   - clipboardImagePaste.ts handleRemoteClipboardImageUpload → uploadClipboardImage（Rust 读剪贴板 + SFTP 写）
 */
import { isTauri } from "./tauri";
import type { Osc7SetupRunResult } from "./osc7Setup";

/** Netcatty OSC 7 处理器的解析规则；不认识的返回 null */
export function parseOsc7Cwd(data: string): string | null {
	try {
		if (data.startsWith("file://")) {
			const path = decodeURIComponent(new URL(data).pathname);
			return path.length > 0 ? path : null;
		}
		if (data.startsWith("/")) return data;
	} catch {
		/* Netcatty：解析失败只记日志 */
	}
	return null;
}

const cwdBySession = new Map<string, string>();
const listeners = new Set<(key: string, cwd: string) => void>();

export function setSessionCwd(key: string, cwd: string): void {
	if (cwdBySession.get(key) === cwd) return;
	cwdBySession.set(key, cwd);
	for (const fn of listeners) fn(key, cwd);
}

export function getSessionCwd(key: string): string | null {
	return cwdBySession.get(key) ?? null;
}

export function forgetSessionCwd(key: string): void {
	cwdBySession.delete(key);
}

export function subscribeSessionCwd(fn: (key: string, cwd: string) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** 交互 shell 的当前目录：先用 OSC 7 上报的，没有再走 exec 通道探测（Netcatty getSessionPwd） */
export async function resolveRemoteCwd(key: string): Promise<string | null> {
	const known = getSessionCwd(key);
	if (known) return known;
	if (!isTauri()) return null;
	const { invoke } = await import("@tauri-apps/api/core");
	try {
		return (await invoke<string | null>("ssh_session_pwd", { key })) ?? null;
	} catch {
		return null;
	}
}

/** Netcatty RemoteClipboardImageUploadResult */
export type RemoteClipboardImageUploadResult =
	| { ok: true; remotePath: string; pastedPath: string }
	| { ok: false; reason: "no-session" | "unsupported" | "no-image" | "no-cwd" | "upload-failed"; detail?: string };

type RustUploadResult =
	| { status: "ok"; remotePath: string; pastedPath: string }
	| { status: "failed"; reason: "no-image" | "no-cwd" | "upload-failed"; detail?: string | null };

/**
 * 读剪贴板图片 → 上传到 `<cwd>/.netcatty-paste-images/` → 返回要键入终端的路径。
 * 由调用方把 pastedPath 写进会话（不带回车）并聚焦终端（同 Netcatty）。
 */
export async function uploadClipboardImage(key: string | null | undefined): Promise<RemoteClipboardImageUploadResult> {
	if (!key) return { ok: false, reason: "no-session" };
	if (!isTauri()) return { ok: false, reason: "unsupported" };
	const { invoke } = await import("@tauri-apps/api/core");
	const result = await invoke<RustUploadResult>("ssh_upload_clipboard_image", { key, cwd: getSessionCwd(key) });
	if (result.status === "ok") return { ok: true, remotePath: result.remotePath, pastedPath: result.pastedPath };
	return { ok: false, reason: result.reason, detail: result.detail ?? undefined };
}

/** Netcatty systemManagerBridge.setupOsc7Tracking：在会话连接上开 exec 通道跑配置命令（10 秒） */
export async function setupOsc7Tracking(key: string, command: string): Promise<Osc7SetupRunResult> {
	if (!key || !command.trim()) return { success: false, error: "Missing sessionId or command" };
	if (!isTauri()) return { success: false, error: "Directory tracking setup is unavailable" };
	const { invoke } = await import("@tauri-apps/api/core");
	try {
		const result = await invoke<{ code: number | null; stdout: string; stderr: string }>("ssh_exec", {
			key,
			command,
			timeoutMs: 10000,
		});
		if (typeof result.code === "number" && result.code !== 0) {
			const error = String(result.stderr || `Directory tracking setup failed with exit code ${result.code}`).trim();
			return { success: false, stdout: result.stdout || "", stderr: result.stderr || "", code: result.code, error };
		}
		return { success: true, stdout: result.stdout || "", stderr: result.stderr || "", code: result.code ?? 0 };
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) || "Directory tracking setup failed" };
	}
}
