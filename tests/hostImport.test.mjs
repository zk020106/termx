import assert from "node:assert/strict";
import { test } from "node:test";
import { expandHome, parseHostCsv, parseSshConfig, toHosts } from "../.tmp/test-build/lib/hostImport.js";

const config = `
# comment
Host bastion
  HostName 1.2.3.4
  User ops
  Port 2222
  IdentityFile ~/.ssh/id_ed25519

Host app1 app2
  HostName=10.0.0.5
  User deploy
  ProxyJump bastion
  User ignored-second

Host *.corp *
  User nobody

Include conf.d/*
Match host foo
  User bar
`;

test("parses Host blocks and skips wildcards / Include / Match", () => {
	const res = parseSshConfig(config);
	assert.deepEqual(
		res.hosts.map((h) => [h.alias, h.hostname, h.port, h.username]),
		[
			["bastion", "1.2.3.4", 2222, "ops"],
			["app1", "10.0.0.5", 22, "deploy"],
			["app2", "10.0.0.5", 22, "deploy"],
		],
	);
	assert.equal(res.skipped.length, 4);
});

test("toHosts maps ProxyJump aliases, expands ~ and skips duplicates", () => {
	const res = parseSshConfig(config);
	const existing = [
		{ id: "x", name: "app2", hostname: "h", port: 22, username: "u", tags: [], favorite: false, groupId: null, auth: { method: "agent" }, jumpHostIds: [], reachable: true },
	];
	const { hosts, conflicts } = toHosts(res.hosts, existing, { home: "/home/me", defaultUser: "me", now: 1 });
	assert.equal(hosts.length, 2);
	const bastion = hosts.find((h) => h.name === "bastion");
	const app1 = hosts.find((h) => h.name === "app1");
	assert.equal(bastion.auth.method, "key");
	assert.equal(bastion.auth.keyPath, "/home/me/.ssh/id_ed25519");
	assert.deepEqual(app1.jumpHostIds, [bastion.id]);
	assert.equal(conflicts.length, 1);
	assert.equal(expandHome("~", "/h"), "/h");
});

test("CSV import with Chinese headers and quotes", () => {
	const csv = '\uFEFF名称,地址,用户,端口\n"db, primary",10.0.0.1,postgres,5432\n,,,\nweb,10.0.0.2,,\n';
	const res = parseHostCsv(csv);
	assert.deepEqual(
		res.hosts.map((h) => [h.alias, h.hostname, h.username, h.port]),
		[
			["db, primary", "10.0.0.1", "postgres", 5432],
			["web", "10.0.0.2", "", 22],
		],
	);
	assert.ok(parseHostCsv("a,b\n1,2").skipped[0].includes("表头"));
});
