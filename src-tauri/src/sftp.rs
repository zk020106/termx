//! SFTP 远程与本地文件管理子系统（基于 russh-sftp）

use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime: u64,
    pub permissions: u32,
    pub permissions_str: String,
    pub owner: Option<String>,
    pub group: Option<String>,
}

#[derive(Default, Clone)]
pub struct SftpState {
    sessions: Arc<AsyncMutex<HashMap<String, Arc<SftpSession>>>>,
}

impl SftpState {
    pub async fn register_sftp(&self, key: String, sftp: Arc<SftpSession>) {
        let mut map = self.sessions.lock().await;
        map.insert(key, sftp);
    }

    pub async fn unregister_sftp(&self, key: &str) {
        let mut map = self.sessions.lock().await;
        map.remove(key);
    }

    pub async fn get_sftp(&self, key: &str) -> Result<Arc<SftpSession>, String> {
        let map = self.sessions.lock().await;
        map.get(key)
            .cloned()
            .ok_or_else(|| format!("会话「{key}」未连接或未就绪（SFTP 未挂载）"))
    }
}

fn format_permissions(is_dir: bool, is_symlink: bool, mode: u32) -> String {
    let type_char = if is_dir { 'd' } else if is_symlink { 'l' } else { '-' };
    let p = |val: u32, r: char, w: char, x: char| {
        format!(
            "{}{}{}",
            if val & 4 != 0 { r } else { '-' },
            if val & 2 != 0 { w } else { '-' },
            if val & 1 != 0 { x } else { '-' }
        )
    };
    format!(
        "{}{}{}{}",
        type_char,
        p((mode >> 6) & 7, 'r', 'w', 'x'),
        p((mode >> 3) & 7, 'r', 'w', 'x'),
        p(mode & 7, 'r', 'w', 'x')
    )
}

/* ------------------------------- 远端 SFTP 命令 ------------------------------- */

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, SftpState>,
    key: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let sftp = state.get_sftp(&key).await?;
    let target_path = if path.trim().is_empty() || path == "~" {
        sftp.canonicalize(".").await.unwrap_or_else(|_| "/".to_string())
    } else {
        path.clone()
    };
    let dir = sftp
        .read_dir(&target_path)
        .await
        .map_err(|e| format!("读取远程目录失败 ({target_path}): {e}"))?;
    let mut entries = Vec::new();
    for item in dir {
        let name = item.file_name();
        let meta = item.metadata();
        let is_dir = meta.is_dir();
        let is_symlink = meta.is_symlink();
        let size = meta.size.unwrap_or(0);
        let mtime = meta.mtime.unwrap_or(0) as u64;
        let permissions = meta.permissions.unwrap_or(0);
        let permissions_str = format_permissions(is_dir, is_symlink, permissions);
        let full_path = item.path();
        entries.push(FileEntry {
            name,
            path: full_path,
            is_dir,
            is_symlink,
            size,
            mtime,
            permissions,
            permissions_str,
            owner: meta.user,
            group: meta.group,
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

#[tauri::command]
pub async fn sftp_realpath(
    state: State<'_, SftpState>,
    key: String,
    path: String,
) -> Result<String, String> {
    let sftp = state.get_sftp(&key).await?;
    let target = if path.trim().is_empty() { "." } else { &path };
    sftp.canonicalize(target).await.map_err(|e| format!("解析绝对路径失败: {e}"))
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, SftpState>,
    key: String,
    path: String,
) -> Result<(), String> {
    let sftp = state.get_sftp(&key).await?;
    sftp.create_dir(path).await.map_err(|e| format!("创建远程目录失败: {e}"))
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, SftpState>,
    key: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let sftp = state.get_sftp(&key).await?;
    if is_dir {
        sftp.remove_dir(path).await.map_err(|e| format!("删除远程目录失败: {e}"))
    } else {
        sftp.remove_file(path).await.map_err(|e| format!("删除远程文件失败: {e}"))
    }
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SftpState>,
    key: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let sftp = state.get_sftp(&key).await?;
    sftp.rename(old_path, new_path).await.map_err(|e| format!("重命名远程项失败: {e}"))
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, SftpState>,
    key: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let sftp = state.get_sftp(&key).await?;
    let mut attrs = russh_sftp::protocol::FileAttributes::default();
    attrs.permissions = Some(mode);
    sftp.set_metadata(&path, attrs).await.map_err(|e| format!("修改远程文件权限失败: {e}"))
}

#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, SftpState>,
    key: String,
    path: String,
) -> Result<String, String> {
    let sftp = state.get_sftp(&key).await?;
    let bytes = sftp.read(path).await.map_err(|e| format!("读取远程文件失败: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("文件非 UTF-8 文本: {e}"))
}

#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, SftpState>,
    key: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let sftp = state.get_sftp(&key).await?;
    sftp.write(path, content.as_bytes()).await.map_err(|e| format!("保存远程文件失败: {e}"))
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, SftpState>,
    key: String,
    local_path: String,
    remote_path: String,
) -> Result<u64, String> {
    let sftp = state.get_sftp(&key).await?;
    let data = tokio::fs::read(&local_path).await.map_err(|e| format!("读取本地文件失败: {e}"))?;
    let size = data.len() as u64;
    sftp.write(remote_path, &data).await.map_err(|e| format!("写入远程文件失败: {e}"))?;
    Ok(size)
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, SftpState>,
    key: String,
    remote_path: String,
    local_path: String,
) -> Result<u64, String> {
    let sftp = state.get_sftp(&key).await?;
    let data = sftp.read(remote_path).await.map_err(|e| format!("读取远程文件失败: {e}"))?;
    let size = data.len() as u64;
    tokio::fs::write(&local_path, &data).await.map_err(|e| format!("写入本地文件失败: {e}"))?;
    Ok(size)
}

/* ------------------------------- 本地文件命令 ------------------------------- */

#[tauri::command]
pub async fn fs_local_list(path: String) -> Result<Vec<FileEntry>, String> {
    let target = if path.trim().is_empty() || path == "~" {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
    } else {
        PathBuf::from(path)
    };

    let mut reader = tokio::fs::read_dir(&target)
        .await
        .map_err(|e| format!("读取本地目录「{}」失败: {e}", target.display()))?;

    let mut entries = Vec::new();
    while let Some(item) = reader.next_entry().await.map_err(|e| format!("读取文件项失败: {e}"))? {
        let name = item.file_name().to_string_lossy().to_string();
        let meta = item.metadata().await.ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let is_symlink = meta.as_ref().map(|m| m.is_symlink()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let p_str = if is_dir { "drwxr-xr-x".to_string() } else { "-rw-r--r--".to_string() };
        entries.push(FileEntry {
            name,
            path: item.path().to_string_lossy().to_string(),
            is_dir,
            is_symlink,
            size,
            mtime,
            permissions: 0,
            permissions_str: p_str,
            owner: None,
            group: None,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
pub fn fs_local_home() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "无法获取本地主目录".to_string())
}

#[tauri::command]
pub fn fs_local_drives() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        let mut drives = Vec::new();
        for b in b'C'..=b'Z' {
            let drive = format!("{}:\\", b as char);
            if std::path::Path::new(&drive).exists() {
                drives.push(drive);
            }
        }
        if drives.is_empty() {
            drives.push("C:\\".to_string());
        }
        Ok(drives)
    }
    #[cfg(not(windows))]
    {
        Ok(vec!["/".to_string()])
    }
}

#[tauri::command]
pub async fn fs_local_mkdir(path: String) -> Result<(), String> {
    tokio::fs::create_dir_all(path).await.map_err(|e| format!("创建本地目录失败: {e}"))
}

#[tauri::command]
pub async fn fs_local_remove(path: String, is_dir: bool) -> Result<(), String> {
    if is_dir {
        tokio::fs::remove_dir_all(path).await.map_err(|e| format!("删除本地目录失败: {e}"))
    } else {
        tokio::fs::remove_file(path).await.map_err(|e| format!("删除本地文件失败: {e}"))
    }
}

#[tauri::command]
pub async fn fs_local_rename(old_path: String, new_path: String) -> Result<(), String> {
    tokio::fs::rename(old_path, new_path).await.map_err(|e| format!("重命名本地项失败: {e}"))
}

#[tauri::command]
pub async fn fs_local_read_file(path: String) -> Result<String, String> {
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("读取本地文件失败: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("本地文件非 UTF-8 文本: {e}"))
}

#[tauri::command]
pub async fn fs_local_write_file(path: String, content: String) -> Result<(), String> {
    tokio::fs::write(&path, content.as_bytes()).await.map_err(|e| format!("写入本地文件失败: {e}"))
}

