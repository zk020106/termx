import { useSettingsStore } from "@/store/settings";

/* 敏感内容复制（密码等）。
 * 设置页「复制密码后清空剪贴板」打开时：写进剪贴板的同时起一个真实计时器，
 * 到期把剪贴板清空。
 * 刻意**不读**剪贴板来判断内容是否还是我们写的那份：WebView2 读剪贴板会弹权限提示，
 * 为了一个后台计时器打扰用户不值当，因此按设置的承诺直接清空。 */

export const SENSITIVE_CLEAR_MS = 30_000;

/** 写剪贴板：优先剪贴板 API，未聚焦被权限提示挂住时退回 execCommand */
async function writeClipboard(text: string): Promise<boolean> {
	const clipboard = navigator.clipboard;
	if (!clipboard) return legacyCopy(text);
	const viaApi = clipboard.writeText(text).then(
		() => true,
		() => false,
	);
	// WebView2 在窗口没有焦点时会弹权限提示并一直挂起：等 1.5 秒就改用不需要权限的老接口，
	// 免得按钮点了没有任何结果
	return Promise.race([
		viaApi,
		new Promise<boolean>((resolve) => window.setTimeout(() => resolve(legacyCopy(text)), 1500)),
	]);
}

/** execCommand 兜底：不需要剪贴板权限，WebView2 里也不会弹提示 */
function legacyCopy(text: string): boolean {
	try {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
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

async function clearClipboard(onCleared?: () => void): Promise<void> {
	// 窗口有焦点时用剪贴板 API 写空串 —— 这才是真正的「空」；
	// 没有焦点时不碰 API（WebView2 会弹权限提示并挂住），直接走下面的兜底。
	if (document.hasFocus() && navigator.clipboard) {
		try {
			await navigator.clipboard.writeText("");
			onCleared?.();
			return;
		} catch {
			/* 落到兜底 */
		}
	}
	// 兜底：execCommand 拒绝复制空串（实测返回 false），所以写一个空格 ——
	// 至少不会把密码留在剪贴板里
	if (legacyCopy(" ")) onCleared?.();
}

/** 复制敏感内容：返回是否写成功；按偏好安排 30 秒后的自动清空 */
export async function copySensitive(text: string, onCleared?: () => void): Promise<boolean> {
	if (!text) return false;
	const ok = await writeClipboard(text);
	if (!ok) return false;
	if (useSettingsStore.getState().clearClipboard) {
		window.setTimeout(() => void clearClipboard(onCleared), SENSITIVE_CLEAR_MS);
	}
	return true;
}
