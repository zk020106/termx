//! 密码持久化：交给操作系统钥匙串，应用自己不落盘任何明文口令。
//!
//! Windows 上是「凭据管理器」，macOS 是 Keychain，Linux 走 Secret Service。
//! 存的是主机 id → 密码；**默认不保存**，只有用户在连接页明确勾选「记住密码」才会写入。
//!
//! 读取失败（没存过 / 钥匙串不可用）一律当作「没有保存过」，不阻断连接流程。

use keyring::Entry;

/// 钥匙串里的服务名，与应用的 bundle identifier 保持一致
const SERVICE: &str = "dev.termx.app";

fn entry(host_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, host_id).map_err(|e| format!("无法访问系统钥匙串：{e}"))
}

#[tauri::command]
pub fn secret_save(host_id: String, password: String) -> Result<(), String> {
    entry(&host_id)?
        .set_password(&password)
        .map_err(|e| format!("写入系统钥匙串失败：{e}"))
}

/// 取密码；没保存过返回 null
#[tauri::command]
pub fn secret_load(host_id: String) -> Result<Option<String>, String> {
    match entry(&host_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取系统钥匙串失败：{e}")),
    }
}

/// 删除已保存的密码；本来就没有也算成功（幂等）
#[tauri::command]
pub fn secret_delete(host_id: String) -> Result<(), String> {
    match entry(&host_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除系统钥匙串条目失败：{e}")),
    }
}

/// 系统钥匙串是否真的可用（用于界面提示，避免把失败说成成功）
#[tauri::command]
pub fn secret_available() -> bool {
    entry("__probe__").is_ok()
}
