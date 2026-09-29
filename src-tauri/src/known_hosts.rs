//! 主机密钥信任（known_hosts）。
//!
//! 策略是 SSH 客户端应有的那一套，不做任何"为了方便就放行"的妥协：
//!   1. 已信任且密钥一致 → 放行
//!   2. 从未见过这台主机 → **拒绝**，把指纹交给用户确认（首次连接确认）
//!   3. 见过但这把密钥不一样 → **拒绝并告警**（可能是服务器重装，也可能是中间人攻击）
//!
//! 存储：TermX 自己目录下的 `known_hosts`，沿用 OpenSSH 的文件格式（由 russh 读写）。
//! 读取时**同时**查 `~/.ssh/known_hosts`，这样你在命令行里已经信任过的主机不必再确认一遍；
//! 但写入只写自己的文件，绝不改动 OpenSSH 的 known_hosts。

use russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path};
use russh::keys::{Error as KeysError, HashAlg, PublicKey};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const FILE: &str = "known_hosts";

pub fn fingerprint_of(key: &PublicKey) -> String {
    format!("{}", key.fingerprint(HashAlg::Sha256))
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建配置目录：{e}"))?;
    Ok(dir.join(FILE))
}

/// OpenSSH 自己的 known_hosts：只读沿用，不写
fn openssh_path() -> Option<PathBuf> {
    std::env::home_dir().map(|home| home.join(".ssh").join("known_hosts"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// 已信任，可以直接连
    Trusted,
    /// 首次连接这台主机，需要用户确认指纹
    Unknown { fingerprint: String },
    /// 指纹与记录不一致，必须拒绝
    Changed { fingerprint: String },
}

impl Verdict {
    /// 供前端判断该引导用户做什么
    pub fn kind(&self) -> Option<&'static str> {
        match self {
            Verdict::Trusted => None,
            Verdict::Unknown { .. } => Some("host_unknown"),
            Verdict::Changed { .. } => Some("host_changed"),
        }
    }

    pub fn fingerprint(&self) -> Option<&str> {
        match self {
            Verdict::Trusted => None,
            Verdict::Unknown { fingerprint } | Verdict::Changed { fingerprint } => Some(fingerprint),
        }
    }
}

fn check_in(path: &Path, host: &str, port: u16, key: &PublicKey) -> Option<Verdict> {
    if !path.exists() {
        return None;
    }
    match check_known_hosts_path(host, port, key, path) {
        Ok(true) => Some(Verdict::Trusted),
        Ok(false) => None,
        // 记录里是另一把钥匙 —— 这是必须拦住的情况
        Err(KeysError::KeyChanged { .. }) => Some(Verdict::Changed {
            fingerprint: fingerprint_of(key),
        }),
        // 文件读不动就当没记录，走首次确认流程（宁可多问一次，也不静默放行）
        Err(_) => None,
    }
}

/// 校验主机密钥：先查 TermX 自己的记录，再查 OpenSSH 的
pub fn verify(app: &AppHandle, host: &str, port: u16, key: &PublicKey) -> Verdict {
    if let Ok(path) = store_path(app) {
        if let Some(verdict) = check_in(&path, host, port, key) {
            return verdict;
        }
    }

    if let Some(path) = openssh_path() {
        if let Some(verdict) = check_in(&path, host, port, key) {
            return verdict;
        }
    }

    Verdict::Unknown {
        fingerprint: fingerprint_of(key),
    }
}

/// 首次连接确认后记录信任
pub fn trust(app: &AppHandle, host: &str, port: u16, key: &PublicKey) -> Result<(), String> {
    let path = store_path(app)?;
    learn_known_hosts_path(host, port, key, &path).map_err(|e| format!("写入 known_hosts 失败：{e}"))
}

/// 替换已保存的指纹：只用于「服务器确实重装过、用户已人工核对」的场景
pub fn replace(app: &AppHandle, host: &str, port: u16, key: &PublicKey) -> Result<usize, String> {
    let path = store_path(app)?;
    let removed = remove_entries(&path, host, port)?;
    learn_known_hosts_path(host, port, key, &path).map_err(|e| format!("写入 known_hosts 失败：{e}"))?;
    Ok(removed)
}

/// 删掉某个主机的所有记录。OpenSSH 的已知项里这个主机的字段是 `host`（默认端口）
/// 或 `[host]:port`（非默认端口），这里按字段精确比对，避免误伤名字相近的主机。
fn remove_entries(path: &Path, host: &str, port: u16) -> Result<usize, String> {
    if !path.exists() {
        return Ok(0);
    }

    let text = std::fs::read_to_string(path).map_err(|e| format!("读取 known_hosts 失败：{e}"))?;
    let targets = [host.to_string(), format!("[{host}]:{port}")];

    let mut removed = 0usize;
    let kept: Vec<&str> = text
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return true;
            }
            let field = trimmed.split_whitespace().next().unwrap_or("");
            let hit = targets.iter().any(|t| t == field);
            if hit {
                removed += 1;
            }
            !hit
        })
        .collect();

    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    std::fs::write(path, out.as_bytes()).map_err(|e| format!("写回 known_hosts 失败：{e}"))?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path};

    /// 两把真实生成的 ed25519 公钥，仅作测试夹具。
    ///
    /// 注意：这里刻意**不带注释**。russh 解析 known_hosts 时只取 `<算法> <base64>`，
    /// 回头用 `PublicKey` 相等比较时，注释是参与比较的 —— 夹具若带注释，
    /// 同一把钥匙也会被判成「指纹变化」。真实握手时服务器发来的公钥本来就没有注释，
    /// 所以生产路径不受影响，但夹具必须与之一致。
    const KEY_A: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMA6n+DQWVPOxphqrRcQRfq6san3Tlu/Sevut+ELlKjJ";
    const KEY_B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC3qHhWjgK6jCQ45pmQUhuW+ECM2RsatUtFIp8wXXNI3";

    fn temp_file(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("termx-kh-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn key_a() -> PublicKey {
        KEY_A.parse().expect("夹具公钥 A 应可解析")
    }

    fn key_b() -> PublicKey {
        KEY_B.parse().expect("夹具公钥 B 应可解析")
    }

    fn fresh_path(name: &str) -> PathBuf {
        let path = temp_file(name);
        let _ = std::fs::remove_file(&path);
        path
    }

    /// 这是整套信任策略的基石：未知要问、命中要放行、变了必须拦
    #[test]
    fn trust_policy_separates_unknown_trusted_and_changed() {
        let path = fresh_path("policy");

        // 从没见过这台主机
        assert_eq!(check_in(&path, "host.example", 22, &key_a()), None);

        // 记录之后应判定为已信任
        learn_known_hosts_path("host.example", 22, &key_a(), &path).unwrap();
        assert_eq!(
            check_in(&path, "host.example", 22, &key_a()),
            Some(Verdict::Trusted)
        );

        // 换成另一把钥匙 —— 必须报「变了」，绝不能当成未知而放行
        match check_in(&path, "host.example", 22, &key_b()) {
            Some(Verdict::Changed { fingerprint }) => {
                assert!(fingerprint.starts_with("SHA256:"), "指纹格式异常：{fingerprint}");
            }
            other => panic!("指纹变化应判定为 Changed，实际是 {other:?}"),
        }

        // 另一台主机不受影响
        assert_eq!(check_in(&path, "other.example", 22, &key_a()), None);
    }

    /// 底层库的行为也要钉住：不同密钥必须报 KeyChanged，否则我们的策略会失效
    #[test]
    fn russh_reports_key_changed_for_different_key() {
        let path = fresh_path("russh-behaviour");
        std::fs::write(&path, b"").unwrap();

        assert!(!check_known_hosts_path("host.example", 22, &key_a(), &path).unwrap());

        learn_known_hosts_path("host.example", 22, &key_a(), &path).unwrap();
        assert!(check_known_hosts_path("host.example", 22, &key_a(), &path).unwrap());

        match check_known_hosts_path("host.example", 22, &key_b(), &path) {
            Err(KeysError::KeyChanged { .. }) => {}
            other => panic!("应报 KeyChanged，实际 {other:?}"),
        }
    }

    #[test]
    fn remove_entries_only_touches_matching_host() {
        let path = fresh_path("known_hosts");
        std::fs::write(
            &path,
            "10.0.3.21 ssh-ed25519 AAAA\n[10.0.3.21]:2222 ssh-ed25519 BBBB\n10.0.3.210 ssh-ed25519 CCCC\n# 注释保留\n",
        )
        .unwrap();

        // 只应删掉 10.0.3.21 的两条（默认端口 + 指定端口），不能碰到 10.0.3.210
        let removed = remove_entries(&path, "10.0.3.21", 2222).unwrap();
        assert_eq!(removed, 2);

        let left = std::fs::read_to_string(&path).unwrap();
        assert!(left.contains("10.0.3.210"), "名字相近的主机被误删了");
        assert!(left.contains("# 注释保留"), "注释不应被删除");
        assert!(!left.contains("10.0.3.21 ssh-ed25519 AAAA"));
    }

    #[test]
    fn remove_entries_on_missing_file_is_noop() {
        let path = fresh_path("does-not-exist");
        assert_eq!(remove_entries(&path, "example.com", 22).unwrap(), 0);
    }
}
