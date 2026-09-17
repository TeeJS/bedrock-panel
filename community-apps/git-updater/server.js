'use strict';

// git-updater drop-in backend — a thin adapter over the vendored engine (engine/,
// see engine/VENDORED.md). Runs in the Bedrock Panel host's main process.
//
// Shares config/state/logs with the STANDALONE git-updater, in whatever directory that
// app uses on this OS (engine/paths.js): the tracked-app list is managed there; this app
// checks and applies updates from the panel. Concurrent runs are safe — the engine's
// cross-process pid lock (state.js) makes a simultaneous standalone run wait instead of
// corrupting state.
//
// Bridge contract: the page calls /app-api/<action> -> handle(action, {query, body}).
// check/update start an async batch and return immediately; the page polls `status`.

const fs = require('fs');
const path = require('path');

const core = require('./engine/core');
const runner = require('./engine/runner');
const state = require('./engine/state');
const detect = require('./engine/detect');
const github = require('./engine/github');
const catalog = require('./engine/catalog');
const paths = require('./engine/paths');
const { log } = require('./engine/log');

// The engine owns where git-updater's files live per OS — resolving it here too would
// mean the config went somewhere the state and the logs did not.
const CONFIG_PATH = process.env.GITUPDATER_CONFIG || path.join(paths.configDir(), 'config.json');

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { portableRoot: '', repos: [] };
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
// Same backup + tmp-rename pattern as the standalone app — both write the shared file.
function saveConfigFile(cfg) {
  if (!cfg || !Array.isArray(cfg.repos)) throw new Error('config: "repos" must be an array');
  cfg.repos.forEach((r, i) => {
    if (!r.owner || !r.repo) throw new Error(`app ${i + 1}: owner and repo are required`);
    if (r.type !== 'portable' && r.type !== 'installer') throw new Error(`app ${i + 1}: type must be portable or installer`);
  });
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.${stamp}.bak`);
  }
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}
function appKey(r) { return `${r.owner}/${r.repo}#${r.type}`; }
function portableDir(cfg, r) {
  if (r.install && r.install.dir) return r.install.dir;
  return cfg.portableRoot ? `${cfg.portableRoot.replace(/[\\/]+$/, '')}/${r.repo}` : null;
}
function dirHasFiles(dir) {
  try { return !!dir && fs.existsSync(dir) && fs.readdirSync(dir).length > 0; } catch { return false; }
}

// ── batch state the page polls ────────────────────────────────────────────────
let running = false;          // a check/update batch is in flight
let batchMode = null;         // 'check' | 'update'
let status = {};              // key -> { ph, pct?, from?, to?, reason?, note? }
let lock = null;              // engine state lock while an update batch runs

function setPh(key, patch) { status[key] = { ...(status[key] || {}), ...patch }; }

function applyResults(results, mode) {
  for (const r of results) {
    if (r.status === 'failed') setPh(r.id, { ph: 'failed', reason: r.reason, from: r.from, to: r.to });
    else if (r.status === 'current') setPh(r.id, { ph: 'current', from: r.from, to: r.to });
    else if (mode === 'check') setPh(r.id, { ph: 'available', from: r.from, to: r.to, note: r.note });
    else setPh(r.id, { ph: 'updated', from: r.to, to: r.to, note: r.note });
  }
}

// A check can discover that an app typed as an installer publishes no installer for this
// OS, and correct it to portable (retypeIfNoInstaller in engine/runner.js). The runner only
// decides; persisting is ours, exactly as the standalone's main process does it — otherwise
// the correction is made again on every check and never sticks. Never silent: the status
// entry carries the engine's note, and it is logged.
function applyRetypes(results) {
  const changes = (results || []).filter((r) => r.retyped && r.retyped.to === 'portable');
  if (!changes.length) return;
  const cfg = readConfig();
  const hits = [];
  for (const r of changes) {
    const m = /^([^/]+)\/([^/]+)#(.+)$/.exec(r.id || '');
    if (!m) continue;
    const [, owner, repo, type] = m;
    // Already tracked as portable: correcting would create a duplicate entry. Leave the
    // installer entry alone and let the user untrack it.
    if ((cfg.repos || []).some((x) => x.owner === owner && x.repo === repo && x.type === 'portable')) continue;
    const entry = (cfg.repos || []).find((x) => x.owner === owner && x.repo === repo && x.type === type);
    if (!entry) continue;
    entry.type = 'portable';
    entry.install = { ...(entry.install || {}), dir: r.retyped.dir };
    // The page reloads its list when the batch ends, so move the status across to the key
    // that list will return — otherwise the row comes back blank and the note is lost.
    status[`${owner}/${repo}#portable`] = status[r.id];
    delete status[r.id];
    hits.push(`${owner}/${repo}`);
  }
  if (!hits.length) return;
  saveConfigFile(cfg);
  log(`dropin retyped to portable (no installer published): ${hits.join(', ')}`);
}

async function runBatch(mode, only, force) {
  const config = core.validateConfig(readConfig());
  const keys = config.repos.map(appKey).filter((k) => !only || k === only);
  keys.forEach((k) => setPh(k, { ph: 'queued' }));
  const onProgress = (id, phase, pct) => setPh(id, { ph: phase, pct });
  try {
    if (mode === 'update') lock = state.acquireLock();
    // Hand the file to the OS so an interactive installer runs the way it expects:
    // ShellExecute on Windows (its UAC manifest works), Installer.app on macOS, the
    // desktop's package installer on Linux. The window opens on the PC, same as standalone.
    const openFile = (f) => { try { require('electron').shell.openPath(f); } catch (e) { log(`dropin openFile: ${e.message}`); } };
    const { results } = await runner.run(config, { mode: mode === 'check' ? 'check' : undefined, only, force: !!force, onProgress, openFile });
    applyResults(results, mode);
    if (mode === 'check') applyRetypes(results);
  } catch (e) {
    log(`dropin ${mode} batch: ${e.message || e}`);
    keys.forEach((k) => { if (!status[k] || ['queued', 'checking', 'downloading', 'verifying', 'installing'].includes(status[k].ph)) setPh(k, { ph: 'failed', reason: String(e.message || e) }); });
  } finally {
    if (lock) { state.releaseLock(lock); lock = null; }
    running = false; batchMode = null;
  }
}

function startBatch(mode, only, force) {
  if (running) return { ok: false, error: 'a batch is already running' };
  running = true; batchMode = mode;
  runBatch(mode, only || null, force); // async — page polls `status`
  return { ok: true };
}

exports.handle = async function handle(action, ctx) {
  const q = (ctx && ctx.query) || {};
  const body = ctx && ctx.body ? JSON.parse(ctx.body.toString('utf8') || '{}') : {};

  if (action === 'list') {
    detect.clearCache(); // fresh inventory scan — an install may have just changed versions
    const cfg = readConfig();
    const stt = state.load();
    const apps = [];
    for (const r of cfg.repos || []) {
      const key = appKey(r);
      let current = null; let present = false;
      if (r.type === 'installer') {
        try { current = await detect.installedVersion(r.detect || r.repo); } catch {}
        present = !!current;
      } else {
        const rec = stt[key];
        current = (rec && rec.version) || null;
        present = dirHasFiles(portableDir(cfg, r));
      }
      apps.push({ key, owner: r.owner, repo: r.repo, type: r.type, prerelease: !!r.prerelease, current, present });
    }
    return { ok: true, platform: process.platform, portableRoot: cfg.portableRoot || '', apps, status, running, batchMode };
  }

  if (action === 'status') return { ok: true, status, running, batchMode };

  if (action === 'check') return startBatch('check', body.only || q.only);
  if (action === 'update') return startBatch('update', body.only || q.only, !!body.force);

  if (action === 'add') {
    const owner = String(body.owner || '').trim();
    const repo = String(body.repo || '').trim();
    const type = body.type === 'portable' ? 'portable' : 'installer';
    if (!owner || !repo) return { ok: false, error: 'owner and repo are required' };
    const cfg = readConfig();
    if (type === 'portable' && !cfg.portableRoot) return { ok: false, error: 'set the portable apps folder first (Settings)' };
    if ((cfg.repos || []).some((r) => r.owner === owner && r.repo === repo && r.type === type)) {
      return { ok: false, error: `${owner}/${repo} (${type}) is already tracked` };
    }
    const rel = await github.getLatestRelease(owner, repo, { prerelease: !!body.prerelease }); // throws -> 500 with reason
    const entry = { owner, repo, type };
    if (body.prerelease) entry.prerelease = true;
    cfg.repos = cfg.repos || [];
    cfg.repos.push(entry);
    saveConfigFile(cfg);
    return { ok: true, key: appKey(entry), tag: rel.tag_name };
  }

  if (action === 'addMany') {
    // [{repo: "owner/name", type}] — same contract as the standalone scan window.
    const items = Array.isArray(body.items) ? body.items : [];
    const cfg = readConfig();
    if (!Array.isArray(cfg.repos)) cfg.repos = [];
    if (items.some((i) => i && i.type === 'portable') && !cfg.portableRoot) {
      return { ok: false, error: 'set the portable apps folder first (Settings)' };
    }
    let added = 0;
    for (const it of items) {
      const m = /^([^/]+)\/([^/]+)$/.exec(String(it && it.repo));
      const type = it && it.type === 'portable' ? 'portable' : 'installer';
      if (!m) continue;
      if (cfg.repos.some((r) => r.owner === m[1] && r.repo === m[2] && r.type === type)) continue;
      cfg.repos.push({ owner: m[1], repo: m[2], type });
      added++;
    }
    if (added) saveConfigFile(cfg);
    return { ok: true, added };
  }

  if (action === 'scan') {
    detect.clearCache();
    const tracked = new Set((readConfig().repos || []).map((r) => `${r.owner}/${r.repo}`.toLowerCase()));
    return { ok: true, found: catalog.matchInstalled(await detect.allInstalled(), tracked) };
  }

  if (action === 'setRoot') {
    const p = String(body.path || '').trim();
    const cfg = readConfig();
    cfg.portableRoot = p;
    if (!Array.isArray(cfg.repos)) cfg.repos = [];
    saveConfigFile(cfg);
    return { ok: true };
  }

  if (action === 'remove') {
    const key = String(body.key || '');
    const cfg = readConfig();
    const before = (cfg.repos || []).length;
    cfg.repos = (cfg.repos || []).filter((r) => appKey(r) !== key);
    if (cfg.repos.length === before) return { ok: false, error: 'app not found' };
    saveConfigFile(cfg);
    delete status[key];
    return { ok: true };
  }

  if (action === 'edit') {
    // Replace the entry at `key` with the new owner/repo/type/prerelease (standalone's edit flow).
    const key = String(body.key || '');
    const owner = String(body.owner || '').trim();
    const repo = String(body.repo || '').trim();
    const type = body.type === 'portable' ? 'portable' : 'installer';
    if (!owner || !repo) return { ok: false, error: 'owner and repo are required' };
    const cfg = readConfig();
    const idx = (cfg.repos || []).findIndex((r) => appKey(r) === key);
    if (idx === -1) return { ok: false, error: 'app not found' };
    if (type === 'portable' && !cfg.portableRoot) return { ok: false, error: 'set the portable apps folder first (Settings)' };
    const entry = { owner, repo, type };
    if (body.prerelease) entry.prerelease = true;
    if (cfg.repos.some((r, i) => i !== idx && appKey(r) === appKey(entry))) {
      return { ok: false, error: `${owner}/${repo} (${type}) is already tracked` };
    }
    await github.getLatestRelease(owner, repo, { prerelease: !!body.prerelease }); // throws -> 500 with reason
    cfg.repos[idx] = entry;
    saveConfigFile(cfg);
    delete status[key];
    return { ok: true, key: appKey(entry) };
  }

  if (action === 'closeApp') {
    const key = String(body.key || '');
    const r = (readConfig().repos || []).find((x) => appKey(x) === key);
    if (!r) return { ok: false, error: 'app not found' };
    log(`dropin closeApp ${key} force=${!!body.force}`);
    const res = await detect.closeApp(r.process || r.repo, { force: !!body.force });
    return { ok: true, stillRunning: !!(res && res.stillRunning) };
  }

  if (action === 'openFolder') {
    const cfg = readConfig();
    const r = (cfg.repos || []).find((x) => appKey(x) === String(body.key || q.key || ''));
    const dir = r && portableDir(cfg, r);
    if (!dir) return { ok: false, error: 'no folder for this app' };
    require('electron').shell.openPath(dir);
    return { ok: true };
  }

  if (action === 'openRelease') {
    const m = /^([^/]+)\/([^#]+)#/.exec(String(q.key || ''));
    if (!m) return { ok: false, error: 'bad key' };
    require('electron').shell.openExternal(`https://github.com/${m[1]}/${m[2]}/releases/latest`);
    return { ok: true };
  }

  return { ok: false, error: 'unknown action' };
};

exports._shutdown = function () {
  if (lock) { try { state.releaseLock(lock); } catch {} lock = null; }
};
