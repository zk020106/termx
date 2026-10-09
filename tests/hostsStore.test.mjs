import { test } from "node:test";
import assert from "node:assert/strict";
import {
	formatHostCredentials,
	groupPathLabel,
	groupWithDescendants,
	orderGroupsAsTree,
	useHostsStore,
} from "../.tmp/test-build/store/hosts.js";

const groups = [
	{ id: "a", name: "生产", parentId: null },
	{ id: "b", name: "测试", parentId: null },
	{ id: "a1", name: "数据库", parentId: "a" },
	{ id: "a1x", name: "主库", parentId: "a1" },
];

test("分组树：先序排列 + 深度 + 路径名", () => {
	assert.deepEqual(
		orderGroupsAsTree(groups).map(({ group, depth }) => `${group.id}:${depth}`),
		["a:0", "a1:1", "a1x:2", "b:0"],
	);
	assert.equal(groupPathLabel(groups, "a1x"), "生产 / 数据库 / 主库");
	assert.deepEqual([...groupWithDescendants(groups, "a")].sort(), ["a", "a1", "a1x"]);
	// 环引用不死循环
	const cyc = [
		{ id: "x", name: "X", parentId: "y" },
		{ id: "y", name: "Y", parentId: "x" },
	];
	assert.equal(orderGroupsAsTree(cyc).length, 2);
	assert.ok(groupPathLabel(cyc, "x").length > 0);
});

test("复制账密信息：Netcatty 文本格式（非默认端口追加 :port，IPv6 加括号）", () => {
	assert.equal(formatHostCredentials({ hostname: "10.0.0.1", port: 22, username: "root" }, "pw"), "host: 10.0.0.1\nusername: root\npassword: pw");
	assert.equal(formatHostCredentials({ hostname: "h", port: 2222, username: "u" }, "p"), "host: h:2222\nusername: u\npassword: p");
	assert.equal(formatHostCredentials({ hostname: "::1", port: 2200, username: "u" }, "p"), "host: [::1]:2200\nusername: u\npassword: p");
});

function host(id, groupId) {
	return { id, name: id, groupId, hostname: "h", port: 22, username: "u", tags: [], favorite: false, auth: { method: "password" }, jumpHostIds: [], reachable: false };
}

test("删除分组：连同子分组；主机默认移到未分组，可选一起删除", () => {
	const st = useHostsStore.getState();
	st.setAll([host("h1", "a"), host("h2", "a1x"), host("h3", "b")], groups);
	let removed = useHostsStore.getState().removeGroup("a");
	assert.deepEqual(removed, []);
	let s = useHostsStore.getState();
	assert.deepEqual(s.groups.map((g) => g.id), ["b"]);
	assert.deepEqual(s.hosts.map((h) => [h.id, h.groupId]), [["h1", null], ["h2", null], ["h3", "b"]]);

	st.setAll([host("h1", "a"), host("h2", "a1x"), host("h3", "b")], groups);
	removed = useHostsStore.getState().removeGroup("a", { deleteHosts: true });
	assert.deepEqual(removed.sort(), ["h1", "h2"]);
	s = useHostsStore.getState();
	assert.deepEqual(s.hosts.map((h) => h.id), ["h3"]);
});

test("置顶切换、重命名、新建子分组", () => {
	useHostsStore.getState().setAll([host("h1", null)], []);
	useHostsStore.getState().togglePinned("h1");
	assert.equal(useHostsStore.getState().hosts[0].pinned, true);
	useHostsStore.getState().togglePinned("h1");
	assert.equal("pinned" in useHostsStore.getState().hosts[0], false);
	useHostsStore.getState().renameHost("h1", "新名字");
	assert.equal(useHostsStore.getState().hosts[0].name, "新名字");
	const parent = useHostsStore.getState().addGroup("父");
	const child = useHostsStore.getState().addGroup("子", parent.id);
	assert.equal(child.parentId, parent.id);
	assert.notEqual(child.id, parent.id);
});
