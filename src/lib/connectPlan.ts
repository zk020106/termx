import type { Host } from "@/data/types";

/* =============================================================================
 * 连接计划：把主机上的「跳板链 / 代理 / 会话选项」展开成后端 ssh_connect 的 profile。
 *
 * 纯函数，不碰 store 与钥匙串（那些由 connectProfile.ts 读好传进来），方便单测：
 *  - 跳板链按 jumpHostIds 顺序逐跳；缺失的主机、自己跳自己、链里重复都报出来；
 *  - 每一跳用它自己登记的认证方式：
 *      密码 → 钥匙串/已记住的密码，没有就「连接时再问」（ask_password）
 *      私钥 → 登记的私钥路径；私钥+口令 → 连接时再问口令（ask_passphrase）
 *      Agent / 键盘交互 → 原样
 *  - 跳板机自己的跳板链不展开（与 OpenSSH 的 ProxyJump 一样，只认目标主机这一条链）。
 * ========================================================================== */

/** 与 lib/ssh.ts 的 Credential 一致（这里重复声明，避免纯模块依赖 Tauri 入口） */
export type HopCredential =
	| { method: "password"; password: string }
	| { method: "private_key"; path: string; passphrase: string | null }
	| { method: "agent" }
	| { method: "keyboard_interactive" }
	| { method: "ask_password" }
	| { method: "ask_passphrase"; path: string };

export interface HopSpec {
	label: string;
	host: string;
	port: number;
	username: string;
	credential: HopCredential;
}

export interface ProxySpec {
	type: "socks5" | "http";
	host: string;
	port: number;
	username?: string | null;
	password?: string | null;
}

export interface ConnectProfile {
	label: string;
	jumps: HopSpec[];
	proxy: ProxySpec | null;
	termType: string | null;
	env: { key: string; value: string }[];
	loginScript: string | null;
	encoding: string | null;
}

export interface PlanInputs {
	/** 按 id 查主机 */
	hostById: (id: string) => Host | undefined;
	/** 跳板机已保存的密码（钥匙串里读出来的），没有就是 undefined */
	savedPassword: (hostId: string) => string | undefined;
	/** 代理口令（钥匙串里读出来的），没有就是 undefined */
	proxyPassword?: string;
}

export type PlanResult = { ok: true; profile: ConnectProfile } | { ok: false; error: string };

/** 一跳的认证凭据 */
export function hopCredential(host: Host, savedPassword: string | undefined): HopCredential | { error: string } {
	switch (host.auth.method) {
		case "password": {
			// 密码只来自钥匙串（或本次运行的内存）；没有就在连接时向用户要
			return savedPassword ? { method: "password", password: savedPassword } : { method: "ask_password" };
		}
		case "key":
			if (!host.auth.keyPath) return { error: `跳板机「${host.name}」登记的是私钥认证，但没有私钥文件路径` };
			return { method: "private_key", path: host.auth.keyPath, passphrase: null };
		case "key-passphrase":
			if (!host.auth.keyPath) return { error: `跳板机「${host.name}」登记的是私钥认证，但没有私钥文件路径` };
			return { method: "ask_passphrase", path: host.auth.keyPath };
		case "agent":
			return { method: "agent" };
		case "keyboard-interactive":
			return { method: "keyboard_interactive" };
	}
}

/** 展开跳板链：返回按顺序的跳板机，或者说明哪里不对 */
export function resolveJumpChain(target: Host, hostById: (id: string) => Host | undefined): Host[] | { error: string } {
	const ids = target.jumpHostIds ?? [];
	const chain: Host[] = [];
	const seen = new Set<string>([target.id]);
	for (const [index, id] of ids.entries()) {
		const hop = hostById(id);
		if (!hop) return { error: `跳板链第 ${index + 1} 跳引用的主机已不存在，请在主机设置里重新选择` };
		if (seen.has(id)) {
			return {
				error:
					id === target.id
						? `跳板链里包含目标主机「${target.name}」自己，会形成环路`
						: `跳板机「${hop.name}」在链里出现了两次，会形成环路`,
			};
		}
		seen.add(id);
		chain.push(hop);
	}
	if (chain.length > 8) return { error: "跳板链超过 8 跳，请检查配置" };
	return chain;
}

/** 生成完整的连接 profile */
export function buildConnectProfile(target: Host, inputs: PlanInputs): PlanResult {
	const chain = resolveJumpChain(target, inputs.hostById);
	if ("error" in chain) return { ok: false, error: chain.error };

	const jumps: HopSpec[] = [];
	for (const hop of chain) {
		const credential = hopCredential(hop, inputs.savedPassword(hop.id));
		if ("error" in credential) return { ok: false, error: credential.error };
		if (!hop.hostname.trim()) return { ok: false, error: `跳板机「${hop.name}」没有填写地址` };
		jumps.push({
			label: hop.name,
			host: hop.hostname.trim(),
			port: hop.port || 22,
			username: hop.username,
			credential,
		});
	}

	let proxy: ProxySpec | null = null;
	if (target.proxy && target.proxy.host.trim()) {
		const p = target.proxy;
		if (!p.port || p.port < 1 || p.port > 65535) return { ok: false, error: "代理端口无效" };
		proxy = {
			type: p.type === "http" ? "http" : "socks5",
			host: p.host.trim(),
			port: p.port,
			username: p.username?.trim() || null,
			password: p.username?.trim() ? (inputs.proxyPassword ?? "") : null,
		};
	}

	const env = (target.envVars ?? [])
		.map((v) => ({ key: v.key.trim(), value: v.value }))
		.filter((v) => v.key.length > 0);

	return {
		ok: true,
		profile: {
			label: target.name,
			jumps,
			proxy,
			termType: target.termType?.trim() || null,
			env,
			loginScript: target.loginScript?.trim() ? target.loginScript : null,
			encoding: target.encoding?.trim() || null,
		},
	};
}

/** 给界面看的路线描述：本机 → [代理] → 跳板… → 目标 */
export function describeRoute(profile: ConnectProfile, target: { hostname: string; port: number }): string {
	const parts = ["本机"];
	if (profile.proxy) parts.push(`${profile.proxy.type === "http" ? "HTTP" : "SOCKS5"} ${profile.proxy.host}:${profile.proxy.port}`);
	for (const hop of profile.jumps) parts.push(hop.label || `${hop.host}:${hop.port}`);
	parts.push(`${target.hostname}:${target.port}`);
	return parts.join(" → ");
}
