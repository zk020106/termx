import {
	classifyLoadError,
	loadRawConfig,
	normalizeConfig,
	persistableForward,
	rawVersion,
	rememberUnknownFields,
	saveConfig,
	type ConfigLoadIssue,
	type PersistedConfig,
} from "@/lib/persist";
import { stripHostSecrets, type LegacySecret } from "@/lib/configSecrets";
import { secretRememberForSession, secretSave } from "@/lib/secret";
import { useForwardsStore } from "./forwards";
import { useHostsStore } from "./hosts";
import { useKeysStore } from "./keys";
import { useSettingsStore } from "./settings";
import { useSnippetsStore } from "./snippets";
import { useThemeStore } from "./theme";

/* =============================================================================
 * 把「磁盘上的配置」和「内存里的 store」接起来。
 *
 * 启动：读一次配置灌进各 store；读失败也必须让应用可用（给空数据）。
 * 运行：任一持久化字段变化后去抖保存，且内容没变就不写盘。
 * ========================================================================== */

/** 当前内存里的完整配置（写盘、导出配置都用这一份，保证两边永远一致） */
export function snapshotConfig(): PersistedConfig {
	const preferences = useSettingsStore.getState().toPreferences();
	return {
		version: 1,
		// 写盘与导出共用这一份：密码一律剥掉（只存系统钥匙串）
		hosts: stripHostSecrets(useHostsStore.getState().hosts).hosts,
		groups: useHostsStore.getState().groups,
		keys: useKeysStore.getState().keys,
		snippets: useSnippetsStore.getState().snippets,
		// 转发规则的运行期状态（运行中、连接数、流量）不进配置：否则流量每秒变化都会触发写盘
		forwards: useForwardsStore.getState().rules.map(persistableForward),
		preferences: { accent: useThemeStore.getState().accent, ...preferences },
	};
}

const snapshotText = () => JSON.stringify(snapshotConfig());

/**
 * 载入配置并灌进 store。返回值决定能不能开启自动保存：
 *  - null：正常；
 *  - corrupt：原文件解析失败、已备份，按空配置启动，可以保存（备份还在）；
 *  - failed：读失败（权限、IO 等）——**不能**自动保存，否则会用空配置覆盖用户的文件；
 *  - newer：文件是更高版本写的，同样不覆盖。
 */
export async function hydrateStores(): Promise<ConfigLoadIssue | null> {
	let raw: unknown;
	try {
		raw = await loadRawConfig();
	} catch (error) {
		console.error("配置载入失败，按空配置启动", error);
		useHostsStore.getState().setAll([], []);
		return classifyLoadError(error);
	}
	const version = rawVersion(raw);
	if (version !== null && version > 1) {
		rememberUnknownFields(raw);
		const loaded = normalizeConfig(raw as Partial<PersistedConfig>);
		const { hosts, legacy } = stripHostSecrets(loaded.hosts);
		applyConfig({ ...loaded, hosts });
		// 不写回文件（更高版本），但明文密码同样只交钥匙串 / 内存使用
		lastMigration = await migrateLegacySecrets(legacy);
		return { kind: "newer", version };
	}
	try {
		rememberUnknownFields(raw);
		const loaded = normalizeConfig(raw as Partial<PersistedConfig> | null);
		// 旧版本会把「记住的密码」与代理口令明文写进 termx.json：先剥掉再进 store，
		// 等偏好（钥匙串开关）就绪后迁进系统钥匙串，最后把干净的配置写回磁盘
		const { hosts, legacy } = stripHostSecrets(loaded.hosts);
		const config: PersistedConfig = { ...loaded, hosts };
		useHostsStore.getState().setAll(config.hosts, config.groups);
		useKeysStore.getState().setAll(config.keys);
		useSnippetsStore.getState().setAll(config.snippets);
		useForwardsStore.getState().setAll(config.forwards);
		// 强调色与终端/安全/数据偏好都来自配置文件，渲染前先灌进 store，
		// 首帧就是用户选的那套（xterm 也才会以正确字号/配色挂载）
		useThemeStore.getState().setAccent(config.preferences.accent);
		useSettingsStore.getState().hydrate(config.preferences);
		lastMigration = await migrateLegacySecrets(legacy);
		// 立刻把规范化后的配置写回一次（明文密码也就此从磁盘上消失）：
		// 首次启动会因此创建配置文件，老文件缺字段也会被补齐。
		await saveConfig(config);
		return null;
	} catch (error) {
		console.error("配置载入失败，按空配置启动", error);
		useHostsStore.getState().setAll([], []);
		return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
	}
}

export interface SecretMigrationReport {
	/** 迁进系统钥匙串的条数 */
	migrated: number;
	/** 钥匙串不可用 / 已关闭：只留在本次运行内存里的条目（主机 id 与种类） */
	sessionOnly: LegacySecret[];
	reason?: string;
}

let lastMigration: SecretMigrationReport | null = null;

/** 启动时的明文密码迁移结果（取一次就清空），供启动后提示用户 */
export function takeSecretMigrationReport(): SecretMigrationReport | null {
	const report = lastMigration;
	lastMigration = null;
	return report;
}

/**
 * 把旧配置里的明文密码 / 代理口令迁进系统钥匙串。迁移失败（钥匙串不可用 / 设置里关掉了）时
 * 不会再写回配置文件，而是留在本次运行的内存里继续可用，并如实提示：下次启动需要重新输入。
 */
export async function migrateLegacySecrets(legacy: LegacySecret[]): Promise<SecretMigrationReport | null> {
	if (legacy.length === 0) return null;
	const report: SecretMigrationReport = { migrated: 0, sessionOnly: [] };
	for (const item of legacy) {
		try {
			await secretSave(item.account, item.password);
			report.migrated += 1;
		} catch (error) {
			secretRememberForSession(item.account, item.password);
			report.sessionOnly.push(item);
			report.reason = error instanceof Error ? error.message : String(error);
		}
	}
	return report;
}

function applyConfig(config: PersistedConfig) {
	useHostsStore.getState().setAll(config.hosts, config.groups);
	useKeysStore.getState().setAll(config.keys);
	useSnippetsStore.getState().setAll(config.snippets);
	useForwardsStore.getState().setAll(config.forwards);
	useThemeStore.getState().setAccent(config.preferences.accent);
	useSettingsStore.getState().hydrate(config.preferences);
}

export function startAutosave(): () => void {
	let timer: number | null = null;
	// 用序列化结果做脏检查：改视图、改搜索词这类内存态不该触发写盘
	let lastSaved = snapshotText();

	const flush = () => {
		timer = null;
		const text = snapshotText();
		if (text === lastSaved) return;
		lastSaved = text;
		void saveConfig(JSON.parse(text) as PersistedConfig).catch((error) => {
			console.error("配置保存失败", error);
		});
	};

	const schedule = () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(flush, 300);
	};

	const unsubscribes = [
		useHostsStore.subscribe(schedule),
		useKeysStore.subscribe(schedule),
		useSnippetsStore.subscribe(schedule),
		useForwardsStore.subscribe(schedule),
		useThemeStore.subscribe(schedule),
		useSettingsStore.subscribe(schedule),
	];

	return () => {
		for (const unsubscribe of unsubscribes) unsubscribe();
		if (timer !== null) window.clearTimeout(timer);
	};
}

/** 手动立即写盘（导入配置后立刻落盘等场景用） */
export async function flushNow(): Promise<void> {
	await saveConfig(snapshotConfig());
}
