mod chain;
mod codec;
mod config;
mod fs_guard;
mod forward;
mod known_hosts;
mod probe;
mod pty;
mod secret;
mod sftp;
mod ssh;
mod ssh_auth;
mod transfer;
mod transport;
#[cfg(test)]
mod live_tests;

use pty::PtyState;
use sftp::SftpState;
use ssh::SshState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例守护：重复启动时不闪退，自动唤起已存在的主窗口
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        // 文件选择器：界面上「选择私钥文件」用它（前端 @tauri-apps/plugin-dialog）
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyState::default())
        .manage(SshState::default())
        .manage(SftpState::default())
        .manage(forward::ForwardState::default())
        .manage(transfer::TransferState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            probe::probe_hosts,
            probe::probe_host,
            config::config_load,
            config::config_save,
            config::config_location,
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_ping_rtt,
            ssh::ssh_disconnect,
            ssh::ssh_exec,
            forward::forward_start,
            forward::forward_stop,
            forward::forward_list,
            ssh::ssh_trust_host,
            ssh::ssh_replace_host_key,
            ssh_auth::ssh_auth_respond,
            ssh_auth::ssh_agent_identities,
            secret::secret_save,
            secret::secret_load,
            secret::secret_delete,
            secret::secret_available,
            sftp::sftp_list,
            sftp::sftp_realpath,
            sftp::sftp_mkdir,
            sftp::sftp_remove,
            sftp::sftp_rename,
            sftp::sftp_chmod,
            sftp::sftp_read_file,
            sftp::sftp_write_file,
            sftp::sftp_upload,
            sftp::sftp_download,
            sftp::sftp_stat,
            sftp::fs_local_stat,
            transfer::transfer_check,
            transfer::transfer_start,
            transfer::transfer_control,
            transfer::transfer_set_limits,
            transfer::transfer_discard_partial,
            transfer::fs_reveal,
            sftp::fs_local_list,
            sftp::fs_local_home,
            sftp::fs_local_drives,
            sftp::fs_local_mkdir,
            sftp::fs_local_remove,
            sftp::fs_local_rename,
            sftp::fs_local_read_file,
            sftp::fs_local_write_file,
        ])
        .run(tauri::generate_context!())
        .expect("TermX 启动失败");
}
