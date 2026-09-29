//! 本地终端（PTY）：为工作区的每个终端格提供真实 shell。
//!
//! 前端契约（见 src/lib/tauri.ts）：
//!   pty_spawn(key, cols, rows)
//!   pty_write(key, data)
//!   pty_resize(key, cols, rows)
//!   pty_kill(key)
//! 事件：
//!   `pty://data/{key}`  载荷为 UTF-8 文本片段
//!   `pty://exit/{key}`  载荷为退出码，拿不到时为 null
//!
//! key 由前端生成：前端必须先注册好事件监听再调用 pty_spawn，
//! 否则 shell 的首屏输出会在监听就绪前发出而丢失。

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

/// 默认本地 shell。Windows 用 PowerShell，Unix 用 $SHELL。
#[cfg(windows)]
fn default_shell() -> (String, Vec<String>) {
    ("powershell.exe".to_string(), vec!["-NoLogo".to_string()])
}

#[cfg(not(windows))]
fn default_shell() -> (String, Vec<String>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    (shell, Vec::new())
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    key: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("打开 PTY 失败：{e}"))?;

    let (program, args) = default_shell();
    let mut cmd = CommandBuilder::new(program);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.env("TERM", "xterm-256color");
    if let Ok(cwd) = std::env::current_dir() {
        cmd.cwd(cwd);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动 shell 失败：{e}"))?;

    // slave 必须尽早释放，否则 Windows 上读端不会收到 EOF
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("读取 PTY 失败：{e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("写入 PTY 失败：{e}"))?;

    // 读线程：把 shell 输出按块推给前端
    let data_event = format!("pty://data/{key}");
    let exit_event = format!("pty://exit/{key}");
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    if app_handle.emit(&data_event, chunk).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_handle.emit(&exit_event, None::<i32>);
    });

    state
        .sessions
        .lock()
        .map_err(|_| "PTY 会话表已损坏".to_string())?
        .insert(
            key,
            PtySession {
                writer,
                master: pair.master,
                child,
            },
        );

    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, key: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "PTY 会话表已损坏".to_string())?;
    let session = sessions.get_mut(&key).ok_or_else(|| format!("未找到会话 {key}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("写入失败：{e}"))?;
    session.writer.flush().map_err(|e| format!("刷新失败：{e}"))
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    key: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "PTY 会话表已损坏".to_string())?;
    let session = sessions.get(&key).ok_or_else(|| format!("未找到会话 {key}"))?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("调整尺寸失败：{e}"))
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, key: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "PTY 会话表已损坏".to_string())?;
    if let Some(mut session) = sessions.remove(&key) {
        let _ = session.child.kill();
    }
    Ok(())
}
