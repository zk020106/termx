//! 连接链路：代理（可选）→ 跳板机 1 → 跳板机 2 → … → 目标主机。
//!
//! - 第一跳经 [`crate::transport`] 直连或经 SOCKS5 / HTTP CONNECT 代理；
//! - 之后每一跳都走上一跳的 `direct-tcpip` 通道（等同 OpenSSH 的 ProxyJump），
//!   SSH 握手跑在通道流上 —— 中间的跳板机只转发密文，看不到目标会话的内容；
//! - **每一跳都单独做 known_hosts 校验与认证**，首次连接 / 指纹变化时回报的是
//!   出问题的那一跳的 host:port，界面据此信任或替换的就是那一跳的记录；
//! - 每一跳的握手都受连接超时约束；连上以后由 keepalive 维持，对端失联会被发现。

use crate::known_hosts::{self, Verdict};
use crate::ssh_auth::{self, AuthPromptRegistry, Credential};
use crate::transport::{self, ProxySpec};
use russh::client::{self, ChannelOpenHandle, Msg, Session};
use russh::keys::{PublicKey, PublicKeyOrCertificate};
use russh::Channel;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::UnboundedSender;

/// 单跳连接超时（TCP/代理 + SSH 握手），认证阶段不计（可能在等用户输入）
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// keepalive：每 15 秒一次，连续 3 次没回应判定连接已断
pub const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
pub const KEEPALIVE_MAX: usize = 3;

/// 等用户确认的主机密钥（密钥材料留在 Rust 侧，不经过前端）。
///
/// 按 host:port 存**多把**：同一个地址前后两次握手可能看到不同的钥匙（中间人恰好在第二次换了钥匙）。
/// 确认时必须带上用户在界面上看到的那个指纹，只信任指纹一致的那一把 ——
/// 否则用户核对的是 A，写进 known_hosts 的却可能是 B。
pub type PendingKeys = Arc<Mutex<HashMap<String, Vec<PublicKey>>>>;

/// 每个地址最多留几把待确认的钥匙（防止被不停换钥匙的对端撑大）
const MAX_PENDING_PER_HOST: usize = 8;

pub fn remember_pending(keys: &PendingKeys, host: &str, port: u16, key: PublicKey) {
    let Ok(mut map) = keys.lock() else { return };
    let list = map.entry(host_port_key(host, port)).or_default();
    let fp = known_hosts::fingerprint_of(&key);
    list.retain(|k| known_hosts::fingerprint_of(k) != fp);
    list.push(key);
    if list.len() > MAX_PENDING_PER_HOST {
        let excess = list.len() - MAX_PENDING_PER_HOST;
        list.drain(..excess);
    }
}

/// 按用户核对过的指纹取待确认的钥匙（只读不取走：同主机的并发会话都要能确认）
pub fn pending_by_fingerprint(keys: &PendingKeys, host: &str, port: u16, fingerprint: &str) -> Result<PublicKey, String> {
    let map = keys.lock().map_err(|_| "待确认密钥表已损坏".to_string())?;
    let list = map
        .get(&host_port_key(host, port))
        .ok_or_else(|| "没有待确认的主机密钥，请重新发起连接".to_string())?;
    list.iter()
        .find(|k| known_hosts::fingerprint_of(k) == fingerprint.trim())
        .cloned()
        .ok_or_else(|| {
            format!(
                "{host}:{port} 最近出示的主机密钥里没有指纹 {fingerprint} 的那一把 —— 对端可能在你核对期间换了钥匙。请重新连接并再次核对"
            )
        })
}

pub fn host_port_key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

/// 链路上的一跳
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HopSpec {
    /// 给人看的名字（主机库里的名称）
    #[serde(default)]
    pub label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub credential: Credential,
}

impl HopSpec {
    pub fn display(&self) -> String {
        if self.label.is_empty() || self.label == self.host {
            format!("{}:{}", self.host, self.port)
        } else {
            format!("{}（{}:{}）", self.label, self.host, self.port)
        }
    }
}

/// 连接阶段事件：phase 取 resolve / tcp / handshake / auth / shell / failed
#[derive(Serialize, Clone, Debug)]
pub struct SshPhase {
    pub phase: String,
    pub ok: bool,
    pub detail: String,
    /// host_unknown / host_changed；普通阶段为 null
    pub kind: Option<String>,
    pub fingerprint: Option<String>,
    /// 指纹问题出在哪一跳：信任 / 替换要作用在这台主机上（跳板机时与目标不同）
    pub host: Option<String>,
    pub port: Option<u16>,
}

pub fn emit_phase(app: &AppHandle, key: &str, phase: &str, ok: bool, detail: impl Into<String>) {
    emit_phase_full(app, key, phase, ok, detail, None, None, None);
}

#[allow(clippy::too_many_arguments)]
pub fn emit_phase_full(
    app: &AppHandle,
    key: &str,
    phase: &str,
    ok: bool,
    detail: impl Into<String>,
    kind: Option<&str>,
    fingerprint: Option<&str>,
    at: Option<(&str, u16)>,
) {
    let _ = app.emit(
        &format!("ssh://state/{key}"),
        SshPhase {
            phase: phase.to_string(),
            ok,
            detail: detail.into(),
            kind: kind.map(str::to_string),
            fingerprint: fingerprint.map(str::to_string),
            host: at.map(|(h, _)| h.to_string()),
            port: at.map(|(_, p)| p),
        },
    );
}

#[derive(Debug, Default, Clone)]
pub struct SessionError {
    pub detail: String,
    pub kind: Option<String>,
    pub fingerprint: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
}

impl SessionError {
    pub fn msg(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
            ..Default::default()
        }
    }
}

/// 远程转发（-R）进来的一条连接
pub struct ForwardedChannel {
    pub channel: Channel<Msg>,
}

pub type ForwardSink = UnboundedSender<ForwardedChannel>;

/// 握手时对主机密钥的判定：(kind, 指纹, 校验失败的原因)
type HostVerdict = (String, String, Option<String>);

#[derive(Clone)]
pub struct ClientHandler {
    app: Option<AppHandle>,
    host: String,
    port: u16,
    fingerprint: Arc<Mutex<Option<String>>>,
    verdict: Arc<Mutex<Option<HostVerdict>>>,
    pending: PendingKeys,
    forwarded: Option<ForwardSink>,
}

impl ClientHandler {
    pub fn new(app: Option<AppHandle>, host: &str, port: u16, pending: PendingKeys) -> Self {
        Self {
            app,
            host: host.to_string(),
            port,
            fingerprint: Arc::new(Mutex::new(None)),
            verdict: Arc::new(Mutex::new(None)),
            pending,
            forwarded: None,
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = server_public_key.public_key();
        *self.fingerprint.lock().unwrap() = Some(known_hosts::fingerprint_of(&key));

        let verdict = match &self.app {
            Some(app) => known_hosts::verify(app, &self.host, self.port, &key),
            // 只有测试会走到这里（没有界面）：一律当首次连接
            None => Verdict::Unknown {
                fingerprint: known_hosts::fingerprint_of(&key),
            },
        };
        if matches!(verdict, Verdict::Trusted) {
            return Ok(true);
        }
        let kind = verdict.kind().unwrap_or("host_unknown").to_string();
        let fingerprint = verdict.fingerprint().unwrap_or_default().to_string();
        // 校验本身失败（记录读不了 / 解析不了 / 被吊销）时不提供「信任」：没有可供确认的待定钥匙
        if !matches!(verdict, Verdict::CheckFailed { .. }) {
            remember_pending(&self.pending, &self.host, self.port, key);
        }
        *self.verdict.lock().unwrap() = Some((kind, fingerprint, verdict.reason().map(str::to_string)));
        Ok(false)
    }

    #[allow(clippy::too_many_arguments)]
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        // 只有登记了远程转发的连接才接受；其余一律拒绝（丢掉 reply 即拒绝）
        if let Some(sink) = &self.forwarded {
            reply.accept().await;
            let _ = sink.send(ForwardedChannel { channel });
        }
        Ok(())
    }
}

pub type SshHandle = client::Handle<ClientHandler>;

/// 一条建立好的链路。跳板机的句柄必须跟着活着，否则通道会被关掉。
pub struct Chain {
    pub target: Arc<SshHandle>,
    pub jumps: Vec<Arc<SshHandle>>,
}

impl Chain {
    pub async fn close(&self) {
        let _ = self
            .target
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        for jump in self.jumps.iter().rev() {
            let _ = jump.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        }
    }
}

pub fn client_config() -> Arc<client::Config> {
    let config = client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        keepalive_max: KEEPALIVE_MAX,
        nodelay: true,
        ..Default::default()
    };
    Arc::new(config)
}

/// 链路上各跳的叫法：「跳板机 1/2 名字」/「目标主机」
fn hop_prefix(index: usize, total_jumps: usize, hop: &HopSpec) -> String {
    if index < total_jumps {
        format!("跳板机 {}/{} {}", index + 1, total_jumps, hop.display())
    } else {
        format!("目标主机 {}", hop.display())
    }
}

/// 握手失败时把「是我们拦下的」说清楚
fn handshake_error(
    handler: &ClientHandler,
    who: &str,
    error: impl std::fmt::Display,
) -> SessionError {
    if let Some((kind, fingerprint, reason)) = handler.verdict.lock().unwrap().clone() {
        let detail = match kind.as_str() {
            "host_unknown" => format!("首次连接{who}，需要你确认服务器指纹 {fingerprint}"),
            "host_changed" => format!(
                "{who} 的主机指纹与已保存的记录不一致（{fingerprint}）。可能是服务器重装，也可能是中间人攻击，已拒绝连接。"
            ),
            "host_check_failed" => format!(
                "无法校验{who}的主机密钥（{fingerprint}），已拒绝连接：{}",
                reason.unwrap_or_default()
            ),
            _ => format!("{who} 握手失败：{error}"),
        };
        return SessionError {
            detail,
            kind: Some(kind),
            fingerprint: Some(fingerprint),
            host: Some(handler.host.clone()),
            port: Some(handler.port),
        };
    }
    SessionError::msg(format!("{who} SSH 握手失败：{error}"))
}

pub struct ChainRequest {
    pub app: AppHandle,
    pub key: String,
    pub pending: PendingKeys,
    pub prompts: AuthPromptRegistry,
    pub jumps: Vec<HopSpec>,
    pub target: HopSpec,
    pub proxy: Option<ProxySpec>,
    pub timeout: Duration,
    /// 目标连接上的远程转发入口（只有 -R 规则需要）
    pub forward_sink: Option<ForwardSink>,
}

/// 依次建立链路上的每一跳，返回目标主机上已认证的连接。
pub async fn connect_chain(req: ChainRequest) -> Result<Chain, SessionError> {
    let ChainRequest {
        app,
        key,
        pending,
        prompts,
        jumps,
        target,
        proxy,
        timeout,
        forward_sink,
    } = req;
    let total_jumps = jumps.len();
    let mut hops = jumps;
    hops.push(target);

    let route: Vec<String> = hops.iter().map(|h| h.display()).collect();
    let via = match &proxy {
        Some(p) => format!("经{} → ", p.label()),
        None => String::new(),
    };
    emit_phase(&app, &key, "resolve", true, format!("{via}{}", route.join(" → ")));

    // ProxyCommand 会在本机执行任意命令：每条（代入 %h/%p 后的）命令本次运行首次使用前，
    // 都要用户在原生对话框里确认 —— 防止被注入的前端脚本借连接参数执行命令。
    // 目标主机的主机密钥照常在 ClientHandler::check_server_key 里对 known_hosts 校验。
    if let (Some(p), Some(first)) = (proxy.as_ref().filter(|p| p.is_command()), hops.first()) {
        let line = transport::proxy_command_line(p, &first.host, first.port).map_err(SessionError::msg)?;
        crate::fs_guard::confirm_native(
            &app,
            &format!("proxy-command\u{0}{line}"),
            "确认运行 ProxyCommand",
            format!(
                "连接 {} 需要在本机运行下面的 ProxyCommand：\n\n{line}\n\n如果这不是你配置的命令，请点「取消」。",
                first.display()
            ),
            "运行",
        )
        .await
        .map_err(|_| SessionError::msg("已取消：没有允许运行 ProxyCommand".to_string()))?;
        emit_phase(&app, &key, "tcp", true, format!("ProxyCommand：{line}"));
    }

    let config = client_config();
    let mut opened: Vec<Arc<SshHandle>> = Vec::new();

    for (index, hop) in hops.into_iter().enumerate() {
        let who = hop_prefix(index, total_jumps, &hop);
        let is_target = index == total_jumps;
        let mut handler = ClientHandler::new(Some(app.clone()), &hop.host, hop.port, pending.clone());
        if is_target {
            handler.forwarded = forward_sink.clone();
        }
        let probe = handler.clone();

        let handshake = async {
            if let Some(previous) = opened.last() {
                let channel = previous
                    .channel_open_direct_tcpip(hop.host.clone(), hop.port as u32, "127.0.0.1", 0)
                    .await
                    .map_err(|e| {
                        SessionError::msg(format!(
                            "上一跳无法打开到 {} 的转发通道：{e}（跳板机可能禁止了 TCP 转发，或目标不可达）",
                            hop.display()
                        ))
                    })?;
                if is_target {
                    emit_phase(&app, &key, "tcp", true, format!("已经由跳板机建立到 {} 的通道", hop.display()));
                } else {
                    emit_phase(&app, &key, "tcp", true, format!("{who}：通道已建立"));
                }
                client::connect_stream(config.clone(), channel.into_stream(), handler)
                    .await
                    .map_err(|e| handshake_error(&probe, &who, e))
            } else {
                let stream = transport::open_stream(&hop.host, hop.port, proxy.as_ref(), timeout)
                    .await
                    .map_err(SessionError::msg)?;
                let detail = match &proxy {
                    Some(p) => format!("{who}：已经由{}连通", p.label()),
                    None if is_target => format!("已连接到 {}:{}", hop.host, hop.port),
                    None => format!("{who}：TCP 已连通"),
                };
                emit_phase(&app, &key, "tcp", true, detail);
                client::connect_stream(config.clone(), stream, handler)
                    .await
                    .map_err(|e| handshake_error(&probe, &who, e))
            }
        };

        let mut session = match tokio::time::timeout(timeout, handshake).await {
            Ok(Ok(session)) => session,
            Ok(Err(error)) => {
                close_all(&opened).await;
                return Err(error);
            }
            Err(_) => {
                close_all(&opened).await;
                return Err(SessionError::msg(format!(
                    "{who} 连接超时（{} 秒内没有完成握手）",
                    timeout.as_secs()
                )));
            }
        };

        let fp = probe
            .fingerprint
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "未能取得指纹".to_string());
        if is_target {
            emit_phase_full(
                &app,
                &key,
                "handshake",
                true,
                format!("主机指纹 {fp}（已通过 known_hosts 校验）"),
                None,
                Some(&fp),
                None,
            );
        } else {
            emit_phase(&app, &key, "tcp", true, format!("{who}：指纹 {fp} 已通过 known_hosts 校验"));
        }

        let credential = match ssh_auth::resolve_credential(&app, &key, &prompts, hop.credential.clone(), &who, &hop.username, if is_target { "auth" } else { "tcp" }).await {
            Ok(c) => c,
            Err(detail) => {
                close_all(&opened).await;
                return Err(SessionError::msg(detail));
            }
        };
        let outcome = if is_target {
            ssh_auth::authenticate(&app, &key, &mut session, &hop.username, &credential, &prompts).await
        } else {
            ssh_auth::authenticate_as(&app, &key, "tcp", Some(&who), &mut session, &hop.username, &credential, &prompts).await
        };
        drop(credential);
        if let Err(detail) = outcome {
            close_all(&opened).await;
            let _ = session.disconnect(russh::Disconnect::ByApplication, "", "en").await;
            return Err(SessionError::msg(if is_target { detail } else { format!("{who}：{detail}") }));
        }
        opened.push(Arc::new(session));
    }

    let target = opened.pop().expect("至少有目标主机这一跳");
    Ok(Chain { target, jumps: opened })
}

async fn close_all(opened: &[Arc<SshHandle>]) {
    for handle in opened.iter().rev() {
        let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    }
}

/// 发现跳板链里的环与缺失（前端已经拦过，这里再兜一层，防止配置被手工改坏）
pub fn validate_route(jumps: &[HopSpec], target: &HopSpec) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for hop in jumps.iter().chain(std::iter::once(target)) {
        if hop.host.trim().is_empty() {
            return Err("跳板链里有一跳缺少主机地址".into());
        }
        if !seen.insert((hop.host.to_ascii_lowercase(), hop.port, hop.username.clone())) {
            return Err(format!("跳板链里 {} 出现了两次，会形成环路", hop.display()));
        }
    }
    if jumps.len() > 8 {
        return Err("跳板链超过 8 跳，已拒绝（多半是配置错误）".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hop(host: &str, port: u16) -> HopSpec {
        HopSpec {
            label: host.into(),
            host: host.into(),
            port,
            username: "u".into(),
            credential: Credential::Agent,
        }
    }

    #[test]
    fn route_validation() {
        assert!(validate_route(&[hop("a", 22)], &hop("b", 22)).is_ok());
        assert!(validate_route(&[hop("a", 22), hop("A", 22)], &hop("b", 22)).is_err());
        assert!(validate_route(&[hop("b", 22)], &hop("b", 22)).is_err());
        assert!(validate_route(&[], &hop("", 22)).is_err());
        // 同一台机器不同端口不算环
        assert!(validate_route(&[hop("a", 22)], &hop("a", 2222)).is_ok());
    }

    #[test]
    fn hop_naming() {
        assert_eq!(hop_prefix(0, 2, &hop("bastion", 22)), "跳板机 1/2 bastion:22");
        let mut t = hop("10.0.0.5", 22);
        t.label = "db".into();
        assert_eq!(hop_prefix(2, 2, &t), "目标主机 db（10.0.0.5:22）");
    }

    #[test]
    fn hop_spec_deserializes_from_frontend_shape() {
        let raw = r#"{"label":"跳板","host":"j.example","port":2200,"username":"ops","credential":{"method":"ask_password"}}"#;
        let spec: HopSpec = serde_json::from_str(raw).unwrap();
        assert_eq!(spec.port, 2200);
        assert!(matches!(spec.credential, Credential::AskPassword));
    }
}
