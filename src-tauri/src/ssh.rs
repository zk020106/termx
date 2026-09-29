//! SSH 连接（真实实现，基于 russh）。
//!
//! 设计要点：
//! - 连接过程分阶段回报给前端（`ssh://state/{key}`），正好对应「连接过程」界面的步骤条，
//!   失败时能指出是哪一步出错，而不是笼统的一句「连接失败」。
//! - 会话数据走事件流（`ssh://data/{key}`），与本地终端 PTY 的形态保持一致。
//! - 凭据只存在于内存：密码用于本次认证，**不写进任何配置文件**
//!   （配置文件只存主机地址、用户名这类非敏感信息）。系统钥匙串持久化尚未接入。
//! - 主机指纹会被回报并在界面上展示；但**信任策略（known_hosts / 首次连接人工确认）尚未实现**，
//!   当前是接受任何指纹。这一点在界面上必须如实标注，不能假装已经校验过。

use russh::client::{self, AuthResult};
use russh::keys::{HashAlg, PublicKeyOrCertificate};
use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

/// 发给会话任务的指令
enum SshCommand {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(Default)]
pub struct SshState {
    sessions: Arc<Mutex<HashMap<String, UnboundedSender<SshCommand>>>>,
}

/// 连接阶段事件：phase 取 resolve / tcp / handshake / auth / shell / failed
#[derive(Serialize, Clone)]
pub struct SshPhase {
    phase: String,
    ok: bool,
    detail: String,
}

fn emit_phase(app: &AppHandle, key: &str, phase: &str, ok: bool, detail: impl Into<String>) {
    let _ = app.emit(
        &format!("ssh://state/{key}"),
        SshPhase {
            phase: phase.to_string(),
            ok,
            detail: detail.into(),
        },
    );
}

struct ClientHandler {
    app: AppHandle,
    key: String,
    fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // 对公钥与证书都取底层公钥算指纹，形状统一
        let fingerprint = format!(
            "{}",
            server_public_key.public_key().fingerprint(HashAlg::Sha256)
        );
        *self.fingerprint.lock().unwrap() = Some(fingerprint);
        // 尚未实现 known_hosts 校验：这里先接受，由界面把指纹展示给用户
        let _ = (&self.app, &self.key);
        Ok(true)
    }
}

/// 建立连接并跑会话循环；返回 Err 时调用方会把失败阶段报给前端
#[allow(clippy::too_many_arguments)]
async fn run_session(
    app: &AppHandle,
    key: &str,
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    cols: u32,
    rows: u32,
    rx: &mut UnboundedReceiver<SshCommand>,
) -> Result<(), String> {
    emit_phase(app, key, "resolve", true, format!("{host}:{port}"));

    let fingerprint = Arc::new(Mutex::new(None));
    let handler = ClientHandler {
        app: app.clone(),
        key: key.to_string(),
        fingerprint: fingerprint.clone(),
    };

    let mut session = client::connect(Arc::new(client::Config::default()), (host, port), handler)
        .await
        .map_err(|e| format!("建立 TCP 连接失败：{e}"))?;
    emit_phase(app, key, "tcp", true, format!("已连接到 {host}:{port}"));

    let fp = fingerprint
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| "未能取得指纹".to_string());
    emit_phase(app, key, "handshake", true, format!("主机指纹 {fp}"));

    let auth = session
        .authenticate_password(username, password)
        .await
        .map_err(|e| format!("认证阶段出错：{e}"))?;

    match auth {
        AuthResult::Success => {
            emit_phase(app, key, "auth", true, format!("{username} 密码认证通过"));
        }
        AuthResult::Failure { partial_success, .. } => {
            let detail = if partial_success {
                "服务器要求继续验证（多因素）".to_string()
            } else {
                "认证被拒绝：用户名或密码不正确".to_string()
            };
            emit_phase(app, key, "auth", false, detail.clone());
            return Err(detail);
        }
    }

    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("打开会话通道失败：{e}"))?;

    channel
        .request_pty(true, "xterm-256color", cols.max(1), rows.max(1), 0, 0, &[])
        .await
        .map_err(|e| format!("申请 PTY 失败：{e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("启动远程 shell 失败：{e}"))?;

    emit_phase(app, key, "shell", true, format!("远程 shell 已就绪（{cols}x{rows}）"));

    let data_event = format!("ssh://data/{key}");
    let exit_event = format!("ssh://exit/{key}");
    let mut exit_code: Option<i32> = None;

    loop {
        tokio::select! {
            incoming = channel.wait() => {
                match incoming {
                    Some(ChannelMsg::Data { data }) => {
                        let _ = app.emit(&data_event, String::from_utf8_lossy(&data).to_string());
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = app.emit(&data_event, String::from_utf8_lossy(&data).to_string());
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status as i32);
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            command = rx.recv() => {
                match command {
                    Some(SshCommand::Data(bytes)) => {
                        if channel.data_bytes(bytes).await.is_err() {
                            break;
                        }
                    }
                    Some(SshCommand::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols.max(1), rows.max(1), 0, 0).await;
                    }
                    Some(SshCommand::Close) | None => break,
                }
            }
        }
    }

    let _ = channel.close().await;
    let _ = app.emit(&exit_event, exit_code);
    Ok(())
}

/// 发起连接。立即返回，进度与数据都通过事件推送。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshState>,
    key: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let (tx, mut rx) = unbounded_channel::<SshCommand>();

    {
        let mut sessions = state.sessions.lock().map_err(|_| "SSH 会话表已损坏".to_string())?;
        if sessions.contains_key(&key) {
            return Err(format!("会话 {key} 已存在"));
        }
        sessions.insert(key.clone(), tx);
    }

    let sessions = state.sessions.clone();
    let task_key = key.clone();

    tauri::async_runtime::spawn(async move {
        let result = run_session(
            &app, &task_key, &host, port, &username, &password, cols, rows, &mut rx,
        )
        .await;

        if let Err(message) = result {
            emit_phase(&app, &task_key, "failed", false, message);
            let _ = app.emit(&format!("ssh://exit/{task_key}"), None::<i32>);
        }

        if let Ok(mut map) = sessions.lock() {
            map.remove(&task_key);
        }
    });

    Ok(())
}

/// 键盘输入 → 远端
#[tauri::command]
pub fn ssh_write(state: State<'_, SshState>, key: String, data: String) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "SSH 会话表已损坏".to_string())?;
    let tx = sessions.get(&key).ok_or_else(|| format!("未找到会话 {key}"))?;
    tx.send(SshCommand::Data(data.into_bytes()))
        .map_err(|_| "会话已关闭".to_string())
}

/// 终端尺寸变化 → 远端 PTY
#[tauri::command]
pub fn ssh_resize(
    state: State<'_, SshState>,
    key: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "SSH 会话表已损坏".to_string())?;
    let tx = sessions.get(&key).ok_or_else(|| format!("未找到会话 {key}"))?;
    tx.send(SshCommand::Resize { cols, rows })
        .map_err(|_| "会话已关闭".to_string())
}

#[tauri::command]
pub fn ssh_disconnect(state: State<'_, SshState>, key: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "SSH 会话表已损坏".to_string())?;
    if let Some(tx) = sessions.remove(&key) {
        let _ = tx.send(SshCommand::Close);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// 测试用 handler：只记录指纹，不需要 AppHandle
    struct TestHandler {
        fingerprint: Arc<Mutex<Option<String>>>,
    }

    impl client::Handler for TestHandler {
        type Error = russh::Error;

        async fn check_server_key(
            &mut self,
            server_public_key: &PublicKeyOrCertificate,
        ) -> Result<bool, Self::Error> {
            *self.fingerprint.lock().unwrap() = Some(format!(
                "{}",
                server_public_key.public_key().fingerprint(HashAlg::Sha256)
            ));
            Ok(true)
        }
    }

    /// 测试目标从环境变量取，**不把任何凭据写进仓库**。
    /// 四个变量不全就直接跳过。
    fn test_target() -> Option<(String, u16, String, String)> {
        let host = std::env::var("TERMX_TEST_SSH_HOST").ok()?;
        let user = std::env::var("TERMX_TEST_SSH_USER").ok()?;
        let password = std::env::var("TERMX_TEST_SSH_PASSWORD").ok()?;
        let port = std::env::var("TERMX_TEST_SSH_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(22);
        Some((host, port, user, password))
    }

    async fn connect(
        host: &str,
        port: u16,
    ) -> (
        client::Handle<TestHandler>,
        Arc<Mutex<Option<String>>>,
    ) {
        let fingerprint = Arc::new(Mutex::new(None));
        let session = client::connect(
            Arc::new(client::Config::default()),
            (host, port),
            TestHandler {
                fingerprint: fingerprint.clone(),
            },
        )
        .await
        .expect("TCP/握手阶段失败");
        (session, fingerprint)
    }

    /// 真实连接：握手 → 密码认证 → 申请 PTY → 起 shell → 读回真实输出
    #[tokio::test]
    async fn real_host_handshake_auth_and_shell() {
        let Some((host, port, user, password)) = test_target() else {
            eprintln!("跳过：未提供 TERMX_TEST_SSH_* 环境变量");
            return;
        };

        let (mut session, fingerprint) = connect(&host, port).await;
        let fingerprint = fingerprint
            .lock()
            .unwrap()
            .clone()
            .expect("握手阶段应能拿到主机指纹");
        assert!(fingerprint.starts_with("SHA256:"), "指纹格式异常：{fingerprint}");

        let auth = session
            .authenticate_password(user.clone(), password)
            .await
            .expect("认证过程出错");
        assert!(
            matches!(auth, AuthResult::Success),
            "密码认证未通过（{user}@{host}）"
        );

        let mut channel = session.channel_open_session().await.expect("打开会话失败");
        channel
            .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .expect("申请 PTY 失败");
        channel.request_shell(true).await.expect("启动 shell 失败");

        // 真实 shell 至少会吐一个提示符或 motd；读到就说明整条链路通了
        let mut received = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while received.is_empty() && tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_secs(5), channel.wait()).await {
                Ok(Some(ChannelMsg::Data { data })) => {
                    received.push_str(&String::from_utf8_lossy(&data));
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => break,
            }
        }

        assert!(
            !received.is_empty(),
            "认证成功但没读到任何 shell 输出（{host}）"
        );
        eprintln!(
            "已连上 {user}@{host}:{port}\n指纹：{fingerprint}\n远端输出（前 200 字符）：\n{}",
            received.chars().take(200).collect::<String>()
        );
    }

    /// 负向验证：错误密码必须被服务器拒绝，避免「连上就算成功」的假阳性
    #[tokio::test]
    async fn wrong_password_is_rejected() {
        let Some((host, port, user, _password)) = test_target() else {
            eprintln!("跳过：未提供 TERMX_TEST_SSH_* 环境变量");
            return;
        };

        let (mut session, _) = connect(&host, port).await;
        let auth = session
            .authenticate_password(user, "definitely-not-the-password-xyz")
            .await
            .expect("认证过程出错");

        assert!(
            matches!(auth, AuthResult::Failure { .. }),
            "错误密码不应通过认证"
        );
    }
}
