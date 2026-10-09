//! 密钥库：Netcatty 的「钥匙串」（KeychainManager）里的私钥，在 TermX 里的安全落法。
//!
//! Netcatty 把 `SSHKey.privateKey` 直接放在它的（加密）存储里，导入 / 生成后连接时由主进程使用。
//! TermX 的配置文件是明文 JSON，私钥绝不能进去；而 Windows 凭据管理器单条上限约 2.5KB，
//! 放不下 RSA-4096 的 PEM。所以这里用**信封加密**：
//!
//! - 每把私钥一个随机 256 位数据密钥，存在系统钥匙串（账户 `key-vault:<id>`）；
//! - 私钥原文（保持用户导入 / 生成时的格式，含它自己的口令保护）用 AES-256-GCM 加密后
//!   写进 `<应用配置目录>/keys/<id>.enc`（Unix 上 0600）；
//! - 记住的私钥口令（Netcatty `savePassphrase`）存在钥匙串 `key-passphrase:<id>`。
//!
//! 私钥材料**只在 Rust 里**解开：连接时由 `Credential::StoredKey` 在认证前就地加载，
//! 前端只拿到公钥 / 指纹 / 算法这些公开信息；上面两个钥匙串账户也不允许前端的
//! `secret_load` 读取（见 `secret.rs`）。

use crate::fs_guard;
use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use russh::keys::ssh_key::{self, private::KeypairData, private::RsaKeypair, Algorithm, EcdsaCurve, LineEnding, PrivateKey};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const SERVICE: &str = "dev.termx.app";
/// 前端 `secret_*` 命令不允许碰的钥匙串账户前缀
pub const PROTECTED_PREFIXES: [&str; 2] = ["key-vault:", "key-passphrase:"];

/// 返回给界面的公开信息（Netcatty `SSHKey` 里除 privateKey 之外的那部分）
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    /// OpenSSH 一行公钥（含注释）
    pub public_key: String,
    pub fingerprint: String,
    /// Netcatty 的 KeyType：ED25519 / ECDSA / RSA
    pub key_type: String,
    pub bits: Option<u32>,
    pub comment: String,
    /// 私钥本身是否有口令保护
    pub encrypted: bool,
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("密钥 id 不合法".to_string());
    }
    Ok(())
}

fn vault_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?
        .join("keys");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建密钥目录：{e}"))?;
    Ok(dir)
}

fn vault_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    Ok(vault_dir(app)?.join(format!("{id}.enc")))
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| format!("无法访问系统钥匙串：{e}"))
}

fn keychain_get(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取系统钥匙串失败：{e}")),
    }
}

fn keychain_set(account: &str, value: &str) -> Result<(), String> {
    entry(account)?.set_password(value).map_err(|e| format!("写入系统钥匙串失败：{e}"))
}

fn keychain_delete(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除系统钥匙串条目失败：{e}")),
    }
}

/* ------------------------------ 信封加密 ------------------------------ */

/// 用数据密钥加密：输出 nonce(12) || 密文+tag
pub fn seal(data_key: &[u8; 32], plain: &[u8]) -> Result<Vec<u8>, String> {
    let rng = SystemRandom::new();
    let mut nonce = [0u8; NONCE_LEN];
    rng.fill(&mut nonce).map_err(|_| "生成随机数失败".to_string())?;
    let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, data_key).map_err(|_| "数据密钥无效".to_string())?);
    let mut buf = plain.to_vec();
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(b"termx-key-vault-v1"), &mut buf)
        .map_err(|_| "加密私钥失败".to_string())?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&buf);
    Ok(out)
}

pub fn open(data_key: &[u8; 32], sealed: &[u8]) -> Result<Vec<u8>, String> {
    if sealed.len() < NONCE_LEN + 16 {
        return Err("密钥库文件已损坏".to_string());
    }
    let (nonce, body) = sealed.split_at(NONCE_LEN);
    let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, data_key).map_err(|_| "数据密钥无效".to_string())?);
    let mut buf = body.to_vec();
    let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| "密钥库文件已损坏".to_string())?;
    let plain = key
        .open_in_place(nonce, Aad::from(b"termx-key-vault-v1"), &mut buf)
        .map_err(|_| "密钥库解密失败：文件被改动过，或系统钥匙串里的数据密钥不匹配".to_string())?;
    Ok(plain.to_vec())
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("enc.tmp");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("写入密钥库失败：{e}"))?;
        f.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("写入密钥库失败：{e}"))?;
        f.write_all(bytes).map_err(|e| format!("写入密钥库失败：{e}"))?;
        f.sync_all().map_err(|e| format!("写入密钥库失败：{e}"))?;
    }
    #[cfg(not(unix))]
    std::fs::write(&tmp, bytes).map_err(|e| format!("写入密钥库失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("写入密钥库失败：{e}"))
}

/* ------------------------------ 解析 / 描述 ------------------------------ */

fn key_type_of(alg: &Algorithm) -> String {
    match alg {
        Algorithm::Ed25519 => "ED25519".into(),
        Algorithm::Ecdsa { .. } => "ECDSA".into(),
        Algorithm::Rsa { .. } => "RSA".into(),
        other => other.to_string(),
    }
}

fn bits_of(public: &ssh_key::PublicKey) -> Option<u32> {
    match public.key_data() {
        ssh_key::public::KeyData::Rsa(rsa) => Some(rsa.key_size()),
        ssh_key::public::KeyData::Ecdsa(ec) => Some(match ec.curve() {
            EcdsaCurve::NistP256 => 256,
            EcdsaCurve::NistP384 => 384,
            EcdsaCurve::NistP521 => 521,
        }),
        _ => None,
    }
}

fn info_of(public: &ssh_key::PublicKey, encrypted: bool) -> KeyInfo {
    KeyInfo {
        public_key: public.to_openssh().unwrap_or_default(),
        fingerprint: crate::known_hosts::fingerprint_of(public),
        key_type: key_type_of(&public.algorithm()),
        bits: bits_of(public),
        comment: public.comment().to_string(),
        encrypted,
    }
}

/// 看一眼私钥文本：拿到公钥信息、是否有口令；带了口令就顺便验证口令能解开。
/// 未加密 / OpenSSH 格式加密的私钥不需要口令就能拿到公钥；PEM/PKCS#8/PPK 的加密私钥必须给口令。
pub fn inspect(text: &str, passphrase: Option<&str>) -> Result<KeyInfo, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("私钥内容为空".to_string());
    }
    // OpenSSH 新格式：公钥部分不加密
    if let Ok(parsed) = PrivateKey::from_openssh(text) {
        let encrypted = parsed.is_encrypted();
        if encrypted {
            if let Some(p) = passphrase.filter(|p| !p.is_empty()) {
                parsed.decrypt(p).map_err(|_| "私钥口令不正确".to_string())?;
            }
        }
        return Ok(info_of(parsed.public_key(), encrypted));
    }
    match russh::keys::decode_secret_key(text, None) {
        Ok(key) => Ok(info_of(key.public_key(), false)),
        Err(russh::keys::Error::KeyIsEncrypted) | Err(russh::keys::Error::SshKey(ssh_key::Error::Encrypted)) => {
            let Some(p) = passphrase.filter(|p| !p.is_empty()) else {
                return Err("这把私钥有口令保护，请填写口令后再导入".to_string());
            };
            let key = russh::keys::decode_secret_key(text, Some(p)).map_err(|_| "私钥口令不正确".to_string())?;
            Ok(info_of(key.public_key(), true))
        }
        Err(e) => Err(format!("无法解析私钥：{e}（支持 OpenSSH、PEM、PKCS#8、PuTTY .ppk）")),
    }
}

/* ------------------------------ 存取 ------------------------------ */

fn store(app: &AppHandle, id: &str, text: &str) -> Result<(), String> {
    let path = vault_file(app, id)?;
    let rng = SystemRandom::new();
    let mut data_key = [0u8; 32];
    rng.fill(&mut data_key).map_err(|_| "生成随机数失败".to_string())?;
    let sealed = seal(&data_key, text.as_bytes())?;
    keychain_set(&format!("key-vault:{id}"), &base64::engine::general_purpose::STANDARD.encode(data_key))?;
    write_private(&path, &sealed)
}

/// 取出私钥原文（只在 Rust 内部使用）
pub fn load_text(app: &AppHandle, id: &str) -> Result<String, String> {
    let path = vault_file(app, id)?;
    let sealed = std::fs::read(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "钥匙串里这把密钥没有私钥（只导入了公钥，或已被删除）".to_string(),
        _ => format!("读取密钥库失败：{e}"),
    })?;
    let encoded = keychain_get(&format!("key-vault:{id}"))?
        .ok_or_else(|| "系统钥匙串里找不到这把私钥的数据密钥（钥匙串被清理过？请重新导入私钥）".to_string())?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| "钥匙串里的数据密钥已损坏".to_string())?;
    let data_key: [u8; 32] = raw.try_into().map_err(|_| "钥匙串里的数据密钥已损坏".to_string())?;
    let plain = open(&data_key, &sealed)?;
    String::from_utf8(plain).map_err(|_| "密钥库内容已损坏".to_string())
}

pub fn saved_passphrase(id: &str) -> Option<String> {
    keychain_get(&format!("key-passphrase:{id}")).ok().flatten()
}

/// 私钥本身是否需要口令
pub fn needs_passphrase(text: &str) -> bool {
    match PrivateKey::from_openssh(text.trim()) {
        Ok(k) => k.is_encrypted(),
        Err(_) => matches!(
            russh::keys::decode_secret_key(text.trim(), None),
            Err(russh::keys::Error::KeyIsEncrypted) | Err(russh::keys::Error::SshKey(ssh_key::Error::Encrypted))
        ),
    }
}

pub fn decode(text: &str, passphrase: Option<&str>) -> Result<PrivateKey, String> {
    russh::keys::decode_secret_key(text.trim(), passphrase.filter(|p| !p.is_empty())).map_err(|e| match e {
        russh::keys::Error::KeyIsEncrypted => "这把私钥有口令保护，需要口令".to_string(),
        _ if passphrase.is_some() => "私钥口令不正确".to_string(),
        other => format!("无法解析私钥：{other}"),
    })
}

fn remember_passphrase(id: &str, passphrase: Option<&str>, save: bool) -> Result<(), String> {
    match passphrase.filter(|p| !p.is_empty()) {
        Some(p) if save => keychain_set(&format!("key-passphrase:{id}"), p),
        _ => keychain_delete(&format!("key-passphrase:{id}")),
    }
}

async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| format!("密钥库操作异常退出：{e}"))?
}

/// 导入私钥（Netcatty ImportKeyPanel：粘贴私钥文本，或「从文件导入」读入）。
/// 读本地文件走路径守卫：私钥文件属于敏感文件，要用户在原生对话框里确认。
#[tauri::command]
pub async fn key_vault_import(
    app: AppHandle,
    id: String,
    private_key: Option<String>,
    path: Option<String>,
    passphrase: Option<String>,
    save_passphrase: bool,
) -> Result<KeyInfo, String> {
    valid_id(&id)?;
    let text = match (private_key, path) {
        (Some(text), _) if !text.trim().is_empty() => text,
        (_, Some(path)) => {
            let path = fs_guard::checked_local_path(&path)?;
            fs_guard::confirm_read(&app, &path, "导入私钥").await?;
            let bytes = tokio::fs::read(&path).await.map_err(|e| format!("读取私钥文件失败：{e}"))?;
            if bytes.len() > 64 * 1024 {
                return Err("文件太大，不像私钥".to_string());
            }
            String::from_utf8(bytes).map_err(|_| "私钥文件不是文本".to_string())?
        }
        _ => return Err("请粘贴私钥内容或选择私钥文件".to_string()),
    };
    blocking(move || {
        let info = inspect(&text, passphrase.as_deref())?;
        store(&app, &id, text.trim())?;
        remember_passphrase(&id, passphrase.as_deref(), save_passphrase && info.encrypted)?;
        Ok(info)
    })
    .await
}

/// 生成密钥对（Netcatty `netcatty:key:generate`：ssh2 的 generateKeyPairSync；这里用 russh 自带的 ssh-key）
#[tauri::command]
pub async fn key_vault_generate(
    app: AppHandle,
    id: String,
    key_type: String,
    bits: Option<u32>,
    comment: String,
    passphrase: Option<String>,
    save_passphrase: bool,
) -> Result<KeyInfo, String> {
    valid_id(&id)?;
    blocking(move || {
        let text = generate(&key_type, bits, &comment, passphrase.as_deref())?;
        let info = inspect(&text, passphrase.as_deref())?;
        store(&app, &id, &text)?;
        remember_passphrase(&id, passphrase.as_deref(), save_passphrase)?;
        Ok(info)
    })
    .await
}

pub fn generate(key_type: &str, bits: Option<u32>, comment: &str, passphrase: Option<&str>) -> Result<String, String> {
    let mut rng = rand::rng();
    let mut key = match key_type {
        "ED25519" => PrivateKey::random(&mut rng, Algorithm::Ed25519),
        "ECDSA" => {
            let curve = match bits.unwrap_or(256) {
                256 => EcdsaCurve::NistP256,
                384 => EcdsaCurve::NistP384,
                521 => EcdsaCurve::NistP521,
                other => return Err(format!("ECDSA 不支持 {other} 位")),
            };
            PrivateKey::random(&mut rng, Algorithm::Ecdsa { curve })
        }
        "RSA" => {
            let bits = bits.unwrap_or(4096);
            if !(2048..=8192).contains(&bits) {
                return Err(format!("RSA 位数 {bits} 不合理（2048~8192）"));
            }
            RsaKeypair::random(&mut rng, bits as usize)
                .and_then(|kp| PrivateKey::new(KeypairData::from(kp), ""))
        }
        other => return Err(format!("不支持的密钥类型：{other}")),
    }
    .map_err(|e| format!("生成密钥失败：{e}"))?;
    key.set_comment(comment);
    if let Some(p) = passphrase.filter(|p| !p.is_empty()) {
        key = key.encrypt(&mut rng, p).map_err(|e| format!("加密私钥失败：{e}"))?;
    }
    let text = key.to_openssh(LineEnding::LF).map_err(|e| format!("编码私钥失败：{e}"))?;
    Ok(text.to_string())
}

/// 删除私钥（密钥库文件 + 钥匙串里的数据密钥与口令）
#[tauri::command]
pub async fn key_vault_delete(app: AppHandle, id: String) -> Result<(), String> {
    valid_id(&id)?;
    blocking(move || {
        let path = vault_file(&app, &id)?;
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("删除密钥库文件失败：{e}")),
        }
        keychain_delete(&format!("key-vault:{id}"))?;
        keychain_delete(&format!("key-passphrase:{id}"))
    })
    .await
}

/// 编辑密钥时修改「记住口令」（Netcatty KeychainEditPanel 的 passphrase / savePassphrase）
#[tauri::command]
pub async fn key_vault_set_passphrase(app: AppHandle, id: String, passphrase: Option<String>, save: bool) -> Result<(), String> {
    valid_id(&id)?;
    blocking(move || {
        if save {
            if let Some(p) = passphrase.as_deref().filter(|p| !p.is_empty()) {
                // 先验证口令真能解开这把私钥，免得把错口令存进去
                let text = load_text(&app, &id)?;
                inspect(&text, Some(p))?;
                decode(&text, Some(p))?;
            }
        }
        remember_passphrase(&id, passphrase.as_deref(), save)
    })
    .await
}

/// 这把密钥在本机有没有私钥（界面据此决定「可用于认证」）
#[tauri::command]
pub async fn key_vault_status(app: AppHandle, ids: Vec<String>) -> Result<Vec<bool>, String> {
    blocking(move || {
        Ok(ids
            .iter()
            .map(|id| vault_file(&app, id).map(|p| p.exists()).unwrap_or(false))
            .collect())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_round_trip_and_tamper_detection() {
        let key = [7u8; 32];
        let sealed = seal(&key, b"-----BEGIN OPENSSH PRIVATE KEY-----").unwrap();
        assert_eq!(open(&key, &sealed).unwrap(), b"-----BEGIN OPENSSH PRIVATE KEY-----");
        let mut bad = sealed.clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        assert!(open(&key, &bad).is_err());
        assert!(open(&[8u8; 32], &sealed).is_err());
        // 两次加密 nonce 不同
        assert_ne!(seal(&key, b"x").unwrap(), seal(&key, b"x").unwrap());
    }

    #[test]
    fn generate_and_inspect_all_types() {
        let ed = generate("ED25519", None, "me@termx", None).unwrap();
        let info = inspect(&ed, None).unwrap();
        assert_eq!(info.key_type, "ED25519");
        assert!(info.public_key.starts_with("ssh-ed25519 "));
        assert!(info.public_key.ends_with(" me@termx"));
        assert!(!info.encrypted);
        assert!(decode(&ed, None).is_ok());

        let ec = generate("ECDSA", Some(384), "c", None).unwrap();
        let info = inspect(&ec, None).unwrap();
        assert_eq!((info.key_type.as_str(), info.bits), ("ECDSA", Some(384)));

        let rsa = generate("RSA", Some(2048), "c", None).unwrap();
        let info = inspect(&rsa, None).unwrap();
        assert_eq!((info.key_type.as_str(), info.bits), ("RSA", Some(2048)));
        assert!(generate("RSA", Some(512), "c", None).is_err());
        assert!(generate("DSA", None, "c", None).is_err());
    }

    #[test]
    fn passphrase_protected_keys() {
        let text = generate("ED25519", None, "p", Some("s3cret")).unwrap();
        assert!(needs_passphrase(&text));
        let info = inspect(&text, None).unwrap();
        assert!(info.encrypted);
        assert!(inspect(&text, Some("wrong")).is_err());
        assert!(inspect(&text, Some("s3cret")).is_ok());
        assert!(decode(&text, None).is_err());
        assert!(decode(&text, Some("wrong")).is_err());
        assert!(decode(&text, Some("s3cret")).is_ok());
    }

    #[test]
    fn rejects_garbage_and_bad_ids() {
        assert!(inspect("hello", None).is_err());
        assert!(inspect("", None).is_err());
        assert!(valid_id("../etc").is_err());
        assert!(valid_id("a/b").is_err());
        assert!(valid_id("k_123-abc").is_ok());
    }
}
