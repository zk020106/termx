/** 字节、速率、时长的统一格式化。数字一律等宽显示（tabular-nums），由调用方加类。 */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number, digits = 1): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const fixed = unit === 0 ? Math.round(value).toString() : value.toFixed(digits);
	return `${fixed} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
	return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "—";
	const s = Math.round(seconds);
	if (s < 60) return `${s} 秒`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} 分 ${s % 60} 秒`;
	const h = Math.floor(m / 60);
	return `${h} 小时 ${m % 60} 分`;
}

export function formatPercent(value: number, digits = 0): string {
	return `${value.toFixed(digits)}%`;
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 3 天前 */
export function formatRelative(iso: string): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "—";
	const diff = Math.max(0, Date.now() - then) / 1000;
	if (diff < 60) return "刚刚";
	if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
	if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
	return `${Math.floor(diff / 86400)} 天前`;
}
