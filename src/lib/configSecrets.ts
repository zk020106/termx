import type { Host } from "@/data/types";

/* =============================================================================
 * 配置里的机密字段清理。
 *
 * 记住的密码只能存在系统钥匙串里（lib/secret.ts）。旧版本曾把明文写进配置：
 *   - host.auth.password   —— 登录密码（钥匙串账户名：主机 id）
 *   - host.proxy.password  —— 代理口令（钥匙串账户名：`proxy:<主机 id>`）
 * 这里负责把它们从任何要落盘 / 导出的配置里剥掉，并把剥下来的值交给调用方迁进钥匙串。
 *
 * 本文件保持纯函数、无运行时依赖，便于单测。
 * ========================================================================== */

export interface LegacySecret {
	/** 钥匙串账户名：主机 id 或 `proxy:<主机 id>` */
	account: string;
	hostId: string;
	kind: "login" | "proxy";
	password: string;
}

/** 代理口令在钥匙串里的账户名 */
export function proxySecretAccount(hostId: string): string {
	return `proxy:${hostId}`;
}

/** 代理配置（proxyProfiles）口令在钥匙串里的账户名 */
export function proxyProfileSecretAccount(profileId: string): string {
	return `proxy-profile:${profileId}`;
}

/** 剥掉每台主机里的明文登录密码与代理口令；返回干净的主机列表与剥下来的值（只收非空字符串） */
export function stripHostSecrets(hosts: Host[]): { hosts: Host[]; legacy: LegacySecret[] } {
	const legacy: LegacySecret[] = [];
	const cleaned = hosts.map((host) => {
		if (!host || typeof host !== "object") return host;
		let next = host;
		const auth = host.auth as (Host["auth"] & { password?: unknown }) | undefined;
		if (auth && typeof auth === "object" && "password" in auth) {
			const { password, ...rest } = auth;
			if (typeof password === "string" && password !== "") {
				legacy.push({ account: host.id, hostId: host.id, kind: "login", password });
				// 旧版本以「配置里有密码」表示记住了密码（rememberPassword 可能缺省）：迁走后保留这层含义，
				// 否则自动连接不会再去钥匙串里取
				next = { ...next, auth: { ...rest, rememberPassword: rest.rememberPassword ?? true } };
			} else {
				next = { ...next, auth: rest };
			}
		}
		const proxy = host.proxy as (NonNullable<Host["proxy"]> & { password?: unknown }) | null | undefined;
		if (proxy && typeof proxy === "object" && "password" in proxy) {
			const { password, ...rest } = proxy;
			if (typeof password === "string" && password !== "") {
				legacy.push({ account: proxySecretAccount(host.id), hostId: host.id, kind: "proxy", password });
			}
			next = { ...next, proxy: rest };
		}
		return next;
	});
	return { hosts: cleaned, legacy };
}
