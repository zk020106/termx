// 移植自 Netcatty components/sftp/sftpColumnVisibility.test.ts 与 sftpTabDuplication.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
	buildSftpColumnTemplate,
	DEFAULT_SFTP_COLUMN_VISIBILITY,
	isSftpColumnMenuKey,
	normalizeSftpColumnVisibility,
	sortSftpEntries,
	sftpKindLabel,
	canDuplicateSftpTab,
	getSftpTabDuplicateRequest,
	SFTP_TAB_DUPLICATE_MENU_ITEMS,
	reorderTabs,
} from "../.tmp/test-build/lib/sftpColumns.js";

const widths = { name: 56, modified: 28, size: 7, type: 9, owner: 10 };

test("normalizes missing and invalid SFTP column preferences to all columns", () => {
	assert.deepEqual(normalizeSftpColumnVisibility(null), DEFAULT_SFTP_COLUMN_VISIBILITY);
	assert.deepEqual(normalizeSftpColumnVisibility([]), DEFAULT_SFTP_COLUMN_VISIBILITY);
	assert.deepEqual(normalizeSftpColumnVisibility({ name: false, size: false }), {
		name: true, modified: true, size: false, type: true, owner: true,
	});
});

test("builds a grid template for visible columns only", () => {
	assert.equal(
		buildSftpColumnTemplate(widths, { name: true, modified: false, size: true, type: false, owner: false }),
		"minmax(140px, 56fr) minmax(52px, 7fr)",
	);
	assert.equal(
		buildSftpColumnTemplate(widths, { name: true, modified: false, size: false, type: false, owner: true }),
		"minmax(140px, 56fr) minmax(56px, 10fr)",
	);
	assert.equal(
		buildSftpColumnTemplate(widths, { name: true, modified: false, size: false, type: false, owner: false }),
		"minmax(140px, 56fr)",
	);
});

test("column menu opens from ContextMenu or Shift+F10", () => {
	assert.equal(isSftpColumnMenuKey("ContextMenu", false), true);
	assert.equal(isSftpColumnMenuKey("F10", true), true);
	assert.equal(isSftpColumnMenuKey("F10", false), false);
});

const e = (name, is_dir, extra = {}) => ({ name, path: "/" + name, is_dir, is_symlink: false, size: 0, mtime: 0, permissions: 0, permissions_str: "", ...extra });

test("sorts with directories first unless disabled", () => {
	const list = [e("b.txt", false), e("a", true), e("c.log", false)];
	assert.deepEqual(sortSftpEntries(list, "name", "asc").map((x) => x.name), ["a", "b.txt", "c.log"]);
	assert.deepEqual(sortSftpEntries(list, "name", "desc", false).map((x) => x.name), ["c.log", "b.txt", "a"]);
	assert.deepEqual(sortSftpEntries(list, "type", "asc", false).map((x) => x.name), ["a", "c.log", "b.txt"]);
	const owned = [e("x", false, { owner: "root" }), e("y", false, { owner: "alice" })];
	assert.deepEqual(sortSftpEntries(owned, "owner", "asc").map((x) => x.name), ["y", "x"]);
});

test("kind label matches Netcatty row text", () => {
	assert.equal(sftpKindLabel(e("dir", true)), "folder");
	assert.equal(sftpKindLabel(e("a.TAR", false)), "tar");
	assert.equal(sftpKindLabel(e("Makefile", false)), "file");
	assert.equal(sftpKindLabel({ name: "l", is_dir: true, is_symlink: true }), "link → folder");
});

test("duplicate menu has default-path and current-path modes in Netcatty order", () => {
	assert.deepEqual(SFTP_TAB_DUPLICATE_MENU_ITEMS.map((i) => i.mode), ["defaultPath", "currentPath"]);
});

test("duplicate requests only for connected panes", () => {
	const remote = { status: "connected", isLocal: false, hostId: "h1", currentPath: "/var/log" };
	assert.equal(canDuplicateSftpTab(remote, true), true);
	assert.equal(canDuplicateSftpTab(remote, false), false);
	assert.equal(canDuplicateSftpTab({ ...remote, status: "connecting" }, true), false);
	assert.deepEqual(getSftpTabDuplicateRequest(remote, "defaultPath"), { kind: "remote", hostId: "h1" });
	assert.deepEqual(getSftpTabDuplicateRequest(remote, "currentPath"), { kind: "remote", hostId: "h1", path: "/var/log" });
	assert.deepEqual(getSftpTabDuplicateRequest({ ...remote, isLocal: true, hostId: null }, "currentPath"), { kind: "local", path: "/var/log" });
	assert.equal(getSftpTabDuplicateRequest({ ...remote, hostId: null }, "defaultPath"), null);
	assert.equal(getSftpTabDuplicateRequest({ ...remote, status: "disconnected" }, "defaultPath"), null);
});

test("reorders tabs before/after a target", () => {
	const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];
	assert.deepEqual(reorderTabs(tabs, "a", "c", "after").map((t) => t.id), ["b", "c", "a"]);
	assert.deepEqual(reorderTabs(tabs, "c", "a", "before").map((t) => t.id), ["c", "a", "b"]);
	assert.deepEqual(reorderTabs(tabs, "a", "a", "before"), tabs);
});
