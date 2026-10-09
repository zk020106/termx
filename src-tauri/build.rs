// 应用命令的访问控制（Tauri v2 ACL）。
//
// 在这里登记全部自定义命令后，每条命令都有一条 `allow-<命令名>` 权限，
// 默认**一律不放行**，只有 capabilities/*.json 里显式列出的才可调用：
// 新加的命令忘了授权会直接调不通（而不是悄悄对所有窗口开放），
// 授权范围也只限 capability 里写的窗口（main），不对任何远程页面开放。
const COMMANDS: &[&str] = &[
    "pty_spawn",
    "pty_write",
    "pty_resize",
    "pty_kill",
    "probe_hosts",
    "probe_host",
    "config_load",
    "config_save",
    "config_location",
    "ssh_connect",
    "ssh_write",
    "ssh_resize",
    "ssh_ping_rtt",
    "ssh_disconnect",
    "ssh_exec",
    "forward_start",
    "forward_stop",
    "forward_list",
    "ssh_trust_host",
    "ssh_replace_host_key",
    "ssh_auth_respond",
    "ssh_agent_identities",
    "secret_save",
    "secret_load",
    "secret_delete",
    "secret_available",
    "sftp_list",
    "sftp_realpath",
    "sftp_mkdir",
    "sftp_remove",
    "sftp_rename",
    "sftp_chmod",
    "sftp_read_file",
    "sftp_write_file",
    "sftp_upload",
    "sftp_download",
    "sftp_stat",
    "fs_local_stat",
    "transfer_check",
    "transfer_start",
    "transfer_control",
    "transfer_set_limits",
    "transfer_discard_partial",
    "fs_reveal",
    "fs_local_list",
    "fs_local_home",
    "fs_local_drives",
    "fs_local_mkdir",
    "fs_local_remove",
    "fs_local_rename",
    "fs_local_read_file",
    "fs_local_write_file",
    "fs_open_path",
    "fs_open_with",
    "fs_temp_file_path",
    "fs_local_extract",
    "fs_local_copy",
    "known_hosts_list",
    "known_hosts_remove",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri-build 失败");
}
