import { test } from "node:test";
import assert from "node:assert/strict";
import {
	duplicateProxyProfile,
	getProfileUsageCount,
	materializeHostProxyProfile,
	prepareProxyProfileForSave,
	removeProxyProfileReferences,
} from "../.tmp/test-build/lib/proxyProfiles.js";

const profile = { id: "p1", label: "corp", config: { type: "http", host: "proxy", port: 8080, username: "u" }, createdAt: 1 };
const host = (over) => ({ id: "h", name: "h", hostname: "h", port: 22, ...over });

test("materialize expands a referenced profile, host proxy wins", () => {
	const h = materializeHostProxyProfile(host({ proxyProfileId: "p1" }), [profile]);
	assert.deepEqual(h.proxy, profile.config);
	assert.notEqual(h.proxy, profile.config, "config is cloned");
	const own = { type: "socks5", host: "x", port: 1 };
	assert.equal(materializeHostProxyProfile(host({ proxy: own, proxyProfileId: "p1" }), [profile]).proxy, own);
	assert.equal(materializeHostProxyProfile(host({ proxyProfileId: "gone" }), [profile]).proxy, undefined);
});

test("delete removes references and usage counts", () => {
	const hosts = [host({ id: "a", proxyProfileId: "p1" }), host({ id: "b", proxyProfileId: "p2" }), host({ id: "c" })];
	assert.equal(getProfileUsageCount("p1", hosts), 1);
	const cleaned = removeProxyProfileReferences("p1", hosts);
	assert.equal("proxyProfileId" in cleaned[0], false);
	assert.equal(cleaned[1].proxyProfileId, "p2");
});

test("save validation and duplicate naming follow Netcatty", () => {
	assert.equal(prepareProxyProfileForSave({ ...profile, label: " " }).error, "required");
	assert.equal(prepareProxyProfileForSave({ ...profile, config: { ...profile.config, port: 70000 } }).error, "port");
	const ok = prepareProxyProfileForSave({ ...profile, label: " corp ", config: { type: "socks5", host: " p ", port: 1080, username: " " } }, 5);
	assert.deepEqual(ok.saved, { ...profile, label: "corp", config: { type: "socks5", host: "p", port: 1080 }, updatedAt: 5 });
	const copy = duplicateProxyProfile(profile, 9);
	assert.equal(copy.label, "corp 副本");
	assert.notEqual(copy.id, profile.id);
	assert.deepEqual(copy.config, profile.config);
});
