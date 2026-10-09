/* 远程监听端口发现：解析 `ss -ltn` / `netstat -ltn` 的输出（纯函数，便于单测）。
 * 两种输出里本地地址都在第 4 列：
 *   ss:      LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:*
 *   netstat: tcp    0 0    0.0.0.0:22     0.0.0.0:*  LISTEN */

export interface ListeningPort {
	address: string;
	port: number;
	/** 只在回环上监听（只能经 SSH 转发才能从外面访问） */
	loopback: boolean;
}

export const LISTEN_PORTS_COMMAND = "ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null";

export function parseListeningPorts(output: string): ListeningPort[] {
	const seen = new Set<string>();
	const result: ListeningPort[] = [];
	for (const line of output.split(/\r?\n/)) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 4) continue;
		const head = cols[0].toLowerCase();
		const isSs = head === "listen";
		const isNetstat = head === "tcp" || head === "tcp6" || head === "tcp4";
		if (!isSs && !isNetstat) continue;
		if (isNetstat && !line.includes("LISTEN")) continue;
		const local = cols[3];
		const sep = local.lastIndexOf(":");
		if (sep <= 0) continue;
		let address = local.slice(0, sep).replace(/^\[|\]$/g, "");
		address = address.replace(/%.*$/, "");
		if (address === "*") address = "0.0.0.0";
		const port = Number(local.slice(sep + 1));
		if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
		const id = `${address}|${port}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const loopback = address === "::1" || address.startsWith("127.");
		result.push({ address, port, loopback });
	}
	return result.sort((a, b) => a.port - b.port || a.address.localeCompare(b.address));
}
