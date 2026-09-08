'use strict';

// AI Usage — host-side data engine.
// Reads local Claude Code (~/.claude) and Codex CLI (~/.codex) session logs and
// aggregates token usage; queries the GitHub billing API for Copilot premium-request
// usage. Everything runs in the host process (full fs/network) and returns only
// pre-aggregated numbers to the page — no raw log contents, no secrets, leave here.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DAY_MS = 86400000;
const SPARK_DAYS = 14;
const GITHUB_TIMEOUT_MS = 10000;

// ── Claude pricing (per 1M tokens, USD, first-party API rates) ─────────────────
// Cache write = 1.25x input (5-min ephemeral, the default), cache read = 0.1x input.
// Matched by family keyword so new point-releases price correctly without edits.
function claudeRates(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return { in: 10, out: 50, cw: 12.5, cr: 1.0 };
  if (m.includes('opus'))   return { in: 5, out: 25, cw: 6.25, cr: 0.5 };
  if (m.includes('sonnet')) return { in: 3, out: 15, cw: 3.75, cr: 0.3 };
  if (m.includes('haiku'))  return { in: 1, out: 5,  cw: 1.25, cr: 0.1 };
  return null; // unknown model — counted in tokens, excluded from the cost estimate
}
function modelCost(model, t) {
  const r = claudeRates(model);
  if (!r) return null;
  return (t.inp * r.in + t.out * r.out + t.cw * r.cw + t.cr * r.cr) / 1e6;
}

// ── Small fs helpers ───────────────────────────────────────────────────────────
function walkJsonl(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkJsonl(full, out);
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}
function dayKey(iso) {
  // Local-day bucket. Codex/Claude timestamps are ISO-8601 (UTC) — group by local date.
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function todayKey() { return dayKey(new Date().toISOString()); }

// Merge per-model token counts into a days map: days[date][model] = {inp,out,cw,cr,msgs}
function addUsage(days, date, model, u) {
  if (!date) return;
  const dm = days[date] || (days[date] = {});
  const t = dm[model] || (dm[model] = { inp: 0, out: 0, cw: 0, cr: 0, msgs: 0 });
  t.inp += u.inp || 0; t.out += u.out || 0; t.cw += u.cw || 0; t.cr += u.cr || 0; t.msgs += u.msgs || 0;
}

// ── Claude parse ───────────────────────────────────────────────────────────────
// Per-file cache keyed by mtime+size, so steady-state polls only re-read the 1–2
// files a live session is still appending to.
const claudeCache = new Map(); // path -> { mtimeMs, size, days, hasUsage }

function parseClaudeFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const days = {};
  let hasUsage = false;
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"usage"') === -1) continue; // cheap prefilter
    let d;
    try { d = JSON.parse(line); } catch (e) { continue; }
    if (d.type !== 'assistant') continue;
    const msg = d.message; if (!msg) continue;
    const model = msg.model;
    if (!model || model === '<synthetic>') continue;
    const u = msg.usage; if (!u) continue;
    hasUsage = true;
    addUsage(days, dayKey(d.timestamp), model, {
      inp: u.input_tokens, out: u.output_tokens,
      cw: u.cache_creation_input_tokens, cr: u.cache_read_input_tokens, msgs: 1,
    });
  }
  return { days, hasUsage };
}

// ── Codex parse ──────────────────────────────────────────────────────────────
// Codex rollout logs: token usage lives in event_msg/token_count payloads
// (last_token_usage = per-turn); the current model comes from turn_context /
// session_meta lines that precede them. rate_limits (weekly %/reset) rides along
// on token_count events — we keep the newest one seen across all files.
const codexCache = new Map(); // path -> { mtimeMs, size, days, latest }

function parseCodexFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const days = {};
  let model = 'codex';
  let latest = null; // { at, weeklyPct, weeklyResetsAt, w5Pct, w5ResetsAt, model }
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.indexOf('"model"') === -1 && line.indexOf('token_count') === -1) continue;
    let d;
    try { d = JSON.parse(line); } catch (e) { continue; }
    if (d.type === 'turn_context' || d.type === 'session_meta') {
      const m = (d.payload && d.payload.model) || d.model;
      if (m) model = m;
      continue;
    }
    const p = d.payload;
    if (!p || p.type !== 'token_count' || !p.info) continue;
    const last = p.info.last_token_usage || {};
    addUsage(days, dayKey(d.timestamp), model, {
      inp: last.input_tokens, out: last.output_tokens,
      cw: last.cache_write_input_tokens, cr: last.cached_input_tokens, msgs: 1,
    });
    const rl = p.rate_limits;
    if (rl) {
      const at = new Date(d.timestamp).getTime() || 0;
      // primary/secondary are NOT fixed to a window size — one is the ~5h limit,
      // the other the weekly (~10080 min); which slot is which varies. Keep both
      // raw and classify by window_minutes at render time.
      const windows = [rl.primary, rl.secondary]
        .filter(w => w && typeof w.window_minutes === 'number' && typeof w.used_percent === 'number')
        .map(w => ({ pct: w.used_percent, window: w.window_minutes, resetsAt: w.resets_at }));
      if (windows.length && (!latest || at > latest.at)) latest = { at, model, windows };
    }
  }
  return { days, latest };
}

// ── Generic cached scan ────────────────────────────────────────────────────────
function scan(dirs, cache, parse) {
  const files = [];
  for (const d of dirs) if (d) walkJsonl(d, files);
  const merged = {}; // date -> model -> tokens
  let sessions = 0;
  let extra = null; // codex 'latest'
  const seen = new Set();
  for (const file of files) {
    seen.add(file);
    let st; try { st = fs.statSync(file); } catch (e) { continue; }
    let hit = cache.get(file);
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      const parsed = parse(file);
      if (!parsed) continue;
      hit = { mtimeMs: st.mtimeMs, size: st.size, days: parsed.days, hasUsage: parsed.hasUsage, latest: parsed.latest };
      cache.set(file, hit);
    }
    let fileHadUsage = false;
    for (const date in hit.days) {
      for (const model in hit.days[date]) {
        fileHadUsage = true;
        addUsage(merged, date, model, hit.days[date][model]);
      }
    }
    if (fileHadUsage) sessions++;
    if (hit.latest && (!extra || hit.latest.at > extra.at)) extra = hit.latest;
  }
  for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);
  saveCaches();
  return { days: merged, sessions, files: files.length, latest: extra };
}

// ── Cache persistence ──────────────────────────────────────────────────────────
// The first scan of a large ~/.claude history is slow (reads every session log);
// the per-file cache makes later polls cheap, and persisting it to a tmp sidecar
// keeps an Bedrock Panel restart from re-paying the cold scan. All best-effort.
const CACHE_FILE = path.join(os.tmpdir(), 'oq-ai-usage-cache.json');
function saveCaches() {
  // Cheap (~155 KB write); called once per scan. Persist both maps every time so a
  // claude scan can't shadow the codex map (and vice-versa) via a shared throttle.
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      claude: Object.fromEntries(claudeCache),
      codex: Object.fromEntries(codexCache),
    }));
  } catch (e) {}
}
try {
  const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  for (const [k, v] of Object.entries(raw.claude || {})) claudeCache.set(k, v);
  for (const [k, v] of Object.entries(raw.codex || {})) codexCache.set(k, v);
} catch (e) {}

// ── Period slicing / rollups ─────────────────────────────────────────────────
function periodStart(period) {
  const now = Date.now();
  if (period === 'today') return dayKey(new Date(now).toISOString());
  if (period === '7d')  return dayKey(new Date(now - 6 * DAY_MS).toISOString());
  if (period === '30d') return dayKey(new Date(now - 29 * DAY_MS).toISOString());
  return '0000-00-00'; // all
}
function inRange(date, start) { return date >= start; }

function sparkSeries(days, valueFn) {
  const out = [];
  for (let i = SPARK_DAYS - 1; i >= 0; i--) {
    const date = dayKey(new Date(Date.now() - i * DAY_MS).toISOString());
    let acc = { inp: 0, out: 0, cw: 0, cr: 0, msgs: 0, cost: 0 };
    const dm = days[date];
    if (dm) for (const model in dm) {
      const t = dm[model];
      acc.inp += t.inp; acc.out += t.out; acc.cw += t.cw; acc.cr += t.cr; acc.msgs += t.msgs;
      const c = modelCost(model, t); if (c) acc.cost += c;
    }
    out.push({ date, value: valueFn(acc) });
  }
  return out;
}

function claudeSummary(days, period) {
  const start = periodStart(period);
  const tot = { inp: 0, out: 0, cw: 0, cr: 0, msgs: 0, cost: 0 };
  const byModel = {};
  let unpriced = false, lastActivity = null;
  for (const date in days) {
    if (date > (lastActivity || '')) lastActivity = date;
    if (!inRange(date, start)) continue;
    for (const model in days[date]) {
      const t = days[date][model];
      tot.inp += t.inp; tot.out += t.out; tot.cw += t.cw; tot.cr += t.cr; tot.msgs += t.msgs;
      const c = modelCost(model, t);
      if (c == null) unpriced = true; else tot.cost += c;
      const bm = byModel[model] || (byModel[model] = { model, tokens: 0, msgs: 0, cost: 0 });
      bm.tokens += t.inp + t.out + t.cw + t.cr; bm.msgs += t.msgs; if (c) bm.cost += c;
    }
  }
  const models = Object.values(byModel).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).slice(0, 5);
  return {
    tokens: tot.inp + tot.out + tot.cw + tot.cr,
    inp: tot.inp, out: tot.out, cacheWrite: tot.cw, cacheRead: tot.cr,
    msgs: tot.msgs, cost: tot.cost, unpriced, models, lastActivity,
    spark: sparkSeries(days, a => a.cost),
  };
}

// Classify the newest rate-limit snapshot into a short (~5h) and weekly window by size.
function classifyLimit(latest) {
  if (!latest || !latest.windows || !latest.windows.length) return null;
  const sorted = [...latest.windows].sort((a, b) => a.window - b.window);
  const short = sorted[0];
  const weekly = sorted[sorted.length - 1];
  return {
    model: latest.model, at: latest.at,
    weeklyPct: weekly.pct, weeklyResetsAt: weekly.resetsAt, weeklyWindow: weekly.window,
    shortPct: short.pct, shortResetsAt: short.resetsAt, shortWindow: short.window,
    hasShort: sorted.length > 1 && short.window !== weekly.window,
  };
}

function codexSummary(days, period) {
  const start = periodStart(period);
  const tot = { inp: 0, out: 0, cr: 0, msgs: 0 };
  let lastActivity = null;
  for (const date in days) {
    if (date > (lastActivity || '')) lastActivity = date;
    if (!inRange(date, start)) continue;
    for (const model in days[date]) {
      const t = days[date][model];
      tot.inp += t.inp; tot.out += t.out; tot.cr += t.cr; tot.msgs += t.msgs;
    }
  }
  return {
    tokens: tot.inp + tot.out, inp: tot.inp, out: tot.out, cachedIn: tot.cr,
    msgs: tot.msgs, lastActivity,
    spark: sparkSeries(days, a => a.msgs),
  };
}

// ── GitHub Copilot usage ───────────────────────────────────────────────────────
async function githubGet(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'bedrock-panel-ai-usage',
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { status: res.status, json };
}

async function copilotUsage(options) {
  const user = String(options.githubUser || '').trim();
  const token = String(options.githubToken || '').trim();
  if (!user || !token) return { ok: true, configured: false };

  const now = new Date();
  const base = 'https://api.github.com/users/' + encodeURIComponent(user) + '/settings/billing';
  // premium_request/usage is the individual-account endpoint; fall back to the
  // general usage report if the account isn't on the premium-request surface.
  let r = await githubGet(base + '/premium_request/usage?year=' + now.getFullYear() + '&month=' + (now.getMonth() + 1), token);
  let source = 'premium_request';
  if (r.status === 404) { r = await githubGet(base + '/usage', token); source = 'usage'; }

  if (r.status === 401) return { ok: false, configured: true, error: 'GitHub rejected the token (401) — check it has not expired.' };
  if (r.status === 403) return { ok: false, configured: true, error: 'Token lacks permission (403) — needs "Plan" read-only access.' };
  if (r.status === 404) return { ok: false, configured: true, error: 'No billing usage for this account (404) — the billing API needs the enhanced billing platform.' };
  if (r.status < 200 || r.status >= 300 || !r.json) return { ok: false, configured: true, error: 'GitHub returned HTTP ' + r.status + '.' };

  const items = (r.json.usageItems || []).filter(it =>
    /copilot/i.test(it.product || '') || /premium|copilot/i.test(it.sku || ''));
  let used = 0, net = 0, gross = 0;
  for (const it of items) {
    used += Number(it.grossQuantity || it.quantity || 0);
    net += Number(it.netAmount || 0);
    gross += Number(it.grossAmount || 0);
  }
  const included = parseInt(options.copilotIncluded, 10) || 0;
  return {
    ok: true, configured: true, source, user,
    used: Math.round(used), included, net, gross,
    period: now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'),
  };
}

// ── Claude plan limits (5-hour + weekly) via the OAuth usage endpoint ──────────
// Ref: github.com/trickv/hass-claude-usage. Reads the Claude login token from
// ~/.claude/.credentials.json, refreshes it when expired, GETs /api/oauth/usage.
// This is ACCOUNT-GLOBAL data (identical on every machine) — unlike the local logs.
// The endpoint 429s hard (up to ~24h) if polled fast, so we call it at most every 5 min.
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_BETA = 'oauth-2025-04-20';
const CLAUDE_UA = 'claude-code/2.1.229';
const CLAUDE_MIN_INTERVAL = 300000;
let claudeUsageCache = { at: 0, data: null, error: null };
let credBackupDone = false;

function backupCredsOnce(file) {
  if (credBackupDone) return;
  credBackupDone = true;
  try { fs.copyFileSync(file, path.join(os.tmpdir(), 'oq-ai-usage-credentials-backup-' + Date.now() + '.json')); } catch (e) {}
}
async function refreshClaudeToken(file, creds) {
  const o = creds.claudeAiOauth;
  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: CLAUDE_CLIENT_ID }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('token refresh ' + res.status);
  const t = await res.json();
  if (!t.access_token) throw new Error('token refresh: no access_token');
  backupCredsOnce(file);                       // back up before the first write
  o.accessToken = t.access_token;
  if (t.refresh_token) o.refreshToken = t.refresh_token;
  o.expiresAt = Date.now() + (Number(t.expires_in) || 3600) * 1000;
  fs.writeFileSync(file, JSON.stringify(creds, null, 2));  // preserve all other keys
  return o.accessToken;
}
function pctOf(x) { if (x == null) return null; const n = Number(x); if (!isFinite(n)) return null; return Math.max(0, Math.min(100, n)); }
function toEpoch(v) { if (v == null) return null; if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : v; const d = Date.parse(v); return isNaN(d) ? null : Math.floor(d / 1000); }
function parseClaudeUsage(j, plan) {
  const fh = j.five_hour || {}, sd = j.seven_day || {};
  return {
    plan: plan || null,
    limit: {
      fiveHourPct: pctOf(fh.utilization), fiveHourResetsAt: toEpoch(fh.resets_at),
      weeklyPct: pctOf(sd.utilization), weeklyResetsAt: toEpoch(sd.resets_at),
    },
  };
}
async function claudeLimits(options) {
  const file = path.join(homeSub('.claude', options.claudePath), '.credentials.json');
  const now = Date.now();
  if (now - claudeUsageCache.at < CLAUDE_MIN_INTERVAL && (claudeUsageCache.data || claudeUsageCache.error)) {
    return claudeUsageCache.data || { limitError: claudeUsageCache.error };
  }
  let creds;
  try { creds = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { limitError: 'not signed in to Claude on this machine' }; }
  const o = creds && creds.claudeAiOauth;
  if (!o || !o.accessToken) return { limitError: 'not signed in to Claude on this machine' };
  let token = o.accessToken;
  if (!o.expiresAt || o.expiresAt < now + 60000) {
    try { token = await refreshClaudeToken(file, creds); }
    catch (e) {
      try {                                    // Claude Code may have refreshed it already
        const fresh = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth;
        if (fresh && fresh.expiresAt > now + 60000) token = fresh.accessToken; else throw e;
      } catch (e2) {
        claudeUsageCache = { at: now, data: null, error: 'Claude sign-in expired — run any claude command to refresh' };
        return { limitError: claudeUsageCache.error };
      }
    }
  }
  let res;
  try {
    res = await fetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': CLAUDE_BETA, 'User-Agent': CLAUDE_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { return { limitError: 'Claude usage request failed' }; }
  if (res.status === 429) { claudeUsageCache.at = now; return claudeUsageCache.data || { limitError: 'Claude usage rate-limited — retry shortly' }; }
  if (res.status === 401) { claudeUsageCache = { at: now, data: null, error: 'Claude sign-in expired — run any claude command' }; return { limitError: claudeUsageCache.error }; }
  if (res.status < 200 || res.status >= 300) return { limitError: 'Claude usage HTTP ' + res.status };
  let j; try { j = await res.json(); } catch (e) { return { limitError: 'Claude usage: bad response' }; }
  const data = parseClaudeUsage(j, o.subscriptionType);
  claudeUsageCache = { at: now, data, error: null };
  return data;
}

// ── Codex live limits (account-global) via the ChatGPT usage endpoint ──────────
// The exact call codex's `/status` makes: GET chatgpt.com/backend-api/wham/usage with
// the Codex login token from ~/.codex/auth.json. Account-wide, so identical on every
// machine — unlike the per-machine snapshot we scrape from the local logs. Read-only:
// we never refresh or write auth.json; if the token's stale we fall back to the log snapshot.
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_MIN_INTERVAL = 120000;
let codexUsageCache = { at: 0, data: null };

async function codexLiveLimits(options) {
  const authFile = path.join(homeSub('.codex', options.codexPath), 'auth.json');
  const now = Date.now();
  if (now - codexUsageCache.at < CODEX_MIN_INTERVAL && codexUsageCache.data) return codexUsageCache.data;
  let auth;
  try { auth = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch (e) { return null; }
  const t = auth && auth.tokens;
  if (!t || !t.access_token) return null;
  let res;
  try {
    res = await fetch(CODEX_USAGE_URL, {
      headers: { Authorization: 'Bearer ' + t.access_token, 'ChatGPT-Account-Id': t.account_id || '', 'User-Agent': 'codex-cli', Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { return null; }
  if (res.status < 200 || res.status >= 300) return null;   // 401 etc → fall back to local snapshot
  let j; try { j = await res.json(); } catch (e) { return null; }
  const rl = j.rate_limit || {};
  const windows = [rl.primary_window, rl.secondary_window]
    .filter(w => w && typeof w.used_percent === 'number' && typeof w.limit_window_seconds === 'number')
    .map(w => ({ pct: w.used_percent, window: Math.round(w.limit_window_seconds / 60), resetsAt: w.reset_at }));
  if (!windows.length) return null;
  const sorted = [...windows].sort((a, b) => a.window - b.window);
  const short = sorted[0], weekly = sorted[sorted.length - 1];
  const data = {
    live: true, plan: j.plan_type || null, email: j.email || null, accountId: j.account_id || null,
    weeklyPct: weekly.pct, weeklyResetsAt: weekly.resetsAt, weeklyWindow: weekly.window,
    shortPct: short.pct, shortResetsAt: short.resetsAt, shortWindow: short.window,
    hasShort: sorted.length > 1 && short.window !== weekly.window,
  };
  codexUsageCache = { at: now, data };
  return data;
}

// ── Dispatch ───────────────────────────────────────────────────────────────────
function homeSub(sub, override) {
  const o = String(override || '').trim();
  return o || path.join(os.homedir(), sub);
}

async function handle(action, context) {
  const options = (context && context.options) || {};
  const query = (context && context.query) || {};
  const period = ['today', '7d', '30d', 'all'].includes(query.period) ? query.period : '7d';
  try {
    if (action === 'claude') {
      const dir = homeSub('.claude', options.claudePath);
      const s = scan([path.join(dir, 'projects')], claudeCache, parseClaudeFile);
      const summary = claudeSummary(s.days, period);
      let extra = {};
      if (String(options.claudeLimits) !== 'false') {
        try { extra = await claudeLimits(options); } catch (e) { extra = { limitError: String(e && e.message || e) }; }
      }
      return { ok: true, period, sessions: s.sessions, files: s.files, ...summary, ...extra, dir: fs.existsSync(dir) };
    }
    if (action === 'codex') {
      const dir = homeSub('.codex', options.codexPath);
      const s = scan([path.join(dir, 'sessions'), path.join(dir, 'archived_sessions')], codexCache, parseCodexFile);
      const summary = codexSummary(s.days, period);
      let limit = classifyLimit(s.latest);
      if (String(options.codexLimits) !== 'false') {
        try { const live = await codexLiveLimits(options); if (live) limit = Object.assign({}, live, { model: limit && limit.model }); } catch (e) {}
      }
      return { ok: true, period, sessions: s.sessions, files: s.files, limit, ...summary, dir: fs.existsSync(dir) };
    }
    if (action === 'copilot') return await copilotUsage(options);
    return { ok: false, error: 'unknown action' };
  } catch (error) {
    return { ok: false, error: String(error && error.message || error || 'request failed') };
  }
}

module.exports = { handle };
