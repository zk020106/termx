/* =============================================================================
 * 远程主机系统指标：在已连接的 SSH 会话上另开 exec 通道跑一条只读命令，
 * 读 /proc 与 df / ps（无需在服务器上安装任何代理）。解析是纯函数，便于单测。
 * 只支持 Linux（/proc）；其他系统如实返回「不支持」。
 * ========================================================================== */

export const SECTION = "@@termx@@";

export const METRICS_COMMAND = [
	"cat /proc/loadavg",
	"head -n 1 /proc/stat",
	"grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo",
	"df -kP / | tail -n 1",
	"nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo",
	"ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu 2>/dev/null | head -n 5",
	"cat /proc/uptime",
]
	.map((cmd) => `${cmd} 2>/dev/null`)
	.join(`; echo '${SECTION}'; `);

export interface CpuTimes {
	idle: number;
	total: number;
}

export interface HostProcess {
	pid: number;
	cpu: number;
	mem: number;
	command: string;
}

export interface HostMetrics {
	load: [number, number, number] | null;
	cores: number | null;
	cpuTimes: CpuTimes | null;
	/** 内存（KiB） */
	memTotal: number | null;
	memUsed: number | null;
	swapTotal: number | null;
	swapUsed: number | null;
	/** 根分区（KiB） */
	diskTotal: number | null;
	diskUsed: number | null;
	diskMount: string | null;
	processes: HostProcess[];
	uptimeSec: number | null;
}

function num(text: string | undefined): number | null {
	if (text === undefined) return null;
	const value = Number(text);
	return Number.isFinite(value) ? value : null;
}

export function parseMetrics(stdout: string): HostMetrics {
	const parts = stdout.split(new RegExp(`^${SECTION}\\s*$`, "m")).map((p) => p.trim());
	const [loadText, statText, memText, dfText, coresText, psText, uptimeText] = parts;

	const loadCols = (loadText ?? "").split(/\s+/);
	const l1 = num(loadCols[0]);
	const l5 = num(loadCols[1]);
	const l15 = num(loadCols[2]);
	const load: HostMetrics["load"] = l1 !== null && l5 !== null && l15 !== null ? [l1, l5, l15] : null;

	let cpuTimes: CpuTimes | null = null;
	const statCols = (statText ?? "").split(/\s+/);
	if (statCols[0] === "cpu") {
		const values = statCols.slice(1).map(Number).filter((v) => Number.isFinite(v));
		if (values.length >= 4) {
			// user nice system idle iowait irq softirq steal（guest 已含在 user 里，不重复计）
			const used = values.slice(0, 8);
			const total = used.reduce((a, b) => a + b, 0);
			const idle = (values[3] ?? 0) + (values[4] ?? 0);
			cpuTimes = { idle, total };
		}
	}

	const mem = new Map<string, number>();
	for (const line of (memText ?? "").split("\n")) {
		const m = /^(\w+):\s+(\d+)/.exec(line.trim());
		if (m) mem.set(m[1], Number(m[2]));
	}
	const memTotal = mem.get("MemTotal") ?? null;
	const available =
		mem.get("MemAvailable") ??
		(mem.has("MemFree") ? (mem.get("MemFree") ?? 0) + (mem.get("Buffers") ?? 0) + (mem.get("Cached") ?? 0) : null);
	const memUsed = memTotal !== null && available !== null ? Math.max(0, memTotal - available) : null;
	const swapTotal = mem.get("SwapTotal") ?? null;
	const swapUsed = swapTotal !== null && mem.has("SwapFree") ? swapTotal - (mem.get("SwapFree") ?? 0) : null;

	// Filesystem 1024-blocks Used Available Capacity Mounted
	const dfCols = (dfText ?? "").split(/\s+/);
	let diskTotal: number | null = null;
	let diskUsed: number | null = null;
	let diskMount: string | null = null;
	if (dfCols.length >= 6) {
		diskTotal = num(dfCols[dfCols.length - 5]);
		diskUsed = num(dfCols[dfCols.length - 4]);
		diskMount = dfCols[dfCols.length - 1];
	}

	const cores = num((coresText ?? "").split(/\s+/)[0]);

	const processes: HostProcess[] = [];
	for (const line of (psText ?? "").split("\n")) {
		const m = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/.exec(line);
		if (m) processes.push({ pid: Number(m[1]), cpu: Number(m[2]), mem: Number(m[3]), command: m[4].trim() });
	}

	const uptimeSec = num((uptimeText ?? "").split(/\s+/)[0]);

	return { load, cores, cpuTimes, memTotal, memUsed, swapTotal, swapUsed, diskTotal, diskUsed, diskMount, processes, uptimeSec };
}

/** 两次 /proc/stat 采样之间的 CPU 使用率（0-100）；第一次采样没有前值时返回 null */
export function cpuPercent(prev: CpuTimes | null, next: CpuTimes | null): number | null {
	if (!prev || !next) return null;
	const total = next.total - prev.total;
	const idle = next.idle - prev.idle;
	if (total <= 0) return null;
	return Math.min(100, Math.max(0, ((total - idle) / total) * 100));
}

/** 判断是不是拿到了 Linux 指标（非 Linux 主机上 /proc 读不到） */
export function hasLinuxMetrics(m: HostMetrics): boolean {
	return m.load !== null || m.memTotal !== null || m.cpuTimes !== null;
}

export function formatKib(kib: number | null): string {
	if (kib === null) return "—";
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = kib;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatUptime(sec: number | null): string {
	if (sec === null) return "—";
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	if (d > 0) return `${d} 天 ${h} 小时`;
	if (h > 0) return `${h} 小时 ${m} 分`;
	return `${m} 分`;
}
