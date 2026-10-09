import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	advanceTypeahead,
	buildExtractCommand,
	computeExtractTimeoutMs,
	EXTRACT_MAX_TIMEOUT_MS,
	getFileExtension,
	getNextUntitledName,
	getSftpArchiveKind,
	hasFileExtension,
	isExtractableArchive,
	isKnownBinaryFile,
	resolveSamePanePaste,
	shellQuote,
} from "../.tmp/test-build/lib/sftpArchive.js";

test("压缩包类型识别（Netcatty getSftpArchiveKind）", () => {
	assert.equal(getSftpArchiveKind("a.tar.gz"), "tar.gz");
	assert.equal(getSftpArchiveKind("A.TGZ"), "tar.gz");
	assert.equal(getSftpArchiveKind("x.tar.zst"), "tar.zst");
	assert.equal(getSftpArchiveKind("x.zip"), "zip");
	assert.equal(getSftpArchiveKind("x.gz"), "gz");
	assert.equal(getSftpArchiveKind(".gz"), null);
	assert.equal(getSftpArchiveKind("readme.md"), null);
	assert.equal(isExtractableArchive("dir/sub/file.tar.xz"), true);
});

test("shellQuote 转义单引号，拒绝 NUL / 空串", () => {
	assert.equal(shellQuote("it's"), `'it'\\''s'`);
	assert.throws(() => shellQuote(""));
	assert.equal(shellQuote("", { allowEmpty: true }), "''");
	assert.throws(() => shellQuote("a\0b"));
	assert.throws(() => buildExtractCommand("/tmp/a\nb.zip"));
	assert.throws(() => buildExtractCommand("/tmp/a.txt"));
});

test("解压超时按大小递增并封顶", () => {
	assert.equal(computeExtractTimeoutMs(0), EXTRACT_MAX_TIMEOUT_MS);
	assert.equal(computeExtractTimeoutMs(1), 90_000);
	assert.equal(computeExtractTimeoutMs(1e12), EXTRACT_MAX_TIMEOUT_MS);
});

test("远程解压命令在真实 sh 下可用（tar.gz / gz）", (t) => {
	try {
		execFileSync("sh", ["-c", "command -v tar && command -v gzip"], { stdio: "ignore" });
	} catch {
		t.skip("本机没有 tar / gzip");
		return;
	}
	const dir = mkdtempSync(join(tmpdir(), "termx-extract-"));
	try {
		writeFileSync(join(dir, "hello.txt"), "hi there\n");
		execFileSync("tar", ["-czf", join(dir, "it's.tar.gz"), "-C", dir, "hello.txt"]);
		rmSync(join(dir, "hello.txt"));
		execFileSync("sh", ["-c", buildExtractCommand(join(dir, "it's.tar.gz"))]);
		assert.equal(readFileSync(join(dir, "hello.txt"), "utf8"), "hi there\n");

		writeFileSync(join(dir, "single.log"), "line\n");
		execFileSync("gzip", [join(dir, "single.log")]);
		assert.equal(existsSync(join(dir, "single.log")), false);
		execFileSync("sh", ["-c", buildExtractCommand(join(dir, "single.log.gz"))]);
		assert.equal(readFileSync(join(dir, "single.log"), "utf8"), "line\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("扩展名 / 二进制判断 / 新建文件默认名", () => {
	assert.equal(getFileExtension("a.TXT"), "txt");
	assert.equal(getFileExtension(".bashrc"), "file");
	assert.equal(getFileExtension("Makefile"), "file");
	assert.equal(hasFileExtension("Makefile"), false);
	assert.equal(isKnownBinaryFile("photo.PNG"), true);
	assert.equal(isKnownBinaryFile("main.rs"), false);
	assert.equal(getNextUntitledName([]), "untitled.txt");
	assert.equal(getNextUntitledName(["Untitled.txt", "untitled (1).txt"]), "untitled (2).txt");
});

test("同栏粘贴守卫（samePanePaste）", () => {
	const files = [{ name: "src", isDirectory: true }];
	assert.equal(resolveSamePanePaste({ operation: "cut", sourcePath: "/a", targetPath: "/a/", files }), "block-same-folder");
	assert.equal(resolveSamePanePaste({ operation: "copy", sourcePath: "/a", targetPath: "/a", files }), "allow");
	assert.equal(resolveSamePanePaste({ operation: "copy", sourcePath: "/a", targetPath: "/a/src/x", files }), "block-into-source");
	assert.equal(resolveSamePanePaste({ operation: "cut", sourcePath: "/a", targetPath: "/a/srcx", files }), "allow");
	assert.equal(
		resolveSamePanePaste({ operation: "copy", sourcePath: "C:\\Users", targetPath: "c:/users/SRC", files, caseInsensitive: true }),
		"block-into-source",
	);
});

test("键盘输入查找：1 秒内连续输入拼前缀", () => {
	const names = ["alpha", "beta", "bravo"];
	let r = advanceTypeahead(names, null, "b", 0);
	assert.equal(r.matchIndex, 1);
	r = advanceTypeahead(names, r.state, "r", 500);
	assert.equal(r.matchIndex, 2);
	r = advanceTypeahead(names, r.state, "a", 3000);
	assert.equal(r.state.query, "a");
	assert.equal(r.matchIndex, 0);
});
