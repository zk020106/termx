import assert from "node:assert/strict";
import { test } from "node:test";
import { cpuPercent, formatKib, hasLinuxMetrics, parseMetrics, SECTION } from "../.tmp/test-build/lib/hostMetrics.js";

const sample = [
	"0.52 0.40 0.31 2/345 6789",
	"cpu  100 0 50 800 50 0 0 0 0 0",
	"MemTotal:       16000000 kB\nMemFree:         2000000 kB\nMemAvailable:    8000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB",
	"/dev/sda1 100000000 40000000 60000000 40% /",
	"8",
	"  123  12.5  3.1 postgres\n    1   0.0  0.1 systemd",
	"12345.67 98765.43",
].join(`\n${SECTION}\n`);

test("parses /proc, df and ps sections", () => {
	const m = parseMetrics(sample);
	assert.deepEqual(m.load, [0.52, 0.4, 0.31]);
	assert.equal(m.cores, 8);
	assert.equal(m.memTotal, 16000000);
	assert.equal(m.memUsed, 8000000);
	assert.equal(m.swapUsed, 500000);
	assert.equal(m.diskTotal, 100000000);
	assert.equal(m.diskUsed, 40000000);
	assert.equal(m.diskMount, "/");
	assert.deepEqual(m.processes[0], { pid: 123, cpu: 12.5, mem: 3.1, command: "postgres" });
	assert.equal(Math.round(m.uptimeSec), 12346);
	assert.equal(hasLinuxMetrics(m), true);
});

test("cpu percent needs two samples", () => {
	const a = { idle: 850, total: 1000 };
	const b = { idle: 900, total: 1100 };
	assert.equal(cpuPercent(null, a), null);
	assert.equal(cpuPercent(a, b), 50);
});

test("non-linux output is detected", () => {
	const m = parseMetrics(["", "", "", "", "", "", ""].join(`\n${SECTION}\n`));
	assert.equal(hasLinuxMetrics(m), false);
	assert.equal(formatKib(1048576), "1.0 GiB");
});
