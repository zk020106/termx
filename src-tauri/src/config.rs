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

    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("配置解析失败（{}）：{e}", path.display()))
}

/// 原子写：先落临时文件，再 rename 覆盖，避免半个文件
fn write_at(path: &Path, data: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建目录：{e}"))?;
    }

    let text = serde_json::to_string_pretty(data).map_err(|e| format!("序列化失败：{e}"))?;
    let tmp = path.with_extension("json.tmp");

    fs::write(&tmp, text.as_bytes()).map_err(|e| format!("写入临时文件失败：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("替换配置文件失败：{e}"))?;
    Ok(())
}

/// 读取配置；文件不存在或为空时返回 null（首次启动就是这种状态）
#[tauri::command]
pub fn config_load(app: AppHandle) -> Result<Option<Value>, String> {
    read_at(&config_file(&app)?)
}

/// 写入配置
#[tauri::command]
pub fn config_save(app: AppHandle, data: Value) -> Result<(), String> {
    write_at(&config_file(&app)?, &data)
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
    }
}
