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
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

type SharedChild = Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>;

struct PtySession {
    /// 键盘输入交给专门的写线程：写 PTY 可能阻塞（子进程不读 stdin、大段粘贴），
    /// 绝不能在命令里（同步命令跑在主线程上）、更不能在持有会话表锁时直接写
    input: Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    /// 读线程在 EOF 后要 wait() 拿退出码并回收进程，所以与会话表共享
    child: SharedChild,
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
    // 同一个键重复启动会让两个 shell 抢同一条事件通道（旧的那个还会变成孤儿进程）
    if state
        .sessions
        .lock()
        .map_err(|_| "PTY 会话表已损坏".to_string())?
        .contains_key(&key)
    {
        return Err(format!("本地会话 {key} 已存在"));
    }
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
    // 新终端从用户主目录开始（与系统终端一致），而不是应用的安装 / 启动目录
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    } else if let Ok(cwd) = std::env::current_dir() {
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
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("写入 PTY 失败：{e}"))?;

    // 写线程：串行把输入写进 PTY。会话被移出表（pty_kill / 退出）后发送端随之释放，线程自然结束
    let (input, input_rx) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for bytes in input_rx {
            if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                break;
            }
        }
    });

    // 读线程：把 shell 输出按块推给前端
    let data_event = format!("pty://data/{key}");
    let exit_event = format!("pty://exit/{key}");
    let app_handle = app.clone();
    let child: SharedChild = Arc::new(Mutex::new(child));
    let thread_child = child.clone();
    let sessions = state.sessions.clone();
    let thread_key = key.clone();

    // 先登记再起读线程：shell 秒退时读线程的清理不会扑空
    state
        .sessions
        .lock()
        .map_err(|_| "PTY 会话表已损坏".to_string())?
        .insert(
            key,
            PtySession {
                input,
                master: pair.master,
                child,
            },
        );

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        // 流式解码：多字节字符被拆在两次读取之间时不会变成乱码
        let mut codec = crate::codec::TermCodec::new("UTF-8");
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = codec.decode(&buf[..n]);
                    if !chunk.is_empty() && app_handle.emit(&data_event, chunk).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let tail = codec.finish();
        if !tail.is_empty() {
            let _ = app_handle.emit(&data_event, tail);
        }
        // 回收子进程拿真实退出码（不 wait 会留下僵尸进程）
        let code = thread_child
            .lock()
            .ok()
            .and_then(|mut c| c.wait().ok())
            .map(|status| status.exit_code() as i32);
        if let Ok(mut map) = sessions.lock() {
            let same = map
                .get(&thread_key)
                .map(|s| Arc::ptr_eq(&s.child, &thread_child))
                .unwrap_or(false);
            if same {
                map.remove(&thread_key);
            }
        }
        let _ = app_handle.emit(&exit_event, code);
    });

    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, key: String, data: String) -> Result<(), String> {
    // 只做投递，不在这里写 PTY：阻塞写会冻住整个窗口
    let sessions = state.sessions.lock().map_err(|_| "PTY 会话表已损坏".to_string())?;
    let session = sessions.get(&key).ok_or_else(|| format!("未找到会话 {key}"))?;
    session
        .input
        .send(data.into_bytes())
        .map_err(|_| "会话已结束，写入失败".to_string())
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
    if let Some(session) = sessions.remove(&key) {
        // 只发信号，不在这里 wait：读线程收到 EOF 后会 wait 回收并报退出码
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}
