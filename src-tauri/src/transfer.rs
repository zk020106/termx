//! 传输引擎：流式上传 / 下载（不整文件进内存），带进度、暂停 / 续传、取消、
//! 全局限速、冲突检查与 SHA-256 校验。
//!
//! - 数据先写到目标旁边的 `.termx-part` 临时文件，完成后再换上正式名字：
//!   中途失败不会留下半截的目标文件，已有的同名文件也只在最后一刻被替换；
//! - 暂停 = 停在当前位置并保留临时文件；继续 = 从临时文件的长度接着传；
//! - 进度事件 `transfer://progress/{id}` 每 250ms 一次；
//! - 校验：传输时边传边算 SHA-256，结束后在远端用 `sha256sum`（或 `shasum -a 256`）
//!   复算对比；远端没有这两个命令时如实报告「未比对」。

use crate::fs_guard::{checked_local_path, confirm_read, confirm_write};
use crate::sftp::SftpState;
use crate::ssh::{exec_on, SshState};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::watch;

pub const PART_SUFFIX: &str = ".termx-part";
const CHUNK: usize = 64 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Ctl {
    Run,
    Pause,
    Cancel,
}

/// 按方向的全局限速（字节/秒，0 = 不限）
#[derive(Default)]
pub struct Limiter {
    rate: AtomicU64,
    next: Mutex<Option<Instant>>,
}

impl Limiter {
    pub fn set(&self, bps: u64) {
        self.rate.store(bps, Ordering::Relaxed);
        if let Ok(mut n) = self.next.lock() {
            *n = None;
        }
    }

    /// 本次要传 n 字节，返回需要等待的时间（多个传输共享同一个额度）
    pub fn reserve(&self, n: usize) -> Duration {
        let rate = self.rate.load(Ordering::Relaxed);
        if rate == 0 {
            return Duration::ZERO;
        }
        let cost = Duration::from_secs_f64(n as f64 / rate as f64);
        let now = Instant::now();
        let mut next = self.next.lock().unwrap();
        let start = match *next {
            Some(t) if t > now => t,
            _ => now,
        };
        *next = Some(start + cost);
        start - now
    }
}

#[derive(Default)]
pub struct TransferState {
    jobs: Arc<Mutex<HashMap<String, watch::Sender<Ctl>>>>,
    pub upload: Arc<Limiter>,
    pub download: Arc<Limiter>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub transferred: u64,
    pub size: u64,
    pub speed_bps: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    /// done / paused / cancelled
    pub state: String,
    pub size: u64,
    pub transferred: u64,
    pub sha256: Option<String>,
    /// Some(true) 远端复算一致；Some(false) 不一致；None 未能比对
    pub verified: Option<bool>,
    pub verify_note: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SideInfo {
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub source: SideInfo,
    pub target: SideInfo,
    /// 目标旁边有上次暂停留下的部分文件，可以续传
    pub partial: u64,
}

fn mtime_secs(t: std::io::Result<std::time::SystemTime>) -> u64 {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

async fn local_info(path: &str) -> SideInfo {
    match tokio::fs::metadata(path).await {
        Ok(m) => SideInfo {
            exists: true,
            is_dir: m.is_dir(),
            size: m.len(),
            mtime: mtime_secs(m.modified()),
        },
        Err(_) => SideInfo::default(),
    }
}

async fn remote_info(sftp: &SftpSession, path: &str) -> SideInfo {
    match sftp.metadata(path).await {
        Ok(m) => SideInfo {
            exists: true,
            is_dir: m.is_dir(),
            size: m.size.unwrap_or(0),
            mtime: m.mtime.unwrap_or(0) as u64,
        },
        Err(_) => SideInfo::default(),
    }
}

/// 单引号转义，供远端 shell 命令使用
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 从 `sha256sum` / `shasum` 的输出里取出十六进制摘要
pub fn parse_sha_output(stdout: &str) -> Option<String> {
    let first = stdout.split_whitespace().next()?;
    let first = first.trim_start_matches('\\');
    (first.len() == 64 && first.chars().all(|c| c.is_ascii_hexdigit())).then(|| first.to_ascii_lowercase())
}

async fn remote_sha256(ssh: &SshState, key: &str, path: &str) -> Result<String, String> {
    let handle = ssh.handle(key).ok_or("会话的 SSH 连接已不在，无法在远端复算")?;
    let q = shell_quote(path);
    let cmd = format!("sha256sum -- {q} 2>/dev/null || shasum -a 256 -- {q} 2>/dev/null");
    let out = exec_on(&handle, &cmd, Duration::from_secs(600)).await?;
    parse_sha_output(&out.stdout).ok_or_else(|| "远端没有 sha256sum / shasum 命令".to_string())
}

/// 远端原子替换：先 rename；目标已存在而服务器不允许覆盖时，先把旧文件挪开再换上
pub async fn remote_replace(sftp: &SftpSession, from: &str, to: &str) -> Result<(), String> {
    if sftp.rename(from, to).await.is_ok() {
        return Ok(());
    }
    if !sftp.try_exists(to).await.unwrap_or(false) {
        return sftp
            .rename(from, to)
            .await
            .map_err(|e| format!("把临时文件换成 {to} 失败：{e}"));
    }
    let backup = format!("{to}.termx-old-{}", std::process::id());
    sftp.rename(to, backup.clone())
        .await
        .map_err(|e| format!("无法替换已有文件 {to}：{e}"))?;
    match sftp.rename(from, to).await {
        Ok(()) => {
            let _ = sftp.remove_file(backup).await;
            Ok(())
        }
        Err(e) => {
            // 换不上就把旧文件放回去，别让用户两头落空
            let _ = sftp.rename(backup, to).await;
            Err(format!("把临时文件换成 {to} 失败：{e}"))
        }
    }
}

struct Copy<'a> {
    app: &'a AppHandle,
    id: &'a str,
    limiter: &'a Limiter,
    ctl: watch::Receiver<Ctl>,
    size: u64,
}

/// 搬运字节：限速、进度、暂停/取消、边传边算哈希
async fn copy_stream<R, W>(
    c: &mut Copy<'_>,
    reader: &mut R,
    writer: &mut W,
    start: u64,
    hasher: &mut Sha256,
) -> Result<(u64, Ctl), String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    let mut done = start;
    let begun = Instant::now();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut window: (Instant, u64) = (Instant::now(), done);
    let mut speed = 0u64;
    loop {
        let ctl = *c.ctl.borrow();
        if ctl != Ctl::Run {
            writer.flush().await.map_err(|e| format!("写入失败：{e}"))?;
            return Ok((done, ctl));
        }
        let n = reader.read(&mut buf).await.map_err(|e| format!("读取失败：{e}"))?;
        if n == 0 {
            break;
        }
        let wait = c.limiter.reserve(n);
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        writer
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("写入失败：{e}"))?;
        hasher.update(&buf[..n]);
        done += n as u64;
        if last_emit.elapsed() >= Duration::from_millis(250) {
            let elapsed = window.0.elapsed().as_secs_f64();
            if elapsed >= 0.5 {
                speed = ((done - window.1) as f64 / elapsed) as u64;
                window = (Instant::now(), done);
            } else if speed == 0 {
                let total = begun.elapsed().as_secs_f64().max(0.001);
                speed = ((done - start) as f64 / total) as u64;
            }
            last_emit = Instant::now();
            let _ = c.app.emit(
                &format!("transfer://progress/{}", c.id),
                Progress { transferred: done, size: c.size.max(done), speed_bps: speed },
            );
        }
    }
    writer.flush().await.map_err(|e| format!("写入失败：{e}"))?;
    let _ = c.app.emit(
        &format!("transfer://progress/{}", c.id),
        Progress { transferred: done, size: c.size.max(done), speed_bps: speed },
    );
    Ok((done, Ctl::Run))
}

/// 续传前把已有的部分重新算进哈希（不重传，只读本地/远端已有字节）
async fn hash_prefix<R: AsyncRead + Unpin>(reader: &mut R, len: u64, hasher: &mut Sha256) -> Result<(), String> {
    let mut left = len;
    let mut buf = vec![0u8; CHUNK];
    while left > 0 {
        let want = (left as usize).min(CHUNK);
        let n = reader.read(&mut buf[..want]).await.map_err(|e| format!("读取已传部分失败：{e}"))?;
        if n == 0 {
            return Err("已传部分比预期短，无法续传".into());
        }
        hasher.update(&buf[..n]);
        left -= n as u64;
    }
    Ok(())
}

struct JobGuard {
    jobs: Arc<Mutex<HashMap<String, watch::Sender<Ctl>>>>,
    id: String,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.jobs.lock() {
            map.remove(&self.id);
        }
    }
}

/// 冲突检查：源与目标的真实大小 / 修改时间，以及可续传的部分文件
#[tauri::command]
pub async fn transfer_check(
    sftp_state: State<'_, SftpState>,
    key: String,
    direction: String,
    local_path: String,
    remote_path: String,
) -> Result<ConflictInfo, String> {
    checked_local_path(&local_path)?;
    let sftp = sftp_state.get_sftp(&key).await?;
    let (source, target, partial) = if direction == "upload" {
        let part = remote_info(&sftp, &format!("{remote_path}{PART_SUFFIX}")).await;
        (local_info(&local_path).await, remote_info(&sftp, &remote_path).await, part)
    } else {
        let part = local_info(&format!("{local_path}{PART_SUFFIX}")).await;
        (remote_info(&sftp, &remote_path).await, local_info(&local_path).await, part)
    };
    Ok(ConflictInfo {
        source,
        target,
        partial: if partial.exists { partial.size } else { 0 },
    })
}

/// 执行一次传输（直到完成、暂停或取消才返回）
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transfer_start(
    app: AppHandle,
    state: State<'_, TransferState>,
    sftp_state: State<'_, SftpState>,
    ssh_state: State<'_, SshState>,
    id: String,
    key: String,
    direction: String,
    local_path: String,
    remote_path: String,
    resume: bool,
    verify: bool,
) -> Result<TransferResult, String> {
    // 本地路径：绝对路径、无 `..`（下载目标里拼着不可信的远程文件名）；
    // 上传私钥等敏感文件、或下载写进 ~/.ssh 之类的位置，要用户在原生对话框里确认
    let local = checked_local_path(&local_path)?;
    if direction == "upload" {
        confirm_read(&app, &local, "上传").await?;
    } else {
        confirm_write(&app, &local, "下载写入").await?;
        if tokio::fs::metadata(&local).await.map(|m| m.is_dir()).unwrap_or(false) {
            return Err(format!("下载目标「{local_path}」是一个目录"));
        }
    }
    let sftp = sftp_state.get_sftp(&key).await?;
    let (tx, rx) = watch::channel(Ctl::Run);
    {
        let mut jobs = state.jobs.lock().map_err(|_| "传输表已损坏".to_string())?;
        if jobs.contains_key(&id) {
            return Err("这项传输已经在进行".into());
        }
        jobs.insert(id.clone(), tx);
    }
    let _guard = JobGuard { jobs: state.jobs.clone(), id: id.clone() };
    let mut hasher = Sha256::new();

    let (outcome, size) = if direction == "upload" {
        let mut src = tokio::fs::File::open(&local_path)
            .await
            .map_err(|e| format!("读取本地文件失败：{e}"))?;
        let size = src.metadata().await.map(|m| m.len()).unwrap_or(0);
        let part = format!("{remote_path}{PART_SUFFIX}");
        let mut offset = 0u64;
        if resume {
            if let Ok(m) = sftp.metadata(part.clone()).await {
                offset = m.size.unwrap_or(0).min(size);
            }
        }
        let flags = if offset > 0 {
            OpenFlags::WRITE | OpenFlags::CREATE
        } else {
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
        };
        let mut dst = sftp
            .open_with_flags(part.clone(), flags)
            .await
            .map_err(|e| format!("在远端创建临时文件失败：{e}"))?;
        if offset > 0 {
            hash_prefix(&mut src, offset, &mut hasher).await?;
            dst.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|e| format!("远端定位续传位置失败：{e}"))?;
        }
        let mut c = Copy { app: &app, id: &id, limiter: &state.upload, ctl: rx, size };
        let (done, ctl) = copy_stream(&mut c, &mut src, &mut dst, offset, &mut hasher).await?;
        dst.shutdown().await.map_err(|e| format!("关闭远端文件失败：{e}"))?;
        drop(dst);
        match ctl {
            Ctl::Pause => (TransferResult { state: "paused".into(), size, transferred: done, ..Default::default() }, size),
            Ctl::Cancel => {
                let _ = sftp.remove_file(part).await;
                (TransferResult { state: "cancelled".into(), size, transferred: done, ..Default::default() }, size)
            }
            Ctl::Run => {
                remote_replace(&sftp, &part, &remote_path).await?;
                (TransferResult { state: "done".into(), size, transferred: done, ..Default::default() }, size)
            }
        }
    } else {
        let mut src = sftp
            .open(remote_path.clone())
            .await
            .map_err(|e| format!("打开远端文件失败：{e}"))?;
        let size = src.metadata().await.ok().and_then(|m| m.size).unwrap_or(0);
        let part = format!("{local_path}{PART_SUFFIX}");
        let mut offset = 0u64;
        if resume {
            if let Ok(m) = tokio::fs::metadata(&part).await {
                offset = m.len().min(size);
            }
        }
        let mut dst = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .read(true)
            .truncate(offset == 0)
            .open(&part)
            .await
            .map_err(|e| format!("创建本地临时文件失败：{e}"))?;
        if offset > 0 {
            hash_prefix(&mut dst, offset, &mut hasher).await?;
            dst.set_len(offset).await.map_err(|e| format!("截断本地临时文件失败：{e}"))?;
            dst.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|e| format!("本地定位续传位置失败：{e}"))?;
            src.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|e| format!("远端定位续传位置失败：{e}"))?;
        }
        let mut c = Copy { app: &app, id: &id, limiter: &state.download, ctl: rx, size };
        let (done, ctl) = copy_stream(&mut c, &mut src, &mut dst, offset, &mut hasher).await?;
        dst.sync_all().await.map_err(|e| format!("写入本地磁盘失败：{e}"))?;
        drop(dst);
        match ctl {
            Ctl::Pause => (TransferResult { state: "paused".into(), size, transferred: done, ..Default::default() }, size),
            Ctl::Cancel => {
                let _ = tokio::fs::remove_file(&part).await;
                (TransferResult { state: "cancelled".into(), size, transferred: done, ..Default::default() }, size)
            }
            Ctl::Run => {
                tokio::fs::rename(&part, &local_path)
                    .await
                    .map_err(|e| format!("把临时文件换成 {local_path} 失败：{e}"))?;
                (TransferResult { state: "done".into(), size, transferred: done, ..Default::default() }, size)
            }
        }
    };

    let mut result = outcome;
    if result.state != "done" {
        return Ok(result);
    }
    result.size = size.max(result.transferred);
    let local_hash = hex(&hasher.finalize());
    result.sha256 = Some(local_hash.clone());
    if verify {
        match remote_sha256(&ssh_state, &key, &remote_path).await {
            Ok(remote) if remote == local_hash => {
                result.verified = Some(true);
                result.verify_note = Some("已在远端用 sha256sum 复算，一致".into());
            }
            Ok(remote) => {
                result.verified = Some(false);
                result.verify_note = Some(format!("SHA-256 不一致：本地 {local_hash}，远端 {remote}"));
            }
            Err(note) => {
                result.verified = None;
                result.verify_note = Some(format!("未比对：{note}（本地 SHA-256 已记录）"));
            }
        }
    }
    Ok(result)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 暂停 / 取消一项进行中的传输
#[tauri::command]
pub fn transfer_control(state: State<'_, TransferState>, id: String, action: String) -> Result<bool, String> {
    let ctl = match action.as_str() {
        "pause" => Ctl::Pause,
        "cancel" => Ctl::Cancel,
        other => return Err(format!("未知的传输操作 {other}")),
    };
    let jobs = state.jobs.lock().map_err(|_| "传输表已损坏".to_string())?;
    Ok(match jobs.get(&id) {
        Some(tx) => tx.send(ctl).is_ok(),
        None => false,
    })
}

/// 设置全局限速（字节/秒，0 = 不限），上传与下载分别生效
#[tauri::command]
pub fn transfer_set_limits(state: State<'_, TransferState>, upload_bps: u64, download_bps: u64) {
    state.upload.set(upload_bps);
    state.download.set(download_bps);
}

/// 丢弃暂停留下的部分文件（用户选择「取消」已暂停的传输时）
#[tauri::command]
pub async fn transfer_discard_partial(
    sftp_state: State<'_, SftpState>,
    key: Option<String>,
    direction: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    if direction == "upload" {
        if let Some(key) = key {
            let sftp = sftp_state.get_sftp(&key).await?;
            let _ = sftp.remove_file(format!("{remote_path}{PART_SUFFIX}")).await;
        }
    } else {
        checked_local_path(&local_path)?;
        let _ = tokio::fs::remove_file(format!("{local_path}{PART_SUFFIX}")).await;
    }
    Ok(())
}

/// 在系统文件管理器里定位文件（「打开所在目录」）
#[tauri::command]
pub fn fs_reveal(path: String) -> Result<(), String> {
    let checked = checked_local_path(&path)?;
    let p = checked.as_path();
    let spawn = |cmd: &mut std::process::Command| cmd.spawn().map(|_| ()).map_err(|e| format!("无法打开文件管理器：{e}"));
    #[cfg(windows)]
    {
        if p.exists() {
            return spawn(std::process::Command::new("explorer").arg(format!("/select,{}", p.display())));
        }
        let dir = p.parent().unwrap_or(p);
        spawn(std::process::Command::new("explorer").arg(dir))
    }
    #[cfg(target_os = "macos")]
    {
        if p.exists() {
            return spawn(std::process::Command::new("open").arg("-R").arg(p));
        }
        spawn(std::process::Command::new("open").arg(p.parent().unwrap_or(p)))
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
        spawn(std::process::Command::new("xdg-open").arg(dir))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limiter_spreads_bytes_over_time() {
        let l = Limiter::default();
        assert_eq!(l.reserve(1_000_000), Duration::ZERO, "不限速时不等待");
        l.set(1000);
        assert_eq!(l.reserve(500), Duration::ZERO, "第一块立即发出");
        let wait = l.reserve(500);
        assert!(wait >= Duration::from_millis(450) && wait <= Duration::from_millis(510), "{wait:?}");
        l.set(0);
        assert_eq!(l.reserve(10), Duration::ZERO);
    }

    #[test]
    fn sha_output_parsing() {
        let h = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(parse_sha_output(&format!("{h}  /tmp/x\n")).as_deref(), Some(h));
        assert_eq!(parse_sha_output(&format!("\\{h}  /tmp/a\\nb\n")).as_deref(), Some(h));
        assert_eq!(parse_sha_output(""), None);
        assert_eq!(parse_sha_output("sha256sum: not found"), None);
    }

    #[test]
    fn shell_quoting() {
        assert_eq!(shell_quote("/tmp/a b"), "'/tmp/a b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    #[tokio::test]
    async fn hash_prefix_matches_full_hash() {
        let data = b"hello world, this is termx".to_vec();
        let mut whole = Sha256::new();
        whole.update(&data);
        let mut h = Sha256::new();
        let mut r = &data[..10];
        hash_prefix(&mut r, 10, &mut h).await.unwrap();
        h.update(&data[10..]);
        assert_eq!(hex(&h.finalize()), hex(&whole.finalize()));
        let mut short = &data[..3];
        assert!(hash_prefix(&mut short, 10, &mut Sha256::new()).await.is_err());
    }
}
