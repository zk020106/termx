import { useSettingsStore } from "@/store/settings";
import { isTauri } from "./tauri";

/* 密码持久化：交给操作系统钥匙串（Windows 凭据管理器 / macOS Keychain / Linux Secret Service）。
 * 应用自己不落盘任何明文口令；配置文件里也不会有密码。
 * 默认不保存 —— 只有用户在连接页明确勾选「记住密码」才会写入。
 * 设置页的「凭据存系统钥匙串」关掉后，这里既不读也不写：密码只留在当前会话内存里。 */

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

/** 保存密码；失败时抛出，由调用方决定是否提示 */
export async function secretSave(hostId: string, password: string): Promise<void> {
	if (!allowed()) throw new Error("设置里已关闭系统钥匙串，密码不会保存");
	if (!supported()) throw new Error("钥匙串需要在桌面端运行");
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("secret_save", { hostId, password });
}

/** 读取已保存的密码；没保存过返回 null */
export async function secretLoad(hostId: string): Promise<string | null> {
	if (!supported() || !allowed()) return null;
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		return await invoke<string | null>("secret_load", { hostId });
	} catch {
		// 钥匙串不可用就当作没保存，不阻断连接
		return null;
	}
}

/** 删除已保存的密码；本来就没有也算成功 */
export async function secretDelete(hostId: string): Promise<void> {
	// 关掉钥匙串后仍要允许删除：否则关掉开关就再也清不掉旧密码了
	if (!supported()) return;
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("secret_delete", { hostId });
}
