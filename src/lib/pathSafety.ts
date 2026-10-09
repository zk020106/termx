/* =============================================================================
 * 把**不可信的远程文件名**拼进本地目录前的校验。
 *
 * 远程服务器决定文件名。名字里若带 `../`、`..\`、盘符、绝对路径或保留设备名，
 * 直接拼进下载目录就会写到目录之外（路径穿越）。后端 sftp_download 也会拒绝含 `..` 的路径，
 * 这里在前端先拦一道，给出看得懂的提示。
 *
 * 本文件保持纯函数、无运行时依赖，便于单测。
 * ========================================================================== */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * 远程文件名能否安全地作为本地文件名使用；不行时返回原因。
 * @param windows 本机是不是 Windows：Windows 额外禁止 `<>:"|?*`、保留设备名和结尾的点 / 空格
 */
export function unsafeLocalNameReason(name: string, windows: boolean): string | null {
	if (!name || !name.trim()) return "文件名为空";
	if (name === "." || name === "..") return "文件名不能是 . 或 ..";
	// 两种分隔符都拦：远程是 Linux，本机是 Windows 时 `..\x` 一样能穿越
	if (/[/\\]/.test(name)) return "文件名里含有路径分隔符";
	if (/[\u0000-\u001f]/.test(name)) return "文件名里含有控制字符";
	if (windows) {
		if (/^[A-Za-z]:/.test(name)) return "文件名里含有盘符";
		if (/[<>:"|?*]/.test(name)) return "文件名里含有 Windows 不允许的字符";
		if (WINDOWS_RESERVED.test(name)) return "文件名是 Windows 保留名";
		if (/[. ]$/.test(name)) return "Windows 上文件名不能以点或空格结尾";
	}
	return null;
}

/** 校验通过返回原名；否则抛出带原因的错误 */
export function assertSafeLocalName(name: string, windows: boolean): string {
	const reason = unsafeLocalNameReason(name, windows);
	if (reason) throw new Error(`远程文件名「${name}」不能直接保存到本地：${reason}`);
	return name;
}

/** 给「另存为」对话框用的默认文件名：不安全的字符替换成 `_`，保证预填的位置还在用户选的目录里 */
export function toSafeLocalName(name: string, windows: boolean): string {
	if (unsafeLocalNameReason(name, windows) === null) return name;
	let safe = name.replace(/[/\\\u0000-\u001f]/g, "_");
	if (windows) safe = safe.replace(/[<>:"|?*]/g, "_").replace(/[. ]+$/, "");
	if (windows && WINDOWS_RESERVED.test(safe)) safe = `_${safe}`;
	if (!safe.trim() || safe === "." || safe === "..") safe = "download";
	return safe;
}
