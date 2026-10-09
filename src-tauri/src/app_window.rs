//! 多窗口：Netcatty「复制标签页到新窗口」（electron/main/registerBridges.cjs `netcatty:window:openSession`）。
//!
//! Netcatty 的做法：主进程新建一个完整的应用窗口（route `#/session-window`），等渲染端就绪后
//! 把源会话描述（sourceSession）推过去，新窗口用 `createSessionFromCloneSource` 克隆出一条新会话；
//! 新窗口不做会话恢复、托盘、端口转发自启这些「只该主窗口做一次」的事。
//!
//! Tauri 等价实现：
//! - `window_open_session` 建一个标签为 `session-N` 的 WebviewWindow（与主窗口同样无边框、深色），
//!   把载荷按窗口标签暂存；新窗口启动后用 `window_take_session_payload` 取走（拉取式，
//!   相当于 Netcatty 的 sendWhenRendererReady，但不怕渲染端还没挂监听）。
//! - 能力文件的 `windows` 加了 `session-*`，命令白名单与主窗口一致（同一份 build.rs 清单）。
//! - 会话归属：前端在建立 SSH / 本地 PTY 会话后调用 `window_own_session` 登记；窗口销毁时
//!   （Netcatty：webContents destroyed → 清理该窗口的会话）把它名下的会话全部断开，不留孤儿连接。
//! - 配置跨窗口同步：`config_save` 写盘后广播 `config://changed`（见 config.rs），
//!   其它窗口重新载入，避免各自持有旧副本互相覆盖（Netcatty 靠同源 localStorage 的 storage 事件）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window};

/// 新窗口载荷上限：只放标签布局与主机 id，不该很大（防止把任意大对象塞进进程内存）
const MAX_PAYLOAD_BYTES: usize = 256 * 1024;

#[derive(Default)]
pub struct AppWindowState {
    seq: AtomicU32,
    payloads: Mutex<HashMap<String, Value>>,
    /// 窗口标签 → 该窗口名下的会话（kind, key）
    owners: Mutex<HashMap<String, Vec<(SessionKind, String)>>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Ssh,
    Pty,
}

pub fn is_session_window_label(label: &str) -> bool {
    label
        .strip_prefix("session-")
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Netcatty `netcatty:window:openSession`：新窗口打开传入的标签（克隆，不共享原会话）。
/// 必须是 async 命令：Windows 上在同步命令里建窗口会死锁（Tauri 文档）。
#[tauri::command]
pub async fn window_open_session(
    app: AppHandle,
    state: tauri::State<'_, AppWindowState>,
    title: String,
    payload: Value,
) -> Result<(), String> {
    if !payload.is_object() {
        return Err("Invalid session payload".into());
    }
    if serde_json::to_vec(&payload).map(|v| v.len()).unwrap_or(usize::MAX) > MAX_PAYLOAD_BYTES {
        return Err("会话载荷过大".into());
    }
    let title = match title.trim() {
        "" => "TermX".to_string(),
        t => t.chars().take(200).collect(),
    };
    let label = format!("session-{}", state.seq.fetch_add(1, Ordering::Relaxed) + 1);
    state
        .payloads
        .lock()
        .map_err(|_| "窗口状态已损坏".to_string())?
        .insert(label.clone(), payload);
    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(&title)
        .inner_size(1280.0, 820.0)
        .min_inner_size(960.0, 600.0)
        .resizable(true)
        .decorations(false)
        .theme(Some(tauri::Theme::Dark))
        .build();
    if let Err(e) = built {
        if let Ok(mut p) = state.payloads.lock() {
            p.remove(&label);
        }
        return Err(format!("无法在新窗口打开标签页：{e}"));
    }
    Ok(())
}

/// 新窗口启动时取走自己的载荷（只能取一次）
#[tauri::command]
pub fn window_take_session_payload(
    window: WebviewWindow,
    state: tauri::State<'_, AppWindowState>,
) -> Result<Option<Value>, String> {
    if !is_session_window_label(window.label()) {
        return Ok(None);
    }
    Ok(state
        .payloads
        .lock()
        .map_err(|_| "窗口状态已损坏".to_string())?
        .remove(window.label()))
}

/// 登记会话归属：窗口销毁时一并断开
#[tauri::command]
pub fn window_own_session(
    window: WebviewWindow,
    state: tauri::State<'_, AppWindowState>,
    kind: SessionKind,
    key: String,
) -> Result<(), String> {
    if key.is_empty() || key.len() > 256 {
        return Err("会话键无效".into());
    }
    let mut owners = state.owners.lock().map_err(|_| "窗口状态已损坏".to_string())?;
    let list = owners.entry(window.label().to_string()).or_default();
    if !list.iter().any(|(k, s)| *k == kind && *s == key) {
        list.push((kind, key));
    }
    Ok(())
}

/// 窗口销毁：断开它名下所有会话、丢掉没取走的载荷
pub fn on_window_destroyed(window: &Window) {
    let app = window.app_handle();
    let Some(state) = app.try_state::<AppWindowState>() else { return };
    let label = window.label().to_string();
    if let Ok(mut p) = state.payloads.lock() {
        p.remove(&label);
    }
    let owned = state.owners.lock().ok().and_then(|mut o| o.remove(&label)).unwrap_or_default();
    for (kind, key) in owned {
        match kind {
            SessionKind::Ssh => {
                let _ = crate::ssh::ssh_disconnect(app.state(), key);
            }
            SessionKind::Pty => {
                let _ = crate::pty::pty_kill(app.state(), key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_window_labels() {
        assert!(is_session_window_label("session-1"));
        assert!(is_session_window_label("session-42"));
        assert!(!is_session_window_label("session-"));
        assert!(!is_session_window_label("session-1x"));
        assert!(!is_session_window_label("main"));
    }
}
