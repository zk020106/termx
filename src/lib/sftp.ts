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

export async function sftpWriteFile(sessionKey: string, path: string, content: string): Promise<void> {
	return invoke<void>("sftp_write_file", { key: sessionKey, path, content });
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
	return invoke<void>("fs_local_rename", { oldPath, newPath });
}

export async function fsLocalReadFile(path: string): Promise<string> {
	return invoke<string>("fs_local_read_file", { path });
}

export async function fsLocalWriteFile(path: string, content: string): Promise<void> {
	return invoke<void>("fs_local_write_file", { path, content });
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
