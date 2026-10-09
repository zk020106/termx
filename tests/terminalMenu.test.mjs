import assert from "node:assert/strict";
import test from "node:test";
import {
	isMiddleClickContextMenuEvent,
	markMiddleClickContextMenuEvent,
	resolveTerminalRightClick,
	shouldOpenTerminalContextMenu,
} from "../.tmp/test-build/components/terminal/terminalMenu.js";

test("右键行为：菜单 / 粘贴 / 选择单词 / 复制选区", () => {
	assert.equal(resolveTerminalRightClick({ rightClickBehavior: "menu" }), "menu");
	assert.equal(resolveTerminalRightClick({ rightClickBehavior: "paste" }), "paste");
	assert.equal(resolveTerminalRightClick({ rightClickBehavior: "select-word" }), "select-word");
	assert.equal(resolveTerminalRightClick({ rightClickBehavior: "select" }), "copy");
});

test("Shift+右键与中键菜单总能弹出菜单（Netcatty 行为）", () => {
	assert.equal(resolveTerminalRightClick({ rightClickBehavior: "paste", shiftKey: true }), "menu");
	assert.equal(resolveTerminalRightClick({ rightClickBehavior: "paste", middleClick: true }), "menu");
	assert.equal(
		resolveTerminalRightClick({ rightClickBehavior: "menu", isAlternateScreen: true, terminalMouseTrackingMode: "any", shiftKey: true }),
		"menu",
	);
});

test("全屏应用抓鼠标时不弹菜单，除非可重连或打开了「全屏应用中也显示菜单」", () => {
	const tmux = { rightClickBehavior: "menu", isAlternateScreen: true, terminalMouseTrackingMode: "vt200" };
	assert.equal(resolveTerminalRightClick(tmux), "suppress");
	assert.equal(resolveTerminalRightClick({ ...tmux, showReconnectAction: true }), "menu");
	assert.equal(resolveTerminalRightClick({ ...tmux, forceMenuInAlternateScreen: true }), "menu");
	// 备用屏但没开鼠标跟踪（less 等）：正常弹菜单
	assert.equal(shouldOpenTerminalContextMenu({ rightClickBehavior: "menu", isAlternateScreen: true, terminalMouseTrackingMode: "none" }), true);
});

test("中键菜单事件标记", () => {
	const event = {};
	assert.equal(isMiddleClickContextMenuEvent(event), false);
	markMiddleClickContextMenuEvent(event);
	assert.equal(isMiddleClickContextMenuEvent(event), true);
});
