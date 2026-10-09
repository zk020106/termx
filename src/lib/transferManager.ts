import type { Transfer, TransferConflict } from "@/data/types";
import { fsLocalStat, localDirname, localJoin, posixDirname, posixJoin, sftpStat } from "@/lib/sftp";
import { freeName } from "@/lib/transferNames";
import { useTransfersStore } from "@/store/transfers";

/* =============================================================================
 * 传输管理：SFTP 页、侧栏、终端内嵌抽屉三处的上传 / 下载都走这里。
 *
 *  - 每批传输依次进行（与原先一致），每项先 transfer_check 拿两侧文件的真实信息：
 *    目标已存在 → 弹「同名文件覆盖冲突」，用户选覆盖 / 跳过 / 重命名保留两份（可应用到本批后续）；
 *    有上次没传完的部分文件 → 可从断点续传。
 *  - 数据先写到目标旁的 .termx-part，传完再原子改名，中途失败不会破坏已有文件。
 *  - 进度来自 transfer://progress/{id}（每 250ms），暂停 / 继续 / 取消 / 重试都是真的：
 *    暂停保留部分文件，继续与重试从断点接着传。
 *  - 传完后在远端用 sha256sum 复算比对；远端没有该命令时如实标注「未比对」。
 * ========================================================================== */

export interface TransferRequest {
	name: string;
	direction: "upload" | "download";
	hostId: string;
	sessionKey: string;
	localPath: string;
	remotePath: string;
	/** 已知的源文件大小（列表里有就传，没有后端会补） */
	size?: number;
	/** 用户已在系统「另存为」对话框里确认过覆盖：目标已存在时不再重复询问 */
	overwriteConfirmed?: boolean;
}

export interface TransferCallbacks {
	onItemDone?: (item: Transfer) => void;
	onItemFailed?: (item: Transfer, error: string) => void;
	onItemSkipped?: (item: Transfer) => void;
	/** 整批结束（含失败 / 跳过）后调用一次，例如刷新目录 */
	onFinished?: () => void;
}

export type ConflictChoice = "overwrite" | "skip" | "rename" | "resume";

interface Progress {
	transferred: number;
	size: number;
	speedBps: number;
}

interface TransferResultPayload {
	state: "done" | "paused" | "cancelled";
	size: number;
	transferred: number;
	sha256?: string | null;
	verified?: boolean | null;
	verifyNote?: string | null;
}

const store = () => useTransfersStore.getState();
const itemOf = (id: string) => store().items.find((t) => t.id === id);

/** 等待用户对冲突做决定的回调（按传输 id） */
const pendingDecisions = new Map<string, (choice: ConflictChoice, applyAll: boolean) => void>();
/** 已经过冲突检查的传输（重试 / 继续不再重复询问） */
const checked = new Set<string>();
/** 已在系统对话框里确认覆盖的传输 */
const preConfirmed = new Set<string>();

let seq = 0;
function newId() {
	seq += 1;
	return `trans-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 6)}`;
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
	const { invoke: call } = await import("@tauri-apps/api/core");
	return call<T>(cmd, args);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/* ------------------------------ 冲突决定 ------------------------------ */

/** 界面（Transfers 详情卡片或全局冲突弹窗）调用：对一项冲突做出决定 */
export function resolveConflict(id: string, choice: ConflictChoice, applyAll: boolean): void {
	const resolve = pendingDecisions.get(id);
	if (!resolve) return;
	pendingDecisions.delete(id);
	store().patch(id, { pendingConflict: undefined, conflict: choice === "resume" ? undefined : choice });
	resolve(choice, applyAll);
}

function askConflict(id: string, conflict: TransferConflict): Promise<{ choice: ConflictChoice; applyAll: boolean }> {
	store().patch(id, { pendingConflict: conflict });
	return new Promise((resolve) => {
		pendingDecisions.set(id, (choice, applyAll) => resolve({ choice, applyAll }));
	});
}

/* ------------------------------ 执行一项 ------------------------------ */

type RunOutcome = "done" | "paused" | "cancelled" | "failed";

async function runOne(id: string, resume: boolean, callbacks?: TransferCallbacks): Promise<RunOutcome> {
	const item = itemOf(id);
	if (!item || !item.sessionKey) return "failed";
	const startedAt = Date.now();
	store().patch(id, {
		state: "running",
		error: undefined,
		verifying: false,
		speedBps: 0,
		etaSec: undefined,
		runStartedAt: startedAt,
		runStartBytes: resume ? item.transferred : 0,
		transferred: resume ? item.transferred : 0,
		samples: [],
	});

	let lastSampleAt = 0;
	const { listen } = await import("@tauri-apps/api/event");
	const unlisten = await listen<Progress>(`transfer://progress/${id}`, (event) => {
		const p = event.payload;
		const now = Date.now();
		const current = itemOf(id);
		if (!current) return;
		const patch: Partial<Transfer> = {
			transferred: p.transferred,
			size: p.size || current.size,
			speedBps: p.speedBps,
			etaSec: p.speedBps > 0 ? Math.max(0, (p.size - p.transferred) / p.speedBps) : undefined,
			verifying: p.size > 0 && p.transferred >= p.size,
		};
		if (now - lastSampleAt >= 1000) {
			lastSampleAt = now;
			patch.samples = [...(current.samples ?? []), p.speedBps].slice(-16);
		}
		store().patch(id, patch);
	});

	const elapsed = () => (itemOf(id)?.activeMs ?? 0) + (Date.now() - startedAt);
	try {
		const result = await invoke<TransferResultPayload>("transfer_start", {
			id,
			key: item.sessionKey,
			direction: item.direction,
			localPath: item.localPath,
			remotePath: item.remotePath,
			resume,
			verify: true,
		});
		if (result.state === "cancelled") {
			store().remove(id);
			checked.delete(id);
			return "cancelled";
		}
		if (result.state === "paused") {
			store().patch(id, {
				state: "paused",
				transferred: result.transferred,
				size: result.size || item.size,
				speedBps: 0,
				activeMs: elapsed(),
				verifying: false,
			});
			return "paused";
		}
		store().patch(id, {
			state: "done",
			size: result.size,
			transferred: result.size,
			speedBps: 0,
			etaSec: 0,
			activeMs: elapsed(),
			verifying: false,
			sha256: result.sha256 ?? undefined,
			verified: result.verified ?? null,
			verifyNote: result.verifyNote ?? undefined,
		});
		checked.delete(id);
		const done = itemOf(id);
		if (done) callbacks?.onItemDone?.(done);
		return "done";
	} catch (raw) {
		const error = messageOf(raw);
		store().patch(id, { state: "failed", error, speedBps: 0, activeMs: elapsed(), verifying: false });
		const failed = itemOf(id);
		if (failed) callbacks?.onItemFailed?.(failed, error);
		return "failed";
	} finally {
		unlisten();
	}
}

/**
 * 冲突检查 + 决定。返回：
 *  - { resume } 继续执行；
 *  - "skip" 用户跳过（条目已移除）；
 *  - { error } 无法传输（源不存在、目标是目录等）。
 */
async function prepare(
	id: string,
	batchRule: { current: ConflictChoice | null },
): Promise<{ resume: boolean } | "skip" | { error: string }> {
	const item = itemOf(id);
	if (!item?.sessionKey) return { error: "会话已不在" };
	let info: TransferConflict;
	try {
		info = await invoke<TransferConflict>("transfer_check", {
			key: item.sessionKey,
			direction: item.direction,
			localPath: item.localPath,
			remotePath: item.remotePath,
		});
	} catch (error) {
		return { error: messageOf(error) };
	}
	if (!info.source.exists) return { error: "源文件不存在" };
	if (info.source.isDir) return { error: "暂不支持目录传输，请单选文件" };
	if (info.target.isDir) return { error: "目标位置是一个同名目录，无法覆盖" };
	store().patch(id, { size: info.source.size });
	if (!info.target.exists && info.partial === 0) return { resume: false };

	let choice: ConflictChoice;
	if (preConfirmed.has(id)) {
		choice = "overwrite";
	} else if (batchRule.current && (info.target.exists || batchRule.current !== "rename")) {
		choice = batchRule.current;
		// 批量规则「续传」只对有部分文件的项有意义；其余按覆盖处理
		if (choice === "resume" && info.partial === 0) choice = "overwrite";
	} else {
		const decision = await askConflict(id, info);
		choice = decision.choice;
		if (decision.applyAll) batchRule.current = choice;
	}

	switch (choice) {
		case "skip":
			return "skip";
		case "resume":
			return { resume: info.partial > 0 };
		case "overwrite":
			return { resume: false };
		case "rename": {
			if (!info.target.exists) return { resume: false };
			const current = itemOf(id);
			if (!current?.sessionKey) return { error: "会话已不在" };
			const key = current.sessionKey;
			try {
				if (current.direction === "upload") {
					const dir = posixDirname(current.remotePath);
					const base = current.remotePath.slice(dir.length).replace(/^\/+/, "");
					const name = await freeName(base, async (c) => (await sftpStat(key, posixJoin(dir, c))).exists);
					store().patch(id, { remotePath: posixJoin(dir, name), name });
				} else {
					const dir = localDirname(current.localPath);
					const base = current.localPath.replace(/\\/g, "/").split("/").pop() ?? current.name;
					const name = await freeName(base, async (c) => (await fsLocalStat(localJoin(dir, c))).exists);
					store().patch(id, { localPath: localJoin(dir, name), name });
				}
			} catch (error) {
				return { error: messageOf(error) };
			}
			return { resume: false };
		}
	}
}

/** 把一批文件加入队列并依次传输 */
export async function enqueueTransfers(requests: TransferRequest[], callbacks?: TransferCallbacks): Promise<void> {
	const ids = requests.map((req) => {
		const id = newId();
		store().upsert({
			id,
			name: req.name,
			direction: req.direction,
			hostId: req.hostId,
			sessionKey: req.sessionKey,
			localPath: req.localPath,
			remotePath: req.remotePath,
			size: req.size ?? 0,
			transferred: 0,
			speedBps: 0,
			state: "queued",
			activeMs: 0,
		});
		if (req.overwriteConfirmed) preConfirmed.add(id);
		return id;
	});

	const batchRule: { current: ConflictChoice | null } = { current: null };
	for (const id of ids) {
		const item = itemOf(id);
		// 排队期间被用户取消 / 已被单独处理
		if (!item || item.state !== "queued") continue;
		const prepared = await prepare(id, batchRule);
		if (prepared === "skip") {
			const skipped = itemOf(id);
			store().remove(id);
			if (skipped) callbacks?.onItemSkipped?.(skipped);
			continue;
		}
		if ("error" in prepared) {
			if (!itemOf(id)) continue;
			store().patch(id, { state: "failed", error: prepared.error });
			const failed = itemOf(id);
			if (failed) callbacks?.onItemFailed?.(failed, prepared.error);
			continue;
		}
		if (!itemOf(id)) continue;
		checked.add(id);
		await runOne(id, prepared.resume, callbacks);
	}
	callbacks?.onFinished?.();
}

/* ------------------------------ 控制 ------------------------------ */

export async function pauseTransfer(id: string): Promise<void> {
	const item = itemOf(id);
	if (item?.state !== "running") return;
	await invoke<boolean>("transfer_control", { id, action: "pause" }).catch(() => false);
}

export async function pauseAllTransfers(): Promise<number> {
	const running = store().items.filter((t) => t.state === "running");
	await Promise.all(running.map((t) => pauseTransfer(t.id)));
	return running.length;
}

/** 继续（已暂停）或重试（失败）：从断点续传 */
export async function resumeTransfer(id: string, callbacks?: TransferCallbacks): Promise<RunOutcome | "skip"> {
	const item = itemOf(id);
	if (!item || (item.state !== "paused" && item.state !== "failed")) return "failed";
	if (!checked.has(id)) {
		// 冲突检查还没做过（例如检查阶段就失败了）：重新走一遍
		store().patch(id, { state: "queued", error: undefined });
		const prepared = await prepare(id, { current: null });
		if (prepared === "skip") {
			store().remove(id);
			return "skip";
		}
		if ("error" in prepared) {
			store().patch(id, { state: "failed", error: prepared.error });
			return "failed";
		}
		checked.add(id);
		return runOne(id, prepared.resume, callbacks);
	}
	return runOne(id, true, callbacks);
}

/** 取消：进行中的让后端停下并删掉部分文件；暂停 / 失败的直接清理部分文件；已完成的只是移出列表 */
export async function cancelTransfer(id: string): Promise<void> {
	const item = itemOf(id);
	if (!item) return;
	if (pendingDecisions.has(id)) {
		resolveConflict(id, "skip", false);
		return;
	}
	if (item.state === "running") {
		const accepted = await invoke<boolean>("transfer_control", { id, action: "cancel" }).catch(() => false);
		if (accepted) return; // runOne 收到 cancelled 后移除
	}
	if (item.state === "paused" || item.state === "failed") {
		await invoke("transfer_discard_partial", {
			key: item.sessionKey ?? null,
			direction: item.direction,
			localPath: item.localPath,
			remotePath: item.remotePath,
		}).catch(() => undefined);
	}
	checked.delete(id);
	store().remove(id);
}

/** 全局限速（MB/s，0 = 不限），上传与下载分别生效，对进行中的传输立即生效 */
export async function setTransferLimit(mb: number): Promise<void> {
	store().setLimitMb(mb);
	const bps = Math.round(mb * 1024 * 1024);
	await invoke("transfer_set_limits", { uploadBps: bps, downloadBps: bps });
}

/** 在系统文件管理器里定位到文件 */
export async function revealLocal(path: string): Promise<void> {
	await invoke("fs_reveal", { path });
}
