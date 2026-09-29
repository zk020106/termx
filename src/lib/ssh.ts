import { isTauri } from "./tauri";

/* SSH（原生壳内的 russh 实现）前端入口。
 * 连接过程与数据都通过事件推送，这里只负责发起与写入。 */

/** 连接阶段：resolve / tcp / handshake / auth / shell / failed */
export interface SshPhase {
	phase: string;
	ok: boolean;
	detail: string;
}

export interface SshConnectOptions {
	/** 会话键，前端生成，用于把事件对回具体的会话 */
	key: string;
	host: string;
	port: number;
	username: string;
	/** 只走内存，绝不写入配置文件 */
	password: string;
	cols: number;
	rows: number;
}

export function sshSupported(): boolean {
	return isTauri();
}

export async function sshConnect(options: SshConnectOptions): Promise<void> {
	if (!isTauri()) throw new Error("SSH 需要在桌面端运行");
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("ssh_connect", {
		key: options.key,
		host: options.host,
		port: options.port,
		username: options.username,
		password: options.password,
		cols: options.cols,
		rows: options.rows,
	});
}

export async function sshWrite(key: string, data: string): Promise<void> {
	if (!isTauri()) return;
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("ssh_write", { key, data });
}

export async function sshResize(key: string, cols: number, rows: number): Promise<void> {
	if (!isTauri()) return;
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("ssh_resize", { key, cols, rows });
}

export async function sshDisconnect(key: string): Promise<void> {
	if (!isTauri()) return;
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("ssh_disconnect", { key });
}

/** 订阅一个会话的事件流，返回取消订阅的函数 */
export async function listenSsh(
	key: string,
	handlers: {
		onPhase: (phase: SshPhase) => void;
		onData: (chunk: string) => void;
		onExit: (code: number | null) => void;
	},
): Promise<() => void> {
	const { listen } = await import("@tauri-apps/api/event");

	const unlistenPhase = await listen<SshPhase>(`ssh://state/${key}`, (event) => handlers.onPhase(event.payload));
	const unlistenData = await listen<string>(`ssh://data/${key}`, (event) => handlers.onData(event.payload));
	const unlistenExit = await listen<number | null>(`ssh://exit/${key}`, (event) => handlers.onExit(event.payload));

	return () => {
		unlistenPhase();
		unlistenData();
		unlistenExit();
	};
}
