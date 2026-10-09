import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_KEY_BINDINGS,
	keyEventToString,
	matchKeyBinding,
	matchesKeyBinding,
	nextTerminalFontSizeForAction,
	nextTerminalFontSizeForWheel,
	resolveKeyBindings,
	shortcutLabel,
} from "../.tmp/test-build/lib/keyBindings.js";

const ev = (key, mods = {}, code = "") => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test("Netcatty 默认键位：PC 方案下逐条匹配", () => {
	// 终端 / 工作区只看非 SFTP 键位（SFTP 键位在文件面板里单独匹配）
	const b = resolveKeyBindings({}).filter((x) => x.category !== "sftp");
	const hit = (e) => matchKeyBinding(e, b, false)?.id;
	assert.equal(hit(ev("C", { ctrlKey: true, shiftKey: true }, "KeyC")), "copy");
	assert.equal(hit(ev("V", { ctrlKey: true, shiftKey: true }, "KeyV")), "paste");
	assert.equal(hit(ev("X", { ctrlKey: true, shiftKey: true }, "KeyX")), "paste-selection");
	assert.equal(hit(ev("K", { ctrlKey: true, shiftKey: true }, "KeyK")), "clear-buffer");
	assert.equal(hit(ev("f", { ctrlKey: true }, "KeyF")), "search-terminal");
	assert.equal(hit(ev("D", { ctrlKey: true, shiftKey: true }, "KeyD")), "split-horizontal");
	assert.equal(hit(ev("E", { ctrlKey: true, shiftKey: true }, "KeyE")), "split-vertical");
	assert.equal(hit(ev("m", { altKey: true }, "KeyM")), "toggle-pane-zoom");
	assert.equal(hit(ev("Tab", { ctrlKey: true }, "Tab")), "next-tab");
	assert.equal(hit(ev("Tab", { ctrlKey: true, shiftKey: true }, "Tab")), "prev-tab");
	assert.equal(hit(ev("3", { ctrlKey: true }, "Digit3")), "switch-tab-1-9");
	assert.equal(hit(ev("ArrowLeft", { ctrlKey: true, altKey: true })), "move-focus");
	assert.equal(hit(ev("=", { ctrlKey: true }, "Equal")), "increase-terminal-font-size");
	assert.equal(hit(ev("w", { ctrlKey: true }, "KeyW")), "close-tab");
	// 裸 Ctrl+C 不是任何绑定（SIGINT 必须能发出去）
	assert.equal(hit(ev("c", { ctrlKey: true }, "KeyC")), undefined);
});

test("Mac 方案用 ⌘，且 PC 修饰键的绑定不会在 Mac 方案下误中", () => {
	const b = resolveKeyBindings({});
	assert.equal(matchKeyBinding(ev("d", { metaKey: true }, "KeyD"), b, true)?.id, "split-horizontal");
	assert.equal(matchesKeyBinding(ev("d", { ctrlKey: true, shiftKey: true }), "Ctrl + Shift + D", true), false);
});

test("自定义覆盖只改对应方案，Disabled 不再匹配", () => {
	const b = resolveKeyBindings({ "clear-buffer": { pc: "Ctrl + Alt + L" }, copy: { pc: "Disabled" } });
	assert.equal(b.find((x) => x.id === "clear-buffer").pc, "Ctrl + Alt + L");
	assert.equal(b.find((x) => x.id === "clear-buffer").mac, DEFAULT_KEY_BINDINGS.find((x) => x.id === "clear-buffer").mac);
	assert.equal(matchKeyBinding(ev("C", { ctrlKey: true, shiftKey: true }, "KeyC"), b, false), null);
	assert.equal(matchKeyBinding(ev("l", { ctrlKey: true, altKey: true }, "KeyL"), b, false)?.id, "clear-buffer");
});

test("录制：keyEventToString 与 matchesKeyBinding 互逆", () => {
	const s = keyEventToString(ev("j", { ctrlKey: true, shiftKey: true }, "KeyJ"), false);
	assert.equal(s, "Ctrl + Shift + J");
	assert.ok(matchesKeyBinding(ev("J", { ctrlKey: true, shiftKey: true }, "KeyJ"), s, false));
});

test("菜单快捷键文案与 Netcatty getShortcut 一致", () => {
	const b = resolveKeyBindings({});
	assert.equal(shortcutLabel(b, "split-horizontal", "mac"), "⌘ D");
	assert.equal(shortcutLabel(b, "copy", "pc"), "Ctrl Shift C");
	assert.equal(shortcutLabel(b, "copy", "disabled"), "");
	assert.equal(shortcutLabel(b, "open-hosts", "pc"), "");
});

test("字号缩放：动作与滚轮，范围 10–32，禁用时不处理", () => {
	assert.equal(nextTerminalFontSizeForAction("increaseTerminalFontSize", 32, 12), 32);
	assert.equal(nextTerminalFontSizeForAction("decreaseTerminalFontSize", 10, 12), 10);
	assert.equal(nextTerminalFontSizeForAction("resetTerminalFontSize", 20, 12), 12);
	assert.equal(nextTerminalFontSizeForAction("increaseTerminalFontSize", 12, 12, true), null);
	assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: true, metaKey: false, deltaY: -1 }, 12, false), 13);
	assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: false, metaKey: true, deltaY: 1 }, 12, true), 11);
	assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: false, metaKey: false, deltaY: 1 }, 12, false), null);
});

test("SFTP 键位单独匹配", () => {
	const sftp = resolveKeyBindings({}).filter((x) => x.category === "sftp");
	const hit = (e) => matchKeyBinding(e, sftp, false)?.id;
	assert.equal(hit(ev("c", { ctrlKey: true }, "KeyC")), "sftp-copy");
	assert.equal(hit(ev("F2", {}, "F2")), "sftp-rename");
	assert.equal(hit(ev("Delete", {}, "Delete")), "sftp-delete");
	assert.equal(hit(ev("F5", {}, "F5")), "sftp-refresh");
	assert.equal(hit(ev("Backspace", {}, "Backspace")), "sftp-go-parent");
	assert.equal(hit(ev("Enter", { ctrlKey: true }, "Enter")), "sftp-navigate-to");
});
