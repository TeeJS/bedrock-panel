'use strict';
// The optional Claude token must reach the `claude` child processes (AI Voice + the CLI analysis
// paths) via getClaudeEnv(), and must NOT leak onto the Codex spawn. These drive each spawn site with
// a fake spawn and assert the env that was handed to it. The env-BUILDING logic is covered by
// test/claudeAuth.test.js; this covers the WIRING.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const { createClaudeVoiceSession, resetClaudeExeCache } = require('../app/claudevoice-session');
const { createLucidAI } = require('../app/lucidtypeAI');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {};
  return child;
}

test('AI Voice: the claude spawn env carries the token plus the OQX_VOICE_* keys', () => {
  resetClaudeExeCache();
  const captured = [];
  const tokenEnv = { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-voice' };
  const session = createClaudeVoiceSession({
    spawn: (exe, args, opts) => { captured.push(opts); return fakeChild(); },
    execFileSync: () => Buffer.from('C:\\tools\\claude.exe\n'),   // findClaudeExe PATH lookup
    getEnv: () => tokenEnv,
    log: () => {},
  });
  session.start({ projectDir: '.', permissionMode: 'manual', model: '', port: 4321, token: 'hooktok', systemPrompt: '' });
  assert.equal(captured.length, 1, 'spawn should have been called once');
  const env = captured[0].env;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-voice', 'token passed through');
  assert.equal(env.PATH, '/usr/bin', 'base env preserved');
  assert.equal(env.OQX_VOICE_SESSION, '1');
  assert.equal(env.OQX_VOICE_TOKEN, 'hooktok');
  assert.equal(String(env.OQX_VOICE_PORT), '4321');
  try { session.stop(); } catch (e) {}
});

test('AI Voice: without getEnv it falls back to process.env (no token injected)', () => {
  resetClaudeExeCache();
  const captured = [];
  const session = createClaudeVoiceSession({
    spawn: (exe, args, opts) => { captured.push(opts); return fakeChild(); },
    execFileSync: () => Buffer.from('C:\\tools\\claude.exe\n'),
    log: () => {},
  });
  session.start({ projectDir: '.', permissionMode: 'manual', model: '', port: 1, token: 't', systemPrompt: '' });
  assert.equal(captured[0].env.OQX_VOICE_SESSION, '1');
  assert.equal(captured[0].env.CLAUDE_CODE_OAUTH_TOKEN, process.env.CLAUDE_CODE_OAUTH_TOKEN);  // whatever the real env had, unchanged
  try { session.stop(); } catch (e) {}
});

function lucidFakeSpawn(captured, stdout) {
  return (cmd, args, opts) => {
    captured.push({ cmd, args, opts });
    const c = fakeChild();
    setImmediate(() => { c.stdout.write(stdout); c.stdout.end(); c.emit('close', 0); });
    return c;
  };
}

test('LucidType: the claude transform spawn gets the token env; the codex spawn gets none', async () => {
  const captured = [];
  const tokenEnv = { PATH: '/x', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-lucid' };
  const ai = createLucidAI({
    spawn: lucidFakeSpawn(captured, 'cleaned'),
    findClaudeExe: () => 'C:\\tools\\claude.exe',
    findCodexExe: () => 'C:\\tools\\codex.cmd',
    getClaudeEnv: () => tokenEnv,
    log: () => {},
  });

  const out = await ai.transform('SYS', 'raw', { backend: 'claude', timeoutMs: 2000 });
  assert.equal(out, 'cleaned');
  const claudeSpawn = captured.find(c => /claude/.test(c.cmd));
  assert.ok(claudeSpawn, 'claude was spawned');
  assert.equal(claudeSpawn.opts.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-lucid');

  captured.length = 0;
  // Codex writes its reply to a temp file we don't create, so the transform rejects — but the spawn
  // still happened, and that is what we inspect: it must NOT carry the Claude token env.
  await ai.transform('SYS', 'raw', { backend: 'codex', timeoutMs: 2000 }).catch(() => {});
  const codexSpawn = captured.find(c => /codex/.test(c.cmd));
  assert.ok(codexSpawn, 'codex was spawned');
  assert.equal(codexSpawn.opts.env, undefined, 'codex spawn inherits process.env, no token env');
});
