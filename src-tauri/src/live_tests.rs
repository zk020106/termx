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
    let phases = collect(app, &format!("ssh://state/{key}"));
    ssh::ssh_connect(
        app.clone(),
        app.state(),
        app.state(),
        key.into(),
        "127.0.0.1".into(),
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

    /* 8. 断开 */
    let exits = collect(&app, "ssh://exit/s2");
    ssh::ssh_disconnect(app.state(), "s2".into()).unwrap();
    assert!(wait_for(&exits, "", 5).await, "exit event after disconnect");
    assert!(ssh::ssh_write(app.state(), "s2".into(), "x".into()).is_err(), "session removed");
    println!("[8] 断开后会话已注销");
    println!("全部实测通过");
}
