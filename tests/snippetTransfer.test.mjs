import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildSnippetExportPayload,
	mergeSnippetImportPayload,
	parseSnippetImportPayload,
	snippetExportFileName,
} from "../.tmp/test-build/lib/snippetTransfer.js";

const extractVariables = (c) => [...c.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
const sn = (id, name, group, command) => ({ id, name, group, command, variables: extractVariables(command) });

test("导出为 Netcatty 格式，默认分组导出为空 package", () => {
	const p = buildSnippetExportPayload([sn("1", "重启", "ops/web", "systemctl restart ${svc}"), sn("2", "看日志", "默认", "tail -f x")], "T");
	assert.equal(p.kind, "netcatty.snippets");
	assert.equal(p.version, 2);
	assert.deepEqual(p.snippetPackages, ["ops", "ops/web"]);
	assert.equal(p.snippets[0].label, "重启");
	assert.equal(p.snippets[1].package, "");
	assert.equal(snippetExportFileName("Ops/Web 1"), "netcatty-snippets-ops-web-1.json");
});

test("解析 Netcatty 导出 / 裸数组 / 拒绝其他 kind", () => {
	const nc = JSON.stringify({ kind: "netcatty.snippets", version: 1, snippets: [{ label: "a", command: "ls", package: "p" }, { command: "  " }] });
	assert.equal(parseSnippetImportPayload(nc).snippets.length, 1);
	assert.equal(parseSnippetImportPayload(JSON.stringify([{ command: "uptime\nmore" }])).snippets[0].label, "uptime");
	assert.throws(() => parseSnippetImportPayload(JSON.stringify({ kind: "x", version: 2, snippets: [] })));
});

test("按命令文本合并：skip / overwrite", () => {
	const existing = [sn("1", "old", "g", "ls -la")];
	const payload = parseSnippetImportPayload(
		JSON.stringify({ kind: "netcatty.snippets", version: 2, snippets: [{ label: "new", command: "ls -la", package: "" }, { label: "u", command: "echo ${x}", package: "p" }] }),
	);
	let n = 0;
	const skip = mergeSnippetImportPayload({ existing, payload, conflictAction: "skip", createId: () => `n${n++}`, extractVariables });
	assert.deepEqual(skip.stats, { imported: 1, overwritten: 0, skipped: 1, conflicts: 1 });
	assert.equal(skip.snippets[0].name, "old");
	assert.deepEqual(skip.snippets[1].variables, ["x"]);
	assert.equal(skip.snippets[1].group, "p");
	const over = mergeSnippetImportPayload({ existing, payload, conflictAction: "overwrite", createId: () => "z", extractVariables });
	assert.equal(over.snippets[0].id, "1");
	assert.equal(over.snippets[0].name, "new");
	assert.equal(over.snippets[0].group, "默认");
});
