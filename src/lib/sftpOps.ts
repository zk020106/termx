import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { buildExtractCommand, computeExtractTimeoutMs } from "@/lib/sftpArchive";
import {
	fsLocalList,
	fsLocalMkdir,
	fsLocalRename,
	fsLocalStat,
	localDirname,
	localJoin,
	posixDirname,
	posixJoin,
	sftpDownload,
	sftpList,
	sftpMkdir,
	sftpRename,
	sftpStat,
	sftpUpload,
	type SftpFileEntry,
} from "@/lib/sftp";
import { sshExec } from "@/lib/ssh";
import { enqueueTransfers, type TransferRequest } from "@/lib/transferManager";
import { unsafeLocalNameReason } from "@/lib/pathSafety";
import { detectPlatform } from "@/lib/platform";
import { shellQuote } from "@/lib/sftpArchive";
import { toast } from "@/store/toast";

/* =============================================================================
 * SFTP 右键菜单 / 键盘快捷键背后的动作，对齐 Netcatty：
 * - 解压到当前目录：远程走 ssh_exec 跑 archiveExtract 的命令，本地走 Rust fs_local_extract；
 * - 系统默认程序打开 / 打开方式…：远程文件先下到临时目录再打开（Netcatty downloadToTemp），
 *   开了「自动同步」时轮询临时文件，改动后自动传回远程（Netcatty startFileWatch 的等价物）；
 * - 复制到另一侧 / 上传文件夹 / 下载文件夹：目录递归展开后进 termx 的传输队列；
 * - 移动到上级目录 / 移动到…：同一侧 rename；
 * - 剪贴板粘贴：跨栏 = 传输，同栏剪切 = 移动，同栏复制 = 远程 `cp -R` / 本地 fs_local_copy。
 * ========================================================================== */

export type PaneSide = "local" | "remote";

export interface PaneTarget {
	side: PaneSide;
	/** 远程栏的会话 */
	sessionKey?: string | null;
	hostId?: string | null;
}

const isWindows = () => detectPlatform() === "windows";

export function joinIn(target: PaneTarget, dir: string, name: string): string {
	return target.side === "local" ? localJoin(dir, name) : posixJoin(dir, name);
}

export function parentOf(target: PaneTarget, path: string): string {
	return target.side === "local" ? localDirname(path) : posixDirname(path);
}

function requireKey(target: PaneTarget): string {
	if (!target.sessionKey) throw new Error("远程 SFTP 会话未连接");
	return target.sessionKey;
}

/* ------------------------------ 解压 ------------------------------ */

export async function extractArchive(target: PaneTarget, entry: SftpFileEntry): Promise<void> {
	if (target.side === "local") {
		await invoke("fs_local_extract", { path: entry.path });
		return;
	}
	const out = await sshExec(requireKey(target), buildExtractCommand(entry.path), computeExtractTimeoutMs(entry.size));
	if (out.code !== 0) {
		const detail = (out.stderr || out.stdout).trim();
		throw new Error(detail || `exit code ${out.code ?? "?"}`);
	}
}

/* ------------------------------ 打开 ------------------------------ */

export async function fsOpenPath(path: string): Promise<void> {
	await invoke("fs_open_path", { path });
}

export async function fsOpenWith(path: string, application: string): Promise<void> {
	await invoke("fs_open_with", { path, application });
}

/** 让用户在本机挑一个程序（Netcatty selectApplication） */
export async function pickApplication(): Promise<{ path: string; name: string } | null> {
	const selected = await openFileDialog({ multiple: false, directory: false, title: "选择应用程序" });
	if (!selected || Array.isArray(selected)) return null;
	const name = selected.replace(/\\/g, "/").split("/").pop() || selected;
	return { path: selected, name: name.replace(/\.(exe|app)$/i, "") };
}

/** 远程文件下到临时目录（每次一个新目录，不覆盖用户别处的文件） */
async function downloadToTemp(key: string, entry: SftpFileEntry): Promise<string> {
	const local = await invoke<string>("fs_temp_file_path", { name: entry.name });
	await sftpDownload(key, entry.path, local);
	return local;
}

interface Watch {
	timer: ReturnType<typeof setInterval>;
	mtime: number;
	busy: boolean;
}
const watches = new Map<string, Watch>();

/** 自动同步：外部程序保存临时文件后传回远程（轮询 mtime，2 秒一次） */
function startAutoSync(localPath: string, key: string, remotePath: string, name: string) {
	if (watches.has(localPath)) return;
	void fsLocalStat(localPath).then((st) => {
		const watch: Watch = {
			mtime: st.mtime,
			busy: false,
			timer: setInterval(async () => {
				if (watch.busy) return;
				watch.busy = true;
				try {
					const now = await fsLocalStat(localPath);
					if (!now.exists) {
						stopAutoSync(localPath);
						return;
					}
					if (now.mtime !== watch.mtime) {
						watch.mtime = now.mtime;
						await sftpUpload(key, localPath, remotePath);
						toast({ title: `已同步到远程：${name}`, description: remotePath, tone: "success" });
					}
				} catch (error) {
					// 会话断了 / 远程不可写：停掉，避免反复报错
					stopAutoSync(localPath);
					toast({ title: `自动同步已停止：${name}`, description: String(error), tone: "warning" });
				} finally {
					watch.busy = false;
				}
			}, 2000),
		};
		watches.set(localPath, watch);
	});
}

function stopAutoSync(localPath: string) {
	const w = watches.get(localPath);
	if (w) clearInterval(w.timer);
	watches.delete(localPath);
}

export async function openWithSystemDefault(target: PaneTarget, entry: SftpFileEntry, opts: { autoSync: boolean }) {
	if (target.side === "local") {
		await fsOpenPath(entry.path);
		return;
	}
	const key = requireKey(target);
	const local = await downloadToTemp(key, entry);
	await fsOpenPath(local);
	if (opts.autoSync) startAutoSync(local, key, entry.path, entry.name);
}

export async function openWithApplication(
	target: PaneTarget,
	entry: SftpFileEntry,
	application: string,
	opts: { autoSync: boolean },
) {
	if (target.side === "local") {
		await fsOpenWith(entry.path, application);
		return;
	}
	const key = requireKey(target);
	const local = await downloadToTemp(key, entry);
	await fsOpenWith(local, application);
	if (opts.autoSync) startAutoSync(local, key, entry.path, entry.name);
}

/* ------------------------------ 移动 / 复制（同一侧） ------------------------------ */

export async function moveEntries(target: PaneTarget, paths: string[], destDir: string): Promise<number> {
	let moved = 0;
	for (const path of paths) {
		const name = (target.side === "local" ? path.replace(/\\/g, "/") : path).split("/").filter(Boolean).pop();
		if (!name) continue;
		const dest = joinIn(target, destDir, name);
		if (dest === path) continue;
		if (target.side === "local") {
			await fsLocalRename(path, dest);
		} else {
			const key = requireKey(target);
			if ((await sftpStat(key, dest)).exists) throw new Error(`目标已存在：${dest}`);
			await sftpRename(key, path, dest);
		}
		moved++;
	}
	return moved;
}

/** 目录是否存在（「移动到…」校验目标） */
export async function directoryExists(target: PaneTarget, path: string): Promise<boolean> {
	try {
		const st = target.side === "local" ? await fsLocalStat(path) : await sftpStat(requireKey(target), path);
		return st.exists && st.isDir;
	} catch {
		return false;
	}
}

/** 本地「下载」= 在同目录另存一份（Netcatty 本地栏下载走浏览器保存，这里用系统另存为对话框选位置） */
export async function localSaveCopy(source: string, destPath: string): Promise<void> {
	await invoke("fs_local_copy", { source, destDir: localDirname(destPath), destName: destPath.replace(/\\/g, "/").split("/").pop() });
}

export async function copyEntriesSameSide(target: PaneTarget, paths: string[], destDir: string): Promise<void> {
	for (const path of paths) {
		if (target.side === "local") {
			await invoke("fs_local_copy", { source: path, destDir, destName: null });
		} else {
			const key = requireKey(target);
			const name = path.split("/").filter(Boolean).pop() ?? "";
			const dest = posixJoin(destDir, name);
			if ((await sftpStat(key, dest)).exists) throw new Error(`目标已存在：${dest}`);
			const out = await sshExec(key, `cp -R -- ${shellQuote(path)} ${shellQuote(dest)}`, 600_000);
			if (out.code !== 0) throw new Error((out.stderr || out.stdout).trim() || `cp 失败（exit ${out.code}）`);
		}
	}
}

/* ------------------------------ 跨栏传输（含目录递归） ------------------------------ */

const MAX_TREE_FILES = 20_000;

interface TreeFile {
	/** 相对根的路径段 */
	rel: string[];
	path: string;
	size: number;
}

async function walkLocal(root: SftpFileEntry): Promise<{ dirs: string[][]; files: TreeFile[] }> {
	const dirs: string[][] = [[root.name]];
	const files: TreeFile[] = [];
	const queue: { path: string; rel: string[] }[] = [{ path: root.path, rel: [root.name] }];
	while (queue.length) {
		const cur = queue.shift()!;
		for (const e of await fsLocalList(cur.path)) {
			const rel = [...cur.rel, e.name];
			if (e.is_dir) {
				// 目录符号链接不跟进，避免环
				if (e.is_symlink) continue;
				dirs.push(rel);
				queue.push({ path: e.path, rel });
			} else {
				files.push({ rel, path: e.path, size: e.size });
				if (files.length > MAX_TREE_FILES) throw new Error(`文件夹内文件超过 ${MAX_TREE_FILES} 个，请分批传输`);
			}
		}
	}
	return { dirs, files };
}

async function walkRemote(key: string, root: SftpFileEntry): Promise<{ dirs: string[][]; files: TreeFile[] }> {
	const win = isWindows();
	const check = (name: string) => {
		const reason = unsafeLocalNameReason(name, win);
		if (reason) throw new Error(`远程文件名「${name}」不能保存到本地：${reason}`);
	};
	check(root.name);
	const dirs: string[][] = [[root.name]];
	const files: TreeFile[] = [];
	const queue: { path: string; rel: string[] }[] = [{ path: root.path, rel: [root.name] }];
	while (queue.length) {
		const cur = queue.shift()!;
		for (const e of await sftpList(key, cur.path)) {
			if (e.name === "." || e.name === "..") continue;
			check(e.name);
			const rel = [...cur.rel, e.name];
			if (e.is_dir) {
				if (e.is_symlink) continue;
				dirs.push(rel);
				queue.push({ path: e.path, rel });
			} else {
				files.push({ rel, path: e.path, size: e.size });
				if (files.length > MAX_TREE_FILES) throw new Error(`文件夹内文件超过 ${MAX_TREE_FILES} 个，请分批传输`);
			}
		}
	}
	return { dirs, files };
}

async function ensureRemoteDir(key: string, path: string) {
	const st = await sftpStat(key, path);
	if (st.exists) {
		if (!st.isDir) throw new Error(`远程已存在同名文件：${path}`);
		return;
	}
	await sftpMkdir(key, path);
}

async function ensureLocalDir(path: string) {
	const st = await fsLocalStat(path);
	if (st.exists) {
		if (!st.isDir) throw new Error(`本地已存在同名文件：${path}`);
		return;
	}
	await fsLocalMkdir(path);
}

/**
 * 把一组条目从一侧传到另一侧的 destDir（目录递归）。
 * 本地 → 远程 = 上传，远程 → 本地 = 下载；文件进 termx 传输队列（冲突询问、续传、校验都沿用）。
 */
export async function transferEntries(input: {
	from: PaneTarget;
	to: PaneTarget;
	entries: SftpFileEntry[];
	destDir: string;
	/** allDone = 每个文件都传完（无失败 / 跳过 / 暂停 / 取消）；剪切粘贴据此决定是否删源 */
	onFinished?: (result: { allDone: boolean }) => void;
}): Promise<void> {
	const { from, to, entries, destDir } = input;
	if (from.side === to.side) {
		// 同侧（Netcatty 标签可以让两栏都是本地 / 都是远程）：本地 ↔ 本地、同一会话内直接复制；
		// 两个不同远程会话之间走 sftp_copy_between（Netcatty remote-to-remote 传输）
		if (from.side === "local" || from.sessionKey === to.sessionKey) {
			await copyEntriesSameSide(to, entries.map((e) => e.path), destDir);
			toast({ title: "复制完成", description: `${entries.length} 项 → ${destDir}`, tone: "success" });
			input.onFinished?.({ allDone: true });
			return;
		}
		await copyRemoteToRemote(requireKey(from), requireKey(to), entries, destDir);
		input.onFinished?.({ allDone: true });
		return;
	}
	const upload = from.side === "local";
	const key = requireKey(upload ? to : from);
	const hostId = (upload ? to.hostId : from.hostId) ?? "";
	const requests: TransferRequest[] = [];
	const win = isWindows();

	for (const entry of entries) {
		if (!upload) {
			const reason = unsafeLocalNameReason(entry.name, win);
			if (reason) {
				toast({ title: "已跳过不安全的文件名", description: `「${entry.name}」：${reason}`, tone: "danger" });
				continue;
			}
		}
		if (!entry.is_dir) {
			requests.push({
				name: entry.name,
				direction: upload ? "upload" : "download",
				hostId,
				sessionKey: key,
				localPath: upload ? entry.path : localJoin(destDir, entry.name),
				remotePath: upload ? posixJoin(destDir, entry.name) : entry.path,
				size: entry.size,
			});
			continue;
		}
		const tree = upload ? await walkLocal(entry) : await walkRemote(key, entry);
		for (const rel of tree.dirs) {
			if (upload) await ensureRemoteDir(key, posixJoin(destDir, ...rel));
			else await ensureLocalDir(rel.reduce((acc, seg) => localJoin(acc, seg), destDir));
		}
		for (const f of tree.files) {
			const remote = upload ? posixJoin(destDir, ...f.rel) : f.path;
			const local = upload ? f.path : f.rel.reduce((acc, seg) => localJoin(acc, seg), destDir);
			requests.push({
				name: f.rel.join("/"),
				direction: upload ? "upload" : "download",
				hostId,
				sessionKey: key,
				localPath: local,
				remotePath: remote,
				size: f.size,
			});
		}
	}
	if (requests.length === 0) {
		input.onFinished?.({ allDone: entries.length > 0 });
		return;
	}
	let done = 0;
	await enqueueTransfers(requests, {
		onItemDone: () => {
			done++;
		},
		onItemFailed: (item, error) =>
			toast({ title: `${upload ? "上传" : "下载"}失败: ${item.name}`, description: error, tone: "danger" }),
		onFinished: () => {
			toast({ title: `${upload ? "上传" : "下载"}完成`, description: `${requests.length} 个文件 → ${destDir}`, tone: "success" });
			input.onFinished?.({ allDone: done === requests.length });
		},
	});
}

/** 两个不同远程会话之间的复制（目录递归；逐个文件由后端从源 SFTP 读、向目标 SFTP 写） */
async function copyRemoteToRemote(srcKey: string, dstKey: string, entries: SftpFileEntry[], destDir: string): Promise<void> {
	let files = 0;
	let bytes = 0;
	for (const entry of entries) {
		if (!entry.is_dir) {
			bytes += await invoke<number>("sftp_copy_between", {
				srcKey,
				srcPath: entry.path,
				dstKey,
				dstPath: posixJoin(destDir, entry.name),
			});
			files++;
			continue;
		}
		const tree = await walkRemoteTree(srcKey, entry);
		for (const rel of tree.dirs) await ensureRemoteDir(dstKey, posixJoin(destDir, ...rel));
		for (const f of tree.files) {
			bytes += await invoke<number>("sftp_copy_between", { srcKey, srcPath: f.path, dstKey, dstPath: posixJoin(destDir, ...f.rel) });
			files++;
		}
	}
	toast({ title: "复制完成", description: `${files} 个文件（${bytes} 字节）→ ${destDir}`, tone: "success" });
}

/** 远程目录树（不做本地文件名检查：目标也是远程） */
async function walkRemoteTree(key: string, root: SftpFileEntry): Promise<{ dirs: string[][]; files: TreeFile[] }> {
	const dirs: string[][] = [[root.name]];
	const files: TreeFile[] = [];
	const queue: { path: string; rel: string[] }[] = [{ path: root.path, rel: [root.name] }];
	while (queue.length) {
		const cur = queue.shift()!;
		for (const e of await sftpList(key, cur.path)) {
			if (e.name === "." || e.name === "..") continue;
			const rel = [...cur.rel, e.name];
			if (e.is_dir) {
				if (e.is_symlink) continue;
				dirs.push(rel);
				queue.push({ path: e.path, rel });
			} else {
				files.push({ rel, path: e.path, size: e.size });
				if (files.length > MAX_TREE_FILES) throw new Error(`文件夹内文件超过 ${MAX_TREE_FILES} 个，请分批传输`);
			}
		}
	}
	return { dirs, files };
}

/** 本机路径 → SftpFileEntry（「上传文件… / 上传文件夹…」从系统对话框挑出来的路径） */
export async function localEntriesFromPaths(paths: string[]): Promise<SftpFileEntry[]> {
	const out: SftpFileEntry[] = [];
	for (const p of paths) {
		const st = await fsLocalStat(p);
		if (!st.exists) continue;
		out.push({
			name: p.replace(/\\/g, "/").split("/").filter(Boolean).pop() || p,
			path: p,
			is_dir: st.isDir,
			is_symlink: false,
			size: st.size,
			mtime: st.mtime,
			permissions: 0,
			permissions_str: "",
		});
	}
	return out;
}
