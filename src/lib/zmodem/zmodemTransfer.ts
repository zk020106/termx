/**
 * 原样移植自 Netcatty components/terminal/hooks/useZmodemTransfer.ts 的状态归约（reduceZmodemTransferState）。
 * 事件来源从 Electron IPC 换成 lib/zmodem/sessionZmodem.ts 里的前端 Sentry 包装。
 */
export interface ZmodemTransferEvent {
	type: "detect" | "progress" | "complete" | "error";
	transferType?: "upload" | "download";
	filename?: string;
	transferred?: number;
	total?: number;
	fileIndex?: number;
	fileCount?: number;
	finalizing?: boolean;
	error?: string;
}

export interface ZmodemTransferState {
	active: boolean;
	transferType: "upload" | "download" | null;
	filename: string | null;
	transferred: number;
	total: number;
	fileIndex: number;
	fileCount: number;
	finalizing: boolean;
	completed: boolean;
	startedAt: number | null;
	updatedAt: number | null;
	bytesPerSecond: number | null;
	error: string | null;
}

export const initialZmodemTransferState: ZmodemTransferState = {
	active: false,
	transferType: null,
	filename: null,
	transferred: 0,
	total: 0,
	fileIndex: 0,
	fileCount: 0,
	finalizing: false,
	completed: false,
	startedAt: null,
	updatedAt: null,
	bytesPerSecond: null,
	error: null,
};

export function reduceZmodemTransferState(
	prev: ZmodemTransferState,
	event: ZmodemTransferEvent,
	now: number = Date.now(),
): ZmodemTransferState {
	switch (event.type) {
		case "detect":
			return {
				...initialZmodemTransferState,
				active: true,
				transferType: event.transferType ?? null,
				startedAt: now,
				updatedAt: now,
			};
		case "progress": {
			const transferred = event.transferred ?? prev.transferred;
			const fileChanged =
				prev.filename !== null &&
				((typeof event.fileIndex === "number" && event.fileIndex !== prev.fileIndex) ||
					(typeof event.filename === "string" && event.filename !== prev.filename));
			const previousUpdatedAt = fileChanged ? now : (prev.updatedAt ?? now);
			const elapsedSeconds = Math.max((now - previousUpdatedAt) / 1000, 0);
			const deltaBytes = Math.max(transferred - prev.transferred, 0);
			const bytesPerSecond =
				elapsedSeconds > 0 && deltaBytes > 0 ? deltaBytes / elapsedSeconds : fileChanged ? null : prev.bytesPerSecond;
			return {
				...prev,
				active: true,
				transferType: event.transferType ?? prev.transferType,
				filename: event.filename ?? prev.filename,
				transferred,
				total: event.total ?? prev.total,
				fileIndex: event.fileIndex ?? prev.fileIndex,
				fileCount: event.fileCount ?? prev.fileCount,
				finalizing: !!event.finalizing,
				completed: false,
				startedAt: prev.startedAt ?? now,
				updatedAt: now,
				bytesPerSecond,
				error: null,
			};
		}
		case "complete":
			return { ...prev, active: false, finalizing: false, completed: true, updatedAt: now };
		case "error":
			return { ...prev, active: false, finalizing: false, completed: false, updatedAt: now, error: event.error ?? "Unknown error" };
	}
}

/** Netcatty resolveZmodemTransferToast */
export function resolveZmodemTransferToast(
	zmodem: Pick<ZmodemTransferState, "active" | "error" | "completed" | "transferType" | "filename">,
): { kind: "success" | "error"; message: string; title: string } | null {
	if (zmodem.active) return null;
	if (zmodem.error) return { kind: "error", message: zmodem.error, title: "ZMODEM" };
	if (!zmodem.completed) return null;
	const action =
		zmodem.transferType === "upload" ? "Uploaded" : zmodem.transferType === "download" ? "Downloaded" : "Transfer completed";
	const message = zmodem.filename ? `${action}: ${zmodem.filename}` : action;
	return { kind: "success", message, title: "ZMODEM" };
}
