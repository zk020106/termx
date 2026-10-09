import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGroupDefaults, effectiveHost, resolveGroupDefaults, toRawHost } from "../.tmp/test-build/lib/groupConfig.js";
import { useHostsStore } from "../.tmp/test-build/store/hosts.js";
import { useGroupConfigsStore } from "../.tmp/test-build/store/groupConfigs.js";
import { useIdentitiesStore } from "../.tmp/test-build/store/identities.js";

const groups = [
	{ id: "a", name: "A", parentId: null },
	{ id: "b", name: "B", parentId: "a" },
];
const host = (over = {}) => ({
	id: "h1",
	name: "h1",
	groupId: "b",
	hostname: "10.0.0.1",
	port: 0,
	username: "",
	tags: [],
	favorite: false,
	auth: { method: "password" },
	jumpHostIds: [],
	reachable: false,
	...over,
});

test("resolveGroupDefaults：子分组覆盖父分组，proxyProfileId 与 proxyConfig 互斥", () => {
	const d = resolveGroupDefaults("b", groups, [
		{ groupId: "a", username: "ops", port: 2222, proxyProfileId: "pp", startupCommand: "uptime" },
		{ groupId: "b", port: 2200, proxyConfig: { type: "socks5", host: "p", port: 1080 } },
	]);
	assert.equal(d.username, "ops");
	assert.equal(d.port, 2200);
	assert.equal(d.proxyProfileId, undefined);
	assert.equal(d.proxyConfig.host, "p");
	assert.equal(d.startupCommand, "uptime");
});

test("resolveGroupDefaults：子分组的身份替换父分组的手动凭据；themeOverride=false 跳过主题", () => {
	const d = resolveGroupDefaults("b", groups, [
		{ groupId: "a", username: "ops", authMethod: "key", keyId: "k1", theme: "x" },
		{ groupId: "b", identityId: "id1", theme: "y", themeOverride: false },
	]);
	assert.equal(d.identityId, "id1");
	assert.equal(d.username, undefined);
	assert.equal(d.keyId, undefined);
	assert.equal(d.theme, "x");
	const d2 = resolveGroupDefaults("b", groups, [
		{ groupId: "a", identityId: "id1" },
		{ groupId: "b", username: "dba", hasPassword: true },
	]);
	assert.equal(d2.identityId, undefined);
	assert.equal(d2.username, "dba");
	assert.equal(d2.passwordGroupId, "b");
});

test("applyGroupDefaults：只填主机未设置的字段；手动凭据不被覆盖", () => {
	const d = { username: "ops", port: 2222, authMethod: "key", keyId: "k1", startupCommand: "uptime", charset: "GBK", jumpHostIds: ["j"] };
	const e = applyGroupDefaults(host(), d);
	assert.equal(e.username, "ops");
	assert.equal(e.port, 2222);
	assert.equal(e.auth.method, "key");
	assert.equal(e.auth.keyId, "k1");
	assert.equal(e.loginScript, "uptime");
	assert.equal(e.encoding, "GBK");
	assert.deepEqual(e.jumpHostIds, ["j"]);
	const own = applyGroupDefaults(host({ username: "me", port: 22, auth: { method: "agent" }, jumpHostIds: ["x"] }), d);
	assert.equal(own.username, "me");
	assert.equal(own.port, 22);
	assert.equal(own.auth.method, "agent");
	assert.deepEqual(own.jumpHostIds, ["x"]);
});

test("effectiveHost：身份提供用户名与密钥；默认端口 22、用户名 root", () => {
	const ctx = { groups, groupConfigs: [{ groupId: "a", identityId: "id1" }], identities: [{ id: "id1", label: "ops", username: "deploy", authMethod: "key", keyId: "k9", created: 0 }] };
	const e = effectiveHost(host(), ctx);
	assert.equal(e.username, "deploy");
	assert.equal(e.auth.method, "key");
	assert.equal(e.auth.keyId, "k9");
	assert.equal(e.auth.secretAccount, "identity:id1");
	assert.equal(e.port, 22);
	const plain = effectiveHost(host({ groupId: null }), { groups, groupConfigs: [], identities: [] });
	assert.equal(plain.username, "root");
	// 分组密码：钥匙串账户 group:<定义它的分组>
	const gp = effectiveHost(host(), { groups, groupConfigs: [{ groupId: "a", username: "u", hasPassword: true }], identities: [] });
	assert.equal(gp.auth.secretAccount, "group:a");
	assert.equal(gp.auth.credentialSource, "group");
});

test("toRawHost：改名 / 置顶不会把继承来的值固化进主机", () => {
	const raw = host();
	const eff = effectiveHost(raw, { groups, groupConfigs: [{ groupId: "a", port: 2222, username: "ops" }], identities: [] });
	const back = toRawHost({ ...eff, name: "renamed", pinned: true }, raw, eff);
	assert.equal(back.name, "renamed");
	assert.equal(back.port, 0);
	assert.equal(back.username, "");
	assert.equal(back.auth.secretAccount, undefined);
	// 用户真的改了端口：保留
	assert.equal(toRawHost({ ...eff, port: 2022 }, raw, eff).port, 2022);
});

test("hosts store：生效层随分组设置 / 身份变化重算，落盘的是原始主机", () => {
	useHostsStore.getState().setAll([host()], groups);
	assert.equal(useHostsStore.getState().hosts[0].port, 22);
	useGroupConfigsStore.getState().save({ groupId: "a", port: 2222 });
	assert.equal(useHostsStore.getState().hosts[0].port, 2222);
	useIdentitiesStore.getState().setAll([{ id: "i", label: "i", username: "idu", authMethod: "password", created: 0 }]);
	useGroupConfigsStore.getState().save({ groupId: "b", identityId: "i" });
	assert.equal(useHostsStore.getState().hosts[0].username, "idu");
	useHostsStore.getState().togglePinned("h1");
	assert.equal(useHostsStore.getState().rawHosts[0].port, 0);
	assert.equal(useHostsStore.getState().rawHosts[0].username, "");
	useHostsStore.getState().upsertHost({ ...useHostsStore.getState().hosts[0], name: "x" });
	assert.equal(useHostsStore.getState().rawHosts[0].username, "");
	assert.equal(useHostsStore.getState().rawHosts[0].name, "x");
	// 删除分组时一并删掉分组设置
	useHostsStore.getState().removeGroup("a");
	assert.equal(useGroupConfigsStore.getState().configs.length, 0);
	useGroupConfigsStore.getState().setAll([]);
	useIdentitiesStore.getState().setAll([]);
});
