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
use crate::probe::Stats;
use crate::ssh_auth::{self, AuthPromptRegistry, Credential};
use russh::client;
use russh::keys::{PublicKey, PublicKeyOrCertificate};
use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;

/// 发给会话任务的指令
enum SshCommand {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    /// 在这条连接上量一次往返；答复走 oneshot 回给发起测量的命令
    Ping {
        samples: u32,
        timeout: Duration,
        reply: oneshot::Sender<SshRttReport>,
    },
    Close,
}

#[derive(Default)]
pub struct SshState {
    sessions: Arc<Mutex<HashMap<String, UnboundedSender<SshCommand>>>>,
    /// 各主机**最近一次握手看到的**服务器公钥：host:port -> 公钥。
    /// 存在这里而不是走 IPC 传递密钥材料，用户确认后由 Rust 自己写盘。
    ///
    /// 为什么是「最近看到」而不是「取走一份」：同一台主机可以有多条并发会话
    /// （会话键每次连接都不同），几条会话撞上未知指纹时会写入同一把公钥。
    /// 若确认时把它取走，第二条会话点确认就会撞上「没有待确认的主机密钥」，
    /// 而其实它看到的正是同一把。留着不动，谁先确认都能拿到同一份材料。
    pending_keys: Arc<Mutex<HashMap<String, PublicKey>>>,
    /// 正在等界面回答的键盘交互请求（二次验证要来回问用户）
    pub auth_prompts: AuthPromptRegistry,
}

fn host_port_key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

/// 登记一条会话。
///
/// 键必须唯一：同键重复登记会让两条会话抢同一格事件通道。前端给**每次连接**
/// 生成一个新的键（`ssh:<hostId>#<序号>-<随机段>`），所以同一台主机的第二条
/// 连接不会被这里挡住 —— 挡住的只是同一个键的重复登记。
fn insert_session(
    sessions: &Arc<Mutex<HashMap<String, UnboundedSender<SshCommand>>>>,
    key: &str,
    tx: UnboundedSender<SshCommand>,
) -> Result<(), String> {
    let mut map = sessions.lock().map_err(|_| "SSH 会话表已损坏".to_string())?;
    if map.contains_key(key) {
        return Err(format!("会话 {key} 已存在"));
    }
    map.insert(key.to_string(), tx);
    Ok(())
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

/// 与 emit_phase 相同，但没有 AppHandle 时静默跳过。
/// 只给测试用：这样认证循环可以在没有界面的情况下被完整驱动。
pub(crate) fn emit_phase_opt(
    app: Option<&AppHandle>,
    key: &str,
    phase: &str,
    ok: bool,
    detail: impl Into<String>,
) {
    if let Some(app) = app {
        emit_phase(app, key, phase, ok, detail);
    }
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

/// 在已认证连接上量到的往返延迟。
///
/// 口径：一次 SSH 全局请求（keepalive）从发出到收到对端答复，
/// 也就是**端到端的真实往返**（含两端 SSH 协议栈的处理时间）。
/// 与 probe.rs 的 TCP 建连耗时是两码事：后者可能被本机代理就地握完，与远端无关。
#[derive(Debug, Serialize, Clone)]
pub struct SshRttReport {
    pub key: String,
    /// 口径标识，恒为 `ssh_round_trip`
    pub caliber: &'static str,
    /// 实际发出去的 ping 次数（首包超时后就不再继续，所以可能小于请求的次数）
    pub sent: u32,
    pub received: u32,
    /// 丢包率 0..1
    pub loss: f64,
    pub min_ms: f64,
    pub avg_ms: f64,
    pub median_ms: f64,
    pub max_ms: f64,
    pub jitter_ms: f64,
    pub samples: Vec<f64>,
    pub error: Option<String>,
}

/// SSH 往返测量的口径名，前端据此措辞
pub const RTT_CALIBER: &str = "ssh_round_trip";

/// 「在这条连接上发一次往返」的来源。
///
/// 抽成 trait 是为了能用可控实现钉住「首包超时后立刻收工」这条 FIFO 安全规则 ——
/// 在真机上没法稳定造出「服务器就是不回话」，而这条规则恰恰最不能被改错。
trait RttSource {
    fn ping(&mut self) -> impl std::future::Future<Output = Result<(), String>> + Send;
}

/// 真实来源：在已认证的 SSH 会话上发一次 keepalive 并等答复
struct SshKeepalive<'a, H: client::Handler> {
    session: &'a client::Handle<H>,
    timeout: Duration,
}

impl<H: client::Handler> RttSource for SshKeepalive<'_, H> {
    async fn ping(&mut self) -> Result<(), String> {
        match tokio::time::timeout(self.timeout, self.session.send_ping()).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(failure)) => Err(format!("keepalive 发送失败：{failure}")),
            Err(_) => Err("keepalive 没有得到答复".to_string()),
        }
    }
}

/// 按样本数依次测量：**一旦有一次失败就收工**，把已经拿到的样本如实报出去。
///
/// 为什么必须收工：russh 用 FIFO 队列把全局请求的答复与请求配对，
/// 上一次超时后它的槽位还占着，紧接着再发一次会让答复配错位置。
async fn measure_rtt<S: RttSource>(key: &str, samples: u32, source: &mut S) -> SshRttReport {
    let mut times: Vec<f64> = Vec::with_capacity(samples as usize);
    let mut sent = 0u32;
    let mut error: Option<String> = None;

    for _ in 0..samples {
        sent += 1;
        let started = Instant::now();
        match source.ping().await {
            Ok(()) => times.push(started.elapsed().as_secs_f64() * 1000.0),
            Err(message) => {
                error = Some(message);
                break;
            }
        }
    }

    let stats = Stats::from_samples(&times);
    let received = times.len() as u32;

    SshRttReport {
        key: key.to_string(),
        caliber: RTT_CALIBER,
        sent,
        received,
        loss: if sent > 0 {
            (sent - received) as f64 / sent as f64
        } else {
            1.0
        },
        min_ms: stats.min,
        avg_ms: stats.avg,
        median_ms: stats.median,
        max_ms: stats.max,
        jitter_ms: stats.jitter,
        samples: times,
        error,
    }
}

/// 在已有连接上量一次 SSH 往返（口径见 [`SshRttReport`]）。
///
/// 为什么不另开一条 TCP 连接去连服务端口：那会在服务端 sshd 日志里留下一条
/// **没有用户名的预认证失败记录**（Netcatty 也正因此放弃了这种测法），
/// 而且本机装了 TUN 类代理时，那条连接会被本机协议栈就地握完，
/// 量出来的只是本机耗时 —— 保留域名 `.invalid` 都能"连上"，可见一斑。
/// 已认证连接上的往返不受这两件事影响。
async fn measure_ssh_rtt<H: client::Handler>(
    session: &client::Handle<H>,
    key: &str,
    samples: u32,
    timeout: Duration,
) -> SshRttReport {
    let mut source = SshKeepalive { session, timeout };
    measure_rtt(key, samples, &mut source).await
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
                    // 测量期间不排空终端数据：正常往返只有几十毫秒，而一旦超时就立刻
                    // 收工（见 measure_ssh_rtt），所以这里最多挡住一个超时时长
                    Some(SshCommand::Ping { samples, timeout, reply }) => {
                        let report = measure_ssh_rtt(&session, key, samples, timeout).await;
                        // 发起测量的命令可能已经整体超时走人了，发不出去就算了
                        let _ = reply.send(report);
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
    insert_session(&state.sessions, &key, tx)?;

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
    let key = pending_key(&state.pending_keys, &host, port)?;
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
    let key = pending_key(&state.pending_keys, &host, port)?;
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

/// 取这台主机最近一次握手看到的公钥（只读，不取走）。
///
/// 同主机的并发会话共用这一份材料：谁先点「确认」都能拿到同一把密钥，
/// 不会出现「第二条会话确认时被告知没有待确认密钥」。重复确认只是把同一条
/// 记录再写一遍 —— known_hosts::trust 已做幂等，不会留下重复行。
fn pending_key(
    keys: &Arc<Mutex<HashMap<String, PublicKey>>>,
    host: &str,
    port: u16,
) -> Result<PublicKey, String> {
    keys.lock()
        .map_err(|_| "待确认密钥表已损坏".to_string())?
        .get(&host_port_key(host, port))
        .cloned()
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

/// 在一条已经认证成功的会话上量真正的端到端往返（见 [`SshRttReport`]）。
///
/// 这是「延迟」唯一站得住的口径：连接已经建立，往返必须真的走一趟网络，
/// 本机代理没法替对端作答；也不会在服务端 sshd 日志里留下预认证失败记录。
#[tauri::command]
pub async fn ssh_ping_rtt(
    state: State<'_, SshState>,
    key: String,
    samples: u32,
    timeout_ms: u64,
) -> Result<SshRttReport, String> {
    let samples = samples.clamp(1, 10);
    let timeout = Duration::from_millis(timeout_ms.clamp(200, 10_000));

    let (reply_tx, reply_rx) = oneshot::channel();
    {
        // 锁只在这个块里持有：下面要 await，不能把 std 的守卫带过 await 点
        let sessions = state.sessions.lock().map_err(|_| "SSH 会话表已损坏".to_string())?;
        let sender = sessions.get(&key).ok_or_else(|| format!("未找到会话 {key}"))?;
        sender
            .send(SshCommand::Ping {
                samples,
                timeout,
                reply: reply_tx,
            })
            .map_err(|_| "会话已关闭".to_string())?;
    }

    // 会话任务里最多等 samples 次超时，这里再放宽一层，避免命令永远挂住
    let budget = timeout * (samples + 1);
    match tokio::time::timeout(budget, reply_rx).await {
        Ok(Ok(report)) => Ok(report),
        Ok(Err(_)) => Err("会话在测量过程中结束".to_string()),
        Err(_) => Err("测量超时".to_string()),
    }
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

    // ---------------------------------------------------------------------
    // SSH 往返：自带一台本地 SSH 服务器，把「已认证连接上的一次真实往返」跑通。
    //
    // 为什么自带：这条路径要的就是往返本身，而手上没有可用的测试凭据；
    // 协议行为足以验证 —— 客户端发 keepalive 全局请求，服务器对未知全局请求
    // 回 REQUEST_FAILURE（这正是 OpenSSH 对 keepalive@openssh.com 的标准应答），
    // 客户端把「收到答复」就算一次往返完成。
    // ---------------------------------------------------------------------

    /// 只接受 none 认证的测试服务器
    struct NoAuthServer;

    impl russh::server::Handler for NoAuthServer {
        type Error = russh::Error;

        async fn auth_none(&mut self, _user: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }
    }

    /// 起一台本地测试服务器并完成认证，返回可以直接发 keepalive 的会话。
    /// `tag` 用来隔离各条测试的临时目录 —— 测试并行跑，共用一个路径会互相踩。
    async fn authenticated_local_session(tag: &str) -> client::Handle<TestHandler> {
        let mut dir = std::env::temp_dir();
        dir.push(format!("termx-rtt-server-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let host_key_path = dir.join("host_ed25519");
        let _ = std::fs::remove_file(&host_key_path);

        let status = std::process::Command::new("ssh-keygen")
            .args(["-t", "ed25519", "-N", "", "-q", "-f"])
            .arg(&host_key_path)
            .status()
            .expect("需要本机有 ssh-keygen 才能生成测试主机密钥");
        assert!(status.success(), "ssh-keygen 生成主机密钥失败");

        let host_key =
            russh::keys::load_secret_key(&host_key_path, None).expect("加载测试主机密钥失败");
        let config = Arc::new(russh::server::Config {
            keys: vec![host_key],
            inactivity_timeout: Some(Duration::from_secs(30)),
            ..Default::default()
        });

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let _ = russh::server::run_stream(config, stream, NoAuthServer).await;
            }
        });

        let mut session = client::connect(
            Arc::new(client::Config::default()),
            addr,
            TestHandler {
                fingerprint: Arc::new(Mutex::new(None)),
            },
        )
        .await
        .expect("连接本地测试服务器失败");

        let auth = session
            .authenticate_none("termx-test")
            .await
            .expect("认证过程出错");
        assert!(matches!(auth, AuthResult::Success), "测试服务器应当直接放行");

        session
    }

    #[tokio::test]
    async fn ssh_rtt_measures_round_trip_after_authentication() {
        let session = authenticated_local_session("ok").await;

        let report = measure_ssh_rtt(&session, "local", 3, Duration::from_millis(1000)).await;

        assert_eq!(report.key, "local");
        assert_eq!(report.caliber, RTT_CALIBER);
        assert_eq!(report.sent, 3);
        assert_eq!(report.received, 3, "本机往返三次都该拿到答复");
        assert_eq!(report.loss, 0.0);
        assert_eq!(report.samples.len(), 3);
        assert!(report.error.is_none());
        assert!(report.min_ms <= report.median_ms && report.median_ms <= report.max_ms);
        assert!(report.median_ms < 1000.0, "本机往返不该逼近超时");
    }

    /// 第一次就不给答复的来源；被调用第二次就直接失败
    struct FailsOnFirstPing {
        calls: usize,
    }

    impl RttSource for FailsOnFirstPing {
        async fn ping(&mut self) -> Result<(), String> {
            self.calls += 1;
            assert_eq!(self.calls, 1, "首包失败之后不该再发第二次");
            Err("模拟：keepalive 没有得到答复".to_string())
        }
    }

    /// 第一次给答复、第二次不给的来源；再被调用就直接失败
    struct FailsOnSecondPing {
        calls: usize,
    }

    impl RttSource for FailsOnSecondPing {
        async fn ping(&mut self) -> Result<(), String> {
            self.calls += 1;
            assert!(self.calls <= 2, "第二次失败之后不该再发第三次");
            if self.calls == 1 {
                Ok(())
            } else {
                Err("模拟：第二次没有得到答复".to_string())
            }
        }
    }

    /// 首包失败就必须收工：紧接着再发一次会让 russh 的 FIFO 答复队列配错位置
    #[tokio::test]
    async fn rtt_stops_after_the_first_failure() {
        let mut source = FailsOnFirstPing { calls: 0 };

        let report = measure_rtt("local", 5, &mut source).await;

        assert_eq!(report.sent, 1, "只该发出去一次");
        assert_eq!(report.received, 0);
        assert_eq!(report.loss, 1.0);
        assert!(report.samples.is_empty());
        assert_eq!(report.error.as_deref(), Some("模拟：keepalive 没有得到答复"));
        assert_eq!(source.calls, 1);
    }

    /// 中途失败时，前面已经拿到的样本要如实保留，损失率按实际发出的次数算
    #[tokio::test]
    async fn rtt_keeps_earlier_samples_when_a_later_one_fails() {
        let mut source = FailsOnSecondPing { calls: 0 };

        let report = measure_rtt("local", 5, &mut source).await;

        assert_eq!(report.sent, 2);
        assert_eq!(report.received, 1);
        assert_eq!(report.samples.len(), 1);
        assert_eq!(report.loss, 0.5, "发出两次、收到一次");
        assert!(report.error.is_some());
        assert_eq!(source.calls, 2, "收工之后不能再发");
    }

    // ---------------------------------------------------------------------
    // 多会话：同一台主机可以同时有多条连接。
    //
    // 会话身份是**会话键**（前端每次连接生成一个新的），不是主机：
    // 会话表按键存，所以同一台主机登记两次是两条会话，各占一格、互不覆盖。
    // ---------------------------------------------------------------------

    /// 夹具公钥（与 known_hosts 的测试同款），只用于「待确认密钥」的读写验证
    const FIXTURE_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMA6n+DQWVPOxphqrRcQRfq6san3Tlu/Sevut+ELlKjJ";

    fn fixture_key() -> PublicKey {
        FIXTURE_KEY.parse().expect("夹具公钥应可解析")
    }

    fn session_table() -> Arc<Mutex<HashMap<String, UnboundedSender<SshCommand>>>> {
        Arc::new(Mutex::new(HashMap::new()))
    }

    /// 同一台主机的两次连接得到**不同的键**，两条会话各自占一格
    #[test]
    fn two_connections_to_one_host_get_separate_slots() {
        let table = session_table();
        let (tx1, _rx1) = unbounded_channel::<SshCommand>();
        let (tx2, _rx2) = unbounded_channel::<SshCommand>();

        // 前端生成的形状：ssh:<hostId>#<序号>-<随机段>
        let first = "ssh:aws-18-216-234-51#1-ab12cd";
        let second = "ssh:aws-18-216-234-51#2-ef34gh";
        assert_ne!(first, second, "同一台主机的两次连接必须是不同的键");

        insert_session(&table, first, tx1).expect("同主机的第一条会话应当能登记");
        insert_session(&table, second, tx2).expect("同一台主机的第二条会话也应当能登记");

        let map = table.lock().unwrap();
        assert_eq!(map.len(), 2, "两条会话各占一格，不能互相覆盖");
        assert!(map.contains_key(first) && map.contains_key(second));
    }

    /// 同一个键重复登记必须被挡住：否则两条会话会抢同一格事件通道
    #[test]
    fn duplicate_session_key_is_rejected() {
        let table = session_table();
        let key = "ssh:host#1-ab12cd";
        let (tx1, _rx1) = unbounded_channel::<SshCommand>();
        let (tx2, _rx2) = unbounded_channel::<SshCommand>();

        insert_session(&table, key, tx1).expect("第一次登记应当成功");
        let error = insert_session(&table, key, tx2).expect_err("同键重复登记必须被拒绝");
        assert!(error.contains("已存在"), "错误信息应说明原因：{error}");
        assert_eq!(table.lock().unwrap().len(), 1, "被拒绝的登记不能改动会话表");
    }

    /// 一条会话结束，不能动到同一台主机的另一条（清理按会话键来）
    #[test]
    fn ending_one_session_leaves_the_other() {
        let table = session_table();
        let first = "ssh:host#1-ab12cd";
        let second = "ssh:host#2-ef34gh";
        let (tx1, _rx1) = unbounded_channel::<SshCommand>();
        let (tx2, _rx2) = unbounded_channel::<SshCommand>();
        insert_session(&table, first, tx1).unwrap();
        insert_session(&table, second, tx2).unwrap();

        assert!(
            table.lock().unwrap().remove(first).is_some(),
            "第一条会话应当能按自己的键收掉"
        );
        assert!(
            table.lock().unwrap().contains_key(second),
            "同一台主机的另一条会话必须还在"
        );
    }

    /// 待确认的主机密钥是按主机存的：同主机并发会话都能读到同一份材料
    /// （读而不是取走 —— 取走会让第二条会话的「确认指纹」报「没有待确认的密钥」）
    #[test]
    fn pending_key_is_readable_by_every_concurrent_session() {
        let keys = Arc::new(Mutex::new(HashMap::new()));
        keys.lock()
            .unwrap()
            .insert(host_port_key("18.216.234.51", 22), fixture_key());

        let first = pending_key(&keys, "18.216.234.51", 22).expect("第一条会话应能读到待确认密钥");
        let second = pending_key(&keys, "18.216.234.51", 22).expect("并发的第二条会话也应能读到同一把");
        assert_eq!(
            known_hosts::fingerprint_of(&first),
            known_hosts::fingerprint_of(&second),
            "两条会话看到的必须是同一把密钥"
        );

        // 主机与端口都是维度：别的目标不能串到这台主机的材料上
        assert!(pending_key(&keys, "49.235.166.66", 22).is_err());
        assert!(pending_key(&keys, "18.216.234.51", 2222).is_err());
    }

    /// 连上一台真机并起一个 shell 通道；连接句柄要一起返回，否则连接会被丢掉
    async fn open_shell(
        host: &str,
        port: u16,
        user: &str,
        password: &str,
    ) -> (client::Handle<TestHandler>, russh::Channel<client::Msg>) {
        let (mut session, _) = connect(host, port).await;
        let auth = session
            .authenticate_password(user.to_string(), password.to_string())
            .await
            .expect("认证过程出错");
        assert!(
            matches!(auth, AuthResult::Success),
            "密码认证未通过（{user}@{host}）"
        );

        let mut channel = session.channel_open_session().await.expect("打开会话通道失败");
        channel
            .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .expect("申请 PTY 失败");
        channel.request_shell(true).await.expect("启动远程 shell 失败");
        (session, channel)
    }

    /// 从通道里一直读到出现 `needle`（或超时），返回读到的全部输出
    async fn read_until(
        channel: &mut russh::Channel<client::Msg>,
        needle: &str,
        budget: Duration,
    ) -> String {
        let mut received = String::new();
        let deadline = tokio::time::Instant::now() + budget;
        while !received.contains(needle) && tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_secs(5), channel.wait()).await {
                Ok(Some(ChannelMsg::Data { data })) => {
                    received.push_str(&String::from_utf8_lossy(&data));
                }
                Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                    received.push_str(&String::from_utf8_lossy(&data));
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => break,
            }
        }
        received
    }

    /// 真机：同一台主机的两条**并发**连接各自独立 ——
    /// 各自的命令输出不会串到对方，关掉一条之后另一条照旧可用。
    /// 对应界面验收的「两条会话同时开」与「关掉一个标签，另一个仍在工作」。
    #[tokio::test]
    async fn two_concurrent_connections_to_one_host_stay_independent() {
        let Some((host, port, user, password)) = test_target() else {
            eprintln!("跳过：未提供 TERMX_TEST_SSH_* 环境变量");
            return;
        };

        let (_session_a, mut first) = open_shell(&host, port, &user, &password).await;
        let (_session_b, mut second) = open_shell(&host, port, &user, &password).await;

        let tag = std::process::id();
        let first_tag = format!("A-{tag}");
        let second_tag = format!("B-{tag}");

        // 两条连接同时活着：各自敲一条带独立标记的命令
        first
            .data(format!("echo {first_tag}\n").as_bytes())
            .await
            .expect("第一条会话写入失败");
        second
            .data(format!("echo {second_tag}\n").as_bytes())
            .await
            .expect("第二条会话写入失败");

        let first_out = read_until(&mut first, &first_tag, Duration::from_secs(20)).await;
        let second_out = read_until(&mut second, &second_tag, Duration::from_secs(20)).await;
        assert!(first_out.contains(&first_tag), "第一条会话没有回显自己的标记");
        assert!(second_out.contains(&second_tag), "第二条会话没有回显自己的标记");
        assert!(
            !first_out.contains(&second_tag),
            "第一条会话里出现了第二条的标记：两条会话串流了"
        );
        assert!(
            !second_out.contains(&first_tag),
            "第二条会话里出现了第一条的标记：两条会话串流了"
        );

        // 关掉第一条，第二条必须照旧能用
        let _ = first.close().await;
        drop(first);
        let later_tag = format!("B2-{tag}");
        second
            .data(format!("echo {later_tag}\n").as_bytes())
            .await
            .expect("关掉另一条之后，这条会话仍应可写");
        let later_out = read_until(&mut second, &later_tag, Duration::from_secs(20)).await;
        assert!(
            later_out.contains(&later_tag),
            "关掉另一条会话后，这条会话应当继续正常工作"
        );

        eprintln!(
            "同一台主机两条并发会话各自独立：{first_tag} / {second_tag}；关掉第一条后第二条仍可用"
        );
    }
}
