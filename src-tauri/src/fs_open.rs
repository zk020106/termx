//! SFTP 右键里「系统默认程序打开 / 打开方式… / 解压到当前目录（本地）」需要的本地能力。
//!
//! 对应 Netcatty（Electron）：
//! - `shell.openPath`               → [`fs_open_path`]：Windows 交给 explorer、macOS `open`、Linux `xdg-open`；
//! - `openWithApplication`          → [`fs_open_with`]：macOS `open -a <app> <file>`，其余直接以文件为参数启动程序；
//! - 远程文件先下到临时目录再打开  → [`fs_temp_file_path`]：`<系统临时目录>/termx-sftp/<随机>/<文件名>`；
//! - `archiveExtract.cjs` 的 `buildLocalExtractPlan` / `executeLocalExtractPlan` → [`fs_local_extract`]（逐条移植）。
//!
//! 安全上沿用 termx 的本地文件护栏（fs_guard）：只接受绝对路径；打开可执行类文件、用任意程序打开文件，
//! 都先由 Rust 侧弹**原生**确认框 —— WebView 里的脚本点不到它，被注入也没法悄悄启动程序。

use crate::fs_guard::{checked_local_path, confirm_native, confirm_write};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// 双击就会「运行」而不是「查看」的扩展名：打开前要用户在原生对话框里确认
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe", "com", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msp", "scr", "pif",
    "lnk", "url", "hta", "cpl", "jar", "reg", "inf", "app", "command", "sh", "bash", "zsh", "run", "desktop",
    "appimage", "pkg", "dmg", "deb", "rpm",
];

pub fn is_executable_like(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXECUTABLE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn spawn_detached(cmd: &mut Command) -> Result<(), String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd.spawn().map(|_| ()).map_err(|e| format!("无法启动程序：{e}"))
}

/// 用系统默认程序打开本地文件（Netcatty shell.openPath）
#[tauri::command]
pub async fn fs_open_path(app: AppHandle, path: String) -> Result<(), String> {
    let p = checked_local_path(&path)?;
    if !p.exists() {
        return Err(format!("文件不存在：{}", p.display()));
    }
    if is_executable_like(&p) {
        confirm_native(
            &app,
            &format!("open\u{0}{}", p.display()),
            "确认运行文件",
            format!(
                "TermX 正要用系统默认程序打开：\n{}\n\n这是可执行 / 脚本类文件，打开就会直接运行。如果这不是你刚刚亲手发起的操作，请点「取消」。",
                p.display()
            ),
            "仍然打开",
        )
        .await?;
    }
    #[cfg(windows)]
    {
        spawn_detached(Command::new("explorer").arg(&p))
    }
    #[cfg(target_os = "macos")]
    {
        spawn_detached(Command::new("open").arg(&p))
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        spawn_detached(Command::new("xdg-open").arg(&p))
    }
}

/// 用指定程序打开本地文件（Netcatty「打开方式...」→ 选择程序）
#[tauri::command]
pub async fn fs_open_with(app: AppHandle, path: String, application: String) -> Result<(), String> {
    let p = checked_local_path(&path)?;
    let exe = checked_local_path(&application)?;
    if !p.exists() {
        return Err(format!("文件不存在：{}", p.display()));
    }
    if !exe.exists() {
        return Err(format!("程序不存在：{}", exe.display()));
    }
    confirm_native(
        &app,
        &format!("open-with\u{0}{}", exe.display()),
        "确认启动程序",
        format!(
            "TermX 正要启动：\n{}\n来打开：\n{}\n\n如果这不是你刚刚亲手选择的程序，请点「取消」。（本次运行内同一程序只问一次）",
            exe.display(),
            p.display()
        ),
        "启动",
    )
    .await?;
    #[cfg(target_os = "macos")]
    {
        if exe.extension().map(|e| e == "app").unwrap_or(false) {
            return spawn_detached(Command::new("open").arg("-a").arg(&exe).arg(&p));
        }
    }
    spawn_detached(Command::new(&exe).arg(&p))
}

/// 去掉远程文件名里不能落地的字符（远程名不可信：分隔符、`..`、控制字符都换掉）
pub fn safe_temp_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "file".to_string()
    } else {
        trimmed
    }
}

/// 远程文件「打开 / 打开方式」用的临时落地路径：`<临时目录>/termx-sftp/<随机>/<文件名>`（目录已建好）
#[tauri::command]
pub fn fs_temp_file_path(name: String) -> Result<String, String> {
    let mut nonce = [0u8; 8];
    getrandom_fill(&mut nonce);
    let dir = std::env::temp_dir()
        .join("termx-sftp")
        .join(nonce.iter().map(|b| format!("{b:02x}")).collect::<String>());
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建临时目录：{e}"))?;
    Ok(dir.join(safe_temp_name(&name)).to_string_lossy().into_owned())
}

fn getrandom_fill(buf: &mut [u8]) {
    // 不为一个目录名引新依赖：时间 + 进程 id + 计数器做 SHA-256，足够避免碰撞
    use sha2::{Digest, Sha256};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = Sha256::new();
    h.update(format!(
        "{:?}{}{}",
        std::time::SystemTime::now(),
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let out = h.finalize();
    buf.copy_from_slice(&out[..buf.len()]);
}

/* ----------------------------- 本地解压（移植 archiveExtract.cjs） ----------------------------- */

const ARCHIVE_KINDS: &[(&str, &[&str])] = &[
    ("tar.gz", &[".tar.gz", ".tgz"]),
    ("tar.bz2", &[".tar.bz2", ".tbz2", ".tar.bzip2"]),
    ("tar.xz", &[".tar.xz", ".txz"]),
    ("tar.zst", &[".tar.zst", ".tzst"]),
    ("tar", &[".tar"]),
    ("zip", &[".zip"]),
    ("gz", &[".gz"]),
    ("bz2", &[".bz2"]),
    ("xz", &[".xz"]),
];

const EXTRACT_BASE_TIMEOUT_MS: u64 = 60_000;
const EXTRACT_MAX_TIMEOUT_MS: u64 = 10 * 60_000;
const EXTRACT_MAX_OUTPUT_BYTES: usize = 64 * 1024;

pub fn archive_kind(name: &str) -> Option<&'static str> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").to_lowercase();
    if base.is_empty() {
        return None;
    }
    ARCHIVE_KINDS
        .iter()
        .find(|(_, suffixes)| suffixes.iter().any(|s| base.ends_with(s) && base.len() > s.len()))
        .map(|(k, _)| *k)
}

pub fn compute_extract_timeout_ms(size: u64) -> u64 {
    if size == 0 {
        return EXTRACT_MAX_TIMEOUT_MS;
    }
    let extra = size.div_ceil(10 * 1024 * 1024) * 30_000;
    EXTRACT_MAX_TIMEOUT_MS.min(EXTRACT_BASE_TIMEOUT_MS.max(EXTRACT_BASE_TIMEOUT_MS + extra))
}

#[derive(Debug, PartialEq)]
pub enum ExtractPlan {
    /// 直接运行，解到 parent
    Run { command: String, args: Vec<String>, fallback: Option<(String, Vec<String>)> },
    /// 解压到单个文件：命令的 stdout 写进 `out`
    Pipe { command: String, args: Vec<String>, out: PathBuf },
    /// 内置 gunzip（flate2），同 Netcatty 用 zlib
    Gunzip { out: PathBuf },
}

fn strip_compression_suffix(path: &Path, kind: &str) -> Result<PathBuf, String> {
    let suffix = match kind {
        "gz" => ".gz",
        "bz2" => ".bz2",
        "xz" => ".xz",
        _ => return Err(format!("Cannot strip suffix for archive kind: {kind}")),
    };
    let base = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if base.len() <= suffix.len() || !base.to_lowercase().ends_with(suffix) {
        return Err(format!("Archive name does not match kind {kind}"));
    }
    let stem = &base[..base.len() - suffix.len()];
    Ok(path.parent().unwrap_or(Path::new("")).join(stem))
}

pub fn build_local_extract_plan(archive: &Path, windows: bool) -> Result<ExtractPlan, String> {
    let name = archive.to_string_lossy();
    let kind = archive_kind(&name).ok_or_else(|| format!("Unsupported archive type: {name}"))?;
    let parent = archive.parent().ok_or("Archive path has no parent directory")?;
    let a = archive.to_string_lossy().into_owned();
    let d = parent.to_string_lossy().into_owned();
    let tar = |flag: &str| ExtractPlan::Run {
        command: "tar".into(),
        args: vec![flag.into(), a.clone(), "-C".into(), d.clone()],
        fallback: None,
    };
    Ok(match kind {
        "tar" => tar("-xf"),
        "tar.gz" => tar("-xzf"),
        "tar.bz2" => tar("-xjf"),
        "tar.xz" => tar("-xJf"),
        "tar.zst" => ExtractPlan::Run {
            command: "tar".into(),
            args: vec!["--zstd".into(), "-xf".into(), a.clone(), "-C".into(), d.clone()],
            fallback: None,
        },
        "zip" if windows => tar("-xf"),
        "zip" => ExtractPlan::Run {
            command: "unzip".into(),
            args: vec!["-qo".into(), a.clone(), "-d".into(), d.clone()],
            fallback: Some(("tar".into(), vec!["-xf".into(), a.clone(), "-C".into(), d.clone()])),
        },
        "gz" => ExtractPlan::Gunzip { out: strip_compression_suffix(archive, kind)? },
        "bz2" => ExtractPlan::Pipe {
            command: "bzip2".into(),
            args: vec!["-dc".into(), a.clone()],
            out: strip_compression_suffix(archive, kind)?,
        },
        "xz" => ExtractPlan::Pipe {
            command: "xz".into(),
            args: vec!["-dc".into(), a.clone()],
            out: strip_compression_suffix(archive, kind)?,
        },
        other => return Err(format!("Unsupported archive type: {other}")),
    })
}

fn allocate_staging(dest: &Path) -> Result<PathBuf, String> {
    for _ in 0..32 {
        let mut nonce = [0u8; 6];
        getrandom_fill(&mut nonce);
        let hex: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let mut name = dest.as_os_str().to_owned();
        name.push(format!(".termx-extract.{hex}"));
        let candidate = PathBuf::from(name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(_) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("Could not allocate extraction staging file".into())
}

fn replace_file(staging: &Path, dest: &Path) -> Result<(), String> {
    if dest.is_dir() {
        let _ = std::fs::remove_file(staging);
        return Err("Extraction target is a directory".into());
    }
    if std::fs::rename(staging, dest).is_ok() {
        return Ok(());
    }
    // Windows 上目标已存在时 rename 会失败：先删再挪
    let _ = std::fs::remove_file(dest);
    std::fs::rename(staging, dest).map_err(|e| {
        let _ = std::fs::remove_file(staging);
        e.to_string()
    })
}

fn wait_with_timeout(mut child: std::process::Child, timeout: Duration) -> Result<(), String> {
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(s) = stderr.as_mut() {
            let _ = s.take(EXTRACT_MAX_OUTPUT_BYTES as u64).read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let err = reader.join().unwrap_or_default();
                if status.success() {
                    return Ok(());
                }
                let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
                let detail = err.trim();
                return Err(if detail.is_empty() {
                    format!("Local extraction failed (code {code})")
                } else {
                    format!("Local extraction failed (code {code}): {detail}")
                });
            }
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Local extraction timed out after {} ms", timeout.as_millis()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn run_plan(plan: &ExtractPlan, archive: &Path, timeout: Duration) -> Result<(), String> {
    match plan {
        ExtractPlan::Run { command, args, fallback } => {
            let spawn = |c: &str, a: &[String]| {
                Command::new(c).args(a).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn()
            };
            match spawn(command, args) {
                Ok(child) => wait_with_timeout(child, timeout),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => match fallback {
                    Some((c, a)) => {
                        let child = spawn(c, a).map_err(|e| format!("无法运行 {c}：{e}"))?;
                        wait_with_timeout(child, timeout)
                    }
                    None => Err(format!("本机没有 {command}，无法解压")),
                },
                Err(e) => Err(format!("无法运行 {command}：{e}")),
            }
        }
        ExtractPlan::Pipe { command, args, out } => {
            let staging = allocate_staging(out)?;
            let file = std::fs::File::create(&staging).map_err(|e| e.to_string())?;
            let child = Command::new(command)
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::from(file))
                .stderr(Stdio::piped())
                .spawn();
            let result = match child {
                Ok(child) => wait_with_timeout(child, timeout),
                Err(e) => Err(format!("无法运行 {command}：{e}")),
            };
            match result {
                Ok(()) => replace_file(&staging, out),
                Err(e) => {
                    let _ = std::fs::remove_file(&staging);
                    Err(e)
                }
            }
        }
        ExtractPlan::Gunzip { out } => {
            let staging = allocate_staging(out)?;
            let result = (|| -> Result<(), String> {
                let input = std::fs::File::open(archive).map_err(|e| e.to_string())?;
                let mut decoder = flate2::read::MultiGzDecoder::new(std::io::BufReader::new(input));
                let mut output = std::fs::File::create(&staging).map_err(|e| e.to_string())?;
                let start = Instant::now();
                let mut buf = vec![0u8; 256 * 1024];
                loop {
                    let n = decoder.read(&mut buf).map_err(|e| format!("Local extraction failed: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    output.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                    if start.elapsed() > timeout {
                        return Err(format!("Local extraction timed out after {} ms", timeout.as_millis()));
                    }
                }
                output.flush().map_err(|e| e.to_string())
            })();
            match result {
                Ok(()) => replace_file(&staging, out),
                Err(e) => {
                    let _ = std::fs::remove_file(&staging);
                    Err(e)
                }
            }
        }
    }
}

/// 把本地压缩包解到它所在的目录（Netcatty extractLocalArchiveFile）
#[tauri::command]
pub async fn fs_local_extract(app: AppHandle, path: String) -> Result<(), String> {
    let archive = checked_local_path(&path)?;
    let meta = std::fs::metadata(&archive).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("Cannot extract a directory".into());
    }
    let parent = archive.parent().ok_or("Archive path has no parent directory")?.to_path_buf();
    // 解压会往所在目录写文件：与其它本地写入一样过一遍护栏
    confirm_write(&app, &parent, "解压到这个目录").await?;
    let plan = build_local_extract_plan(&archive, cfg!(windows))?;
    if let ExtractPlan::Pipe { out, .. } | ExtractPlan::Gunzip { out } = &plan {
        confirm_write(&app, out, "写入解压结果").await?;
    }
    let timeout = Duration::from_millis(compute_extract_timeout_ms(meta.len()));
    tauri::async_runtime::spawn_blocking(move || run_plan(&plan, &archive, timeout))
        .await
        .map_err(|e| e.to_string())?
}

/* ----------------------------- 本地同栏复制（SFTP 剪贴板 Ctrl+C → Ctrl+V） ----------------------------- */

/// 递归复制；目标已存在时报错（不静默覆盖），不跟随符号链接（链接本身按普通文件复制其目标内容）
fn copy_recursive(src: &Path, dst: &Path) -> Result<u64, String> {
    if dst.exists() {
        return Err(format!("目标已存在：{}", dst.display()));
    }
    let meta = std::fs::metadata(src).map_err(|e| format!("读取「{}」失败：{e}", src.display()))?;
    if meta.is_dir() {
        std::fs::create_dir(dst).map_err(|e| format!("创建「{}」失败：{e}", dst.display()))?;
        let mut total = 0;
        for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            total += copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(total)
    } else {
        std::fs::copy(src, dst).map_err(|e| format!("复制「{}」失败：{e}", src.display()))
    }
}

/// 把本地文件 / 目录复制到 `dest_dir` 下（同名已存在则报错）。返回复制的字节数。
/// `dest_name` 给出时用它作目标名（本地栏「下载」= 另存为一份）
#[tauri::command]
pub async fn fs_local_copy(app: AppHandle, source: String, dest_dir: String, dest_name: Option<String>) -> Result<u64, String> {
    let src = checked_local_path(&source)?;
    let dir = checked_local_path(&dest_dir)?;
    let dst = match dest_name {
        Some(n) => {
            if n.is_empty() || n == "." || n == ".." || n.contains(['/', '\\', '\0']) {
                return Err(format!("目标文件名不合法：「{n}」"));
            }
            dir.join(n)
        }
        None => dir.join(src.file_name().ok_or("源路径没有文件名")?),
    };
    // 不能把目录复制进它自己里面（会无限递归）
    let src_real = std::fs::canonicalize(&src).map_err(|e| e.to_string())?;
    let dir_real = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    if dir_real.starts_with(&src_real) {
        return Err("不能把文件夹复制到它自己或它的子文件夹里".into());
    }
    crate::fs_guard::confirm_read(&app, &src, "复制").await?;
    confirm_write(&app, &dst, "复制写入").await?;
    tauri::async_runtime::spawn_blocking(move || copy_recursive(&src, &dst))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_kinds_match_netcatty() {
        assert_eq!(archive_kind("a.tar.gz"), Some("tar.gz"));
        assert_eq!(archive_kind("A.TGZ"), Some("tar.gz"));
        assert_eq!(archive_kind("x.tar.bzip2"), Some("tar.bz2"));
        assert_eq!(archive_kind("x.tzst"), Some("tar.zst"));
        assert_eq!(archive_kind("x.zip"), Some("zip"));
        assert_eq!(archive_kind("x.gz"), Some("gz"));
        assert_eq!(archive_kind("dir/x.xz"), Some("xz"));
        assert_eq!(archive_kind(".gz"), None, "只有后缀不算");
        assert_eq!(archive_kind("x.txt"), None);
    }

    #[test]
    fn timeouts_scale_with_size() {
        assert_eq!(compute_extract_timeout_ms(0), EXTRACT_MAX_TIMEOUT_MS);
        assert_eq!(compute_extract_timeout_ms(1), 90_000);
        assert_eq!(compute_extract_timeout_ms(10 * 1024 * 1024 + 1), 120_000);
        assert_eq!(compute_extract_timeout_ms(u64::MAX / 2), EXTRACT_MAX_TIMEOUT_MS);
    }

    #[test]
    fn plans() {
        let p = Path::new("/d/a.tar.gz");
        assert_eq!(
            build_local_extract_plan(p, false).unwrap(),
            ExtractPlan::Run { command: "tar".into(), args: vec!["-xzf".into(), "/d/a.tar.gz".into(), "-C".into(), "/d".into()], fallback: None }
        );
        match build_local_extract_plan(Path::new("/d/a.zip"), false).unwrap() {
            ExtractPlan::Run { command, fallback, .. } => {
                assert_eq!(command, "unzip");
                assert_eq!(fallback.unwrap().0, "tar");
            }
            other => panic!("{other:?}"),
        }
        match build_local_extract_plan(Path::new("/d/a.zip"), true).unwrap() {
            ExtractPlan::Run { command, .. } => assert_eq!(command, "tar"),
            other => panic!("{other:?}"),
        }
        assert_eq!(build_local_extract_plan(Path::new("/d/log.gz"), false).unwrap(), ExtractPlan::Gunzip { out: PathBuf::from("/d/log") });
        assert!(build_local_extract_plan(Path::new("/d/a.txt"), false).is_err());
    }

    #[test]
    fn gunzip_and_tar_really_extract() {
        let dir = std::env::temp_dir().join(format!("termx-extract-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // .gz（内置 flate2）
        let gz = dir.join("hello.txt.gz");
        {
            let f = std::fs::File::create(&gz).unwrap();
            let mut enc = flate2::write::GzEncoder::new(f, flate2::Compression::default());
            enc.write_all(b"hello netcatty").unwrap();
            enc.finish().unwrap();
        }
        let plan = build_local_extract_plan(&gz, false).unwrap();
        run_plan(&plan, &gz, Duration::from_secs(10)).unwrap();
        assert_eq!(std::fs::read(dir.join("hello.txt")).unwrap(), b"hello netcatty");
        // 已存在时覆盖
        run_plan(&plan, &gz, Duration::from_secs(10)).unwrap();
        assert_eq!(std::fs::read(dir.join("hello.txt")).unwrap(), b"hello netcatty");

        // .tar.gz（系统 tar；没有 tar 的环境跳过）
        if Command::new("tar").arg("--version").output().is_ok() {
            let src = dir.join("src");
            std::fs::create_dir_all(&src).unwrap();
            std::fs::write(src.join("a.txt"), b"A").unwrap();
            let tgz = dir.join("pkg.tar.gz");
            let ok = Command::new("tar").arg("-czf").arg(&tgz).arg("-C").arg(&src).arg("a.txt").status().unwrap();
            assert!(ok.success());
            std::fs::remove_dir_all(&src).unwrap();
            let plan = build_local_extract_plan(&tgz, false).unwrap();
            run_plan(&plan, &tgz, Duration::from_secs(10)).unwrap();
            assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"A");
            // 坏包要报错而不是静默成功
            let bad = dir.join("bad.tar.gz");
            std::fs::write(&bad, b"not a tarball").unwrap();
            let plan = build_local_extract_plan(&bad, false).unwrap();
            assert!(run_plan(&plan, &bad, Duration::from_secs(10)).is_err());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn temp_names_are_sanitized() {
        assert_eq!(safe_temp_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_temp_name("a\\b\\c.txt"), "c.txt");
        assert_eq!(safe_temp_name(".."), "file");
        assert_eq!(safe_temp_name("x<y>.log"), "x_y_.log");
        assert_eq!(safe_temp_name("name. "), "name");
        let p = fs_temp_file_path("报告.pdf".into()).unwrap();
        assert!(p.ends_with("报告.pdf"));
        assert!(Path::new(&p).parent().unwrap().is_dir());
    }

    #[test]
    fn recursive_copy_refuses_overwrite() {
        let dir = std::env::temp_dir().join(format!("termx-copy-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/sub")).unwrap();
        std::fs::write(dir.join("src/a.txt"), b"a").unwrap();
        std::fs::write(dir.join("src/sub/b.txt"), b"bb").unwrap();
        std::fs::create_dir_all(dir.join("out")).unwrap();
        assert_eq!(copy_recursive(&dir.join("src"), &dir.join("out/src")).unwrap(), 3);
        assert_eq!(std::fs::read(dir.join("out/src/sub/b.txt")).unwrap(), b"bb");
        assert!(copy_recursive(&dir.join("src"), &dir.join("out/src")).is_err(), "已存在时不覆盖");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn executable_detection() {
        assert!(is_executable_like(Path::new("/x/a.EXE")));
        assert!(is_executable_like(Path::new("/x/run.sh")));
        assert!(!is_executable_like(Path::new("/x/a.txt")));
        assert!(!is_executable_like(Path::new("/x/Makefile")));
    }
}
