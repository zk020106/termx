import type { GroupConfig, Host, HostGroup, Identity, ProxyConfig } from "../data/types";

/* =============================================================================
 * 分组默认值与身份解析 —— 移植自 Netcatty domain/groupConfig.ts
 * （resolveGroupDefaults / applyGroupDefaults）与它连接时的 identity 解析。
 *
 * TermX 与 Netcatty 的差异只在数据形状上：
 *  - Netcatty 用分组路径 "A/B/C" 做键；TermX 分组有 id/parentId，这里沿 parentId 链从根到叶合并；
 *  - Netcatty 的 host 字段可以是 undefined（= 继承）；TermX 的 Host 字段大多必填，
 *    于是约定「未设置」的表示：username "" / port 0 / jumpHostIds [] / proxy 与 proxyProfileId 都缺省 /
 *    loginScript "" / envVars 空 / encoding 缺省 / 外观 custom 不为 true；
 *  - 认证方式：Netcatty authMethod undefined 才继承；TermX 主机总有 auth.method，
 *    沿用 Netcatty 的 hostHasManualSshCredentials 判断：用户名为空或 root、密码方式、没有私钥/身份 → 没有手动凭据。
 * ========================================================================== */

export type GroupDefaults = Partial<Omit<GroupConfig, "groupId">> & {
	/** 合并后密码来自哪个分组（钥匙串账户 group:<id>） */
	passwordGroupId?: string;
	/** 合并后 proxyConfig 来自哪个分组（代理口令在钥匙串 group-proxy:<id>） */
	proxyGroupId?: string;
};

/** 从根到叶的祖先链（含自己）；环引用时截断 */
export function groupAncestry(groups: HostGroup[], groupId: string | null): string[] {
	if (!groupId) return [];
	const byId = new Map(groups.map((g) => [g.id, g]));
	const chain: string[] = [];
	const seen = new Set<string>();
	let cur = byId.get(groupId);
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		chain.unshift(cur.id);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return chain;
}

const SSH_CREDENTIAL_KEYS = ["username", "hasPassword", "passwordGroupId", "authMethod", "keyId", "keyPath"] as const;

export const hasManualGroupSshCredentials = (config: Partial<GroupConfig>): boolean =>
	[config.username, config.hasPassword, config.authMethod, config.keyId, config.keyPath].some((v) => v !== undefined);

/** Netcatty resolveGroupDefaults：沿祖先链合并，子分组覆盖父分组 */
export function resolveGroupDefaults(
	groupId: string | null,
	groups: HostGroup[],
	configs: GroupConfig[],
	options?: { validProxyProfileIds?: ReadonlySet<string> },
): GroupDefaults {
	const byGroup = new Map(configs.map((c) => [c.groupId, c]));
	const merged: Record<string, unknown> = {};
	const dropCredentials = () => {
		for (const k of SSH_CREDENTIAL_KEYS) delete merged[k];
	};
	for (const id of groupAncestry(groups, groupId)) {
		const config = byGroup.get(id);
		if (!config) continue;
		if (config.identityId !== undefined) {
			dropCredentials();
		} else if (hasManualGroupSshCredentials(config)) {
			const replacesInheritedIdentity = Boolean(merged.identityId);
			delete merged.identityId;
			if (replacesInheritedIdentity) dropCredentials();
		}
		for (const [key, value] of Object.entries(config)) {
			if (key === "groupId" || value === undefined) continue;
			if (key === "proxyProfileId" && typeof value === "string" && options?.validProxyProfileIds && !options.validProxyProfileIds.has(value)) {
				delete merged.proxyConfig;
			}
			if (
				(key === "theme" && config.themeOverride === false) ||
				(key === "fontFamily" && config.fontFamilyOverride === false) ||
				(key === "fontSize" && config.fontSizeOverride === false)
			) {
				continue;
			}
			if (key === "proxyProfileId") {
				delete merged.proxyConfig;
				delete merged.proxyGroupId;
			}
			if (key === "proxyConfig") {
				delete merged.proxyProfileId;
				merged.proxyGroupId = id;
			}
			merged[key] = value;
		}
		if (config.hasPassword) merged.passwordGroupId = id;
		if (config.hasPassword === false) delete merged.passwordGroupId;
		if (config.themeOverride === false) delete merged.themeOverride;
		if (config.fontFamilyOverride === false) delete merged.fontFamilyOverride;
		if (config.fontSizeOverride === false) delete merged.fontSizeOverride;
	}
	return merged as GroupDefaults;
}

/** 主机有没有自己的手动 SSH 凭据（Netcatty hostHasManualSshCredentials 的 TermX 版） */
export function hostHasManualSshCredentials(host: Host): boolean {
	if (host.auth.identityId) return false;
	const username = host.username?.trim();
	return Boolean(
		(username && username !== "root") ||
			host.auth.method !== "password" ||
			host.auth.keyId ||
			host.auth.keyPath,
	);
}

const emptyList = (v: unknown[] | undefined | null) => !v || v.length === 0;

/**
 * Netcatty applyGroupDefaults：只填主机自己没设置的字段，返回新对象。
 * 结果里 auth.credentialSource / auth.secretAccount 说明凭据来自哪里、密码在钥匙串哪个账户。
 */
export function applyGroupDefaults(host: Host, defaults: GroupDefaults, options?: { validProxyProfileIds?: ReadonlySet<string> }): Host {
	const out: Host = { ...host, auth: { ...host.auth } };
	const manual = hostHasManualSshCredentials(host);
	const skipBundle = Boolean(host.auth.identityId) || (Boolean(defaults.identityId) && manual);
	if (!skipBundle) {
		if (!host.auth.identityId && defaults.identityId && !manual) out.auth.identityId = defaults.identityId;
		if (!out.auth.identityId) {
			if (!host.username?.trim() && defaults.username) out.username = defaults.username;
			const authUnset = host.auth.method === "password" && !host.auth.keyId && !host.auth.keyPath;
			if (authUnset && (defaults.authMethod || defaults.keyId || defaults.keyPath)) {
				out.auth.method = defaults.authMethod ?? "key";
				if (defaults.keyId) out.auth.keyId = defaults.keyId;
				if (defaults.keyPath) out.auth.keyPath = defaults.keyPath;
				out.auth.credentialSource = "group";
			}
			if (authUnset && defaults.passwordGroupId && (defaults.authMethod ?? "password") === "password") {
				out.auth.secretAccount = `group:${defaults.passwordGroupId}`;
				out.auth.credentialSource = "group";
			}
		}
	}
	if (!host.port && defaults.port) out.port = defaults.port;
	// proxyProfileId 与 proxyConfig 互斥；主机两者都没设置时才继承分组的那一个
	if (host.proxy == null && host.proxyProfileId === undefined) {
		const usable = defaults.proxyProfileId && (!options?.validProxyProfileIds || options.validProxyProfileIds.has(defaults.proxyProfileId));
		if (usable) out.proxyProfileId = defaults.proxyProfileId;
		else if (defaults.proxyConfig) out.proxy = { ...defaults.proxyConfig };
	}
	if (emptyList(host.jumpHostIds) && defaults.jumpHostIds?.length) out.jumpHostIds = [...defaults.jumpHostIds];
	if (!host.loginScript && defaults.startupCommand) out.loginScript = defaults.startupCommand;
	if (emptyList(host.envVars) && defaults.environmentVariables?.length) out.envVars = defaults.environmentVariables.map((v) => ({ ...v }));
	if (!host.encoding && defaults.charset) out.encoding = defaults.charset;
	if (!host.termType && defaults.termType) out.termType = defaults.termType;
	if (!host.terminal?.custom && (defaults.theme || defaults.fontFamily || defaults.fontSize)) {
		out.terminal = {
			...(host.terminal ?? {}),
			custom: true,
			...(defaults.theme ? { colorScheme: defaults.theme } : {}),
			...(defaults.fontFamily ? { fontFamily: defaults.fontFamily } : {}),
			...(defaults.fontSize ? { fontSize: defaults.fontSize } : {}),
		};
	}
	return out;
}

/** 连接时的身份解析（Netcatty：identity 提供 username + authMethod + keyId + password） */
export function applyIdentity(host: Host, identities: Identity[]): Host {
	const id = host.auth.identityId;
	if (!id) return host;
	const identity = identities.find((i) => i.id === id);
	if (!identity) return host;
	return {
		...host,
		username: identity.username || host.username,
		auth: {
			...host.auth,
			method: identity.authMethod === "key" && identity.keyId ? "key" : "password",
			keyId: identity.authMethod === "key" ? identity.keyId : undefined,
			keyPath: identity.authMethod === "key" ? undefined : host.auth.keyPath,
			secretAccount: `identity:${identity.id}`,
			credentialSource: "identity",
		},
	};
}

export interface EffectiveContext {
	groups: HostGroup[];
	groupConfigs: GroupConfig[];
	identities: Identity[];
	validProxyProfileIds?: ReadonlySet<string>;
}

/** 生效主机 = 原始主机 + 分组默认值 + 身份；最后补上默认端口 22 与默认用户名 root */
export function effectiveHost(raw: Host, ctx: EffectiveContext): Host {
	const defaults = resolveGroupDefaults(raw.groupId, ctx.groups, ctx.groupConfigs, ctx);
	let out = applyGroupDefaults(raw, defaults, ctx);
	out = applyIdentity(out, ctx.identities);
	if (!out.port) out = { ...out, port: 22 };
	if (!out.username?.trim()) out = { ...out, username: "root" };
	return out;
}

const INHERITABLE_HOST_KEYS = ["username", "port", "jumpHostIds", "proxy", "proxyProfileId", "loginScript", "envVars", "encoding", "termType", "terminal", "auth"] as const;

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** 生效层 auth 里只在运行期存在的字段 */
export function stripEffectiveAuth(auth: Host["auth"]): Host["auth"] {
	const { secretAccount: _a, credentialSource: _s, ...rest } = auth;
	return rest;
}

/**
 * 把「基于生效主机改出来的主机」还原成原始主机：原始里没设置、而新值与继承值相同的字段保持未设置，
 * 免得置顶 / 改名 / 移动分组之类的操作把继承来的值固化进主机。
 */
export function toRawHost(next: Host, prevRaw: Host | undefined, prevEffective: Host | undefined): Host {
	if (!prevRaw || !prevEffective) return { ...next, auth: stripEffectiveAuth(next.auth) };
	const out: Record<string, unknown> = { ...next };
	for (const key of INHERITABLE_HOST_KEYS) {
		if (same(next[key], prevEffective[key])) out[key] = prevRaw[key];
	}
	if (out.proxy === undefined) delete out.proxy;
	if (out.proxyProfileId === undefined) delete out.proxyProfileId;
	const result = out as unknown as Host;
	return { ...result, auth: stripEffectiveAuth(result.auth) };
}

/** 代理凭据来自身份时：用户名取身份 */
export function proxyUsername(proxy: ProxyConfig, identities: Identity[]): string | undefined {
	if (proxy.identityId) return identities.find((i) => i.id === proxy.identityId)?.username;
	return proxy.username;
}
