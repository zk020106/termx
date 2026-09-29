mod config;
mod probe;
mod pty;
mod ssh;

use pty::PtyState;
use ssh::SshState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState::default())
        .manage(SshState::default())
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
            ssh::ssh_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("TermX 启动失败");
}
