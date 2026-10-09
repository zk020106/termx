import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@/styles/theme.css";

import App from "@/App";
import type { ConfigLoadIssue } from "@/lib/persist";
import { wireForwardAutoStart } from "@/lib/forwardManager";
import { hydrateStores, reloadFromDisk, startAutosave, takeSecretMigrationReport } from "@/store/persistence";
import { useSessionsStore } from "@/store/sessions";
import { isTauri } from "@/lib/tauri";
import { currentWindowLabel, isSessionWindow, takeSessionWindowPayload } from "@/lib/window";
import { useHostsStore } from "@/store/hosts";
import { toast } from "@/store/toast";

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root 挂载点");

// 先把磁盘上的配置读进 store 再渲染，避免首帧闪一下空列表。
// 加超时兜底：持久化层出任何问题都不该让应用起不来。
// 自动保存必须等载入真正完成后才开启——否则超时后先渲染出的空 store
// 会被当成「用户的配置」写回磁盘，把原文件冲掉。
const hydration = hydrateStores().then((issue) => {
	if (issue === null || issue.kind === "corrupt") startAutosave();
	if (issue) window.setTimeout(() => reportConfigIssue(issue), 600);
	const migration = takeSecretMigrationReport();
	if (migration) window.setTimeout(() => reportSecretMigration(migration), 800);
	// 端口转发自启只由主窗口做一次（Netcatty：会话窗口不跑托盘 / 自启这类全局副作用）
	if (!isSessionWindow()) void wireForwardAutoStart();
	return issue;
});
await Promise.race([hydration, new Promise((resolve) => window.setTimeout(resolve, 3000))]);

// 多窗口：别的窗口写过配置就重新载入（后端 config_save 广播来源窗口标签）
if (isTauri()) {
	void import("@tauri-apps/api/event").then(({ listen }) =>
		listen<string>("config://changed", (event) => {
			if (event.payload !== currentWindowLabel()) void reloadFromDisk();
		}),
	);
}

// 「复制标签页到新窗口」打开的会话窗口：取走载荷，按原布局克隆标签（Netcatty createSessionFromCloneSource）
if (isSessionWindow()) {
	void hydration.then(async () => {
		const payload = await takeSessionWindowPayload().catch(() => null);
		if (payload?.tab && Array.isArray(payload.panes)) {
			useSessionsStore.getState().importTab(payload.tab, payload.panes);
		}
	});
}

function reportSecretMigration(report: NonNullable<ReturnType<typeof takeSecretMigrationReport>>) {
	if (report.sessionOnly.length === 0) {
		toast({
			title: "已把配置里的明文密码迁入系统钥匙串",
			description: `${report.migrated} 个密码 / 代理口令已移出 termx.json`,
			tone: "success",
		});
		return;
	}
	const hosts = useHostsStore.getState().hosts;
	const names = report.sessionOnly
		.map((item) => `${hosts.find((h) => h.id === item.hostId)?.name ?? item.hostId}${item.kind === "proxy" ? "（代理）" : ""}`)
		.join("、");
	toast({
		title: "配置里的明文密码已移出，但系统钥匙串不可用",
		description: `${names} 的密码本次运行内仍可用，重启后需要重新输入${report.reason ? ` · ${report.reason}` : ""}`,
		tone: "warning",
		duration: 15000,
	});
}

function reportConfigIssue(issue: ConfigLoadIssue) {
	if (issue.kind === "corrupt") {
		toast({
			title: "配置文件损坏，已备份并按空配置启动",
			description: `${issue.message} · 备份：${issue.backupPath}`,
			tone: "warning",
			duration: 15000,
		});
	} else if (issue.kind === "newer") {
		toast({
			title: "配置文件来自更新版本的 termx",
			description: `文件版本 ${issue.version}。为避免丢失新版本的数据，本次运行中的修改不会写回配置文件。`,
			tone: "warning",
			duration: 15000,
		});
	} else {
		toast({
			title: "配置读取失败，本次修改不会保存",
			description: `${issue.message} · 为避免用空配置覆盖原文件，已暂停自动保存。请检查文件权限后重启。`,
			tone: "danger",
			duration: 15000,
		});
	}
}

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
