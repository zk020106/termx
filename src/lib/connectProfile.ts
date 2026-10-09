import { buildConnectProfile, type ConnectProfile } from "./connectPlan";
import { proxyProfileSecretAccount, proxySecretAccount } from "./configSecrets";
import { materializeHostProxyProfile } from "./proxyProfiles";
import { secretLoad } from "./secret";

/* 从 store 与钥匙串里取数据，生成某台主机的连接 profile（纯逻辑见 connectPlan.ts）。 */

export async function resolveConnectProfile(hostId: string): Promise<{ ok: true; profile: ConnectProfile } | { ok: false; error: string }> {
	const { useHostsStore } = await import("@/store/hosts");
	const hosts = useHostsStore.getState().hosts;
	const stored = hosts.find((h) => h.id === hostId);
	if (!stored) return { ok: false, error: "找不到这台主机的配置" };
	// 引用了已保存的代理配置：连接时展开（Netcatty materializeHostProxyProfile）
	const { useProxyProfilesStore } = await import("@/store/proxyProfiles");
	const target = materializeHostProxyProfile(stored, useProxyProfilesStore.getState().profiles);
	if (stored.proxyProfileId && !stored.proxy && !target.proxy) {
		return { ok: false, error: "主机引用的代理配置不存在（保存的代理不存在），请在主机设置里重新选择代理" };
	}

	const byId = new Map(hosts.map((h) => [h.id, h]));
	// 跳板机的密码：先读钥匙串（读不到不算错，连接时会再问）
	const saved = new Map<string, string>();
	for (const id of target.jumpHostIds ?? []) {
		const hop = byId.get(id);
		if (hop?.auth.method !== "password") continue;
		try {
			// 凭据来自身份 / 分组时，密码在 identity:<id> / group:<id>；否则在主机 id 下
			const value = (hop.auth.secretAccount ? await secretLoad(hop.auth.secretAccount) : null) ?? (await secretLoad(id));
			if (value) saved.set(id, value);
		} catch {
			/* 钥匙串不可用：连接时向用户要 */
		}
	}
	let proxyPassword: string | undefined;
	let proxyUsername: string | undefined;
	const { useIdentitiesStore } = await import("@/store/identities");
	const identities = useIdentitiesStore.getState().identities;
	if (target.proxy?.identityId) {
		// 代理凭据来自钥匙串身份（Netcatty「钥匙串身份」）：用户名取身份，口令取 identity:<id>
		const identity = identities.find((i) => i.id === target.proxy?.identityId);
		if (!identity) return { ok: false, error: "钥匙串身份不存在" };
		if (!identity.username || !identity.hasPassword) return { ok: false, error: "代理身份需要用户名和密码" };
		proxyUsername = identity.username;
		try {
			proxyPassword = (await secretLoad(`identity:${identity.id}`)) ?? undefined;
		} catch {
			/* 钥匙串不可用：按空口令发（代理会如实拒绝） */
		}
	} else if (target.proxy?.username) {
		try {
			// 代理口令所在的钥匙串账户：主机自己的代理 → proxy:<主机 id>；代理配置 → proxy-profile:<id>；
			// 分组设置里的代理 → group-proxy:<定义它的分组 id>
			const raw = useHostsStore.getState().rawHostById(hostId);
			let account: string;
			if (raw?.proxy) account = proxySecretAccount(target.id);
			else if (stored.proxyProfileId) account = proxyProfileSecretAccount(stored.proxyProfileId);
			else {
				const { resolveGroupDefaults } = await import("./groupConfig");
				const { useGroupConfigsStore } = await import("@/store/groupConfigs");
				const d = resolveGroupDefaults(stored.groupId, useHostsStore.getState().groups, useGroupConfigsStore.getState().configs);
				account = `group-proxy:${d.proxyGroupId ?? ""}`;
			}
			proxyPassword = (await secretLoad(account)) ?? undefined;
		} catch {
			/* 钥匙串不可用：按空口令发（代理会如实拒绝） */
		}
	}
	const { useKeysStore } = await import("@/store/keys");
	const keys = useKeysStore.getState().keys;

	return buildConnectProfile(target, {
		hostById: (id) => byId.get(id),
		savedPassword: (id) => saved.get(id),
		proxyPassword,
		proxyUsername,
		keyLabel: (id) => keys.find((k) => k.id === id)?.name,
	});
}
