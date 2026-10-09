/**
 * 代理配置的纯逻辑 —— 移植自 Netcatty domain/proxyProfiles.ts（GPL-3.0-or-later）。
 * 含 ProxyCommand（type: "command"）与「钥匙串身份」凭据（identityId）分支；
 * 差异：口令不在 config 里（在系统钥匙串 proxy-profile:<id> / identity:<id>）。
 */
import type { Host, Identity, ProxyConfig, ProxyProfile } from "../data/types";

export const isProxyCommandConfig = (config: ProxyConfig | undefined | null): boolean => config?.type === "command";

export const isValidProxyPort = (port: unknown): boolean => {
	const value = Number(port);
	return Number.isInteger(value) && value >= 1 && value <= 65535;
};

export const isCompleteProxyConfig = (config: ProxyConfig | undefined | null): boolean =>
	isProxyCommandConfig(config)
		? Boolean(config?.command?.trim())
		: Boolean(config?.host.trim()) && isValidProxyPort(config?.port);

/** Netcatty normalizeManualProxyConfig：ProxyCommand 只留命令；身份与手填用户名二选一 */
export function normalizeManualProxyConfig(config: ProxyConfig | undefined | null): ProxyConfig | undefined {
	if (!config) return undefined;
	if (isProxyCommandConfig(config)) {
		const command = config.command?.trim();
		return command ? { type: "command", host: "", port: 0, command } : undefined;
	}
	if (!config.host.trim()) return undefined;
	const normalized: ProxyConfig = { type: config.type, host: config.host.trim(), port: Number(config.port) };
	if (config.identityId) normalized.identityId = config.identityId;
	else if (config.username?.trim()) normalized.username = config.username.trim();
	return normalized;
}

export const hasMissingProxyIdentity = (config: ProxyConfig, identities: Identity[]): boolean =>
	Boolean(config.identityId) && !identities.some((i) => i.id === config.identityId);

export const hasIncompleteProxyIdentity = (config: ProxyConfig, identities: Identity[]): boolean => {
	if (!config.identityId) return false;
	const identity = identities.find((i) => i.id === config.identityId);
	return Boolean(identity) && (!identity?.username || !identity.hasPassword);
};

/** 列表摘要里不展示 ProxyCommand 的内容（可能含令牌），与 Netcatty 一致 */
export const formatProxyConfigEndpoint = (config: ProxyConfig | undefined | null): string =>
	!config ? "" : isProxyCommandConfig(config) ? "ProxyCommand" : `${config.host}:${config.port}`;

export const formatProxyConfigType = (config: ProxyConfig | undefined | null): string =>
	!config ? "" : isProxyCommandConfig(config) ? "ProxyCommand" : config.type.toUpperCase();

export function findProxyProfile(proxyProfileId: string | undefined, proxyProfiles: ProxyProfile[]): ProxyProfile | undefined {
	if (!proxyProfileId) return undefined;
	return proxyProfiles.find((profile) => profile.id === proxyProfileId);
}

/** 连接时把引用的代理配置展开成主机自己的 proxy（主机自带 proxy 时以主机为准） */
export function materializeHostProxyProfile<T extends Host>(host: T, proxyProfiles: ProxyProfile[]): T {
	if (host.proxy || !host.proxyProfileId) return host;
	const profile = findProxyProfile(host.proxyProfileId, proxyProfiles);
	if (!profile) return host;
	return { ...host, proxy: { ...profile.config } };
}

/** 删除代理配置时解除所有主机上的引用 */
export function removeProxyProfileReferences(proxyProfileId: string, hosts: Host[]): Host[] {
	return hosts.map((host) => {
		if (host.proxyProfileId !== proxyProfileId) return host;
		const { proxyProfileId: _id, ...rest } = host;
		return rest as Host;
	});
}

export const getProfileUsageCount = (profileId: string, hosts: Host[]): number =>
	hosts.filter((host) => host.proxyProfileId === profileId).length;

export type ProxyProfileSaveError = "required" | "port" | "missingIdentity" | "incompleteIdentity";

/** Netcatty prepareProxyProfileForSave：名称必填；ProxyCommand 要命令，其余要地址与 1~65535 端口；身份要存在且完整 */
export function prepareProxyProfileForSave(
	draft: ProxyProfile,
	updatedAt = Date.now(),
	identities: Identity[] = [],
): { saved?: ProxyProfile; error?: ProxyProfileSaveError } {
	const label = draft.label.trim();
	const isCommand = isProxyCommandConfig(draft.config);
	if (!label || (isCommand ? !draft.config.command?.trim() : !draft.config.host.trim() || !draft.config.port)) return { error: "required" };
	if (!isCommand && !isValidProxyPort(draft.config.port)) return { error: "port" };
	if (!isCommand && hasMissingProxyIdentity(draft.config, identities)) return { error: "missingIdentity" };
	if (!isCommand && hasIncompleteProxyIdentity(draft.config, identities)) return { error: "incompleteIdentity" };
	const config = normalizeManualProxyConfig(draft.config);
	if (!config) return { error: "required" };
	return { saved: { ...draft, label, config, updatedAt } };
}

export const PROXY_PROFILE_ERROR_TEXT: Record<ProxyProfileSaveError, string> = {
	required: "名称和代理详情不能为空。",
	port: "端口必须在 1 到 65535 之间。",
	missingIdentity: "钥匙串身份不存在",
	incompleteIdentity: "代理身份需要用户名和密码",
};

/** Netcatty proxyProfiles.copyName：「{name} 副本」 */
export const proxyProfileCopyName = (name: string): string => `${name} 副本`;

export function createDraftProfile(now = Date.now()): ProxyProfile {
	return {
		id: `proxy-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
		label: "",
		config: { type: "http", host: "", port: 8080 },
		createdAt: now,
		updatedAt: now,
	};
}

export function duplicateProxyProfile(profile: ProxyProfile, now = Date.now()): ProxyProfile {
	return {
		...profile,
		id: `proxy-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
		label: proxyProfileCopyName(profile.label),
		config: { ...profile.config },
		createdAt: now,
		updatedAt: now,
	};
}
