import { isTauri } from "./tauri";

/* SSH（原生壳内的 russh 实现）前端入口。
 * 连接过程与数据都通过事件推送，这里只负责发起与写入。
 *
 * 认证方式五种，全部由 Rust 侧实现：密码、私钥、私钥 + 口令、SSH Agent、
 * 键盘交互（服务器提问 / 二次验证）。凭据只走内存：不写配置文件、不落盘。 */

/** 连接阶段：resolve / tcp / handshake / auth / shell / failed */
export interface SshPhase {
	phase: string;
	ok: boolean;
	detail: string;
	/** 需要界面引导动作的失败类型：host_unknown（首次连接需确认指纹）/ host_changed（指纹变了，已拒绝） */
	kind: string | null;
	/** 服务器返回的主机指纹（SHA256:…）；有则直接用，不必从 detail 里解析 */
	fingerprint: string | null;
}

/** 认证凭据：与 Rust 侧 ssh_connect 的 credential 参数一一对应 */
export type Credential =
	| { method: "password"; password: string }
	/** 私钥文件路径 + 口令；没有口令时传 null（口令只存在于本次调用的内存里） */
	| { method: "private_key"; path: string; passphrase: string | null }
	| { method: "agent" }
	| { method: "keyboard_interactive" };

/** SSH Agent 里的一个身份：只有公钥信息，私钥始终留在 agent 自己的进程里 */
export interface AgentIdentity {
	fingerprint: string;
	comment: string;
	/** 公钥算法，例如 ssh-ed25519 */
	algorithm: string;
}

/** 键盘交互：服务器的一轮提问。服务器可能连着问好几轮，每轮都是一条这样的事件 */
export interface AuthPromptRequest {
	/** 通常是 "password" / "Verification code" 之类的提示名 */
	name: string;
	instructions: string;
	prompts: {
		prompt: string;
		/** false 表示服务器要求不回显（密码 / 验证码），界面上要当密码框用 */
		echo: boolean;
	}[];
}

export interface SshConnectOptions {
	/** 会话键，前端生成，用于把事件对回具体的会话 */
	key: string;
	host: string;
	port: number;
	username: string;
	/** 认证凭据；只在内存里过一手 */
	credential?: Credential;
	/**
	 * 兼容字段：sshCache.openSshSession 的入参至今固定为 password（该文件不在本次写入范围），
	 * 所以这里保留它。只有既没有 credential、也没有寄存凭据时才用它，并映射成密码认证。
	 */
	password?: string;
	cols: number;
	rows: number;
}

/*
 * 凭据寄存：sshCache 只能按 password 传参，非密码认证没法从那条路进来。
 * 于是调用方（连接页）先按会话键把真正的凭据寄存在这里，sshConnect 取一次即删。
 * 密码方式也走同一条路，避免出现两套凭据来源。
 */
const stagedCredentials = new Map<string, Credential>();

/** 寄存一份凭据，供下一次 sshConnect 使用（键相同则覆盖） */
export function stageCredential(key: string, credential: Credential): void {
	stagedCredentials.set(key, credential);
}

/** 丢弃寄存的凭据（断开连接时调用，别让它在内存里留着） */
export function dropStagedCredential(key: string): void {
	stagedCredentials.delete(key);
}

export function sshSupported(): boolean {
	return isTauri();
}

/** 旧的 password 字段 → 密码凭据；没给密码就是没有凭据 */
function credentialFromPassword(password: string | undefined): Credential | null {
	return typeof password === "string" ? { method: "password", password } : null;
}

export async function sshConnect(options: SshConnectOptions): Promise<void> {
	if (!isTauri()) throw new Error("SSH 需要在桌面端运行");
	const credential =
		options.credential ?? stagedCredentials.get(options.key) ?? credentialFromPassword(options.password);
	stagedCredentials.delete(options.key);
	if (!credential) throw new Error("缺少认证凭据，无法发起 SSH 连接");

	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("ssh_connect", {
		key: options.key,
		host: options.host,
		port: options.port,
		username: options.username,
		credential,
		cols: options.cols,
		rows: options.rows,
	});
}

/** 回答服务器当前这一轮的键盘交互提问；顺序必须与事件里的 prompts 一致 */
export async function sshAuthRespond(key: string, responses: string[]): Promise<void> {
	if (!isTauri()) throw new Error("SSH 需要在桌面端运行");
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("ssh_auth_respond", { key, responses });
}

/** 列出 SSH Agent 里可用的身份；只有公钥信息，私钥不会经过前端 */
export async function sshAgentIdentities(): Promise<AgentIdentity[]> {
	if (!isTauri()) throw new Error("SSH 需要在桌面端运行：浏览器预览里读不到 SSH Agent");
	const { invoke } = await import("@tauri-apps/api/core");
	const raw = await invoke<Partial<AgentIdentity>[]>("ssh_agent_identities");
	// 后端字段缺失时补空串，界面就不必到处判空；排序保持后端给的顺序（就是依次尝试的顺序）
	return (raw ?? []).map((identity) => ({
		fingerprint: identity.fingerprint ?? "",
		comment: identity.comment ?? "",
		algorithm: identity.algorithm ?? "",
	}));
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
	dropStagedCredential(key);
	if (!isTauri()) return;
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("ssh_disconnect", { key });
}

/** 首次连接确认后记录信任（密钥材料留在 Rust 侧，不经过前端）。返回写入后的指纹。 */
export async function sshTrustHost(host: string, port: number): Promise<string> {
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<string>("ssh_trust_host", { host, port });
}

/** 服务器确实重装过、人工核对之后替换旧记录；返回结果说明 */
export async function sshReplaceHostKey(host: string, port: number): Promise<string> {
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<string>("ssh_replace_host_key", { host, port });
}

/**
 * 只订阅键盘交互提问。服务器在认证阶段随时可能发问，而它不属于会话事件流里
 * 那些有缓冲语义的数据，单独一条监听更干净（连接页就是这么用的）。
 */
export async function listenAuthPrompts(key: string, handler: (payload: AuthPromptRequest) => void): Promise<() => void> {
	const { listen } = await import("@tauri-apps/api/event");
	return listen<AuthPromptRequest>(`ssh://auth-prompt/${key}`, (event) => handler(event.payload));
}

/** 订阅一个会话的事件流，返回取消订阅的函数 */
export async function listenSsh(
	key: string,
	handlers: {
		onPhase: (phase: SshPhase) => void;
		onData: (chunk: string) => void;
		onExit: (code: number | null) => void;
		/** 键盘交互：服务器发来一轮提问，等用户作答 */
		onAuthPrompt?: (payload: AuthPromptRequest) => void;
	},
): Promise<() => void> {
	const { listen } = await import("@tauri-apps/api/event");

	const unlistenPhase = await listen<SshPhase>(`ssh://state/${key}`, (event) => handlers.onPhase(event.payload));
	const unlistenData = await listen<string>(`ssh://data/${key}`, (event) => handlers.onData(event.payload));
	const unlistenExit = await listen<number | null>(`ssh://exit/${key}`, (event) => handlers.onExit(event.payload));
	const unlistenPrompt = handlers.onAuthPrompt
		? await listen<AuthPromptRequest>(`ssh://auth-prompt/${key}`, (event) => handlers.onAuthPrompt?.(event.payload))
		: null;

	return () => {
		unlistenPhase();
		unlistenData();
		unlistenExit();
		unlistenPrompt?.();
	};
}
