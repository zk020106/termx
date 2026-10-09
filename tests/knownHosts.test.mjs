import { test } from "node:test";
import assert from "node:assert/strict";
import { convertibleHost, knownHostLabel } from "../.tmp/test-build/lib/knownHosts.js";

const entry = (over) => ({
	source: "termx",
	lineNo: 1,
	line: "x",
	patterns: ["example.com"],
	host: "example.com",
	port: 22,
	keyType: "ssh-ed25519",
	fingerprint: "SHA256:abc",
	marker: null,
	hashed: false,
	...over,
});

test("plain and bracketed entries convert to host", () => {
	assert.deepEqual(convertibleHost(entry({})), { hostname: "example.com", port: 22 });
	assert.deepEqual(convertibleHost(entry({ patterns: ["[10.0.0.1]:2222"], host: "10.0.0.1", port: 2222 })), {
		hostname: "10.0.0.1",
		port: 2222,
	});
});

test("hashed, wildcard, negated and marked entries are not convertible", () => {
	assert.equal(convertibleHost(entry({ hashed: true, host: null, patterns: ["|1|a|b"] })), null);
	assert.equal(convertibleHost(entry({ host: "*.example.com" })), null);
	assert.equal(convertibleHost(entry({ host: "!bad" })), null);
	assert.equal(convertibleHost(entry({ marker: "@revoked" })), null);
	assert.equal(knownHostLabel(entry({ hashed: true })), "（哈希的主机名）");
	assert.equal(knownHostLabel(entry({ patterns: ["a", "b"] })), "a, b");
});
