// 命令历史敏感过滤的单测。先 `tsc -p tsconfig.test.json` 编译纯函数模块，再用 node:test 跑（见 package.json 的 test 脚本）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { isLikelySecretEntry, isSensitiveCommand, looksLikeSecretPrompt } from "../.tmp/test-build/lib/sensitive.js";

test("常见的密码 / 口令提示符都能认出来", () => {
	for (const line of [
		"[sudo] password for kai:",
		"kai@10.0.0.8's password:",
		"Password:",
		"Enter passphrase for key '/home/kai/.ssh/id_ed25519':",
		"Enter password: ",
		"请输入密码：",
		"Verification code:",
		"Enter PIN:",
	]) {
		assert.equal(looksLikeSecretPrompt(line), true, line);
	}
});

test("普通 shell 提示符不算密码提示", () => {
	for (const line of ["kai@web-01:~$ ", "root@db:/var/log# ", "PS C:\\Users\\kai> ", "~/src/termx main %"]) {
		assert.equal(looksLikeSecretPrompt(line), false, line);
	}
});

test("在密码提示符下回车：不记历史", () => {
	// 关了回显，屏幕上只有提示文字
	assert.equal(isLikelySecretEntry("[sudo] password for kai: ", "hunter2"), true);
	// 关了回显、提示文字不含关键词但像个提问
	assert.equal(isLikelySecretEntry("Enter the vault key:", "s3cr3t"), true);
});

test("正常命令：照常记历史", () => {
	assert.equal(isLikelySecretEntry("kai@web-01:~$ git status", "git status"), false);
	// 命令里提到 password 但这是一条回显出来的命令，不是提示符
	assert.equal(isLikelySecretEntry("kai@web-01:~$ grep -r password: config/", "grep -r password: config/"), false);
});

test("命令行里直接带秘密的命令不入历史", () => {
	for (const cmd of [
		"mysql -uroot -pS3cret db",
		"psql --password=abc",
		"deploy --token abc123",
		"export GITHUB_TOKEN=ghp_xxx",
		"DB_PASSWORD=x ./run.sh",
		"AWS_SECRET_ACCESS_KEY=abc aws s3 ls",
		"sshpass -p pw ssh host",
		"curl -u admin:pw https://x",
		"git clone https://kai:pat123@github.com/a/b.git",
		'curl -H "Authorization: Bearer eyJhbGci" https://api',
		"echo pw | passwd --stdin kai",
	]) {
		assert.equal(isSensitiveCommand(cmd), true, cmd);
	}
});

test("普通命令不误伤", () => {
	for (const cmd of [
		"git status",
		"docker compose up -d",
		"mysql -uroot -p db",
		"ls -la /etc/ssh",
		"tail -f /var/log/auth.log",
		"curl -I https://example.com",
		"passwd",
	]) {
		assert.equal(isSensitiveCommand(cmd), false, cmd);
	}
});
