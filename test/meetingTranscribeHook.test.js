'use strict';
// The pre/post transcription hooks run through the platform shell: cmd.exe on Windows, /bin/sh
// elsewhere. Both accept these commands, so the assertions hold on every platform the app runs on.
const test = require('node:test');
const assert = require('node:assert');
const { runShellHook } = require('../app/meetingTranscribe');

test('runShellHook runs a multi-line command through the platform shell and logs its output', async () => {
  const lines = [];
  await runShellHook('echo one\necho two', m => lines.push(m), 15000);
  const out = lines.join('\n');
  assert.match(out, /hook output: /);
  assert.match(out, /one/);
  assert.match(out, /two/);
});

test('runShellHook rejects when the command exits non-zero', async () => {
  await assert.rejects(runShellHook('exit 3', () => {}, 15000));
});
