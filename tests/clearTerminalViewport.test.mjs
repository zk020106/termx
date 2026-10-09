import { test } from "node:test";
import assert from "node:assert/strict";
import xtermHeadless from "@xterm/headless";
import { clearTerminalViewportAndSyncPty } from "../.tmp/test-build/components/terminal/netcatty/clearTerminalViewport.js";

const { Terminal } = xtermHeadless;
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));
const lines = (term) => {
	const out = [];
	const b = term.buffer.active;
	for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true));
	return out;
};

async function setup() {
	const term = new Terminal({ cols: 40, rows: 5, scrollback: 100, allowProposedApi: true });
	await write(term, "one\r\ntwo\r\nthree\r\n$ ");
	return term;
}

test("clear keeps the prompt line and preserves history when wipeScrollback is off", async () => {
	const term = await setup();
	let synced = 0;
	const ok = clearTerminalViewportAndSyncPty(term, { wipeScrollback: false, syncPty: () => synced++ });
	assert.equal(ok, true);
	assert.equal(synced, 1);
	await write(term, "");
	const all = lines(term);
	assert.ok(all.includes("one") && all.includes("three"), JSON.stringify(all));
	const b = term.buffer.active;
	assert.equal(b.getLine(b.baseY).translateToString(true).trimEnd(), "$");
});

test("clear wipes scrollback when wipeScrollback is on", async () => {
	const term = await setup();
	clearTerminalViewportAndSyncPty(term, { wipeScrollback: true, syncPty: () => {} });
	await write(term, "");
	const all = lines(term).map((l) => l.trimEnd()).filter(Boolean);
	assert.deepEqual(all, ["$"]);
});
