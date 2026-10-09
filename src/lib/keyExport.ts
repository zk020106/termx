import { shellQuote } from "./sftpArchive";

/* =============================================================================
 * 密钥右键「导出密钥」—— 对齐 Netcatty KeychainExportPanel（GPL-3.0-or-later）：
 * 在目标主机上跑同一段导出脚本，把公钥追加到 ~/$1/$2（默认 ~/.ssh/authorized_keys），
 * 目录不存在先建 700、文件不存在先建 600。
 *
 * 与 Netcatty 的差别：
 * - Netcatty 把 $1/$2/$3 文本替换进脚本；这里改为 `sh -c 脚本 sh 位置 文件名 公钥` 传位置参数，
 *   位置 / 文件名里有引号或 $ 也不会被当成 shell 代码；
 * - 保留 termx 原界面承诺的两点：已存在完全相同的一行就跳过；追加前把原文件备份为 .bak；
 * - 原文件末尾没有换行时先补一个，避免和上一行粘在一起（Netcatty 用 echo 追加会粘行）。
 * ========================================================================== */

export const KEY_EXPORT_SCRIPT = [
	'DIR="$HOME/$1"',
	'FILE="$DIR/$2"',
	'if [ ! -d "$DIR" ]; then',
	'  mkdir -p "$DIR"',
	'  chmod 700 "$DIR"',
	"fi",
	'if [ ! -f "$FILE" ]; then',
	'  touch "$FILE"',
	'  chmod 600 "$FILE"',
	"fi",
	'if grep -qxF -- "$3" "$FILE"; then',
	"  echo 'termx: public key already present'",
	"  exit 0",
	"fi",
	'if [ -s "$FILE" ]; then',
	'  cp -p -- "$FILE" "$FILE.bak"',
	'  if [ -n "$(tail -c 1 -- "$FILE")" ]; then echo >> "$FILE"; fi',
	"fi",
	`printf '%s\\n' "$3" >> "$FILE"`,
].join("\n");

export function validateKeyExportTarget(location: string, filename: string): string | null {
	if (!location.trim()) return "位置不能为空";
	if (!filename.trim()) return "文件名不能为空";
	if (/[\r\n\0]/.test(location) || /[\r\n\0]/.test(filename)) return "位置 / 文件名不能包含换行";
	if (filename.includes("/")) return "文件名不能包含 /";
	return null;
}

export function buildKeyExportCommand(location: string, filename: string, publicKey: string): string {
	const err = validateKeyExportTarget(location, filename);
	if (err) throw new Error(err);
	const key = publicKey.trim();
	if (!key || /[\r\n\0]/.test(key)) throw new Error("公钥必须是单行");
	return `sh -c ${shellQuote(KEY_EXPORT_SCRIPT)} sh ${shellQuote(location.trim())} ${shellQuote(filename.trim())} ${shellQuote(key)}`;
}
