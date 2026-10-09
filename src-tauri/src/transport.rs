//! 出站传输层：直连 / SOCKS5 代理 / HTTP CONNECT 代理。
//!
//! 主机编辑里的「代理」配置在这里落地：SSH 握手跑在这里返回的字节流上，
//! 跳板机链路的第一跳也从这里出发（后续各跳走上一跳的 direct-tcpip 通道）。
//!
//! 握手函数对任意 `AsyncRead + AsyncWrite` 泛型，测试用内存管道就能完整驱动，
//! 不需要真的起一个代理。

use base64::Engine;
use serde::Deserialize;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

/// 代理配置（与前端 `ProxyConfig` 对应；用户名/口令可缺省）
#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxySpec {
    /// socks5 / http
    #[serde(rename = "type")]
    pub kind: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

impl std::fmt::Debug for ProxySpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProxySpec")
            .field("kind", &self.kind)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "<已隐藏>"))
            .finish()
    }
}

impl ProxySpec {
    pub fn label(&self) -> String {
        let kind = if self.kind.eq_ignore_ascii_case("http") { "HTTP" } else { "SOCKS5" };
        format!("{kind} 代理 {}:{}", self.host, self.port)
    }

    fn credentials(&self) -> Option<(&str, &str)> {
        match self.username.as_deref() {
            Some(user) if !user.is_empty() => Some((user, self.password.as_deref().unwrap_or(""))),
            _ => None,
        }
    }
}

/// 建一条到 `host:port` 的 TCP 流，必要时经由代理。整个过程受 `timeout` 约束。
pub async fn open_stream(
    host: &str,
    port: u16,
    proxy: Option<&ProxySpec>,
    timeout: Duration,
) -> Result<TcpStream, String> {
    let work = async {
        match proxy {
            None => TcpStream::connect((host, port))
                .await
                .map_err(|e| format!("建立 TCP 连接失败（{host}:{port}）：{e}")),
            Some(proxy) => {
                let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
                    .await
                    .map_err(|e| format!("连接{}失败：{e}", proxy.label()))?;
                if proxy.kind.eq_ignore_ascii_case("http") {
                    http_connect(&mut stream, host, port, proxy.credentials()).await?;
                } else {
                    socks5_connect(&mut stream, host, port, proxy.credentials()).await?;
                }
                Ok(stream)
            }
        }
    };
    match tokio::time::timeout(timeout, work).await {
        Ok(result) => {
            let stream = result?;
            let _ = stream.set_nodelay(true);
            Ok(stream)
        }
        Err(_) => Err(match proxy {
            Some(p) => format!("经{}连接 {host}:{port} 超时（{} 秒）", p.label(), timeout.as_secs()),
            None => format!("连接 {host}:{port} 超时（{} 秒）", timeout.as_secs()),
        }),
    }
}

/* ------------------------------ SOCKS5 客户端 ------------------------------ */

fn socks5_reply_text(code: u8) -> &'static str {
    match code {
        0x01 => "代理服务器内部错误",
        0x02 => "代理规则不允许这条连接",
        0x03 => "网络不可达",
        0x04 => "主机不可达",
        0x05 => "目标拒绝连接",
        0x06 => "TTL 过期",
        0x07 => "代理不支持该命令",
        0x08 => "代理不支持该地址类型",
        _ => "未知错误",
    }
}

/// SOCKS5 握手（RFC 1928 / 1929）。目标地址按域名发给代理，由代理侧解析 ——
/// 这样内网域名、仅代理可解析的地址都能用。
pub async fn socks5_connect<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    host: &str,
    port: u16,
    auth: Option<(&str, &str)>,
) -> Result<(), String> {
    let io = |e: std::io::Error| format!("SOCKS5 握手中断：{e}");
    if host.len() > 255 {
        return Err("目标主机名过长（SOCKS5 限 255 字节）".into());
    }

    // 1) 问候：声明支持的认证方式
    let greeting: &[u8] = if auth.is_some() { &[0x05, 0x02, 0x00, 0x02] } else { &[0x05, 0x01, 0x00] };
    stream.write_all(greeting).await.map_err(io)?;
    let mut choice = [0u8; 2];
    stream.read_exact(&mut choice).await.map_err(io)?;
    if choice[0] != 0x05 {
        return Err(format!("对端不是 SOCKS5 代理（版本字节 0x{:02x}）", choice[0]));
    }
    match choice[1] {
        0x00 => {}
        0x02 => {
            let Some((user, pass)) = auth else {
                return Err("SOCKS5 代理要求用户名/口令，但没有配置".into());
            };
            if user.len() > 255 || pass.len() > 255 {
                return Err("SOCKS5 用户名或口令过长（限 255 字节）".into());
            }
            let mut msg = vec![0x01, user.len() as u8];
            msg.extend_from_slice(user.as_bytes());
            msg.push(pass.len() as u8);
            msg.extend_from_slice(pass.as_bytes());
            stream.write_all(&msg).await.map_err(io)?;
            let mut status = [0u8; 2];
            stream.read_exact(&mut status).await.map_err(io)?;
            if status[1] != 0x00 {
                return Err("SOCKS5 代理拒绝了用户名/口令".into());
            }
        }
        0xff => return Err("SOCKS5 代理不接受任何可用的认证方式".into()),
        other => return Err(format!("SOCKS5 代理选择了不支持的认证方式 0x{other:02x}")),
    }

    // 2) CONNECT 请求（ATYP=域名；IP 字面量按 IP 发）
    let mut req = vec![0x05, 0x01, 0x00];
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => {
            req.push(0x01);
            req.extend_from_slice(&v4.octets());
        }
        Ok(std::net::IpAddr::V6(v6)) => {
            req.push(0x04);
            req.extend_from_slice(&v6.octets());
        }
        Err(_) => {
            req.push(0x03);
            req.push(host.len() as u8);
            req.extend_from_slice(host.as_bytes());
        }
    }
    req.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&req).await.map_err(io)?;

    // 3) 应答：VER REP RSV ATYP BND.ADDR BND.PORT
    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await.map_err(io)?;
    if head[0] != 0x05 {
        return Err("SOCKS5 应答格式错误".into());
    }
    if head[1] != 0x00 {
        return Err(format!(
            "SOCKS5 代理无法连到 {host}:{port}：{}（0x{:02x}）",
            socks5_reply_text(head[1]),
            head[1]
        ));
    }
    let skip = match head[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(io)?;
            len[0] as usize
        }
        other => return Err(format!("SOCKS5 应答地址类型未知 0x{other:02x}")),
    };
    let mut rest = vec![0u8; skip + 2];
    stream.read_exact(&mut rest).await.map_err(io)?;
    Ok(())
}

/* ---------------------------- HTTP CONNECT 客户端 ---------------------------- */

/// 解析 HTTP CONNECT 的应答头，返回状态码与原因短语
pub fn parse_http_status(head: &str) -> Result<(u16, String), String> {
    let line = head.lines().next().unwrap_or_default();
    let mut parts = line.splitn(3, ' ');
    let version = parts.next().unwrap_or_default();
    if !version.starts_with("HTTP/") {
        return Err(format!("HTTP 代理应答格式错误：{line}"));
    }
    let code = parts
        .next()
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| format!("HTTP 代理应答缺少状态码：{line}"))?;
    Ok((code, parts.next().unwrap_or_default().trim().to_string()))
}

/// HTTP CONNECT 隧道。只读到头部结束（`\r\n\r\n`）为止，之后的字节属于 SSH。
pub async fn http_connect<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    host: &str,
    port: u16,
    auth: Option<(&str, &str)>,
) -> Result<(), String> {
    let io = |e: std::io::Error| format!("HTTP 代理握手中断：{e}");
    let authority = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let mut req = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some((user, pass)) = auth {
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
        req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).await.map_err(io)?;

    // 逐字节读，保证不多吞 SSH 的首个字节
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 16 * 1024 {
            return Err("HTTP 代理应答头过长".into());
        }
        let n = stream.read(&mut byte).await.map_err(io)?;
        if n == 0 {
            return Err("HTTP 代理在应答前关闭了连接".into());
        }
        head.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&head);
    let (code, reason) = parse_http_status(&text)?;
    match code {
        200..=299 => Ok(()),
        407 => Err(if auth.is_some() {
            "HTTP 代理拒绝了用户名/口令（407）".to_string()
        } else {
            "HTTP 代理要求认证（407），请在主机的代理设置里填写用户名与口令".to_string()
        }),
        _ => Err(format!("HTTP 代理拒绝隧道到 {host}:{port}：{code} {reason}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[tokio::test]
    async fn socks5_without_auth_sends_domain_connect() {
        let (mut client, mut server) = duplex(1024);
        let srv = tokio::spawn(async move {
            let mut greet = [0u8; 3];
            server.read_exact(&mut greet).await.unwrap();
            assert_eq!(greet, [5, 1, 0]);
            server.write_all(&[5, 0]).await.unwrap();
            let mut head = [0u8; 5];
            server.read_exact(&mut head).await.unwrap();
            assert_eq!(&head[..4], &[5, 1, 0, 3]);
            let mut name = vec![0u8; head[4] as usize + 2];
            server.read_exact(&mut name).await.unwrap();
            assert_eq!(&name[..name.len() - 2], b"db.internal");
            assert_eq!(&name[name.len() - 2..], &22u16.to_be_bytes());
            server.write_all(&[5, 0, 0, 1, 10, 0, 0, 1, 0, 22]).await.unwrap();
            server.write_all(b"SSH-2.0-test\r\n").await.unwrap();
        });
        socks5_connect(&mut client, "db.internal", 22, None).await.unwrap();
        // 握手之后的字节原样留给 SSH
        let mut banner = [0u8; 14];
        client.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"SSH-2.0-test\r\n");
        srv.await.unwrap();
    }

    #[tokio::test]
    async fn socks5_user_pass_auth_and_failure_reply() {
        let (mut client, mut server) = duplex(1024);
        let srv = tokio::spawn(async move {
            let mut greet = [0u8; 4];
            server.read_exact(&mut greet).await.unwrap();
            assert_eq!(greet, [5, 2, 0, 2]);
            server.write_all(&[5, 2]).await.unwrap();
            let mut ver_ulen = [0u8; 2];
            server.read_exact(&mut ver_ulen).await.unwrap();
            let mut user = vec![0u8; ver_ulen[1] as usize];
            server.read_exact(&mut user).await.unwrap();
            assert_eq!(user, b"alice");
            let mut plen = [0u8; 1];
            server.read_exact(&mut plen).await.unwrap();
            let mut pass = vec![0u8; plen[0] as usize];
            server.read_exact(&mut pass).await.unwrap();
            assert_eq!(pass, b"s3cret");
            server.write_all(&[1, 0]).await.unwrap();
            let mut req = [0u8; 10];
            server.read_exact(&mut req).await.unwrap();
            assert_eq!(&req[..4], &[5, 1, 0, 1]);
            server.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
        });
        let err = socks5_connect(&mut client, "10.1.2.3", 22, Some(("alice", "s3cret")))
            .await
            .unwrap_err();
        assert!(err.contains("目标拒绝连接"), "{err}");
        srv.await.unwrap();
    }

    #[tokio::test]
    async fn socks5_rejected_credentials() {
        let (mut client, mut server) = duplex(1024);
        tokio::spawn(async move {
            let mut greet = [0u8; 4];
            server.read_exact(&mut greet).await.unwrap();
            server.write_all(&[5, 2]).await.unwrap();
            let mut buf = [0u8; 64];
            let _ = server.read(&mut buf).await.unwrap();
            server.write_all(&[1, 1]).await.unwrap();
        });
        let err = socks5_connect(&mut client, "h", 22, Some(("u", "bad"))).await.unwrap_err();
        assert!(err.contains("拒绝了用户名"), "{err}");
    }

    #[tokio::test]
    async fn socks5_requires_auth_but_none_configured() {
        let (mut client, mut server) = duplex(1024);
        tokio::spawn(async move {
            let mut greet = [0u8; 3];
            server.read_exact(&mut greet).await.unwrap();
            server.write_all(&[5, 0xff]).await.unwrap();
        });
        let err = socks5_connect(&mut client, "h", 22, None).await.unwrap_err();
        assert!(err.contains("不接受"), "{err}");
    }

    #[tokio::test]
    async fn http_connect_success_keeps_following_bytes() {
        let (mut client, mut server) = duplex(4096);
        let srv = tokio::spawn(async move {
            let mut buf = vec![0u8; 512];
            let mut got = Vec::new();
            while !got.ends_with(b"\r\n\r\n") {
                let n = server.read(&mut buf).await.unwrap();
                got.extend_from_slice(&buf[..n]);
            }
            let text = String::from_utf8(got).unwrap();
            assert!(text.starts_with("CONNECT example.com:2222 HTTP/1.1\r\n"));
            // "u:p" 的 base64
            assert!(text.contains("Proxy-Authorization: Basic dTpw\r\n"));
            server
                .write_all(b"HTTP/1.1 200 Connection established\r\nX-A: b\r\n\r\nSSH-2.0-x\r\n")
                .await
                .unwrap();
        });
        http_connect(&mut client, "example.com", 2222, Some(("u", "p"))).await.unwrap();
        let mut rest = [0u8; 11];
        client.read_exact(&mut rest).await.unwrap();
        assert_eq!(&rest, b"SSH-2.0-x\r\n");
        srv.await.unwrap();
    }

    #[tokio::test]
    async fn http_connect_407_and_403() {
        for (reply, needle) in [
            (&b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"[..], "要求认证"),
            (&b"HTTP/1.0 403 Forbidden\r\n\r\n"[..], "403 Forbidden"),
        ] {
            let (mut client, mut server) = duplex(4096);
            let reply = reply.to_vec();
            tokio::spawn(async move {
                let mut buf = [0u8; 512];
                let _ = server.read(&mut buf).await.unwrap();
                server.write_all(&reply).await.unwrap();
            });
            let err = http_connect(&mut client, "h", 22, None).await.unwrap_err();
            assert!(err.contains(needle), "{err}");
        }
    }

    #[test]
    fn http_status_parsing() {
        assert_eq!(parse_http_status("HTTP/1.1 200 OK\r\n").unwrap(), (200, "OK".into()));
        assert_eq!(parse_http_status("HTTP/1.0 502 Bad Gateway").unwrap().0, 502);
        assert!(parse_http_status("SSH-2.0-OpenSSH").is_err());
        assert!(parse_http_status("HTTP/1.1 abc").is_err());
    }
}
