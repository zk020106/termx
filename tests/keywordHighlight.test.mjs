import assert from "node:assert/strict";
import test from "node:test";
import headless from "@xterm/headless";
import { KeywordHighlighter } from "../.tmp/test-build/components/terminal/netcatty/keywordHighlight.js";
import {
	DEFAULT_KEYWORD_HIGHLIGHT_RULES,
	normalizeKeywordHighlightRules,
} from "../.tmp/test-build/components/terminal/netcatty/keywordHighlightRules.js";

const { Terminal: HeadlessTerminal } = headless;
// 无头终端没有渲染层：refresh 在浏览器里只是重绘，这里给个空实现
class Terminal extends HeadlessTerminal {
	refresh() {}
}
const write = (term, data) => new Promise((resolve) => term.write(data, resolve));
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function fgOf(term, row, col) {
	const cell = term.buffer.active.getLine(row).getCell(col);
	return { rgb: cell.isFgRGB(), color: cell.getFgColor() };
}

test("关键字高亮：error / IPv4 被染成规则颜色，普通文字不变", async () => {
	const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
	const h = new KeywordHighlighter(term);
	h.setRules(DEFAULT_KEYWORD_HIGHLIGHT_RULES, true);
	await write(term, "plain text then error here 10.0.0.1\r\n");
	await settle();
	const line = term.buffer.active.getLine(0).translateToString(true);
	const errAt = line.indexOf("error");
	const ipAt = line.indexOf("10.0.0.1");
	assert.deepEqual(fgOf(term, 0, errAt), { rgb: true, color: 0xf87171 });
	assert.deepEqual(fgOf(term, 0, ipAt), { rgb: true, color: 0xec4899 });
	assert.equal(fgOf(term, 0, 0).rgb, false);
	h.dispose();
	term.dispose();
});

test("关键字高亮：关闭后新输出不再着色", async () => {
	const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
	const h = new KeywordHighlighter(term);
	h.setRules(DEFAULT_KEYWORD_HIGHLIGHT_RULES, false);
	await write(term, "fatal failure\r\n");
	await settle();
	assert.equal(fgOf(term, 0, 0).rgb, false);
	h.dispose();
	term.dispose();
});

test("规则 normalize：未自定义的内置规则跟随新默认，自定义的保留", () => {
	const rules = normalizeKeywordHighlightRules([
		{ id: "error", label: "X", patterns: ["foo"], color: "#000000", enabled: false },
		{ id: "warning", label: "W", patterns: ["bar"], color: "#111111", enabled: true, customized: true },
		{ id: "mine", label: "Mine", patterns: ["baz"], color: "#222222", enabled: true },
	]);
	const err = rules.find((r) => r.id === "error");
	assert.equal(err.label, "Error");
	assert.equal(err.color, "#000000");
	assert.equal(err.enabled, false);
	assert.deepEqual(rules.find((r) => r.id === "warning").patterns, ["bar"]);
	assert.ok(rules.some((r) => r.id === "mine"));
	assert.ok(rules.some((r) => r.id === "ip-mac"));
});
