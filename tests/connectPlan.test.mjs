import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConnectProfile, describeRoute, hopCredential, resolveJumpChain } from "../.tmp/test-build/lib/connectPlan.js";

const host = (id, extra = {}) => ({
	id,
	name: id,
	groupId: null,
	hostname: `${id}.example`,
	port: 22,
	username: "u",
	tags: [],
	favorite: false,
	auth: { method: "agent" },
	jumpHostIds: [],
	reachable: true,
	...extra,
});

test("hop credentials follow each hop's own auth method", () => {
	assert.deepEqual(hopCredential(host("a", { auth: { method: "password" } }), "pw"), { method: "password", password: "pw" });
	assert.deepEqual(hopCredential(host("a", { auth: { method: "password" } }), undefined), { method: "ask_password" });
	assert.deepEqual(hopCredential(host("a", { auth: { method: "key", keyPath: "/k" } }), undefined), {
		method: "private_key",
		path: "/k",
		passphrase: null,
	});
	assert.deepEqual(hopCredential(host("a", { auth: { method: "key-passphrase", keyPath: "/k" } }), undefined), {
		method: "ask_passphrase",
		path: "/k",
	});
	assert.ok("error" in hopCredential(host("a", { auth: { method: "key" } }), undefined));
});

test("jump chain rejects missing hosts, self references and duplicates", () => {
	const a = host("a");
	const b = host("b");
	const map = new Map([
		["a", a],
		["b", b],
	]);
	const by = (id) => map.get(id);
	assert.deepEqual(resolveJumpChain(host("t", { jumpHostIds: ["a", "b"] }), by), [a, b]);
	assert.ok("error" in resolveJumpChain(host("t", { jumpHostIds: ["zz"] }), by));
	assert.ok("error" in resolveJumpChain(host("t", { jumpHostIds: ["t"] }), (id) => (id === "t" ? host("t") : map.get(id))));
	assert.ok("error" in resolveJumpChain(host("t", { jumpHostIds: ["a", "a"] }), by));
});

test("profile carries proxy auth, env, login script and encoding", () => {
	const target = host("t", {
		jumpHostIds: ["a"],
		proxy: { type: "socks5", host: "127.0.0.1", port: 1080, username: "pu", password: "cfg" },
		envVars: [
			{ key: " LANG ", value: "C.UTF-8" },
			{ key: "", value: "dropped" },
		],
		loginScript: "cd /srv\n",
		encoding: "GBK",
		termType: "xterm-256color",
	});
	const res = buildConnectProfile(target, {
		hostById: (id) => (id === "a" ? host("a", { auth: { method: "password" } }) : undefined),
		savedPassword: (id) => (id === "a" ? "secret" : undefined),
		proxyPassword: "kc",
	});
	assert.equal(res.ok, true);
	const p = res.profile;
	assert.equal(p.jumps.length, 1);
	assert.deepEqual(p.jumps[0].credential, { method: "password", password: "secret" });
	assert.equal(p.proxy.password, "kc", "proxy password comes from the keychain");
	assert.deepEqual(p.env, [{ key: "LANG", value: "C.UTF-8" }]);
	assert.equal(p.encoding, "GBK");
	assert.equal(describeRoute(p, { hostname: "t.example", port: 22 }), "本机 → SOCKS5 127.0.0.1:1080 → a → t.example:22");
});

test("invalid proxy port is reported instead of silently ignored", () => {
	const res = buildConnectProfile(host("t", { proxy: { type: "http", host: "p", port: 0 } }), {
		hostById: () => undefined,
		savedPassword: () => undefined,
	});
	assert.equal(res.ok, false);
});

test("plaintext passwords left in an old config are never used (keychain only)", () => {
	const target = host("t", {
		auth: { method: "password", rememberPassword: true, password: "old-plain" },
		jumpHostIds: ["a"],
		proxy: { type: "socks5", host: "127.0.0.1", port: 1080, username: "pu", password: "old-proxy" },
	});
	const res = buildConnectProfile(target, {
		hostById: (id) => (id === "a" ? host("a", { auth: { method: "password", rememberPassword: true, password: "old-jump" } }) : undefined),
		savedPassword: () => undefined,
	});
	assert.equal(res.ok, true);
	assert.deepEqual(res.profile.jumps[0].credential, { method: "ask_password" }, "jump asks instead of using the plaintext");
	assert.equal(res.profile.proxy.password, "", "proxy password not taken from config");
	assert.equal(JSON.stringify(res.profile).includes("old-"), false);
});
