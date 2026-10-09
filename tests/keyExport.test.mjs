import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKeyExportCommand, validateKeyExportTarget } from "../.tmp/test-build/lib/keyExport.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample it's me";

test("导出脚本：建目录 / 文件、权限、追加、去重、备份、补换行", () => {
	const home = mkdtempSync(join(tmpdir(), "termx-keyexp-"));
	try {
		const run = (cmd) => execSync(cmd, { env: { ...process.env, HOME: home }, shell: "/bin/sh" }).toString();
		run(buildKeyExportCommand(".ssh", "authorized_keys", KEY));
		const file = join(home, ".ssh", "authorized_keys");
		assert.equal(readFileSync(file, "utf8"), `${KEY}\n`);
		assert.equal(statSync(join(home, ".ssh")).mode & 0o777, 0o700);
		assert.equal(statSync(file).mode & 0o777, 0o600);
		// 再导一次：跳过
		assert.match(run(buildKeyExportCommand(".ssh", "authorized_keys", KEY)), /already present/);
		assert.equal(readFileSync(file, "utf8"), `${KEY}\n`);
		// 原文件末尾无换行：补换行后追加，并留 .bak
		writeFileSync(file, "ssh-rsa AAAA old");
		run(buildKeyExportCommand(".ssh", "authorized_keys", KEY));
		assert.equal(readFileSync(file, "utf8"), `ssh-rsa AAAA old\n${KEY}\n`);
		assert.equal(readFileSync(`${file}.bak`, "utf8"), "ssh-rsa AAAA old");
		// 位置里的 $ / 引号不会被当成代码
		mkdirSync(join(home, "x"), { recursive: true });
		run(buildKeyExportCommand('we"ird $(touch pwned)', "keys", KEY));
		assert.equal(existsSync(join(home, 'we"ird $(touch pwned)', "keys")), true);
		assert.equal(existsSync(join(process.cwd(), "pwned")), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("导出目标校验", () => {
	assert.equal(validateKeyExportTarget(".ssh", "authorized_keys"), null);
	assert.ok(validateKeyExportTarget("", "a"));
	assert.ok(validateKeyExportTarget(".ssh", "a/b"));
	assert.throws(() => buildKeyExportCommand(".ssh", "k", "line1\nline2"));
});
