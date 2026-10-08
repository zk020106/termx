import { isTauri, spawnLocalShell, type PtyHandle } from "@/lib/tauri";

/* =============================================================================
 * 终端会话缓存：把 PTY 会话挂在模块级，独立于 React 组件的生命周期。
 *
 * 在原生 Tauri 桌面端：调用 Rust portable-pty 真实 Shell。
 * 在 Web / 预览环境：自动降级为交互式 Mock Shell，支持输入、历史、常见内置命令。
 * ========================================================================== */

/** 回放缓冲上限，避免长会话占内存 */
const MAX_BUFFER = 64 * 1024;

class MockPtyHandle implements PtyHandle {
	private buffer = "";
	private prompt = "\x1b[32mtermx@local\x1b[0m:\x1b[34m~\x1b[0m$ ";

	constructor(private onChunk: (chunk: string) => void) {
		setTimeout(() => {
			this.onChunk(
				"\r\n\x1b[38;2;0;100;224m[TermX]\x1b[0m 本地终端 (Web 预览环境就绪)\r\n" +
				"支持命令：\x1b[32mhelp\x1b[0m、\x1b[32mls\x1b[0m、\x1b[32mwhoami\x1b[0m、\x1b[32mdate\x1b[0m、\x1b[32mclear\x1b[0m\r\n\r\n" +
				this.prompt,
			);
		}, 30);
	}

	async write(data: string): Promise<void> {
		for (let i = 0; i < data.length; i++) {
			const char = data[i];
			const code = data.charCodeAt(i);

			if (char === "\r" || char === "\n") {
				this.onChunk("\r\n");
				const cmd = this.buffer.trim();
				this.buffer = "";
				this.exec(cmd);
				this.onChunk(this.prompt);
			} else if (code === 127 || char === "\b") {
				if (this.buffer.length > 0) {
					this.buffer = this.buffer.slice(0, -1);
					this.onChunk("\b \b");
				}
			} else if (code === 3) {
				// Ctrl+C
				this.buffer = "";
				this.onChunk("^C\r\n" + this.prompt);
			} else if (code >= 32) {
				this.buffer += char;
				this.onChunk(char);
			}
		}
	}

	private exec(cmd: string) {
		if (!cmd) return;
		const [name, ...args] = cmd.split(" ");
		switch (name.toLowerCase()) {
			case "help":
				this.onChunk(
					"TermX 终端模拟命令：\r\n" +
					"  help        - 显示帮助\r\n" +
					"  ls          - 列出目录文件\r\n" +
					"  whoami      - 显示当前用户\r\n" +
					"  uname [-a]  - 显示系统架构\r\n" +
					"  date        - 查看当前系统时间\r\n" +
					"  clear       - 清空屏幕\r\n" +
					"  ping [host] - 发送网络探测包\r\n" +
					"  echo [text] - 回显指定文本\r\n",
				);
				break;
			case "ls":
				this.onChunk("bin   etc   home   lib   opt   root   tmp   usr   var   termx.config\r\n");
				break;
			case "whoami":
				this.onChunk("termx-user\r\n");
				break;
			case "uname":
				this.onChunk("Linux termx-local 6.6.0-x86_64 #1 SMP PREEMPT GNU/Linux\r\n");
				break;
			case "date":
				this.onChunk(new Date().toLocaleString() + "\r\n");
				break;
			case "clear":
				this.onChunk("\x1b[2J\x1b[H");
				break;
			case "echo":
				this.onChunk(args.join(" ") + "\r\n");
				break;
			case "ping":
				this.onChunk(`PING ${args[0] || "127.0.0.1"}: 64 data bytes\r\n64 bytes: icmp_seq=1 ttl=64 time=0.042 ms\r\n`);
				break;
			default:
				this.onChunk(`bash: ${name}: command not found\r\n`);
				break;
		}
	}

	async resize(): Promise<void> {}
	async kill(): Promise<void> {}
}

interface Entry {
	handle: PtyHandle | null;
	replay: string;
	subs: Set<(chunk: string) => void>;
	exitSubs: Set<(code: number | null) => void>;
	ready: Promise<boolean>;
}

const entries = new Map<string, Entry>();

export interface PtyAttachment {
	replay: string;
	ready: Promise<boolean>;
	detach: () => void;
}

export function ptySupported(): boolean {
	return true;
}

export function attachPty(
	paneId: string,
	cols: number,
	rows: number,
	onData: (chunk: string) => void,
	onExit: (code: number | null) => void,
): PtyAttachment | null {
	let entry = entries.get(paneId);

	if (!entry) {
		const subs = new Set<(chunk: string) => void>();
		const exitSubs = new Set<(code: number | null) => void>();
		const created: Entry = {
			handle: null,
			replay: "",
			subs,
			exitSubs,
			ready: Promise.resolve(false),
		};
		entries.set(paneId, created);

		if (isTauri()) {
			created.ready = spawnLocalShell(
				cols,
				rows,
				(chunk) => {
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
		} else {
			// Web 预览环境：自动挂载交互式 Mock PTY
			const mock = new MockPtyHandle((chunk) => {
				created.replay = (created.replay + chunk).slice(-MAX_BUFFER);
				for (const sub of subs) sub(chunk);
			});
			created.handle = mock;
			created.ready = Promise.resolve(true);
		}

		entry = created;
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
		},
	};
}

/** 显式关闭 PTY 会话（关闭标签或关闭分屏时调用） */
export function closePty(paneId: string): void {
	const entry = entries.get(paneId);
	if (entry) {
		entries.delete(paneId);
		void entry.handle?.kill();
	}
}

/** 写入键盘输入 */
export function writePty(paneId: string, data: string): boolean {
	const entry = entries.get(paneId);
	if (!entry?.handle) return false;
	void entry.handle.write(data);
	return true;
}

export function resizePty(paneId: string, cols: number, rows: number): void {
	void entries.get(paneId)?.handle?.resize(cols, rows);
}
