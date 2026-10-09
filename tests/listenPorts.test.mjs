import assert from "node:assert/strict";
import { test } from "node:test";
import { parseListeningPorts } from "../.tmp/test-build/lib/listenPorts.js";

test("parses ss output (with header, IPv6, scoped addresses)", () => {
	const out = `State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*
LISTEN 0      128          0.0.0.0:22        0.0.0.0:*
LISTEN 0      128             [::]:22           [::]:*
LISTEN 0      244        127.0.0.1:5432      0.0.0.0:*
LISTEN 0      128                *:8080            *:*`;
	const ports = parseListeningPorts(out);
	assert.deepEqual(
		ports.map((p) => `${p.address}:${p.port}:${p.loopback}`),
		[":::22:false", "0.0.0.0:22:false", "127.0.0.53:53:true", "127.0.0.1:5432:true", "0.0.0.0:8080:false"],
	);
});

test("parses netstat output and ignores non-listen lines", () => {
	const out = `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN
tcp6       0      0 ::1:631                 :::*                    LISTEN
tcp        0      0 10.0.0.2:22             10.0.0.9:51000          ESTABLISHED`;
	const ports = parseListeningPorts(out);
	assert.equal(ports.length, 2);
	assert.deepEqual(ports[0], { address: "0.0.0.0", port: 22, loopback: false });
	assert.deepEqual(ports[1], { address: "::1", port: 631, loopback: true });
});
