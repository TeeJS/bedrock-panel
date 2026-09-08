'use strict';
// FileBridge drop-in backend — job store, scheduler, and run queue around sync.js.
// Runs in the Bedrock Panel host main process. Bridge contract: the page calls
// /app-api/<action> -> handle(action, {query, body}); runs are async, the page polls `status`.
//
// Jobs live in %APPDATA%\bedrock-panel\file-bridge\jobs.json — plain JSON, copy the file to
// another machine to move your jobs. Structural edits back the file up first; the
// per-run lastRun bookkeeping writes without backups so scheduled runs don't pile up .baks.
//
// Scheduling: the manifest's "serverAutoStart": true makes the host load this module at
// startup, so cron schedules arm without the page being opened. On hosts predating that
// flag, the module loads on the first /app-api call instead and "run if missed" catches
// up anything that came due in the gap.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const sync = require('./sync');
const web = require('./web');
const drive = require('./drive');

// The host hands ctx.oauth (bound to THIS app's `app:file-bridge` provider) with every
// handle() call — but never at autostart, so a scheduled Drive-API run on a cold host
// needs one page visit first. Captured closures stay valid for the process lifetime.
// (HANDOFF-server-boot-context.md asks the host to pass a context once at autostart.)
let hostOauth = null;
const driveToken = async () => {
  if (!hostOauth) return null;
  const t = await hostOauth.getAccessToken(drive.SCOPES);
  return (t && t.accessToken) || null;
};

// Destination free/total bytes for the live disk bar. Walks up to the drive/share root the
// dest lives on (the dest folder itself may not exist yet). Best-effort — null on failure.
async function diskInfo(p) {
  let dir = path.resolve(p);
  for (let i = 0; i < 40 && dir; i++) {
    try {
      const s = await fsp.statfs(dir);
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Bedrock Panel 0.9.2 renamed the host's %APPDATA% folder from Bedrock Panel to bedrock-panel and moved it (this
// folder rode along). Use the new location; fall back to the old one only while the host is still pre-rename.
const DATA_DIR = (() => {
  const base = process.env.APPDATA || os.homedir();
  const next = path.join(base, 'bedrock-panel', 'file-bridge'), legacy = path.join(base, 'Bedrock Panel', 'file-bridge');
  return (!fs.existsSync(next) && fs.existsSync(legacy)) ? legacy : next;
})();
const JOBS_PATH = path.join(DATA_DIR, 'jobs.json');
const FILTERS_PATH = path.join(DATA_DIR, 'filters.json');
const RULES_DIR = path.join(DATA_DIR, 'rules');
const LOG_PATH = path.join(DATA_DIR, 'log.txt');

// ── web-job rules — USER-supplied per-site instruction files. The app ships none:
//    a web job is a pasted URL, and the URL's hostname picks the matching rule file. ──
function loadRules() {
  fs.mkdirSync(RULES_DIR, { recursive: true });
  const out = {};
  for (const f of fs.readdirSync(RULES_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(RULES_DIR, f), 'utf8'));
      if (!web.validateRule(r)) out[r.site] = r;
    } catch {}
  }
  return out;
}
const loginWins = {}; // site -> visible sign-in BrowserWindow
function openLogin(rule, url) {
  const { BrowserWindow } = require('electron');
  if (loginWins[rule.site] && !loginWins[rule.site].isDestroyed()) { loginWins[rule.site].focus(); return; }
  const win = new BrowserWindow({
    width: 1100, height: 850, autoHideMenuBar: true, title: 'Sign in — ' + (rule.name || rule.site),
    webPreferences: { partition: 'persist:webdrops-' + rule.site, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.on('closed', () => { delete loginWins[rule.site]; });
  win.loadURL((rule.auth && rule.auth.loginUrl) || url);
  loginWins[rule.site] = win;
}
async function sessionInfo(rule, url) {
  // Cookie presence is a cheap signed-in approximation for the UI; runs are the truth.
  try {
    const { session } = require('electron');
    const ses = session.fromPartition('persist:webdrops-' + rule.site);
    const cookies = await ses.cookies.get({});
    const host = new URL(url).hostname.split('.').slice(-2).join('.');
    return { site: rule.site, name: rule.name || rule.site, cookies: cookies.filter(c => (c.domain || '').includes(host)).length };
  } catch { return { site: rule.site, name: rule.name || rule.site, cookies: 0 }; }
}

// Reusable filter groups (Karen parity): named wildcard sets a job can insert into its
// Copy-only / Skip lists. Seeded on first use with common types — these are our own
// extension lists, plain facts, not copied from Karen's FileFilters.txt.
const DEFAULT_FILTERS = [
  { id: 'images', name: 'Common image files', wildcards: ['*.jpg', '*.jpeg', '*.png', '*.gif', '*.bmp', '*.tif', '*.tiff', '*.webp', '*.heic', '*.raw', '*.cr2', '*.nef'] },
  { id: 'audio', name: 'Common audio files', wildcards: ['*.mp3', '*.wav', '*.flac', '*.aac', '*.ogg', '*.m4a', '*.wma'] },
  { id: 'video', name: 'Common video files', wildcards: ['*.mp4', '*.mkv', '*.avi', '*.mov', '*.wmv', '*.m4v', '*.webm'] },
  { id: 'documents', name: 'Common document files', wildcards: ['*.doc', '*.docx', '*.xls', '*.xlsx', '*.ppt', '*.pptx', '*.pdf', '*.txt', '*.rtf', '*.odt', '*.csv'] },
  { id: 'web', name: 'Web files', wildcards: ['*.html', '*.htm', '*.css', '*.js', '*.json', '*.xml'] },
  { id: 'executables', name: 'Executable files', wildcards: ['*.exe', '*.dll', '*.msi', '*.bat', '*.cmd', '*.com'] },
  { id: 'temporary', name: 'Temporary files', wildcards: ['*.tmp', '*.temp', '~*', '*.bak', 'thumbs.db', 'desktop.ini'] },
];
function loadFilters() {
  try { const f = JSON.parse(fs.readFileSync(FILTERS_PATH, 'utf8')); if (Array.isArray(f.groups)) return f; } catch {}
  return { groups: DEFAULT_FILTERS.map(g => ({ ...g })) };
}
function saveFilters(f) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILTERS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2));
  fs.renameSync(tmp, FILTERS_PATH);
}
// Merge a job's LITERAL patterns with its referenced groups (live) and every "global
// exclusion" group into the effective include/exclude the engine sees. Resolved fresh every
// run — never persisted — so editing a group (or its global flag) updates all jobs at once.
// Folder + Drive jobs only; web jobs don't use file/folder globs.
function resolveFilters(job) {
  const groups = (loadFilters().groups || []).filter(g => g && typeof g === 'object' && g.id); // tolerate a malformed filters.json
  const byId = new Map(groups.map(g => [g.id, g]));
  // A job's own include/exclude may be a STRING (jobs.json is hand-editable and compileGlobs
  // splits strings on ';') — normalize before spreading, or a string would explode into
  // per-character globs (incl. '*' = match everything). Same tolerance compileGlobs applies.
  const asList = v => Array.isArray(v) ? v : String(v || '').split(';');
  const dedup = arr => [...new Set(arr.map(s => String(s).trim()).filter(Boolean))];
  // A global group is skip-only — never let it feed an INCLUDE list, or its patterns land in
  // both include and exclude (exclude wins) and the job would copy nothing.
  const fromIds = (ids, allowGlobal) => (Array.isArray(ids) ? ids : []).flatMap(id => {
    const g = byId.get(id);
    return g && (allowGlobal || !g.global) ? (g.wildcards || []) : [];
  });
  const globalWc = groups.filter(g => g.global).flatMap(g => g.wildcards || []);
  job.include = dedup([...asList(job.include), ...fromIds(job.includeGroups, false)]);
  job.exclude = dedup([...asList(job.exclude), ...fromIds(job.excludeGroups, true), ...globalWc]);
  return job;
}
const MISSED_GRACE_MS = 15 * 60000; // without "run if missed", a run this late still counts as on-time

// ── config file ───────────────────────────────────────────────────────────────
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8')); }
  catch { return { jobs: [] }; }
}
// Same backup + tmp-rename pattern as git-updater. backup=true only for structural changes.
function saveCfg(cfg, backup) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (backup && fs.existsSync(JOBS_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(JOBS_PATH, `${JOBS_PATH}.${stamp}.bak`);
  }
  const tmp = `${JOBS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, JOBS_PATH);
}

// ── persisted run results (full detail per job, survives restarts/updates) ────
const resultPath = id => path.join(DATA_DIR, 'result-' + String(id).replace(/[^a-z0-9]/gi, '') + '.json');
function saveResult(id, summary) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = resultPath(id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(summary));
    fs.renameSync(tmp, resultPath(id));
  } catch {} // best-effort — the in-memory copy still serves this session
}

// ── log (rolling file + in-memory tail for the UI) ────────────────────────────
const logTail = [];
function logLine(text) {
  const line = `[${new Date().toLocaleString()}] ${text}`;
  logTail.push(line);
  if (logTail.length > 500) logTail.splice(0, logTail.length - 500);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // ponytail: unbounded append; rotate at 2 MB by truncating to the tail
    try { if (fs.statSync(LOG_PATH).size > 2 * 1024 * 1024) fs.writeFileSync(LOG_PATH, logTail.join('\n') + '\n'); } catch {}
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {}
}
// Per-file detail goes to the FILE ONLY (not the in-memory tail the Activity view shows) — a
// 7000-file run would otherwise flood the view and push the run summaries out. Batched: one
// append, not one per line. Full detail lives in log.txt (Open config folder).
function logToFile(lines) {
  if (!lines || !lines.length) return;
  const now = new Date().toLocaleString();
  const body = lines.map(t => `[${now}] ${t}`).join('\n') + '\n';
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try { if (fs.statSync(LOG_PATH).size > 2 * 1024 * 1024) fs.writeFileSync(LOG_PATH, logTail.join('\n') + '\n'); } catch {}
    fs.appendFileSync(LOG_PATH, body);
  } catch {}
}
// Which categories get PER-FILE log entries. Defaults keep the log lean; the user opts into
// the noisy ones (copies / up-to-date / exclusions) for a detailed audit.
const DEFAULT_LOG_CATS = { summary: true, errors: true, warnings: true, deletions: true, skips: false, copies: false, uptodate: false, exclusions: false };
function logCats(cfg) { return { ...DEFAULT_LOG_CATS, ...(((cfg || loadCfg()).logCats) || {}) }; }
// Write the per-file entries for a finished REAL run, gated by the enabled categories.
function logRunEntries(name, summary, plan, cats) {
  const lines = [];
  const push = (tag, rel, extra) => lines.push(`  ${tag}  ${rel}${extra ? '  — ' + extra : ''}`);
  if (cats.copies) for (const a of summary.actions || []) if (a.op === 'copy') push('COPIED', a.rel);
  if (cats.deletions) for (const a of summary.actions || []) if (a.op === 'del' || a.op === 'deldir') push('DELETED', a.rel);
  if (cats.uptodate) for (const rel of (plan.unchangedList || [])) push('UP-TO-DATE', rel);
  if (cats.exclusions) for (const rel of (plan.filteredList || [])) push('EXCLUDED', rel);
  if (cats.skips) for (const s of (summary.skipped || [])) push('SKIPPED', s.path, s.note);
  if (cats.warnings) for (const w of (summary.warnings || [])) push('WARN', w.path, w.warn);
  if (cats.errors) for (const e of (summary.errors || [])) push('ERROR', e.path, e.error);
  if (lines.length) {
    logToFile([`─── ${name}: ${summary.copied} copied, ${summary.deleted} deleted, ${summary.warningCount || 0} warnings, ${summary.errorCount || 0} errors ───`].concat(lines));
  }
}

// ── run queue: one job at a time ──────────────────────────────────────────────
let jobWin = null;       // the pop-out job-manager window (single instance)
let current = null;      // { id, name, dryRun, trigger, phase, progress, startedAt }
const queue = [];        // [{ id, dryRun, trigger }]
const lastResults = {};  // id -> summary of last run/preview (in-memory; full action list)
let stopFlag = false;
// Per-run pause (Karen's "Resume Job"): suspends the ACTIVE run in place and continues from the
// exact same spot on resume — distinct from Stop (cancels the run) and cfg.paused (blocks the
// scheduler). The engine loops await waitIfPaused() between files; "pause now" also aborts the
// in-flight Drive download (shouldPauseNow) and the loop redoes that one file after resume.
let runPaused = false;   // pause requested / in effect for the current run
let pauseNow = false;    // "pause now" — abort the in-flight file rather than finish it first
let pauseWaiters = [];   // resolve fns for engine loops parked in waitIfPaused()
function waitIfPaused() {
  if (!runPaused) return Promise.resolve();
  if (current) current.pausedActive = true; // actually parked now (vs still finishing the current file)
  return new Promise(resolve => pauseWaiters.push(resolve));
}
function wakePauseWaiters() { const ws = pauseWaiters; pauseWaiters = []; for (const r of ws) r(); }
function clearPause() { runPaused = false; pauseNow = false; wakePauseWaiters(); }
// pump() claims `current` only AFTER an await (drive.folderName) in the Drive-API branch, so a
// re-entrant pump() during that window could start a SECOND concurrent run. This synchronous latch
// claims the run slot the moment pump() commits to a job, closing that race.
let pumpStarting = false;

const busy = id => (current && current.id === id) || queue.some(q => q.id === id);

function enqueue(id, dryRun, trigger) {
  if (busy(id)) return { ok: false, error: 'this job is already running or queued' };
  queue.push({ id, dryRun: !!dryRun, trigger });
  pump();
  return { ok: true };
}

async function pump() {
  if (current || pumpStarting || !queue.length) return;
  const next = queue.shift();
  const cfg = loadCfg();
  const stored = (cfg.jobs || []).find(j => j.id === next.id);
  if (!stored) { pump(); return; } // skip path re-pumps BEFORE claiming the slot — keep the latch off here
  pumpStarting = true; // slot claimed synchronously; released in failRun and in the run's finally
  stopFlag = false;
  runPaused = false; pauseNow = false; pauseWaiters = []; // fresh run starts un-paused
  // Refuse this run with a clear fatal result. Also records lastRun (for real runs), or
  // the scheduler would see the job still due and retry (and beep) every 30 seconds.
  const failRun = msg => {
    pumpStarting = false; // release the slot before re-pumping the queue
    lastResults[stored.id] = { at: new Date().toISOString(), ms: 0, ok: false, dryRun: next.dryRun, trigger: next.trigger, fatal: msg, errors: [], errorCount: 1, actions: [], kind: stored.kind === 'web' ? 'web' : undefined, webDownloaded: [], wouldDownload: [], skippedSeen: 0, collectionsVisited: 0, bytes: 0 };
    saveResult(stored.id, lastResults[stored.id]);
    logLine(`${next.dryRun ? 'preview' : 'run'} ${stored.name} (${next.trigger}): FAILED — ${msg}`);
    if (!next.dryRun) {
      const fresh = loadCfg();
      const j = (fresh.jobs || []).find(x => x.id === stored.id);
      if (j) {
        j.lastRun = { at: new Date().toISOString(), ok: false, copied: 0, deleted: 0, errors: 1, ms: 0 };
        delete j.lastSkippedDue;
        saveCfg(fresh, false);
      }
    }
    pump();
  };
  // Resolve each side once per run against ONE clock read: a Google Drive folder link
  // becomes its local-mount path, anything else gets its <date> tokens expanded — so the
  // whole run (scan, copy, mirror, disk bar, live paths) sees one consistent pair.
  const when = new Date();
  let job;
  if (stored.kind === 'web') {
    job = { ...stored, dest: sync.expandTokens(stored.dest, when) };
    const werr = web.validateWebJob(job, loadRules());
    if (werr) {
      failRun('invalid at run time: ' + werr);
      return;
    }
  } else if (stored.driveApi) {
    // Drive-API job: the source STAYS the Drive link (read remotely through the API —
    // no mount involved, and the mount's hidden-files quirk can't bite); dest resolves
    // locally like any folder job.
    const folderId = sync.parseDriveLink(stored.source);
    if (!folderId) { failRun('Drive API mode needs a Google Drive folder link as the source'); return; }
    if (!hostOauth) { failRun('the Google Drive connection is not available yet — open the FileBridge page once after a host restart, then run again'); return; }
    try {
      job = { ...stored, folderId, dest: sync.expandTokens(stored.dest, when) };
      if (sync.parseDriveLink(stored.dest)) throw new Error('Drive API mode reads the source — the destination must be a local folder');
      if (!path.isAbsolute(job.dest)) throw new Error('destination must be an absolute path');
      if (stored.subfolderFromSource) {
        // The subfolder name comes from the REMOTE folder's own title — works even
        // when the folder was never synced to the local mount.
        const base = await drive.folderName({ getToken: driveToken }, folderId);
        if (base) job.dest = path.join(job.dest, base);
      }
    } catch (e) {
      failRun(e.message);
      return;
    }
  } else {
    try {
      const field = v => sync.parseDriveLink(v) ? sync.resolveDriveLink(v) : sync.expandTokens(v, when);
      job = { ...stored, source: field(stored.source), dest: field(stored.dest) };
      // "Copy into a subfolder named after the source folder": paste next month's Drive link
      // and the matching dest subfolder appears by itself (created on first copy).
      if (stored.subfolderFromSource) {
        const base = path.basename(job.source);
        if (base) job.dest = path.join(job.dest, base);
      }
    } catch (e) {
      failRun(e.message);
      return;
    }
    // Re-validate the RESOLVED paths: tokens or link resolution can make source/dest collide
    // or nest in ways the save-time check (which sees the raw values) cannot foresee.
    const verr = sync.validateJob(job);
    if (verr) {
      failRun('invalid at run time: ' + verr);
      return;
    }
  }
  // Fold referenced + global filter groups into job.include/exclude (folder + Drive only).
  // Guarded: a filter-resolution failure becomes a clean per-job failure, never an escaped
  // rejection that would jam the queue and retry every tick.
  if (stored.kind !== 'web') { try { resolveFilters(job); } catch (e) { failRun('filter groups could not be resolved: ' + e.message); return; } }
  current = { id: job.id, name: job.name, kind: stored.kind === 'web' ? 'web' : 'folder', source: stored.kind === 'web' ? job.url : job.source, dest: job.dest, dryRun: next.dryRun, trigger: next.trigger, phase: 'scan', progress: {}, tally: { copy: 0, same: 0, filtered: 0 }, paused: false, pausedActive: false, pauseMode: null, disk: null, startedAt: Date.now() };
  const t0 = Date.now();
  diskInfo(job.dest).then(d => { if (current && current.id === job.id) current.disk = d; }); // async — non-blocking
  // Live free space: refresh the destination's free/total every few seconds so a long run's
  // disk bar tracks reality instead of the value captured at start.
  const diskTimer = setInterval(() => { diskInfo(job.dest).then(d => { if (current && current.id === job.id) current.disk = d; }); }, 4000);
  // Recycle Bin support for the engine: only Electron's shell can move a path to the Recycle
  // Bin. Resolves true on success, false on any failure (e.g. no Recycle Bin on a network share).
  const trash = async p => {
    try { await require('electron').shell.trashItem(p); return true; }
    catch { return false; }
  };
  // Follow-shortcuts support: only the Windows shell (COM, in-process via Electron) can
  // resolve a .lnk — Drive placeholder .lnk files fail raw reads with EINVAL, yet the
  // shell resolves them fine. Null on any failure; the engine reports it per entry.
  const resolveShortcut = async p => {
    try { return require('electron').shell.readShortcutLink(p).target || null; }
    catch { return null; }
  };
  const opts = {
    resolveShortcut,
    shouldStop: () => stopFlag,
    waitIfPaused,                       // engine loops park here between files while paused
    shouldPauseNow: () => pauseNow,     // "pause now" — abort the in-flight Drive download
    onProgress: p => {
      if (!current) return;
      // Running scan tally (up-to-date · copy · filtered, climbing live). Count each file's
      // verdict ONCE — off the op the event ARRIVED with, before the sticky carry-forward
      // below re-stamps blank "examining" events with the previous verdict (which would
      // otherwise count every file many times over).
      const arrivedOp = p.op;
      if (p.phase === 'scan' && arrivedOp && current.tally) {
        if (arrivedOp === 'copy') current.tally.copy++;
        else if (arrivedOp === 'same') current.tally.same++;
        else if (arrivedOp === 'filtered') current.tally.filtered++;
      }
      // The scan emits "examining" (no verdict) then the verdict, and the next file's
      // "examining" follows within microseconds — a 1 s status snapshot would almost
      // always catch the blank instant and the verdict chip would never be seen.
      // Carry the last decided verdict forward so the chip reads as a rolling
      // status band (Karen-style) until the next decision replaces it.
      const prev = current.progress;
      if (p.phase === 'scan' && !p.op && prev && prev.phase === 'scan' && prev.op) {
        p.op = prev.op; p.reason = prev.reason;
      }
      current.phase = p.phase;
      current.progress = p;
    },
    trash,
  };
  // The whole run body sits under one finally so no throw — including in the post-run
  // bookkeeping (saveCfg can fail on a locked jobs.json) — can leave `current` stuck
  // and the queue jammed forever.
  try {
  let summary;
  let plan = null, cats = null; // hoisted: the per-file log is written AFTER the summary line (below)
  try {
    if (job.kind === 'web') {
      const rule = web.findRule(job.url, loadRules());
      if (!rule) throw new Error('no rule file matches ' + job.url + ' — add one under Rules');
      job.site = rule.site; // partition + display identity comes from the matched rule
      const w = await web.runWebJob(job, rule, {
        dataDir: DATA_DIR, dryRun: next.dryRun, log: logLine,
        setPhase: (phase, detail) => { if (current) { current.phase = 'web'; current.progress = { phase: 'web', webPhase: phase, detail: detail || '' }; } },
        setCounts: c => { if (current) current.webCounts = c; },
        shouldStop: () => stopFlag,
      });
      // Shaped like a folder summary so the band, rows, stats, and grand totals all work:
      // copied = files downloaded, bytes = bytes fetched. Web extras ride alongside.
      summary = {
        at: new Date().toISOString(), ms: Date.now() - t0,
        ok: !w.fatal && !w.errors.length && !stopFlag,
        dryRun: next.dryRun, trigger: next.trigger, stopped: stopFlag, kind: 'web',
        source: job.url, dest: job.dest,
        scanned: 0, unchanged: 0, filtered: 0, mirrorProtected: 0,
        foldersScanned: 0, foldersCreated: 0, foldersDeleted: 0,
        planCopies: w.wouldDownload.length, planDeletes: 0, totalBytes: w.bytes,
        copied: w.downloaded.length, deleted: 0, recycled: 0, bytes: w.bytes,
        skippedSeen: w.skippedSeen, collectionsVisited: w.collectionsVisited,
        needsLogin: !!w.needsLogin, fatal: w.fatal,
        webDownloaded: w.downloaded, wouldDownload: w.wouldDownload,
        errors: w.errors.map(x => ({ path: x.item, error: x.error })),
        errorCount: w.errors.length + (w.fatal ? 1 : 0),
        skipped: [], skippedCount: 0,
        actions: [],
      };
      lastResults[job.id] = summary;
      saveResult(job.id, summary);
      if (w.fatal || logCats().summary)
        logLine(`${next.dryRun ? 'preview' : 'run'} ${job.name} (${next.trigger}): ` + (w.fatal ? `FAILED — ${w.fatal}`
          : next.dryRun ? `would download ${w.wouldDownload.length} (${w.skippedSeen} already seen)`
            : `downloaded ${w.downloaded.length}, ${w.skippedSeen} already seen${summary.errorCount ? `, ${summary.errorCount} ERRORS` : ''}${stopFlag ? ' — STOPPED' : ''}`));
      if (!next.dryRun) {
        const fresh = loadCfg();
        const j = (fresh.jobs || []).find(x => x.id === job.id);
        if (j) {
          j.lastRun = { at: summary.at, ok: summary.ok, copied: summary.copied, deleted: 0, errors: summary.errorCount, needsLogin: summary.needsLogin, ms: summary.ms };
          delete j.lastSkippedDue;
          const s = j.stats || (j.stats = { since: summary.at, runs: 0, ms: 0, bytes: 0, copied: 0, deleted: 0, recycled: 0, scanned: 0, unchanged: 0, filtered: 0, errors: 0 });
          s.runs += 1; s.ms += summary.ms; s.bytes += summary.bytes || 0; s.copied += summary.copied || 0; s.errors += summary.errorCount || 0;
        }
        const g = fresh.grand || (fresh.grand = { since: summary.at, runs: 0, ms: 0, bytes: 0, copied: 0, deleted: 0, recycled: 0, errors: 0 });
        g.runs += 1; g.ms += summary.ms; g.bytes += summary.bytes || 0; g.copied += summary.copied || 0; g.errors += summary.errorCount || 0;
        saveCfg(fresh, false);
      }
      return; // the shared finally below clears `current` and pumps the queue
    }
    // Collect the up-to-date / exclusion lists only when a real run will log those categories
    // (they can be big on a huge tree), so plan doesn't hold them for nothing.
    cats = logCats();
    opts.collectUnchanged = !next.dryRun && cats.uptodate;
    opts.collectFiltered = !next.dryRun && cats.exclusions;
    const dopts = stored.driveApi
      ? { getToken: driveToken, onProgress: opts.onProgress, shouldStop: opts.shouldStop, waitIfPaused: opts.waitIfPaused, shouldPauseNow: opts.shouldPauseNow, trash, collectUnchanged: opts.collectUnchanged, collectFiltered: opts.collectFiltered }
      : null;
    plan = stored.driveApi ? await drive.planDrive(job, dopts) : await sync.plan(job, opts);
    const copies = plan.actions.filter(a => a.op === 'copy').length;
    const deletes = plan.actions.length - copies;
    let exec = { copied: 0, deleted: 0, bytes: 0, recycled: 0, foldersCreated: 0, foldersDeleted: 0, errors: [], skipped: [], stopped: stopFlag };
    if (!next.dryRun && !stopFlag) {
      current.phase = 'run';
      current.totalBytes = plan.totalBytes; // denominator for the byte-based progress bar
      exec = stored.driveApi ? await drive.executeDrive(job, plan.actions, dopts) : await sync.execute(job, plan.actions, { ...opts, folderMeta: plan.folderMeta });
    }
    if (plan.mirrorSkipped) logLine(`WARNING ${job.name}: ${plan.mirrorSkipped}`);
    summary = {
      at: new Date().toISOString(), ms: Date.now() - t0, ok: !exec.stopped && !plan.errors.length && !exec.errors.length,
      dryRun: next.dryRun, trigger: next.trigger, stopped: exec.stopped, mirrorSkipped: plan.mirrorSkipped,
      source: job.source, dest: job.dest, // token-expanded — what the run actually used
      scanned: plan.scanned, unchanged: plan.unchanged, filtered: plan.filtered, mirrorProtected: plan.mirrorProtected,
      foldersScanned: plan.foldersScanned, foldersCreated: exec.foldersCreated, foldersDeleted: exec.foldersDeleted,
      planCopies: copies, planDeletes: deletes, totalBytes: plan.totalBytes,
      copied: exec.copied, deleted: exec.deleted, recycled: exec.recycled, bytes: exec.bytes,
      errors: plan.errors.concat(exec.errors),
      errorCount: plan.errors.length + exec.errors.length,
      // Warnings are non-fatal (e.g. copied fine but couldn't set the timestamp) — tracked
      // separately so a run isn't marked FAILED over a cosmetic hiccup. ok already excludes
      // them (they're not in errors).
      warnings: exec.warnings || [],
      warningCount: (exec.warnings || []).length,
      // Drive-API natives (Google Docs etc.) surface as skips on preview AND run —
      // parity with the mount's placeholder-skip behavior.
      skipped: (exec.skipped || []).concat(plan.nativeSkipped || []),
      skippedCount: (exec.skipped || []).length + (plan.nativeSkipped || []).length,
      // Full action list, uncapped — a preview must show EXACTLY what a real run would touch,
      // no arbitrary truncation. ponytail: held whole in memory (~100 B/entry); a multi-million
      // -file job could cost real RAM — page it out to a temp file if that ever bites.
      // reason = WHY each file is copied (new file / source newer / time differs / size differs /
      // content differs) — surfaced per row in the result detail so a copy always explains itself.
      actions: plan.actions.map(a => ({ op: a.op, rel: a.rel, size: a.size, reason: a.reason })),
    };
  } catch (e) {
    summary = { at: new Date().toISOString(), ms: Date.now() - t0, ok: false, dryRun: next.dryRun, trigger: next.trigger, fatal: e.message, errors: [], errorCount: 1, actions: [], kind: stored.kind === 'web' ? 'web' : undefined, webDownloaded: [], wouldDownload: [], skippedSeen: 0, collectionsVisited: 0, bytes: 0 };
  }
  lastResults[job.id] = summary;
  saveResult(job.id, summary);
  const what = next.dryRun ? 'preview' : 'run';
  // The run-summary line is gated by the 'summary' category (a FAILED run is always logged).
  if (summary.fatal || logCats().summary)
    logLine(`${what} ${job.name} (${next.trigger}): ` + (summary.fatal ? `FAILED — ${summary.fatal}`
      : next.dryRun ? `would copy ${summary.planCopies}, delete ${summary.planDeletes}${summary.errorCount ? `, ${summary.errorCount} errors` : ''}`
        : `copied ${summary.copied}, ${summary.recycled ? `recycled ${summary.recycled}, ` : ''}deleted ${summary.deleted}, unchanged ${summary.unchanged}${summary.skippedCount ? `, ${summary.skippedCount} placeholders skipped` : ''}${summary.warningCount ? `, ${summary.warningCount} warnings` : ''}${summary.errorCount ? `, ${summary.errorCount} ERRORS` : ''}${summary.stopped ? ' — STOPPED' : ''}`));
  // Per-file detail LAST — after the summary line — so a big batch that trips the summary
  // line's rotation-to-tail can't truncate away the detail written this same run.
  if (!next.dryRun && !summary.fatal && plan) { try { logRunEntries(job.name, summary, plan, cats); } catch {} }
  if (!next.dryRun) {
    const fresh = loadCfg(); // reload — the user may have edited other jobs mid-run
    const j = (fresh.jobs || []).find(x => x.id === job.id);
    if (j) {
      j.lastRun = { at: summary.at, ok: summary.ok, copied: summary.copied, deleted: summary.deleted, errors: summary.errorCount, warnings: summary.warningCount || 0, ms: summary.ms };
      delete j.lastSkippedDue;
      // Lifetime accumulators (Karen's History): every real run adds to the per-job totals.
      const s = j.stats || (j.stats = { since: summary.at, runs: 0, ms: 0, bytes: 0, copied: 0, deleted: 0, recycled: 0, scanned: 0, unchanged: 0, filtered: 0, errors: 0 });
      s.runs += 1; s.ms += summary.ms;
      s.bytes += summary.bytes || 0; s.copied += summary.copied || 0;
      s.deleted += summary.deleted || 0; s.recycled += summary.recycled || 0;
      s.scanned += summary.scanned || 0; s.unchanged += summary.unchanged || 0;
      s.filtered += summary.filtered || 0; s.errors += summary.errorCount || 0;
      s.foldersScanned = (s.foldersScanned || 0) + (summary.foldersScanned || 0);
      s.foldersCreated = (s.foldersCreated || 0) + (summary.foldersCreated || 0);
      s.foldersDeleted = (s.foldersDeleted || 0) + (summary.foldersDeleted || 0);
    }
    // Grand totals (Karen's Grand Totals): app-wide, across every job, persisted.
    const g = fresh.grand || (fresh.grand = { since: summary.at, runs: 0, ms: 0, bytes: 0, copied: 0, deleted: 0, recycled: 0, errors: 0 });
    g.runs += 1; g.ms += summary.ms;
    g.bytes += summary.bytes || 0; g.copied += summary.copied || 0;
    g.deleted += summary.deleted || 0; g.recycled += summary.recycled || 0;
    g.errors += summary.errorCount || 0;
    g.foldersCreated = (g.foldersCreated || 0) + (summary.foldersCreated || 0);
    g.foldersDeleted = (g.foldersDeleted || 0) + (summary.foldersDeleted || 0);
    saveCfg(fresh, false);
  }
  } finally {
    clearInterval(diskTimer);
    current = null;
    pumpStarting = false; // release the run slot so the next queued job can start
    clearPause(); // never let a pause flag linger past the run it belonged to
    pump();
  }
}

// ── scheduler ─────────────────────────────────────────────────────────────────
// Anchor for "next due": the latest of last real run, schedule save time, and the last
// deliberately skipped occurrence — so a missed slot fires once (run-if-missed) or is
// skipped once (not re-litigated every tick).
function anchor(j) {
  return Math.max(
    (j.lastRun && Date.parse(j.lastRun.at)) || 0,
    (j.schedule && j.schedule.since) || 0,
    j.lastSkippedDue || 0);
}
function nextDue(j) { return j.enabled === false ? null : sync.nextOccurrence(j.schedule, anchor(j)); }

function tick() {
  let cfg;
  try { cfg = loadCfg(); } catch { return; }
  if (cfg.paused) return; // scheduler paused globally — manual runs still work (they don't go through tick)
  const now = Date.now();
  for (const j of cfg.jobs || []) {
    if (j.enabled === false || busy(j.id)) continue;
    const due = nextDue(j);
    if (!due || due > now) continue;
    if (j.runIfMissed === false && now - due > MISSED_GRACE_MS) {
      j.lastSkippedDue = due;
      saveCfg(cfg, false);
      logLine(`skipped missed run: ${j.name} (was due ${new Date(due).toLocaleString()})`);
      continue;
    }
    logLine(`schedule due: ${j.name}`);
    enqueue(j.id, false, 'schedule');
  }
}
const timer = setInterval(tick, 30000);
setTimeout(tick, 3000); // catch up promptly once the module loads

// ── API ───────────────────────────────────────────────────────────────────────
exports.handle = async function handle(action, ctx) {
  const body = ctx && ctx.body ? JSON.parse(ctx.body.toString('utf8') || '{}') : {};
  if (ctx && ctx.oauth) hostOauth = ctx.oauth; // captured for scheduled Drive-API runs

  if (action === 'list') {
    const cfg = loadCfg();
    const rules = loadRules();
    // Session chips for the sites the user's WEB JOBS actually touch (rule matched by URL).
    const sessions = [];
    const seenSites = new Set();
    for (const j of cfg.jobs || []) {
      if (j.kind !== 'web') continue;
      const r = web.findRule(j.url, rules);
      if (r && !seenSites.has(r.site)) { seenSites.add(r.site); sessions.push(await sessionInfo(r, j.url)); }
    }
    const jobs = (cfg.jobs || []).map(j => {
      if (j.kind === 'web') return { ...j, nextRunAt: nextDue(j) };
      const out = { ...j, nextRunAt: nextDue(j) };
      // Display-only: show where a Drive link currently lands (best-effort, null on
      // failure). A Drive-API job reads the link REMOTELY — resolving it through the
      // mount here would show a wrong/missing path for exactly the folders that made
      // the user pick API mode, so it just labels itself instead.
      if (j.driveApi) out.resolvedSource = '(read via the Drive API)';
      else { try { if (sync.parseDriveLink(j.source)) out.resolvedSource = sync.resolveDriveLink(j.source); } catch {} }
      try { if (sync.parseDriveLink(j.dest)) out.resolvedDest = sync.resolveDriveLink(j.dest); } catch {}
      if (j.subfolderFromSource && !j.driveApi) {
        try {
          const srcPath = sync.parseDriveLink(j.source) ? out.resolvedSource : sync.expandTokens(j.source);
          const base = srcPath ? path.basename(srcPath) : '';
          if (base) out.resolvedDest = path.join(out.resolvedDest !== undefined ? out.resolvedDest : sync.expandTokens(j.dest), base);
        } catch {}
      }
      return out;
    });
    // Google Drive connection chip: shown whenever any folder job uses the Drive API
    // (or so the user can set it up). status() is host-side and cheap.
    let driveInfo = { available: false, configured: false, connected: false };
    try { if (hostOauth) driveInfo = { available: true, ...(await hostOauth.status()) }; } catch {}
    return {
      ok: true, jobs, grand: cfg.grand || null, dataDir: DATA_DIR, current, queue: queue.map(q => q.id),
      rules: Object.values(rules).map(r => ({ site: r.site, name: r.name || r.site, match: r.match })),
      sessions, lastResults: slim(), drive: driveInfo, paused: !!cfg.paused, logCats: logCats(cfg),
    };
  }

  // Configure which categories get per-file log entries, and clear the log file.
  if (action === 'setLogCats') {
    const cfg = loadCfg();
    cfg.logCats = { ...DEFAULT_LOG_CATS, ...(cfg.logCats || {}), ...(body.cats || {}) };
    saveCfg(cfg, false);
    return { ok: true, logCats: logCats(cfg) };
  }
  if (action === 'eraseLog') {
    try { fs.writeFileSync(LOG_PATH, ''); } catch (e) { return { ok: false, error: e.message }; }
    logTail.length = 0;
    logLine('log erased');
    return { ok: true };
  }

  // Global scheduler pause: stop all scheduled runs (manual Run/Preview still work). Persisted,
  // so it survives a restart — the UI shows a clear "schedules paused" indicator.
  if (action === 'setPaused') {
    const cfg = loadCfg();
    cfg.paused = !!body.paused;
    saveCfg(cfg, false);
    logLine('schedules ' + (cfg.paused ? 'PAUSED' : 'resumed'));
    return { ok: true, paused: cfg.paused };
  }

  if (action === 'driveConnect') {
    if (!hostOauth) return { ok: false, error: 'the host OAuth bridge is not available' };
    const creds = String(body.clientId || '').trim()
      ? { clientId: String(body.clientId).trim(), clientSecret: String(body.clientSecret || '').trim() }
      : undefined;
    try { await hostOauth.connect(drive.SCOPES, creds); return { ok: true, opened: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  if (action === 'driveDisconnect') {
    if (!hostOauth) return { ok: false, error: 'the host OAuth bridge is not available' };
    try { await hostOauth.disconnect(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  if (action === 'status') { let paused = false; try { paused = !!loadCfg().paused; } catch {} return { ok: true, current, queue: queue.map(q => q.id), lastResults: slim(), log: logTail.slice(-120), paused }; }

  if (action === 'result') {
    const id = String(body.id || (ctx.query && ctx.query.id) || '');
    let r = lastResults[id];
    // Full details persist per job, so "View last result" survives app updates/restarts.
    if (!r) { try { r = JSON.parse(fs.readFileSync(resultPath(id), 'utf8')); } catch {} }
    return r ? { ok: true, result: r } : { ok: false, error: 'no result for this job yet' };
  }

  if (action === 'save') {
    const job = body.job || {};
    // Web jobs validate their own shape; the schedule is validated with the same code
    // either way (the scheduler is kind-agnostic). A DISABLED web job may be saved even
    // when no rule matches any more (rule file deleted) — disabling must always work.
    let err;
    if (job.kind === 'web') {
      err = web.validateWebJob(job, loadRules());
      if (err && job.enabled === false) err = null;
      if (!err) err = sync.validateJob({ name: 'x', source: 'C:\\x', dest: 'D:\\x', schedule: job.schedule || { type: 'manual' } });
      if (!err) {
        const rule = web.findRule(job.url, loadRules());
        if (rule) job.site = rule.site; // cache the matched rule's site id for sessions/partition
      }
    } else {
      err = sync.validateJob(job);
      if (!err && job.driveApi) {
        if (!sync.parseDriveLink(job.source)) err = 'Drive API mode needs a Google Drive folder link as the source';
        else if (sync.parseDriveLink(job.dest)) err = 'Drive API mode reads the source — the destination must be a local folder';
      }
    }
    if (err) return { ok: false, error: err };
    const cfg = loadCfg();
    cfg.jobs = cfg.jobs || [];
    delete job.nextRunAt; delete job.resolvedSource; delete job.resolvedDest; // display-only fields the page echoes back
    job.name = String(job.name).trim();
    if (job.kind === 'web') job.source = '';
    else job.source = String(job.source).trim();
    job.dest = String(job.dest).trim();
    const idx = cfg.jobs.findIndex(j => j.id === job.id);
    const old = idx >= 0 ? cfg.jobs[idx] : null;
    if (!job.id) job.id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    // Re-anchor the schedule when it changes, so "daily 03:00" saved at 14:00 doesn't fire instantly.
    const sc = job.schedule || { type: 'manual' };
    if (!old || JSON.stringify({ ...((old.schedule) || {}), since: 0 }) !== JSON.stringify({ ...sc, since: 0 })) sc.since = Date.now();
    else sc.since = (old.schedule && old.schedule.since) || Date.now();
    job.schedule = sc;
    // lastRun and the lifetime stats are SERVER-owned bookkeeping: always take the on-disk
    // values, never the client's echoed snapshot (which can be a poll old — or forged).
    if (old) {
      job.lastRun = old.lastRun; job.stats = old.stats;
      // Switching a web job to a folder job orphans its seen-ledger — clean it up.
      if (old.kind === 'web' && job.kind !== 'web') { try { fs.rmSync(web.seenPath(DATA_DIR, job.id), { force: true }); } catch {} }
      cfg.jobs[idx] = job;
    } else { delete job.lastRun; delete job.stats; cfg.jobs.push(job); }
    delete job.lastSkippedDue;
    if (busy(job.id)) return { ok: false, error: 'stop the running job before editing it' };
    saveCfg(cfg, true);
    logLine(`${old ? 'edited' : 'added'} job: ${job.name}`);
    return { ok: true, id: job.id };
  }

  if (action === 'remove') {
    const id = String(body.id || '');
    if (busy(id)) return { ok: false, error: 'stop the running job before deleting it' };
    const cfg = loadCfg();
    const j = (cfg.jobs || []).find(x => x.id === id);
    if (!j) return { ok: false, error: 'job not found' };
    cfg.jobs = cfg.jobs.filter(x => x.id !== id);
    saveCfg(cfg, true);
    delete lastResults[id];
    try { fs.rmSync(resultPath(id), { force: true }); } catch {}
    try { fs.rmSync(web.seenPath(DATA_DIR, id), { force: true }); } catch {} // ledger, if it ever was a web job
    logLine(`deleted job: ${j.name}`);
    return { ok: true };
  }

  if (action === 'duplicate') {
    const id = String(body.id || '');
    const cfg = loadCfg();
    const orig = (cfg.jobs || []).find(x => x.id === id);
    if (!orig) return { ok: false, error: 'job not found' };
    // Clone all settings; drop the server-owned bookkeeping so the copy starts fresh. A new
    // id means a web copy also gets a fresh seen-ledger (nothing at its seenPath yet).
    const copy = { ...orig };
    delete copy.lastRun; delete copy.stats; delete copy.lastSkippedDue;
    copy.id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    copy.name = orig.name + ' (copy)';
    copy.enabled = false; // never auto-run a duplicate until the user has reviewed it
    copy.schedule = { ...(orig.schedule || { type: 'manual' }), since: Date.now() }; // re-anchor
    cfg.jobs.push(copy);
    saveCfg(cfg, true);
    logLine(`duplicated job: ${orig.name} -> ${copy.name}`);
    return { ok: true, id: copy.id };
  }

  if (action === 'moveJob') {
    // Reorder in the stored list — the order drives Run-all and the same-tick scheduler sequence.
    const id = String(body.id || ''), dir = body.dir === 'up' ? -1 : 1;
    const cfg = loadCfg();
    const jobs = cfg.jobs || [];
    const i = jobs.findIndex(j => j.id === id);
    if (i < 0) return { ok: false, error: 'job not found' };
    const k = i + dir;
    if (k < 0 || k >= jobs.length) return { ok: true, unchanged: true }; // already at the end
    [jobs[i], jobs[k]] = [jobs[k], jobs[i]];
    saveCfg(cfg, true);
    return { ok: true };
  }

  // ── web jobs: sign-in windows, recipes, seen ledger ─────────────────────────
  if (action === 'openLogin') {
    const url = String(body.url || '');
    const r = web.findRule(url, loadRules());
    if (!r) return { ok: false, error: 'no rule file matches this URL' };
    openLogin(r, url);
    return { ok: true };
  }

  // Live rule-match feedback for the editor: which rule file handles this URL?
  if (action === 'resolveRule') {
    const r = web.findRule(String(body.url || ''), loadRules());
    return r ? { ok: true, site: r.site, name: r.name || r.site }
      : { ok: false, error: 'no rule file matches this URL — add one under Rules (match its hostname)' };
  }

  if (action === 'rules') {
    fs.mkdirSync(RULES_DIR, { recursive: true });
    const out = {};
    for (const f of fs.readdirSync(RULES_DIR)) {
      if (f.endsWith('.json')) { try { out[f.replace(/\.json$/, '')] = fs.readFileSync(path.join(RULES_DIR, f), 'utf8'); } catch {} }
    }
    return { ok: true, files: out };
  }

  if (action === 'removeRule') {
    const site = String(body.site || '');
    if (!/^[a-z0-9-]{2,40}$/.test(site)) return { ok: false, error: 'unknown rule' };
    const p = path.join(RULES_DIR, site + '.json');
    if (!fs.existsSync(p)) return { ok: false, error: 'rule file not found' };
    fs.rmSync(p, { force: true });
    logLine('deleted rule: ' + site);
    return { ok: true };
  }

  if (action === 'saveRule') {
    let parsed;
    try { parsed = JSON.parse(String(body.json || '')); }
    catch (e) { return { ok: false, error: 'not valid JSON: ' + e.message }; }
    const err = web.validateRule(parsed);
    if (err) return { ok: false, error: err };
    fs.mkdirSync(RULES_DIR, { recursive: true });
    fs.writeFileSync(path.join(RULES_DIR, parsed.site + '.json'), JSON.stringify(parsed, null, 2));
    logLine('saved rule: ' + parsed.site);
    return { ok: true, site: parsed.site };
  }

  if (action === 'resetLedger') {
    const id = String(body.id || '');
    if (busy(id)) return { ok: false, error: 'stop the running job first' };
    try { fs.rmSync(web.seenPath(DATA_DIR, id), { force: true }); } catch {}
    logLine('seen-ledger reset for job ' + id);
    return { ok: true };
  }

  if (action === 'run') return enqueue(String(body.id || ''), !!body.dryRun, 'manual');

  // Run the chosen jobs, in stored order, one after another (Karen's "Run Highlighted") —
  // an explicitly selected job runs even when disabled (disabled only gates the scheduler).
  if (action === 'runMany') {
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const cfg = loadCfg();
    let queued = 0;
    for (const j of cfg.jobs || []) {
      if (!ids.includes(j.id) || busy(j.id)) continue;
      queue.push({ id: j.id, dryRun: false, trigger: 'manual' });
      queued++;
    }
    if (queued) { logLine(`run selected: ${queued} job${queued === 1 ? '' : 's'} queued`); pump(); }
    return { ok: true, queued };
  }

  // Run every enabled job, in stored order, one after another (Karen's "Run All Now").
  if (action === 'runAll') {
    const cfg = loadCfg();
    let queued = 0;
    for (const j of cfg.jobs || []) {
      if (j.enabled === false || busy(j.id)) continue;
      queue.push({ id: j.id, dryRun: false, trigger: 'manual' });
      queued++;
    }
    if (queued) { logLine(`run all: ${queued} job${queued === 1 ? '' : 's'} queued`); pump(); }
    return { ok: true, queued };
  }

  // Zero one job's lifetime accumulators / the app-wide grand totals (Karen's resets).
  if (action === 'resetStats') {
    const cfg = loadCfg();
    const j = (cfg.jobs || []).find(x => x.id === String(body.id || ''));
    if (!j) return { ok: false, error: 'job not found' };
    delete j.stats;
    saveCfg(cfg, true);
    logLine(`reset lifetime stats: ${j.name}`);
    return { ok: true };
  }
  if (action === 'resetGrand') {
    const cfg = loadCfg();
    delete cfg.grand;
    saveCfg(cfg, true);
    logLine('reset grand totals');
    return { ok: true };
  }

  // Live schedule feedback for the editor — works for any schedule type (cron, every):
  // validate with the same code the scheduler uses and hand back the next few run times.
  if (action === 'sched') {
    const sc = body.schedule || {};
    const err = sync.validateJob({ name: 'x', source: 'C:\\x', dest: 'D:\\x', schedule: sc });
    if (err) return { ok: false, error: err };
    const next = [];
    let t = Date.now();
    for (let i = 0; i < 3; i++) {
      t = sync.nextOccurrence(sc, t);
      if (!t) break;
      next.push(t);
    }
    return { ok: true, next };
  }

  if (action === 'stop') {
    if (!current && !queue.length) return { ok: false, error: 'nothing is running' };
    if (body.all && queue.length) { queue.length = 0; logLine('stop all: cleared the run queue'); }
    // Wake a paused run so its loop unblocks, sees stopFlag, and ends (Stop cancels a pause too).
    if (current) { stopFlag = true; clearPause(); if (current) { current.paused = false; current.pausedActive = false; current.pauseMode = null; } logLine(`stop requested: ${current.name}`); }
    return { ok: true };
  }

  // Per-run pause/resume (Karen's "Resume Job"). pauseRun {mode:'afterFile'|'now'} suspends the
  // active run; resumeRun continues from the same spot. Web-drop jobs run their own engine and
  // aren't pausable here.
  if (action === 'pauseRun') {
    if (!current) return { ok: false, error: 'no job is running' };
    if (current.kind === 'web') return { ok: false, error: 'web-drop jobs can\'t be paused mid-run — use Stop' };
    runPaused = true;
    pauseNow = body.mode === 'now';
    current.paused = true;
    current.pauseMode = pauseNow ? 'now' : 'afterFile';
    logLine(`pause requested (${current.pauseMode}): ${current.name}`);
    return { ok: true };
  }
  if (action === 'resumeRun') {
    if (!current || !runPaused) return { ok: false, error: 'no paused job to resume' };
    current.paused = false; current.pausedActive = false; current.pauseMode = null;
    clearPause();
    logLine(`resume: ${current.name}`);
    return { ok: true };
  }

  // Live cron feedback for the editor: validate the expression and hand back the
  // next few run times so the user can see it's right before saving.
  if (action === 'cron') {
    try {
      const expr = String(body.expr || '');
      sync.parseCron(expr);
      const next = [];
      let t = Date.now();
      for (let i = 0; i < 3; i++) {
        t = sync.cronNext(expr, t);
        if (!t) break;
        next.push(t);
      }
      return { ok: true, next };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // Editor preview for a pasted Drive folder link — same resolver the runs use.
  if (action === 'resolveLink') {
    try {
      const url = String(body.url || '');
      if (!sync.parseDriveLink(url)) return { ok: false, error: 'not a Google Drive folder link' };
      return { ok: true, path: sync.resolveDriveLink(url) };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  if (action === 'filters') return { ok: true, groups: loadFilters().groups };

  if (action === 'saveFilter') {
    const g = body.group || {};
    const name = String(g.name || '').trim();
    const wildcards = (Array.isArray(g.wildcards) ? g.wildcards : String(g.wildcards || '').split(';'))
      .map(w => String(w).trim()).filter(Boolean);
    if (!name) return { ok: false, error: 'a group name is required' };
    if (!wildcards.length) return { ok: false, error: 'add at least one wildcard' };
    const f = loadFilters();
    const idx = g.id ? f.groups.findIndex(x => x.id === g.id) : -1;
    const id = g.id || 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const entry = { id, name, wildcards, global: !!g.global };
    if (idx >= 0) f.groups[idx] = entry; else f.groups.push(entry);
    saveFilters(f);
    return { ok: true, id };
  }

  if (action === 'removeFilter') {
    const f = loadFilters();
    const before = f.groups.length;
    f.groups = f.groups.filter(x => x.id !== String(body.id || ''));
    if (f.groups.length === before) return { ok: false, error: 'group not found' };
    saveFilters(f);
    return { ok: true };
  }

  if (action === 'openData') {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    require('electron').shell.openPath(DATA_DIR);
    return { ok: true };
  }

  // Open the rules folder in Explorer so the user can edit a rule file in their own
  // editor (the in-app Rules view works too; this is for people who prefer a text editor
  // or want to drop a .json in by hand). Returns the path so the UI can show it.
  if (action === 'openRulesFolder') {
    fs.mkdirSync(RULES_DIR, { recursive: true });
    require('electron').shell.openPath(RULES_DIR);
    return { ok: true, path: RULES_DIR };
  }

  // Open the job manager in its own resizable window — the editor's embedded frame nests
  // inside the editor's scrolling page (double scrollbar), so editing is nicer in a real
  // window with a single scroll and the footer always at the window bottom. The page passes
  // its own loopback origin; only 127.0.0.1/localhost is accepted, and the path is built
  // here, so the window can only ever load this app's own served page.
  if (action === 'openWindow') {
    const origin = String(body.origin || '');
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(origin)) return { ok: false, error: 'bad origin' };
    const accent = /^#?[0-9a-fA-F]{3,8}$/.test(String(body.accent || '')) ? String(body.accent) : '';
    // Optional intent: land the window directly on a task (add/edit/result/filters).
    const id = v => (/^[a-z0-9]{1,32}$/i.test(String(v || '')) ? String(v) : '');
    const intent = body.edit === 'new' ? '&_add=1'
      : id(body.edit) ? '&_edit=' + id(body.edit)
      : id(body.result) ? '&_result=' + id(body.result)
      : body.filters ? '&_filters=1'
      : body.rules ? '&_rules=1' : '';
    if (jobWin && !jobWin.isDestroyed()) {
      // An already-open window must still LAND on the requested task, or every editor
      // click after the first just focuses whatever the window was showing.
      if (intent) jobWin.loadURL(origin + '/apps/file-bridge/index.html?_surface=window' + (accent ? '&_accent=' + encodeURIComponent(accent) : '') + intent);
      jobWin.focus();
      return { ok: true, already: true };
    }
    const { BrowserWindow } = require('electron');
    jobWin = new BrowserWindow({
      width: 1180, height: 800, minWidth: 700, minHeight: 480,
      autoHideMenuBar: true, backgroundColor: '#0d1117', title: 'FileBridge — jobs',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    jobWin.on('closed', () => { jobWin = null; });
    jobWin.loadURL(origin + '/apps/file-bridge/index.html?_surface=window' + (accent ? '&_accent=' + encodeURIComponent(accent) : '') + intent);
    return { ok: true };
  }

  return { ok: false, error: 'unknown action' };
};

// Row-sized result summaries — the full action sample only ships via `result`.
function slim() {
  const out = {};
  for (const [id, r] of Object.entries(lastResults)) {
    out[id] = { at: r.at, ok: r.ok, dryRun: r.dryRun, trigger: r.trigger, ms: r.ms, kind: r.kind, copied: r.copied, bytes: r.bytes, deleted: r.deleted, recycled: r.recycled, scanned: r.scanned, unchanged: r.unchanged, filtered: r.filtered, mirrorProtected: r.mirrorProtected, skippedCount: r.skippedCount, skippedSeen: r.skippedSeen, needsLogin: r.needsLogin, collectionsVisited: r.collectionsVisited, foldersScanned: r.foldersScanned, foldersCreated: r.foldersCreated, foldersDeleted: r.foldersDeleted, planCopies: r.planCopies, planDeletes: r.planDeletes, errorCount: r.errorCount, warningCount: r.warningCount, stopped: r.stopped, mirrorSkipped: r.mirrorSkipped, fatal: r.fatal };
  }
  return out;
}

exports._resolveFilters = resolveFilters; // exposed for tests
exports._shutdown = function () {
  clearInterval(timer);
  stopFlag = true;
  clearPause(); // wake a run parked in waitIfPaused so it can see stopFlag and unwind on shutdown
  for (const w of Object.values(loginWins)) { try { if (!w.isDestroyed()) w.destroy(); } catch {} }
  if (jobWin && !jobWin.isDestroyed()) { try { jobWin.destroy(); } catch {} }
  jobWin = null;
};
