'use strict';
// Vault push (docs/charter-vault-push.md §5), against real git and a throwaway local remote: an
// export ends committed and on the remote; a remote edit to another file is merged in; a remote
// edit to the same file forces nothing and loses nothing; a refused sign-in or an unreachable
// remote keeps the commit for the next run; a vault that is not a repository (or a PC without
// git) still gets its export; and with the setting off no git process is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { EventEmitter, PassThrough } = require('node:stream');
const { createVaultPush, gitEnv } = require('../app/vaultPush');
const { createMeetingAnalyzer } = require('../app/meetingAnalyze');
const { readFrontmatter } = require('../app/meetingFrontmatter');

// The tests' git sees no user or system configuration (signing, hooks, default branch).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-vp-cfg-'));
const emptyConfig = path.join(scratch, 'gitconfig');
fs.writeFileSync(emptyConfig, '');
const ENV = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' });

let hasGit = true;
try { childProcess.execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch (e) { hasGit = false; }
const opt = { skip: hasGit ? false : 'git is not installed' };

function git(cwd, ...args) {
  return childProcess.execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function identify(repo, name) { git(repo, 'config', 'user.name', name); git(repo, 'config', 'user.email', name + '@example.test'); }

// A bare remote, the vault (a clone with one commit pushed), and a second clone standing in for a phone.
function repos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-vp-'));
  const remote = path.join(root, 'remote.git'), vault = path.join(root, 'vault'), phone = path.join(root, 'phone');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'init', '-q', '-b', 'main', vault);
  identify(vault, 'bedrock');
  fs.writeFileSync(path.join(vault, 'README.md'), 'meetings vault\n');
  git(vault, 'add', '-A'); git(vault, 'commit', '-q', '-m', 'first');
  git(vault, 'remote', 'add', 'origin', remote);
  git(vault, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'clone', '-q', remote, phone);
  identify(phone, 'phone');
  return { root, remote, vault, phone };
}
const remoteFiles = r => git(r.remote, 'ls-tree', '-r', '--name-only', 'main').split(/\r?\n/).filter(Boolean);
const remoteFile = (r, name) => git(r.remote, 'show', 'main:' + name);
const remoteCount = r => Number(git(r.remote, 'rev-list', '--count', 'main'));
function phoneEdit(r, name, text) {
  git(r.phone, 'pull', '-q');
  fs.writeFileSync(path.join(r.phone, name), text);
  git(r.phone, 'add', '-A'); git(r.phone, 'commit', '-q', '-m', 'phone edit'); git(r.phone, 'push', '-q');
}

// A pusher on r.vault. `calls` records every git start; `intercept(args)` may answer one instead of git.
function pusher(r, extra) {
  const calls = [];
  let intercept = null;
  const execFile = (exe, args, opts, cb) => {
    calls.push({ exe, args, cwd: opts.cwd, env: opts.env });
    const fake = intercept && intercept(args);
    if (fake) { setImmediate(() => cb(Object.assign(new Error('git failed'), { code: fake.code }), '', fake.stderr)); return; }
    return childProcess.execFile(exe, args, opts, cb);
  };
  const vp = createVaultPush(Object.assign({
    execFile, env: ENV, busyWaitMs: 5,
    resolve: () => ({ enabled: true, vault: r.vault }),
    hostname: () => 'TESTPC',
  }, extra || {}));
  return { vp, calls, setIntercept: fn => { intercept = fn; } };
}

test('a new file in the vault is committed and pushed; a second run has nothing to do', opt, async () => {
  const r = repos();
  const { vp } = pusher(r);
  fs.mkdirSync(path.join(r.vault, '2026', '11'), { recursive: true });
  fs.writeFileSync(path.join(r.vault, '2026', '11', 'standup.md'), 'notes\n');
  const res = await vp.request();
  assert.equal(res.ok, true);
  assert.equal(res.state, 'pushed');
  assert.equal(res.pushed, 1);
  assert.deepEqual(remoteFiles(r), ['2026/11/standup.md', 'README.md']);
  assert.match(git(r.vault, 'log', '-1', '--format=%s'), /^vault backup: bedrock TESTPC \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(git(r.vault, 'status', '--porcelain'), '');
  assert.deepEqual(vp.getState(), res);
  const again = await vp.request();
  assert.equal(again.ok, true);
  assert.equal(again.state, 'up-to-date');
  assert.equal(remoteCount(r), 2);
});

test('a phone edit to a different file is merged in, then everything is pushed', opt, async () => {
  const r = repos();
  const { vp } = pusher(r);
  phoneEdit(r, 'phone-note.md', 'from the phone\n');
  fs.writeFileSync(path.join(r.vault, 'meeting.md'), 'from bedrock\n');
  const res = await vp.request();
  assert.equal(res.ok, true);
  assert.equal(res.state, 'pushed');
  assert.equal(res.pulled, 1);
  assert.equal(fs.readFileSync(path.join(r.vault, 'phone-note.md'), 'utf8'), 'from the phone\n');   // the phone's edit reached the PC
  assert.deepEqual(remoteFiles(r), ['README.md', 'meeting.md', 'phone-note.md']);
  assert.equal(git(r.vault, 'rev-parse', 'HEAD'), git(r.remote, 'rev-parse', 'main'));
});

test('a phone edit to the same file: nothing is forced, nothing is lost, and a merge is asked for', opt, async () => {
  const r = repos();
  const { vp, calls } = pusher(r);
  fs.writeFileSync(path.join(r.vault, 'meeting.md'), 'first version\n');
  assert.equal((await vp.request()).state, 'pushed');
  phoneEdit(r, 'meeting.md', 'speaker names fixed on the phone\n');
  const phoneHead = git(r.remote, 'rev-parse', 'main');
  fs.writeFileSync(path.join(r.vault, 'meeting.md'), 're-analysis from bedrock\n');
  const res = await vp.request();
  assert.equal(res.ok, false);
  assert.equal(res.state, 'conflict');
  assert.deepEqual(res.files, ['meeting.md']);
  assert.match(res.error, /merge is needed/);
  assert.equal(res.waiting, 1);
  assert.equal(git(r.remote, 'rev-parse', 'main'), phoneHead);                                    // the remote is exactly as the phone left it
  assert.equal(remoteFile(r, 'meeting.md'), 'speaker names fixed on the phone');
  assert.equal(fs.readFileSync(path.join(r.vault, 'meeting.md'), 'utf8'), 're-analysis from bedrock\n');   // the PC's version is intact
  assert.equal(git(r.vault, 'show', 'HEAD:meeting.md'), 're-analysis from bedrock');             // ...and committed here
  assert.equal(git(r.vault, 'status', '--porcelain'), '');                                        // the merge was backed out cleanly
  assert.equal(fs.existsSync(path.join(r.vault, '.git', 'MERGE_HEAD')), false);
  for (const c of calls) assert.equal(c.args.some(a => /^(--force|-f|--force-with-lease|reset|rebase)$/.test(a) || /^\+/.test(a)), false, c.args.join(' '));
});

test('sign-in refused: the error is reported, the commit stays, and the next run pushes both', opt, async () => {
  const r = repos();
  const { vp, setIntercept } = pusher(r);
  setIntercept(args => (args.includes('fetch') || args.includes('push'))
    ? { code: 128, stderr: "remote: Failed to authenticate user\nfatal: Authentication failed for 'https://tj:secret@git.example.test/meetings.git/'\n" } : null);
  fs.writeFileSync(path.join(r.vault, 'one.md'), 'one\n');
  const res = await vp.request();
  assert.equal(res.ok, false);
  assert.equal(res.state, 'signin');
  assert.match(res.error, /sign-in to the vault's remote was refused/);
  assert.match(res.error, /1 commit waiting on this PC/);
  assert.doesNotMatch(res.error, /secret/);                    // a sign-in in the URL is never shown
  assert.equal(res.waiting, 1);
  assert.equal(git(r.vault, 'show', 'HEAD:one.md'), 'one');   // committed on the PC
  assert.equal(remoteCount(r), 1);
  setIntercept(null);
  fs.writeFileSync(path.join(r.vault, 'two.md'), 'two\n');
  const next = await vp.request();
  assert.equal(next.ok, true);
  assert.equal(next.state, 'pushed');
  assert.equal(next.pushed, 2);
  assert.deepEqual(remoteFiles(r), ['README.md', 'one.md', 'two.md']);
  assert.equal(vp.getState().ok, true);                        // the earlier failure no longer shows
});

test('remote unreachable: the error is reported, the commit stays, and the next run pushes it', opt, async () => {
  const r = repos();
  const { vp } = pusher(r);
  git(r.vault, 'remote', 'set-url', 'origin', path.join(r.root, 'gone.git'));
  fs.writeFileSync(path.join(r.vault, 'one.md'), 'one\n');
  const res = await vp.request();
  assert.equal(res.ok, false);
  assert.equal(res.state, 'unreachable');
  assert.match(res.error, /could not be reached/);
  assert.equal(res.waiting, 1);
  git(r.vault, 'remote', 'set-url', 'origin', r.remote);
  const next = await vp.request();
  assert.equal(next.state, 'pushed');
  assert.deepEqual(remoteFiles(r), ['README.md', 'one.md']);
});

test('a vault that is not a git repository, sits inside a larger one, or is missing is reported and left alone', opt, async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-vp-plain-'));
  fs.writeFileSync(path.join(plain, 'a.md'), 'a\n');
  let res = await createVaultPush({ env: ENV, resolve: () => ({ enabled: true, vault: plain }) }).request();
  assert.equal(res.ok, false);
  assert.equal(res.state, 'not-repo');
  assert.match(res.error, /not a git repository/);
  assert.equal(fs.existsSync(path.join(plain, '.git')), false);

  const r = repos();
  const inner = path.join(r.vault, 'notes');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, 'a.md'), 'a\n');
  res = await createVaultPush({ env: ENV, resolve: () => ({ enabled: true, vault: inner }) }).request();
  assert.equal(res.state, 'not-repo');
  assert.match(res.error, /inside a larger git repository/);
  assert.equal(git(r.vault, 'status', '--porcelain'), '?? notes/');   // nothing was staged or committed

  res = await createVaultPush({ env: ENV, resolve: () => ({ enabled: true, vault: path.join(plain, 'missing') }) }).request();
  assert.equal(res.state, 'no-vault');
});

test('git not installed: reported, nothing else happens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-vp-nogit-'));
  const res = await createVaultPush({ gitPath: 'bedrock-no-such-git-binary', resolve: () => ({ enabled: true, vault: dir }) }).request();
  assert.equal(res.ok, false);
  assert.equal(res.state, 'no-git');
  assert.match(res.error, /Git is not installed/);
});

test('setting off: no git process is started', async () => {
  let started = 0;
  const vp = createVaultPush({ execFile: () => { started++; }, resolve: () => ({ enabled: false, vault: os.tmpdir() }) });
  assert.equal(await vp.request(), null);
  assert.equal(started, 0);
  assert.equal(vp.getState(), null);
});

test('git runs only in the vault folder, never prompts, and requests made together share one run', opt, async () => {
  const r = repos();
  const { vp, calls } = pusher(r);
  fs.writeFileSync(path.join(r.vault, 'a.md'), 'a\n');
  const first = vp.request(), second = vp.request();
  assert.equal(first, second);
  assert.equal((await first).state, 'pushed');
  await vp.idle();
  assert.ok(calls.length > 0);
  for (const c of calls) {
    assert.equal(c.cwd, r.vault);
    assert.deepEqual(c.args.slice(0, 4), ['-c', 'core.askPass=', '-c', 'credential.interactive=never']);
    assert.equal(c.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(c.env.GCM_INTERACTIVE, 'never');
  }
  const env = gitEnv({ GIT_ASKPASS: 'C:\\some\\askpass.exe' });
  assert.equal(env.GIT_ASKPASS, '');
  assert.equal(env.GCM_GUI_PROMPT, 'false');
});

// ---- through the analyzer: the export, then the push ----
function fakeSpawn(behavior) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
    proc.kill = () => {};
    proc.stdin.on('data', () => {});
    setImmediate(() => { const b = behavior(); proc.stdout.write(b.stdout || ''); proc.stdout.end(); proc.stderr.end(); proc.emit('close', b.code === undefined ? 0 : b.code); });
    return proc;
  };
}
function drained(an) { return new Promise(res => { const t = setInterval(() => { const s = an.getState(); if (!s.running && !s.queue.length) { clearInterval(t); res(); } }, 10); }); }
const SEGMENTS = [
  { speaker: 'T.J. Schmitz', start: 0, end: 4, text: 'good morning everyone welcome to the weekly review' },
  { speaker: 'Speaker A', start: 4.5, end: 9, text: 'thanks lets start with the audit items' },
];
const OUTPUT = '# Meeting Analysis\n## Summary\nFirst pass.\n## Transcript\n'
  + '[T.J. Schmitz 0:00] Good morning everyone, welcome to the weekly review.\n'
  + '[Carl Tanner 0:04] Thanks, let\'s start with the audit items.\n'
  + ['', '<!-- BEDROCK-STRUCTURED v1 -->',
    'KEY POINTS:', '- Audit on track', '', 'DECISIONS:', '- (none)', '', 'ACTION ITEMS:', '- (none)', '',
    'OPEN QUESTIONS:', '- (none)', '', 'COMMITMENTS:', '- (none)', '',
    'PARTICIPANTS:', '- T.J. Schmitz', '- Carl Tanner', '',
    'SPEAKER MAP:', '- Speaker A -> Carl Tanner (direct address)', '',
    'TURNS:', '- 1: segments 0-0', '- 2: segments 1-1', '<!-- /BEDROCK-STRUCTURED -->', ''].join('\n');
const BASE = '2026-10-14-15-57-16-G1 Weekly Review';
const REL = '2026/G1-Weekly-Review/' + BASE + '.md';

function analyzer(vault, vaultPush) {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-vp-done-'));
  fs.writeFileSync(path.join(processed, BASE + '-diarizer-response.json'), JSON.stringify({ segments: SEGMENTS, speaker_report: { speakers: [{ label: 'T.J. Schmitz', identified: true }] } }));
  fs.writeFileSync(path.join(processed, BASE + '.json'), JSON.stringify({ subject: 'G1 Weekly Review', is_recurring: true, start: '2026-10-14T22:00:00+00:00', required_attendees: ['Carl Tanner', 'T.J. Schmitz'], optional_attendees: [] }));
  fs.writeFileSync(path.join(processed, BASE + '.capture.json'), JSON.stringify({ schema: 1, started_at: '2026-10-14T15:57:16-07:00', tz: 'America/Los_Angeles', device: 'Mic' }));
  const outcomes = [];
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'claude',
    findClaudeExe: () => 'claude.exe', findCodexExe: () => null,
    spawn: fakeSpawn(() => ({ stdout: OUTPUT, code: 0 })),
    filingOptions: () => ({ useDetailsFolder: true, separateRecurring: true }),
    resolveMyName: () => 'T.J. Schmitz',
    resolveObsidian: () => ({ enabled: true, vault }),
    vaultPush,
  });
  an.onOutcome(o => outcomes.push(o));
  return { an, processed, outcomes, md: path.join(processed, '2026', 'G1-Weekly-Review', BASE + '.md'), json: BASE + '-diarizer-response.json' };
}

test('an analyzed meeting ends with its file committed and on the remote, along with anything else changed in the vault', opt, async () => {
  const r = repos();
  const { vp } = pusher(r);
  fs.writeFileSync(path.join(r.vault, 'edited-in-obsidian.md'), 'a note written in Obsidian\n');   // the whole vault is committed
  const a = analyzer(r.vault, vp);
  assert.equal(a.an.start(a.json).ok, true);
  await drained(a.an);
  const st = a.an.getState();
  assert.equal(st.error, null);
  assert.equal(st.obsidian.ok, true);
  assert.equal(st.vaultPush.ok, true);
  assert.equal(st.vaultPush.state, 'pushed');
  assert.equal(a.outcomes[0].warning, undefined);
  assert.deepEqual(remoteFiles(r), [REL, 'README.md', 'edited-in-obsidian.md']);
  assert.equal(remoteFile(r, REL), fs.readFileSync(path.join(r.vault, REL), 'utf8').replace(/\r?\n$/, ''));
  assert.equal(git(r.vault, 'status', '--porcelain'), '');
  // Only the .md went to the vault, the sources stayed in Completed, and the push left no record in the meeting file.
  assert.equal(fs.existsSync(path.join(a.processed, '2026', 'G1-Weekly-Review', 'details', a.json)), true);
  assert.equal(remoteFiles(r).some(f => /details|diarizer/.test(f)), false);
  assert.deepEqual(Object.keys(readFrontmatter(fs.readFileSync(a.md, 'utf8')).data.bedrock.exports), ['obsidian']);
});

test('a vault that is not a repository, or a PC without git: the export still succeeds and the panel says why nothing was pushed', opt, async () => {
  for (const [extra, why] of [[{}, /not a git repository/], [{ gitPath: 'bedrock-no-such-git-binary' }, /Git is not installed/]]) {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-vp-vault-'));
    const vp = createVaultPush(Object.assign({ env: ENV, resolve: () => ({ enabled: true, vault }) }, extra));
    const a = analyzer(vault, vp);
    assert.equal(a.an.start(a.json).ok, true);
    await drained(a.an);
    const st = a.an.getState();
    assert.equal(st.error, null);                                        // the analysis is a success
    assert.equal(st.obsidian.ok, true);
    assert.equal(fs.existsSync(path.join(vault, REL)), true);            // the file is in the vault
    assert.equal(st.vaultPush.ok, false);
    assert.match(st.vaultPush.error, why);                               // shown on the panel
    assert.match(a.outcomes[0].warning, /^Vault push failed: /);
  }
});

test('a vault folder that is not there: the export reports it and no push is attempted', async () => {
  let asked = 0;
  const vp = { idle: async () => {}, request: async () => { asked++; return null; }, getState: () => null };
  const a = analyzer(path.join(os.tmpdir(), 'oqx-vp-no-such-vault-' + process.pid), vp);
  assert.equal(a.an.start(a.json).ok, true);
  await drained(a.an);
  assert.match(a.an.getState().obsidian.error, /not found/);
  assert.equal(asked, 0);
});
