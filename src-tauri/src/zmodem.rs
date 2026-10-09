//! ZMODEM（rz / sz）—— 对应 Netcatty electron/bridges/zmodemHelper.cjs。
//!
//! Netcatty 在 Electron 主进程（Node）里用 zmodem.js 的 Sentry 包住会话的原始字节流。
//! Tauri 的「主进程」是 Rust，跑不了 zmodem.js，所以拆成两半：
//! - Rust（这里）：会话循环里的 [`ZmodemGate`] 在**解码之前**盯着原始字节，一旦出现
//!   ZRQINIT / ZRINIT 十六进制头（`**␘B00` / `**␘B01`，即 sz / rz 开始），就从这里开始把
//!   原始字节原样（base64）推给前端 `ssh://zmodem/{key}`，不再经过字符解码；前端收尾后
//!   调 `ssh_zmodem_release` 回到正常的解码通道。键入方向用 `ssh_write_bytes` 发原始字节。
//!   平时（没有 ZMODEM）数据路径与编码解码器完全不变。
//! - 前端（src/lib/zmodem）：同一个 zmodem.js 0.1.10 Sentry 与 zmodemHelper 的逻辑原样移植。
//! - 本地文件：Netcatty 用 dialog.showOpenDialog + fs；这里用原生对话框选文件 / 目录，Rust
//!   只把**用户在对话框里选中的**路径登记成一次性令牌，前端只能按令牌读写，拿不到也传不进任意路径；
//!   读之前过 `confirm_read`（私钥 / 敏感位置要用户确认），写之前过 `confirm_write`。

use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::fs_guard::{confirm_read, confirm_write};

/* --------------------------------- 字节流闸门 --------------------------------- */

const ZRQINIT_HEX: &[u8] = b"**\x18B00";
const ZRINIT_HEX: &[u8] = b"**\x18B01";

/// 会话输出的 ZMODEM 闸门：正常模式下原样放行给解码器；看到 sz / rz 的起始头后切到原始模式
#[derive(Default)]
pub struct ZmodemGate {
    raw: bool,
    /// 包尾可能是半个起始头，先扣下来等下一包（或短暂超时后放行）
    held: Vec<u8>,
}

pub struct GateOutput {
    /// 交给字符解码器的字节
    pub text: Vec<u8>,
    /// 原样交给前端 zmodem.js 的字节
    pub raw: Option<Vec<u8>>,
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

impl ZmodemGate {
    pub fn is_raw(&self) -> bool {
        self.raw
    }

    pub fn has_held(&self) -> bool {
        !self.held.is_empty()
    }

    pub fn feed(&mut self, data: &[u8]) -> GateOutput {
        let mut buf = std::mem::take(&mut self.held);
        buf.extend_from_slice(data);
        if self.raw {
            return GateOutput { text: Vec::new(), raw: Some(buf) };
        }
        let hit = [find(&buf, ZRQINIT_HEX), find(&buf, ZRINIT_HEX)].into_iter().flatten().min();
        if let Some(at) = hit {
            self.raw = true;
            let raw = buf.split_off(at);
            return GateOutput { text: buf, raw: Some(raw) };
        }
        // 尾部是起始头的前缀（"*"、"**"、"**␘"、"**␘B"、"**␘B0"）：先扣下
        let max = (ZRQINIT_HEX.len() - 1).min(buf.len());
        let keep = (1..=max).rev().find(|&n| buf.ends_with(&ZRQINIT_HEX[..n])).unwrap_or(0);
        self.held = buf.split_off(buf.len() - keep);
        GateOutput { text: buf, raw: None }
    }

    /// 扣下的半个头等不到下文：照常放行
    pub fn flush_held(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.held)
    }

    /// 前端的 ZMODEM 会话收尾：回到解码通道
    pub fn release(&mut self) {
        self.raw = false;
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ZmodemChunk {
    /// 会话编码（前端 zmodem.js 交还给终端的字节按它解码）
    pub encoding: &'static str,
    pub data: String,
}

pub fn chunk(encoding: &'static str, bytes: &[u8]) -> ZmodemChunk {
    ZmodemChunk { encoding, data: base64::engine::general_purpose::STANDARD.encode(bytes) }
}

/* --------------------------------- 本地文件 --------------------------------- */

#[derive(Default)]
pub struct ZmodemState {
    inner: Mutex<ZmodemFiles>,
}

#[derive(Default)]
struct ZmodemFiles {
    /// 上传：用户选中的文件
    reads: HashMap<String, PathBuf>,
    /// 下载：用户选中的目录
    dirs: HashMap<String, PathBuf>,
    /// 下载：正在写的文件
    writes: HashMap<String, (std::fs::File, PathBuf)>,
}

fn token() -> String {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0u8; 16];
    SystemRandom::new().fill(&mut bytes).expect("system rng");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub token: String,
    pub name: String,
    pub size: u64,
    pub mtime_ms: f64,
}

fn file_path_of(fp: tauri_plugin_dialog::FilePath) -> Option<PathBuf> {
    fp.into_path().ok()
}

/// Netcatty handleUpload 的 showOpenDialog（openFile + multiSelections，标题同）。取消返回 None
#[tauri::command]
pub async fn zmodem_pick_upload_files(app: AppHandle, state: State<'_, ZmodemState>) -> Result<Option<Vec<PickedFile>>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Select files to upload (ZMODEM)")
        .pick_files(move |paths| {
            let _ = tx.send(paths);
        });
    let Some(paths) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    let mut out = Vec::new();
    for fp in paths {
        let Some(path) = file_path_of(fp) else { continue };
        let meta = std::fs::metadata(&path).map_err(|e| format!("读取「{}」失败：{e}", path.display()))?;
        if !meta.is_file() {
            return Err(format!("「{}」不是普通文件", path.display()));
        }
        confirm_read(&app, &path, "经 ZMODEM 上传").await?;
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let t = token();
        state.inner.lock().map_err(|_| "ZMODEM 状态损坏")?.reads.insert(t.clone(), path);
        out.push(PickedFile { token: t, name, size: meta.len(), mtime_ms });
    }
    if out.is_empty() {
        return Ok(None);
    }
    Ok(Some(out))
}

/// 按令牌读用户选中文件的一段（原始字节）
#[tauri::command]
pub fn zmodem_read_chunk(state: State<'_, ZmodemState>, token: String, offset: u64, length: u32) -> Result<tauri::ipc::Response, String> {
    let path = state
        .inner
        .lock()
        .map_err(|_| "ZMODEM 状态损坏")?
        .reads
        .get(&token)
        .cloned()
        .ok_or("这个文件没有经过选择，不能读取")?;
    let mut f = std::fs::File::open(&path).map_err(|e| format!("打开「{}」失败：{e}", path.display()))?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; length.min(1024 * 1024) as usize];
    let mut filled = 0;
    while filled < buf.len() {
        let n = f.read(&mut buf[filled..]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    buf.truncate(filled);
    Ok(tauri::ipc::Response::new(buf))
}

/// 上传结束：作废这些令牌
#[tauri::command]
pub fn zmodem_release_files(state: State<'_, ZmodemState>, tokens: Vec<String>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "ZMODEM 状态损坏")?;
    for t in tokens {
        inner.reads.remove(&t);
        inner.dirs.remove(&t);
    }
    Ok(())
}

/// Netcatty handleDownload 的 showOpenDialog（openDirectory + createDirectory，标题同）
#[tauri::command]
pub async fn zmodem_pick_download_dir(app: AppHandle, state: State<'_, ZmodemState>) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Select download directory (ZMODEM)")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    let Some(dir) = rx.await.ok().flatten().and_then(file_path_of) else {
        return Ok(None);
    };
    let t = token();
    state.inner.lock().map_err(|_| "ZMODEM 状态损坏")?.dirs.insert(t.clone(), dir);
    Ok(Some(t))
}

/// Netcatty processOffer：远端给的文件名只取 basename（防路径穿越），已存在时追加 (1)、(2)…
pub fn download_target(dir: &Path, raw_name: &str, fallback_stamp: u128) -> PathBuf {
    let base = raw_name.rsplit(['/', '\\']).next().unwrap_or("");
    let name = if base.is_empty() || base == "." || base == ".." {
        format!("untitled_{fallback_stamp}")
    } else {
        base.replace('\0', "_")
    };
    let first = dir.join(&name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name.as_str(), ""),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("unbounded")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedFile {
    pub token: String,
    pub name: String,
    pub path: String,
}

#[tauri::command]
pub async fn zmodem_create_file(app: AppHandle, state: State<'_, ZmodemState>, dir_token: String, name: String) -> Result<CreatedFile, String> {
    let dir = state
        .inner
        .lock()
        .map_err(|_| "ZMODEM 状态损坏")?
        .dirs
        .get(&dir_token)
        .cloned()
        .ok_or("下载目录没有经过选择")?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = download_target(&dir, &name, stamp);
    confirm_write(&app, &path, "经 ZMODEM 下载写入").await?;
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("创建「{}」失败：{e}", path.display()))?;
    let t = token();
    let shown = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    state.inner.lock().map_err(|_| "ZMODEM 状态损坏")?.writes.insert(t.clone(), (file, path.clone()));
    Ok(CreatedFile { token: t, name: shown, path: path.display().to_string() })
}

#[tauri::command]
pub fn zmodem_write_chunk(state: State<'_, ZmodemState>, token: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    let mut inner = state.inner.lock().map_err(|_| "ZMODEM 状态损坏")?;
    let (file, path) = inner.writes.get_mut(&token).ok_or("没有这个下载文件")?;
    file.write_all(&bytes).map_err(|e| format!("写入「{}」失败：{e}", path.display()))
}

/// 一个文件收完（completed=true）或中断（false：同 Netcatty 删掉不完整的文件）
#[tauri::command]
pub fn zmodem_finish_file(state: State<'_, ZmodemState>, token: String, completed: bool) -> Result<(), String> {
    let entry = state.inner.lock().map_err(|_| "ZMODEM 状态损坏")?.writes.remove(&token);
    if let Some((mut file, path)) = entry {
        let flushed = file.flush();
        drop(file);
        if !completed {
            let _ = std::fs::remove_file(&path);
        }
        flushed.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_passes_text_and_switches_on_header() {
        let mut g = ZmodemGate::default();
        let out = g.feed(b"hello ");
        assert_eq!(out.text, b"hello ");
        assert!(out.raw.is_none());
        let out = g.feed(b"rz\r**\x18B0100000023be50\r\n\x11");
        assert_eq!(out.text, b"rz\r");
        assert_eq!(out.raw.unwrap(), b"**\x18B0100000023be50\r\n\x11");
        assert!(g.is_raw());
        let out = g.feed(b"\xff\x00binary");
        assert!(out.text.is_empty());
        assert_eq!(out.raw.unwrap(), b"\xff\x00binary");
        g.release();
        assert_eq!(g.feed(b"$ ").text, b"$ ");
    }

    #[test]
    fn gate_holds_split_header() {
        let mut g = ZmodemGate::default();
        let out = g.feed(b"abc**\x18");
        assert_eq!(out.text, b"abc");
        assert!(g.has_held());
        let out = g.feed(b"B00000000000000\r\n");
        assert!(out.text.is_empty());
        assert_eq!(out.raw.unwrap(), b"**\x18B00000000000000\r\n");
        // 只是普通星号：超时放行
        let mut g = ZmodemGate::default();
        assert_eq!(g.feed(b"Password: **").text, b"Password: ");
        assert_eq!(g.flush_held(), b"**");
        // 不是起始头的 `**`
        let mut g = ZmodemGate::default();
        assert_eq!(g.feed(b"a**b").text, b"a**b");
        // 多字节 UTF-8 不受影响
        assert_eq!(g.feed("中文".as_bytes()).text, "中文".as_bytes());
    }

    #[test]
    fn download_target_is_basename_and_deduped() {
        let dir = std::env::temp_dir().join(format!("termx-zm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(download_target(&dir, "../../etc/passwd", 1), dir.join("passwd"));
        assert_eq!(download_target(&dir, "a\\b\\c.txt", 1), dir.join("c.txt"));
        assert_eq!(download_target(&dir, "..", 7), dir.join("untitled_7"));
        std::fs::write(dir.join("r.tar.gz"), b"x").unwrap();
        assert_eq!(download_target(&dir, "r.tar.gz", 1), dir.join("r.tar (1).gz"));
        std::fs::write(dir.join("r.tar (1).gz"), b"x").unwrap();
        assert_eq!(download_target(&dir, "r.tar.gz", 1), dir.join("r.tar (2).gz"));
        std::fs::write(dir.join(".bashrc"), b"x").unwrap();
        assert_eq!(download_target(&dir, ".bashrc", 1), dir.join(".bashrc (1)"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
