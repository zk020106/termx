import type { ConnectProfile } from "./connectPlan";
import { isTauri } from "./tauri";
import { ownSession } from "./window";

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
	/** 指纹问题出在哪一跳（经跳板机时可能是跳板机而不是目标主机）；信任 / 替换要作用在它上面 */
	host?: string | null;
	port?: number | null;
}

/** 认证凭据：与 Rust 侧 ssh_connect 的 credential 参数一一对应 */
export type Credential =
	| { method: "password"; password: string }
	/** 私钥文件路径 + 口令；没有口令时传 null（口令只存在于本次调用的内存里） */
	| { method: "private_key"; path: string; passphrase: string | null }
	| { method: "agent" }
	| { method: "keyboard_interactive" }
	/** 连接到这一跳时再弹框问密码 / 私钥口令（跳板机没有保存凭据时用） */
	| { method: "ask_password" }
	| { method: "ask_passphrase"; path: string }
	/** 钥匙串（密钥库）里的私钥：私钥材料由 Rust 就地解开；口令缺省时用记住的口令或连接时再问 */
	| { method: "stored_key"; keyId: string; label?: string | null; passphrase?: string | null };

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
	/** 跳板链 / 代理 / TERM / 环境变量 / 登录脚本 / 编码（见 lib/connectPlan.ts） */
	profile?: ConnectProfile;
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

/**
 * 一条已认证连接上的往返延迟。
 *
 * 口径：一次 SSH keepalive 全局请求从发出到收到答复，也就是**端到端的真实往返**。
 * 这跟 probe.ts 的 TCP 建连耗时是两码事：后者可能被本机代理就地握完，与远端无关，
 * 而已经建立的这条连接必须真的把数据送到对端再回来。
 */
export interface SshRttReport {
	/** 会话键（就是前端的标签页 id） */
	key: string;
	/** 口径标识：恒为 ssh_round_trip */
	caliber: "ssh_round_trip";
	/** 实际发出去的次数；首包超时后就不再继续，所以可能小于请求的次数 */
	sent: number;
	received: number;
	loss: number;
	min_ms: number;
	avg_ms: number;
	/** 中位数：样本少时比平均值更稳，展示用它 */
	median_ms: number;
	max_ms: number;
	jitter_ms: number;
	samples: number[];
	error: string | null;
}

/**
 * 在已认证会话上量一次 SSH 往返。会话不存在、或对端不应答时返回 null，
 * 由调用方决定回落到什么口径 —— 这里不编数字。
 */
export async function sshPingRtt(
	key: string,
	options: { samples?: number; timeoutMs?: number } = {},
): Promise<SshRttReport | null> {
	if (!isTauri()) return null;
	const { invoke } = await import("@tauri-apps/api/core");
	try {
		return await invoke<SshRttReport>("ssh_ping_rtt", {
			key,
			samples: options.samples ?? 3,
			timeoutMs: options.timeoutMs ?? 1000,
		});
	} catch {
		return null;
	}
}

/** 把 SSH 往返压成一句事实描述：中位数、区间、抖动、丢包 */
export function describeRtt(report: SshRttReport): string {
	if (report.received === 0) return report.error ?? "没有收到 keepalive 答复";

	const head = `SSH 往返 ${Math.round(report.median_ms)} ms（最低 ${Math.round(
		report.min_ms,
	)} / 最高 ${Math.round(report.max_ms)}，${report.received}/${report.sent} 次）`;
	const jitter = report.jitter_ms > 0 ? ` · 抖动 ±${report.jitter_ms.toFixed(1)} ms` : "";
	const loss = report.loss > 0 ? ` · 丢包 ${Math.round(report.loss * 100)}%` : "";
	return `${head}${jitter}${loss}`;
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
		profile: options.profile ?? null,
	});
	// 会话归属登记：所在窗口关闭时后端断开它（多窗口，见 app_window.rs）
	ownSession("ssh", options.key);
}

/** 远端命令的执行结果 */
export interface ExecOutput {
	code: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
}

/** 在已连接会话所在主机上跑一条非交互命令（另开 exec 通道，不占用终端） */
export async function sshExec(key: string, command: string, timeoutMs = 15000): Promise<ExecOutput> {
	if (!isTauri()) throw new Error("SSH 需要在桌面端运行");
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<ExecOutput>("ssh_exec", { key, command, timeoutMs });
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

/**
 * 首次连接确认后记录信任（密钥材料留在 Rust 侧，不经过前端）。返回写入后的指纹。
 * 必须带上界面上展示给用户核对的那个指纹：Rust 只信任指纹一致的那把钥匙，
 * 核对期间对端换了钥匙会被拒绝，而不是把另一把钥匙写进 known_hosts。
 */
export async function sshTrustHost(host: string, port: number, fingerprint: string | null): Promise<string> {
	if (!fingerprint) throw new Error("没有拿到可供核对的主机指纹，请重新发起连接");
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<string>("ssh_trust_host", { host, port, fingerprint });
}

/** 服务器确实重装过、人工核对之后替换旧记录；同样按用户核对过的指纹；返回结果说明 */
export async function sshReplaceHostKey(host: string, port: number, fingerprint: string | null): Promise<string> {
	if (!fingerprint) throw new Error("没有拿到可供核对的主机指纹，请重新发起连接");
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<string>("ssh_replace_host_key", { host, port, fingerprint });
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
		onZmodem?: (chunk: { encoding: string; data: string }) => void;
	},
): Promise<() => void> {
	const { listen } = await import("@tauri-apps/api/event");

	const unlistenPhase = await listen<SshPhase>(`ssh://state/${key}`, (event) => handlers.onPhase(event.payload));
	const unlistenData = await listen<string>(`ssh://data/${key}`, (event) => handlers.onData(event.payload));
	const unlistenExit = await listen<number | null>(`ssh://exit/${key}`, (event) => handlers.onExit(event.payload));
	// ZMODEM：Rust 闸门检测到 sz / rz 后推来的原始字节（见 src-tauri/src/zmodem.rs）
	const unlistenZmodem = handlers.onZmodem
		? await listen<{ encoding: string; data: string }>(`ssh://zmodem/${key}`, (event) => handlers.onZmodem?.(event.payload))
		: null;
	const unlistenPrompt = handlers.onAuthPrompt
		? await listen<AuthPromptRequest>(`ssh://auth-prompt/${key}`, (event) => handlers.onAuthPrompt?.(event.payload))
		: null;

	return () => {
		unlistenPhase();
		unlistenData();
		unlistenExit();
		unlistenZmodem?.();
		unlistenPrompt?.();
	};
}
