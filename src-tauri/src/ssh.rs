//! SSH 连接（真实实现，基于 russh）。
//!
//! 设计要点：
//! - 连接过程分阶段回报给前端（`ssh://state/{key}`），正好对应「连接过程」界面的步骤条，
//!   失败时能指出是哪一步出错，而不是笼统的一句「连接失败」。
//! - 会话数据走事件流（`ssh://data/{key}`），与本地终端 PTY 的形态保持一致。
//! - 凭据只存在于内存：认证方式与凭据由 `ssh_auth` 处理，用完即弃、**不写进任何配置文件**
//!   （配置文件只存主机地址、用户名这类非敏感信息）。系统钥匙串持久化尚未接入。
//!   五种认证方式（密码 / 私钥 / 私钥加口令 / SSH Agent / 键盘交互）都在 `crate::ssh_auth`。
//! - 主机指纹会被回报并在界面上展示，信任策略（known_hosts / 首次连接人工确认）由
//!   `crate::known_hosts` 执行：未见过的指纹一律先拒绝，由用户确认后再写入自己的记录。

use crate::known_hosts::{self, Verdict};
use crate::ssh_auth::{self, AuthPromptRegistry, Credential};
use russh::client;
use russh::keys::{PublicKey, PublicKeyOrCertificate};
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
    /// 等待用户确认的主机密钥：host:port -> 公钥。
    /// 存在这里而不是走 IPC 传递密钥材料，用户确认后由 Rust 自己写盘。
    pending_keys: Arc<Mutex<HashMap<String, PublicKey>>>,
    /// 正在等界面回答的键盘交互请求（二次验证要来回问用户）
    pub auth_prompts: AuthPromptRegistry,
}

fn host_port_key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

/// 连接阶段事件：phase 取 resolve / tcp / handshake / auth / shell / failed
#[derive(Serialize, Clone)]
pub struct SshPhase {
    phase: String,
    ok: bool,
    detail: String,
    /// 供界面判断该引导什么动作：host_unknown（首次连接，需确认指纹）/
    /// host_changed（指纹变了，默认拒绝）；普通阶段为 null
    kind: Option<String>,
    /// 主机指纹：有就带上，界面直接展示，不用从 detail 里猜
    fingerprint: Option<String>,
}

pub(crate) fn emit_phase(app: &AppHandle, key: &str, phase: &str, ok: bool, detail: impl Into<String>) {
    emit_phase_full(app, key, phase, ok, detail, None, None);
}

fn emit_phase_full(
    app: &AppHandle,
    key: &str,
    phase: &str,
    ok: bool,
    detail: impl Into<String>,
    kind: Option<&str>,
    fingerprint: Option<&str>,
) {
    let _ = app.emit(
        &format!("ssh://state/{key}"),
        SshPhase {
            phase: phase.to_string(),
            ok,
            detail: detail.into(),
            kind: kind.map(str::to_string),
            fingerprint: fingerprint.map(str::to_string),
        },
    );
}

struct ClientHandler {
    app: AppHandle,
    key: String,
    host: String,
    port: u16,
    fingerprint: Arc<Mutex<Option<String>>>,
    /// 信任判定的结果（放行以外的两种情况要回报给用户）
    verdict: Arc<Mutex<Option<(String, String)>>>,
    pending: Arc<Mutex<HashMap<String, PublicKey>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // 对公钥与证书都取底层公钥算指纹，形状统一
        let key = server_public_key.public_key();
        *self.fingerprint.lock().unwrap() = Some(known_hosts::fingerprint_of(&key));

        let verdict = known_hosts::verify(&self.app, &self.host, self.port, &key);
        if matches!(verdict, Verdict::Trusted) {
            return Ok(true);
        }

        // 首次连接或指纹变化：拒绝这次握手，把待确认的密钥留给用户决策
        let kind = verdict.kind().unwrap_or("host_unknown").to_string();
        let fingerprint = verdict.fingerprint().unwrap_or_default().to_string();
        self.pending
            .lock()
            .unwrap()
            .insert(host_port_key(&self.host, self.port), key);
        *self.verdict.lock().unwrap() = Some((kind, fingerprint));
        Ok(false)
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
    credential: Credential,
    cols: u32,
    rows: u32,
    rx: &mut UnboundedReceiver<SshCommand>,
    pending_keys: &Arc<Mutex<HashMap<String, PublicKey>>>,
    auth_prompts: &AuthPromptRegistry,
) -> Result<(), String> {
    emit_phase(app, key, "resolve", true, format!("{host}:{port}"));

    let fingerprint = Arc::new(Mutex::new(None));
    let verdict: Arc<Mutex<Option<(String, String)>>> = Arc::new(Mutex::new(None));
    let handler = ClientHandler {
        app: app.clone(),
        key: key.to_string(),
        host: host.to_string(),
        port,
        fingerprint: fingerprint.clone(),
        verdict: verdict.clone(),
        pending: pending_keys.clone(),
    };

    let mut session = match client::connect(
        Arc::new(client::Config::default()),
        (host, port),
        handler,
    )
    .await
    {
        Ok(session) => session,
        Err(error) => {
            // 握手被我们自己拦下来时，要告诉用户该怎么办，而不是回一句笼统的失败
            if let Some((kind, fingerprint)) = verdict.lock().unwrap().clone() {
                let detail = match kind.as_str() {
                    "host_unknown" => format!("首次连接这台主机，需要你确认服务器指纹 {fingerprint}"),
                    "host_changed" => format!(
                        "主机指纹与已保存的记录不一致（{fingerprint}）。可能是服务器重装，也可能是中间人攻击，已拒绝连接。"
                    ),
                    _ => format!("握手失败：{error}"),
                };
                emit_phase_full(
                    app,
                    key,
                    "failed",
                    false,
                    detail,
                    Some(&kind),
                    Some(&fingerprint),
                );
                return Err("主机密钥未通过校验".to_string());
            }
            return Err(format!("建立 TCP 连接失败：{error}"));
        }
    };
    emit_phase(app, key, "tcp", true, format!("已连接到 {host}:{port}"));

    let fp = fingerprint
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| "未能取得指纹".to_string());
    emit_phase_full(
        app,
        key,
        "handshake",
        true,
        format!("主机指纹 {fp}（已通过 known_hosts 校验）"),
        None,
        Some(&fp),
    );

    // 认证：密码 / 私钥 / 私钥加口令 / SSH Agent / 键盘交互，由 ssh_auth 分派。
    // 详细过程（用了哪种方式、服务器提了什么问）由 ssh_auth 自己回报 auth 阶段。
    let outcome = ssh_auth::authenticate(
        app,
        key,
        &mut session,
        username,
        &credential,
        auth_prompts,
    )
    .await;
    // 凭据用完即弃，不跟着会话一直挂在内存里
    drop(credential);
    outcome?;

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
    credential: Credential,
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
    let pending = state.pending_keys.clone();
    let auth_prompts = state.auth_prompts.clone();
    let task_key = key.clone();

    tauri::async_runtime::spawn(async move {
        let result = run_session(
            &app,
            &task_key,
            &host,
            port,
            &username,
            credential,
            cols,
            rows,
            &mut rx,
            &pending,
            &auth_prompts,
        )
        .await;

        // 认证输入若还挂着（失败退出、超时），一并收掉，别留下永远等不到的通道
        auth_prompts.cancel(&task_key, "会话已结束");

        // 先清掉会话条目再报失败：否则界面立刻重试（例如用户刚确认完指纹）会撞上「会话已存在」
        if let Ok(mut map) = sessions.lock() {
            map.remove(&task_key);
        }

        if let Err(message) = result {
            emit_phase(&app, &task_key, "failed", false, message);
            let _ = app.emit(&format!("ssh://exit/{task_key}"), None::<i32>);
        }
    });

    Ok(())
}

/// 用户确认首次连接的指纹后调用：把待确认的密钥写进 known_hosts。
/// 密钥材料一直留在 Rust 侧，不经过前端。
#[tauri::command]
pub fn ssh_trust_host(
    app: AppHandle,
    state: State<'_, SshState>,
    host: String,
    port: u16,
) -> Result<String, String> {
    let key = take_pending(&state, &host, port)?;
    known_hosts::trust(&app, &host, port, &key)?;
    Ok(known_hosts::fingerprint_of(&key))
}

/// 服务器确实重装过、用户已人工核对后调用：替换掉旧记录
#[tauri::command]
pub fn ssh_replace_host_key(
    app: AppHandle,
    state: State<'_, SshState>,
    host: String,
    port: u16,
) -> Result<String, String> {
    let key = take_pending(&state, &host, port)?;
    let removed = known_hosts::replace(&app, &host, port, &key)?;

    // 替换后复查：旧指纹也可能来自 OpenSSH 的 ~/.ssh/known_hosts，而我们不写那个文件。
    // 不复查的话用户会陷入「替换了却还是连不上」的死胡同。
    match known_hosts::verify(&app, &host, port, &key) {
        Verdict::Trusted => Ok(format!(
            "已替换 {removed} 条记录，新指纹 {}",
            known_hosts::fingerprint_of(&key)
        )),
        Verdict::Changed { .. } => Err(format!(
            "已在 TermX 的记录里替换 {removed} 条，但旧指纹仍然存在于 OpenSSH 的 ~/.ssh/known_hosts 中。\
             请自行删除那一行（或改成该主机的真实公钥）后再连接 —— TermX 不会去改你自己的 OpenSSH 配置。"
        )),
        Verdict::Unknown { .. } => Err("替换后仍未生效，请重试".to_string()),
    }
}

fn take_pending(state: &State<'_, SshState>, host: &str, port: u16) -> Result<PublicKey, String> {
    state
        .pending_keys
        .lock()
        .map_err(|_| "待确认密钥表已损坏".to_string())?
        .remove(&host_port_key(host, port))
        .ok_or_else(|| "没有待确认的主机密钥，请重新发起连接".to_string())
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
    // 认证还没结束（比如正卡在键盘交互等输入）时也要把它叫醒，
    // 否则会话任务会一直挂着，用户点了「断开」却什么都没发生
    state.auth_prompts.cancel(&key, "用户断开了连接");
    let mut sessions = state.sessions.lock().map_err(|_| "SSH 会话表已损坏".to_string())?;
    if let Some(tx) = sessions.remove(&key) {
        let _ = tx.send(SshCommand::Close);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::client::AuthResult;
    use russh::keys::HashAlg;
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
