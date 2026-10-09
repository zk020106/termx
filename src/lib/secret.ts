import { useSettingsStore } from "@/store/settings";
import { isTauri } from "./tauri";

/* 密码持久化：交给操作系统钥匙串（Windows 凭据管理器 / macOS Keychain / Linux Secret Service）。
 * 应用自己不落盘任何明文口令；配置文件里也不会有密码（见 lib/configSecrets.ts）。
 * 默认不保存 —— 只有用户明确勾选「记住密码」才会写入。
 *
 * 账户名：登录密码用主机 id；代理口令用 `proxy:<主机 id>`。
 *
 * 会话内存：设置页「凭据存系统钥匙串」关掉、或本机钥匙串不可用时，
 * 「记住」的密码只留在本次运行的内存里（设置页的说明就是这么承诺的），退出即失。
 * 钥匙串可用时内存里也留一份，避免同一次运行里反复读钥匙串（Linux 上可能弹解锁框）。 */

const sessionSecrets = new Map<string, string>();

function supported(): boolean {
	return isTauri();
}

/** 钥匙串开关（设置页偏好）关掉时，等同于「本机没有可用的钥匙串」 */
function allowed(): boolean {
	return useSettingsStore.getState().keychain;
}

export async function secretAvailable(): Promise<boolean> {
	if (!supported() || !allowed()) return false;
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		return await invoke<boolean>("secret_available");
	} catch {
		return false;
	}
}

/** 只记在本次运行的内存里（钥匙串不可用 / 已关闭时「记住密码」的落点） */
export function secretRememberForSession(account: string, password: string): void {
	sessionSecrets.set(account, password);
}

/** 保存密码到系统钥匙串；失败时抛出，由调用方决定是否提示。无论成败，本次运行内都可再取到 */
export async function secretSave(account: string, password: string): Promise<void> {
	sessionSecrets.set(account, password);
	if (!allowed()) throw new Error("设置里已关闭系统钥匙串，密码只保留到本次退出");
	if (!supported()) throw new Error("钥匙串需要在桌面端运行");
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("secret_save", { hostId: account, password });
}

/** 读取已保存的密码（先看本次运行的内存，再看钥匙串）；没保存过返回 null */
export async function secretLoad(account: string): Promise<string | null> {
	const cached = sessionSecrets.get(account);
	if (cached !== undefined) return cached;
	if (!supported() || !allowed()) return null;
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		const value = await invoke<string | null>("secret_load", { hostId: account });
		if (value !== null) sessionSecrets.set(account, value);
		return value;
	} catch {
		// 钥匙串不可用就当作没保存，不阻断连接
		return null;
	}
}

/** 删除已保存的密码；本来就没有也算成功 */
export async function secretDelete(account: string): Promise<void> {
	sessionSecrets.delete(account);
	// 关掉钥匙串后仍要允许删除：否则关掉开关就再也清不掉旧密码了
	if (!supported()) return;
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("secret_delete", { hostId: account });
}
