import type { PersistedConfig } from "./persist";
import { normalizeConfig } from "./persist";
import { proxySecretAccount, stripHostSecrets } from "./configSecrets";
import { flushNow, migrateLegacySecrets, snapshotConfig } from "@/store/persistence";
import { useForwardsStore } from "@/store/forwards";
import { useHostsStore } from "@/store/hosts";
import { useKeysStore } from "@/store/keys";
import { useSnippetsStore } from "@/store/snippets";

/* =============================================================================
 * 配置的手动导入 / 导出。
 *
 * 导出的是**未加密**的 JSON：它包含主机、分组、密钥引用、片段、转发规则与偏好，
 * 不含任何密码（密码在系统钥匙串里），但里面有主机地址与用户名，
 * 所以导出文件按敏感文件对待 —— 界面文案如实说「未加密」。
 * 定时 / 加密备份是另一件事，需要备份服务，本文件不做假。
 * ========================================================================== */

const STAMP_PAD = (value: number) => String(value).padStart(2, "0");

function fileStamp(): string {
	const now = new Date();
	return `${now.getFullYear()}${STAMP_PAD(now.getMonth() + 1)}${STAMP_PAD(now.getDate())}-${STAMP_PAD(now.getHours())}${STAMP_PAD(now.getMinutes())}`;
}

/** 导出为文件：与「保存屏幕内容」同一套下载机制 */
export function exportConfig(): void {
	const config = snapshotConfig();
	const blob = new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: "application/json;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `termx-config-${fileStamp()}.json`;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

export interface ImportSummary {
	hostsAdded: number;
	hostsUpdated: number;
	groups: number;
	keys: number;
	snippets: number;
	forwards: number;
	/** 导入文件里带着的旧版明文密码：迁进钥匙串的条数 / 只留在本次运行内存里的条数 */
	secretsMigrated: number;
	secretsSessionOnly: number;
}

/** 解析导入文件；读不懂就抛错，由调用方提示 */
export function parseConfigFile(text: string): PersistedConfig {
	const parsed = JSON.parse(text) as Partial<PersistedConfig> | null;
	if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.hosts)) {
		throw new Error("这个文件不是 TermX 配置（缺少 hosts 列表）");
	}
	return normalizeConfig(parsed);
}

/**
 * 合并进当前 store：
 * - 主机按「地址:端口」判重，已存在就更新（保留本机 id，避免会话引用断开），否则新增；
 * - 分组 / 密钥 / 片段 / 转发按 id 合并（同 id 以导入文件为准）；
 * - 本机偏好（主题、终端、安全）不导入，免得别人的设置把界面改掉。
 */
export async function mergeConfig(incoming: PersistedConfig): Promise<ImportSummary> {
	const hostStore = useHostsStore.getState();
	const mergedHosts = [...hostStore.hosts];
	const byAddress = new Map(mergedHosts.map((host) => [`${host.hostname}:${host.port}`, host]));
	let hostsAdded = 0;
	let hostsUpdated = 0;
	// 导入文件若带着旧版的明文密码：不进 store、不落盘，按合并后的主机 id 迁进钥匙串
	const { hosts: incomingHosts, legacy } = stripHostSecrets(incoming.hosts);
	const finalId = new Map<string, string>();

	for (const host of incomingHosts) {
		const key = `${host.hostname}:${host.port}`;
		const existing = byAddress.get(key);
		if (existing) {
			const index = mergedHosts.findIndex((item) => item.id === existing.id);
			// 保留本机 id：分屏格、会话标签、转发规则都按 id 引用主机
			mergedHosts[index] = { ...host, id: existing.id };
			finalId.set(host.id, existing.id);
			hostsUpdated += 1;
			continue;
		}
		const conflict = mergedHosts.some((item) => item.id === host.id);
		const next = conflict ? { ...host, id: `${host.id}-imported` } : host;
		mergedHosts.push(next);
		finalId.set(host.id, next.id);
		byAddress.set(key, next);
		hostsAdded += 1;
	}

	const mergeById = <T extends { id: string }>(current: T[], added: T[]): T[] => {
		const map = new Map(current.map((item) => [item.id, item]));
		for (const item of added) map.set(item.id, item);
		return [...map.values()];
	};

	const groups = mergeById(hostStore.groups, incoming.groups);
	const keys = mergeById(useKeysStore.getState().keys, incoming.keys);
	const snippets = mergeById(useSnippetsStore.getState().snippets, incoming.snippets);
	const forwards = mergeById(useForwardsStore.getState().rules, incoming.forwards);

	useHostsStore.getState().setAll(mergedHosts, groups);
	useKeysStore.getState().setAll(keys);
	useSnippetsStore.getState().setAll(snippets);
	useForwardsStore.getState().setAll(forwards);
	// 导入是用户的明确动作，立刻落盘，不等去抖
	await flushNow();
	const migration = await migrateLegacySecrets(
		legacy.map((item) => {
			const hostId = finalId.get(item.hostId) ?? item.hostId;
			return { ...item, hostId, account: item.kind === "proxy" ? proxySecretAccount(hostId) : hostId };
		}),
	);

	return {
		hostsAdded,
		hostsUpdated,
		groups: incoming.groups.length,
		keys: incoming.keys.length,
		snippets: incoming.snippets.length,
		forwards: incoming.forwards.length,
		secretsMigrated: migration?.migrated ?? 0,
		secretsSessionOnly: migration?.sessionOnly.length ?? 0,
	};
}
