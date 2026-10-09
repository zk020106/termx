import { invoke } from "@tauri-apps/api/core";

export interface SftpFileEntry {
	name: string;
	path: string;
	is_dir: boolean;
	is_symlink: boolean;
	size: number;
	mtime: number; // unix timestamp in seconds
	permissions: number;
	permissions_str: string;
	owner?: string;
	group?: string;
}

/* ------------------------------- 远端 SFTP 调用 ------------------------------- */

export async function sftpList(sessionKey: string, path: string): Promise<SftpFileEntry[]> {
	return invoke<SftpFileEntry[]>("sftp_list", { key: sessionKey, path });
}

export async function sftpRealPath(sessionKey: string, path: string = ""): Promise<string> {
	return invoke<string>("sftp_realpath", { key: sessionKey, path });
}

export async function sftpMkdir(sessionKey: string, path: string): Promise<void> {
	return invoke<void>("sftp_mkdir", { key: sessionKey, path });
}

export async function sftpRemove(sessionKey: string, path: string, isDir: boolean): Promise<void> {
	return invoke<void>("sftp_remove", { key: sessionKey, path, isDir });
}

export async function sftpRename(sessionKey: string, oldPath: string, newPath: string): Promise<void> {
	return invoke<void>("sftp_rename", { key: sessionKey, oldPath, newPath });
}

export async function sftpChmod(sessionKey: string, path: string, mode: number): Promise<void> {
	return invoke<void>("sftp_chmod", { key: sessionKey, path, mode });
}

export async function sftpReadFile(sessionKey: string, path: string): Promise<string> {
	return invoke<string>("sftp_read_file", { key: sessionKey, path });
}

/** 文件当前状态（保存前做冲突检查用；mtime 为秒） */
export interface FileStat {
	exists: boolean;
	isDir: boolean;
	size: number;
	mtime: number;
}

/** 保存冲突：磁盘上的文件在打开后被别人改过。错误文本以此开头，后面是当前 mtime */
export const CONFLICT_PREFIX = "CONFLICT:";

export function conflictMtime(error: unknown): number | null {
	const text = error instanceof Error ? error.message : String(error);
	if (!text.startsWith(CONFLICT_PREFIX)) return null;
	const value = Number(text.slice(CONFLICT_PREFIX.length));
	return Number.isFinite(value) ? value : 0;
}

export async function sftpStat(sessionKey: string, path: string): Promise<FileStat> {
	return invoke<FileStat>("sftp_stat", { key: sessionKey, path });
}

/**
 * 原子保存（先写临时文件再改名替换，保留原权限）。
 * expectedMtime 为打开时记下的修改时间：文件在此之后被改过就抛 CONFLICT 错误；传 null 表示强制覆盖。
 * 返回保存后的新 mtime。
 */
export async function sftpWriteFile(
	sessionKey: string,
	path: string,
	content: string,
	expectedMtime: number | null = null,
): Promise<number> {
	return invoke<number>("sftp_write_file", { key: sessionKey, path, content, expectedMtime });
}

export async function sftpUpload(sessionKey: string, localPath: string, remotePath: string): Promise<number> {
	return invoke<number>("sftp_upload", { key: sessionKey, localPath, remotePath });
}

export async function sftpDownload(sessionKey: string, remotePath: string, localPath: string): Promise<number> {
	return invoke<number>("sftp_download", { key: sessionKey, remotePath, localPath });
}

/* ------------------------------- 本地文件调用 ------------------------------- */

export async function fsLocalList(path: string = ""): Promise<SftpFileEntry[]> {
	return invoke<SftpFileEntry[]>("fs_local_list", { path });
}

export async function fsLocalHome(): Promise<string> {
	return invoke<string>("fs_local_home");
}

export async function fsLocalDrives(): Promise<string[]> {
	return invoke<string[]>("fs_local_drives");
}

export async function fsLocalMkdir(path: string): Promise<void> {
	return invoke<void>("fs_local_mkdir", { path });
}

export async function fsLocalRemove(path: string, isDir: boolean): Promise<void> {
	return invoke<void>("fs_local_remove", { path, isDir });
}

export async function fsLocalRename(oldPath: string, newPath: string): Promise<void> {
	// 本地 rename 会静默覆盖同名目标：先查一下（只改大小写的重命名除外，大小写不敏感的盘上那是同一个文件）
	if (oldPath.toLowerCase() !== newPath.toLowerCase() && (await fsLocalStat(newPath)).exists) {
		throw new Error(`目标已存在：${newPath}`);
	}
	return invoke<void>("fs_local_rename", { oldPath, newPath });
}

export async function fsLocalReadFile(path: string): Promise<string> {
	return invoke<string>("fs_local_read_file", { path });
}

export async function fsLocalStat(path: string): Promise<FileStat> {
	return invoke<FileStat>("fs_local_stat", { path });
}

/** 本地原子保存，语义同 sftpWriteFile */
export async function fsLocalWriteFile(path: string, content: string, expectedMtime: number | null = null): Promise<number> {
	return invoke<number>("fs_local_write_file", { path, content, expectedMtime });
}

/** 新建空文件：同名文件已存在时报错，而不是把它清空 */
export async function sftpCreateEmptyFile(sessionKey: string, path: string): Promise<void> {
	if ((await sftpStat(sessionKey, path)).exists) throw new Error(`已存在同名文件或目录：${path}`);
	await sftpWriteFile(sessionKey, path, "");
}

export async function fsLocalCreateEmptyFile(path: string): Promise<void> {
	if ((await fsLocalStat(path)).exists) throw new Error(`已存在同名文件或目录：${path}`);
	await fsLocalWriteFile(path, "");
}

/* ------------------------------- 工具函数 ------------------------------- */

export function formatUnixTime(timestampSec: number): string {
	if (!timestampSec) return "-";
	const d = new Date(timestampSec * 1000);
	const pad = (n: number) => n.toString().padStart(2, "0");
	const month = pad(d.getMonth() + 1);
	const day = pad(d.getDate());
	const hour = pad(d.getHours());
	const minute = pad(d.getMinutes());
	return `${month}-${day} ${hour}:${minute}`;
}

export function posixJoin(...parts: string[]): string {
	const cleaned = parts
		.map((p, i) => {
			if (i === 0) return p.replace(/\/+$/, "");
			return p.replace(/^\/+|\/+$/g, "");
		})
		.filter((p) => p.length > 0);
	const res = cleaned.join("/");
	return res.startsWith("/") ? res : "/" + res;
}

export function posixDirname(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const idx = normalized.lastIndexOf("/");
	if (idx <= 0) return "/";
	return normalized.slice(0, idx);
}

export function localJoin(parent: string, child: string): string {
	if (parent.includes("\\")) {
		const p = parent.endsWith("\\") ? parent : parent + "\\";
		return p + child.replace(/^[\\/]+/, "");
	}
	const p = parent.endsWith("/") ? parent : parent + "/";
	return p + child.replace(/^[\\/]+/, "");
}

export function localDirname(path: string): string {
	if (path.includes("\\")) {
		const trimmed = path.replace(/\\+$/, "");
		const idx = trimmed.lastIndexOf("\\");
		if (idx <= 2 && trimmed.length >= 2 && trimmed[1] === ":") {
			return trimmed.slice(0, 2) + "\\";
		}
		if (idx < 0) return trimmed;
		return trimmed.slice(0, idx);
	}
	const trimmed = path.replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	if (idx <= 0) return "/";
	return trimmed.slice(0, idx);
}

export function getFileIcon(name: string, isDir: boolean, isSymlink: boolean): string {
	if (isSymlink) return "icon-[lucide--link]";
	if (isDir) return "icon-[lucide--folder]";
	const ext = name.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "ts":
		case "tsx":
		case "js":
		case "jsx":
		case "mjs":
		case "cjs":
			return "icon-[lucide--file-code-2]";
		case "json":
		case "yaml":
		case "yml":
		case "toml":
		case "xml":
		case "ini":
		case "conf":
		case "env":
			return "icon-[lucide--file-cog]";
		case "rs":
		case "go":
		case "py":
		case "c":
		case "cpp":
		case "java":
		case "sh":
		case "bash":
		case "zsh":
			return "icon-[lucide--terminal]";
		case "md":
		case "txt":
		case "rtf":
		case "doc":
		case "docx":
			return "icon-[lucide--file-text]";
		case "png":
		case "jpg":
		case "jpeg":
		case "gif":
		case "svg":
		case "webp":
		case "ico":
			return "icon-[lucide--image]";
		case "zip":
		case "tar":
		case "gz":
		case "bz2":
		case "xz":
		case "7z":
		case "rar":
			return "icon-[lucide--archive]";
		case "mp3":
		case "wav":
		case "ogg":
		case "flac":
			return "icon-[lucide--music]";
		case "mp4":
		case "mkv":
		case "mov":
		case "avi":
			return "icon-[lucide--video]";
		case "pdf":
			return "icon-[lucide--file-text]";
		default:
			return "icon-[lucide--file]";
	}
}
