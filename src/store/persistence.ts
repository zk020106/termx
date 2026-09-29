import { loadConfig, saveConfig, type PersistedConfig } from "@/lib/persist";
import { useForwardsStore } from "./forwards";
import { useHostsStore } from "./hosts";
import { useKeysStore } from "./keys";
import { useSnippetsStore } from "./snippets";
import { useThemeStore } from "./theme";

/* =============================================================================
 * 把「磁盘上的配置」和「内存里的 store」接起来。
 *
 * 启动：读一次配置灌进各 store；读失败也必须让应用可用（给空数据）。
 * 运行：任一持久化字段变化后去抖保存，且内容没变就不写盘。
 * ========================================================================== */

function snapshot(): PersistedConfig {
	return {
		version: 1,
		hosts: useHostsStore.getState().hosts,
		groups: useHostsStore.getState().groups,
		keys: useKeysStore.getState().keys,
		snippets: useSnippetsStore.getState().snippets,
		forwards: useForwardsStore.getState().rules,
		preferences: { accent: useThemeStore.getState().accent },
	};
}

const snapshotText = () => JSON.stringify(snapshot());

export async function hydrateStores(): Promise<void> {
	try {
		const config = await loadConfig();
		useHostsStore.getState().setAll(config.hosts, config.groups);
		useKeysStore.getState().setAll(config.keys);
		useSnippetsStore.getState().setAll(config.snippets);
		useForwardsStore.getState().setAll(config.forwards);
		// 强调色来自配置文件，渲染前先落到 <html data-accent>，首帧就是用户选的那套
		useThemeStore.getState().setAccent(config.preferences.accent);
		// 立刻把规范化后的配置写回一次：
		// 首次启动会因此创建配置文件，老文件缺字段也会被补齐。
		await saveConfig(config);
	} catch (error) {
		console.error("配置载入失败，按空配置启动", error);
		useHostsStore.getState().setAll([], []);
	}
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
	];

	return () => {
		for (const unsubscribe of unsubscribes) unsubscribe();
		if (timer !== null) window.clearTimeout(timer);
	};
}

/** 手动立即写盘（设置页的「立即备份」等场景用） */
export async function flushNow(): Promise<void> {
	await saveConfig(snapshot());
}
