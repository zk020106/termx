mod config;
mod known_hosts;
mod probe;
mod pty;
mod secret;
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
            ssh::ssh_trust_host,
            ssh::ssh_replace_host_key,
            secret::secret_save,
            secret::secret_load,
            secret::secret_delete,
            secret::secret_available,
        ])
        .run(tauri::generate_context!())
        .expect("TermX 启动失败");
}
