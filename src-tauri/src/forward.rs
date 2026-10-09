//! 端口转发：本地（-L）、远程（-R）、动态 SOCKS5（-D）。
//!
//! 每条规则独占一条 SSH 连接（链路与终端会话一样：代理 / 跳板机 / 每跳指纹校验），
//! 这样规则的启停不影响任何终端，终端断开也不会拖垮正在跑的转发。
//!
//! 状态通过 `forward://state/{ruleId}` 推送：starting / running / stopped / error，
//! 运行中每秒推一次连接数与流量（只在有变化时推）。连接阶段与认证提问沿用
//! `ssh://state/fwd:{ruleId}` 与 `ssh://auth-prompt/fwd:{ruleId}`。

use crate::chain::{self, Chain, ChainRequest, ForwardedChannel, HopSpec, SessionError};
use crate::ssh::{ConnectProfile, SshState};
use crate::ssh_auth::Credential;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ForwardSpec {
    /// local / remote / dynamic
    #[serde(rename = "type")]
    pub kind: String,
    pub bind_address: String,
    pub bind_port: u16,
    #[serde(default)]
    pub target_host: String,
    #[serde(default)]
    pub target_port: u16,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ForwardEvent {
    pub state: String,
    pub connections: u64,
    pub total_connections: u64,
    pub traffic_in: u64,
    pub traffic_out: u64,
    pub error: Option<String>,
    pub kind: Option<String>,
    pub fingerprint: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    /// 实际监听的地址（远程转发绑定 0 端口时由服务器分配）
    pub bound: Option<String>,
}

/// 转发流量计数：in = 从远端流回本地的字节，out = 本地发往远端的字节
#[derive(Default)]
pub struct Counters {
    pub active: AtomicU64,
    pub total: AtomicU64,
    pub bytes_in: AtomicU64,
    pub bytes_out: AtomicU64,
}

struct Running {
    stop: watch::Sender<bool>,
    counters: Arc<Counters>,
}

#[derive(Default)]
pub struct ForwardState {
    rules: Arc<Mutex<HashMap<String, Running>>>,
}

fn event_name(rule_id: &str) -> String {
    format!("forward://state/{rule_id}")
}

pub fn session_key(rule_id: &str) -> String {
    format!("fwd:{rule_id}")
}

fn emit(app: &AppHandle, rule_id: &str, event: ForwardEvent) {
    let _ = app.emit(&event_name(rule_id), event);
}

fn snapshot(state: &str, c: &Counters) -> ForwardEvent {
    ForwardEvent {
        state: state.to_string(),
        connections: c.active.load(Ordering::Relaxed),
        total_connections: c.total.load(Ordering::Relaxed),
        traffic_in: c.bytes_in.load(Ordering::Relaxed),
        traffic_out: c.bytes_out.load(Ordering::Relaxed),
        ..Default::default()
    }
}

/// 双向拷贝并计数；任一方向结束后关闭写端，等另一方向收尾
pub async fn pump<A, B>(local: A, remote: B, counters: Arc<Counters>)
where
    A: AsyncRead + AsyncWrite + Unpin + Send,
    B: AsyncRead + AsyncWrite + Unpin + Send,
{
    let (mut lr, mut lw) = tokio::io::split(local);
    let (mut rr, mut rw) = tokio::io::split(remote);
    let c_out = counters.clone();
    let up = async move {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match lr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if rw.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                    c_out.bytes_out.fetch_add(n as u64, Ordering::Relaxed);
                }
            }
        }
        let _ = rw.shutdown().await;
    };
    let c_in = counters.clone();
    let down = async move {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match rr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if lw.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                    c_in.bytes_in.fetch_add(n as u64, Ordering::Relaxed);
                }
            }
        }
        let _ = lw.shutdown().await;
    };
    tokio::join!(up, down);
}

/* ------------------------------ SOCKS5 服务端 ------------------------------ */

/// 动态转发：解析浏览器等客户端发来的 SOCKS5 请求，返回目标 host:port。
/// 只支持无认证 + CONNECT（与 `ssh -D` 一致）。
pub async fn socks5_accept<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S) -> Result<(String, u16), String> {
    let io = |e: std::io::Error| format!("SOCKS5 请求读取失败：{e}");
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await.map_err(io)?;
    if head[0] == 0x04 {
        return Err("只支持 SOCKS5（收到的是 SOCKS4 请求）".into());
    }
    if head[0] != 0x05 {
        return Err(format!("不是 SOCKS5 请求（版本字节 0x{:02x}）", head[0]));
    }
    let mut methods = vec![0u8; head[1] as usize];
    stream.read_exact(&mut methods).await.map_err(io)?;
    if !methods.contains(&0x00) {
        let _ = stream.write_all(&[0x05, 0xff]).await;
        return Err("客户端要求认证，动态转发只支持无认证 SOCKS5".into());
    }
    stream.write_all(&[0x05, 0x00]).await.map_err(io)?;

    let mut req = [0u8; 4];
    stream.read_exact(&mut req).await.map_err(io)?;
    if req[1] != 0x01 {
        let _ = stream.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        return Err(format!("只支持 CONNECT 命令（收到 0x{:02x}）", req[1]));
    }
    let host = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            stream.read_exact(&mut a).await.map_err(io)?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        0x04 => {
            let mut a = [0u8; 16];
            stream.read_exact(&mut a).await.map_err(io)?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(io)?;
            let mut name = vec![0u8; len[0] as usize];
            stream.read_exact(&mut name).await.map_err(io)?;
            String::from_utf8(name).map_err(|_| "目标域名不是合法文本".to_string())?
        }
        other => {
            let _ = stream.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            return Err(format!("不支持的地址类型 0x{other:02x}"));
        }
    };
    let mut port = [0u8; 2];
    stream.read_exact(&mut port).await.map_err(io)?;
    Ok((host, u16::from_be_bytes(port)))
}

pub async fn socks5_reply<S: AsyncWrite + Unpin>(stream: &mut S, ok: bool) -> std::io::Result<()> {
    let code = if ok { 0x00 } else { 0x05 };
    stream.write_all(&[0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await
}

/* ------------------------------ 规则运行 ------------------------------ */

async fn serve_local(
    listener: TcpListener,
    chain: Arc<Chain>,
    spec: ForwardSpec,
    counters: Arc<Counters>,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((socket, peer)) = accepted else { continue };
                let _ = socket.set_nodelay(true);
                let chain = chain.clone();
                let counters = counters.clone();
                let spec = spec.clone();
                tokio::spawn(async move {
                    counters.total.fetch_add(1, Ordering::Relaxed);
                    counters.active.fetch_add(1, Ordering::Relaxed);
                    let opened = chain
                        .target
                        .channel_open_direct_tcpip(spec.target_host.clone(), spec.target_port as u32, peer.ip().to_string(), peer.port() as u32)
                        .await;
                    if let Ok(channel) = opened {
                        pump(socket, channel.into_stream(), counters.clone()).await;
                    }
                    counters.active.fetch_sub(1, Ordering::Relaxed);
                });
            }
            _ = stop.changed() => break,
        }
    }
}

async fn serve_dynamic(
    listener: TcpListener,
    chain: Arc<Chain>,
    counters: Arc<Counters>,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((mut socket, peer)) = accepted else { continue };
                let _ = socket.set_nodelay(true);
                let chain = chain.clone();
                let counters = counters.clone();
                tokio::spawn(async move {
                    let target = tokio::time::timeout(Duration::from_secs(10), socks5_accept(&mut socket)).await;
                    let Ok(Ok((host, port))) = target else { return };
                    counters.total.fetch_add(1, Ordering::Relaxed);
                    counters.active.fetch_add(1, Ordering::Relaxed);
                    match chain
                        .target
                        .channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32)
                        .await
                    {
                        Ok(channel) => {
                            if socks5_reply(&mut socket, true).await.is_ok() {
                                pump(socket, channel.into_stream(), counters.clone()).await;
                            }
                        }
                        Err(_) => {
                            let _ = socks5_reply(&mut socket, false).await;
                        }
                    }
                    counters.active.fetch_sub(1, Ordering::Relaxed);
                });
            }
            _ = stop.changed() => break,
        }
    }
}

async fn serve_remote(
    mut incoming: mpsc::UnboundedReceiver<ForwardedChannel>,
    spec: ForwardSpec,
    counters: Arc<Counters>,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            next = incoming.recv() => {
                let Some(forwarded) = next else { break };
                let counters = counters.clone();
                let spec = spec.clone();
                tokio::spawn(async move {
                    counters.total.fetch_add(1, Ordering::Relaxed);
                    counters.active.fetch_add(1, Ordering::Relaxed);
                    let connect = TcpStream::connect((spec.target_host.as_str(), spec.target_port));
                    if let Ok(Ok(local)) = tokio::time::timeout(Duration::from_secs(10), connect).await {
                        let _ = local.set_nodelay(true);
                        pump(local, forwarded.channel.into_stream(), counters.clone()).await;
                    } else {
                        let _ = forwarded.channel.close().await;
                    }
                    counters.active.fetch_sub(1, Ordering::Relaxed);
                });
            }
            _ = stop.changed() => break,
        }
    }
}

fn validate_spec(spec: &ForwardSpec) -> Result<(), String> {
    match spec.kind.as_str() {
        "local" | "remote" => {
            if spec.target_host.trim().is_empty() || spec.target_port == 0 {
                return Err("缺少目标地址或端口".into());
            }
        }
        "dynamic" => {}
        other => return Err(format!("未知的转发类型 {other}")),
    }
    if spec.kind != "remote" && spec.bind_port == 0 {
        return Err("本地监听端口不能为 0".into());
    }
    Ok(())
}

fn bind_text(spec: &ForwardSpec) -> String {
    let addr = if spec.bind_address.trim().is_empty() { "127.0.0.1" } else { spec.bind_address.trim() };
    if addr.contains(':') {
        format!("[{addr}]:{}", spec.bind_port)
    } else {
        format!("{addr}:{}", spec.bind_port)
    }
}

/// 启动一条转发规则。连接与监听都成功后才返回 Ok；之后的状态走事件。
#[tauri::command]
#[allow(clippy::too_many_arguments, clippy::result_large_err)]
pub async fn forward_start(
    app: AppHandle,
    state: State<'_, ForwardState>,
    ssh_state: State<'_, SshState>,
    rule_id: String,
    spec: ForwardSpec,
    host: String,
    port: u16,
    username: String,
    credential: Credential,
    profile: Option<ConnectProfile>,
) -> Result<ForwardEvent, ForwardEvent> {
    let fail = |error: String| ForwardEvent {
        state: "error".into(),
        error: Some(error),
        ..Default::default()
    };
    validate_spec(&spec).map_err(fail)?;
    if state.rules.lock().map_err(|_| fail("转发表已损坏".into()))?.contains_key(&rule_id) {
        return Err(fail("这条规则已经在运行".into()));
    }

    let profile = profile.unwrap_or_default();
    let target = HopSpec {
        label: profile.label.clone(),
        host,
        port,
        username,
        credential,
    };
    chain::validate_route(&profile.jumps, &target).map_err(fail)?;
    emit(&app, &rule_id, ForwardEvent { state: "starting".into(), ..Default::default() });

    // 先占住本地端口：端口被占用时不必白白建一条 SSH 连接
    let local_listener = if spec.kind != "remote" {
        let ip = spec.bind_address.trim();
        let ip = if ip.is_empty() { "127.0.0.1" } else { ip };
        match TcpListener::bind((ip, spec.bind_port)).await {
            Ok(l) => Some(l),
            Err(e) => {
                let err = fail(format!("无法监听 {}：{e}", bind_text(&spec)));
                emit(&app, &rule_id, err.clone());
                return Err(err);
            }
        }
    } else {
        None
    };

    let (sink_tx, sink_rx) = mpsc::unbounded_channel();
    let key = session_key(&rule_id);
    let request = ChainRequest {
        app: app.clone(),
        key: key.clone(),
        pending: ssh_state.pending_keys.clone(),
        prompts: ssh_state.auth_prompts.clone(),
        jumps: profile.jumps.clone(),
        target,
        proxy: profile.proxy.clone(),
        timeout: profile.timeout(),
        forward_sink: if spec.kind == "remote" { Some(sink_tx) } else { None },
    };

    // 连接期间允许「停止」：登记一个 stop 通道，连接完成前收到就放弃
    let (stop_tx, mut stop_rx) = watch::channel(false);
    let counters = Arc::new(Counters::default());
    state
        .rules
        .lock()
        .map_err(|_| fail("转发表已损坏".into()))?
        .insert(rule_id.clone(), Running { stop: stop_tx, counters: counters.clone() });

    let rules = state.rules.clone();
    let cleanup = |rules: &Arc<Mutex<HashMap<String, Running>>>| {
        if let Ok(mut map) = rules.lock() {
            map.remove(&rule_id);
        }
    };

    let connected = tokio::select! {
        r = chain::connect_chain(request) => r,
        _ = stop_rx.changed() => Err(SessionError::msg("已取消：启动过程中规则被停止")),
    };
    ssh_state.auth_prompts.cancel(&key, "连接阶段已结束");
    let chain = match connected {
        Ok(chain) => Arc::new(chain),
        Err(e) => {
            cleanup(&rules);
            let err = ForwardEvent {
                state: "error".into(),
                error: Some(e.detail),
                kind: e.kind,
                fingerprint: e.fingerprint,
                host: e.host,
                port: e.port,
                ..Default::default()
            };
            emit(&app, &rule_id, err.clone());
            return Err(err);
        }
    };

    let bound = match (&spec.kind[..], &local_listener) {
        ("remote", _) => {
            let addr = if spec.bind_address.trim().is_empty() { "127.0.0.1".to_string() } else { spec.bind_address.trim().to_string() };
            match chain.target.tcpip_forward(addr.clone(), spec.bind_port as u32).await {
                Ok(assigned) => {
                    let p = if spec.bind_port == 0 { assigned } else { spec.bind_port as u32 };
                    format!("远端 {addr}:{p}")
                }
                Err(e) => {
                    chain.close().await;
                    cleanup(&rules);
                    let err = fail(format!(
                        "服务器拒绝了远程转发 {addr}:{}：{e}（检查 sshd 的 AllowTcpForwarding / GatewayPorts，或端口已被占用）",
                        spec.bind_port
                    ));
                    emit(&app, &rule_id, err.clone());
                    return Err(err);
                }
            }
        }
        (_, Some(l)) => l.local_addr().map(|a| a.to_string()).unwrap_or_else(|_| bind_text(&spec)),
        _ => bind_text(&spec),
    };

    let mut running = snapshot("running", &counters);
    running.bound = Some(bound.clone());
    emit(&app, &rule_id, running.clone());

    // 服务循环
    let server_stop = stop_rx.clone();
    let server = {
        let chain = chain.clone();
        let spec = spec.clone();
        let counters = counters.clone();
        match local_listener {
            Some(listener) if spec.kind == "dynamic" => tokio::spawn(serve_dynamic(listener, chain, counters, server_stop)),
            Some(listener) => tokio::spawn(serve_local(listener, chain, spec, counters, server_stop)),
            None => tokio::spawn(serve_remote(sink_rx, spec, counters, server_stop)),
        }
    };

    // 监视：每秒推统计；SSH 断开则报错收工；收到停止则清理
    let app_bg = app.clone();
    let rule_bg = rule_id.clone();
    let rules_bg = rules.clone();
    tauri::async_runtime::spawn(async move {
        let mut last = (u64::MAX, 0, 0, 0);
        let mut stop = stop_rx;
        let final_state: ForwardEvent = loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(1)) => {
                    if chain.target.is_closed() {
                        let mut ev = snapshot("error", &counters);
                        ev.error = Some("SSH 连接已断开，转发已停止".into());
                        break ev;
                    }
                    let now = (
                        counters.active.load(Ordering::Relaxed),
                        counters.total.load(Ordering::Relaxed),
                        counters.bytes_in.load(Ordering::Relaxed),
                        counters.bytes_out.load(Ordering::Relaxed),
                    );
                    if now != last {
                        last = now;
                        let mut ev = snapshot("running", &counters);
                        ev.bound = Some(bound.clone());
                        emit(&app_bg, &rule_bg, ev);
                    }
                }
                _ = stop.changed() => break snapshot("stopped", &counters),
            }
        };
        server.abort();
        if spec.kind == "remote" {
            let addr = if spec.bind_address.trim().is_empty() { "127.0.0.1".to_string() } else { spec.bind_address.trim().to_string() };
            let _ = chain.target.cancel_tcpip_forward(addr, spec.bind_port as u32).await;
        }
        chain.close().await;
        if let Ok(mut map) = rules_bg.lock() {
            map.remove(&rule_bg);
        }
        emit(&app_bg, &rule_bg, final_state);
    });

    Ok(running)
}

/// 停止一条规则（启动中也能停）
#[tauri::command]
pub fn forward_stop(state: State<'_, ForwardState>, ssh_state: State<'_, SshState>, rule_id: String) -> Result<(), String> {
    ssh_state.auth_prompts.cancel(&session_key(&rule_id), "用户停止了转发规则");
    let map = state.rules.lock().map_err(|_| "转发表已损坏".to_string())?;
    if let Some(running) = map.get(&rule_id) {
        let _ = running.stop.send(true);
    }
    Ok(())
}

/// 当前在运行的规则及其统计（界面重新挂载时对账用）
#[tauri::command]
pub fn forward_list(state: State<'_, ForwardState>) -> Result<HashMap<String, ForwardEvent>, String> {
    let map = state.rules.lock().map_err(|_| "转发表已损坏".to_string())?;
    Ok(map
        .iter()
        .map(|(id, r)| (id.clone(), snapshot("running", &r.counters)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[tokio::test]
    async fn socks5_server_parses_domain_connect() {
        let (mut client, mut server) = duplex(1024);
        let cli = tokio::spawn(async move {
            client.write_all(&[5, 1, 0]).await.unwrap();
            let mut choice = [0u8; 2];
            client.read_exact(&mut choice).await.unwrap();
            assert_eq!(choice, [5, 0]);
            let mut req = vec![5, 1, 0, 3, 11];
            req.extend_from_slice(b"example.com");
            req.extend_from_slice(&443u16.to_be_bytes());
            client.write_all(&req).await.unwrap();
            let mut reply = [0u8; 10];
            client.read_exact(&mut reply).await.unwrap();
            reply
        });
        let (host, port) = socks5_accept(&mut server).await.unwrap();
        assert_eq!((host.as_str(), port), ("example.com", 443));
        socks5_reply(&mut server, true).await.unwrap();
        assert_eq!(cli.await.unwrap()[1], 0);
    }

    #[tokio::test]
    async fn socks5_server_ipv4_and_rejects() {
        let (mut client, mut server) = duplex(1024);
        tokio::spawn(async move {
            client.write_all(&[5, 1, 0, 5, 1, 0, 1, 10, 0, 0, 7, 0, 80]).await.unwrap();
            let mut sink = [0u8; 16];
            let _ = client.read(&mut sink).await;
        });
        assert_eq!(socks5_accept(&mut server).await.unwrap(), ("10.0.0.7".into(), 80));

        // 只支持无认证
        let (mut client, mut server) = duplex(1024);
        tokio::spawn(async move {
            client.write_all(&[5, 1, 2]).await.unwrap();
            let mut sink = [0u8; 2];
            let _ = client.read_exact(&mut sink).await;
            assert_eq!(sink, [5, 0xff]);
        });
        assert!(socks5_accept(&mut server).await.is_err());

        // BIND 命令被拒绝
        let (mut client, mut server) = duplex(1024);
        tokio::spawn(async move {
            client.write_all(&[5, 1, 0, 5, 2, 0, 1, 1, 2, 3, 4, 0, 1]).await.unwrap();
            let mut sink = [0u8; 16];
            let _ = client.read(&mut sink).await;
        });
        assert!(socks5_accept(&mut server).await.unwrap_err().contains("CONNECT"));
    }

    #[tokio::test]
    async fn pump_counts_both_directions() {
        let (a_local, mut a_peer) = duplex(4096);
        let (b_remote, mut b_peer) = duplex(4096);
        let counters = Arc::new(Counters::default());
        let task = tokio::spawn(pump(a_local, b_remote, counters.clone()));
        a_peer.write_all(b"hello").await.unwrap();
        let mut got = [0u8; 5];
        b_peer.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"hello");
        b_peer.write_all(b"world!!").await.unwrap();
        let mut back = [0u8; 7];
        a_peer.read_exact(&mut back).await.unwrap();
        drop(a_peer);
        drop(b_peer);
        task.await.unwrap();
        assert_eq!(counters.bytes_out.load(Ordering::Relaxed), 5);
        assert_eq!(counters.bytes_in.load(Ordering::Relaxed), 7);
    }

    #[test]
    fn spec_validation() {
        let mut s = ForwardSpec {
            kind: "local".into(),
            bind_address: "127.0.0.1".into(),
            bind_port: 8080,
            target_host: "db".into(),
            target_port: 5432,
        };
        assert!(validate_spec(&s).is_ok());
        s.target_port = 0;
        assert!(validate_spec(&s).is_err());
        s.kind = "dynamic".into();
        assert!(validate_spec(&s).is_ok());
        s.bind_port = 0;
        assert!(validate_spec(&s).is_err());
        s.kind = "remote".into();
        s.target_port = 80;
        assert!(validate_spec(&s).is_ok(), "远程转发允许 0 端口（由服务器分配）");
        s.kind = "weird".into();
        assert!(validate_spec(&s).is_err());
        assert_eq!(bind_text(&ForwardSpec { bind_address: "::1".into(), ..s.clone() }), "[::1]:0");
    }
}
