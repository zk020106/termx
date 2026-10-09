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

use russh::keys::known_hosts::learn_known_hosts_path;
use russh::keys::{HashAlg, PublicKey};
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
    /// 无法完成校验：known_hosts 读不了、这台主机的记录解析不了、或这把钥匙被标记为 @revoked。
    /// 既不能当「已信任」放行，也**不能**降级成「首次连接」让用户一键信任 —— 那等于绕过已有记录。
    CheckFailed { fingerprint: String, reason: String },
}

impl Verdict {
    /// 供前端判断该引导用户做什么
    pub fn kind(&self) -> Option<&'static str> {
        match self {
            Verdict::Trusted => None,
            Verdict::Unknown { .. } => Some("host_unknown"),
            Verdict::Changed { .. } => Some("host_changed"),
            Verdict::CheckFailed { .. } => Some("host_check_failed"),
        }
    }

    pub fn fingerprint(&self) -> Option<&str> {
        match self {
            Verdict::Trusted => None,
            Verdict::Unknown { fingerprint }
            | Verdict::Changed { fingerprint }
            | Verdict::CheckFailed { fingerprint, .. } => Some(fingerprint),
        }
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            Verdict::CheckFailed { reason, .. } => Some(reason),
            _ => None,
        }
    }
}

/// OpenSSH 的主机字段：默认端口写 `host`，其他端口写 `[host]:port`
fn host_field(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// `*` / `?` 通配（OpenSSH 的主机模式），不区分大小写
fn glob_match(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], t) || (!t.is_empty() && go(p, &t[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &t[1..]),
            (Some(a), Some(b)) => a == b && go(&p[1..], &t[1..]),
            _ => false,
        }
    }
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    go(&p, &t)
}

/// `|1|<salt>|<hash>`：HMAC-SHA1(salt, 主机字段) 比对
fn hashed_match(entry: &str, field: &str) -> bool {
    use base64::Engine;
    use hmac::{Hmac, KeyInit, Mac};
    let mut parts = entry.trim_start_matches("|1|").split('|');
    let (Some(salt), Some(hash)) = (parts.next(), parts.next()) else {
        return false;
    };
    let b64 = base64::engine::general_purpose::STANDARD;
    let (Ok(salt), Ok(hash)) = (b64.decode(salt), b64.decode(hash)) else {
        return false;
    };
    let Ok(mac) = <Hmac<sha1::Sha1> as KeyInit>::new_from_slice(&salt) else {
        return false;
    };
    mac.chain_update(field.as_bytes()).verify_slice(&hash).is_ok()
}

/// 一行的主机列表（逗号分隔，可带 `!` 否定、通配、哈希）是否命中
fn hosts_match(patterns: &str, field: &str) -> bool {
    let mut hit = false;
    for entry in patterns.split(',') {
        let (negated, pat) = match entry.strip_prefix('!') {
            Some(rest) => (true, rest),
            None => (false, entry),
        };
        let matched = if pat.starts_with("|1|") { hashed_match(pat, field) } else { glob_match(pat, field) };
        if matched {
            if negated {
                return false;
            }
            hit = true;
        }
    }
    hit
}

/// 解析 known_hosts 文本，给出对这把钥匙的判定；没有这台主机的任何记录时返回 None。
///
/// 自己解析而不是用 russh 的 `check_known_hosts_path`：后者遇到任何一行解析不了的记录就整体报错
/// （以前这种错误被当成「没有记录」→ 首次连接 → 用户一键信任，等于绕过了已有记录），
/// 也不认识 `@revoked` / `@cert-authority` 标记、否定模式和通配。
fn judge(text: &str, field: &str, key: &PublicKey, source: &Path) -> Option<Verdict> {
    let fingerprint = || fingerprint_of(key);
    let mut trusted = false;
    let mut other = false;
    let mut unparsable: Option<usize> = None;
    for (index, line) in text.lines().enumerate() {
        let line_no = index + 1;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let Some(mut first) = parts.next() else { continue };
        let marker = if first.starts_with('@') {
            let m = first;
            match parts.next() {
                Some(next) => first = next,
                None => continue,
            }
            Some(m)
        } else {
            None
        };
        if !hosts_match(first, field) {
            continue;
        }
        // CA 记录用于证书校验，不是这台主机自己的钥匙
        if marker == Some("@cert-authority") {
            continue;
        }
        let (Some(_key_type), Some(b64)) = (parts.next(), parts.next()) else {
            unparsable.get_or_insert(line_no);
            continue;
        };
        match russh::keys::parse_public_key_base64(b64) {
            Ok(recorded) => {
                let same = recorded.key_data() == key.key_data();
                if marker == Some("@revoked") {
                    if same {
                        return Some(Verdict::CheckFailed {
                            fingerprint: fingerprint(),
                            reason: format!("{} 第 {line_no} 行把这把主机密钥标记为已吊销（@revoked）", source.display()),
                        });
                    }
                    continue;
                }
                if same {
                    trusted = true;
                } else {
                    other = true;
                }
            }
            Err(_) => {
                unparsable.get_or_insert(line_no);
            }
        }
    }
    if trusted {
        Some(Verdict::Trusted)
    } else if other {
        Some(Verdict::Changed { fingerprint: fingerprint() })
    } else {
        unparsable.map(|line_no| Verdict::CheckFailed {
            fingerprint: fingerprint(),
            reason: format!(
                "{} 第 {line_no} 行是这台主机的记录，但无法解析，无法确认指纹。请检查或删除该行后重试",
                source.display()
            ),
        })
    }
}

fn check_in(path: &Path, host: &str, port: u16, key: &PublicKey) -> Option<Verdict> {
    let text = match std::fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        // 读不了（权限、IO 错误）≠ 没有记录：拒绝并说明，绝不降级成首次连接
        Err(e) => {
            return Some(Verdict::CheckFailed {
                fingerprint: fingerprint_of(key),
                reason: format!("无法读取 {}：{e}", path.display()),
            })
        }
    };
    judge(&text, &host_field(host, port), key, path)
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
    trust_in(&path, host, port, key)
}

/// 信任的实际实现（落在指定文件上，便于测试）。
///
/// 已经记过这条密钥就直接返回：`learn_known_hosts_path` 是**无条件追加**的，
/// 而同一台主机的并发会话会各自点一次「确认」，重复写会在文件里留下重复行。
fn trust_in(path: &Path, host: &str, port: u16, key: &PublicKey) -> Result<(), String> {
    if check_in(path, host, port, key) == Some(Verdict::Trusted) {
        return Ok(());
    }
    learn_known_hosts_path(host, port, key, path).map_err(|e| format!("写入 known_hosts 失败：{e}"))
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

/* ------------------------------ 已知主机列表（设置页 / Netcatty KnownHostsManager） ------------------------------ */

/// 一行 known_hosts 记录，给界面列出来
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    /// "termx" = TermX 自己的记录（可删）；"openssh" = ~/.ssh/known_hosts（只读沿用，不改）
    pub source: &'static str,
    pub line_no: usize,
    /// 原始行（删除时按整行精确匹配）
    pub line: String,
    /// 主机字段里的每个模式（逗号分隔）
    pub patterns: Vec<String>,
    /// 第一个可读的主机名 / 地址与端口；哈希过的（|1|…）为 None
    pub host: Option<String>,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: Option<String>,
    pub marker: Option<String>,
    pub hashed: bool,
}

/// `[host]:port` → (host, port)；`host` → (host, 22)
fn split_pattern(pattern: &str) -> (String, u16) {
    if let Some(rest) = pattern.strip_prefix('[') {
        if let Some((h, p)) = rest.split_once("]:") {
            if let Ok(port) = p.parse() {
                return (h.to_string(), port);
            }
        }
    }
    (pattern.to_string(), 22)
}

pub fn parse_entries(text: &str, source: &'static str) -> Vec<KnownHostEntry> {
    let mut out = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let Some(mut field) = parts.next() else { continue };
        let mut marker = None;
        if field.starts_with('@') {
            marker = Some(field.to_string());
            match parts.next() {
                Some(next) => field = next,
                None => continue,
            }
        }
        let key_type = parts.next().unwrap_or("").to_string();
        let fingerprint = parts
            .next()
            .and_then(|b64| russh::keys::parse_public_key_base64(b64).ok())
            .map(|k| fingerprint_of(&k));
        let hashed = field.starts_with('|');
        let patterns: Vec<String> = field.split(',').filter(|p| !p.is_empty()).map(str::to_string).collect();
        // 第一个不是通配 / 否定的模式当作可转换的地址
        let readable = patterns
            .iter()
            .find(|p| !p.starts_with('|') && !p.starts_with('!') && !p.contains('*') && !p.contains('?'));
        let (host, port) = match readable {
            Some(p) => {
                let (h, port) = split_pattern(p);
                (Some(h), port)
            }
            None => (None, 22),
        };
        out.push(KnownHostEntry {
            source,
            line_no: index + 1,
            line: trimmed.to_string(),
            patterns,
            host,
            port,
            key_type,
            fingerprint,
            marker,
            hashed,
        });
    }
    out
}

fn read_entries(path: &Path, source: &'static str) -> Result<Vec<KnownHostEntry>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(parse_entries(&String::from_utf8_lossy(&bytes), source)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("无法读取 {}：{e}", path.display())),
    }
}

/// 列出 TermX 记录 + OpenSSH 记录（后者只读）
#[tauri::command]
pub fn known_hosts_list(app: AppHandle) -> Result<Vec<KnownHostEntry>, String> {
    let mut all = read_entries(&store_path(&app)?, "termx")?;
    if let Some(path) = openssh_path() {
        // OpenSSH 文件读不了不影响 TermX 自己的列表
        if let Ok(list) = read_entries(&path, "openssh") {
            all.extend(list);
        }
    }
    Ok(all)
}

/// 从 TermX 的记录里删掉与 `line` 完全相同的行；不碰 OpenSSH 的 ~/.ssh/known_hosts
#[tauri::command]
pub fn known_hosts_remove(app: AppHandle, line: String) -> Result<usize, String> {
    remove_line(&store_path(&app)?, &line)
}

fn remove_line(path: &Path, line: &str) -> Result<usize, String> {
    let target = line.trim();
    if target.is_empty() {
        return Err("要删除的记录为空".into());
    }
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("读取 known_hosts 失败：{e}")),
    };
    let mut removed = 0usize;
    let kept: Vec<&str> = text
        .lines()
        .filter(|l| {
            let hit = l.trim() == target;
            if hit {
                removed += 1;
            }
            !hit
        })
        .collect();
    if removed == 0 {
        return Ok(0);
    }
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
    use russh::keys::Error as KeysError;

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

    /// 同主机并发会话会各自点一次「确认」：信任必须幂等，不能写出重复行
    #[test]
    fn trust_is_idempotent() {
        let path = fresh_path("idempotent");

        trust_in(&path, "host.example", 22, &key_a()).unwrap();
        trust_in(&path, "host.example", 22, &key_a()).unwrap();
        trust_in(&path, "host.example", 22, &key_a()).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
        assert_eq!(lines.len(), 1, "重复确认不应写出重复记录，实际是：{text}");
        assert_eq!(check_in(&path, "host.example", 22, &key_a()), Some(Verdict::Trusted));

        // 另一台主机仍然可以正常新增
        trust_in(&path, "other.example", 22, &key_a()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().filter(|l| !l.trim().is_empty()).count(), 2);
    }

    fn b64_of(key: &str) -> &str {
        key.split_whitespace().nth(1).unwrap()
    }

    fn judge_text(text: &str, field: &str, key: &PublicKey) -> Option<Verdict> {
        judge(text, field, key, Path::new("/kh"))
    }

    /// M9：哈希主机名（ssh-keygen -H / HashKnownHosts yes）必须能认出来，否则已信任的主机会被当成首次连接
    #[test]
    fn hashed_hostnames_match() {
        let text = format!(
            "|1|AAECAwQFBgcICQoLDA0ODxAREhM=|IZ1zV0swCfFUvwvqRtiJbYJ0/LA= ssh-ed25519 {}\n\
             |1|AAECAwQFBgcICQoLDA0ODxAREhM=|DnpHtKjaC+vTmgwkAZCf9SqxJN8= ssh-ed25519 {}\n",
            b64_of(KEY_A),
            b64_of(KEY_B)
        );
        assert_eq!(judge_text(&text, "host.example", &key_a()), Some(Verdict::Trusted));
        assert!(matches!(judge_text(&text, "host.example", &key_b()), Some(Verdict::Changed { .. })));
        assert_eq!(judge_text(&text, &host_field("host.example", 2222), &key_b()), Some(Verdict::Trusted));
        assert_eq!(judge_text(&text, "other.example", &key_a()), None);
    }

    /// M9：这台主机的记录解析不了 → 拒绝（CheckFailed），不能降级成「首次连接」
    #[test]
    fn unparsable_record_for_this_host_is_not_unknown() {
        let text = "host.example ssh-ed25519 !!!not-base64!!!\nother.example ssh-ed25519 AAAA\n";
        match judge_text(text, "host.example", &key_a()) {
            Some(Verdict::CheckFailed { reason, .. }) => assert!(reason.contains("第 1 行"), "{reason}"),
            other => panic!("应判定为 CheckFailed，实际 {other:?}"),
        }
        // 别的主机的坏行不影响这台主机
        let text = format!("broken.example ssh-ed25519 ???\nhost.example ssh-ed25519 {}\n", b64_of(KEY_A));
        assert_eq!(judge_text(&text, "host.example", &key_a()), Some(Verdict::Trusted));
        // 有一条好记录是另一把钥匙 + 一条坏记录：按「变了」处理
        let text = format!("host.example ssh-ed25519 {}\nhost.example ssh-ed25519 ???\n", b64_of(KEY_B));
        assert!(matches!(judge_text(&text, "host.example", &key_a()), Some(Verdict::Changed { .. })));
    }

    /// M9：文件存在但读不了 → CheckFailed（以前被当成「没有记录」）
    #[test]
    fn unreadable_file_is_check_failed() {
        let dir = temp_file("unreadable-dir");
        std::fs::create_dir_all(&dir).unwrap();
        // 目录当文件读一定失败（且不依赖权限，root 下也成立）
        match check_in(&dir, "host.example", 22, &key_a()) {
            Some(Verdict::CheckFailed { reason, .. }) => assert!(reason.contains("无法读取"), "{reason}"),
            other => panic!("应判定为 CheckFailed，实际 {other:?}"),
        }
        assert_eq!(check_in(&fresh_path("nope"), "host.example", 22, &key_a()), None, "文件不存在 = 没有记录");
    }

    #[test]
    fn markers_wildcards_negation_and_whitespace() {
        let a = b64_of(KEY_A);
        let b = b64_of(KEY_B);
        // @revoked 命中这把钥匙：拒绝；@cert-authority 行忽略
        let text = format!("@revoked * ssh-ed25519 {a}\nhost.example ssh-ed25519 {a}\n");
        assert!(matches!(judge_text(&text, "host.example", &key_a()), Some(Verdict::CheckFailed { .. })));
        let text = format!("@cert-authority *.example ssh-ed25519 {b}\n");
        assert_eq!(judge_text(&text, "host.example", &key_a()), None);
        // 通配与否定
        let text = format!("*.example,!bad.example ssh-ed25519 {a}\n");
        assert_eq!(judge_text(&text, "host.example", &key_a()), Some(Verdict::Trusted));
        assert_eq!(judge_text(&text, "bad.example", &key_a()), None);
        assert_eq!(judge_text(&text, "HOST.EXAMPLE", &key_a()), Some(Verdict::Trusted), "主机名不区分大小写");
        // 制表符 / 多个空格 / 行尾注释
        let text = format!("host.example\tssh-ed25519   {a}  user@box\n");
        assert_eq!(judge_text(&text, "host.example", &key_a()), Some(Verdict::Trusted));
        // 带注释的记录与无注释的服务器公钥也能对上（只比密钥数据）
        let text = format!("[host.example]:2222 ssh-ed25519 {a} comment\n");
        assert_eq!(judge_text(&text, "[host.example]:2222", &key_a()), Some(Verdict::Trusted));
    }

    #[test]
    fn list_parses_markers_ports_and_hashes() {
        let text = format!(
            "# c\nexample.com,1.2.3.4 {KEY_A}\n[box]:2222 {KEY_B}\n@revoked bad {KEY_A}\n|1|abc=|def= {KEY_B}\n*.wild {KEY_A}\nbroken ssh-ed25519 !!!\n"
        );
        let list = parse_entries(&text, "termx");
        assert_eq!(list.len(), 6);
        assert_eq!(list[0].host.as_deref(), Some("example.com"));
        assert_eq!(list[0].patterns, vec!["example.com", "1.2.3.4"]);
        assert_eq!(list[0].port, 22);
        assert!(list[0].fingerprint.as_deref().unwrap().starts_with("SHA256:"));
        assert_eq!((list[1].host.as_deref(), list[1].port), (Some("box"), 2222));
        assert_eq!(list[2].marker.as_deref(), Some("@revoked"));
        assert!(list[3].hashed && list[3].host.is_none());
        assert!(list[4].host.is_none());
        assert!(list[5].fingerprint.is_none());
        assert_eq!(list[1].line_no, 3);
    }

    #[test]
    fn remove_line_is_exact() {
        let path = temp_file("remove_line");
        std::fs::write(&path, format!("a {KEY_A}\nab {KEY_A}\n# keep\n")).unwrap();
        assert_eq!(remove_line(&path, &format!("  a {KEY_A} ")).unwrap(), 1);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("ab {KEY_A}\n# keep\n"));
        assert_eq!(remove_line(&path, "nothing").unwrap(), 0);
        let _ = std::fs::remove_file(&path);
    }
}
