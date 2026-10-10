import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_PREFERENCES,
	DEFAULT_TERMINAL,
	normalizePreferences,
} from "../.tmp/test-build/data/preferences.js";
import { useSettingsStore } from "../.tmp/test-build/store/settings.js";

test("设置默认值：包含新加的 customCss, uiFontFamily 与 sessionRestore", () => {
	assert.equal(DEFAULT_TERMINAL.customCss, "");
	assert.equal(DEFAULT_TERMINAL.uiFontFamily, "");
	assert.equal(DEFAULT_TERMINAL.sessionRestore, true);
	assert.equal(DEFAULT_TERMINAL.fontWeight, 400);
	assert.equal(DEFAULT_TERMINAL.fontWeightBold, 700);
	assert.equal(DEFAULT_TERMINAL.cursorBlink, true);
	assert.equal(DEFAULT_TERMINAL.drawBoldInBrightColors, true);
	assert.equal(DEFAULT_TERMINAL.minimumContrastRatio, 1);
	assert.equal(DEFAULT_TERMINAL.altAsMeta, false);
});

test("配置反序列化校验 (normalizePreferences)：兜底与持久化保留", () => {
	// 空数据回退默认值
	const emptyNorm = normalizePreferences({});
	assert.equal(emptyNorm.terminal.customCss, "");
	assert.equal(emptyNorm.terminal.uiFontFamily, "");
	assert.equal(emptyNorm.terminal.sessionRestore, true);
	assert.equal(emptyNorm.terminal.fontWeight, 400);
	assert.equal(emptyNorm.terminal.fontWeightBold, 700);

	// 注入自定义有效值
	const customized = normalizePreferences({
		terminal: {
			customCss: ".xterm-rows { line-height: 1.15; }",
			uiFontFamily: "Microsoft YaHei",
			sessionRestore: false,
			fontWeight: 500,
			fontWeightBold: 800,
			cursorBlink: false,
			minimumContrastRatio: 4.5,
			sftpDirectoriesFirst: false,
			sftpVisibleColumns: {
				name: true,
				size: false,
				modified: true,
				type: false,
				owner: false,
			},
		},
	});

	assert.equal(customized.terminal.customCss, ".xterm-rows { line-height: 1.15; }");
	assert.equal(customized.terminal.uiFontFamily, "Microsoft YaHei");
	assert.equal(customized.terminal.sessionRestore, false);
	assert.equal(customized.terminal.fontWeight, 500);
	assert.equal(customized.terminal.fontWeightBold, 800);
	assert.equal(customized.terminal.cursorBlink, false);
	assert.equal(customized.terminal.minimumContrastRatio, 4.5);
	assert.equal(customized.terminal.sftpDirectoriesFirst, false);
	assert.equal(customized.terminal.sftpVisibleColumns.size, false);
	assert.equal(customized.terminal.sftpVisibleColumns.modified, true);

	// 非法值兜底安全防护
	const invalid = normalizePreferences({
		terminal: {
			customCss: 12345, // 错误类型
			sessionRestore: "not-a-bool", // 错误类型
			fontWeight: 9999, // 超出可选范围
			minimumContrastRatio: -10, // 超出范围
		},
	});
	assert.equal(invalid.terminal.customCss, "");
	assert.equal(invalid.terminal.sessionRestore, true);
	assert.equal(invalid.terminal.fontWeight, 400);
	assert.equal(invalid.terminal.minimumContrastRatio, 1);
});

test("设置 Store 联动 (useSettingsStore)：更新与 toPreferences 导出", () => {
	const store = useSettingsStore.getState();

	// 修改各属性
	store.setTerminal({
		customCss: "body { background: #000; }",
		uiFontFamily: "Inter",
		sessionRestore: false,
		fontWeight: 600,
		fontWeightBold: 900,
		cursorBlink: false,
		minimumContrastRatio: 7,
		sftpDirectoriesFirst: false,
	});

	const updated = useSettingsStore.getState();
	assert.equal(updated.customCss, "body { background: #000; }");
	assert.equal(updated.uiFontFamily, "Inter");
	assert.equal(updated.sessionRestore, false);
	assert.equal(updated.fontWeight, 600);
	assert.equal(updated.fontWeightBold, 900);
	assert.equal(updated.cursorBlink, false);
	assert.equal(updated.minimumContrastRatio, 7);
	assert.equal(updated.sftpDirectoriesFirst, false);

	// toPreferences() 生成持久化快照
	const prefs = store.toPreferences();
	assert.equal(prefs.terminal.customCss, "body { background: #000; }");
	assert.equal(prefs.terminal.uiFontFamily, "Inter");
	assert.equal(prefs.terminal.sessionRestore, false);
	assert.equal(prefs.terminal.fontWeight, 600);
	assert.equal(prefs.terminal.fontWeightBold, 900);
	assert.equal(prefs.terminal.cursorBlink, false);
	assert.equal(prefs.terminal.minimumContrastRatio, 7);
	assert.equal(prefs.terminal.sftpDirectoriesFirst, false);
});
