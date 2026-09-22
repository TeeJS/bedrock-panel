'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../community-apps/deck-host/server.js');
const intent = server._openTargetIntent;

// The "Open" built-in used to build `start "" "<target>"` and run it through a cmd.exe shell, so a
// target containing a double quote (or a `cmd /c ...` prefix) could inject a command — and the target
// can come from an imported .streamDeckProfile. openTargetIntent now classifies the target as data:
// a URL for the browser, or an inert path for the OS default handler. No shell, no command branch.

test('open target: http(s) URLs route to the browser', () => {
  assert.deepEqual(intent('https://example.com/x'), { kind: 'url', value: 'https://example.com/x' });
  assert.deepEqual(intent('  http://a.b  '), { kind: 'url', value: 'http://a.b' });
});

test('open target: a filesystem path routes to the OS default handler', () => {
  assert.deepEqual(intent('C:\\Tools\\my app.exe'), { kind: 'path', value: 'C:\\Tools\\my app.exe' });
  assert.deepEqual(intent('/usr/bin/thing'), { kind: 'path', value: '/usr/bin/thing' });
});

test('open target: an injection attempt is an inert path, never a command', () => {
  const evil = 'x" & calc & "';        // would have broken out of the old start "" "<t>" quoting
  assert.deepEqual(intent(evil), { kind: 'path', value: evil });
  const shellEscape = 'cmd /c calc';   // the removed escape hatch is now just an (unopenable) path
  assert.deepEqual(intent(shellEscape), { kind: 'path', value: shellEscape });
});

test('open target: empty/whitespace is a no-op', () => {
  assert.deepEqual(intent('   '), { kind: 'none' });
  assert.deepEqual(intent(''), { kind: 'none' });
  assert.deepEqual(intent(undefined), { kind: 'none' });
});
