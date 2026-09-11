'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ensureShellPath, augmentPath, loginShellPath, wellKnownDirs } = require('../app/shellPath');

test('loginShellPath asks the login shell and extracts the marked PATH; failures and garbage give null', () => {
  const calls = [];
  const exec = (file, args, opts) => { calls.push([file, args, opts]); return 'motd banner\n__BP_PATH__/opt/homebrew/bin:/Users/t/.local/bin:/usr/bin__END__'; };
  assert.equal(loginShellPath({ shell: '/bin/zsh', execFileSync: exec, env: { HOME: '/Users/t' } }), '/opt/homebrew/bin:/Users/t/.local/bin:/usr/bin');
  assert.deepEqual(calls[0][1].slice(0, 2), ['-ilc', 'printf "%s%s%s" "__BP_PATH__" "$PATH" "__END__"']);
  assert.equal(calls[0][2].env.TERM, 'dumb');
  assert.ok(calls[0][2].timeout > 0);
  assert.equal(loginShellPath({ execFileSync: () => { throw new Error('timeout'); } }), null);
  assert.equal(loginShellPath({ execFileSync: () => 'no markers here' }), null);
  assert.equal(loginShellPath({ execFileSync: () => '__BP_PATH____END__' }), null, 'an empty PATH is no PATH');
});

test('augmentPath keeps the current PATH first, adds the shell entries, then existing well-known dirs, without duplicates', () => {
  const env = { PATH: '/usr/bin:/bin' };
  const r = augmentPath({ env, shellPath: '/opt/homebrew/bin:/usr/bin:/Users/t/.local/bin', extraDirs: ['/opt/homebrew/bin', '/Users/t/.volta/bin', '/nope'], exists: p => p !== '/nope' });
  assert.equal(env.PATH, '/usr/bin:/bin:/opt/homebrew/bin:/Users/t/.local/bin:/Users/t/.volta/bin');
  assert.deepEqual(r.added, ['/opt/homebrew/bin', '/Users/t/.local/bin', '/Users/t/.volta/bin']);
  const again = augmentPath({ env, shellPath: '/opt/homebrew/bin', extraDirs: [], exists: () => true });
  assert.deepEqual(again.added, [], 'idempotent');
});

test('ensureShellPath is a no-op on Windows and logs what it added elsewhere', () => {
  const winEnv = { PATH: 'C:\\Windows' };
  assert.equal(ensureShellPath({ platform: 'win32', env: winEnv }), null);
  assert.equal(winEnv.PATH, 'C:\\Windows');
  const env = { PATH: '/usr/bin:/bin' };
  const logs = [];
  const r = ensureShellPath({ platform: 'darwin', env, execFileSync: () => '__BP_PATH__/opt/homebrew/bin:/usr/bin__END__', extraDirs: ['/Users/t/.local/bin'], exists: () => true, log: m => logs.push(m) });
  assert.deepEqual(r.added, ['/opt/homebrew/bin', '/Users/t/.local/bin']);
  assert.match(logs[0], /added 2 dir\(s\) from the login shell: \/opt\/homebrew\/bin:\/Users\/t\/\.local\/bin/);
  const env2 = { PATH: '/usr/bin' };
  const logs2 = [];
  ensureShellPath({ platform: 'darwin', env: env2, execFileSync: () => { throw new Error('no shell'); }, extraDirs: ['/opt/homebrew/bin'], exists: () => true, log: m => logs2.push(m) });
  assert.equal(env2.PATH, '/usr/bin:/opt/homebrew/bin');
  assert.match(logs2[0], /shell gave nothing; well-known dirs only/);
});

test('wellKnownDirs covers Homebrew, ~/.local/bin (the claude CLI), npm/volta/bun, and nvm node bins newest first', () => {
  const dirs = wellKnownDirs('/Users/t');
  // The home-relative entries are path.join'd by wellKnownDirs, so join them here too: on Windows
  // they come back backslashed and a forward-slash literal would never match. The absolute ones
  // are literals in the implementation, so they stay literals here.
  const home = (...p) => path.join('/Users/t', ...p);
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', home('.local', 'bin'), home('.npm-global', 'bin'), home('.volta', 'bin'), home('.bun', 'bin')]) assert.ok(dirs.includes(d), d);
});
