// 前半部分原样移植自 Netcatty electron/bridges/zmodemHelper.test.cjs（buildUploadPlan / buildModeRestores）；
// 后半部分用本机 lrzsz 的真实 sz / rz 进程端到端跑一遍移植后的 Sentry 包装（下载 + 上传）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  buildUploadPlan,
  buildModeRestores,
  createZmodemSentry,
} from '../.tmp/test-build/lib/zmodem/zmodemHelper.js';
const never = () => { throw new Error("resolver should not be called"); };

test("no conflicts: all indices offered, none removed, resolver untouched", async () => {
  const plan = await buildUploadPlan(["a.txt", "b.txt"], [], never);
  assert.deepEqual(plan, { offerIndices: [0, 1], removeIndices: [], aborted: false });
});

test("overwrite a conflict: index both removed and offered", async () => {
  const plan = await buildUploadPlan(["a.txt", "b.txt"], ["b.txt"], async () => ({ action: "overwrite" }));
  assert.deepEqual(plan, { offerIndices: [0, 1], removeIndices: [1], aborted: false });
});

test("skip a conflict: index omitted from offer and remove", async () => {
  const plan = await buildUploadPlan(["a.txt", "b.txt"], ["b.txt"], async () => ({ action: "skip" }));
  assert.deepEqual(plan, { offerIndices: [0], removeIndices: [], aborted: false });
});

test("cancel aborts the whole transfer", async () => {
  const plan = await buildUploadPlan(["a.txt", "b.txt"], ["b.txt"], async () => ({ action: "cancel" }));
  assert.deepEqual(plan, { offerIndices: [], removeIndices: [], aborted: true });
});

test("applyToRest reuses the action and stops prompting", async () => {
  let calls = 0;
  const plan = await buildUploadPlan(["a", "b", "c"], ["a", "b", "c"],
    async () => { calls++; return { action: "overwrite", applyToRest: true }; });
  assert.equal(calls, 1);
  assert.deepEqual(plan, { offerIndices: [0, 1, 2], removeIndices: [0, 1, 2], aborted: false });
});

test("only conflicting files invoke the resolver; order preserved", async () => {
  const seen = [];
  const plan = await buildUploadPlan(["a", "b", "c"], ["b"],
    async (n) => { seen.push(n); return { action: "skip" }; });
  assert.deepEqual(seen, ["b"]);
  assert.deepEqual(plan.offerIndices, [0, 2]);
});

test("duplicate basenames keep independent per-file decisions", async () => {
  // Two different local files share a basename; skip the first, overwrite the second.
  const actions = ["skip", "overwrite"];
  let i = 0;
  const plan = await buildUploadPlan(["x.txt", "x.txt"], ["x.txt"],
    async () => ({ action: actions[i++] }));
  assert.deepEqual(plan, { offerIndices: [1], removeIndices: [1], aborted: false });
});

// Issue #1079: overwriting (rm + rz re-create) drops the original permission
// bits. buildModeRestores resolves which overwritten files to chmod back.

test("buildModeRestores maps overwritten files to their captured modes", () => {
  assert.deepEqual(
    buildModeRestores("/home/u", ["a.sh", "b.txt"], [0], { "a.sh": "755" }),
    [{ path: "/home/u/a.sh", mode: "755" }],
  );
});

test("buildModeRestores skips files whose mode was not captured", () => {
  assert.deepEqual(
    buildModeRestores("/srv", ["a", "b"], [0, 1], { a: "644" }),
    [{ path: "/srv/a", mode: "644" }],
  );
});

test("buildModeRestores strips trailing slashes and dedupes duplicate basenames", () => {
  assert.deepEqual(
    buildModeRestores("/srv//", ["x", "x"], [0, 1], { x: "600" }),
    [{ path: "/srv/x", mode: "600" }],
  );
});


const hasLrzsz = spawnSync('sh', ['-c', 'command -v sz && command -v rz']).status === 0;

/** 用真实 lrzsz 进程当「远端」：stdout → sentry.consume，sentry 发出的字节 → stdin */
function runAgainst(cmd, args, cwd, bridgeExtra) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [];
    const terminal = [];
    const sentry = createZmodemSentry({
      onData: (bytes) => terminal.push(Buffer.from(bytes).toString('latin1')),
      writeToRemote: (bytes) => {
        if (!child.stdin.destroyed) child.stdin.write(Buffer.from(bytes));
        return true;
      },
      emit: (ev) => {
        events.push(ev);
        if (ev.type === 'complete' || ev.type === 'error') {
          setTimeout(() => {
            child.kill();
            resolve({ events, terminal: terminal.join('') });
          }, 300);
        }
      },
      ...bridgeExtra,
    });
    child.stdout.on('data', (d) => sentry.consume(new Uint8Array(d)));
    child.on('error', reject);
    setTimeout(() => {
      child.kill();
      reject(new Error(`timeout; events=${JSON.stringify(events)}`));
    }, 20000).unref();
  });
}

test('sz → ZMODEM download through the ported sentry writes the file', { skip: !hasLrzsz && 'lrzsz not installed' }, async () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-remote-'));
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-local-'));
  const payload = Buffer.alloc(300 * 1024 + 7);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761) >>> 24;
  fs.writeFileSync(path.join(remote, 'blob.bin'), payload);
  fs.writeFileSync(path.join(local, 'blob.bin'), 'existing');
  const files = new Map();
  let finished = [];
  const { events } = await runAgainst('sz', ['blob.bin'], remote, {
    selectUploadFiles: async () => null,
    readChunk: async () => new Uint8Array(),
    selectDownloadDirectory: async () => 'dir-token',
    createFile: async (dirToken, name) => {
      assert.equal(dirToken, 'dir-token');
      // 与 Rust zmodem_create_file 相同的命名：已存在时追加 (1)
      const target = path.join(local, fs.existsSync(path.join(local, name)) ? 'blob (1).bin' : name);
      files.set('f1', { path: target, chunks: [] });
      return { token: 'f1', name: path.basename(target) };
    },
    writeChunk: async (token, bytes) => files.get(token).chunks.push(Buffer.from(bytes)),
    finishFile: async (token, completed) => {
      const f = files.get(token);
      finished.push([token, completed]);
      if (completed) fs.writeFileSync(f.path, Buffer.concat(f.chunks));
    },
  });
  assert.equal(events[0].type, 'detect');
  assert.equal(events[0].transferType, 'download');
  assert.equal(events.at(-1).type, 'complete', JSON.stringify(events.at(-1)));
  assert.deepEqual(finished, [['f1', true]]);
  assert.ok(Buffer.from(fs.readFileSync(path.join(local, 'blob (1).bin'))).equals(payload));
  assert.equal(fs.readFileSync(path.join(local, 'blob.bin'), 'utf8'), 'existing');
});

test('rz → ZMODEM upload through the ported sentry delivers the file', { skip: !hasLrzsz && 'lrzsz not installed' }, async () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-remote-'));
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-local-'));
  const payload = Buffer.alloc(200 * 1024 + 3);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 40503) & 0xff;
  const src = path.join(local, 'up.bin');
  fs.writeFileSync(src, payload);
  const released = [];
  const { events } = await runAgainst('rz', [], remote, {
    selectUploadFiles: async () => [{ token: 't1', name: 'up.bin', size: payload.length, mtimeMs: Date.now() }],
    readChunk: async (token, offset, length) => {
      assert.equal(token, 't1');
      return new Uint8Array(payload.subarray(offset, offset + length));
    },
    releaseFiles: (tokens) => released.push(...tokens),
    selectDownloadDirectory: async () => null,
    createFile: async () => { throw new Error('unexpected'); },
    writeChunk: async () => {},
    finishFile: async () => {},
  });
  assert.equal(events[0].type, 'detect');
  assert.equal(events[0].transferType, 'upload');
  assert.equal(events.at(-1).type, 'complete', JSON.stringify(events.at(-1)));
  assert.deepEqual(released, ['t1']);
  assert.ok(fs.readFileSync(path.join(remote, 'up.bin')).equals(payload));
});

test('cancelling the download picker aborts sz and reports cancellation', { skip: !hasLrzsz && 'lrzsz not installed' }, async () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-remote-'));
  fs.writeFileSync(path.join(remote, 'x.txt'), 'x');
  const { events } = await runAgainst('sz', ['x.txt'], remote, {
    selectUploadFiles: async () => null,
    readChunk: async () => new Uint8Array(),
    selectDownloadDirectory: async () => null,
    createFile: async () => { throw new Error('unexpected'); },
    writeChunk: async () => {},
    finishFile: async () => {},
  });
  assert.deepEqual(events.at(-1), { type: 'error', error: 'Transfer cancelled' });
});
