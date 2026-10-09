import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveLook, schemeIdFromName } from "../.tmp/test-build/lib/hostTerminal.js";

const global = { scheme: "one-dark", fontFamily: "JetBrains Mono", fontSize: 13, lineHeight: 1.2, cursorStyle: "block" };

test("host prefs only apply when marked custom", () => {
	assert.deepEqual(effectiveLook(global, { colorScheme: "Dracula", fontSize: "18" }), global);
	const look = effectiveLook(global, { custom: true, colorScheme: "Dracula", fontSize: "18", lineHeight: "9", cursorStyle: "bar" });
	assert.equal(look.scheme, "dracula");
	assert.equal(look.fontSize, 18);
	assert.equal(look.lineHeight, 1.2, "out-of-range line height falls back to global");
	assert.equal(look.cursorStyle, "bar");
});

test("scheme names map to setting ids", () => {
	assert.equal(schemeIdFromName("Tokyo Night"), "tokyo-night");
	assert.equal(schemeIdFromName("unknown"), null);
});
