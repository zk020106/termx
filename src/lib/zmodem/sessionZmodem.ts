/**
 * 每条 SSH 会话的 ZMODEM：把 Rust 闸门推来的原始字节（ssh://zmodem/{key}）交给
 * zmodemHelper.createZmodemSentry（Netcatty 同款逻辑），并把 Node / Electron 能力换成 Tauri 命令：
 *   stream.write → ssh_write_bytes（按顺序串行发送）；stream 'drain' → ssh_drain
 *   dialog + fs → zmodem_pick_upload_files / zmodem_read_chunk / zmodem_pick_download_dir / zmodem_create_file …
 *   probeReceiveConflicts / removeRemoteFiles / restoreRemoteModes → 同样的脚本走 ssh_exec
 *   requestOverwriteDecision → 界面里的覆盖确认框（Netcatty ZmodemOverwriteDialog，120 秒不答按「跳过」）
 * 传输结束（且过了取消后的冷却期）调 ssh_zmodem_release，会话输出回到 Rust 的文本解码通道。
 */
import { create } from "zustand";
import { sshExec } from "@/lib/ssh";
import { toast } from "@/store/toast";
import { createZmodemSentry, type OverwriteDecision, type PickedUploadFile, type ZmodemSentryWrapper } from "./zmodemHelper";
import {
	initialZmodemTransferState,
	reduceZmodemTransferState,
	resolveZmodemTransferToast,
	type ZmodemTransferState,
} from "./zmodemTransfer";

interface ZmodemUiState {
	transfers: Record<string, ZmodemTransferState>;
	overwrite: Record<string, { filename: string; resolve: (d: OverwriteDecision) => void } | undefined>;
}

export const useZmodemStore = create<ZmodemUiState>(() => ({ transfers: {}, overwrite: {} }));

function b64encode(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}
function b64decode(data: string): Uint8Array {
	const bin = atob(data);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const quoteShellArg = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** Netcatty sessionOps.probeReceiveConflicts 的脚本（找 rz 所在目录，列出同名文件与权限） */
const PROBE_SCRIPT = `SELF=$$
find_login_shell() {
  ps -e -o pid=,ppid=,tty=,comm= 2>/dev/null | awk -v pp="$1" -v self="$SELF" '
    $1 != self && $2 == pp && $4 ~ /^-?(ba|z|fi|k|da|a)?sh$/ {
      if ($3 != "?") { print $1; found=1; exit }
      if (any == "") any=$1
    }
    END { if (!found && any != "") print any }'
}
find_fg_leaf() {
  ps -e -o pid=,ppid=,stat=,comm= 2>/dev/null | awk -v start="$1" '
    { pp[$1]=$2; st[$1]=$3; ord[NR]=$1 }
    function depth(p,  d){ d=0; while(p!="" && d<64){ if(p==start) return d; p=pp[p]; d++ } return -1 }
    END { best=-1; bp=""; for(i=1;i<=NR;i++){ p=ord[i];
      if(index(st[p],"+")==0) continue; d=depth(p); if(d<0) continue;
      if(d>best){best=d; bp=p} } print bp }'
}
login=$(find_login_shell "$PPID")
[ -n "$login" ] || exit 0
leaf=$(find_fg_leaf "$login")
[ -n "$leaf" ] || leaf="$login"
dir=$(readlink /proc/$leaf/cwd 2>/dev/null)
[ -n "$dir" ] || exit 0
printf 'DIR\\t%s\\n' "$dir"
cd "$dir" 2>/dev/null || exit 0
for n in "$@"; do
  [ -e "$n" ] || continue
  m=$(stat -c %a -- "$n" 2>/dev/null || stat -f %Lp -- "$n" 2>/dev/null)
  printf 'EXIST\\t%s\\t%s\\n' "$n" "$m"
done`;

interface SessionZmodem {
	wrapper: ZmodemSentryWrapper;
	decoder: TextDecoder;
	encoding: string;
	deliver: (text: string) => void;
	releaseTimer: ReturnType<typeof setTimeout> | null;
	released: boolean;
}

const sessions = new Map<string, SessionZmodem>();
/** 写队列：Tauri IPC 不保证并发调用的顺序，协议字节必须串行发出 */
const writeChains = new Map<string, { chain: Promise<void>; pending: number }>();
const BACKPRESSURE_BYTES = 1024 * 1024;

function makeDecoder(encoding: string): TextDecoder {
	try {
		return new TextDecoder(encoding);
	} catch {
		return new TextDecoder("utf-8");
	}
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<T>(cmd, args);
}

function emitTransfer(key: string, event: Parameters<typeof reduceZmodemTransferState>[1]) {
	useZmodemStore.setState((s) => {
		const next = reduceZmodemTransferState(s.transfers[key] ?? initialZmodemTransferState, event);
		const toastInfo = event.type === "complete" || event.type === "error" ? resolveZmodemTransferToast(next) : null;
		if (toastInfo) {
			toast({ title: toastInfo.title, description: toastInfo.message, tone: toastInfo.kind === "error" ? "danger" : "success" });
		}
		return { transfers: { ...s.transfers, [key]: next } };
	});
}

function scheduleRelease(key: string) {
	const st = sessions.get(key);
	if (!st) return;
	if (st.releaseTimer) clearTimeout(st.releaseTimer);
	st.releaseTimer = setTimeout(() => {
		st.releaseTimer = null;
		if (st.wrapper.isActive()) return;
		if (st.wrapper.isCoolingDown()) {
			scheduleRelease(key);
			return;
		}
		// 解码器里残留的半个字符冲掉，交还 Rust 解码
		const tail = st.decoder.decode();
		if (tail) st.deliver(tail);
		st.released = true;
		void invokeTauri("ssh_zmodem_release", { key }).catch(() => undefined);
	}, 250);
}

function createSession(key: string, encoding: string, deliver: (text: string) => void): SessionZmodem {
	const writeToRemote = (bytes: Uint8Array): boolean => {
		const state = writeChains.get(key) ?? { chain: Promise.resolve(), pending: 0 };
		writeChains.set(key, state);
		state.pending += bytes.length;
		const data = b64encode(bytes);
		state.chain = state.chain
			.then(() => invokeTauri<void>("ssh_write_bytes", { key, data }))
			.catch(() => undefined)
			.finally(() => {
				state.pending -= bytes.length;
			});
		return state.pending < BACKPRESSURE_BYTES;
	};
	const wrapper = createZmodemSentry({
		label: "SSH",
		onData: (bytes) => {
			const text = session.decoder.decode(bytes, { stream: true });
			if (text) session.deliver(text);
		},
		writeToRemote,
		waitForTransportDrain: async () => {
			await (writeChains.get(key)?.chain ?? Promise.resolve());
			await invokeTauri<void>("ssh_drain", { key });
		},
		selectUploadFiles: async () => (await invokeTauri<PickedUploadFile[] | null>("zmodem_pick_upload_files", {})) ?? null,
		readChunk: async (token, offset, length) => new Uint8Array(await invokeTauri<ArrayBuffer>("zmodem_read_chunk", { token, offset, length })),
		releaseFiles: (tokens) => void invokeTauri("zmodem_release_files", { tokens }).catch(() => undefined),
		selectDownloadDirectory: async () => (await invokeTauri<string | null>("zmodem_pick_download_dir", {})) ?? null,
		createFile: (dirToken, name) => invokeTauri<{ token: string; name: string }>("zmodem_create_file", { dirToken, name }),
		writeChunk: (token, bytes) => invokeTauri<void>("zmodem_write_chunk", { token, data: b64encode(bytes) }),
		finishFile: (token, completed) => invokeTauri<void>("zmodem_finish_file", { token, completed }),
		probeReceiveConflicts: async (names) => {
			const argv = names.map(quoteShellArg).join(" ");
			try {
				const { stdout } = await sshExec(key, `exec sh -c ${quoteShellArg(PROBE_SCRIPT)} sh ${argv}`, 5000);
				let dir: string | null = null;
				const existing: string[] = [];
				const modes: Record<string, string> = {};
				for (const line of stdout.split("\n")) {
					const [tag, val, mode] = line.split("\t");
					if (tag === "DIR") dir = val;
					else if (tag === "EXIST" && val) {
						existing.push(val);
						if (mode && /^[0-7]{3,4}$/.test(mode)) modes[val] = mode;
					}
				}
				return dir ? { dir, existing, modes } : null;
			} catch {
				return null;
			}
		},
		removeRemoteFiles: async (paths) => {
			const argv = paths.map(quoteShellArg).join(" ");
			await sshExec(key, `exec sh -c 'rm -f -- "$@"' sh ${argv}`, 5000).catch(() => undefined);
		},
		restoreRemoteModes: async (entries) => {
			const args: string[] = [];
			for (const e of entries) {
				if (!e || !e.path || !/^[0-7]{3,4}$/.test(String(e.mode))) continue;
				args.push(quoteShellArg(String(e.mode)), quoteShellArg(e.path));
			}
			if (!args.length) return;
			const script = 'while [ "$#" -ge 2 ]; do chmod "$1" "$2" 2>/dev/null; shift 2; done';
			await sshExec(key, `exec sh -c ${quoteShellArg(script)} sh ${args.join(" ")}`, 5000).catch(() => undefined);
		},
		requestOverwriteDecision: (filename) =>
			new Promise<OverwriteDecision>((resolve) => {
				const timer = setTimeout(() => finish({ action: "skip", applyToRest: false }), 120000);
				const finish = (d: OverwriteDecision) => {
					clearTimeout(timer);
					useZmodemStore.setState((s) => ({ overwrite: { ...s.overwrite, [key]: undefined } }));
					resolve(d);
				};
				useZmodemStore.setState((s) => ({ overwrite: { ...s.overwrite, [key]: { filename, resolve: finish } } }));
			}),
		emit: (event) => {
			emitTransfer(key, event);
			if (event.type === "complete" || event.type === "error") scheduleRelease(key);
		},
	});
	const session: SessionZmodem = { wrapper, decoder: makeDecoder(encoding), encoding, deliver, releaseTimer: null, released: false };
	return session;
}

/** Rust 闸门推来一段原始字节：交给 Sentry；非 ZMODEM 的部分按会话编码解码后照常送进终端 */
export function consumeZmodemChunk(key: string, chunk: { encoding: string; data: string }, deliver: (text: string) => void): void {
	let st = sessions.get(key);
	if (!st || st.encoding !== chunk.encoding) {
		st = createSession(key, chunk.encoding, deliver);
		sessions.set(key, st);
	}
	st.deliver = deliver;
	st.released = false;
	st.wrapper.consume(b64decode(chunk.data));
	// 误报（Sentry 否认 / 收回）或者传输已经结束：交还解码通道
	if (!st.wrapper.isActive()) scheduleRelease(key);
}

/**
 * 终端键入拦截（Netcatty terminalBridge.writeToSession：ZMODEM 传输期间屏蔽终端输入，Ctrl+C 取消传输）。
 * 返回 true 表示输入已被吞掉。
 */
export function interceptZmodemInput(key: string, data: string): boolean {
	const st = sessions.get(key);
	if (!st?.wrapper.isActive()) return false;
	if (data === "\x03") cancelZmodem(key);
	return true;
}

/** 进度条上的「取消传输」 */
export function cancelZmodem(key: string): void {
	sessions.get(key)?.wrapper.cancel();
	scheduleRelease(key);
}

export function respondZmodemOverwrite(key: string, action: OverwriteDecision["action"], applyToRest: boolean): void {
	useZmodemStore.getState().overwrite[key]?.resolve({ action, applyToRest });
}

/** 会话结束：清掉状态（Netcatty：会话退出时进度条复位） */
export function disposeZmodemSession(key: string): void {
	const st = sessions.get(key);
	if (st?.releaseTimer) clearTimeout(st.releaseTimer);
	sessions.delete(key);
	writeChains.delete(key);
	useZmodemStore.setState((s) => {
		const transfers = { ...s.transfers };
		delete transfers[key];
		const pending = s.overwrite[key];
		pending?.resolve({ action: "cancel" });
		return { transfers, overwrite: { ...s.overwrite, [key]: undefined } };
	});
}
