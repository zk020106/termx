//! 密码持久化：交给操作系统钥匙串，应用自己不落盘任何明文口令。
//!
//! Windows 上是「凭据管理器」，macOS 是 Keychain，Linux 走 Secret Service。
//! 存的是主机 id → 密码；**默认不保存**，只有用户在连接页明确勾选「记住密码」才会写入。
//!
//! 读取失败（没存过 / 钥匙串不可用）一律当作「没有保存过」，不阻断连接流程。
//!
//! 所有命令都是 async + 阻塞线程池：钥匙串调用可能很慢（Linux 上走 D-Bus，
//! 还可能弹出解锁对话框等用户操作），同步命令跑在主线程上会把整个窗口冻住。

use keyring::Entry;

/// 钥匙串里的服务名，与应用的 bundle identifier 保持一致
const SERVICE: &str = "dev.termx.app";

/// 前端可以读写的账户：密钥库的数据密钥 / 私钥口令只给 Rust 用（`key_vault.rs`）
fn guard(account: &str) -> Result<(), String> {
    if crate::key_vault::PROTECTED_PREFIXES.iter().any(|p| account.starts_with(p)) {
        return Err("这个钥匙串条目只允许 TermX 内部使用".to_string());
    }
    Ok(())
}

fn entry(host_id: &str) -> Result<Entry, String> {
    guard(host_id)?;
    Entry::new(SERVICE, host_id).map_err(|e| format!("无法访问系统钥匙串：{e}"))
}

async fn blocking<T: Send + 'static>(job: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| format!("钥匙串操作异常退出：{e}"))
}

#[tauri::command]
pub async fn secret_save(host_id: String, password: String) -> Result<(), String> {
    blocking(move || {
        entry(&host_id)?
            .set_password(&password)
            .map_err(|e| format!("写入系统钥匙串失败：{e}"))
    })
    .await?
}

/// 取密码；没保存过返回 null
#[tauri::command]
pub async fn secret_load(host_id: String) -> Result<Option<String>, String> {
    blocking(move || match entry(&host_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取系统钥匙串失败：{e}")),
    })
    .await?
}

/// 删除已保存的密码；本来就没有也算成功（幂等）
#[tauri::command]
pub async fn secret_delete(host_id: String) -> Result<(), String> {
    blocking(move || match entry(&host_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除系统钥匙串条目失败：{e}")),
    })
    .await?
}

/// 系统钥匙串是否真的可用（用于界面提示，避免把失败说成成功）
#[tauri::command]
pub async fn secret_available() -> bool {
    // 真读一次探针条目：能读到或明确「没有这条」才算可用（Linux 没有 Secret Service 时会在这里失败）
    blocking(|| match entry("__probe__") {
        Ok(e) => matches!(e.get_password(), Ok(_) | Err(keyring::Error::NoEntry)),
        Err(_) => false,
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    #[test]
    fn key_vault_accounts_are_not_reachable_from_the_frontend() {
        assert!(super::guard("key-vault:abc").is_err());
        assert!(super::guard("key-passphrase:abc").is_err());
        assert!(super::guard("identity:abc").is_ok());
        assert!(super::guard("host-1").is_ok());
    }
}
