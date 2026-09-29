import { useSettingsStore } from "@/store/settings";

/* 敏感内容复制（密码等）。
 * 设置页「复制密码后清空剪贴板」打开时：写进剪贴板的同时起一个真实计时器，
 * 到期后把剪贴板清空 —— 能读到剪贴板时只在内容仍是我们写进去的那份才清，
 * 免得把用户中途复制的别的东西删掉。 */

export const SENSITIVE_CLEAR_MS = 30_000;

/** 写剪贴板；非安全上下文里退回 execCommand */
async function writeClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		try {
			const area = document.createElement("textarea");
			area.value = text;
			area.style.position = "fixed";
			area.style.opacity = "0";
			document.body.appendChild(area);
			area.select();
			const ok = document.execCommand("copy");
			area.remove();
			return ok;
		} catch {
			return false;
		}
	}
}

async function clearClipboardAfter(text: string, onCleared?: () => void): Promise<void> {
	try {
		const current = await navigator.clipboard.readText();
		// 用户中途复制了别的内容：不清，避免误删
		if (current !== text) return;
	} catch {
		// 读不到剪贴板（没有读取权限）就按设置的承诺直接清空
	}
	try {
		await navigator.clipboard.writeText("");
		onCleared?.();
	} catch {
		/* 清不掉就作罢，不打扰用户 */
	}
}

/** 复制敏感内容：返回是否写成功；按偏好安排 30 秒后的自动清空 */
export async function copySensitive(text: string, onCleared?: () => void): Promise<boolean> {
	if (!text) return false;
	const ok = await writeClipboard(text);
	if (!ok) return false;
	if (useSettingsStore.getState().clearClipboard) {
		window.setTimeout(() => void clearClipboardAfter(text, onCleared), SENSITIVE_CLEAR_MS);
	}
	return true;
}
