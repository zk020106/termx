/**
 * 代理配置的纯逻辑 —— 移植自 Netcatty domain/proxyProfiles.ts（GPL-3.0-or-later）。
 * 差异：TermX 的代理只有 HTTP / SOCKS5（原生层没有 ProxyCommand 通道），口令在钥匙串，
 * 因而 identity / ProxyCommand 相关的分支不移植；其余函数语义保持一致。
 */
import type { Host, ProxyConfig, ProxyProfile } from "../data/types";

export const isValidProxyPort = (port: unknown): boolean => {
	const value = Number(port);
	return Number.isInteger(value) && value >= 1 && value <= 65535;
};

export const isCompleteProxyConfig = (config: ProxyConfig | undefined | null): boolean =>
	Boolean(config?.host.trim()) && isValidProxyPort(config?.port);

export const formatProxyConfigEndpoint = (config: ProxyConfig | undefined | null): string =>
	config ? `${config.host}:${config.port}` : "";

export const formatProxyConfigType = (config: ProxyConfig | undefined | null): string =>
	config ? config.type.toUpperCase() : "";

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

export type ProxyProfileSaveError = "required" | "port";

/** Netcatty prepareProxyProfileForSave：名称、地址必填，端口 1~65535 */
export function prepareProxyProfileForSave(
	draft: ProxyProfile,
	updatedAt = Date.now(),
): { saved?: ProxyProfile; error?: ProxyProfileSaveError } {
	const label = draft.label.trim();
	const host = draft.config.host.trim();
	if (!label || !host || !draft.config.port) return { error: "required" };
	if (!isValidProxyPort(draft.config.port)) return { error: "port" };
	const config: ProxyConfig = { type: draft.config.type, host, port: Number(draft.config.port) };
	const username = draft.config.username?.trim();
	if (username) config.username = username;
	return { saved: { ...draft, label, config, updatedAt } };
}

export const PROXY_PROFILE_ERROR_TEXT: Record<ProxyProfileSaveError, string> = {
	required: "名称和代理详情不能为空。",
	port: "端口必须在 1 到 65535 之间。",
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
