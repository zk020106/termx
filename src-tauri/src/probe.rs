//! TCP 建连探测：对 host:port 连若干次，得出**本机 connect() 耗时**与可达性。
//!
//! 口径（重要）：这里量到的只是「本机发起 connect() 到它返回」这一段，即
//! **TCP 建连耗时**，不是到主机的网络往返：
//!
//! - 装了 TUN 类代理（fake-ip 模式）的机器上，握手会由本机协议栈就地完成，
//!   connect() 在亚毫秒级返回；这个数字只反映本机协议栈，与远端无关。
//!   更极端的例子：保留域名 `.invalid` 也能「连上」。
//! - 因此展示层必须按「TCP 建连」标注，**不能当成主机延迟**。
//!   真正端到端的往返要用 [`crate::ssh::ssh_ping_rtt`]：在已认证的 SSH 连接上
//!   发一次 keepalive 往返，代理无法在本地替它作答。
//!
//! 其他约定：
//! - 地址解析在计时之外单独测量，结果放在 `dns_ms`，不混进样本。
//! - 正式采样前先跑一次预热连接（`warmup`），它不计入样本：本机第一次
//!   connect 常要先建路由/邻居表，耗时可高出数倍，混进样本会把平均值带偏。
//! - 丢包只统计「发了 SYN 但一直没有回音」。被 RST 拒绝是服务器明确回了话，
//!   端口关着不等于丢包，报「丢包 100%」会把人指到错的方向。
//!
//! 前端契约（见 src/lib/probe.ts）：
//!   probe_hosts(targets, attempts, timeout_ms) -> Vec<ProbeReport>
//!   probe_host(id, host, port, attempts, timeout_ms) -> ProbeReport

use serde::{Deserialize, Serialize};
use std::io::ErrorKind;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

/// 单批最多同时探测的主机数，避免一次点「全部测速」把连接表打满
const MAX_CONCURRENCY: usize = 16;

/// 预热连接次数：只用于把本机连接路径跑热，结果丢弃、不计时
const WARMUP_CONNECTIONS: u32 = 1;

/// 口径标识：数值是「本机 TCP 建连耗时」
pub const CALIBER: &str = "tcp_connect";

#[derive(Debug, Deserialize)]
pub struct ProbeTarget {
    /// 前端的主机 id，原样回传，便于把结果对回列表
    pub id: String,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProbeReport {
    pub id: String,
    pub host: String,
    pub port: u16,
    /// 口径标识，恒为 `tcp_connect`；展示层据此措辞
    pub caliber: &'static str,
    /// 实际连接的对端地址（解析结果里的第一个）
    pub addr: Option<String>,
    /// 是否至少成功建立过一次 TCP 连接
    pub reachable: bool,
    /// ok / refused / timeout / unresolved / error
    pub outcome: &'static str,
    /// 计时的连接次数（不含预热）
    pub attempts: u32,
    /// 预热连接次数；真正发起的连接数是 warmup + attempts
    pub warmup: u32,
    /// 成功建连的次数，也就是 samples 的长度
    pub received: u32,
    /// 被 RST 拒绝的次数（服务器明确回了话，不算丢包）
    pub refused: u32,
    /// 完全没有回音的次数（这才是丢包）
    pub timeouts: u32,
    /// 丢包率 0..1，只统计没有回音的那部分
    pub loss: f64,
    pub min_ms: f64,
    pub avg_ms: f64,
    /// 中位数：样本少的时候比平均值更稳，展示层优先用它
    pub median_ms: f64,
    pub max_ms: f64,
    /// 相邻两次采样的平均绝对差，反映建连耗时的稳定性
    pub jitter_ms: f64,
    /// 地址解析耗时；它不在样本里
    pub dns_ms: f64,
    /// 成功那几次的原始建连耗时（按发生顺序）
    pub samples: Vec<f64>,
    /// 失败原因（中文，可直接展示）
    pub error: Option<String>,
}

/// 一次连接尝试的结果
#[derive(Debug, Clone, PartialEq)]
enum Attempt {
    /// 建连成功，耗时毫秒
    Connected(f64),
    /// 被 RST 拒绝：端口没开（或对端不接受）
    Refused,
    /// 发了 SYN 但始终没回音
    NoReply,
    /// 其他错误，附人话
    Failed(String),
}

impl Attempt {
    fn error_text(&self) -> Option<String> {
        match self {
            Attempt::Connected(_) => None,
            Attempt::Refused => Some("端口未开放（连接被拒绝）".to_string()),
            Attempt::NoReply => Some("连接超时".to_string()),
            Attempt::Failed(message) => Some(message.clone()),
        }
    }
}

/// 把底层 io 错误翻译成用户能看懂的一句话
fn describe(error: &std::io::Error) -> String {
    match error.kind() {
        ErrorKind::ConnectionRefused => "端口未开放（连接被拒绝）".to_string(),
        ErrorKind::TimedOut => "连接超时".to_string(),
        ErrorKind::PermissionDenied => "被本机策略拒绝".to_string(),
        ErrorKind::AddrNotAvailable => "本机地址不可用".to_string(),
        ErrorKind::Unsupported => "该地址族不支持".to_string(),
        _ => format!("连接失败：{error}"),
    }
}

/// 发起一次连接并计时，返回结果分类而不是直接丢错误
fn connect_once(addr: SocketAddr, timeout: Duration) -> Attempt {
    let started = Instant::now();
    match TcpStream::connect_timeout(&addr, timeout) {
        Ok(stream) => {
            let elapsed = started.elapsed().as_secs_f64() * 1000.0;
            // 立刻关掉：我们只要握手耗时，不留半开连接
            let _ = stream.shutdown(std::net::Shutdown::Both);
            Attempt::Connected(elapsed)
        }
        Err(error) => classify(&error),
    }
}

/// 把 connect 的错误分成三类：对端回了 RST / 完全没回音 / 其他。
/// 抽成纯函数是为了能脱离真实网络做单测 —— 这两个类别的区分决定了「丢包」怎么算。
fn classify(error: &std::io::Error) -> Attempt {
    match error.kind() {
        ErrorKind::ConnectionRefused => Attempt::Refused,
        // 部分平台把 connect 超时报成 WouldBlock
        ErrorKind::TimedOut | ErrorKind::WouldBlock => Attempt::NoReply,
        _ => Attempt::Failed(describe(error)),
    }
}

/// 解析全部地址，并在计时之内量出解析本身的耗时
fn resolve_all(host: &str, port: u16) -> Result<(Vec<SocketAddr>, f64), String> {
    let started = Instant::now();
    let addrs: Vec<SocketAddr> = match (host, port).to_socket_addrs() {
        Ok(iter) => iter.collect(),
        Err(error) => return Err(format!("域名解析失败：{error}")),
    };
    let dns_ms = started.elapsed().as_secs_f64() * 1000.0;

    if addrs.is_empty() {
        // 解析过程没报错但一个地址都没给出来，归到「解析不到」这一类
        return Err("域名没有解析到任何地址".to_string());
    }
    Ok((addrs, dns_ms))
}

/// 样本的汇总统计；单独抽出来是为了能脱离真实网络做单测，
/// 也让 SSH 往返测量（crate::ssh）与这里的口径完全一致
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub(crate) struct Stats {
    pub(crate) min: f64,
    pub(crate) avg: f64,
    pub(crate) median: f64,
    pub(crate) max: f64,
    pub(crate) jitter: f64,
}

impl Stats {
    pub(crate) fn from_samples(samples: &[f64]) -> Stats {
        if samples.is_empty() {
            return Stats::default();
        }

        let mut sorted = samples.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let median = if sorted.len() % 2 == 1 {
            sorted[sorted.len() / 2]
        } else {
            (sorted[sorted.len() / 2 - 1] + sorted[sorted.len() / 2]) / 2.0
        };

        // 抖动：相邻采样差的平均绝对值，需要至少两次成功采样才有意义
        let jitter = if samples.len() >= 2 {
            samples
                .windows(2)
                .map(|pair| (pair[1] - pair[0]).abs())
                .sum::<f64>()
                / (samples.len() - 1) as f64
        } else {
            0.0
        };

        Stats {
            min: sorted[0],
            avg: samples.iter().sum::<f64>() / samples.len() as f64,
            median,
            max: sorted[sorted.len() - 1],
            jitter,
        }
    }
}

/// 一个「什么都没测到」的报告，用于解析失败与线程异常
fn empty_report(target: &ProbeTarget, attempts: u32, outcome: &'static str, error: String) -> ProbeReport {
    ProbeReport {
        id: target.id.clone(),
        host: target.host.clone(),
        port: target.port,
        caliber: CALIBER,
        addr: None,
        reachable: false,
        outcome,
        attempts,
        warmup: WARMUP_CONNECTIONS,
        received: 0,
        refused: 0,
        timeouts: 0,
        loss: 1.0,
        min_ms: 0.0,
        avg_ms: 0.0,
        median_ms: 0.0,
        max_ms: 0.0,
        jitter_ms: 0.0,
        dns_ms: 0.0,
        samples: Vec::new(),
        error: Some(error),
    }
}

/// 对单个目标探测：1 次预热 + attempts 次计时采样
fn probe_one(target: &ProbeTarget, attempts: u32, timeout: Duration) -> ProbeReport {
    // 解析放在计时之外：它有自己的耗时字段，不能混进建连样本
    let (addrs, dns_ms) = match resolve_all(&target.host, target.port) {
        Ok(value) => value,
        Err(message) => return empty_report(target, attempts, "unresolved", message),
    };

    // 多地址（例如 IPv6 + IPv4）只取解析结果里的第一个，与系统连接时的取法一致；
    // 把地址回报出去，出问题时能看出到底连的是哪一个
    let addr = addrs[0];

    // 预热：结果丢弃，只为了让后面的采样处在同一状态
    let warm = connect_once(addr, timeout);

    let mut samples: Vec<f64> = Vec::with_capacity(attempts as usize);
    let mut refused = 0u32;
    let mut timeouts = 0u32;
    let mut last_error: Option<String> = None;

    for _ in 0..attempts {
        let attempt = connect_once(addr, timeout);
        match &attempt {
            Attempt::Connected(ms) => samples.push(*ms),
            Attempt::Refused => refused += 1,
            Attempt::NoReply => timeouts += 1,
            // 其他错误同样要留下原因，方便定位（例如本机策略拒绝）
            Attempt::Failed(_) => {}
        }
        if let Some(message) = attempt.error_text() {
            last_error = Some(message);
        }
    }

    // 一次都没连上、而计时采样又全是「准备好了的失败」时，用预热那次的原因兜底，
    // 免得出现「有失败却说不清为什么」
    if samples.is_empty() && last_error.is_none() {
        last_error = warm.error_text();
    }

    let stats = Stats::from_samples(&samples);
    let received = samples.len() as u32;
    let reachable = received > 0;
    let outcome = outcome_of(received, refused, timeouts);

    ProbeReport {
        id: target.id.clone(),
        host: target.host.clone(),
        port: target.port,
        caliber: CALIBER,
        addr: Some(addr.to_string()),
        reachable,
        outcome,
        attempts,
        warmup: WARMUP_CONNECTIONS,
        received,
        refused,
        timeouts,
        loss: loss_of(timeouts, attempts),
        min_ms: stats.min,
        avg_ms: stats.avg,
        median_ms: stats.median,
        max_ms: stats.max,
        jitter_ms: stats.jitter,
        dns_ms,
        samples,
        error: if reachable {
            None
        } else {
            Some(last_error.unwrap_or_else(|| "连接失败".to_string()))
        },
    }
}

/// 由各类计数得出结论。抽成纯函数：这几行就是「口径」本身，必须能脱离网络单测
fn outcome_of(received: u32, refused: u32, timeouts: u32) -> &'static str {
    if received > 0 {
        "ok"
    } else if refused > 0 {
        "refused"
    } else if timeouts > 0 {
        "timeout"
    } else {
        "error"
    }
}

/// 丢包率只统计「发了 SYN 但一直没有回音」：被 RST 拒绝说明对端回了话、网络是通的，
/// 端口关着却报「丢包 100%」会把人指到完全错的方向
fn loss_of(timeouts: u32, attempts: u32) -> f64 {
    if attempts > 0 {
        timeouts as f64 / attempts as f64
    } else {
        1.0
    }
}

fn clamp_params(attempts: u32, timeout_ms: u64) -> (u32, Duration) {
    (
        attempts.clamp(1, 10),
        Duration::from_millis(timeout_ms.clamp(200, 10_000)),
    )
}

/// 批量测速：分批并发，返回顺序与入参一致。
///
/// 必须是 async 命令、并把阻塞的解析与建连挪到阻塞线程池：Tauri 的同步命令跑在主线程上，
/// 几十台不通的主机会把整个窗口冻住几十秒。
#[tauri::command]
pub async fn probe_hosts(targets: Vec<ProbeTarget>, attempts: u32, timeout_ms: u64) -> Vec<ProbeReport> {
    let fallback: Vec<(String, String, u16)> = targets
        .iter()
        .map(|t| (t.id.clone(), t.host.clone(), t.port))
        .collect();
    match tauri::async_runtime::spawn_blocking(move || probe_hosts_blocking(targets, attempts, timeout_ms)).await {
        Ok(reports) => reports,
        Err(_) => {
            let (attempts, _) = clamp_params(attempts, timeout_ms);
            fallback
                .into_iter()
                .map(|(id, host, port)| {
                    empty_report(&ProbeTarget { id, host, port }, attempts, "error", "探测线程异常退出".to_string())
                })
                .collect()
        }
    }
}

/// 批量测速的阻塞实现（在阻塞线程池里跑；单测也直接调它）
fn probe_hosts_blocking(targets: Vec<ProbeTarget>, attempts: u32, timeout_ms: u64) -> Vec<ProbeReport> {
    let (attempts, timeout) = clamp_params(attempts, timeout_ms);
    let mut reports: Vec<ProbeReport> = Vec::with_capacity(targets.len());

    for chunk in targets.chunks(MAX_CONCURRENCY) {
        let batch: Vec<ProbeReport> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|target| scope.spawn(move || probe_one(target, attempts, timeout)))
                .collect();
            handles
                .into_iter()
                .zip(chunk.iter())
                .map(|(handle, target)| {
                    handle
                        .join()
                        .unwrap_or_else(|_| empty_report(target, attempts, "error", "探测线程异常退出".to_string()))
                })
                .collect()
        });
        reports.extend(batch);
    }

    reports
}

/// 单个目标测速（同样不能占用主线程）
#[tauri::command]
pub async fn probe_host(id: String, host: String, port: u16, attempts: u32, timeout_ms: u64) -> ProbeReport {
    let (attempts, timeout) = clamp_params(attempts, timeout_ms);
    let target = ProbeTarget { id, host, port };
    let fallback = ProbeTarget {
        id: target.id.clone(),
        host: target.host.clone(),
        port: target.port,
    };
    tauri::async_runtime::spawn_blocking(move || probe_one(&target, attempts, timeout))
        .await
        .unwrap_or_else(|_| empty_report(&fallback, attempts, "error", "探测线程异常退出".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn target(port: u16) -> ProbeTarget {
        ProbeTarget {
            id: "t".to_string(),
            host: "127.0.0.1".to_string(),
            port,
        }
    }

    /// 起一个本机监听，最多接受 `accepted` 次连接，返回端口与「接到了几次」的计数器。
    ///
    /// 两个坑都是实测踩出来的：
    ///  - accept 偶发报错不代表监听坏了（客户端连上就 shutdown，可能把排队中的连接弄成
    ///    中止态）。一旦 break 掉接收线程，监听就被关掉，后面的连接会被直接拒绝，
    ///    测试随即随机失败 —— 所以出错要接着接，不能退出。
    ///  - accepted 要给足余量，别让接收线程在探测跑完之前自然结束。
    fn listener(accepted: usize) -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let counter = Arc::new(AtomicUsize::new(0));
        let seen = counter.clone();
        std::thread::spawn(move || {
            while seen.load(Ordering::SeqCst) < accepted {
                match listener.accept() {
                    Ok(_) => {
                        seen.fetch_add(1, Ordering::SeqCst);
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(1)),
                }
            }
        });
        (port, counter)
    }

    /// 等接收线程把计数追上来：accept 与计数在另一个线程里，直接读会读到 0
    fn wait_for(counter: &AtomicUsize, expected: usize) -> usize {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let seen = counter.load(Ordering::SeqCst);
            if seen >= expected || std::time::Instant::now() > deadline {
                return seen;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// 找一个当前确定没人监听的固定端口。
    ///
    /// **不能**用「绑端口 0 拿到号码再释放」：那个号码落在系统动态端口范围内，
    /// 会被并行跑的其它测试抢去监听，于是这个「关着的端口」真的能连上，
    /// 测试随机失败。所以用固定的小端口（低于 Linux/Windows 的动态范围起点），
    /// 并且逐个试到能绑上为止 —— 万一被别的程序占了也不至于误判。
    fn closed_port() -> u16 {
        for candidate in [20001u16, 20002, 20003, 20004, 20005] {
            if let Ok(listener) = TcpListener::bind(("127.0.0.1", candidate)) {
                drop(listener);
                return candidate;
            }
        }
        panic!("找不到空闲的固定测试端口");
    }

    /// 结构上就不合法的域名：单段标签超过 RFC 1035 的 63 字符上限，任何解析器都必须失败。
    /// **不能用 `.invalid`**：本机装了 fake-ip 代理时，连保留域名都会被解析出一个地址来，
    /// 那样这条测试就成了「看环境脸色」。
    const UNRESOLVABLE_HOST: &str =
        "termx-probe-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.invalid";

    #[test]
    fn measures_latency_against_local_listener() {
        // 接收上限给足余量，只关心「一共连了几次」
        let (port, seen) = listener(64);

        let report = probe_one(&target(port), 3, Duration::from_millis(800));

        assert!(report.reachable, "本机监听应当可连通");
        assert_eq!(report.received, 3, "三次都应成功");
        assert_eq!(report.loss, 0.0);
        assert_eq!(report.outcome, "ok");
        assert_eq!(report.caliber, CALIBER);
        assert!(report.addr.as_deref().unwrap_or("").starts_with("127.0.0.1:"));
        assert!(report.avg_ms > 0.0 && report.avg_ms < 800.0, "平均耗时应在合理区间");
        assert!(report.min_ms <= report.median_ms && report.median_ms <= report.max_ms);
        assert!(report.error.is_none());
        // 采样次数只认 attempts：样本里绝不能混进预热那一次
        assert_eq!(report.attempts, 3);
        assert_eq!(report.warmup, WARMUP_CONNECTIONS);
        assert_eq!(report.samples.len(), 3);
        // 但连接确实发起了 warmup + attempts 次，说明预热真的跑了
        assert_eq!(
            wait_for(&seen, 4),
            4,
            "应当是 1 次预热 + 3 次采样，共 4 次连接"
        );
    }

    #[test]
    fn closed_port_is_reported_without_pretending_to_be_packet_loss() {
        // 一个当前确定没人监听的固定端口
        let port = closed_port();

        let report = probe_one(&target(port), 2, Duration::from_millis(500));

        assert!(!report.reachable);
        assert_eq!(report.received, 0);
        assert!(report.samples.is_empty());
        assert!(report.error.is_some(), "失败必须带原因");

        // 不同环境下这里可能收到 RST（被拒绝），也可能被静默丢弃（超时），
        // 所以只断言「两种都分得清、且丢包口径对得上」，不写死是哪一种
        match report.outcome {
            // 对端回了 RST：说明网络是通的，绝不能报成丢包
            "refused" => {
                assert_eq!(report.refused, 2);
                assert_eq!(report.timeouts, 0);
                assert_eq!(report.loss, 0.0, "被拒绝不算丢包");
            }
            // 完全没有回音：这才叫丢包
            "timeout" => {
                assert_eq!(report.timeouts, 2);
                assert_eq!(report.refused, 0);
                assert_eq!(report.loss, 1.0);
            }
            other => panic!("端口关着只该是 refused 或 timeout，实际是 {other}"),
        }
    }

    #[test]
    fn outcome_and_loss_follow_the_agreed_definition() {
        // 口径本身：只要有一次连上就算 ok，一条都没连上时再看是「被拒绝」还是「没回音」
        assert_eq!(outcome_of(1, 0, 0), "ok");
        assert_eq!(outcome_of(2, 1, 1), "ok", "有成功样本就是 ok");
        assert_eq!(outcome_of(0, 3, 0), "refused");
        assert_eq!(outcome_of(0, 0, 3), "timeout");
        assert_eq!(outcome_of(0, 0, 0), "error");

        // 丢包只数没回音的那部分
        assert_eq!(loss_of(0, 3), 0.0, "三次都被 RST 拒绝不等于丢包");
        assert_eq!(loss_of(3, 3), 1.0);
        assert!((loss_of(1, 4) - 0.25).abs() < 1e-9);
        assert_eq!(loss_of(0, 0), 1.0, "没测过就该是满额，不能是 NaN");
    }

    #[test]
    fn unresolvable_host_is_reported_as_unresolved() {
        let report = probe_one(
            &ProbeTarget {
                id: "u".to_string(),
                host: UNRESOLVABLE_HOST.to_string(),
                port: 22,
            },
            3,
            Duration::from_millis(300),
        );

        assert!(!report.reachable);
        assert_eq!(report.outcome, "unresolved");
        assert_eq!(report.received, 0);
        assert_eq!(report.attempts, 3);
        assert!(report.addr.is_none(), "解析不到就不该有对端地址");
        assert!(report.error.unwrap_or_default().contains("解析"));
    }

    #[test]
    fn maps_io_errors_to_readable_reasons() {
        // 不依赖外网路由：直接验证错误到人话的映射，这是失败态展示的关键
        let refused = std::io::Error::new(ErrorKind::ConnectionRefused, "refused");
        assert_eq!(describe(&refused), "端口未开放（连接被拒绝）");

        let timed_out = std::io::Error::new(ErrorKind::TimedOut, "timeout");
        assert_eq!(describe(&timed_out), "连接超时");

        let other = std::io::Error::other("boom");
        assert!(describe(&other).starts_with("连接失败"));
    }

    #[test]
    fn attempted_classification_keeps_timeout_apart_from_refusal() {
        // 不碰真实网络：直接验证「回话」与「没回音」的分流，丢包口径全靠它
        assert_eq!(
            classify(&std::io::Error::new(ErrorKind::ConnectionRefused, "refused")),
            Attempt::Refused
        );
        assert_eq!(
            classify(&std::io::Error::new(ErrorKind::TimedOut, "timeout")),
            Attempt::NoReply
        );
        assert_eq!(
            classify(&std::io::Error::new(ErrorKind::WouldBlock, "would block")),
            Attempt::NoReply
        );
        assert!(matches!(
            classify(&std::io::Error::other("boom")),
            Attempt::Failed(_)
        ));

        assert_eq!(Attempt::Refused.error_text().unwrap(), "端口未开放（连接被拒绝）");
        assert_eq!(Attempt::NoReply.error_text().unwrap(), "连接超时");
        assert!(Attempt::Connected(1.0).error_text().is_none());
    }

    #[test]
    fn median_beats_mean_when_one_sample_is_an_outlier() {
        // 预热没做好时典型的样子：第一次 40ms，后面三次 0.5ms
        let stats = Stats::from_samples(&[40.0, 0.5, 0.5, 0.5]);
        assert!((stats.avg - 10.375).abs() < 1e-9, "平均值被离群值带偏");
        assert!((stats.median - 0.5).abs() < 1e-9, "中位数不受单个离群值影响");
        assert_eq!(stats.min, 0.5);
        assert_eq!(stats.max, 40.0);
    }

    #[test]
    fn stats_degenerate_cases_are_zero_not_nan() {
        let empty = Stats::from_samples(&[]);
        assert_eq!(empty, Stats::default());
        assert_eq!(empty.median, 0.0);
        assert_eq!(empty.jitter, 0.0);

        // 只有一次采样时抖动没有意义，必须是 0 而不是 NaN
        let single = Stats::from_samples(&[3.0]);
        assert_eq!(single.jitter, 0.0);
        assert_eq!(single.median, 3.0);

        // 偶数个样本取中间两个的平均
        let even = Stats::from_samples(&[4.0, 1.0]);
        assert_eq!(even.median, 2.5);
    }

    #[test]
    fn jitter_is_the_mean_absolute_step_between_samples() {
        let stats = Stats::from_samples(&[10.0, 12.0, 11.0]);
        // |12-10| + |11-12| = 3，除以 2 段
        assert!((stats.jitter - 1.5).abs() < 1e-9);
    }

    #[test]
    fn batch_keeps_input_order_and_covers_all() {
        let (port, _seen) = listener(64);

        let targets = vec![
            ProbeTarget {
                id: "a".to_string(),
                host: "127.0.0.1".to_string(),
                port,
            },
            ProbeTarget {
                id: "b".to_string(),
                host: UNRESOLVABLE_HOST.to_string(),
                port: 22,
            },
        ];

        let reports = probe_hosts_blocking(targets, 1, 400);

        assert_eq!(reports.len(), 2);
        assert_eq!(reports[0].id, "a");
        assert_eq!(reports[1].id, "b");
        assert!(reports[0].reachable);
        assert_eq!(reports[1].outcome, "unresolved", "解析不到的要在结果里说清楚");
    }

    /// 实测辅助：把**不预热**的连续连接耗时按顺序打出来，
    /// 用来判断「第一次连接明显更慢」到底是不是真的（决定要不要留预热）。
    /// 与其它实测一样用环境变量门控，缺变量就跳过。
    #[test]
    fn live_raw_connect_sequence_without_warmup() {
        let Ok(host) = std::env::var("TERMX_TEST_PROBE_HOST") else {
            eprintln!("跳过：未提供 TERMX_TEST_PROBE_HOST");
            return;
        };
        let port = std::env::var("TERMX_TEST_PROBE_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(22);

        let (addrs, dns_ms) = resolve_all(&host, port).expect("解析失败");
        let addr = addrs[0];
        let timeout = Duration::from_millis(1500);

        // 第一轮：就是应用里「不预热」时的样子，第一个样本往往最慢
        let cold: Vec<String> = (0..6)
            .map(|_| match connect_once(addr, timeout) {
                Attempt::Connected(ms) => format!("{ms:.3}"),
                Attempt::Refused => "拒绝".to_string(),
                Attempt::NoReply => "超时".to_string(),
                Attempt::Failed(message) => format!("出错({message})"),
            })
            .collect();
        // 第二轮：连接路径已经跑热
        let warm: Vec<String> = (0..6)
            .map(|_| match connect_once(addr, timeout) {
                Attempt::Connected(ms) => format!("{ms:.3}"),
                Attempt::Refused => "拒绝".to_string(),
                Attempt::NoReply => "超时".to_string(),
                Attempt::Failed(message) => format!("出错({message})"),
            })
            .collect();

        eprintln!(
            "目标 {host}:{port} → {addr}，解析 {dns_ms:.3} ms\n\
             不预热（应用原样，首样本在最前）：{}\n\
             已跑热：{}",
            cold.join("  "),
            warm.join("  "),
        );
    }

    /// 真实目标实测：用环境变量门控，缺变量就跳过（与 ssh.rs 的约定一致）。
    /// 作用是把 TCP 建连耗时的真实分布打出来，尤其要看「预热前后」的差。
    #[test]
    fn live_probe_prints_real_sample_distribution() {
        let Ok(host) = std::env::var("TERMX_TEST_PROBE_HOST") else {
            eprintln!("跳过：未提供 TERMX_TEST_PROBE_HOST");
            return;
        };
        let port = std::env::var("TERMX_TEST_PROBE_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(22);

        let report = probe_one(
            &ProbeTarget {
                id: "live".to_string(),
                host: host.clone(),
                port,
            },
            5,
            Duration::from_millis(1500),
        );

        eprintln!(
            "目标 {host}:{port} → 地址 {:?}，解析 {:?} ms\n口径：{}\n结果：{}  可达={} 丢包={}  拒绝={}  无回音={}\n样本：{:?}\nmin/中位/平均/max = {:.3} / {:.3} / {:.3} / {:.3} ms，抖动 {:.3} ms",
            report.addr,
            report.dns_ms,
            report.caliber,
            report.outcome,
            report.reachable,
            report.loss,
            report.refused,
            report.timeouts,
            report.samples,
            report.min_ms,
            report.median_ms,
            report.avg_ms,
            report.max_ms,
            report.jitter_ms,
        );
    }
}
