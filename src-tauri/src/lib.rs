mod chain;
mod codec;
mod config;
mod fs_guard;
mod fs_open;
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
mod app_window;
mod zmodem;
mod session_cwd;
mod key_vault;
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
        .manage(zmodem::ZmodemState::default())
        .manage(app_window::AppWindowState::default())
        // 窗口销毁时断开它名下的会话（Netcatty：webContents destroyed 时清理该窗口的会话）
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                app_window::on_window_destroyed(window);
            }
        })
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
            fs_open::fs_open_path,
            fs_open::fs_open_with,
            fs_open::fs_temp_file_path,
            fs_open::fs_local_extract,
            fs_open::fs_local_copy,
            known_hosts::known_hosts_list,
            known_hosts::known_hosts_remove,
            key_vault::key_vault_import,
            key_vault::key_vault_generate,
            key_vault::key_vault_delete,
            key_vault::key_vault_set_passphrase,
            key_vault::key_vault_status,
            known_hosts::known_hosts_import,
            session_cwd::ssh_session_pwd,
            session_cwd::ssh_upload_clipboard_image,
            ssh::ssh_write_bytes,
            ssh::ssh_zmodem_release,
            zmodem::zmodem_pick_upload_files,
            zmodem::zmodem_read_chunk,
            zmodem::zmodem_release_files,
            zmodem::zmodem_pick_download_dir,
            zmodem::zmodem_create_file,
            zmodem::zmodem_write_chunk,
            zmodem::zmodem_finish_file,
            ssh::ssh_drain,
            app_window::window_open_session,
            app_window::window_take_session_payload,
            app_window::window_own_session,
            sftp::sftp_copy_between,
        ])
        .run(tauri::generate_context!())
        .expect("TermX 启动失败");
}
