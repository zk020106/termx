import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseOsc7Cwd,
  setSessionCwd,
  getSessionCwd,
  forgetSessionCwd,
  subscribeSessionCwd,
} from '../.tmp/test-build/lib/terminalCwd.js';

test('parseOsc7Cwd follows Netcatty OSC 7 handler', () => {
  assert.equal(parseOsc7Cwd('file://host/home/u/my%20dir'), '/home/u/my dir');
  assert.equal(parseOsc7Cwd('file:///tmp'), '/tmp');
  assert.equal(parseOsc7Cwd('/var/log'), '/var/log');
  assert.equal(parseOsc7Cwd('relative/path'), null);
  assert.equal(parseOsc7Cwd('file://%zz'), null);
});

test('session cwd store notifies only on change', () => {
  const seen = [];
  const off = subscribeSessionCwd((key, cwd) => seen.push([key, cwd]));
  setSessionCwd('k1', '/a');
  setSessionCwd('k1', '/a');
  setSessionCwd('k1', '/b');
  off();
  setSessionCwd('k1', '/c');
  assert.deepEqual(seen, [['k1', '/a'], ['k1', '/b']]);
  assert.equal(getSessionCwd('k1'), '/c');
  forgetSessionCwd('k1');
  assert.equal(getSessionCwd('k1'), null);
});
