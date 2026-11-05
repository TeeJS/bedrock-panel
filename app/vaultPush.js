'use strict';

// Vault push: after Bedrock copies a meeting file into the Obsidian vault (obsidianExport.js), it
// commits and pushes the vault itself, so meetings reach the git remote with Obsidian closed
// (docs/charter-vault-push.md). One run = stage everything changed in the vault, commit, fetch,
// merge the remote's changes in, push. Deps are injected for tests: execFile, resolve, log, now,
// hostname, gitPath, fs.
//
// Rules this file keeps:
//   - git is started directly (execFile, no shell), only with the vault folder as its working
//     directory, and only when the vault folder is itself the top of a git repository.
//   - It never prompts. Sign-in comes from whatever the PC's Git already has saved; a refused
//     sign-in is reported and the commit waits on this PC for the next run.
//   - Nothing is forced, reset or rewritten. A remote change to the same file as a local one backs
//     the merge out (git merge --abort), keeps the local commit, and is reported for a manual merge.
//   - Runs are serialized, and a request made while one is queued joins it.
// The result is kept for the panel (getState) and never written into a meeting file: that would
// change the file that was just committed.

const pathMod = require('path');

const LOCAL_MS = 30000;   // a local git command
const NET_MS = 90000;     // fetch / push
const BUSY_TRIES = 4;
const BUSY_WAIT_MS = 1500;

const BUSY_RE = /index\.lock|another git process/i;
const AUTH_RE = /authentication failed|failed to authenticate|could not read (username|password)|terminal prompts disabled|permission denied|access denied|returned error: 40[13]|HTTP 40[13]|interaction is not allowed|user interaction is disabled|cannot prompt/i;
const NET_RE = /could not resolve host|failed to connect|couldn't connect|unable to access|connection (timed out|refused|reset)|network is unreachable|could not read from remote|does not appear to be a git repository|timed out|unable to look up/i;
const REJECT_RE = /\[rejected\]|non-fast-forward|fetch first/i;

// Settings every git call carries: no askpass helper, no credential-manager window.
const GIT_PREFIX = ['-c', 'core.askPass=', '-c', 'credential.interactive=never', '-c', 'core.quotePath=false'];

function gitEnv(base) {
  return Object.assign({}, base || process.env, {
    GIT_TERMINAL_PROMPT: '0',     // git itself never asks on a terminal
    GCM_INTERACTIVE: 'never',     // Git Credential Manager never opens a window
    GCM_GUI_PROMPT: 'false',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_MERGE_AUTOEDIT: 'no',     // a merge commit never opens an editor
    LANGUAGE: 'C',                // English messages, so failures can be told apart
    LC_MESSAGES: 'C',
  });
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function stamp(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

// The one line of git's output worth showing: the last fatal/error/remote line, else the last
// line. Any sign-in embedded in a URL is removed.
function detailOf(r) {
  if (r.timedOut) return 'git did not finish in time';
  const lines = String(r.stderr || r.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const pick = lines.filter(l => /^(fatal|error|remote):/i.test(l)).pop() || lines.pop() || (r.spawnError || 'git exited with code ' + r.code);
  return pick.replace(/\/\/[^/\s@]+@/g, '//').slice(0, 240);
}

function plural(n) { return n + ' commit' + (n === 1 ? '' : 's'); }

function createVaultPush(deps) {
  deps = deps || {};
  const execFile = deps.execFile || require('child_process').execFile;
  const fsMod = deps.fs || require('fs');
  const resolve = deps.resolve || (() => ({}));        // () => { enabled, vault }
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  const hostname = deps.hostname || (() => require('os').hostname());
  const busyWaitMs = deps.busyWaitMs === undefined ? BUSY_WAIT_MS : deps.busyWaitMs;

  let gitExe = deps.gitPath || null;   // resolved on first use and remembered
  let last = null;                     // the last run's result, for the panel
  let queued = null;                   // a run that has not started yet
  let chain = Promise.resolve();

  function run(exe, cwd, args, ms) {
    return new Promise(done => {
      const opts = { cwd, windowsHide: true, timeout: ms || LOCAL_MS, maxBuffer: 16 * 1024 * 1024, env: gitEnv(deps.env) };
      try {
        execFile(exe, GIT_PREFIX.concat(args), opts, (err, stdout, stderr) => {
          const r = { code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') };
          if (err) {
            if (typeof err.code === 'number') r.code = err.code;
            else { r.code = -1; r.spawnError = err.code === 'ENOENT' ? 'ENOENT' : (err.message || 'git could not be started'); }
            if (err.killed) r.timedOut = true;
          }
          done(r);
        });
      } catch (e) { done({ code: -1, stdout: '', stderr: '', spawnError: (e && e.code) === 'ENOENT' ? 'ENOENT' : ((e && e.message) || 'git could not be started') }); }
    });
  }

  // git on PATH, else the usual Git for Windows install folders. null when there is none.
  async function findGit(cwd) {
    if (gitExe) return gitExe;
    const candidates = ['git'];
    if (process.platform === 'win32') {
      for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && pathMod.join(process.env.LOCALAPPDATA, 'Programs')]) {
        if (root) candidates.push(pathMod.join(root, 'Git', 'cmd', 'git.exe'));
      }
    }
    for (const exe of candidates) {
      const r = await run(exe, cwd, ['--version']);
      if (r.code === 0) { gitExe = exe; return exe; }
    }
    return null;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function runOnce() {
    const cfg = resolve() || {};
    if (!cfg.enabled) return null;                    // setting off: no git process is started
    const vault = String(cfg.vault || '').trim();
    const fail = (state, error, extra) => Object.assign({ ok: false, state, error, finishedAt: now() }, extra || {});
    const done = (state, extra) => Object.assign({ ok: true, state, finishedAt: now() }, extra || {});

    let st = null;
    try { st = vault ? fsMod.statSync(vault) : null; } catch (e) { st = null; }
    if (!st || !st.isDirectory()) return fail('no-vault', 'the vault folder was not found' + (vault ? ' (' + vault + ')' : '') + ' — nothing pushed');

    const exe = deps.gitPath || await findGit(vault);
    if (!exe) return fail('no-git', 'Git is not installed on this PC (git was not found) — nothing pushed');
    const G = (args, ms) => run(exe, vault, args, ms);
    // A vault another git process is using right now (the Obsidian Git plugin, say): wait and retry.
    const patient = async (args, ms) => {
      let r = await G(args, ms);
      for (let i = 1; i < BUSY_TRIES && r.code !== 0 && BUSY_RE.test(r.stderr); i++) { await sleep(busyWaitMs); r = await G(args, ms); }
      return r;
    };

    let r = await G(['rev-parse', '--is-inside-work-tree', '--show-prefix']);
    if (r.spawnError === 'ENOENT') return fail('no-git', 'Git is not installed on this PC (git was not found) — nothing pushed');
    if (r.code !== 0 || !/^true\b/.test(r.stdout)) {
      const notRepo = /not a git repository/i.test(r.stderr) || r.code === 0;
      return fail('not-repo', 'the vault folder is not a git repository — nothing pushed' + (notRepo ? '' : ' (' + detailOf(r) + ')'));
    }
    if ((r.stdout.split(/\r?\n/)[1] || '').trim()) {
      return fail('not-repo', 'the vault folder is inside a larger git repository; Bedrock only pushes a vault that is its own repository — nothing pushed');
    }
    if ((await G(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0) {
      return fail('unfinished-merge', 'the vault has an unfinished merge — finish it in Obsidian or git; nothing pushed');
    }
    r = await G(['symbolic-ref', '-q', '--short', 'HEAD']);
    if (r.code !== 0 || !r.stdout.trim()) return fail('no-branch', 'the vault is not on a branch — nothing pushed');
    const branch = r.stdout.trim();

    // Stage and commit everything changed in the vault (the whole vault, as the Obsidian Git plugin does).
    r = await patient(['add', '-A']);
    if (r.code !== 0) return fail(BUSY_RE.test(r.stderr) ? 'busy' : 'commit-failed', 'the vault could not be committed — nothing pushed (' + detailOf(r) + ')');
    r = await G(['diff', '--cached', '--quiet']);
    let committed = false;
    if (r.code === 1) {
      r = await patient(['commit', '-q', '-m', 'vault backup: bedrock ' + hostname() + ' ' + stamp(now())]);
      if (r.code !== 0) return fail(BUSY_RE.test(r.stderr) ? 'busy' : 'commit-failed', 'the vault could not be committed — nothing pushed (' + detailOf(r) + ')');
      committed = true;
    } else if (r.code !== 0) {
      return fail('commit-failed', 'the vault could not be committed — nothing pushed (' + detailOf(r) + ')');
    }

    const remote = (await G(['config', '--get', 'branch.' + branch + '.remote'])).stdout.trim();
    const mergeRef = (await G(['config', '--get', 'branch.' + branch + '.merge'])).stdout.trim();
    if (!remote || remote === '.' || !mergeRef) {
      return fail('no-upstream', 'the vault\'s branch "' + branch + '" has no remote branch to push to — nothing pushed');
    }

    // Commits this PC has that the remote (as last seen) does not.
    const waitingCount = async () => {
      const c = await G(['rev-list', '--count', '@{u}..HEAD']);
      if (c.code === 0) return Number(c.stdout.trim()) || 0;
      const all = await G(['rev-list', '--count', 'HEAD']);
      return all.code === 0 ? Number(all.stdout.trim()) || 0 : 0;
    };
    const remoteFail = async (what, res) => {
      const waiting = await waitingCount();
      const kept = waiting ? '; ' + plural(waiting) + ' waiting on this PC, tried again on the next export' : '';
      const d = detailOf(res);
      if (AUTH_RE.test(res.stderr)) return fail('signin', 'sign-in to the vault\'s remote was refused' + kept + ' (' + d + ')', { waiting });
      if (res.timedOut || NET_RE.test(res.stderr)) return fail('unreachable', 'the vault\'s remote could not be reached' + kept + ' (' + d + ')', { waiting });
      return fail('failed', what + ' failed' + kept + ' (' + d + ')', { waiting });
    };

    for (let attempt = 0; ; attempt++) {
      r = await G(['fetch', '-q', remote], NET_MS);
      if (r.code !== 0) return remoteFail('fetching from the vault\'s remote', r);

      let ahead, behind = 0;
      const hasUpstream = (await G(['rev-parse', '-q', '--verify', '@{u}'])).code === 0;
      if (hasUpstream) {
        r = await G(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
        if (r.code !== 0) return fail('failed', 'the vault could not be compared with its remote (' + detailOf(r) + ')');
        const parts = r.stdout.trim().split(/\s+/);
        ahead = Number(parts[0]) || 0; behind = Number(parts[1]) || 0;
      } else {
        ahead = await waitingCount();   // the remote branch does not exist yet: everything here is new
      }

      let pulled = 0;
      if (behind > 0) {
        r = await patient(['merge', '--no-edit', '-q', '@{u}']);
        if (r.code !== 0) {
          const files = (await G(['diff', '--name-only', '--diff-filter=U'])).stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
          const detail = detailOf(r);
          // Back the merge out: the vault returns to the local commit, with nothing lost on either side.
          if ((await G(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0) await G(['merge', '--abort']);
          const waiting = await waitingCount();
          if (files.length) {
            return fail('conflict', 'the remote changed the same file' + (files.length === 1 ? '' : 's') + ' (' + files.join(', ')
              + ') — a merge is needed. Nothing was pushed and nothing was overwritten; ' + plural(waiting) + ' waiting on this PC', { files, waiting });
          }
          return fail('merge-failed', 'the remote\'s changes could not be merged in — nothing pushed (' + detail + ')', { waiting });
        }
        pulled = behind;
        ahead = await waitingCount();
      }

      if (!ahead) return done('up-to-date', { pulled, committed });
      r = await G(['push', '-q', remote, 'HEAD:' + mergeRef], NET_MS);
      if (r.code === 0) return done('pushed', { pushed: ahead, pulled, committed });
      if (attempt === 0 && REJECT_RE.test(r.stderr)) continue;   // the remote moved between fetch and push: once more
      return remoteFail('pushing the vault', r);
    }
  }

  // Ask for a run. Resolves to the run's result ({ ok, state, error?, ... }), or null when the
  // setting is off. Never rejects. A request made while a run is waiting to start joins that run.
  function request() {
    if (queued) return queued;
    const p = chain.then(async () => {
      queued = null;
      let res;
      try { res = await runOnce(); }
      catch (e) { res = { ok: false, state: 'failed', error: (e && e.message) || 'vault push failed', finishedAt: now() }; }
      last = res;
      if (res) log(res.ok ? 'vault push: ' + res.state + (res.pushed ? ' (' + plural(res.pushed) + ')' : '') : 'vault push failed: ' + res.error);
      return res;
    });
    queued = p;
    chain = p.then(() => {}, () => {});
    return p;
  }

  return {
    request,
    idle: () => chain,          // resolves when no run is in progress or waiting
    getState: () => last,       // for the panel: null until a run finishes (or when the setting is off)
  };
}

module.exports = { createVaultPush, gitEnv };
