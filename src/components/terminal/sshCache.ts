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
 * ========================================================================== */

/** 会话键：按主机 id 派生，保证同一台主机复用同一条连接 */
export function sshKeyForHost(hostId: string): string {
	return `ssh:${hostId}`;
}

interface Entry {
	/** 整段会话输出（只留末尾 MAX_BUFFER 字符）：终端重挂载时靠它回放 */
	replay: string;
	subs: Set<(chunk: string) => void>;
	exitSubs: Set<(code: number | null) => void>;
	phase: SshPhase | null;
	phaseSubs: Set<(phase: SshPhase) => void>;
	connected: boolean;
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
			failed: null,
			unlisten: null,
		};
		sessions.set(key, entry);
	}
	return entry;
}

/** 会话是否已经建立（终端据此决定走 SSH 还是本地 shell） */
export function hasSshSession(key: string): boolean {
	return sessions.get(key)?.connected ?? false;
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

	// 先挂监听再发起连接：否则登录横幅会在监听就绪前发出而丢失
	if (!entry.unlisten) {
		entry.unlisten = await listenSsh(key, {
			onPhase: (phase) => {
				entry.phase = phase;
				for (const sub of entry.phaseSubs) sub(phase);
				onPhase?.(phase);
				if (phase.phase === "failed") entry.failed = phase.detail;
				if (phase.phase === "shell" && phase.ok) entry.connected = true;
			},
			onData: (chunk) => {
				// 关键：不管此刻有没有终端挂着都累积整段输出。
				// 只累积「没人看的那一段」的话，切到别的界面再回到工作区时，
				// 之前已经画在终端上的内容就永久丢了——切回来是一片空白，
				// 看起来就像会话没了。这里保留末尾 MAX_BUFFER，重新挂载时整段回放。
				entry.replay = (entry.replay + chunk).slice(-MAX_BUFFER);
				for (const sub of entry.subs) sub(chunk);
			},
			onExit: (code) => {
				entry.connected = false;
				for (const sub of entry.exitSubs) sub(code);
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
