//! SSH 连接（真实实现，基于 russh）。
//!
//! 设计要点：
//! - 连接过程分阶段回报给前端（`ssh://state/{key}`），正好对应「连接过程」界面的步骤条，
//!   失败时能指出是哪一步、哪一跳出错，而不是笼统的一句「连接失败」。
//! - 会话数据走事件流（`ssh://data/{key}`），与本地终端 PTY 的形态保持一致。
//!   远端字节按主机设置的编码流式解码（见 `crate::codec`），键盘输入按同一编码编回去。
//! - 链路（代理 / 跳板机 / 每一跳的指纹校验与认证）由 `crate::chain` 负责；
//!   连接超时与 keepalive 也在那里统一配置。
//! - 会话选项：TERM 类型、环境变量（`env` 请求）、登录脚本（shell 就绪后逐行键入）。
//! - 往返测量在独立任务里跑，不会卡住终端数据的收发。
//! - 主机指纹会被回报并在界面上展示，信任策略由 `crate::known_hosts` 执行。

use crate::chain::{self, Chain, ChainRequest, HopSpec, PendingKeys, SshHandle};
use crate::codec::TermCodec;
use crate::known_hosts::{self, Verdict};
use crate::probe::Stats;
use crate::ssh_auth::{AuthPromptRegistry, Credential};
use crate::transport::ProxySpec;
use russh::client;
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;

pub use crate::chain::{emit_phase, emit_phase_full, SessionError};

/// 发给会话任务的指令
enum SshCommand {
    /// 键盘输入（文本，发送前按会话编码编码）
    Data(String),
    Resize { cols: u32, rows: u32 },
    /// 在这条连接上量一次往返；答复走 oneshot 回给发起测量的命令
    Ping {
        samples: u32,
        timeout: Duration,
        reply: oneshot::Sender<SshRttReport>,
    },
    Close,
}

type SessionTable = Arc<Mutex<HashMap<String, UnboundedSender<SshCommand>>>>;

#[derive(Default)]
pub struct SshState {
    sessions: SessionTable,
    /// 已建立的会话连接句柄：exec（远端校验、监控采样）复用这条连接，不另开
    handles: Arc<Mutex<HashMap<String, Arc<SshHandle>>>>,
    /// 各主机**最近一次握手看到的**服务器公钥：host:port -> 公钥。
    /// 存在这里而不是走 IPC 传递密钥材料，用户确认后由 Rust 自己写盘。
    /// 跳板机与目标主机都记在这里，界面信任的是出问题的那一跳。
    pub(crate) pending_keys: PendingKeys,
    /// 正在等界面回答的认证输入（键盘交互、跳板机密码等）
    pub auth_prompts: AuthPromptRegistry,
}

impl SshState {
    pub fn handle(&self, key: &str) -> Option<Arc<SshHandle>> {
        self.handles.lock().ok()?.get(key).cloned()
    }
}

/// 登记一条会话。
///
/// 键必须唯一：同键重复登记会让两条会话抢同一格事件通道。前端给**每次连接**
/// 生成一个新的键（`ssh:<hostId>:<序号>-<随机段>`），所以同一台主机的第二条
/// 连接不会被这里挡住 —— 挡住的只是同一个键的重复登记。
fn insert_session(sessions: &SessionTable, key: &str, tx: UnboundedSender<SshCommand>) -> Result<(), String> {
    let mut map = sessions.lock().map_err(|_| "SSH 会话表已损坏".to_string())?;
    if map.contains_key(key) {
        return Err(format!("会话 {key} 已存在"));
    }
    map.insert(key.to_string(), tx);
    Ok(())
}

/// 与 emit_phase 相同，但没有 AppHandle 时静默跳过（测试用）
pub(crate) fn emit_phase_opt(app: Option<&AppHandle>, key: &str, phase: &str, ok: bool, detail: impl Into<String>) {
    if let Some(app) = app {
        emit_phase(app, key, phase, ok, detail);
    }
}

/// 在已认证连接上量到的往返延迟。
///
/// 口径：一次 SSH 全局请求（keepalive）从发出到收到对端答复，
/// 也就是**端到端的真实往返**（含两端 SSH 协议栈的处理时间）。
/// 经跳板机时量的是到目标主机的整条链路。
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
async fn measure_ssh_rtt<H: client::Handler>(
    session: &client::Handle<H>,
    key: &str,
    samples: u32,
    timeout: Duration,
) -> SshRttReport {
    let mut source = SshKeepalive { session, timeout };
    measure_rtt(key, samples, &mut source).await
}

/// 主机级的连接选项（与前端 Host 的 jumpHostIds / proxy / termType / envVars /
/// loginScript / encoding 对应；前端负责把 jumpHostIds 展开成每一跳的地址与凭据）
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConnectProfile {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub jumps: Vec<HopSpec>,
    #[serde(default)]
    pub proxy: Option<ProxySpec>,
    #[serde(default)]
    pub term_type: Option<String>,
    #[serde(default)]
    pub env: Vec<EnvVar>,
    #[serde(default)]
    pub login_script: Option<String>,
    #[serde(default)]
    pub encoding: Option<String>,
    /// 单跳连接超时（秒）；缺省 15 秒
    #[serde(default)]
    pub connect_timeout_secs: Option<u64>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

impl ConnectProfile {
    pub fn timeout(&self) -> Duration {
        self.connect_timeout_secs
            .map(|s| Duration::from_secs(s.clamp(3, 120)))
            .unwrap_or(chain::DEFAULT_CONNECT_TIMEOUT)
    }
}

/// TERM 只允许常见的字符，防止奇怪的值被原样塞进协议
fn sanitize_term(term: Option<&str>) -> String {
    match term.map(str::trim) {
        Some(t) if !t.is_empty() && t.len() <= 64 && t.chars().all(|c| c.is_ascii_alphanumeric() || "-_.+".contains(c)) => {
            t.to_string()
        }
        _ => "xterm-256color".to_string(),
    }
}

/// 登录脚本 → 要键入的文本：每行一条命令，空行跳过，每条以回车结束
pub fn login_script_input(script: &str) -> Option<String> {
    let lines: Vec<&str> = script
        .lines()
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return None;
    }
    let mut out = String::new();
    for line in lines {
        out.push_str(line);
        out.push('\r');
    }
    Some(out)
}

/// 合法的环境变量名
fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 认证还没结束时用户点了「断开」：在等待连接的同时盯着指令通道
async fn wait_for_close(rx: &mut UnboundedReceiver<SshCommand>) {
    loop {
        match rx.recv().await {
            Some(SshCommand::Close) | None => return,
            // 连接建立前的输入 / 尺寸 / 测量请求都没有意义，丢弃
            Some(SshCommand::Ping { reply, .. }) => drop(reply),
            Some(_) => {}
        }
    }
}

struct SessionDeps<'a> {
    app: &'a AppHandle,
    key: &'a str,
    pending_keys: &'a PendingKeys,
    auth_prompts: &'a AuthPromptRegistry,
    sftp: &'a crate::sftp::SftpState,
    handles: &'a Arc<Mutex<HashMap<String, Arc<SshHandle>>>>,
}

/// 建立连接并跑会话循环；返回 Err 时调用方会把失败阶段报给前端
async fn run_session(
    deps: SessionDeps<'_>,
    target: HopSpec,
    profile: ConnectProfile,
    cols: u32,
    rows: u32,
    rx: &mut UnboundedReceiver<SshCommand>,
) -> Result<(), SessionError> {
    let SessionDeps {
        app,
        key,
        pending_keys,
        auth_prompts,
        sftp,
        handles,
    } = deps;
    chain::validate_route(&profile.jumps, &target).map_err(SessionError::msg)?;

    let request = ChainRequest {
        app: app.clone(),
        key: key.to_string(),
        pending: pending_keys.clone(),
        prompts: auth_prompts.clone(),
        jumps: profile.jumps.clone(),
        target,
        proxy: profile.proxy.clone(),
        timeout: profile.timeout(),
        forward_sink: None,
    };

    let chain: Chain = tokio::select! {
        result = chain::connect_chain(request) => result?,
        _ = wait_for_close(rx) => {
            return Err(SessionError::msg("已取消：连接过程中用户断开了连接"));
        }
    };
    let session = chain.target.clone();

    // 认证通过后，尝试为本会话开辟 SFTP 子系统通道并注册
    if let Ok(sftp_channel) = session.channel_open_session().await {
        if sftp_channel.request_subsystem(true, "sftp").await.is_ok() {
            if let Ok(sftp_sess) = russh_sftp::client::SftpSession::new(sftp_channel.into_stream()).await {
                sftp.register_sftp(key.to_string(), Arc::new(sftp_sess)).await;
            }
        }
    }

    let mut channel = match session.channel_open_session().await {
        Ok(channel) => channel,
        Err(e) => {
            chain.close().await;
            return Err(SessionError::msg(format!("打开会话通道失败：{e}")));
        }
    };

    let term = sanitize_term(profile.term_type.as_deref());
    if let Err(e) = channel.request_pty(true, &term, cols.max(1), rows.max(1), 0, 0, &[]).await {
        chain.close().await;
        return Err(SessionError::msg(format!("申请 PTY 失败：{e}")));
    }

    // 环境变量：服务器只接受 sshd_config 里 AcceptEnv 放行的变量，其余会被它静默忽略
    let mut env_sent = 0usize;
    let mut env_skipped: Vec<String> = Vec::new();
    for var in &profile.env {
        let name = var.key.trim();
        if name.is_empty() {
            continue;
        }
        if !valid_env_name(name) {
            env_skipped.push(name.to_string());
            continue;
        }
        if channel.set_env(false, name, var.value.clone()).await.is_ok() {
            env_sent += 1;
        }
    }

    if let Err(e) = channel.request_shell(true).await {
        chain.close().await;
        return Err(SessionError::msg(format!("启动远程 shell 失败：{e}")));
    }

    let mut codec = TermCodec::new(profile.encoding.as_deref().unwrap_or("UTF-8"));
    let mut notes: Vec<String> = vec![format!("TERM={term}")];
    if codec.name() != "UTF-8" {
        notes.push(format!("编码 {}", codec.name()));
    }
    if env_sent > 0 {
        notes.push(format!("已请求设置 {env_sent} 个环境变量（服务器 AcceptEnv 未放行的会被忽略）"));
    }
    if !env_skipped.is_empty() {
        notes.push(format!("跳过非法变量名 {}", env_skipped.join("、")));
    }
    if !chain.jumps.is_empty() {
        notes.push(format!("经 {} 个跳板机", chain.jumps.len()));
    }
    // 先登记句柄再报 shell 就绪：前端一收到就绪就可能发 exec / 测量
    if let Ok(mut map) = handles.lock() {
        map.insert(key.to_string(), session.clone());
    }
    emit_phase(app, key, "shell", true, format!("远程 shell 已就绪（{cols}x{rows}，{}）", notes.join("，")));

    // 登录脚本：shell 已经起来，直接键入；shell 会把它们排在提示符之后执行
    if let Some(script) = profile.login_script.as_deref().and_then(login_script_input) {
        let _ = channel.data(&codec.encode(&script)[..]).await;
    }

    let data_event = format!("ssh://data/{key}");
    let exit_event = format!("ssh://exit/{key}");
    let mut exit_code: Option<i32> = None;
    // 同一条连接上的往返测量必须串行（russh 按 FIFO 配对答复）
    let ping_lock = Arc::new(tokio::sync::Mutex::new(()));

    loop {
        tokio::select! {
            incoming = channel.wait() => {
                match incoming {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let text = codec.decode(&data);
                        if !text.is_empty() {
                            let _ = app.emit(&data_event, text);
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status as i32);
                    }
                    Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                        let _ = app.emit(&data_event, format!("\r\n[远端进程被信号 {signal_name:?} 终止]\r\n"));
                    }
                    // EOF 只是对端不再发数据，退出码可能还在路上：继续等到通道关闭
                    Some(ChannelMsg::Eof) => {}
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            command = rx.recv() => {
                match command {
                    Some(SshCommand::Data(text)) => {
                        if channel.data(&codec.encode(&text)[..]).await.is_err() {
                            break;
                        }
                    }
                    Some(SshCommand::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols.max(1), rows.max(1), 0, 0).await;
                    }
                    Some(SshCommand::Ping { samples, timeout, reply }) => {
                        // 放到独立任务里量：测量期间终端数据照常收发
                        let handle = session.clone();
                        let lock = ping_lock.clone();
                        let task_key = key.to_string();
                        tokio::spawn(async move {
                            let _guard = lock.lock().await;
                            let report = measure_ssh_rtt(&handle, &task_key, samples, timeout).await;
                            let _ = reply.send(report);
                        });
                    }
                    Some(SshCommand::Close) | None => break,
                }
            }
        }
    }

    let tail = codec.finish();
    if !tail.is_empty() {
        let _ = app.emit(&data_event, tail);
    }
    let _ = channel.close().await;
    if let Ok(mut map) = handles.lock() {
        map.remove(key);
    }
    chain.close().await;
    let _ = app.emit(&exit_event, exit_code);
    Ok(())
}

/// 发起连接。立即返回，进度与数据都通过事件推送。
///
/// `profile` 带上跳板机链路、代理与会话选项；缺省时就是直连、默认选项。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshState>,
    sftp_state: State<'_, crate::sftp::SftpState>,
    key: String,
    host: String,
    port: u16,
    username: String,
    credential: Credential,
    cols: u32,
    rows: u32,
    profile: Option<ConnectProfile>,
) -> Result<(), String> {
    let (tx, mut rx) = unbounded_channel::<SshCommand>();
    insert_session(&state.sessions, &key, tx)?;

    let sessions = state.sessions.clone();
    let handles = state.handles.clone();
    let pending = state.pending_keys.clone();
    let auth_prompts = state.auth_prompts.clone();
    let sftp = sftp_state.inner().clone();
    let task_key = key.clone();
    let profile = profile.unwrap_or_default();
    let target = HopSpec {
        label: profile.label.clone(),
        host,
        port,
        username,
        credential,
    };

    tauri::async_runtime::spawn(async move {
        let deps = SessionDeps {
            app: &app,
            key: &task_key,
            pending_keys: &pending,
            auth_prompts: &auth_prompts,
            sftp: &sftp,
            handles: &handles,
        };
        let result = run_session(deps, target, profile, cols, rows, &mut rx).await;

        // 认证输入若还挂着（失败退出、超时），一并收掉，别留下永远等不到的通道
        auth_prompts.cancel(&task_key, "会话已结束");

        // 会话退出时注销 SFTP 句柄与连接句柄
        sftp.unregister_sftp(&task_key).await;
        if let Ok(mut map) = handles.lock() {
            map.remove(&task_key);
        }

        // 先清掉会话条目再报失败：否则界面立刻重试（例如用户刚确认完指纹）会撞上「会话已存在」
        if let Ok(mut map) = sessions.lock() {
            map.remove(&task_key);
        }

        if let Err(err) = result {
            let at = err.host.as_deref().zip(err.port);
            emit_phase_full(
                &app,
                &task_key,
                "failed",
                false,
                err.detail,
                err.kind.as_deref(),
                err.fingerprint.as_deref(),
                at,
            );
            let _ = app.emit(&format!("ssh://exit/{task_key}"), None::<i32>);
        }
    });

    Ok(())
}

/// 用户确认首次连接的指纹后调用：把待确认的密钥写进 known_hosts。
/// 密钥材料一直留在 Rust 侧，不经过前端。跳板机与目标主机同样适用。
#[tauri::command]
pub fn ssh_trust_host(
    app: AppHandle,
    state: State<'_, SshState>,
    host: String,
    port: u16,
    fingerprint: String,
) -> Result<String, String> {
    // 只信任用户在界面上核对过的那一把（按指纹挑），不是「这个地址最近出示的随便哪一把」
    let key = chain::pending_by_fingerprint(&state.pending_keys, &host, port, &fingerprint)?;
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
    fingerprint: String,
) -> Result<String, String> {
    let key = chain::pending_by_fingerprint(&state.pending_keys, &host, port, &fingerprint)?;
    let removed = known_hosts::replace(&app, &host, port, &key)?;

    // 替换后复查：旧指纹也可能来自 OpenSSH 的 ~/.ssh/known_hosts，而我们不写那个文件。
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
        Verdict::CheckFailed { reason, .. } => Err(format!("已替换 {removed} 条记录，但复查失败：{reason}")),
    }
}

/// 键盘输入 → 远端（按会话编码编码后发送）
#[tauri::command]
pub fn ssh_write(state: State<'_, SshState>, key: String, data: String) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "SSH 会话表已损坏".to_string())?;
    let tx = sessions.get(&key).ok_or_else(|| format!("未找到会话 {key}"))?;
    tx.send(SshCommand::Data(data)).map_err(|_| "会话已关闭".to_string())
}

/// 终端尺寸变化 → 远端 PTY
#[tauri::command]
pub fn ssh_resize(state: State<'_, SshState>, key: String, cols: u32, rows: u32) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "SSH 会话表已损坏".to_string())?;
    let tx = sessions.get(&key).ok_or_else(|| format!("未找到会话 {key}"))?;
    tx.send(SshCommand::Resize { cols, rows })
        .map_err(|_| "会话已关闭".to_string())
}

/// 在一条已经认证成功的会话上量真正的端到端往返（见 [`SshRttReport`]）。
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

    // 测量排在同一连接的其它测量之后，预算再放宽一层，避免命令永远挂住
    let budget = timeout * (samples * 2 + 1);
    match tokio::time::timeout(budget, reply_rx).await {
        Ok(Ok(report)) => Ok(report),
        Ok(Err(_)) => Err("会话在测量过程中结束".to_string()),
        Err(_) => Err("测量超时".to_string()),
    }
}

#[tauri::command]
pub fn ssh_disconnect(state: State<'_, SshState>, key: String) -> Result<(), String> {
    // 认证还没结束（比如正卡在键盘交互等输入）时也要把它叫醒
    state.auth_prompts.cancel(&key, "用户断开了连接");
    let sessions = state.sessions.lock().map_err(|_| "SSH 会话表已损坏".to_string())?;
    // 不在这里移除条目：会话任务收尾时自己移除（连接中途取消也能走完整的清理）
    if let Some(tx) = sessions.get(&key) {
        let _ = tx.send(SshCommand::Close);
    }
    Ok(())
}

/* ------------------------------ 远端命令（exec） ------------------------------ */

#[derive(Serialize, Debug, Clone, Default)]
pub struct ExecOutput {
    pub code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
    /// 输出超过上限被截断
    pub truncated: bool,
}

const EXEC_OUTPUT_LIMIT: usize = 1024 * 1024;

/// 在已有连接上开一个 exec 通道跑一条命令（不占用交互 shell）
pub async fn exec_on(handle: &SshHandle, command: &str, timeout: Duration) -> Result<ExecOutput, String> {
    let work = async {
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开 exec 通道失败：{e}"))?;
        channel
            .exec(true, command.as_bytes().to_vec())
            .await
            .map_err(|e| format!("执行远端命令失败：{e}"))?;
        let mut out = ExecOutput::default();
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    if stdout.len() < EXEC_OUTPUT_LIMIT {
                        stdout.extend_from_slice(&data);
                    } else {
                        out.truncated = true;
                    }
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    if stderr.len() < EXEC_OUTPUT_LIMIT {
                        stderr.extend_from_slice(&data);
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => out.code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        out.stdout = String::from_utf8_lossy(&stdout).into_owned();
        out.stderr = String::from_utf8_lossy(&stderr).into_owned();
        Ok(out)
    };
    tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| format!("远端命令 {} 秒内没有结束", timeout.as_secs()))?
}

/// 在会话所在主机上执行一条非交互命令（监控采样、传输后校验用）
#[tauri::command]
pub async fn ssh_exec(
    state: State<'_, SshState>,
    key: String,
    command: String,
    timeout_ms: Option<u64>,
) -> Result<ExecOutput, String> {
    let handle = state.handle(&key).ok_or_else(|| format!("未找到会话 {key}（可能已断开）"))?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(15_000).clamp(500, 600_000));
    exec_on(&handle, &command, timeout).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::client::AuthResult;
    use russh::keys::{HashAlg, PublicKey, PublicKeyOrCertificate};
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
        let keys: PendingKeys = Arc::new(Mutex::new(HashMap::new()));
        let fp = known_hosts::fingerprint_of(&fixture_key());
        chain::remember_pending(&keys, "18.216.234.51", 22, fixture_key());

        let first = chain::pending_by_fingerprint(&keys, "18.216.234.51", 22, &fp).expect("第一条会话应能读到待确认密钥");
        let second = chain::pending_by_fingerprint(&keys, "18.216.234.51", 22, &fp).expect("并发的第二条会话也应能读到同一把");
        assert_eq!(known_hosts::fingerprint_of(&first), known_hosts::fingerprint_of(&second));

        // 主机与端口都是维度：别的目标不能串到这台主机的材料上
        assert!(chain::pending_by_fingerprint(&keys, "49.235.166.66", 22, &fp).is_err());
        assert!(chain::pending_by_fingerprint(&keys, "18.216.234.51", 2222, &fp).is_err());
    }

    /// 用户核对的是 A、对端随后换成了 B：确认 A 只能写入 A；拿 B 的指纹去确认也只会写入 B；
    /// 拿一个从没出示过的指纹去确认必须失败
    #[test]
    fn trust_is_bound_to_the_fingerprint_the_user_saw() {
        let keys: PendingKeys = Arc::new(Mutex::new(HashMap::new()));
        let a = fixture_key();
        let b: PublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC3qHhWjgK6jCQ45pmQUhuW+ECM2RsatUtFIp8wXXNI3".parse().unwrap();
        let (fa, fb) = (known_hosts::fingerprint_of(&a), known_hosts::fingerprint_of(&b));
        chain::remember_pending(&keys, "h", 22, a.clone());
        chain::remember_pending(&keys, "h", 22, b.clone());
        assert_eq!(chain::pending_by_fingerprint(&keys, "h", 22, &fa).unwrap().key_data(), a.key_data());
        assert_eq!(chain::pending_by_fingerprint(&keys, "h", 22, &fb).unwrap().key_data(), b.key_data());
        let err = chain::pending_by_fingerprint(&keys, "h", 22, "SHA256:never-shown").unwrap_err();
        assert!(err.contains("换了钥匙"), "{err}");
        // 同一把钥匙重复出示不会堆积
        for _ in 0..20 {
            chain::remember_pending(&keys, "h", 22, a.clone());
        }
        assert_eq!(keys.lock().unwrap().get("h:22").unwrap().len(), 2);
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

        let channel = session.channel_open_session().await.expect("打开会话通道失败");
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
