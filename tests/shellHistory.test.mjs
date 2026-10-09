import { test } from "node:test";
import assert from "node:assert/strict";
import { formatHistoryTime, mergeGlobalHistoryOnAppend, removeGlobalHistoryEntry, sanitizeGlobalHistoryEntries } from "../.tmp/test-build/lib/shellHistory.js";

const base = { hostId: "h1", hostLabel: "web", sessionId: "p1" };

test("Shell 历史：新命令插到最前，与最近一条相同只刷新时间", () => {
	let list = mergeGlobalHistoryOnAppend([], { ...base, command: "  ls -la " }, 1000, 1000);
	assert.equal(list.length, 1);
	assert.equal(list[0].command, "ls -la");
	list = mergeGlobalHistoryOnAppend(list, { ...base, command: "ls -la", hostLabel: "db" }, 1000, 2000);
	assert.equal(list.length, 1);
	assert.equal(list[0].timestamp, 2000);
	assert.equal(list[0].hostLabel, "db");
	list = mergeGlobalHistoryOnAppend(list, { ...base, command: "pwd" }, 1000, 3000);
	assert.deepEqual(list.map((e) => e.command), ["pwd", "ls -la"]);
	assert.equal(mergeGlobalHistoryOnAppend(list, { ...base, command: "pwd2" }, 2).length, 2);
});

test("Shell 历史：空白与敏感命令不记录，删除按 id", () => {
	const list = mergeGlobalHistoryOnAppend([], { ...base, command: "uptime" });
	assert.equal(mergeGlobalHistoryOnAppend(list, { ...base, command: "   " }), list);
	assert.equal(mergeGlobalHistoryOnAppend(list, { ...base, command: "export GITHUB_TOKEN=abc" }), list);
	assert.equal(sanitizeGlobalHistoryEntries([...list, { ...base, id: "x", timestamp: 1, command: "mysql -pSecret" }]).length, 1);
	assert.equal(removeGlobalHistoryEntry(list, "nope"), list);
	assert.equal(removeGlobalHistoryEntry(list, list[0].id).length, 0);
});

test("Shell 历史：相对时间文案同 Netcatty", () => {
	const now = 10 * 86400000;
	assert.equal(formatHistoryTime(now - 10_000, now), "刚刚");
	assert.equal(formatHistoryTime(now - 5 * 60000, now), "5 分钟前");
	assert.equal(formatHistoryTime(now - 3 * 3600000, now), "3 小时前");
	assert.equal(formatHistoryTime(now - 2 * 86400000, now), "2 天前");
});
