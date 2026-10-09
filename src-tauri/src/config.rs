//! 配置持久化：把用户自己的数据（主机、分组、密钥、片段、转发规则）落在真实文件里。
//!
//! 位置：操作系统给应用分配的配置目录，Windows 上是
//! `%APPDATA%\dev.termx.app\termx.json`。
//!
//! 写入策略：先写同目录的临时文件再原子替换，避免写到一半（崩溃/断电）把配置损坏。
//! 这里刻意不做加密——凭据不进这个文件（密码与私钥口令交操作系统钥匙串），
//! 文件里只有主机地址、用户名、分组这类非敏感配置。

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const CONFIG_FILE: &str = "termx.json";

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建配置目录：{e}"))?;
    Ok(dir)
}

fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(CONFIG_FILE))
}

/// 读文件；不存在或为空都按「还没有配置」处理
fn read_at(path: &Path) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let text = fs::read_to_string(path).map_err(|e| format!("读取配置失败：{e}"))?;
    if text.trim().is_empty() {
        return Ok(None);
    }

    match serde_json::from_str(&text) {
        Ok(value) => Ok(Some(value)),
        Err(e) => {
            // 解析失败时先把原文件备份一份：之后的自动保存会写入新内容，
            // 不能让一次解析失败把用户原来的配置整个冲掉
            let backup = backup_corrupt(path);
            Err(match backup {
                Ok(b) => format!(
                    "{CORRUPT_PREFIX}{}\n配置解析失败（{}）：{e}。原文件已备份到 {}",
                    b.display(),
                    path.display(),
                    b.display()
                ),
                Err(be) => format!("配置解析失败（{}）：{e}。备份原文件也失败了：{be}", path.display()),
            })
        }
    }
}

/// 前端据此判断「已备份、可以继续使用」
pub const CORRUPT_PREFIX: &str = "CORRUPT_BACKED_UP:";

fn backup_corrupt(path: &Path) -> Result<PathBuf, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| CONFIG_FILE.to_string());
    let backup = path.with_file_name(format!("{name}.corrupt-{ts}"));
    fs::copy(path, &backup).map_err(|e| e.to_string())?;
    Ok(backup)
}

/// 兜底：落盘前剥掉主机里的明文密码与代理口令（它们只能在系统钥匙串里）。
/// 前端已经剥过一次；这里再做一次，保证任何调用方（含被注入的脚本）都没法让明文落盘。
fn strip_secrets(data: &mut Value) -> usize {
    let mut removed = 0;
    if let Some(hosts) = data.get_mut("hosts").and_then(Value::as_array_mut) {
        for host in hosts {
            for field in ["auth", "proxy"] {
                if let Some(obj) = host.get_mut(field).and_then(Value::as_object_mut) {
                    if obj.remove("password").is_some() {
                        removed += 1;
                    }
                }
            }
        }
    }
    // 代理配置（Netcatty proxyProfiles）的口令同样只进钥匙串
    if let Some(profiles) = data.get_mut("proxyProfiles").and_then(Value::as_array_mut) {
        for profile in profiles {
            if let Some(obj) = profile.get_mut("config").and_then(Value::as_object_mut) {
                if obj.remove("password").is_some() {
                    removed += 1;
                }
            }
        }
    }
    // 身份（Netcatty identities）与分组设置（groupConfigs）的密码同样只进钥匙串
    for list in ["identities", "groupConfigs"] {
        if let Some(items) = data.get_mut(list).and_then(Value::as_array_mut) {
            for item in items {
                if let Some(obj) = item.as_object_mut() {
                    if obj.remove("password").is_some() {
                        removed += 1;
                    }
                    if let Some(proxy) = obj.get_mut("proxyConfig").and_then(Value::as_object_mut) {
                        if proxy.remove("password").is_some() {
                            removed += 1;
                        }
                    }
                }
            }
        }
    }
    removed
}

/// 原子写：先落临时文件，再 rename 覆盖，避免半个文件。
/// Unix 上文件权限收紧为 0600（只有本人可读写）：里面虽然没有密码，但有主机地址与用户名。
fn write_at(path: &Path, data: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建目录：{e}"))?;
    }

    let text = serde_json::to_string_pretty(data).map_err(|e| format!("序列化失败：{e}"))?;
    let tmp = path.with_extension("json.tmp");

    write_private(&tmp, text.as_bytes()).map_err(|e| format!("写入临时文件失败：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("替换配置文件失败：{e}"))?;
    Ok(())
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    // 已存在的临时文件不受 mode 影响，显式收紧一次
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    fs::write(path, bytes)
}

/// 读取配置；文件不存在或为空时返回 null（首次启动就是这种状态）。
/// 文件 IO 放到阻塞线程池：同步命令跑在主线程上，慢盘 / 网络盘会冻住界面。
#[tauri::command]
pub async fn config_load(app: AppHandle) -> Result<Option<Value>, String> {
    let path = config_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_at(&path))
        .await
        .map_err(|e| format!("读取配置失败：{e}"))?
}

/// 写入配置（明文密码一律剥掉）
#[tauri::command]
pub async fn config_save(app: AppHandle, webview: tauri::Webview, mut data: Value) -> Result<(), String> {
    let path = config_file(&app)?;
    strip_secrets(&mut data);
    tauri::async_runtime::spawn_blocking(move || write_at(&path, &data))
        .await
        .map_err(|e| format!("写入配置失败：{e}"))??;
    // 多窗口：通知其它窗口重新载入（载荷只有来源窗口标签，不带配置内容）
    use tauri::Emitter;
    let _ = app.emit("config://changed", webview.label());
    Ok(())
}

/// 配置文件在磁盘上的真实路径，供设置页展示（不再写死的示例路径）
#[tauri::command]
pub fn config_location(app: AppHandle) -> Result<String, String> {
    Ok(config_file(&app)?.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_path(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("termx-config-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn missing_file_reads_as_none() {
        let path = temp_path("missing.json");
        let _ = fs::remove_file(&path);
        assert!(read_at(&path).unwrap().is_none());
    }

    #[test]
    fn write_then_read_round_trips() {
        let path = temp_path("round-trip.json");
        let _ = fs::remove_file(&path);

        let data = json!({
            "version": 1,
            "hosts": [{ "id": "h1", "name": "本机", "hostname": "127.0.0.1", "port": 22 }],
            "groups": [],
            "keys": [],
            "snippets": [],
            "forwards": []
        });

        write_at(&path, &data).unwrap();
        let read = read_at(&path).unwrap().unwrap();

        assert_eq!(read["hosts"][0]["name"], "本机");
        assert_eq!(read["version"], 1);

        // 临时文件必须已经被 rename 掉，不能在目录里留垃圾
        let leftover = path.with_extension("json.tmp");
        assert!(!leftover.exists(), "原子写入后不应残留临时文件");
    }

    #[test]
    fn overwrite_replaces_previous_content() {
        let path = temp_path("overwrite.json");
        let _ = fs::remove_file(&path);

        write_at(&path, &json!({ "version": 1, "hosts": [{ "id": "a" }] })).unwrap();
        write_at(&path, &json!({ "version": 1, "hosts": [{ "id": "b" }] })).unwrap();

        let read = read_at(&path).unwrap().unwrap();
        assert_eq!(read["hosts"].as_array().unwrap().len(), 1);
        assert_eq!(read["hosts"][0]["id"], "b");
    }

    #[test]
    fn secrets_are_stripped_before_write() {
        let mut data = json!({
            "version": 1,
            "hosts": [
                { "id": "a", "auth": { "method": "password", "rememberPassword": true, "password": "hunter2" },
                  "proxy": { "type": "socks5", "host": "p", "port": 1080, "username": "pu", "password": "pp" } },
                { "id": "b", "auth": { "method": "key" }, "proxy": null }
            ]
        });
        assert_eq!(strip_secrets(&mut data), 2);
        let text = data.to_string();
        assert!(!text.contains("hunter2") && !text.contains("\"pp\""), "{text}");
        assert_eq!(data["hosts"][0]["auth"]["rememberPassword"], true);
        assert_eq!(data["hosts"][0]["proxy"]["username"], "pu");
    }

    #[test]
    fn proxy_profile_passwords_are_stripped_before_write() {
        let mut data = json!({
            "version": 1,
            "hosts": [],
            "proxyProfiles": [
                { "id": "p1", "label": "corp", "config": { "type": "http", "host": "p", "port": 8080, "username": "u", "password": "secretpp" } },
                { "id": "p2", "label": "plain", "config": { "type": "socks5", "host": "q", "port": 1080 } }
            ]
        });
        assert_eq!(strip_secrets(&mut data), 1);
        let text = data.to_string();
        assert!(!text.contains("secretpp"), "{text}");
        assert_eq!(data["proxyProfiles"][0]["config"]["username"], "u");
    }

    #[cfg(unix)]
    #[test]
    fn identity_and_group_passwords_are_stripped_before_write() {
        let mut data = serde_json::json!({
            "identities": [{"id": "i", "username": "u", "password": "p"}],
            "groupConfigs": [{"groupId": "g", "password": "p", "proxyConfig": {"type": "socks5", "password": "x"}}]
        });
        assert_eq!(strip_secrets(&mut data), 3);
        let text = data.to_string();
        assert!(!text.contains("password"), "{text}");
    }

    #[test]
    fn config_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_path("private.json");
        let _ = fs::remove_file(&path);
        write_at(&path, &json!({ "version": 1 })).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn empty_file_reads_as_none() {
        let path = temp_path("empty.json");
        fs::write(&path, b"   \n").unwrap();
        assert!(read_at(&path).unwrap().is_none());
    }

    #[test]
    fn malformed_file_reports_error_instead_of_panicking() {
        let path = temp_path("broken.json");
        fs::write(&path, b"{ not json").unwrap();
        let error = read_at(&path).unwrap_err();
        assert!(error.contains("配置解析失败"));
        // 原文件被备份，内容原样保留
        assert!(error.starts_with(CORRUPT_PREFIX), "{error}");
        let backup = error[CORRUPT_PREFIX.len()..].lines().next().unwrap().to_string();
        assert_eq!(fs::read(&backup).unwrap(), b"{ not json");
        assert!(path.exists(), "原文件不动");
        let _ = fs::remove_file(backup);
    }
}
