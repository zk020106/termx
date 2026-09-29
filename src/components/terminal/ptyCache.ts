import { isTauri, spawnLocalShell, type PtyHandle } from "@/lib/tauri";

/* =============================================================================
 * 终端会话缓存：把 PTY 会话挂在模块级，独立于 React 组件的生命周期。
 *
 * 为什么需要它：
 *  1. React 开发态（StrictMode）会对 effect 做「挂载 → 卸载 → 再挂载」的演练。
 *     如果 PTY 绑在组件上，第一次挂载起的 shell 会随 xterm 一起被丢弃，
 *     它的首屏输出（提示符）也就永久丢了 —— 表现为原生壳里终端一片空白。
 *  2. 分屏布局变化、标签切换都会重建终端组件；会话独立存活后，
 *     重新挂载只需回放缓冲即可接着用，符合需求书「断线/切换后终端内容保留」的取向。
 *     缓冲记的是**整段会话输出**（不只是没人看的那一段）：切到别的界面再回来时，
 *     只回放空窗期的数据会让终端一片空白，看起来像 shell 死了。
 *
 * 生命周期：最后一个订阅者离开后延迟销毁，避免「卸载→立刻重挂载」误杀 shell。
 * ========================================================================== */

const KILL_DELAY_MS = 1500;
/** 回放缓冲上限，避免长会话占内存 */
const MAX_BUFFER = 64 * 1024;

interface Entry {
	handle: PtyHandle | null;
	/** 整段会话输出（只留末尾 MAX_BUFFER 字符）：终端重挂载时靠它回放 */
	replay: string;
	subs: Set<(chunk: string) => void>;
	exitSubs: Set<(code: number | null) => void>;
	killTimer: number | null;
	ready: Promise<boolean>;
}

const entries = new Map<string, Entry>();

export interface PtyAttachment {
	/** 重新挂载时用于回放的整段既有输出 */
	replay: string;
	/** 会话是否真正起来了（false 时调用方应降级为演示模式） */
	ready: Promise<boolean>;
	detach: () => void;
}

/** 原生壳内才可能有真实 PTY */
export function ptySupported(): boolean {
	return isTauri();
}

export function attachPty(
	paneId: string,
	cols: number,
	rows: number,
	onData: (chunk: string) => void,
	onExit: (code: number | null) => void,
): PtyAttachment | null {
	if (!isTauri()) return null;

	let entry = entries.get(paneId);

	if (!entry) {
		const subs = new Set<(chunk: string) => void>();
		const exitSubs = new Set<(code: number | null) => void>();
		const created: Entry = {
			handle: null,
			replay: "",
			subs,
			exitSubs,
			killTimer: null,
			ready: Promise.resolve(false),
		};
		entries.set(paneId, created);

		created.ready = spawnLocalShell(
			cols,
			rows,
			(chunk) => {
				// 不管有没有订阅者都累积：重新挂载的终端要能回放整段会话，
				// 只记空窗期的话，切走再回来就是一片空白
				created.replay = (created.replay + chunk).slice(-MAX_BUFFER);
				for (const sub of subs) sub(chunk);
			},
			(code) => {
				for (const sub of exitSubs) sub(code);
			},
		)
			.then((handle) => {
				created.handle = handle;
				return handle !== null;
			})
			.catch(() => false);

		entry = created;
	}

	// 取消待执行的销毁：说明是「卸载→立刻重挂载」而不是真的离开
	if (entry.killTimer !== null) {
		window.clearTimeout(entry.killTimer);
		entry.killTimer = null;
	}

	entry.subs.add(onData);
	entry.exitSubs.add(onExit);

	const current = entry;
	const replay = current.replay;

	return {
		replay,
		ready: current.ready,
		detach: () => {
			current.subs.delete(onData);
			current.exitSubs.delete(onExit);
			if (current.subs.size > 0) return;

			current.killTimer = window.setTimeout(() => {
				if (current.subs.size > 0) return;
				entries.delete(paneId);
				current.handle?.kill();
			}, KILL_DELAY_MS);
		},
	};
}

/** 写入键盘输入；会话未就绪时返回 false，调用方应走演示回显 */
export function writePty(paneId: string, data: string): boolean {
	const entry = entries.get(paneId);
	if (!entry?.handle) return false;
	entry.handle.write(data);
	return true;
}

export function resizePty(paneId: string, cols: number, rows: number): void {
	entries.get(paneId)?.handle?.resize(cols, rows);
}
