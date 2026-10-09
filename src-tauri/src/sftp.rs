//! SFTP 远程与本地文件管理子系统（基于 russh-sftp）

use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::fs_guard::{checked_local_path, confirm_read, confirm_write};
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
        // 与本地删除一致：目录连同内容一起删（符号链接只删链接本身，不跟进去）
        remove_remote_tree(&sftp, &path).await
    } else {
        sftp.remove_file(path).await.map_err(|e| format!("删除远程文件失败: {e}"))
    }
}

/// 递归删除远端目录。逐层删，任何一项失败就停下并说明是哪一项。
pub async fn remove_remote_tree(sftp: &SftpSession, root: &str) -> Result<(), String> {
    let mut stack: Vec<(String, bool)> = vec![(root.to_string(), false)];
    while let Some((dir, expanded)) = stack.pop() {
        if expanded {
            sftp.remove_dir(dir.clone())
                .await
                .map_err(|e| format!("删除远程目录失败 ({dir}): {e}"))?;
            continue;
        }
        stack.push((dir.clone(), true));
        let items = sftp
            .read_dir(dir.clone())
            .await
            .map_err(|e| format!("读取远程目录失败 ({dir}): {e}"))?;
        for item in items {
            let name = item.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = format!("{}/{}", dir.trim_end_matches('/'), name);
            let meta = item.metadata();
            if meta.is_dir() && !meta.is_symlink() {
                stack.push((child, false));
            } else {
                sftp.remove_file(child.clone())
                    .await
                    .map_err(|e| format!("删除远程文件失败 ({child}): {e}"))?;
            }
        }
    }
    Ok(())
}

/// 文件当前状态（编辑器保存前的冲突检查用）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
}

#[tauri::command]
pub async fn sftp_stat(state: State<'_, SftpState>, key: String, path: String) -> Result<FileStat, String> {
    let sftp = state.get_sftp(&key).await?;
    Ok(match sftp.metadata(path).await {
        Ok(m) => FileStat {
            exists: true,
            is_dir: m.is_dir(),
            size: m.size.unwrap_or(0),
            mtime: m.mtime.unwrap_or(0) as u64,
        },
        Err(_) => FileStat { exists: false, is_dir: false, size: 0, mtime: 0 },
    })
}

#[tauri::command]
pub async fn fs_local_stat(path: String) -> Result<FileStat, String> {
    let path = checked_local_path(&path)?;
    Ok(match tokio::fs::metadata(&path).await {
        Ok(m) => FileStat {
            exists: true,
            is_dir: m.is_dir(),
            size: m.len(),
            mtime: m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
        },
        Err(_) => FileStat { exists: false, is_dir: false, size: 0, mtime: 0 },
    })
}

/// 保存前的冲突前缀：前端据此弹「文件已被修改」确认
pub const CONFLICT_PREFIX: &str = "CONFLICT:";

fn tmp_name(path: &str) -> String {
    let (dir, name) = match path.rfind(['/', '\\']) {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    };
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{dir}.{name}.termx-save-{}-{nonce:x}", std::process::id())
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
    let attrs = russh_sftp::protocol::FileAttributes {
        permissions: Some(mode),
        ..Default::default()
    };
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
    expected_mtime: Option<u64>,
) -> Result<u64, String> {
    use tokio::io::AsyncWriteExt;
    let sftp = state.get_sftp(&key).await?;
    let current = sftp.metadata(path.clone()).await.ok();
    if let (Some(expected), Some(meta)) = (expected_mtime, current.as_ref()) {
        let now = meta.mtime.unwrap_or(0) as u64;
        if expected != 0 && now != expected {
            return Err(format!("{CONFLICT_PREFIX}{now}"));
        }
    }
    // 原子保存：写临时文件 → 沿用原文件权限 → 换名。写到一半断线也不会把原文件写坏
    let tmp = tmp_name(&path);
    let mut file = sftp
        .create(tmp.clone())
        .await
        .map_err(|e| format!("保存远程文件失败（无法创建临时文件）: {e}"))?;
    let written = async {
        file.write_all(content.as_bytes()).await?;
        file.shutdown().await
    }
    .await;
    if let Err(e) = written {
        let _ = sftp.remove_file(tmp.clone()).await;
        return Err(format!("保存远程文件失败: {e}"));
    }
    if let Some(perm) = current.as_ref().and_then(|m| m.permissions) {
        let attrs = russh_sftp::protocol::FileAttributes {
            permissions: Some(perm & 0o7777),
            ..Default::default()
        };
        let _ = sftp.set_metadata(tmp.clone(), attrs).await;
    }
    if let Err(e) = crate::transfer::remote_replace(&sftp, &tmp, &path).await {
        let _ = sftp.remove_file(tmp).await;
        return Err(format!("保存远程文件失败: {e}"));
    }
    Ok(sftp
        .metadata(path)
        .await
        .ok()
        .and_then(|m| m.mtime)
        .unwrap_or(0) as u64)
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, SftpState>,
    key: String,
    local_path: String,
    remote_path: String,
) -> Result<u64, String> {
    let local_path = checked_local_path(&local_path)?;
    confirm_read(&app, &local_path, "上传").await?;
    // 流式：不把整个文件读进内存（带进度 / 续传 / 校验的版本见 transfer_start）
    let sftp = state.get_sftp(&key).await?;
    let mut src = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("读取本地文件失败: {e}"))?;
    let mut dst = sftp
        .create(remote_path)
        .await
        .map_err(|e| format!("写入远程文件失败: {e}"))?;
    let size = tokio::io::copy(&mut src, &mut dst)
        .await
        .map_err(|e| format!("写入远程文件失败: {e}"))?;
    tokio::io::AsyncWriteExt::shutdown(&mut dst)
        .await
        .map_err(|e| format!("写入远程文件失败: {e}"))?;
    Ok(size)
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, SftpState>,
    key: String,
    remote_path: String,
    local_path: String,
) -> Result<u64, String> {
    // 目标路径由前端拼接（目录 + 远程文件名），远程文件名不可信：必须是绝对路径、不含 `..`、
    // 不落在受保护位置，且不能是已存在的目录
    let local_path = checked_local_path(&local_path)?;
    confirm_write(&app, &local_path, "下载写入").await?;
    if tokio::fs::metadata(&local_path).await.map(|m| m.is_dir()).unwrap_or(false) {
        return Err(format!("下载目标「{}」是一个目录", local_path.display()));
    }
    let sftp = state.get_sftp(&key).await?;
    let mut src = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("读取远程文件失败: {e}"))?;
    let mut dst = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| format!("写入本地文件失败: {e}"))?;
    let size = tokio::io::copy(&mut src, &mut dst)
        .await
        .map_err(|e| format!("写入本地文件失败: {e}"))?;
    dst.sync_all().await.map_err(|e| format!("写入本地文件失败: {e}"))?;
    Ok(size)
}

/* ------------------------------- 本地文件命令 ------------------------------- */

#[tauri::command]
pub async fn fs_local_list(path: String) -> Result<Vec<FileEntry>, String> {
    let target = if path.trim().is_empty() || path == "~" {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
    } else {
        checked_local_path(&path)?
    };

    let mut reader = tokio::fs::read_dir(&target)
        .await
        .map_err(|e| format!("读取本地目录「{}」失败: {e}", target.display()))?;

    let mut entries = Vec::new();
    while let Some(item) = reader.next_entry().await.map_err(|e| format!("读取文件项失败: {e}"))? {
        let name = item.file_name().to_string_lossy().to_string();
        // 链接本身的信息决定「是不是链接」；目录/大小跟随链接指向的真实对象
        let link_meta = item.metadata().await.ok();
        let is_symlink = link_meta.as_ref().map(|m| m.is_symlink()).unwrap_or(false);
        let meta = if is_symlink {
            tokio::fs::metadata(item.path()).await.ok().or(link_meta)
        } else {
            link_meta
        };
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let permissions = meta.as_ref().map(local_mode).unwrap_or(0);
        let p_str = format_permissions(is_dir, is_symlink && !is_dir, permissions);
        entries.push(FileEntry {
            name,
            path: item.path().to_string_lossy().to_string(),
            is_dir,
            is_symlink,
            size,
            mtime,
            permissions,
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

/// 本地文件的真实权限位：Unix 取 mode；Windows 只有「只读」这一位可言
fn local_mode(meta: &std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o7777
    }
    #[cfg(not(unix))]
    {
        let base = if meta.is_dir() { 0o755 } else { 0o644 };
        if meta.permissions().readonly() {
            base & !0o222
        } else {
            base
        }
    }
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
pub async fn fs_local_mkdir(app: AppHandle, path: String) -> Result<(), String> {
    let path = checked_local_path(&path)?;
    confirm_write(&app, &path, "创建目录").await?;
    tokio::fs::create_dir_all(path).await.map_err(|e| format!("创建本地目录失败: {e}"))
}

#[tauri::command]
pub async fn fs_local_remove(app: AppHandle, path: String, is_dir: bool) -> Result<(), String> {
    let path = checked_local_path(&path)?;
    confirm_write(&app, &path, "删除").await?;
    let is_link = tokio::fs::symlink_metadata(&path)
        .await
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if is_link {
        // 符号链接只删链接本身，绝不顺着链接递归删目标
        return match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(_) => tokio::fs::remove_dir(&path).await.map_err(|e| format!("删除符号链接失败: {e}")),
        };
    }
    if is_dir {
        tokio::fs::remove_dir_all(path).await.map_err(|e| format!("删除本地目录失败: {e}"))
    } else {
        tokio::fs::remove_file(path).await.map_err(|e| format!("删除本地文件失败: {e}"))
    }
}

#[tauri::command]
pub async fn fs_local_rename(app: AppHandle, old_path: String, new_path: String) -> Result<(), String> {
    let old_path = checked_local_path(&old_path)?;
    let new_path = checked_local_path(&new_path)?;
    confirm_write(&app, &old_path, "移动").await?;
    confirm_write(&app, &new_path, "写入").await?;
    tokio::fs::rename(old_path, new_path).await.map_err(|e| format!("重命名本地项失败: {e}"))
}

#[tauri::command]
pub async fn fs_local_read_file(app: AppHandle, path: String) -> Result<String, String> {
    let path = checked_local_path(&path)?;
    confirm_read(&app, &path, "读取").await?;
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("读取本地文件失败: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("本地文件非 UTF-8 文本: {e}"))
}

#[tauri::command]
pub async fn fs_local_write_file(
    app: AppHandle,
    path: String,
    content: String,
    expected_mtime: Option<u64>,
) -> Result<u64, String> {
    confirm_write(&app, &checked_local_path(&path)?, "写入").await?;
    local_write_atomic(path, content, expected_mtime).await
}

/// 原子写本地文件（带修改时间冲突检测）；路径检查由调用方负责
async fn local_write_atomic(path: String, content: String, expected_mtime: Option<u64>) -> Result<u64, String> {
    let current = fs_local_stat(path.clone()).await?;
    if let Some(expected) = expected_mtime {
        if expected != 0 && current.exists && current.mtime != expected {
            return Err(format!("{CONFLICT_PREFIX}{}", current.mtime));
        }
    }
    let tmp = tmp_name(&path);
    let write = async {
        use tokio::io::AsyncWriteExt;
        let mut f = tokio::fs::File::create(&tmp).await?;
        f.write_all(content.as_bytes()).await?;
        f.sync_all().await?;
        if current.exists {
            if let Ok(meta) = tokio::fs::metadata(&path).await {
                let _ = tokio::fs::set_permissions(&tmp, meta.permissions()).await;
            }
        }
        // 同目录内换名：Unix 上原子替换；Windows 上 MoveFileEx(REPLACE_EXISTING)
        tokio::fs::rename(&tmp, &path).await
    }
    .await;
    if let Err(e) = write {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("写入本地文件失败: {e}"));
    }
    Ok(fs_local_stat(path).await.map(|s| s.mtime).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmp_name_stays_in_same_directory() {
        let t = tmp_name("/etc/nginx/nginx.conf");
        assert!(t.starts_with("/etc/nginx/.nginx.conf.termx-save-"), "{t}");
        let w = tmp_name("C:\\Users\\a\\x.txt");
        assert!(w.starts_with("C:\\Users\\a\\.x.txt.termx-save-"), "{w}");
        assert!(tmp_name("plain").starts_with(".plain.termx-save-"));
    }

    #[tokio::test]
    async fn local_atomic_save_and_conflict() {
        let dir = std::env::temp_dir().join(format!("termx-save-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let file = dir.join("a.txt").to_string_lossy().to_string();
        let m1 = local_write_atomic(file.clone(), "one".into(), None).await.unwrap();
        assert_eq!(tokio::fs::read_to_string(&file).await.unwrap(), "one");
        // 期望的 mtime 对不上：报冲突，文件不动
        let err = local_write_atomic(file.clone(), "two".into(), Some(m1 + 100)).await.unwrap_err();
        assert!(err.starts_with(CONFLICT_PREFIX), "{err}");
        assert_eq!(tokio::fs::read_to_string(&file).await.unwrap(), "one");
        local_write_atomic(file.clone(), "two".into(), Some(m1)).await.unwrap();
        assert_eq!(tokio::fs::read_to_string(&file).await.unwrap(), "two");
        // 没有遗留临时文件
        let mut rd = tokio::fs::read_dir(&dir).await.unwrap();
        let mut names = vec![];
        while let Some(e) = rd.next_entry().await.unwrap() {
            names.push(e.file_name().to_string_lossy().to_string());
        }
        assert_eq!(names, vec!["a.txt".to_string()]);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[test]
    fn permission_text() {
        assert_eq!(format_permissions(true, false, 0o755), "drwxr-xr-x");
        assert_eq!(format_permissions(false, true, 0o777), "lrwxrwxrwx");
        assert_eq!(format_permissions(false, false, 0o600), "-rw-------");
    }
}

