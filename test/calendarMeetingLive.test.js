'use strict';
// Runs the built calendar-meeting helper's own self-test (the :00/:30 selection rule, "Last, First"
// normalization, the join-link scan, the UTC format) when build-mac-helpers.js has produced it;
// skipped elsewhere. The self-test never opens the calendar store, so no Calendars prompt appears.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const bin = path.join(__dirname, '..', 'app', 'native', 'mac', 'calendar-meeting');
const skip = (process.platform !== 'darwin' || !fs.existsSync(bin)) && 'built calendar-meeting helper not present';
const run = args => {
  const r = spawnSync(bin, args, { timeout: 20000, encoding: 'utf8' });
  return { status: r.status, out: JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}') };
};

test('calendar-meeting selftest: the exe\'s selection and field rules hold', { skip }, () => {
  const r = run(['selftest']);
  assert.equal(r.out.ok, true, r.out.error);
  assert.equal(r.status, 0);
  assert.ok(r.out.selftest >= 12, 'every fixed case ran');
});

test('calendar-meeting answers bad usage as {"ok":false,"error"} with exit 0, like the exe', { skip }, () => {
  for (const args of [[], ['bogus'], ['meeting', 'only-account']]) {
    const r = run(args);
    assert.equal(r.status, 0, args.join(' '));
    assert.equal(r.out.ok, false);
    assert.match(r.out.error, /usage|unknown mode/);
  }
});
