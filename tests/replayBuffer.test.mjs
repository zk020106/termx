import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplayBuffer } from "../.tmp/test-build/lib/replayBuffer.js";

test("keeps only the last `limit` characters", () => {
	const b = new ReplayBuffer(10);
	for (let i = 0; i < 100; i++) b.push(String(i % 10));
	assert.equal(b.text().length, 10);
	assert.equal(b.text(), "0123456789");
	b.push("abc");
	assert.equal(b.text(), "3456789abc");
	assert.equal(b.size, 10);
});

test("set and clear", () => {
	const b = new ReplayBuffer(5);
	b.set("hello world");
	assert.equal(b.text(), "world");
	b.clear();
	assert.equal(b.text(), "");
	b.push("");
	assert.equal(b.size, 0);
});
