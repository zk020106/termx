// 配置里明文密码剥离 / 迁移的单测
import assert from "node:assert/strict";
import { test } from "node:test";
import { proxySecretAccount, stripHostSecrets } from "../.tmp/test-build/lib/configSecrets.js";

const host = (id, auth, proxy) => ({ id, name: id, hostname: "h", port: 22, username: "u", auth, proxy });

test("剥掉明文登录密码与代理口令并交出来迁移；其他字段原样保留", () => {
	const input = [
		host("a", { method: "password", rememberPassword: true, password: "hunter2" }, null),
		host("b", { method: "key", keyPath: "/k" }, { type: "socks5", host: "p", port: 1080, username: "pu", password: "pp" }),
		host("c", { method: "password", password: "" }, { type: "http", host: "p", port: 3128 }),
	];
	const { hosts, legacy } = stripHostSecrets(input);
	assert.deepEqual(legacy, [
		{ account: "a", hostId: "a", kind: "login", password: "hunter2" },
		{ account: "proxy:b", hostId: "b", kind: "proxy", password: "pp" },
	]);
	for (const h of hosts) {
		assert.equal("password" in h.auth, false, h.id);
		if (h.proxy) assert.equal("password" in h.proxy, false, h.id);
	}
	assert.equal(hosts[0].auth.rememberPassword, true);
	assert.equal(hosts[1].proxy.username, "pu", "代理用户名保留");
	assert.equal(hosts[2], input[2].auth.password === "" ? hosts[2] : null);
	const text = JSON.stringify(hosts);
	assert.equal(text.includes("hunter2") || text.includes('"pp"'), false);
	// 不改动入参
	assert.equal(input[0].auth.password, "hunter2");
	assert.equal(input[1].proxy.password, "pp");
});

test("没有机密字段的主机原样返回（同一引用）", () => {
	const h = host("k", { method: "key", keyPath: "/k" }, null);
	assert.equal(stripHostSecrets([h]).hosts[0], h);
	assert.equal(proxySecretAccount("x"), "proxy:x");
});

test("旧版只靠「配置里有密码」表示记住：迁走后 rememberPassword 补成 true；显式 false 保持", () => {
	const { hosts } = stripHostSecrets([
		host("old", { method: "password", password: "pw" }, null),
		host("off", { method: "password", rememberPassword: false, password: "pw" }, null),
	]);
	assert.equal(hosts[0].auth.rememberPassword, true);
	assert.equal(hosts[1].auth.rememberPassword, false);
});
