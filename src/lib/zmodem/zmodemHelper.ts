/**
 * ZMODEM —— 移植自 Netcatty electron/bridges/zmodemHelper.cjs（同一个 zmodem.js 0.1.10 Sentry）。
 *
 * Netcatty 在 Electron 主进程里跑这段逻辑，直接用 Node 的 fs / dialog / stream.write。
 * Tauri 下主进程是 Rust，所以这段跑在前端，Node 能力换成 {@link ZmodemBridge}：
 *   - Buffer → Uint8Array（下面的 bytes* 小工具）
 *   - dialog.showOpenDialog → bridge.selectUploadFiles / selectDownloadDirectory（Rust 原生对话框，返回令牌）
 *   - fs.openSync/readSync → bridge.readChunk；fs.createWriteStream → bridge.createFile/writeChunk/finishFile
 *   - stream.write 的背压 → writeToRemote 返回 false + bridge.waitForTransportDrain（Rust 会话队列排空）
 *   - safeSend(webContents, "netcatty:zmodem:*") → bridge.emit
 * 判定、超时、取消、冷却、回显剥离、覆盖确认、权限恢复等逻辑保持原样。
 * 拖放上传（queueDragDropUpload）依赖 Netcatty 的终端拖放 + 临时文件，termx 没有移植。
 */
// zmodem.js 是 CommonJS，没有类型声明
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import ZmodemModule from "zmodem.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Zmodem: any = (ZmodemModule as any)?.Sentry ? ZmodemModule : (ZmodemModule as any)?.default ?? ZmodemModule;

/* ------------------------------ Buffer 替身 ------------------------------ */

const enc = new TextEncoder();
const fromString = (s: string): Uint8Array => enc.encode(s);
const toBytes = (octets: ArrayLike<number> | ArrayBuffer | Uint8Array): Uint8Array =>
	octets instanceof Uint8Array ? octets : octets instanceof ArrayBuffer ? new Uint8Array(octets) : Uint8Array.from(octets as ArrayLike<number>);
function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
	return true;
}
function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
	outer: for (let i = from; i + needle.length <= hay.length; i += 1) {
		for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}

/* ------------------------------ 纯函数（原样） ------------------------------ */

export type OverwriteAction = "overwrite" | "skip" | "cancel";
export type OverwriteDecision = { action: OverwriteAction; applyToRest?: boolean };

/** Netcatty buildUploadPlan */
export async function buildUploadPlan(
	names: string[],
	existingList: string[],
	resolveDecision: (name: string) => Promise<OverwriteDecision | null | undefined>,
): Promise<{ offerIndices: number[]; removeIndices: number[]; aborted: boolean }> {
	const existing = new Set(existingList);
	const offerIndices: number[] = [];
	const removeIndices: number[] = [];
	let bulkAction: OverwriteAction | null = null;
	for (let idx = 0; idx < names.length; idx++) {
		const name = names[idx];
		if (!existing.has(name)) {
			offerIndices.push(idx);
			continue;
		}
		let action: OverwriteAction | null = bulkAction;
		if (!action) {
			const decision = (await resolveDecision(name)) || { action: "skip" as const };
			action = decision.action;
			if (decision.applyToRest && action !== "cancel") bulkAction = action;
		}
		if (action === "cancel") return { offerIndices: [], removeIndices: [], aborted: true };
		if (action === "overwrite") {
			removeIndices.push(idx);
			offerIndices.push(idx);
		}
	}
	return { offerIndices, removeIndices, aborted: false };
}

/** Netcatty buildModeRestores */
export function buildModeRestores(
	dir: string,
	names: string[],
	removeIndices: number[],
	modes: Record<string, string> | null | undefined,
): Array<{ path: string; mode: string }> {
	const base = String(dir).replace(/\/+$/, "");
	const seen = new Set<string>();
	const restores: Array<{ path: string; mode: string }> = [];
	for (const i of removeIndices) {
		const name = names[i];
		const mode = modes && modes[name];
		if (!mode) continue;
		const target = `${base}/${name}`;
		if (seen.has(target)) continue;
		seen.add(target);
		restores.push({ path: target, mode });
	}
	return restores;
}

/* ------------------------------ 桥接接口 ------------------------------ */

export interface PickedUploadFile {
	token: string;
	name: string;
	size: number;
	mtimeMs: number;
}

export type ZmodemEvent =
	| { type: "detect"; transferType: "upload" | "download" }
	| {
			type: "progress";
			filename: string;
			transferred: number;
			total: number;
			fileIndex: number;
			fileCount: number;
			transferType: "upload" | "download";
			finalizing?: boolean;
	  }
	| { type: "complete" }
	| { type: "error"; error: string };

export interface ZmodemBridge {
	/** 原始字节写回远端；返回 false 表示传输层积压（同 stream.write） */
	writeToRemote: (bytes: Uint8Array) => boolean | void;
	waitForTransportDrain?: (opts?: { signal?: AbortSignal }) => Promise<void>;
	interruptRemote?: () => void;
	selectUploadFiles: () => Promise<PickedUploadFile[] | null>;
	readChunk: (token: string, offset: number, length: number) => Promise<Uint8Array>;
	releaseFiles?: (tokens: string[]) => void;
	selectDownloadDirectory: () => Promise<string | null>;
	createFile: (dirToken: string, name: string) => Promise<{ token: string; name: string }>;
	writeChunk: (token: string, bytes: Uint8Array) => Promise<void>;
	finishFile: (token: string, completed: boolean) => Promise<void>;
	probeReceiveConflicts?: (names: string[]) => Promise<{ dir: string; existing: string[]; modes?: Record<string, string> } | null>;
	removeRemoteFiles?: (paths: string[]) => Promise<void>;
	restoreRemoteModes?: (entries: Array<{ path: string; mode: string }>) => Promise<void>;
	requestOverwriteDecision?: (filename: string) => Promise<OverwriteDecision>;
	emit: (event: ZmodemEvent) => void;
}

export interface ZmodemSentryOptions extends ZmodemBridge {
	/** 正常（非 ZMODEM）输出的原始字节，由调用方按会话编码解码 */
	onData: (bytes: Uint8Array) => void;
	label?: string;
	uploadFileEndTimeoutMs?: number;
	slowUploadFileEndTimeoutMs?: number;
	uploadSessionCloseTimeoutMs?: number;
}

/* ------------------------------ 常量与工具（原样） ------------------------------ */

const UPLOAD_FILE_END_TIMEOUT_MS = 45000;
const UPLOAD_BACKPRESSURE_FILE_END_TIMEOUT_MS = 120000;
const UPLOAD_SESSION_CLOSE_TIMEOUT_MS = 15000;
export const UPLOAD_CHUNK_SIZE = 64 * 1024;

type CodedError = Error & { code?: string };

function resolveTimeoutMs(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function withTimeout<T>(promise: Promise<T> | T, ms: number, message = "ZMODEM handshake timeout"): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		Promise.resolve(promise),
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => {
				const err: CodedError = new Error(message);
				err.code = "NETCATTY_ZMODEM_TIMEOUT";
				reject(err);
			}, ms);
		}),
	]).finally(() => clearTimeout(timer));
}

const isZmodemTimeoutError = (err: unknown) => (err as CodedError)?.code === "NETCATTY_ZMODEM_TIMEOUT";
const isZmodemCancelledError = (err: unknown) => (err as CodedError)?.code === "NETCATTY_ZMODEM_CANCELLED";
function createZmodemCancelledError(): CodedError {
	const err: CodedError = new Error("Transfer cancelled");
	err.code = "NETCATTY_ZMODEM_CANCELLED";
	return err;
}

function racePromiseWithAbortSignal(promise: Promise<void> | void, signal?: AbortSignal): Promise<void> {
	if (!signal) return Promise.resolve(promise);
	if (signal.aborted) return Promise.reject(createZmodemCancelledError());
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(createZmodemCancelledError());
		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(promise).then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

/** Netcatty createZmodemUploadDrainWaiter */
export function createZmodemUploadDrainWaiter(opts: {
	getNeedsDrain: () => boolean;
	clearNeedsDrain: () => void;
	waitForTransportDrain?: (opts?: { signal?: AbortSignal }) => Promise<void> | void;
	signal?: AbortSignal;
	onUploadTimeout?: () => void;
	writeToRemote?: (data: Uint8Array) => unknown;
}): () => Promise<void> {
	return async function waitForDrain() {
		if (!opts.getNeedsDrain()) return;
		if (typeof opts.waitForTransportDrain === "function") {
			try {
				const drainOpts = opts.signal ? { signal: opts.signal } : undefined;
				await racePromiseWithAbortSignal(opts.waitForTransportDrain(drainOpts), opts.signal);
			} catch (err) {
				if (isZmodemTimeoutError(err)) {
					try {
						opts.onUploadTimeout?.();
					} catch {
						/* ignore */
					}
					if (typeof opts.writeToRemote === "function") abortRemoteProcess(opts.writeToRemote);
				}
				throw err;
			} finally {
				opts.clearNeedsDrain();
			}
			return;
		}
		opts.clearNeedsDrain();
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
}

/** Netcatty abortRemoteProcess：8 个 CAN，150ms 后补一个 Ctrl+C */
function abortRemoteProcess(writeToRemote: (data: Uint8Array) => unknown) {
	try {
		writeToRemote(new Uint8Array([0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18]));
	} catch {
		/* ignore */
	}
	setTimeout(() => {
		try {
			writeToRemote(fromString("\x03"));
		} catch {
			/* ignore */
		}
	}, 150);
}

interface TransferOpts extends ZmodemSentryOptions {
	hasUploadBackpressure: () => boolean;
	resetUploadBackpressure: () => void;
	onUploadTimeout: () => void;
	waitForDrain: () => Promise<void>;
}

function resolveUploadFileEndTimeoutMs(opts: TransferOpts) {
	const normalTimeout = resolveTimeoutMs(opts.uploadFileEndTimeoutMs, UPLOAD_FILE_END_TIMEOUT_MS);
	const slowTimeout = resolveTimeoutMs(opts.slowUploadFileEndTimeoutMs, UPLOAD_BACKPRESSURE_FILE_END_TIMEOUT_MS);
	return opts.hasUploadBackpressure?.() ? Math.max(normalTimeout, slowTimeout) : normalTimeout;
}

async function waitForUploadHandshake<T>(promise: Promise<T>, ms: number, message: string, opts: TransferOpts): Promise<T> {
	try {
		return await withTimeout(promise, ms, message);
	} catch (err) {
		if (isZmodemTimeoutError(err)) {
			try {
				opts.onUploadTimeout?.();
			} catch {
				/* ignore */
			}
			abortRemoteProcess(opts.writeToRemote);
		}
		throw err;
	}
}

/* ------------------------------ 传输（原样逻辑） ------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ZSession = any;

async function handleTransfer(zsession: ZSession, transferType: "upload" | "download", opts: TransferOpts) {
	if (transferType === "upload") await handleUpload(zsession, opts);
	else await handleDownload(zsession, opts);
}

/** 上传（远端执行了 rz） */
export async function handleUpload(zsession: ZSession, opts: TransferOpts): Promise<void> {
	const yieldToIO = () => new Promise((resolve) => setTimeout(resolve, 0));
	const uploadSessionCloseTimeoutMs = resolveTimeoutMs(opts.uploadSessionCloseTimeoutMs, UPLOAD_SESSION_CLOSE_TIMEOUT_MS);

	const picked = await opts.selectUploadFiles();
	if (!picked || !picked.length) {
		try {
			zsession.abort();
		} catch {
			/* ignore */
		}
		abortRemoteProcess(opts.writeToRemote);
		throw new Error("Transfer cancelled");
	}
	const allNames = picked.map((f) => f.name);

	try {
		let plan = { offerIndices: allNames.map((_, i) => i), removeIndices: [] as number[], aborted: false };
		let probeDir: string | null = null;
		let probeModes: Record<string, string> | null = null;
		if (opts.probeReceiveConflicts && opts.requestOverwriteDecision) {
			try {
				const probe = await opts.probeReceiveConflicts(allNames);
				if (probe && probe.dir && Array.isArray(probe.existing) && probe.existing.length > 0) {
					probeDir = probe.dir;
					probeModes = probe.modes || {};
					plan = await buildUploadPlan(allNames, probe.existing, opts.requestOverwriteDecision);
					if (plan.aborted) {
						try {
							zsession.abort();
						} catch {
							/* ignore */
						}
						abortRemoteProcess(opts.writeToRemote);
						throw new Error("Transfer cancelled");
					}
					if (plan.removeIndices.length && opts.removeRemoteFiles) {
						const base = probe.dir.replace(/\/+$/, "");
						const targets = [...new Set(plan.removeIndices.map((i) => `${base}/${allNames[i]}`))];
						try {
							await opts.removeRemoteFiles(targets);
						} catch {
							/* rz 会跳过 */
						}
					}
				}
			} catch (err) {
				if (err instanceof Error && err.message === "Transfer cancelled") throw err;
			}
		}

		const offers = plan.offerIndices.map((i) => ({ originalIndex: i, file: picked[i], name: allNames[i] }));
		const skippedOfferIndices: number[] = [];

		for (let i = 0; i < offers.length; i++) {
			const { originalIndex, file, name } = offers[i];
			opts.resetUploadBackpressure?.();
			opts.emit({ type: "progress", filename: name, transferred: 0, total: file.size, fileIndex: i, fileCount: offers.length, transferType: "upload" });

			let bytesRemaining = 0;
			for (let j = i; j < offers.length; j++) bytesRemaining += offers[j].file.size;

			const xfer = await zsession.send_offer({
				name,
				size: file.size,
				mtime: new Date(file.mtimeMs),
				files_remaining: offers.length - i,
				bytes_remaining: bytesRemaining,
			});

			if (!xfer) {
				skippedOfferIndices.push(originalIndex);
				continue;
			}

			let sent = 0;
			while (true) {
				const chunk = await opts.readChunk(file.token, sent, UPLOAD_CHUNK_SIZE);
				if (chunk.length === 0) break;
				xfer.send(chunk);
				sent += chunk.length;
				opts.emit({ type: "progress", filename: name, transferred: sent, total: file.size, fileIndex: i, fileCount: offers.length, transferType: "upload" });
				if (opts.waitForDrain) await opts.waitForDrain();
				await yieldToIO();
			}
			opts.emit({
				type: "progress",
				filename: name,
				transferred: file.size,
				total: file.size,
				fileIndex: i,
				fileCount: offers.length,
				transferType: "upload",
				finalizing: true,
			});
			await waitForUploadHandshake(
				xfer.end(),
				resolveUploadFileEndTimeoutMs(opts),
				`Remote did not confirm receiving ${name}. The upload was stopped so the terminal can recover.`,
				opts,
			);
		}

		const restoreAcceptedOverwriteModes = async (skippedIndices?: number[]) => {
			if (!plan.removeIndices.length || !probeDir || !opts.restoreRemoteModes) return;
			const skippedSet = skippedIndices?.length ? new Set(skippedIndices) : null;
			const restoreIndices = skippedSet ? plan.removeIndices.filter((i) => !skippedSet.has(i)) : plan.removeIndices;
			if (!restoreIndices.length) return;
			const restores = buildModeRestores(probeDir, allNames, restoreIndices, probeModes);
			if (!restores.length) return;
			try {
				await opts.restoreRemoteModes(restores);
			} catch {
				/* ignore */
			}
		};

		if (skippedOfferIndices.length > 0) {
			try {
				zsession.abort();
			} catch {
				/* ignore */
			}
			abortRemoteProcess(opts.writeToRemote);
			await restoreAcceptedOverwriteModes(skippedOfferIndices);
			const listed = skippedOfferIndices.map((idx) => allNames[idx]).join(", ");
			throw new Error(
				skippedOfferIndices.length === offers.length
					? `Remote protected existing files and skipped the upload (not overwritten): ${listed}`
					: `Remote skipped some files (not overwritten): ${listed}`,
			);
		}

		await waitForUploadHandshake(
			zsession.close(),
			uploadSessionCloseTimeoutMs,
			"Remote did not finish the ZMODEM upload session in time. The upload was stopped so the terminal can recover.",
			opts,
		);
		await restoreAcceptedOverwriteModes();
	} finally {
		opts.releaseFiles?.(picked.map((f) => f.token));
	}
}

/** 下载缓冲：zmodem.js 每个子包（≤1KB）回调一次，攒到 256KB 再交给 Rust 写盘 */
const DOWNLOAD_FLUSH_BYTES = 256 * 1024;

/** 下载（远端执行了 sz） */
export async function handleDownload(zsession: ZSession, opts: TransferOpts): Promise<void> {
	let fileIndex = 0;
	type Pending = { token: Promise<string>; completed: boolean; done: Promise<void> };
	const pendingFiles: Pending[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const pendingOffers: any[] = [];
	let lastProgressTime = 0;
	let downloadDir: string | null = null;
	let rejectSession: (err: unknown) => void = () => {};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const processOffer = (xfer: any, reject: (err: unknown) => void) => {
		if (!downloadDir) {
			pendingOffers.push(xfer);
			return;
		}
		const detail = xfer.get_details();
		const rawName: string = detail.name || `untitled_${Date.now()}`;
		const size: number = detail.size || 0;
		const currentIndex = fileIndex++;
		let shownName = rawName.split(/[\\/]/).pop() || rawName;
		opts.emit({ type: "progress", filename: shownName, transferred: 0, total: size, fileIndex: currentIndex, fileCount: -1, transferType: "download" });

		// 文件名只取 basename、重名追加 (1)(2)… 都在 Rust 侧（zmodem_create_file）
		const tokenPromise = opts.createFile(downloadDir, rawName).then((f) => {
			shownName = f.name;
			return f.token;
		});
		let chain: Promise<unknown> = tokenPromise;
		let buffered: Uint8Array[] = [];
		let bufferedBytes = 0;
		let received = 0;
		let writeAborted = false;
		const flush = () => {
			if (!bufferedBytes) return;
			const data = concatBytes(...buffered);
			buffered = [];
			bufferedBytes = 0;
			chain = chain.then(() => tokenPromise).then((token) => opts.writeChunk(token, data));
			chain.catch((err) => {
				writeAborted = true;
				reject(err);
			});
		};
		const entry: Pending = { token: tokenPromise, completed: false, done: Promise.resolve() };
		pendingFiles.push(entry);
		tokenPromise.catch((err) => {
			writeAborted = true;
			reject(err);
		});

		xfer
			.accept({
				on_input(payload: ArrayLike<number>) {
					if (writeAborted) return;
					const chunk = toBytes(payload);
					buffered.push(chunk);
					bufferedBytes += chunk.length;
					received += chunk.length;
					if (bufferedBytes >= DOWNLOAD_FLUSH_BYTES) flush();
					const now = Date.now();
					if (now - lastProgressTime >= 100) {
						lastProgressTime = now;
						opts.emit({ type: "progress", filename: shownName, transferred: received, total: size, fileIndex: currentIndex, fileCount: -1, transferType: "download" });
					}
				},
			})
			.catch((err: unknown) => reject(err));

		xfer.on("complete", () => {
			entry.completed = true;
			flush();
			entry.done = chain.then(() => undefined);
		});
	};

	const sessionPromise = new Promise<void>((resolve, reject) => {
		rejectSession = reject;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		zsession.on("offer", (xfer: any) => {
			try {
				processOffer(xfer, reject);
			} catch (err) {
				reject(err);
			}
		});
		zsession.on("session_end", async () => {
			try {
				await Promise.all(
					pendingFiles.map(async (entry) => {
						const token = await entry.token.catch(() => null);
						if (!token) return;
						await entry.done.catch(() => undefined);
						// 没收完的文件删掉（Netcatty：Clean up partial downloads）
						await opts.finishFile(token, entry.completed).catch(() => undefined);
					}),
				);
			} catch {
				/* ignore */
			}
			resolve();
		});
	});

	// 先 start 再弹目录选择：lrzsz 等 ZRINIT 不会超时
	zsession.start();

	const dir = await opts.selectDownloadDirectory();
	if (!dir) {
		try {
			zsession.abort();
		} catch {
			/* ignore */
		}
		abortRemoteProcess(opts.writeToRemote);
		void sessionPromise.catch(() => {});
		throw new Error("Transfer cancelled");
	}
	downloadDir = dir;
	while (pendingOffers.length) processOffer(pendingOffers.shift(), rejectSession);
	try {
		await sessionPromise;
	} finally {
		opts.releaseFiles?.([dir]);
	}
}

/* ------------------------------ Sentry 包装（原样逻辑） ------------------------------ */

export interface ZmodemSentryWrapper {
	consume: (data: Uint8Array) => void;
	isActive: () => boolean;
	/** 冷却期（取消 / 出错后吞掉残余协议字节的 2 秒） */
	isCoolingDown: () => boolean;
	cancel: () => void;
}

export function createZmodemSentry(opts: ZmodemSentryOptions): ZmodemSentryWrapper {
	const { onData, writeToRemote, interruptRemote, emit } = opts;

	let active = false;
	let currentZSession: ZSession = null;
	let _needsDrain = false;
	let _sawUploadBackpressure = false;
	let transferAbortController: AbortController | null = null;
	const pendingEchoes: Array<{ buf: Uint8Array; expiresAt: number }> = [];
	let pendingTerminalSuppression: Uint8Array | null = null;
	let cancelInterruptTimer: ReturnType<typeof setTimeout> | null = null;
	let ignoreDetectionUntil = 0;
	let cooldownUntil = 0;
	const COOLDOWN_MS = 2000;
	const ECHO_TTL_MS = 1500;
	const ECHO_MAX_BYTES = 256;

	function prunePendingEchoes(now = Date.now()) {
		while (pendingEchoes.length && pendingEchoes[0].expiresAt <= now) pendingEchoes.shift();
	}

	function rememberOutgoingEcho(octets: Uint8Array) {
		const buf = Uint8Array.from(octets);
		if (!buf.length || buf.length > ECHO_MAX_BYTES) return;
		prunePendingEchoes();
		pendingEchoes.push({ buf, expiresAt: Date.now() + ECHO_TTL_MS });
	}

	function stripEchoedOutgoingData(data: Uint8Array): Uint8Array {
		if (!pendingEchoes.length) return data;
		prunePendingEchoes();
		let buf = data;
		while (pendingEchoes.length && buf.length) {
			const nextEcho = pendingEchoes[0].buf;
			if (buf.length < nextEcho.length) break;
			if (!bytesEqual(buf.subarray(0, nextEcho.length), nextEcho)) break;
			buf = buf.subarray(nextEcho.length);
			pendingEchoes.shift();
		}
		return buf;
	}

	function stripPendingTerminalSuppression(data: Uint8Array): Uint8Array {
		if (!pendingTerminalSuppression?.length) return data;
		let buf = data;
		const fullMatchAt = indexOfBytes(buf, pendingTerminalSuppression);
		if (fullMatchAt !== -1) {
			buf = concatBytes(buf.subarray(0, fullMatchAt), buf.subarray(fullMatchAt + pendingTerminalSuppression.length));
			pendingTerminalSuppression = null;
			return buf;
		}
		const maxMatch = Math.min(pendingTerminalSuppression.length, buf.length);
		let matchLen = 0;
		while (matchLen < maxMatch && buf[matchLen] === pendingTerminalSuppression[matchLen]) matchLen += 1;
		if (!matchLen) return buf;
		buf = buf.subarray(matchLen);
		pendingTerminalSuppression = matchLen === pendingTerminalSuppression.length ? null : pendingTerminalSuppression.subarray(matchLen);
		return buf;
	}

	function stripVisibleZmodemHeaders(data: Uint8Array): Uint8Array {
		let buf = data;
		let searchFrom = 0;
		const prefix = new Uint8Array([0x2a, 0x2a, 0x18, 0x42]);
		while (searchFrom < buf.length) {
			const prefixAt = indexOfBytes(buf, prefix, searchFrom);
			if (prefixAt === -1) break;
			const minHeaderLength = 20;
			if (buf.length - prefixAt < minHeaderLength) break;
			let isHexHeader = true;
			for (let i = 0; i < 14; i += 1) {
				const byte = buf[prefixAt + 4 + i];
				const isHexDigit = (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
				if (!isHexDigit) {
					isHexHeader = false;
					break;
				}
			}
			if (!isHexHeader) {
				searchFrom = prefixAt + 1;
				continue;
			}
			let headerLength = 18;
			if (buf[prefixAt + 18] === 0x0d && buf[prefixAt + 19] === 0x0a) {
				headerLength = 20;
				if (buf[prefixAt + 20] === 0x11) headerLength = 21;
			}
			buf = concatBytes(buf.subarray(0, prefixAt), buf.subarray(prefixAt + headerLength));
			searchFrom = prefixAt;
		}
		return buf;
	}

	function sendExtraAbortBytes() {
		try {
			writeToRemote(new Uint8Array([0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18]));
		} catch {
			/* ignore */
		}
	}

	function scheduleRemoteInterruptAfterCancel(transferRole: string) {
		if (cancelInterruptTimer) {
			clearTimeout(cancelInterruptTimer);
			cancelInterruptTimer = null;
		}
		if (transferRole !== "send") return;
		ignoreDetectionUntil = Date.now() + 300;
		try {
			interruptRemote?.();
		} catch {
			/* ignore */
		}
		cancelInterruptTimer = setTimeout(() => {
			cancelInterruptTimer = null;
			try {
				interruptRemote?.();
			} catch {
				/* ignore */
			}
			try {
				writeToRemote(fromString("\x03"));
			} catch {
				/* ignore */
			}
		}, 120);
	}

	function isIgnorableSendKeepaliveError(errMsg: string) {
		return Boolean(active && currentZSession?.type === "send" && !currentZSession?._sending_file && errMsg.includes("Unhandled header: ZRINIT"));
	}

	function isIgnorableSendResumePingError(errMsg: string) {
		return Boolean(
			active &&
				currentZSession?.type === "send" &&
				!currentZSession?._sending_file &&
				currentZSession?._next_header_handler?.ZRINIT &&
				errMsg.includes("Unhandled header: ZRPOS"),
		);
	}

	const sentry = new Zmodem.Sentry({
		to_terminal(octets: ArrayLike<number>) {
			let sanitizedOctets = stripPendingTerminalSuppression(toBytes(octets));
			sanitizedOctets = stripVisibleZmodemHeaders(sanitizedOctets);
			if (!sanitizedOctets.length) return;
			onData(sanitizedOctets);
		},

		sender(octets: ArrayLike<number>) {
			const bytes = toBytes(octets);
			rememberOutgoingEcho(bytes);
			const ok = writeToRemote(bytes);
			if (ok === false) {
				_needsDrain = true;
				_sawUploadBackpressure = true;
			}
		},

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		on_detect(detection: any) {
			if (active) {
				detection.deny();
				return;
			}
			if (Date.now() < ignoreDetectionUntil) {
				detection.deny();
				return;
			}
			active = true;
			const zsession = detection.confirm();
			currentZSession = zsession;
			pendingTerminalSuppression =
				zsession.type === "receive"
					? toBytes(Zmodem.Header.build("ZRQINIT").to_hex())
					: zsession._last_ZRINIT?.to_hex
						? toBytes(zsession._last_ZRINIT.to_hex())
						: null;
			const transferType = zsession.type === "send" ? "upload" : "download";
			emit({ type: "detect", transferType });

			const onUploadTimeout = () => {
				ignoreDetectionUntil = Date.now() + 1000;
				cooldownUntil = Date.now() + COOLDOWN_MS;
			};
			transferAbortController = new AbortController();
			const transferSignal = transferAbortController.signal;
			const transferOpts: TransferOpts = {
				...opts,
				hasUploadBackpressure: () => _sawUploadBackpressure,
				resetUploadBackpressure: () => {
					_sawUploadBackpressure = false;
				},
				onUploadTimeout,
				waitForDrain: createZmodemUploadDrainWaiter({
					getNeedsDrain: () => _needsDrain,
					clearNeedsDrain: () => {
						_needsDrain = false;
					},
					signal: transferSignal,
					waitForTransportDrain: opts.waitForTransportDrain,
					onUploadTimeout,
					writeToRemote: opts.writeToRemote,
				}),
			};
			handleTransfer(zsession, transferType, transferOpts)
				.then(() => {
					if (currentZSession !== zsession) return;
					emit({ type: "complete" });
				})
				.catch((err) => {
					if (currentZSession !== zsession) return;
					if (isZmodemCancelledError(err)) return;
					try {
						zsession.abort();
					} catch {
						/* ignore */
					}
					emit({ type: "error", error: String(err?.message || err) });
				})
				.finally(() => {
					if (transferAbortController?.signal === transferSignal) transferAbortController = null;
					if (currentZSession === zsession) {
						active = false;
						currentZSession = null;
					}
				});
		},

		on_retract() {
			// 误报：sentry 自己恢复直通
		},
	});

	return {
		consume(data: Uint8Array) {
			if (cooldownUntil) {
				const now = Date.now();
				if (now < cooldownUntil) {
					if (now - (cooldownUntil - COOLDOWN_MS) > 200) sendExtraAbortBytes();
					return;
				}
				cooldownUntil = 0;
			}
			try {
				const sanitizedData = stripEchoedOutgoingData(data);
				if (!sanitizedData.length) return;
				sentry.consume(Array.from(sanitizedData));
			} catch (err) {
				const errMsg = String((err as Error)?.message || err);
				const wasActive = active;
				if (isIgnorableSendKeepaliveError(errMsg)) return;
				if (isIgnorableSendResumePingError(errMsg)) return;
				if (wasActive && errMsg.includes("ZFIN") && errMsg.includes("OO")) {
					if (currentZSession) {
						try {
							currentZSession._on_session_end();
						} catch {
							/* ignore */
						}
					}
					active = false;
					currentZSession = null;
					emit({ type: "complete" });
					try {
						sentry.consume(Array.from(data));
					} catch {
						/* ignore */
					}
					return;
				}
				if (currentZSession) {
					try {
						currentZSession.abort();
					} catch {
						/* ignore */
					}
				}
				sendExtraAbortBytes();
				setTimeout(() => {
					try {
						writeToRemote(fromString("\x03"));
					} catch {
						/* ignore */
					}
				}, 150);
				try {
					transferAbortController?.abort();
				} catch {
					/* ignore */
				}
				transferAbortController = null;
				active = false;
				currentZSession = null;
				cooldownUntil = Date.now() + COOLDOWN_MS;
				if (wasActive) emit({ type: "error", error: errMsg });
			}
		},

		isActive: () => active,
		isCoolingDown: () => cooldownUntil !== 0 && Date.now() < cooldownUntil,

		cancel() {
			if (currentZSession) {
				const transferRole = currentZSession.type;
				try {
					currentZSession.abort();
				} catch {
					/* ignore */
				}
				sendExtraAbortBytes();
				active = false;
				currentZSession = null;
				cooldownUntil = Date.now() + COOLDOWN_MS;
				scheduleRemoteInterruptAfterCancel(transferRole);
				try {
					transferAbortController?.abort();
				} catch {
					/* ignore */
				}
				transferAbortController = null;
				emit({ type: "error", error: "Transfer cancelled" });
			}
		},
	};
}
