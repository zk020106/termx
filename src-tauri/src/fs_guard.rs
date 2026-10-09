//! 本地文件命令的路径护栏。
//!
//! 本地文件命令（列目录、删除、重命名、写文件、SFTP 下载落地）可以被 WebView 直接调用。
//! 前端拼路径时一旦混进远程文件名里的 `..`、或被注入脚本调用，就可能写穿 / 删掉任意位置。
//! 这里统一做三件事：
//! 1. 只接受**绝对路径**，且不允许出现 `..` 段（远程文件名 `../../x` 拼出来的路径直接拒绝）；
//! 2. 破坏性操作（删除、重命名、写入）拒绝作用于「受保护路径」：根目录 / 盘符根、
//!    用户主目录本身及其上级、操作系统目录；
//! 3. 递归删除前按真实路径（解析符号链接后）再查一遍；
//! 4. **读取**同样有范围：只接受绝对路径；读取 / 上传「敏感文件」（SSH 私钥、`~/.ssh` 下的文件、
//!    TermX 自己的配置目录）以及写进这些位置之前，由 Rust 侧弹**原生**确认框 ——
//!    网页里的脚本既看不到也点不了这个框，就算界面被注入也没法悄悄读走私钥或改写 authorized_keys。
//!    用户确认过的路径本次运行内不再重复询问（续传、重试不会反复弹框）。

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// 校验并返回本地绝对路径：非空、无 NUL、绝对路径、不含 `..`
pub fn checked_local_path(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("本地路径为空".to_string());
    }
    if raw.contains('\0') {
        return Err("本地路径含有非法字符".to_string());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!("只接受绝对路径：「{raw}」"));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("路径里不允许出现「..」：「{raw}」"));
    }
    Ok(path)
}

/// 统一成便于比较的形式：分隔符换成 `/`、去掉 Windows 的 `\\?\` 前缀与结尾斜杠，Windows 下不区分大小写
fn normalized(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s);
    let s = s.trim_end_matches('/');
    let s = if s.is_empty() { "/" } else { s };
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// 去掉盘符（`c:/windows` -> `/windows`），让系统目录规则对任意盘符都生效
fn without_drive(s: &str) -> &str {
    let b = s.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        &s[2..]
    } else {
        s
    }
}

#[cfg(windows)]
const SYSTEM_TREES: &[&str] = &[
    "/windows",
    "/program files",
    "/program files (x86)",
    "/programdata",
];
#[cfg(windows)]
const SYSTEM_DIRS: &[&str] = &["/users"];

#[cfg(not(windows))]
const SYSTEM_TREES: &[&str] = &[
    "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/proc", "/sbin", "/sys", "/usr",
    "/System",
];
#[cfg(not(windows))]
const SYSTEM_DIRS: &[&str] = &[
    "/home",
    "/Users",
    "/root",
    "/var",
    "/opt",
    "/tmp",
    "/private",
    "/Library",
    "/Applications",
    "/Volumes",
    "/mnt",
    "/media",
    "/srv",
];

/// 路径是否受保护；受保护时返回原因
pub fn protected_reason(path: &Path, home: Option<&Path>) -> Option<&'static str> {
    let p = normalized(path);
    let bare = without_drive(&p);
    if path.parent().is_none() || bare.is_empty() || bare == "/" {
        return Some("根目录 / 盘符根");
    }
    if let Some(home) = home {
        let h = normalized(home);
        if h == p || h.starts_with(&format!("{p}/")) {
            return Some("用户主目录或其上级目录");
        }
    }
    if SYSTEM_DIRS.iter().any(|d| normalized(Path::new(d)) == bare) {
        return Some("系统目录");
    }
    if SYSTEM_TREES.iter().any(|d| {
        let d = normalized(Path::new(d));
        bare == d || bare.starts_with(&format!("{d}/"))
    }) {
        return Some("系统目录");
    }
    None
}

/// 破坏性操作前的检查：先按字面路径、再按解析符号链接后的真实路径（存在时）各查一遍
pub fn ensure_not_protected(path: &Path, action: &str) -> Result<(), String> {
    let home = dirs::home_dir();
    let home_real = home.as_deref().and_then(|h| std::fs::canonicalize(h).ok());
    let check = |p: &Path| -> Result<(), String> {
        for h in [home.as_deref(), home_real.as_deref()] {
            if let Some(reason) = protected_reason(p, h) {
                return Err(format!(
                    "出于安全考虑，不允许{action}{reason}：「{}」",
                    path.display()
                ));
            }
        }
        Ok(())
    };
    check(path)?;
    // 路径本身是符号链接时只会作用于链接本身，不解析；否则看真实路径（防止经软链接的上级绕过）
    let is_link = std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if !is_link {
        if let Ok(real) = std::fs::canonicalize(path) {
            check(&real)?;
        }
    }
    Ok(())
}

/// SSH 目录里可以随便读写的文件（公开信息 / 用户自己的客户端配置）
const SSH_DIR_PUBLIC: &[&str] = &["known_hosts", "known_hosts.old", "config"];

/// 文件头像不像私钥（OpenSSH / PEM / PKCS#8 / PuTTY）
pub fn looks_like_private_key(head: &[u8]) -> bool {
    let text = String::from_utf8_lossy(head);
    (text.contains("-----BEGIN") && text.contains("PRIVATE KEY")) || text.starts_with("PuTTY-User-Key-File")
}

/// 路径本身是否敏感：`~/.ssh` 下除公钥 / known_hosts / config 之外的文件，或 TermX 自己的配置目录
pub fn sensitive_location(path: &Path, home: Option<&Path>, app_config: Option<&Path>) -> Option<&'static str> {
    let p = normalized(path);
    if let Some(cfg) = app_config {
        let c = normalized(cfg);
        if p == c || p.starts_with(&format!("{c}/")) {
            return Some("这是 TermX 自己的配置目录（主机列表、known_hosts）");
        }
    }
    if let Some(home) = home {
        let ssh = format!("{}/.ssh", normalized(home));
        if p.starts_with(&format!("{ssh}/")) {
            let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !name.ends_with(".pub") && !SSH_DIR_PUBLIC.contains(&name.as_str()) {
                return Some("这是 ~/.ssh 里的文件（私钥、authorized_keys 等）");
            }
        }
    }
    None
}

/// 本次运行里用户已经确认过的「动作 + 路径」
static CONFIRMED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn already_confirmed(key: &str) -> bool {
    CONFIRMED
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.contains(key)))
        .unwrap_or(false)
}

fn remember_confirmed(key: String) {
    if let Ok(mut g) = CONFIRMED.lock() {
        g.get_or_insert_with(HashSet::new).insert(key);
    }
}

fn app_config_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}

/// 按字面路径与解析符号链接后的真实路径各查一遍（经软链接指向 ~/.ssh 的路径同样算敏感）
fn sensitive_anywhere(app: &AppHandle, path: &Path) -> Option<&'static str> {
    let home = dirs::home_dir();
    let cfg = app_config_dir(app);
    let real = std::fs::canonicalize(path).ok().or_else(|| {
        let parent = std::fs::canonicalize(path.parent()?).ok()?;
        Some(parent.join(path.file_name()?))
    });
    let home_real = home.as_deref().and_then(|h| std::fs::canonicalize(h).ok());
    let cfg_real = cfg.as_deref().and_then(|c| std::fs::canonicalize(c).ok());
    sensitive_location(path, home.as_deref(), cfg.as_deref()).or_else(|| {
        let real = real?;
        sensitive_location(&real, home.as_deref(), cfg.as_deref())
            .or_else(|| sensitive_location(&real, home_real.as_deref(), cfg_real.as_deref()))
    })
}

/// 读取 / 上传本地文件前的检查：敏感文件要用户在原生对话框里点头
pub async fn confirm_read(app: &AppHandle, path: &Path, action: &str) -> Result<(), String> {
    let mut reason = sensitive_anywhere(app, path);
    if reason.is_none() {
        let mut head = [0u8; 64];
        if let Ok(mut f) = tokio::fs::File::open(path).await {
            use tokio::io::AsyncReadExt;
            let n = f.read(&mut head).await.unwrap_or(0);
            if looks_like_private_key(&head[..n]) {
                reason = Some("这是一个私钥文件");
            }
        }
    }
    match reason {
        None => Ok(()),
        Some(reason) => ask(app, path, action, reason).await,
    }
}

/// 写入本地文件前的检查：不在受保护位置；写进敏感位置要用户在原生对话框里点头
pub async fn confirm_write(app: &AppHandle, path: &Path, action: &str) -> Result<(), String> {
    ensure_not_protected(path, action)?;
    match sensitive_anywhere(app, path) {
        None => Ok(()),
        Some(reason) => ask(app, path, action, reason).await,
    }
}

async fn ask(app: &AppHandle, path: &Path, action: &str, reason: &str) -> Result<(), String> {
    let key = format!("{action}\u{0}{}", path.display());
    if already_confirmed(&key) {
        return Ok(());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "TermX 正要{action}：\n{}\n\n{reason}。如果这不是你刚刚亲手发起的操作，请点「取消」。",
            path.display()
        ))
        .title("确认访问敏感文件")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(format!("允许{action}"), "取消".into()))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    if rx.await.unwrap_or(false) {
        remember_confirmed(key);
        Ok(())
    } else {
        Err(format!("已取消：没有允许{action}「{}」", path.display()))
    }
}

/// 通用的原生确认框（打开本地文件 / 用指定程序打开）：同一 key 本次运行只问一次
pub async fn confirm_native(app: &AppHandle, key: &str, title: &str, message: String, ok_label: &str) -> Result<(), String> {
    if already_confirmed(key) {
        return Ok(());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok_label.to_string(), "取消".into()))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    if rx.await.unwrap_or(false) {
        remember_confirmed(key.to_string());
        Ok(())
    } else {
        Err("已取消".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn sensitive_locations() {
        let home = Path::new("/home/u");
        let cfg = Path::new("/home/u/.config/dev.termx.app");
        let s = |p: &str| sensitive_location(Path::new(p), Some(home), Some(cfg)).is_some();
        assert!(s("/home/u/.ssh/id_ed25519"));
        assert!(s("/home/u/.ssh/authorized_keys"));
        assert!(s("/home/u/.ssh/work/id_rsa"));
        assert!(s("/home/u/.config/dev.termx.app/termx.json"));
        assert!(!s("/home/u/.ssh/id_ed25519.pub"));
        assert!(!s("/home/u/.ssh/known_hosts"));
        assert!(!s("/home/u/.ssh/config"));
        assert!(!s("/home/u/.sshx/file"), "前缀相同的别的目录不算");
        assert!(!s("/home/u/Downloads/report.txt"));
    }

    #[test]
    fn private_key_headers() {
        assert!(looks_like_private_key(b"-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn"));
        assert!(looks_like_private_key(b"-----BEGIN RSA PRIVATE KEY-----\n"));
        assert!(looks_like_private_key(b"-----BEGIN PRIVATE KEY-----\n"));
        assert!(looks_like_private_key(b"PuTTY-User-Key-File-3: ssh-ed25519\n"));
        assert!(!looks_like_private_key(b"-----BEGIN CERTIFICATE-----\n"));
        assert!(!looks_like_private_key(b"ssh-ed25519 AAAA user@host\n"));
    }

    #[test]
    fn relative_and_traversal_paths_are_rejected() {
        assert!(checked_local_path("").is_err());
        assert!(checked_local_path("relative/file.txt").is_err());
        assert!(checked_local_path("a\0b").is_err());
        #[cfg(not(windows))]
        {
            // 远程文件名 "../../.bashrc" 被拼进下载目录后的样子
            assert!(checked_local_path("/home/u/Downloads/../../.bashrc").is_err());
            assert!(checked_local_path("/home/u/Downloads/..").is_err());
            assert_eq!(
                checked_local_path("/home/u/Downloads/report.txt").unwrap(),
                PathBuf::from("/home/u/Downloads/report.txt")
            );
            // 文件名里带两个点但不是独立的 `..` 段，是合法文件名
            assert!(checked_local_path("/home/u/Downloads/v1..2.tar.gz").is_ok());
        }
        #[cfg(windows)]
        {
            assert!(checked_local_path(r"C:\Users\u\Downloads\..\..\x").is_err());
            assert!(checked_local_path(r"C:\Users\u\Downloads\report.txt").is_ok());
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn roots_home_and_system_dirs_are_protected() {
        let home = Path::new("/home/u");
        let protected = |p: &str| protected_reason(Path::new(p), Some(home)).is_some();
        assert!(protected("/"));
        assert!(protected("/home/u"), "主目录本身");
        assert!(protected("/home/u/"), "结尾斜杠不影响");
        assert!(protected("/home"), "主目录的上级");
        assert!(protected("/etc"));
        assert!(protected("/etc/ssh/sshd_config"), "系统目录子树");
        assert!(protected("/usr/local/bin"));
        assert!(protected("/var"));

        assert!(!protected("/home/u/Downloads"));
        assert!(!protected("/home/u/projects/old-build"));
        assert!(
            !protected("/var/tmp/scratch"),
            "/var 只保护自身，不保护子树"
        );
        assert!(!protected("/home/user2"), "前缀相同的别的目录不算上级");
    }

    #[cfg(windows)]
    #[test]
    fn windows_roots_home_and_system_dirs_are_protected() {
        let home = Path::new(r"C:\Users\u");
        let protected = |p: &str| protected_reason(Path::new(p), Some(home)).is_some();
        assert!(protected(r"C:\"));
        assert!(protected(r"D:\"));
        assert!(protected(r"c:\users\U"));
        assert!(protected(r"C:\Windows\System32"));
        assert!(protected(r"\\?\C:\Users\u"));
        assert!(!protected(r"C:\Users\u\Downloads"));
        assert!(!protected(r"D:\work\tmp"));
    }

    #[test]
    fn ensure_not_protected_allows_ordinary_temp_files() {
        let dir = std::env::temp_dir().join(format!("termx-guard-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 系统临时目录在某些平台位于 /tmp 或 /var 之下，但它的子目录不受保护
        assert!(ensure_not_protected(&dir, "删除").is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
