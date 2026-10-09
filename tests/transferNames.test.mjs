import assert from "node:assert/strict";
import { test } from "node:test";
import { freeName, numberedName, splitExt } from "../.tmp/test-build/lib/transferNames.js";

test("numbered names keep the extension", () => {
	assert.deepEqual(splitExt(".bashrc"), [".bashrc", ""]);
	assert.equal(numberedName("a.tar.gz", 2), "a.tar (2).gz");
	assert.equal(numberedName("README", 1), "README (1)");
});

test("freeName skips taken names", async () => {
	const taken = new Set(["x (1).txt", "x (2).txt"]);
	assert.equal(await freeName("x.txt", async (c) => taken.has(c)), "x (3).txt");
	await assert.rejects(freeName("x.txt", async () => true, 3));
});
