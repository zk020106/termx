//! 出站传输层：直连 / SOCKS5 代理 / HTTP CONNECT 代理 / ProxyCommand。
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
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use tokio::io::ReadBuf;
use tokio::net::TcpStream;

/// SSH 握手跑在其上的字节流：TCP（直连 / SOCKS5 / HTTP）或 ProxyCommand 子进程的 stdio
pub trait Transport: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Transport for T {}
pub type BoxedTransport = Box<dyn Transport>;

/// 代理配置（与前端 `ProxyConfig` 对应；用户名/口令可缺省）
#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxySpec {
    /// socks5 / http / command（Netcatty `proxy.type === 'command'`）
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    /// ProxyCommand 模板（%h / %p / %%）
    #[serde(default)]
    pub command: Option<String>,
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
            .field("command", &self.command)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "<已隐藏>"))
            .finish()
    }
}

impl ProxySpec {
    pub fn is_command(&self) -> bool {
        self.kind.eq_ignore_ascii_case("command")
    }

    pub fn label(&self) -> String {
        if self.is_command() {
            return "ProxyCommand".to_string();
        }
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

/// 建一条到 `host:port` 的字节流，必要时经由代理。TCP / SOCKS5 / HTTP 整个过程受 `timeout` 约束；
/// ProxyCommand 与 Netcatty 一样：进程起来就返回，`timeout` 只约束「到收到第一个字节为止」。
pub async fn open_stream(
    host: &str,
    port: u16,
    proxy: Option<&ProxySpec>,
    timeout: Duration,
) -> Result<BoxedTransport, String> {
    if let Some(proxy) = proxy.filter(|p| p.is_command()) {
        let command = proxy.command.as_deref().unwrap_or_default();
        let stream = spawn_proxy_command(command, host, port, timeout)?;
        return Ok(Box::new(stream));
    }
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
            Ok(Box::new(stream))
        }
        Err(_) => Err(match proxy {
            Some(p) => format!("经{}连接 {host}:{port} 超时（{} 秒）", p.label(), timeout.as_secs()),
            None => format!("连接 {host}:{port} 超时（{} 秒）", timeout.as_secs()),
        }),
    }
}

/* ------------------------------ ProxyCommand ------------------------------ */
// 移植自 Netcatty electron/bridges/proxyUtils.cjs：substituteProxyCommand / createProxyCommandSocket。
// Node 的 spawn(command, { shell: true }) 在 Unix 上是 `/bin/sh -c command`，
// Windows 上是 `cmd.exe /d /s /c "command"`（windowsHide → CREATE_NO_WINDOW），这里照做。

fn quote_posix_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn quote_windows_cmd_arg(value: &str) -> Result<String, String> {
    if value.chars().any(|c| matches!(c, '\0' | '\r' | '\n' | '"' | '%' | '!')) {
        return Err("ProxyCommand 目标包含无法在 Windows 上安全替换的字符".to_string());
    }
    Ok(format!("\"{value}\""))
}

fn quote_shell_arg(value: &str, windows: bool) -> Result<String, String> {
    if windows {
        quote_windows_cmd_arg(value)
    } else {
        Ok(quote_posix_shell_arg(value))
    }
}

/// `%%` → `%`，`%h` → 加引号的目标主机，`%p` → 加引号的目标端口（与 Netcatty 一致）
pub fn substitute_proxy_command(command: &str, host: &str, port: u16, windows: bool) -> Result<String, String> {
    let mut out = String::with_capacity(command.len() + 16);
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            match chars.peek() {
                Some('%') => {
                    chars.next();
                    out.push('%');
                    continue;
                }
                Some('h') => {
                    chars.next();
                    out.push_str(&quote_shell_arg(host, windows)?);
                    continue;
                }
                Some('p') => {
                    chars.next();
                    out.push_str(&quote_shell_arg(&port.to_string(), windows)?);
                    continue;
                }
                _ => {}
            }
        }
        out.push(c);
    }
    Ok(out)
}

/// 代入 %h/%p 后实际要执行的命令（用于运行前的确认框）
pub fn proxy_command_line(proxy: &ProxySpec, host: &str, port: u16) -> Result<String, String> {
    let line = substitute_proxy_command(proxy.command.as_deref().unwrap_or_default(), host, port, cfg!(windows))?;
    let line = line.trim().to_string();
    if line.is_empty() {
        return Err("ProxyCommand 不能为空".to_string());
    }
    Ok(line)
}

#[derive(Default)]
struct ProxyCommandStatus {
    stderr: String,
    stderr_done: bool,
    exit: Option<String>,
}

/// ProxyCommand 子进程的 stdout/stdin 拼成的双工流。丢弃即结束子进程。
pub struct ProxyCommandStream {
    stdout: tokio::process::ChildStdout,
    stdin: tokio::process::ChildStdin,
    status: Arc<Mutex<ProxyCommandStatus>>,
    /// 到第一个字节为止的超时（Netcatty：stdout 第一次有数据就 clearConnectTimeout）
    first_byte: Option<Pin<Box<tokio::time::Sleep>>>,
    got_data: bool,
    eof_grace: u8,
    eof_timer: Option<Pin<Box<tokio::time::Sleep>>>,
    target: String,
    timeout_secs: u64,
    _kill: tokio::sync::oneshot::Sender<()>,
}

impl ProxyCommandStream {
    fn exit_error(&self) -> std::io::Error {
        let status = self.status.lock().map(|s| (s.exit.clone(), s.stderr.trim().to_string())).unwrap_or_default();
        let (exit, stderr) = status;
        let detail = if stderr.is_empty() { String::new() } else { format!("：{stderr}") };
        let how = exit.unwrap_or_else(|| "关闭了输出".to_string());
        std::io::Error::other(format!("ProxyCommand {how}{detail}"))
    }
}

impl AsyncRead for ProxyCommandStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        match Pin::new(&mut self.stdout).poll_read(cx, buf) {
            Poll::Ready(Ok(())) => {
                if buf.filled().len() == before {
                    // EOF：子进程退了。异步等一小会儿（最多约 300ms）让 stderr 与退出码收齐，
                    // 报出与 Netcatty 相同的信息（退出码 + stderr 尾部）
                    let settled = self.status.lock().map(|s| s.exit.is_some() && s.stderr_done).unwrap_or(true);
                    if !settled && self.eof_grace < 15 {
                        let this = &mut *self;
                        let timer = this.eof_timer.get_or_insert_with(|| Box::pin(tokio::time::sleep(Duration::from_millis(20))));
                        if timer.as_mut().poll(cx).is_pending() {
                            return Poll::Pending;
                        }
                        this.eof_timer = None;
                        this.eof_grace += 1;
                        cx.waker().wake_by_ref();
                        return Poll::Pending;
                    }
                    let clean = self
                        .status
                        .lock()
                        .map(|s| s.exit.as_deref() == Some("已退出（退出码 0）"))
                        .unwrap_or(false);
                    // 与 Netcatty 一致：退出码 0 且已经通过数据的，按正常关闭处理
                    if self.got_data && clean {
                        return Poll::Ready(Ok(()));
                    }
                    return Poll::Ready(Err(self.exit_error()));
                }
                self.got_data = true;
                self.first_byte = None;
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
            Poll::Pending => {
                let this = &mut *self;
                if let Some(timer) = this.first_byte.as_mut() {
                    if timer.as_mut().poll(cx).is_ready() {
                        return Poll::Ready(Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            format!("ProxyCommand 连接 {} 超时（{} 秒内没有收到任何数据）", this.target, this.timeout_secs),
                        )));
                    }
                }
                Poll::Pending
            }
        }
    }
}

impl AsyncWrite for ProxyCommandStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stdin).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdin).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdin).poll_shutdown(cx)
    }
}

use std::future::Future;

fn shell_command(line: &str) -> tokio::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut std_cmd = std::process::Command::new("cmd.exe");
        // 与 Node `shell: true` 相同：cmd.exe /d /s /c "<command>"；CREATE_NO_WINDOW 对应 windowsHide
        std_cmd.raw_arg(format!("/d /s /c \"{line}\"")).creation_flags(0x0800_0000);
        tokio::process::Command::from(std_cmd)
    }
    #[cfg(not(windows))]
    {
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.arg("-c").arg(line);
        cmd
    }
}

/// 启动 ProxyCommand。调用方必须先用 [`proxy_command_line`] 得到命令行并取得用户确认。
pub fn spawn_proxy_command(template: &str, host: &str, port: u16, timeout: Duration) -> Result<ProxyCommandStream, String> {
    let line = substitute_proxy_command(template, host, port, cfg!(windows))?;
    let line = line.trim();
    if line.is_empty() {
        return Err("ProxyCommand 不能为空".to_string());
    }
    let mut child = shell_command(line)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("无法启动 ProxyCommand：{e}"))?;
    let stdout = child.stdout.take().ok_or("ProxyCommand stdout 不可用")?;
    let stdin = child.stdin.take().ok_or("ProxyCommand stdin 不可用")?;
    let stderr = child.stderr.take();
    let status = Arc::new(Mutex::new(ProxyCommandStatus::default()));

    if let Some(mut stderr) = stderr {
        let status = status.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                if let Ok(mut s) = status.lock() {
                    s.stderr.push_str(&String::from_utf8_lossy(&buf[..n]));
                    // 只留最后 4096 字节（Netcatty 同款）
                    if s.stderr.len() > 4096 {
                        let mut cut = s.stderr.len() - 4096;
                        while !s.stderr.is_char_boundary(cut) {
                            cut += 1;
                        }
                        s.stderr.drain(..cut);
                    }
                }
            }
            if let Ok(mut s) = status.lock() {
                s.stderr_done = true;
            }
        });
    } else if let Ok(mut s) = status.lock() {
        s.stderr_done = true;
    }

    let (kill_tx, kill_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let status = status.clone();
        tokio::spawn(async move {
            tokio::select! {
                result = child.wait() => {
                    let text = match result {
                        Ok(st) => match st.code() {
                            Some(code) => format!("已退出（退出码 {code}）"),
                            None => "被信号终止".to_string(),
                        },
                        Err(e) => format!("等待进程失败：{e}"),
                    };
                    if let Ok(mut s) = status.lock() {
                        s.exit = Some(text);
                    }
                }
                // 流被丢弃（会话结束 / 连接失败）：结束子进程
                _ = kill_rx => {
                    let _ = child.kill().await;
                }
            }
        });
    }

    Ok(ProxyCommandStream {
        stdout,
        stdin,
        status,
        first_byte: (!timeout.is_zero()).then(|| Box::pin(tokio::time::sleep(timeout))),
        got_data: false,
        eof_grace: 0,
        eof_timer: None,
        target: format!("{host}:{port}"),
        timeout_secs: timeout.as_secs(),
        _kill: kill_tx,
    })
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
    fn proxy_command_substitution_matches_netcatty() {
        assert_eq!(
            substitute_proxy_command("nc %h %p", "db.internal", 22, false).unwrap(),
            "nc 'db.internal' '22'"
        );
        assert_eq!(substitute_proxy_command("echo 100%% %x", "h", 1, false).unwrap(), "echo 100% %x");
        assert_eq!(
            substitute_proxy_command("ssh -W %h:%p jump", "a'b", 2222, false).unwrap(),
            "ssh -W 'a'\\''b':'2222' jump"
        );
        assert_eq!(substitute_proxy_command("nc %h %p", "h", 22, true).unwrap(), "nc \"h\" \"22\"");
        assert!(substitute_proxy_command("nc %h", "a\"b", 22, true).is_err());
        assert!(substitute_proxy_command("nc %h", "a%b", 22, true).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn proxy_command_stream_is_a_duplex_pipe() {
        // cat 把写进去的字节原样吐回来
        let mut s = spawn_proxy_command("cat", "h", 22, Duration::from_secs(5)).unwrap();
        s.write_all(b"SSH-2.0-x\r\n").await.unwrap();
        let mut buf = [0u8; 11];
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"SSH-2.0-x\r\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn proxy_command_exit_reports_code_and_stderr() {
        let mut s = spawn_proxy_command("echo boom >&2; exit 3", "h", 22, Duration::from_secs(5)).unwrap();
        let mut buf = [0u8; 4];
        let err = s.read(&mut buf).await.unwrap_err().to_string();
        assert!(err.contains("ProxyCommand"), "{err}");
        assert!(err.contains("boom"), "{err}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn proxy_command_first_byte_timeout() {
        let mut s = spawn_proxy_command("sleep 5", "h", 22, Duration::from_millis(200)).unwrap();
        let mut buf = [0u8; 4];
        let err = s.read(&mut buf).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
    }

    #[test]
    fn http_status_parsing() {
        assert_eq!(parse_http_status("HTTP/1.1 200 OK\r\n").unwrap(), (200, "OK".into()));
        assert_eq!(parse_http_status("HTTP/1.0 502 Bad Gateway").unwrap().0, 502);
        assert!(parse_http_status("SSH-2.0-OpenSSH").is_err());
        assert!(parse_http_status("HTTP/1.1 abc").is_err());
    }
}
