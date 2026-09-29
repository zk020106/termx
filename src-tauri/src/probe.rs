//! 主机测速：对 host:port 做多次 TCP 连接，得出延迟、抖动与丢包。
//!
//! 与 ping 的区别：这里测的是「建立到目标 SSH 端口的 TCP 连接」所需时间，
//! 因此结果直接反映用户点「连接」时首包要等多久，而不是 ICMP 往返。
//!
//! 重要边界：TCP 连得上 **不等于** SSH 可用。实测中存在 DNS 劫持与透明中间盒
//! （连 `.invalid` 这种保留域名都能解析并建立连接），所以本模块的结论只能标注为
//! 「TCP 可达」，真正的可用性要等 SSH 握手成功后才有定论。
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
    /// 是否成功建立了 TCP 连接
    pub reachable: bool,
    pub attempts: u32,
    pub received: u32,
    /// 丢包率 0..1
    pub loss: f64,
    pub min_ms: f64,
    pub avg_ms: f64,
    pub max_ms: f64,
    /// 相邻两次采样的平均绝对差，反映延迟稳定性
    pub jitter_ms: f64,
    /// 成功那几次的原始延迟
    pub samples: Vec<f64>,
    /// 失败原因（中文，可直接展示）
    pub error: Option<String>,
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

/// 解析失败的原因也分一分：域名解析不到 vs 解析到但连不上
fn resolve(host: &str, port: u16) -> Result<SocketAddr, String> {
    match (host, port).to_socket_addrs() {
        Ok(mut addrs) => addrs
            .next()
            .ok_or_else(|| "域名没有解析到任何地址".to_string()),
        Err(error) => Err(format!("域名解析失败：{error}")),
    }
}

/// 对单个目标探测 attempts 次
fn probe_one(target: &ProbeTarget, attempts: u32, timeout: Duration) -> ProbeReport {
    let mut samples: Vec<f64> = Vec::with_capacity(attempts as usize);
    let mut last_error: Option<String> = None;

    for _ in 0..attempts {
        let addr = match resolve(&target.host, target.port) {
            Ok(addr) => addr,
            Err(message) => {
                // 解析失败没必要重试，直接出结果
                last_error = Some(message);
                break;
            }
        };

        let started = Instant::now();
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => {
                samples.push(started.elapsed().as_secs_f64() * 1000.0);
                // 立刻关掉：我们只要握手耗时，不留半开连接
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            Err(error) => {
                last_error = Some(describe(&error));
            }
        }
    }

    let received = samples.len() as u32;
    let reachable = received > 0;

    let min_ms = samples.iter().copied().fold(f64::INFINITY, f64::min);
    let max_ms = samples.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let avg_ms = if reachable {
        samples.iter().sum::<f64>() / received as f64
    } else {
        0.0
    };

    // 抖动：相邻采样差的平均绝对值，需要至少两次成功采样才有意义
    let jitter_ms = if samples.len() >= 2 {
        samples
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .sum::<f64>()
            / (samples.len() - 1) as f64
    } else {
        0.0
    };

    ProbeReport {
        id: target.id.clone(),
        host: target.host.clone(),
        port: target.port,
        reachable,
        attempts,
        received,
        loss: if attempts > 0 {
            (attempts - received) as f64 / attempts as f64
        } else {
            1.0
        },
        min_ms: if reachable { min_ms } else { 0.0 },
        avg_ms,
        max_ms: if reachable { max_ms } else { 0.0 },
        jitter_ms,
        samples,
        error: if reachable {
            None
        } else {
            last_error.or_else(|| Some("连接失败".to_string()))
        },
    }
}

fn clamp_params(attempts: u32, timeout_ms: u64) -> (u32, Duration) {
    (
        attempts.clamp(1, 10),
        Duration::from_millis(timeout_ms.clamp(200, 10_000)),
    )
}

/// 批量测速：分批并发，返回顺序与入参一致
#[tauri::command]
pub fn probe_hosts(
    targets: Vec<ProbeTarget>,
    attempts: u32,
    timeout_ms: u64,
) -> Vec<ProbeReport> {
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
                    handle.join().unwrap_or_else(|_| ProbeReport {
                        id: target.id.clone(),
                        host: target.host.clone(),
                        port: target.port,
                        reachable: false,
                        attempts,
                        received: 0,
                        loss: 1.0,
                        min_ms: 0.0,
                        avg_ms: 0.0,
                        max_ms: 0.0,
                        jitter_ms: 0.0,
                        samples: Vec::new(),
                        error: Some("探测线程异常退出".to_string()),
                    })
                })
                .collect()
        });
        reports.extend(batch);
    }

    reports
}

/// 单个目标测速
#[tauri::command]
pub fn probe_host(
    id: String,
    host: String,
    port: u16,
    attempts: u32,
    timeout_ms: u64,
) -> ProbeReport {
    let (attempts, timeout) = clamp_params(attempts, timeout_ms);
    probe_one(&ProbeTarget { id, host, port }, attempts, timeout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn target(port: u16) -> ProbeTarget {
        ProbeTarget {
            id: "t".to_string(),
            host: "127.0.0.1".to_string(),
            port,
        }
    }

    #[test]
    fn measures_latency_against_local_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // 接受几次连接后线程自然结束
        std::thread::spawn(move || {
            for _ in 0..3 {
                if listener.accept().is_err() {
                    break;
                }
            }
        });

        let report = probe_one(&target(port), 3, Duration::from_millis(800));

        assert!(report.reachable, "本机监听应当可连通");
        assert_eq!(report.received, 3, "三次都应成功");
        assert_eq!(report.loss, 0.0);
        assert!(report.avg_ms > 0.0 && report.avg_ms < 800.0, "平均延迟应在合理区间");
        assert!(report.min_ms <= report.avg_ms && report.avg_ms <= report.max_ms);
        assert_eq!(report.samples.len(), 3);
        assert!(report.error.is_none());
    }

    #[test]
    fn reports_closed_port_with_reason() {
        // 绑一个端口拿到号码后立刻释放，几乎必然得到「连接被拒绝」
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };

        let report = probe_one(&target(port), 2, Duration::from_millis(500));

        assert!(!report.reachable);
        assert_eq!(report.received, 0);
        assert_eq!(report.loss, 1.0);
        assert!(report.error.is_some(), "失败必须带原因");
        assert!(report.samples.is_empty());
    }

    #[test]
    fn maps_io_errors_to_readable_reasons() {
        // 不依赖外网路由：直接验证错误到人话的映射，这是失败态展示的关键
        let refused = std::io::Error::new(ErrorKind::ConnectionRefused, "refused");
        assert_eq!(describe(&refused), "端口未开放（连接被拒绝）");

        let timed_out = std::io::Error::new(ErrorKind::TimedOut, "timeout");
        assert_eq!(describe(&timed_out), "连接超时");

        let other = std::io::Error::new(ErrorKind::Other, "boom");
        assert!(describe(&other).starts_with("连接失败"));
    }

    #[test]
    fn batch_keeps_input_order_and_covers_all() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for _ in 0..2 {
                if listener.accept().is_err() {
                    break;
                }
            }
        });

        let targets = vec![
            ProbeTarget {
                id: "a".to_string(),
                host: "127.0.0.1".to_string(),
                port,
            },
            ProbeTarget {
                id: "b".to_string(),
                host: "host.invalid".to_string(),
                port: 22,
            },
        ];

        let reports = probe_hosts(targets, 1, 400);

        assert_eq!(reports.len(), 2);
        assert_eq!(reports[0].id, "a");
        assert_eq!(reports[1].id, "b");
        assert!(reports[0].reachable);
    }
}
