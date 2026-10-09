// 远程文件名 → 本地文件名校验的单测（防 SFTP 下载路径穿越）
import assert from "node:assert/strict";
import { test } from "node:test";
import { toSafeLocalName, unsafeLocalNameReason } from "../.tmp/test-build/lib/pathSafety.js";

test("路径穿越与分隔符一律拒绝（两种平台）", () => {
	for (const windows of [true, false]) {
		for (const name of ["..", ".", "../../.bashrc", "..\\..\\AppData\\evil.dll", "sub/file", "a\\b", "", "a\u0000b"]) {
			assert.notEqual(unsafeLocalNameReason(name, windows), null, `${windows}:${JSON.stringify(name)}`);
		}
	}
});

test("Windows 额外规则：盘符、保留名、非法字符、结尾点", () => {
	for (const name of ["C:evil", "CON", "nul.txt", "a:b", "what?.txt", "trailing."]) {
		assert.notEqual(unsafeLocalNameReason(name, true), null, name);
	}
	// 同样的名字在 macOS / Linux 本机上是合法文件名
	assert.equal(unsafeLocalNameReason("backup-12:00.tar", false), null);
});

test("正常文件名放行", () => {
	for (const name of ["report.txt", "v1..2.tar.gz", ".bashrc", "日志 2026.log"]) {
		assert.equal(unsafeLocalNameReason(name, true), null, name);
		assert.equal(unsafeLocalNameReason(name, false), null, name);
	}
});

test("另存为默认名会被消毒成单个安全文件名", () => {
	assert.equal(toSafeLocalName("report.txt", true), "report.txt");
	const cleaned = toSafeLocalName("../../evil.sh", false);
	assert.equal(cleaned.includes("/"), false);
	assert.equal(unsafeLocalNameReason(cleaned, false), null);
	assert.equal(unsafeLocalNameReason(toSafeLocalName("..", true), true), null);
	assert.equal(unsafeLocalNameReason(toSafeLocalName("CON", true), true), null);
});
