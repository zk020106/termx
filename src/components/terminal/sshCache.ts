import { listenSsh, sshConnect, sshDisconnect, sshResize, sshWrite, type SshPhase } from "@/lib/ssh";

/* =============================================================================
 * SSH 会话缓存：与本地终端的 ptyCache 同构，把会话挂在模块级。
 *
 * 为什么要有它：连接是在「连接过程」界面发起的，而终端在「工作区」里才挂载。
 * 两者之间会有一段空窗，这段时间的输出必须先缓冲，等终端挂上来再回放，
 * 否则登录横幅（motd）和首个提示符就丢了——那正是最能证明「真的连上了」的东西。
 *
 * 缓冲是**整段会话输出**，不是「没人看的那一段」：组件重挂载（切到别的界面再回
 * 到工作区、StrictMode 演练、分屏重建）时，新终端只拿到空窗期的数据就会一片空白，
 * 看上去像会话掉了、逼着用户重连。所以只要会话活着就一路累积，重新挂载时整段回放。
 *
 * 凭据只存在内存：密码用于建立会话，不写进配置文件、不落盘。
 * 应用退出即消失。
 *
 * 会话身份是**会话键**，不是主机：同一台主机可以有任意多条并发会话，
 * 各有各的键、各缓冲各的输出（见 newSshSessionKey）。
 * ========================================================================== */

/* ------------------------------- 会话键 ------------------------------- */

let keySeq = 0;

/**
 * 生成一个新的 SSH 会话键：**每次发起连接都是一个独立身份**。
 *
 * 为什么不能再用 `ssh:<hostId>`：那等于把「主机」当成会话的唯一身份 ——
 * 后端会话表按这个键存，于是同一台主机永远只能有一条连接，再连一次只会
 * 撞上「会话已存在」；前端的缓存、标签、分屏格也会被迫共用一条连接。
 *
 * 后缀里带一段随机数：开发态整页重载后前端计数器会归零，而 Rust 侧的会话
 * 还活着，只有随机段才能保证重载后不会生成一个已经被占用的键。
 * 键里保留 hostId 只是为了可读性（排查问题时一眼看出是哪台主机），
 * 它不参与任何身份判定。
 *
 * 注意分隔符只能用 `-` `/` `:` `_` 与字母数字：这个键会被拼进 Tauri 事件名
 * （ssh://state/<key> 等），而 Tauri 对事件名做字符校验，其它字符会被
 * `listen` 直接拒掉（曾用 `#` 分隔，导致连接时报 invalid args `event`）。
 */
export function newSshSessionKey(hostId: string): string {
	keySeq += 1;
	const rand = Math.random().toString(36).slice(2, 8);
	return `ssh:${hostId}:${keySeq}-${rand}`;
}

interface Entry {
	/** 整段会话输出（只留末尾 MAX_BUFFER 字符）：终端重挂载时靠它回放 */
	replay: string;
	subs: Set<(chunk: string) => void>;
	exitSubs: Set<(code: number | null) => void>;
	phase: SshPhase | null;
	phaseSubs: Set<(phase: SshPhase) => void>;
	connected: boolean;
	/** 该会话是否曾成功建立过连接 */
	wasConnected: boolean;
	/** 远端会话已经结束（shell 退出 / 通道关闭） */
	exited: boolean;
	failed: string | null;
	unlisten: (() => void) | null;
}

const sessions = new Map<string, Entry>();
const MAX_BUFFER = 256 * 1024;

function ensureEntry(key: string): Entry {
	let entry = sessions.get(key);
	if (!entry) {
		entry = {
			replay: "",
			subs: new Set(),
			exitSubs: new Set(),
			phase: null,
			phaseSubs: new Set(),
			connected: false,
			wasConnected: false,
			exited: false,
			failed: null,
			unlisten: null,
		};
		sessions.set(key, entry);
	}
	return entry;
}

/* --------------------------- 生命周期观察 --------------------------- */

export type SshLifecycle = "connected" | "exited" | "failed";

const lifecycleSubs = new Set<(key: string, event: SshLifecycle) => void>();

/**
 * 订阅**所有**会话的生命周期（建立 / 结束 / 失败），返回取消订阅的函数。
 * 工作区用它把标签状态跟到真实会话上：每条会话各自更新自己的标签，
 * 一条断开不影响另一条的显示。
 */
export function observeSshLifecycle(handler: (key: string, event: SshLifecycle) => void): () => void {
	lifecycleSubs.add(handler);
	return () => {
		lifecycleSubs.delete(handler);
	};
}

function emitLifecycle(key: string, event: SshLifecycle): void {
	for (const sub of lifecycleSubs) {
		try {
			sub(key, event);
		} catch {
			// 订阅者（界面）出错不能拖垮会话的事件处理
		}
	}
}

/**
 * 会话是否还"活着"：已建立，或者仍在建立中。
 *
 * 用途是「这台主机是不是已经有会话」——点主机库时据此决定聚焦已有标签
 * 还是发起新连接。已经失败或已经退出的不算，否则用户会被带到一条死掉的
 * 标签上，那比多开一条更让人莫名其妙。
 */
export function sshSessionAlive(key: string): boolean {
	const entry = sessions.get(key);
	if (!entry) return false;
	return !entry.exited && entry.failed === null;
}

/** 会话是否已经建立（终端据此决定走 SSH 还是本地 shell） */
export function hasSshSession(key: string): boolean {
	return sessions.get(key)?.connected ?? false;
}

/** 会话是否曾经成功连上过（用于区分是初次建连中，还是中途掉线） */
export function sshSessionWasConnected(key: string): boolean {
	return sessions.get(key)?.wasConnected ?? false;
}

/** 上一次失败原因，用于界面提示 */
export function sshFailure(key: string): string | null {
	return sessions.get(key)?.failed ?? null;
}

export interface SshOpenResult {
	ok: boolean;
	error?: string;
	/** host_unknown：首次连接需确认指纹；host_changed：指纹变化已被拒绝 */
	kind?: string;
	/** 服务器返回的指纹，界面直接展示 */
	fingerprint?: string;
}

const mockSshBuffers = new Map<string, { buffer: string; host: string; user: string }>();

/**
 * 发起连接。订阅事件 → 调后端 → 等首个 success 阶段。
 * 期间所有输出都进缓冲，终端挂上来即可回放。
 */
export async function openSshSession(
	key: string,
	options: { host: string; port: number; username: string; password: string; cols: number; rows: number },
	onPhase?: (phase: SshPhase) => void,
): Promise<SshOpenResult> {
	const entry = ensureEntry(key);

	if (entry.connected) return { ok: true };

	entry.failed = null;
	entry.exited = false;

	// Web 浏览器预览模式：模拟 SSH 握手并连接成功
	const { isTauri } = await import("@/lib/tauri");
	if (!isTauri()) {
		onPhase?.({ phase: "tcp", ok: true, detail: "正在建立 TCP 连接…", kind: null, fingerprint: null });
		await new Promise((r) => setTimeout(r, 200));
		onPhase?.({ phase: "handshake", ok: true, detail: "SSH-2.0 握手完成…", kind: null, fingerprint: null });
		await new Promise((r) => setTimeout(r, 200));
		onPhase?.({ phase: "auth", ok: true, detail: "凭据验证通过…", kind: null, fingerprint: null });
		await new Promise((r) => setTimeout(r, 150));

		entry.connected = true;
		entry.wasConnected = true;
		const host = options.host;
		const user = options.username || "root";
		mockSshBuffers.set(key, { buffer: "", host, user });

		entry.replay =
			`\r\n\x1b[38;2;0;100;224m[TermX SSH]\x1b[0m 已成功连接到 ${host} (Web 模拟会话)\r\n` +
			`Linux ${host} 6.1.0-22-amd64 #1 SMP PREEMPT_DYNAMIC Debian\r\n` +
			`Last login: ${new Date().toLocaleString()} from 192.168.1.100\r\n\r\n` +
			`\x1b[32m${user}@${host}\x1b[0m:\x1b[34m~\x1b[0m$ `;

		emitLifecycle(key, "connected");
		return { ok: true };
	}

	// 原生桌面端逻辑：先挂监听再发起连接
	if (!entry.unlisten) {
		entry.unlisten = await listenSsh(key, {
			onPhase: (phase) => {
				entry.phase = phase;
				for (const sub of entry.phaseSubs) sub(phase);
				onPhase?.(phase);
				if (phase.phase === "failed") entry.failed = phase.detail;
				if (phase.phase === "shell" && phase.ok) {
					entry.connected = true;
					entry.wasConnected = true;
				}
				if (phase.phase === "failed") emitLifecycle(key, "failed");
				else if (phase.phase === "shell" && phase.ok) emitLifecycle(key, "connected");
			},
			onData: (chunk) => {
				entry.replay = (entry.replay + chunk).slice(-MAX_BUFFER);
				for (const sub of entry.subs) sub(chunk);
			},
			onExit: (code) => {
				entry.connected = false;
				entry.exited = true;
				for (const sub of entry.exitSubs) sub(code);
				emitLifecycle(key, "exited");
			},
		});
	}

	// 先建好「终局」监听，再发起连接：否则首个阶段事件可能在监听就绪前发出
	const outcome = new Promise<{ ok: boolean; detail?: string; kind?: string; fingerprint?: string }>((resolve) => {
		const watch = (phase: SshPhase) => {
			if (phase.phase === "shell" && phase.ok) {
				entry.phaseSubs.delete(watch);
				resolve({ ok: true });
				return;
			}
			if (phase.phase === "failed") {
				entry.phaseSubs.delete(watch);
				resolve({
					ok: false,
					detail: phase.detail,
					kind: phase.kind ?? undefined,
					fingerprint: phase.fingerprint ?? undefined,
				});
			}
		};
		entry.phaseSubs.add(watch);
	});

	try {
		await sshConnect({ key, ...options });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		entry.failed = message;
		return { ok: false, error: message };
	}

	// 认证失败、指纹未确认等都会以 failed 阶段回来
	const result = await outcome;
	if (result.ok) return { ok: true };
	return { ok: false, error: result.detail, kind: result.kind, fingerprint: result.fingerprint };
}

export interface SshAttachment {
	/** 挂载前会话已经产生的全部输出（登录横幅 + 历史命令 + 首个提示符） */
	replay: string;
	detach: () => void;
}

/** 终端挂到会话上；没有会话时返回 null，由调用方决定怎么提示 */
export function attachSsh(
	key: string,
	onData: (chunk: string) => void,
	onExit: (code: number | null) => void,
): SshAttachment | null {
	const entry = sessions.get(key);
	if (!entry) return null;

	entry.subs.add(onData);
	entry.exitSubs.add(onExit);

	return {
		replay: entry.replay,
		detach: () => {
			entry.subs.delete(onData);
			entry.exitSubs.delete(onExit);
		},
	};
}

export function writeSsh(key: string, data: string): boolean {
	const entry = sessions.get(key);
	if (!entry?.connected) return false;

	const mock = mockSshBuffers.get(key);
	if (mock) {
		// Web 模拟交互
		const prompt = `\x1b[32m${mock.user}@${mock.host}\x1b[0m:\x1b[34m~\x1b[0m$ `;
		const emit = (chunk: string) => {
			entry.replay = (entry.replay + chunk).slice(-MAX_BUFFER);
			for (const sub of entry.subs) sub(chunk);
		};

		for (let i = 0; i < data.length; i++) {
			const char = data[i];
			const code = data.charCodeAt(i);

			if (char === "\r" || char === "\n") {
				emit("\r\n");
				const cmd = mock.buffer.trim();
				mock.buffer = "";

				if (cmd) {
					const [name, ...args] = cmd.split(" ");
					switch (name.toLowerCase()) {
						case "help":
							emit("支持的远程命令测试：help, ls, whoami, uname, top, uptime, clear, echo, ping\r\n");
							break;
						case "ls":
							emit("docker-compose.yml   nginx.conf   src   dist   logs   package.json\r\n");
							break;
						case "whoami":
							emit(`${mock.user}\r\n`);
							break;
						case "uname":
							emit(`Linux ${mock.host} 6.1.0-22-amd64 #1 SMP PREEMPT_DYNAMIC Debian\r\n`);
							break;
						case "uptime":
							emit(` ${new Date().toLocaleTimeString()} up 42 days, 3 users, load average: 0.12, 0.08, 0.05\r\n`);
							break;
						case "clear":
							emit("\x1b[2J\x1b[H");
							break;
						case "echo":
							emit(args.join(" ") + "\r\n");
							break;
						case "ping":
							emit(`PING ${args[0] || "1.1.1.1"}: 56 data bytes\r\n64 bytes: icmp_seq=1 ttl=58 time=12.4 ms\r\n`);
							break;
						default:
							emit(`bash: ${name}: command not found\r\n`);
							break;
					}
				}
				emit(prompt);
			} else if (code === 127 || char === "\b") {
				if (mock.buffer.length > 0) {
					mock.buffer = mock.buffer.slice(0, -1);
					emit("\b \b");
				}
			} else if (code === 3) {
				mock.buffer = "";
				emit("^C\r\n" + prompt);
			} else if (code >= 32) {
				mock.buffer += char;
				emit(char);
			}
		}
		return true;
	}

	void sshWrite(key, data);
	return true;
}

export function resizeSsh(key: string, cols: number, rows: number): void {
	if (!sessions.get(key)?.connected) return;
	void sshResize(key, cols, rows);
}

export async function closeSshSession(key: string): Promise<void> {
	const entry = sessions.get(key);
	if (!entry) return;
	await sshDisconnect(key);
	entry.unlisten?.();
	entry.unlisten = null;
	entry.connected = false;
	sessions.delete(key);
}
