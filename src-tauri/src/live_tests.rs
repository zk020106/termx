//! 端到端实测（需要本机起好的 sshd / 代理，见 termx-v2.md「实测环境」）。
//! 默认忽略；运行：TERMX_LIVE=/tmp/txlive cargo test live_ -- --ignored --nocapture --test-threads=1
//!
//! 直接调用 Tauri 命令函数（与前端 invoke 走同一份代码），参数从 JSON 反序列化（与 IPC 同形）。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Listener, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::forward::{self, ForwardState};
use crate::sftp::{self, SftpState};
use crate::ssh::{self, SshState};
use crate::ssh_auth::Credential;
use crate::transfer::{self, TransferState};

fn live_dir() -> Option<String> {
    std::env::var("TERMX_LIVE").ok()
}

fn build_app() -> tauri::App {
    let mut ctx = tauri::generate_context!();
    ctx.config_mut().app.windows.clear();
    tauri::Builder::default()
        .any_thread()
        .manage(SshState::default())
        .manage(SftpState::default())
        .manage(ForwardState::default())
        .manage(TransferState::default())
        .manage(crate::pty::PtyState::default())
        .manage(crate::app_window::AppWindowState::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                crate::app_window::on_window_destroyed(window);
            }
        })
        .build(ctx)
        .expect("build app")
}

fn cred(v: Value) -> Credential {
    serde_json::from_value(v).unwrap()
}

fn profile(v: Value) -> Option<ssh::ConnectProfile> {
    Some(serde_json::from_value(v).unwrap())
}

/// 收集某个事件的载荷
fn collect(app: &tauri::AppHandle, event: &str) -> Arc<Mutex<Vec<String>>> {
    let out = Arc::new(Mutex::new(Vec::new()));
    let o = out.clone();
    app.listen_any(event.to_string(), move |e| o.lock().unwrap().push(e.payload().to_string()));
    out
}

async fn wait_for(buf: &Arc<Mutex<Vec<String>>>, needle: &str, secs: u64) -> bool {
    for _ in 0..secs * 10 {
        if buf.lock().unwrap().iter().any(|s| s.contains(needle)) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// ssh_connect 立即返回、在后台建链；这里等到 shell 就绪或失败
async fn connect(
    app: &tauri::AppHandle,
    key: &str,
    port: u16,
    credential: Credential,
    prof: Option<ssh::ConnectProfile>,
) -> Result<(), String> {
    connect_host(app, key, "127.0.0.1", port, credential, prof).await
}

async fn connect_host(
    app: &tauri::AppHandle,
    key: &str,
    host: &str,
    port: u16,
    credential: Credential,
    prof: Option<ssh::ConnectProfile>,
) -> Result<(), String> {
    let phases = collect(app, &format!("ssh://state/{key}"));
    ssh::ssh_connect(
        app.clone(),
        app.state(),
        app.state(),
        key.into(),
        host.into(),
        port,
        whoami(),
        credential,
        80,
        24,
        prof,
    )
    .await?;
    for _ in 0..300 {
        for p in phases.lock().unwrap().iter() {
            let v: Value = serde_json::from_str(p).unwrap();
            match v["phase"].as_str() {
                Some("shell") => return Ok(()),
                Some("failed") => return Err(format!("{} [{}] {}", v["detail"], v["kind"], v["fingerprint"])),
                _ => {}
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("timeout; phases={:?}", phases.lock().unwrap()))
}

/// 从 connect 的错误串里取出界面会展示的指纹（最后一段，JSON 字符串）
fn fp_of(err: &str) -> String {
    err.rsplit(' ').next().unwrap().trim_matches('"').to_string()
}

fn whoami() -> String {
    std::env::var("USER").unwrap_or_else(|_| "box".into())
}

fn walk_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk_files(&p));
            } else {
                out.push(p);
            }
        }
    }
    out
}

async fn banner(port: u16) -> String {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut buf = [0u8; 64];
    let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf)).await.unwrap().unwrap();
    String::from_utf8_lossy(&buf[..n]).to_string()
}

#[test]
#[ignore]
fn live_end_to_end() {
    let Some(dir) = live_dir() else {
        eprintln!("TERMX_LIVE 未设置，跳过");
        return;
    };
    let app = build_app();
    let h = app.handle().clone();
    tauri::async_runtime::block_on(run_all(h, dir));
}

async fn run_all(app: tauri::AppHandle, dir: String) {
    let plain = format!("{dir}/id_plain");
    let enc = format!("{dir}/id_enc");
    // 每次从「谁都没信任过」开始；只在隔离的 HOME 下动手，绝不碰真实配置
    let cfg = app.path().app_config_dir().unwrap();
    assert!(cfg.starts_with("/tmp/"), "请用隔离的 HOME/XDG_CONFIG_HOME 运行实测：{cfg:?}");
    let _ = std::fs::remove_file(cfg.join("known_hosts"));
    let key_plain = json!({"method": "private_key", "path": plain, "passphrase": null});

    /* 1. 首次连接：未知主机必须拒绝，并给出指纹；信任后可连 */
    let r = connect(&app, "s1", 2222, cred(key_plain.clone()), None).await;
    let e = r.expect_err("unknown host must be rejected");
    assert!(e.contains("host_unknown"), "{e}");
    println!("[1] 未知主机被拒绝：{e}");
    // 信任必须绑定用户看到的指纹：拿一个没出示过的指纹去确认要失败
    let bad = ssh::ssh_trust_host(app.clone(), app.state(), "127.0.0.1".into(), 2222, "SHA256:not-the-one".into());
    println!("[1] 错误指纹确认被拒：{}", bad.as_ref().unwrap_err());
    assert!(bad.is_err());
    let shown = fp_of(&e);
    let fp = ssh::ssh_trust_host(app.clone(), app.state(), "127.0.0.1".into(), 2222, shown.clone()).unwrap();
    assert_eq!(fp, shown);
    println!("[1] 已信任 127.0.0.1:2222 {fp}");
    // 已知主机列表（Netcatty KnownHostsManager）：刚信任的记录能列出、指纹一致；移除后回到「未知主机」，再重新信任
    let listed = crate::known_hosts::known_hosts_list(app.clone()).unwrap();
    let entry = listed
        .iter()
        .find(|e| e.source == "termx" && e.host.as_deref() == Some("127.0.0.1") && e.port == 2222)
        .unwrap_or_else(|| panic!("known_hosts_list 没列出刚信任的主机：{listed:?}"));
    assert_eq!(entry.fingerprint.as_deref(), Some(fp.as_str()));
    assert_eq!(crate::known_hosts::known_hosts_remove(app.clone(), entry.line.clone()).unwrap(), 1);
    let e = connect(&app, "s1b", 2222, cred(key_plain.clone()), None).await.unwrap_err();
    assert!(e.contains("host_unknown"), "移除后应回到未知主机：{e}");
    ssh::ssh_trust_host(app.clone(), app.state(), "127.0.0.1".into(), 2222, fp_of(&e)).unwrap();
    println!("[1] 已知主机列出 / 移除 / 重新信任 OK");

    /* 2. 会话选项：环境变量 + 登录脚本 + 编码(GBK) */
    let data = collect(&app, "ssh://data/s2");
    let p = profile(json!({
        "env": [{"key": "TX_FOO", "value": "bar-from-env"}],
        "loginScript": "echo LOGIN_$TX_FOO\nprintf '\\304\\343\\272\\303\\n'",
        "encoding": "GBK",
        "termType": "xterm-256color"
    }));
    connect(&app, "s2", 2222, cred(key_plain.clone()), p).await.expect("connect s2");
    assert!(wait_for(&data, "LOGIN_bar-from-env", 10).await, "login script + env: {:?}", data.lock().unwrap());
    assert!(wait_for(&data, "你好", 10).await, "GBK decode: {:?}", data.lock().unwrap());
    println!("[2] 环境变量、登录脚本、GBK 解码 OK");
    // 键入方向同样按 GBK 编码：「中文」应以 d6 d0 ce c4 到达远端
    ssh::ssh_write(app.state(), "s2".into(), "echo 中文 | od -An -tx1\r".into()).unwrap();
    assert!(wait_for(&data, "d6 d0 ce c4", 10).await, "GBK encode: {:?}", data.lock().unwrap());
    println!("[2] 输入按 GBK 编码 OK");

    /* 2b. 连接超时：对端接受 TCP 但永不发 banner */
    let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let silent_port = silent.local_addr().unwrap().port();
    let _hold = tauri::async_runtime::spawn(async move {
        let mut keep = Vec::new();
        while let Ok((s, _)) = silent.accept().await {
            keep.push(s);
        }
    });
    let t0 = std::time::Instant::now();
    let e = connect(&app, "s_to", silent_port, cred(key_plain.clone()), profile(json!({"connectTimeoutSecs": 2}))).await.unwrap_err();
    let took = t0.elapsed();
    assert!(e.contains("超时") && took < Duration::from_secs(6), "{e} {took:?}");
    println!("[2b] 连接超时 {:.1}s：{e}", took.as_secs_f32());

    /* 3. ssh_exec（监控采样同一通道）与 RTT */
    let out = ssh::ssh_exec(app.state(), "s2".into(), "cat /proc/loadavg; echo '@@termx@@'; nproc".into(), Some(5000))
        .await
        .unwrap();
    assert!(out.stdout.contains("@@termx@@"));
    let rtt = ssh::ssh_ping_rtt(app.state(), "s2".into(), 3, 1000).await.unwrap();
    assert!(rtt.received > 0);
    println!("[3] exec 采样 OK，RTT 中位数 {:.2} ms", rtt.median_ms);

    /* 4. SFTP：上传 / 下载 / 续传 / 校验 / 冲突检测 */
    let local = format!("{dir}/blob.bin");
    let data_bytes: Vec<u8> = (0..6_000_000u32).map(|i| (i.wrapping_mul(2654435761) >> 24) as u8).collect();
    std::fs::write(&local, &data_bytes).unwrap();
    let remote = format!("{dir}/remote-blob.bin");
    let _ = std::fs::remove_file(&remote);
    // 限速 1.5 MB/s，跑一会儿后暂停
    transfer::transfer_set_limits(app.state(), 1_500_000, 1_500_000);
    let app2 = app.clone();
    let (l2, r2) = (local.clone(), remote.clone());
    let job = tauri::async_runtime::spawn(async move {
        transfer::transfer_start(app2.clone(), app2.state(), app2.state(), app2.state(), "t1".into(), "s2".into(), "upload".into(), l2, r2, false, true).await
    });
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(transfer::transfer_control(app.state(), "t1".into(), "pause".into()).unwrap());
    let paused = job.await.unwrap().unwrap();
    assert_eq!(paused.state, "paused");
    assert!(paused.transferred > 0 && paused.transferred < data_bytes.len() as u64);
    let info = transfer::transfer_check(app.state(), "s2".into(), "upload".into(), local.clone(), remote.clone()).await.unwrap();
    assert_eq!(info.partial, paused.transferred);
    println!("[4] 暂停于 {} 字节，部分文件 {} 字节", paused.transferred, info.partial);
    transfer::transfer_set_limits(app.state(), 0, 0);
    let done = transfer::transfer_start(app.clone(), app.state(), app.state(), app.state(), "t1".into(), "s2".into(), "upload".into(), local.clone(), remote.clone(), true, true)
        .await
        .unwrap();
    assert_eq!(done.state, "done");
    assert_eq!(done.verified, Some(true), "{:?}", done.verify_note);
    assert_eq!(std::fs::read(&remote).unwrap(), data_bytes);
    println!("[4] 续传完成并在远端复算 SHA-256 一致");
    let back = format!("{dir}/blob-back.bin");
    let _ = std::fs::remove_file(&back);
    let d = transfer::transfer_start(app.clone(), app.state(), app.state(), app.state(), "t2".into(), "s2".into(), "download".into(), back.clone(), remote.clone(), false, true)
        .await
        .unwrap();
    assert_eq!(d.verified, Some(true));
    assert_eq!(std::fs::read(&back).unwrap(), data_bytes);
    println!("[4] 下载完成，校验一致");
    // 编辑器原子保存 + 冲突检测
    let txt = format!("{dir}/edit.txt");
    std::fs::write(&txt, "v1").unwrap();
    let st = sftp::sftp_stat(app.state(), "s2".into(), txt.clone()).await.unwrap();
    std::thread::sleep(Duration::from_millis(1100));
    std::fs::write(&txt, "changed by someone").unwrap();
    let conflict = sftp::sftp_write_file(app.state(), "s2".into(), txt.clone(), "mine".into(), Some(st.mtime)).await;
    assert!(conflict.unwrap_err().starts_with("CONFLICT:"));
    sftp::sftp_write_file(app.state(), "s2".into(), txt.clone(), "mine".into(), None).await.unwrap();
    assert_eq!(std::fs::read_to_string(&txt).unwrap(), "mine");
    println!("[4] 编辑器保存冲突检测与强制覆盖 OK");
    // 远程文件名带 `..` 拼出来的本地路径：后端直接拒绝，不落地
    let evil = format!("{dir}/dl/../../evil.txt");
    let e = transfer::transfer_start(app.clone(), app.state(), app.state(), app.state(), "t3".into(), "s2".into(), "download".into(), evil, txt.clone(), false, false)
        .await
        .unwrap_err();
    assert!(e.contains(".."), "{e}");
    assert!(!std::path::Path::new("/tmp/evil.txt").exists());
    println!("[4] 路径穿越的下载目标被拒绝：{e}");

    /* 4b. M9：OpenSSH 的 known_hosts 里这台主机的记录坏了 → 拒绝（不能降级成「首次连接」） */
    let ssh_dir = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join(".ssh");
    assert!(ssh_dir.starts_with("/tmp/"), "只在隔离 HOME 下改 known_hosts");
    std::fs::create_dir_all(&ssh_dir).unwrap();
    std::fs::write(ssh_dir.join("known_hosts"), "[127.0.0.1]:2223 ssh-ed25519 !!broken!!\n").unwrap();
    let e = connect(&app, "s_m9", 2223, cred(key_plain.clone()), None).await.unwrap_err();
    assert!(e.contains("host_check_failed") && e.contains("无法解析"), "{e}");
    println!("[4b] 坏记录被拒绝：{e}");
    std::fs::remove_file(ssh_dir.join("known_hosts")).unwrap();

    /* 5. 跳板：jump(2223，口令私钥，连接时询问) → target(2222) */
    let prompts = collect(&app, "ssh://auth-prompt/s3");
    let p = profile(json!({
        "label": "target",
        "jumps": [{"label": "jump", "host": "127.0.0.1", "port": 2223, "username": whoami(),
                   "credential": {"method": "ask_passphrase", "path": enc}}]
    }));
    let r = connect(&app, "s3", 2222, cred(key_plain.clone()), p.clone()).await;
    let err = r.unwrap_err();
    assert!(err.contains("host_unknown") && err.contains("跳板"), "{err}");
    println!("[5] 跳板未信任：{err}");
    ssh::ssh_trust_host(app.clone(), app.state(), "127.0.0.1".into(), 2223, fp_of(&err)).unwrap();
    let app3 = app.clone();
    let responder = tauri::async_runtime::spawn(async move {
        for _ in 0..100 {
            if app3.state::<SshState>().auth_prompts.resolve("s3", vec!["pp".into()]).is_ok() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    });
    connect(&app, "s3", 2222, cred(key_plain.clone()), p).await.expect("connect via jump");
    assert!(responder.await.unwrap(), "passphrase prompt answered");
    assert!(prompts.lock().unwrap().iter().any(|s| s.contains("口令") || s.contains("passphrase")), "{:?}", prompts.lock().unwrap());
    let out = ssh::ssh_exec(app.state(), "s3".into(), "echo via-jump".into(), Some(5000)).await.unwrap();
    assert!(out.stdout.contains("via-jump"));
    let log = std::fs::read_to_string(format!("{dir}/sshd_2223.log")).unwrap_or_default();
    assert!(log.contains("direct-tcpip") || log.contains("Accepted publickey"), "jump sshd log");
    println!("[5] 经跳板连接成功（口令通过认证提问获取）");

    /* 6. 代理：SOCKS5（带认证）、HTTP CONNECT（带认证）、错误口令 */
    for (k, proxy) in [
        ("s4", json!({"type": "socks5", "host": "127.0.0.1", "port": 1080, "username": "tu", "password": "tp"})),
        ("s5", json!({"type": "http", "host": "127.0.0.1", "port": 3128, "username": "hu", "password": "hp"})),
    ] {
        connect(&app, k, 2222, cred(key_plain.clone()), profile(json!({"proxy": proxy}))).await.unwrap_or_else(|e| panic!("{k}: {e}"));
        let out = ssh::ssh_exec(app.state(), k.into(), "echo via-proxy".into(), Some(5000)).await.unwrap();
        assert!(out.stdout.contains("via-proxy"));
        println!("[6] {k} 经代理连接 OK");
    }
    let bad = connect(&app, "s6", 2222, cred(key_plain.clone()),
        profile(json!({"proxy": {"type": "socks5", "host": "127.0.0.1", "port": 1080, "username": "tu", "password": "wrong"}}))).await;
    println!("[6] SOCKS5 错误口令：{}", bad.as_ref().unwrap_err());
    assert!(bad.is_err());
    let bad = connect(&app, "s7", 2222, cred(key_plain.clone()),
        profile(json!({"proxy": {"type": "http", "host": "127.0.0.1", "port": 3128, "username": "hu", "password": "wrong"}}))).await;
    println!("[6] HTTP 错误口令：{}", bad.as_ref().unwrap_err());
    assert!(bad.is_err());

    /* 7. 端口转发：-L / -D / -R，以及经跳板的 -L */
    let fwd_cred = || cred(key_plain.clone());
    let start = |id: &'static str, spec: Value, prof: Option<ssh::ConnectProfile>| {
        let app = app.clone();
        let c = fwd_cred();
        async move {
            forward::forward_start(app.clone(), app.state(), app.state(), id.into(), serde_json::from_value(spec).unwrap(),
                "127.0.0.1".into(), 2222, whoami(), c, prof).await
        }
    };
    let ev = start("L1", json!({"type": "local", "bindAddress": "127.0.0.1", "bindPort": 18022, "targetHost": "127.0.0.1", "targetPort": 2223}), None)
        .await
        .unwrap_or_else(|e| panic!("{:?}", e.error));
    assert_eq!(ev.state, "running");
    assert!(banner(18022).await.starts_with("SSH-2.0"));
    println!("[7] -L 127.0.0.1:18022 → 2223 OK");

    start("D1", json!({"type": "dynamic", "bindAddress": "127.0.0.1", "bindPort": 18080}), None).await.unwrap();
    let mut s = TcpStream::connect(("127.0.0.1", 18080)).await.unwrap();
    s.write_all(&[5, 1, 0]).await.unwrap();
    let mut b2 = [0u8; 2];
    s.read_exact(&mut b2).await.unwrap();
    let mut req = vec![5, 1, 0, 3, 9];
    req.extend_from_slice(b"localhost");
    req.extend_from_slice(&2223u16.to_be_bytes());
    s.write_all(&req).await.unwrap();
    let mut rep = [0u8; 10];
    s.read_exact(&mut rep).await.unwrap();
    assert_eq!(rep[1], 0, "socks reply ok");
    let mut bb = [0u8; 8];
    s.read_exact(&mut bb).await.unwrap();
    assert_eq!(&bb[..7], b"SSH-2.0");
    println!("[7] -D SOCKS5 18080 → localhost:2223 OK");

    let ev = start("R1", json!({"type": "remote", "bindAddress": "127.0.0.1", "bindPort": 18023, "targetHost": "127.0.0.1", "targetPort": 2223}), None)
        .await
        .unwrap_or_else(|e| panic!("{:?}", e.error));
    println!("[7] -R bound {:?}", ev.bound);
    assert!(banner(18023).await.starts_with("SSH-2.0"));
    println!("[7] -R 远端 18023 → 本地 2223 OK");

    // 统计：等一秒让监视任务推送
    let states = collect(&app, "forward://state/L1");
    let _ = banner(18022).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(states.lock().unwrap().iter().any(|s| s.contains("\"totalConnections\":2")), "{:?}", states.lock().unwrap());
    println!("[7] 统计事件 OK：{}", states.lock().unwrap().last().unwrap());

    // 端口占用
    let busy = start("L2", json!({"type": "local", "bindAddress": "127.0.0.1", "bindPort": 18022, "targetHost": "x", "targetPort": 1}), None).await;
    println!("[7] 端口占用：{:?}", busy.as_ref().unwrap_err().error);

    // 经跳板的 -L（跳板已信任；用不带口令的私钥）
    let pj = profile(json!({"jumps": [{"label": "jump", "host": "127.0.0.1", "port": 2223, "username": whoami(),
        "credential": {"method": "private_key", "path": plain, "passphrase": null}}]}));
    start("L3", json!({"type": "local", "bindAddress": "127.0.0.1", "bindPort": 18024, "targetHost": "127.0.0.1", "targetPort": 2222}), pj).await.unwrap();
    assert!(banner(18024).await.starts_with("SSH-2.0"));
    println!("[7] 经跳板的 -L OK");

    for id in ["L1", "D1", "R1", "L3"] {
        forward::forward_stop(app.state(), app.state(), id.into()).unwrap();
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(TcpStream::connect(("127.0.0.1", 18022)).await.is_err(), "listener released after stop");
    assert!(forward::forward_list(app.state()).unwrap().is_empty());
    println!("[7] 停止后端口已释放");

    /* 9. cwd：exec 通道探测交互 shell 的当前目录（Netcatty getSessionPwd），以及上传剪贴板图片 */
    let cwd_dir = format!("{dir}/cwd test");
    std::fs::create_dir_all(&cwd_dir).unwrap();
    ssh::ssh_write(app.state(), "s2".into(), format!("cd '{cwd_dir}'\r")).unwrap();
    let mut seen = None;
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        seen = crate::session_cwd::ssh_session_pwd(app.state(), "s2".into()).await.unwrap();
        if seen.as_deref() == Some(cwd_dir.as_str()) {
            break;
        }
    }
    assert_eq!(seen.as_deref(), Some(cwd_dir.as_str()), "pwd probe");
    println!("[9] 交互 shell 当前目录探测 OK：{cwd_dir}");
    // 剪贴板图片：只在有 X 显示（如 xvfb-run）时测；放一张 2x1 的图进剪贴板，cwd 交给后端自己探测
    if std::env::var("DISPLAY").is_ok() {
        let mut cb = arboard::Clipboard::new().expect("clipboard");
        cb.set_image(arboard::ImageData { width: 2, height: 1, bytes: vec![255, 0, 0, 255, 0, 0, 255, 255].into() }).unwrap();
        let r = crate::session_cwd::ssh_upload_clipboard_image(app.state(), app.state(), "s2".into(), None).await.unwrap();
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["status"], "ok", "{v}");
        let remote = v["remotePath"].as_str().unwrap().to_string();
        assert!(remote.starts_with(&format!("{cwd_dir}/.netcatty-paste-images/netcatty-paste-")), "{remote}");
        assert_eq!(v["pastedPath"].as_str().unwrap(), format!("'{remote}'"), "带空格的路径要加引号");
        let png = std::fs::read(&remote).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        println!("[9] 剪贴板图片已上传：{remote}（{} 字节）", png.len());
        cb.clear().unwrap();
        let r = crate::session_cwd::ssh_upload_clipboard_image(app.state(), app.state(), "s2".into(), None).await.unwrap();
        assert_eq!(serde_json::to_value(&r).unwrap()["reason"], "no-image");
        println!("[9] 剪贴板没有图片 → no-image");
    } else {
        println!("[9] 没有 DISPLAY，跳过剪贴板图片上传");
    }

    /* 10. ZMODEM：远端 sz 发一个含全部 256 种字节的文件，本机 rz（lrzsz）当接收端。
     * 字节流走 ssh://zmodem（闸门切到原始模式，不经 GBK 解码），回程走 ssh_write_bytes；
     * 传完 ssh_zmodem_release 后普通输出照常按 GBK 解码。 */
    {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;
        let payload: Vec<u8> = (0..4096u32).map(|i| (i * 7 % 256) as u8).collect();
        std::fs::write(format!("{cwd_dir}/zm.bin"), &payload).unwrap();
        let recv_dir = format!("{dir}/zm-recv");
        let _ = std::fs::remove_dir_all(&recv_dir);
        std::fs::create_dir_all(&recv_dir).unwrap();
        let mut rz = tokio::process::Command::new("rz")
            .args(["-b", "-q"])
            .current_dir(&recv_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("本机需要 lrzsz 的 rz");
        let mut rz_in = rz.stdin.take().unwrap();
        let mut rz_out = rz.stdout.take().unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let encodings = Arc::new(Mutex::new(Vec::<String>::new()));
        let enc2 = encodings.clone();
        let id = app.listen_any("ssh://zmodem/s2", move |e| {
            let v: Value = serde_json::from_str(e.payload()).unwrap();
            enc2.lock().unwrap().push(v["encoding"].as_str().unwrap_or("").to_string());
            let bytes = base64::engine::general_purpose::STANDARD.decode(v["data"].as_str().unwrap()).unwrap();
            let _ = tx.send(bytes);
        });
        let feeder = tauri::async_runtime::spawn(async move {
            while let Some(b) = rx.recv().await {
                if rz_in.write_all(&b).await.is_err() {
                    break;
                }
                let _ = rz_in.flush().await;
            }
        });
        let app2 = app.clone();
        let pump = tauri::async_runtime::spawn(async move {
            let mut buf = vec![0u8; 8192];
            loop {
                match rz_out.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let st = app2.state::<SshState>();
                        if ssh::ssh_write_bytes(st, "s2".into(), b64.encode(&buf[..n])).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let before = data.lock().unwrap().len();
        ssh::ssh_write(app.state(), "s2".into(), "sz zm.bin\r".into()).unwrap();
        let status = tokio::time::timeout(Duration::from_secs(30), rz.wait()).await.expect("rz 超时").unwrap();
        assert!(status.success(), "rz 退出码 {status:?}");
        let _ = pump.await;
        app.unlisten(id);
        feeder.abort();
        let got = std::fs::read(format!("{recv_dir}/zm.bin")).expect("rz 没有收到文件");
        assert_eq!(got, payload, "ZMODEM 下载的字节与原文件不一致");
        assert!(encodings.lock().unwrap().iter().all(|e| e == "GBK"), "zmodem 事件应携带会话编码");
        // 闸门处于原始模式时，ZMODEM 帧不会漏进文本通道
        let leaked: String = data.lock().unwrap()[before..].concat();
        assert!(!leaked.contains("\u{18}B0"), "ZMODEM 帧混进了文本输出：{leaked:?}");
        ssh::ssh_zmodem_release(app.state(), "s2".into()).unwrap();
        ssh::ssh_drain(app.state(), "s2".into()).await.unwrap();
        ssh::ssh_write(app.state(), "s2".into(), "printf 'ZM_AFTER_\\304\\343\\n'\r".into()).unwrap();
        assert!(wait_for(&data, "ZM_AFTER_你", 10).await, "释放后 GBK 文本恢复：{:?}", data.lock().unwrap());
        println!("[10] ZMODEM sz → 本机 rz：{} 字节逐字节一致；释放后 GBK 解码恢复", got.len());
    }

    /* 10b. ZMODEM 上传：远端 rz，本机 sz 当发送端（回程走 ssh_write_bytes，原样二进制） */
    {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;
        let payload: Vec<u8> = (0..70_000u32).map(|i| (i * 13 % 256) as u8).collect();
        let send_dir = format!("{dir}/zm-send");
        std::fs::create_dir_all(&send_dir).unwrap();
        std::fs::write(format!("{send_dir}/zm-up.bin"), &payload).unwrap();
        let _ = std::fs::remove_file(format!("{cwd_dir}/zm-up.bin"));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let id = app.listen_any("ssh://zmodem/s2", move |e| {
            let v: Value = serde_json::from_str(e.payload()).unwrap();
            let _ = tx.send(base64::engine::general_purpose::STANDARD.decode(v["data"].as_str().unwrap()).unwrap());
        });
        ssh::ssh_write(app.state(), "s2".into(), "rz -y\r".into()).unwrap();
        // 等闸门认出远端 rz 的 ZRINIT 再起本机 sz，免得 ZRQINIT 落进 shell
        let first = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("没等到 ZRINIT").unwrap();
        assert!(first.windows(5).any(|w| w == b"**\x18B0"), "第一段 zmodem 数据应以起始头开头：{first:?}");
        let mut sz = tokio::process::Command::new("sz")
            .args(["-b", "-q", "zm-up.bin"])
            .current_dir(&send_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("本机需要 lrzsz 的 sz");
        let mut sz_in = sz.stdin.take().unwrap();
        let mut sz_out = sz.stdout.take().unwrap();
        sz_in.write_all(&first).await.unwrap();
        let feeder = tauri::async_runtime::spawn(async move {
            while let Some(b) = rx.recv().await {
                if sz_in.write_all(&b).await.is_err() {
                    break;
                }
                let _ = sz_in.flush().await;
            }
        });
        let app2 = app.clone();
        let pump = tauri::async_runtime::spawn(async move {
            let mut buf = vec![0u8; 8192];
            loop {
                match sz_out.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if ssh::ssh_write_bytes(app2.state::<SshState>(), "s2".into(), b64.encode(&buf[..n])).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let status = tokio::time::timeout(Duration::from_secs(30), sz.wait()).await.expect("sz 超时").unwrap();
        assert!(status.success(), "sz 退出码 {status:?}");
        let _ = pump.await;
        app.unlisten(id);
        feeder.abort();
        ssh::ssh_zmodem_release(app.state(), "s2".into()).unwrap();
        let mut got = Vec::new();
        for _ in 0..50 {
            got = std::fs::read(format!("{cwd_dir}/zm-up.bin")).unwrap_or_default();
            if got.len() == payload.len() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(got, payload, "ZMODEM 上传后远端文件不一致");
        ssh::ssh_write(app.state(), "s2".into(), "echo ZM_UP_DONE\r".into()).unwrap();
        assert!(wait_for(&data, "ZM_UP_DONE", 10).await);
        println!("[10b] ZMODEM 本机 sz → 远端 rz：{} 字节一致", got.len());
    }

    /* 11. 复制标签页到新窗口：建会话窗口、取载荷（只能取一次）、窗口销毁时断开它名下的会话 */
    if std::env::var("DISPLAY").is_ok() {
        use crate::app_window;
        let payload = json!({"tab": {"id": "tab-1", "hostId": "h1", "title": "prod"}, "panes": []});
        let opened = tokio::time::timeout(
            Duration::from_secs(10),
            app_window::window_open_session(app.clone(), app.state(), "prod".into(), payload.clone()),
        )
        .await;
        match opened {
            Ok(r) => {
                r.expect("window_open_session");
                let win = app.get_webview_window("session-1").expect("会话窗口 session-1");
                let got = app_window::window_take_session_payload(win.clone(), app.state()).unwrap();
                assert_eq!(got, Some(payload));
                assert_eq!(app_window::window_take_session_payload(win.clone(), app.state()).unwrap(), None);
                connect(&app, "s_win", 2222, cred(key_plain.clone()), None).await.expect("connect s_win");
                let win_exits = collect(&app, "ssh://exit/s_win");
                app_window::window_own_session(win.clone(), app.state(), serde_json::from_value(json!("ssh")).unwrap(), "s_win".into()).unwrap();
                // 测试里 App 只 build 不 run，没有事件循环派发 WindowEvent::Destroyed：
                // 直接调用 lib.rs 里挂在 Destroyed 上的同一个清理函数
                app_window::on_window_destroyed(&win.as_ref().window());
                let _ = win.destroy();
                assert!(wait_for(&win_exits, "", 10).await, "窗口销毁后其名下的 SSH 会话应被断开");
                println!("[11] 会话窗口：载荷一次性取走；窗口销毁后名下会话已断开");
            }
            Err(_) => println!("[11] 当前测试运行时没有事件循环，建窗口超时，跳过"),
        }
    }

    /* 12. SFTP 两个远程标签之间直接拷贝（Netcatty remote-to-remote）：s2 → 另一条会话 */
    {
        connect(&app, "s_cp", 2222, cred(key_plain.clone()), None).await.expect("connect s_cp");
        let src = format!("{dir}/r2r-src.bin");
        let dst = format!("{dir}/r2r-dst.bin");
        let _ = std::fs::remove_file(&dst);
        let payload: Vec<u8> = (0..300_000u32).map(|i| (i * 31 % 251) as u8).collect();
        std::fs::write(&src, &payload).unwrap();
        let mut copied = 0;
        for _ in 0..50 {
            match sftp::sftp_copy_between(app.state(), "s2".into(), src.clone(), "s_cp".into(), dst.clone()).await {
                Ok(n) => {
                    copied = n;
                    break;
                }
                Err(e) if e.contains("未就绪") => tokio::time::sleep(Duration::from_millis(100)).await,
                Err(e) => panic!("sftp_copy_between: {e}"),
            }
        }
        assert_eq!(copied, payload.len() as u64);
        assert_eq!(std::fs::read(&dst).unwrap(), payload);
        let again = sftp::sftp_copy_between(app.state(), "s2".into(), src.clone(), "s_cp".into(), dst.clone()).await;
        assert!(again.is_err(), "目标已存在时必须拒绝覆盖");
        assert_eq!(std::fs::read(&dst).unwrap(), payload, "拒绝后原目标不变");
        ssh::ssh_disconnect(app.state(), "s_cp".into()).unwrap();
        println!("[12] SFTP 远程 → 远程拷贝 {copied} 字节一致；目标已存在时拒绝");
    }

    /* 13. ProxyCommand（Netcatty proxy.type = command）：经 socat 子进程连到 2223。
     * 目标按「主机名:端口」校验主机密钥——ProxyCommand 不能绕过 known_hosts */
    {
        let pc = profile(json!({"proxy": {"type": "command", "command": "socat - TCP:127.0.0.1:%p"}}));
        // 每条代入后的命令首次运行前要用户在原生对话框里点「运行」；测试里没有对话框，按「已确认」登记
        for cmd in ["socat - TCP:127.0.0.1:%p", "sh -c 'echo nope >&2; exit 3'"] {
            let spec: crate::transport::ProxySpec = serde_json::from_value(json!({"type": "command", "command": cmd})).unwrap();
            let line = crate::transport::proxy_command_line(&spec, "pc-target", 2223).unwrap();
            crate::fs_guard::remember_confirmed(format!("proxy-command\u{0}{line}"));
        }
        let err = connect_host(&app, "s_pc", "pc-target", 2223, cred(key_plain.clone()), pc.clone()).await.unwrap_err();
        assert!(err.contains("host_unknown"), "ProxyCommand 目标也必须校验主机密钥：{err}");
        println!("[13] ProxyCommand 目标未信任被拒：{err}");
        ssh::ssh_trust_host(app.clone(), app.state(), "pc-target".into(), 2223, fp_of(&err)).unwrap();
        connect_host(&app, "s_pc", "pc-target", 2223, cred(key_plain.clone()), pc).await.expect("ProxyCommand connect");
        let out = ssh::ssh_exec(app.state(), "s_pc".into(), "echo via-proxycommand".into(), Some(5000)).await.unwrap();
        assert!(out.stdout.contains("via-proxycommand"));
        ssh::ssh_disconnect(app.state(), "s_pc".into()).unwrap();
        let bad = connect_host(&app, "s_pc2", "pc-target", 2223, cred(key_plain.clone()),
            profile(json!({"proxy": {"type": "command", "command": "sh -c 'echo nope >&2; exit 3'"}}))).await;
        assert!(bad.is_err());
        println!("[13] ProxyCommand 连接 OK；命令失败时报错：{}", bad.unwrap_err());
    }

    /* 14. 钥匙串（密钥库）里的私钥：导入后只凭 key_id 认证；私钥材料不出 Rust */
    {
        let text = std::fs::read_to_string(&plain).unwrap();
        match crate::key_vault::key_vault_import(app.clone(), "live-key".into(), Some(text), None, None, false).await {
            Ok(info) => {
                let c: Credential = serde_json::from_value(json!({"method": "stored_key", "key_id": "live-key"})).unwrap();
                connect(&app, "s_vault", 2222, c, None).await.expect("stored key connect");
                let out = ssh::ssh_exec(app.state(), "s_vault".into(), "echo via-vault".into(), Some(5000)).await.unwrap();
                assert!(out.stdout.contains("via-vault"));
                ssh::ssh_disconnect(app.state(), "s_vault".into()).unwrap();
                let vault_files: Vec<_> = walk_files(&cfg);
                for f in &vault_files {
                    let bytes = std::fs::read(f).unwrap_or_default();
                    assert!(!String::from_utf8_lossy(&bytes).contains("PRIVATE KEY"), "密钥库里不应有明文私钥：{f:?}");
                }
                crate::key_vault::key_vault_delete(app.clone(), "live-key".into()).await.unwrap();
                let c: Credential = serde_json::from_value(json!({"method": "stored_key", "key_id": "live-key"})).unwrap();
                assert!(connect(&app, "s_vault2", 2222, c, None).await.is_err(), "删除后不能再用");
                println!("[14] 钥匙串私钥认证 OK（{}），配置目录无明文私钥；删除后不可用", info.key_type);
            }
            Err(e) => println!("[14] 系统钥匙串不可用，跳过：{e}"),
        }
    }

    /* 8. 断开 */
    let exits = collect(&app, "ssh://exit/s2");
    ssh::ssh_disconnect(app.state(), "s2".into()).unwrap();
    assert!(wait_for(&exits, "", 5).await, "exit event after disconnect");
    assert!(ssh::ssh_write(app.state(), "s2".into(), "x".into()).is_err(), "session removed");
    println!("[8] 断开后会话已注销");
    println!("全部实测通过");
}
