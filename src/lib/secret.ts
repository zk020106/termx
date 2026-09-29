import { isTauri } from "./tauri";

/* 密码持久化：交给操作系统钥匙串（Windows 凭据管理器 / macOS Keychain / Linux Secret Service）。
 * 应用自己不落盘任何明文口令；配置文件里也不会有密码。
 * 默认不保存 —— 只有用户在连接页明确勾选「记住密码」才会写入。 */

function supported(): boolean {
	return isTauri();
}

export async function secretAvailable(): Promise<boolean> {
	if (!supported()) return false;
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		return await invoke<boolean>("secret_available");
	} catch {
		return false;
	}
}

/** 保存密码；失败时抛出，由调用方决定是否提示 */
export async function secretSave(hostId: string, password: string): Promise<void> {
	if (!supported()) throw new Error("钥匙串需要在桌面端运行");
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("secret_save", { hostId, password });
}

/** 读取已保存的密码；没保存过返回 null */
export async function secretLoad(hostId: string): Promise<string | null> {
	if (!supported()) return null;
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
	if (!supported()) return;
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("secret_delete", { hostId });
}
