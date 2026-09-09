'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { install } = require('../app/fileLog');

function fakeConsole() {
  const out = [];
  const c = {};
  for (const level of ['log', 'info', 'warn', 'error']) c[level] = (...a) => out.push([level, ...a]);
  return { c, out };
}

test('console output is mirrored to main.log with a timestamp and level, and still reaches the console', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-log-'));
  const { c, out } = fakeConsole();
  const t = new Date('2026-09-08T23:45:00.000Z');
  const log = install({ dir, console: c, now: () => t });
  assert.equal(log.file, path.join(dir, 'main.log'));
  c.log('hello %s', 'world');
  c.warn('careful', { n: 1 });
  c.error(new Error('boom').message);
  assert.deepEqual(out.map(l => l[0]), ['log', 'warn', 'error']);
  const lines = fs.readFileSync(log.file, 'utf8').trim().split('\n');
  assert.deepEqual(lines, [
    '2026-09-08T23:45:00.000Z info hello world',
    '2026-09-08T23:45:00.000Z warn careful { n: 1 }',
    '2026-09-08T23:45:00.000Z error boom',
  ]);
});

test('rotates to main.log.1 at the size limit, at startup and mid-run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-log-'));
  fs.writeFileSync(path.join(dir, 'main.log'), 'x'.repeat(300));
  const { c } = fakeConsole();
  const log = install({ dir, console: c, maxBytes: 200, now: () => new Date(0) });
  assert.equal(fs.readFileSync(path.join(dir, 'main.log.1'), 'utf8').length, 300, 'an oversized file from the last run is moved aside');
  for (let i = 0; i < 10; i++) c.log('line ' + i + ' ' + 'y'.repeat(40));
  assert.ok(fs.existsSync(path.join(dir, 'main.log.1')));
  assert.ok(fs.statSync(log.file).size <= 200 + 80, 'the live file is kept near the limit');
});

test('no directory, or an unwritable one, disables the file log without touching the console', () => {
  const { c, out } = fakeConsole();
  assert.equal(install({ dir: null, console: c }), null);
  assert.equal(install({ dir: path.join(os.tmpdir(), 'bp-log-' + Date.now(), 'nope', '\0bad'), console: c }), null);
  c.log('still works');
  assert.deepEqual(out, [['log', 'still works']]);
});
