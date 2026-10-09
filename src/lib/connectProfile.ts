import { buildConnectProfile, type ConnectProfile } from "./connectPlan";
import { proxySecretAccount } from "./configSecrets";
import { secretLoad } from "./secret";

/* 从 store 与钥匙串里取数据，生成某台主机的连接 profile（纯逻辑见 connectPlan.ts）。 */

export async function resolveConnectProfile(hostId: string): Promise<{ ok: true; profile: ConnectProfile } | { ok: false; error: string }> {
	const { useHostsStore } = await import("@/store/hosts");
	const hosts = useHostsStore.getState().hosts;
	const target = hosts.find((h) => h.id === hostId);
	if (!target) return { ok: false, error: "找不到这台主机的配置" };

	const byId = new Map(hosts.map((h) => [h.id, h]));
	// 跳板机的密码：先读钥匙串（读不到不算错，连接时会再问）
	const saved = new Map<string, string>();
	for (const id of target.jumpHostIds ?? []) {
		const hop = byId.get(id);
		if (hop?.auth.method !== "password") continue;
		try {
			const value = await secretLoad(id);
			if (value) saved.set(id, value);
		} catch {
			/* 钥匙串不可用：连接时向用户要 */
		}
	}
	let proxyPassword: string | undefined;
	if (target.proxy?.username) {
		try {
			proxyPassword = (await secretLoad(proxySecretAccount(target.id))) ?? undefined;
		} catch {
			/* 钥匙串不可用：按空口令发（代理会如实拒绝） */
		}
	}

	return buildConnectProfile(target, {
		hostById: (id) => byId.get(id),
		savedPassword: (id) => saved.get(id),
		proxyPassword,
	});
}
