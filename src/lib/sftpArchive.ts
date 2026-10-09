/* =============================================================================
 * SFTP 右键「解压到当前目录」与文件类型判断 —— 移植自 Netcatty（GPL-3.0-or-later）：
 * - domain/sftpArchive.ts（getSftpArchiveKind / isExtractableArchive）
 * - electron/bridges/sftpBridge/archiveExtract.cjs（远程解压命令：buildExtractCommand 等）
 * - electron/bridges/sftpBridge/scpShell.cjs（shellQuote / assertSafeRemotePath）
 * - lib/sftpFileUtils.ts（getFileExtension / isKnownBinaryFile）
 * - components/sftp/hooks/useSftpPaneDialogs.ts（getNextUntitledName）
 * 纯函数，不碰 SSH；远程命令经 termx 的 ssh_exec 执行（见 lib/sftpOps.ts）。
 * ========================================================================== */

const ARCHIVE_SUFFIXES: Array<{ kind: string; suffixes: string[] }> = [
	{ kind: "tar.gz", suffixes: [".tar.gz", ".tgz"] },
	{ kind: "tar.bz2", suffixes: [".tar.bz2", ".tbz2", ".tar.bzip2"] },
	{ kind: "tar.xz", suffixes: [".tar.xz", ".txz"] },
	{ kind: "tar.zst", suffixes: [".tar.zst", ".tzst"] },
	{ kind: "tar", suffixes: [".tar"] },
	{ kind: "zip", suffixes: [".zip"] },
	{ kind: "gz", suffixes: [".gz"] },
	{ kind: "bz2", suffixes: [".bz2"] },
	{ kind: "xz", suffixes: [".xz"] },
];

const EXTRACT_BASE_TIMEOUT_MS = 60_000;
export const EXTRACT_MAX_TIMEOUT_MS = 10 * 60_000;

function archiveBaseName(fileName: string): string {
	const normalized = String(fileName || "").replace(/\\/g, "/");
	const parts = normalized.split("/");
	return parts[parts.length - 1] || "";
}

export function getSftpArchiveKind(fileName: string): string | null {
	const base = archiveBaseName(fileName).toLowerCase();
	if (!base) return null;
	for (const entry of ARCHIVE_SUFFIXES) {
		if (entry.suffixes.some((suffix) => base.endsWith(suffix) && base.length > suffix.length)) {
			return entry.kind;
		}
	}
	return null;
}

export function isExtractableArchive(fileName: string): boolean {
	return getSftpArchiveKind(fileName) != null;
}

/** POSIX sh 单引号转义（scpShell.cjs shellQuote） */
export function shellQuote(value: string, { allowEmpty = false } = {}): string {
	const str = String(value);
	if (str.includes("\0")) throw new Error("Shell argument must not contain NUL");
	if (!allowEmpty && str.length === 0) throw new Error("Shell argument must not be empty");
	return `'${str.replace(/'/g, `'\\''`)}'`;
}

export function assertSafeRemotePath(remotePath: string): string {
	if (typeof remotePath !== "string" || !remotePath) throw new Error("Remote path is required");
	if (remotePath.includes("\0") || /[\r\n]/.test(remotePath)) {
		throw new Error("Remote path must not contain NUL or newlines");
	}
	return remotePath;
}

export function posixParentDir(remotePath: string): string {
	const normalized = String(remotePath || "").replace(/\\/g, "/");
	if (!normalized || normalized === "/" || normalized === ".") {
		throw new Error("Archive path has no parent directory");
	}
	const trimmed = normalized.replace(/\/+$/, "") || "/";
	if (trimmed === "/") throw new Error("Archive path has no parent directory");
	const idx = trimmed.lastIndexOf("/");
	if (idx < 0) return ".";
	if (idx === 0) return "/";
	return trimmed.slice(0, idx);
}

export function stripCompressionSuffix(filePath: string, kind: string): string {
	const suffix = kind === "gz" ? ".gz" : kind === "bz2" ? ".bz2" : kind === "xz" ? ".xz" : "";
	if (!suffix) throw new Error(`Cannot strip suffix for archive kind: ${kind}`);
	const base = archiveBaseName(filePath);
	if (base.length <= suffix.length || !base.toLowerCase().endsWith(suffix)) {
		throw new Error(`Archive name does not match kind ${kind}`);
	}
	const parent = posixParentDir(filePath);
	const stem = base.slice(0, base.length - suffix.length);
	if (parent === "/") return `/${stem}`;
	if (parent === ".") return stem;
	return `${parent}/${stem}`;
}

export function computeExtractTimeoutMs(archiveSize: number): number {
	const size = Number(archiveSize);
	if (!Number.isFinite(size) || size <= 0) return EXTRACT_MAX_TIMEOUT_MS;
	const extra = Math.ceil(size / (10 * 1024 * 1024)) * 30_000;
	return Math.min(EXTRACT_MAX_TIMEOUT_MS, Math.max(EXTRACT_BASE_TIMEOUT_MS, EXTRACT_BASE_TIMEOUT_MS + extra));
}

function buildSingleFileExtractCommand(decoder: string, qArchive: string, outputPath: string): string {
	const qOut = shellQuote(outputPath);
	return [
		"set -e",
		`out=${qOut}`,
		`archive=${qArchive}`,
		"n=0",
		"stage=",
		'while [ "$n" -lt 32 ]; do',
		'  candidate="$out.termx-extract.$$.$n"',
		'  if (umask 077; set -C; : > "$candidate") 2>/dev/null; then',
		'    stage="$candidate"',
		"    break",
		"  fi",
		"  n=$((n + 1))",
		"done",
		'if [ -z "$stage" ]; then',
		"  echo 'could not allocate extraction staging file' >&2",
		"  exit 1",
		"fi",
		"trap 'rm -f -- \"$stage\"' EXIT",
		`${decoder} -dc -- "$archive" > "$stage"`,
		'if [ -d "$out" ]; then',
		"  echo 'extraction target is a directory' >&2",
		"  exit 1",
		"fi",
		'mv -f -- "$stage" "$out"',
		"trap - EXIT",
	].join("\n");
}

/** 远程解压命令：解到压缩包所在目录（archiveExtract.cjs buildExtractCommand） */
export function buildExtractCommand(archivePath: string): string {
	const kind = getSftpArchiveKind(archivePath);
	if (!kind) throw new Error(`Unsupported archive type: ${archiveBaseName(archivePath) || archivePath}`);
	const remotePath = assertSafeRemotePath(archivePath);
	const parent = posixParentDir(remotePath);
	const qArchive = shellQuote(remotePath);
	const qParent = shellQuote(parent);

	if (kind === "tar") return `tar -xf ${qArchive} -C ${qParent}`;
	if (kind === "tar.gz") return `tar -xzf ${qArchive} -C ${qParent}`;
	if (kind === "tar.bz2") return `tar -xjf ${qArchive} -C ${qParent}`;
	if (kind === "tar.xz") return `tar -xJf ${qArchive} -C ${qParent}`;
	if (kind === "tar.zst") return `tar --zstd -xf ${qArchive} -C ${qParent}`;
	if (kind === "zip") {
		return [
			"if command -v unzip >/dev/null 2>&1; then",
			`  unzip -qo ${qArchive} -d ${qParent} >/dev/null`,
			`elif tar -tf ${qArchive} >/dev/null 2>&1; then`,
			`  tar -xf ${qArchive} -C ${qParent}`,
			"else",
			"  echo 'unzip is not installed on the remote host' >&2",
			"  exit 127",
			"fi",
		].join("\n");
	}
	const outputPath = stripCompressionSuffix(remotePath, kind);
	const decoder = kind === "gz" ? "gzip" : kind === "bz2" ? "bzip2" : kind === "xz" ? "xz" : null;
	if (!decoder) throw new Error(`Unsupported archive type: ${kind}`);
	return buildSingleFileExtractCommand(decoder, qArchive, outputPath);
}

/* ------------------------------ 文件类型 ------------------------------ */

const BINARY_EXTENSIONS = new Set([
	"jpg", "jpeg", "png", "gif", "bmp", "webp", "ico", "tiff", "tif",
	"heic", "heif", "avif", "jfif", "psd", "ai", "eps", "raw", "cr2", "nef",
	"mp3", "wav", "flac", "aac", "ogg", "wma", "m4a", "aiff", "opus",
	"mp4", "avi", "mkv", "mov", "wmv", "flv", "webm", "m4v", "3gp", "mpeg", "mpg",
	"zip", "rar", "7z", "tar", "gz", "bz2", "xz", "lz", "lzma", "zst",
	"tgz", "tbz2", "txz", "cab", "iso", "dmg",
	"exe", "dll", "so", "dylib", "bin", "app", "msi", "deb", "rpm",
	"apk", "ipa", "jar", "war", "ear",
	"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
	"ttf", "otf", "woff", "woff2", "eot",
	"db", "sqlite", "sqlite3", "mdb", "accdb",
	"o", "obj", "pyc", "pyo", "class", "beam",
	"swf", "fla", "blend", "unity3d", "unitypackage",
]);

/** 没有扩展名时返回 "file"（Netcatty getFileExtension） */
export function getFileExtension(fileName: string): string {
	const lastDot = fileName.lastIndexOf(".");
	if (lastDot === -1 || lastDot === 0) return "file";
	return fileName.slice(lastDot + 1).toLowerCase();
}

export function hasFileExtension(fileName: string): boolean {
	return fileName.lastIndexOf(".") > 0;
}

/** 已知二进制格式：右键里不出现「编辑」 */
export function isKnownBinaryFile(fileName: string): boolean {
	return BINARY_EXTENSIONS.has(getFileExtension(fileName));
}

/** 新建文件的默认名：untitled.txt、untitled (1).txt…（大小写不敏感去重） */
export function getNextUntitledName(existingFiles: string[]): string {
	const existingSet = new Set(existingFiles.map((f) => f.toLowerCase()));
	if (!existingSet.has("untitled.txt")) return "untitled.txt";
	for (let counter = 1; counter < 1000; counter++) {
		const name = `untitled (${counter}).txt`;
		if (!existingSet.has(name.toLowerCase())) return name;
	}
	return `untitled_${Date.now()}.txt`;
}

/* ------------------------------ 剪贴板粘贴守卫（samePanePaste） ------------------------------ */

function normalizePosix(path: string): string {
	const parts: string[] = [];
	for (const seg of path.replace(/\\/g, "/").split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return `/${parts.join("/")}`;
}

/**
 * 同一栏内粘贴的守卫（Netcatty resolveSameConnectionPasteAction 的路径部分）：
 * 剪切到原目录 → block-same-folder；把文件夹粘进自己或子目录 → block-into-source。
 * 本地路径在 Windows 下大小写不敏感。
 */
export function resolveSamePanePaste(input: {
	operation: "copy" | "cut";
	sourcePath: string;
	targetPath: string;
	files: { name: string; isDirectory: boolean }[];
	caseInsensitive?: boolean;
}): "allow" | "block-same-folder" | "block-into-source" {
	const norm = (p: string) => {
		const n = normalizePosix(p);
		return input.caseInsensitive ? n.toLowerCase() : n;
	};
	const src = norm(input.sourcePath);
	const dst = norm(input.targetPath);
	if (input.operation === "cut" && src === dst) return "block-same-folder";
	for (const f of input.files) {
		if (!f.isDirectory) continue;
		const folder = norm(`${input.sourcePath}/${f.name}`);
		if (dst === folder || dst.startsWith(`${folder}/`)) return "block-into-source";
	}
	return "allow";
}

/* ------------------------------ 键盘输入查找（sftpTypeahead） ------------------------------ */

export interface TypeaheadState {
	query: string;
	lastInputAt: number;
}

const SFTP_TYPEAHEAD_RESET_MS = 1000;

/** 连续键入前缀选中第一个匹配的文件名；停顿超过 1 秒重新开始（Netcatty advanceSftpTypeahead） */
export function advanceTypeahead(
	names: string[],
	previous: TypeaheadState | null,
	key: string,
	now: number,
): { state: TypeaheadState; matchIndex: number } {
	const continuesPrevious = previous && now - previous.lastInputAt <= SFTP_TYPEAHEAD_RESET_MS;
	const query = `${continuesPrevious ? previous.query : ""}${key}`.toLocaleLowerCase();
	return {
		state: { query, lastInputAt: now },
		matchIndex: names.findIndex((name) => name.toLocaleLowerCase().startsWith(query)),
	};
}
