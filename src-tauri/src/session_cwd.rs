//! 终端当前目录（cwd）与「上传剪贴板图片」。
//!
//! - `ssh_session_pwd`：移植 Netcatty sshBridge/sessionOps.cjs 的 getSessionPwd。
//!   在**同一条 SSH 连接**上另开一个 exec 通道（终端里什么都不显示），找到这条连接上的交互 shell
//!   （$PPID 的兄弟进程；老 OpenSSH 按 SSH_CONNECTION 找），沿前台进程组找到最深的 shell（跟进 su / sudo），
//!   读它的 /proc/<pid>/cwd（没有 /proc 时用 lsof）；读不到时退回登录 shell 的 cwd，再退回家目录。
//!   前端优先用 OSC 7 上报的目录，没有时才来问这里。
//! - `ssh_upload_clipboard_image`：移植 Netcatty clipboardImagePaste.ts + clipboardFiles.cjs：
//!   读系统剪贴板里的图片（Electron clipboard.readImage → 这里用 arboard），编码成 PNG，
//!   经本会话的 SFTP 写到 `<cwd>/.netcatty-paste-images/netcatty-paste-<时间>.png`，
//!   返回远端路径与按 shell 规则加引号后的路径，由前端键入终端。

use crate::sftp::SftpState;
use crate::ssh::SshState;
use serde::Serialize;
use std::time::Duration;
use tauri::State;

const REMOTE_CLIPBOARD_IMAGE_DIR: &str = ".netcatty-paste-images";

/// Netcatty getSessionPwd 的 POSIX 脚本（ALLOW_HOME_FALLBACK=1、ALLOW_LOGIN_FALLBACK=1）
const PWD_SCRIPT: &str = r#"SELF=$$
TARGET_LOGIN=
ALLOW_HOME_FALLBACK=1
ALLOW_LOGIN_FALLBACK=1
find_login_shell() {
  _shell=$(ps -e -o pid=,ppid=,tty=,comm= 2>/dev/null | awk -v pp="$1" -v self="$SELF" '
    function isshell(c) { sub(/^.*\//, "", c); sub(/^-/, "", c); return c ~ /^(ba|z|fi|k|da|a|c|tc)?sh$/ }
    $1 != self && $2 == pp && isshell($4) {
      if ($3 !~ /^\?+$/) { print $1; found=1; exit }
      if (any == "") any=$1
    }
    END { if (!found && any != "") print any }
  ')
  [ -n "$_shell" ] && { echo "$_shell"; return; }
  _conn=$(tr '\0' '\n' < /proc/$SELF/environ 2>/dev/null | sed -n 's/^SSH_CONNECTION=//p' | head -n1)
  [ -z "$_conn" ] && return
  _any=""
  for _d in /proc/[0-9]*; do
    _pid=$(basename "$_d")
    [ "$_pid" = "$SELF" ] && continue
    [ -r "$_d/environ" ] || continue
    _conn2=$(tr '\0' '\n' < "$_d/environ" 2>/dev/null | sed -n 's/^SSH_CONNECTION=//p' | head -n1)
    [ "$_conn2" = "$_conn" ] || continue
    _comm=$(cat "$_d/comm" 2>/dev/null)
    case "$_comm" in
      sh|bash|zsh|fish|ksh|dash|ash|csh|tcsh) ;;
      *) continue ;;
    esac
    _tty=$(ps -p "$_pid" -o tty= 2>/dev/null | tr -d '[:space:]')
    if [ "$_tty" != "?" ] && [ -n "$_tty" ]; then
      echo "$_pid"
      return
    fi
    [ -z "$_any" ] && _any="$_pid"
  done
  [ -n "$_any" ] && echo "$_any"
}
find_active_shell() {
  ps -e -o pid=,ppid=,stat=,comm= 2>/dev/null | awk -v start="$1" '
    { pp[$1]=$2; st[$1]=$3; cm[$1]=$4; ord[NR]=$1 }
    function isshell(c) { sub(/^.*\//, "", c); sub(/^-/, "", c); return c ~ /^(ba|z|fi|k|da|a|c|tc)?sh$/ }
    function depth(p,   d) { d=0; while (p != "" && d < 64) { if (p == start) return d; p=pp[p]; d++ } return -1 }
    END {
      best=-1; bp="";
      for (i=1; i<=NR; i++) {
        p=ord[i];
        if (!isshell(cm[p])) continue;
        if (index(st[p], "+") == 0) continue;
        d=depth(p); if (d < 0) continue;
        if (d > best) { best=d; bp=p }
      }
      print (bp != "" ? bp : start)
    }
  '
}
read_shell_cwd() {
  _rc_cwd=$(readlink "/proc/$1/cwd" 2>/dev/null)
  if [ -n "$_rc_cwd" ]; then printf '%s\n' "$_rc_cwd"; return 0; fi
  if command -v lsof >/dev/null 2>&1; then
    _rc_cwd=$(LC_ALL=C lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1)
    if [ -n "$_rc_cwd" ]; then printf 'NETCATTY_LSOF_CWD=%s\n' "$_rc_cwd"; return 0; fi
  fi
  return 1
}
login="$TARGET_LOGIN"
[ -n "$login" ] || login=$(find_login_shell "${NC_SSHD_PPID:-$PPID}")
if [ -n "$login" ]; then
  printf 'NETCATTY_LOGIN_PID=%s\n' "$login" >&2
  pid=$(find_active_shell "$login")
  [ -n "$pid" ] || pid="$login"
  cwd=$(read_shell_cwd "$pid")
  if [ -z "$cwd" ] && [ "$pid" != "$login" ] && [ "$ALLOW_LOGIN_FALLBACK" = "1" ]; then
    cwd=$(read_shell_cwd "$login")
  fi
  [ -n "$cwd" ] && printf '%s\n' "$cwd" && exit 0
fi
[ "$ALLOW_HOME_FALLBACK" = "1" ] || exit 1
emit_home() {
  case "$1" in
    /*) printf '%s\n' "$1"; exit 0 ;;
  esac
}
home=$(eval echo "~" 2>/dev/null)
emit_home "$home"
uid=$(id -u 2>/dev/null)
if [ -n "$uid" ]; then
  home=$(getent passwd "$uid" 2>/dev/null | awk -F: 'NR == 1 { print $6; exit }')
  emit_home "$home"
  home=$(awk -F: -v uid="$uid" '$3 == uid { print $6; exit }' /etc/passwd 2>/dev/null)
  emit_home "$home"
fi
home=$(id -P 2>/dev/null | awk -F: 'NR == 1 { print $9; exit }')
emit_home "$home"
emit_home "$HOME"
exit 1"#;

/// POSIX 单引号转义（Netcatty quoteShellArg）
pub fn quote_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Netcatty 的外层：`exec sh -c '<export NC_SSHD_PPID=$PPID; sh -c <script>>'`
/// （exec 换掉登录 shell，使 $PPID 是 sshd；fish/zsh 登录 shell 也不会去解析脚本）
pub fn pwd_command() -> String {
    let inner = format!("export NC_SSHD_PPID=$PPID; sh -c {}", quote_shell_arg(PWD_SCRIPT));
    format!("exec sh -c {}", quote_shell_arg(&inner))
}

/// lsof -Fn 把不可打印字节写成 \xNN（Netcatty decodeLsofFileName）
fn decode_lsof_file_name(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() && bytes[i + 1] == b'x' {
            if let Ok(b) = u8::from_str_radix(&raw[i + 2..i + 4], 16) {
                out.push(b);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 解析 pwd 脚本的输出：绝对路径才算数
pub fn parse_pwd_output(stdout: &str) -> Option<String> {
    let raw = stdout.trim_end_matches(['\r', '\n']);
    let raw = raw.lines().last().unwrap_or("");
    let path = match raw.strip_prefix("NETCATTY_LSOF_CWD=") {
        Some(rest) => decode_lsof_file_name(rest),
        None => raw.to_string(),
    };
    path.starts_with('/').then_some(path)
}

/// 读会话交互 shell 的当前目录；读不到返回 None（不报错，调用方退回别的来源）
#[tauri::command]
pub async fn ssh_session_pwd(state: State<'_, SshState>, key: String) -> Result<Option<String>, String> {
    let handle = state.handle(&key).ok_or_else(|| format!("未找到会话 {key}（可能已断开）"))?;
    match crate::ssh::exec_on(&handle, &pwd_command(), Duration::from_secs(5)).await {
        Ok(out) => Ok(parse_pwd_output(&out.stdout)),
        Err(_) => Ok(None),
    }
}

/* ------------------------------ 上传剪贴板图片 ------------------------------ */

/// Netcatty sanitizeRemoteClipboardImageName
pub fn sanitize_remote_clipboard_image_name(name: &str) -> String {
    let fallback = "netcatty-paste.png";
    let trimmed = if name.trim().is_empty() { fallback } else { name.trim() };
    let mut out = String::new();
    let mut last_underscore = false;
    for ch in trimmed.chars() {
        let mapped = if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' { ch } else { '_' };
        if mapped == '_' {
            if last_underscore {
                continue;
            }
            last_underscore = true;
        } else {
            last_underscore = false;
        }
        out.push(mapped);
    }
    let out = out.trim_matches('_').to_string();
    if out.is_empty() {
        fallback.to_string()
    } else {
        out
    }
}

/// Netcatty buildRemoteClipboardImagePath
pub fn build_remote_clipboard_image_path(cwd: &str, file_name: &str) -> Option<String> {
    let safe = sanitize_remote_clipboard_image_name(file_name);
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return None;
    }
    let base = cwd.trim_end_matches('/');
    Some(if base.is_empty() {
        format!("/{REMOTE_CLIPBOARD_IMAGE_DIR}/{safe}")
    } else {
        format!("{base}/{REMOTE_CLIPBOARD_IMAGE_DIR}/{safe}")
    })
}

/// Netcatty quoteRemotePathForShell：安全字符原样，否则单引号包起来
pub fn quote_remote_path_for_shell(path: &str) -> String {
    let safe = !path.is_empty()
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./~:@%+=,-".contains(c));
    if safe {
        path.to_string()
    } else {
        quote_shell_arg(path)
    }
}

/// Netcatty createClipboardImageFileName：netcatty-paste-YYYYMMDD-HHMMSS-mmm.png（本地时间）
fn clipboard_image_file_name() -> String {
    chrono::Local::now().format("netcatty-paste-%Y%m%d-%H%M%S-%3f.png").to_string()
}

/// RGBA → PNG
pub fn encode_png(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 || rgba.len() != width * height * 4 {
        return Err("剪贴板图片数据无效".into());
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| format!("编码 PNG 失败：{e}"))?;
        writer.write_image_data(rgba).map_err(|e| format!("编码 PNG 失败：{e}"))?;
    }
    Ok(out)
}

fn read_clipboard_png() -> Option<Vec<u8>> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    let image = clipboard.get_image().ok()?;
    encode_png(image.width, image.height, &image.bytes).ok()
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "status")]
pub enum ClipboardImageUpload {
    /// 成功：远端路径与要键入终端的（加引号后的）路径
    Ok { remote_path: String, pasted_path: String },
    /// Netcatty RemoteClipboardImageUploadResult 的失败原因：no-image / no-cwd / upload-failed
    Failed { reason: &'static str, detail: Option<String> },
}

#[tauri::command]
pub async fn ssh_upload_clipboard_image(
    ssh: State<'_, SshState>,
    sftp: State<'_, SftpState>,
    key: String,
    cwd: Option<String>,
) -> Result<ClipboardImageUpload, String> {
    // 剪贴板 API 在部分平台上是同步阻塞调用，放到阻塞线程里
    let png = tokio::task::spawn_blocking(read_clipboard_png).await.ok().flatten();
    let Some(png) = png else {
        return Ok(ClipboardImageUpload::Failed { reason: "no-image", detail: None });
    };
    let cwd = match cwd.filter(|c| c.starts_with('/')) {
        Some(c) => Some(c),
        None => match ssh.handle(&key) {
            Some(handle) => crate::ssh::exec_on(&handle, &pwd_command(), Duration::from_secs(5))
                .await
                .ok()
                .and_then(|out| parse_pwd_output(&out.stdout)),
            None => None,
        },
    };
    let Some(target) = cwd.as_deref().and_then(|c| build_remote_clipboard_image_path(c, &clipboard_image_file_name())) else {
        return Ok(ClipboardImageUpload::Failed { reason: "no-cwd", detail: None });
    };
    let session = match sftp.get_sftp(&key).await {
        Ok(s) => s,
        Err(e) => return Ok(ClipboardImageUpload::Failed { reason: "upload-failed", detail: Some(e) }),
    };
    let dir = target.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
    if session.try_exists(dir.clone()).await.ok() != Some(true) {
        if let Err(e) = session.create_dir(dir.clone()).await {
            return Ok(ClipboardImageUpload::Failed { reason: "upload-failed", detail: Some(format!("创建 {dir} 失败：{e}")) });
        }
    }
    let written = async {
        use tokio::io::AsyncWriteExt;
        let mut file = session.create(target.clone()).await.map_err(|e| e.to_string())?;
        file.write_all(&png).await.map_err(|e| e.to_string())?;
        file.shutdown().await.map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = written {
        return Ok(ClipboardImageUpload::Failed { reason: "upload-failed", detail: Some(e) });
    }
    Ok(ClipboardImageUpload::Ok { pasted_path: quote_remote_path_for_shell(&target), remote_path: target })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_image_paths_follow_netcatty() {
        assert_eq!(sanitize_remote_clipboard_image_name("  "), "netcatty-paste.png");
        assert_eq!(sanitize_remote_clipboard_image_name("a b/c\\d?.png"), "a_b_c_d_.png");
        assert_eq!(build_remote_clipboard_image_path("/home/u/", "x.png").unwrap(), "/home/u/.netcatty-paste-images/x.png");
        assert_eq!(build_remote_clipboard_image_path("/", "x.png").unwrap(), "/.netcatty-paste-images/x.png");
        assert!(build_remote_clipboard_image_path(" ", "x.png").is_none());
        assert_eq!(quote_remote_path_for_shell("/tmp/a.png"), "/tmp/a.png");
        assert_eq!(quote_remote_path_for_shell("/tmp/it's me.png"), "'/tmp/it'\\''s me.png'");
        let name = clipboard_image_file_name();
        assert!(name.starts_with("netcatty-paste-") && name.ends_with(".png") && name.len() == "netcatty-paste-20260611-030405-006.png".len());
    }

    #[test]
    fn pwd_output_parsing() {
        assert_eq!(parse_pwd_output("/home/u/proj\n").as_deref(), Some("/home/u/proj"));
        assert_eq!(parse_pwd_output("NETCATTY_LSOF_CWD=/Users/a\\x20b\n").as_deref(), Some("/Users/a b"));
        assert_eq!(parse_pwd_output("garbage\n"), None);
        assert!(pwd_command().starts_with("exec sh -c '"));
    }

    #[test]
    fn png_roundtrip_header() {
        let png = encode_png(1, 1, &[255, 0, 0, 255]).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert!(encode_png(2, 2, &[0; 4]).is_err());
    }
}
