'use strict';
// oMLX Monitor — server module. Runs inside Bedrock Panel and talks to each configured oMLX
// server (omlx.ai, an MLX inference server for Apple silicon) on the page's behalf:
//   GET /api/status               bearer <api key>   — the lightweight status oMLX offers to external
//                                                      monitors: version, uptime, model counts, totals,
//                                                      average tokens/s, model memory
//   POST /admin/api/login         {api_key}          — a session cookie (main key only; sub keys are
//                                                      refused, and then only the status above is shown)
//   GET /admin/api/activity       session            — per loaded model: requests generating (tokens/s),
//                                                      waiting, prefilling, loading progress, idle TTL;
//                                                      memory pressure
//   GET /admin/api/models         session            — every discovered model, loaded or not
//   GET /admin/api/device-info    session            — chip, memory, GPU cores
//   POST /admin/api/models/<id>/load|unload  session — the Load / Unload buttons
// Keys stay here (serverOnly options); the page only ever sees the merged snapshot. No third-party
// hosts are contacted. [MIT]
const http = require('http');
const https = require('https');

const TIMEOUT_MS = 6000;
const SLOTS = [1, 2, 3];
const MODELS_TTL_MS = 10000;
const DEVICE_TTL_MS = 300000;

const str = v => String(v == null ? '' : v).trim();
const sessions = new Map();   // url -> cookie ("omlx_admin_session=…")
const adminBlocked = new Map();   // url -> reason the admin session cannot be made (sub key, no key)
const modelsCache = new Map();   // url -> { at, list }
const deviceCache = new Map();   // url -> { at, info }

function instances(options) {
  const o = options || {};
  const on = n => n === 1 || (String(o.more2) === 'true' && (n === 2 || String(o.more3) === 'true'));   // "Add another server" toggles
  return SLOTS.filter(on).map(n => {
    const url = str(o['url' + n]).replace(/\/+$/, '');
    let host = '';
    try { host = new URL(url).host; } catch (e) { host = url; }
    return { n, url, key: str(o['key' + n]), name: host || ('oMLX ' + n) };
  }).filter(i => i.url);
}

// One HTTP(S) request with a JSON body/answer; resolves { status, headers, json, text }, rejects on
// network failure or timeout. Only http/https targets are ever contacted.
function request(base, pathname, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(base + pathname); } catch (e) { return reject(new Error('bad server URL: ' + base)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('the server URL must start with http:// or https://'));
    const body = o.body == null ? null : JSON.stringify(o.body);
    const headers = Object.assign({ Accept: 'application/json' }, o.headers || {});
    if (body != null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, { method: o.method || 'GET', headers, timeout: TIMEOUT_MS }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
        resolve({ status: res.statusCode || 0, headers: res.headers, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out after ' + (TIMEOUT_MS / 1000) + ' s')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// ---- admin session (cookie) ----
async function login(inst) {
  if (!inst.key) { adminBlocked.set(inst.url, 'no API key set for this server'); return null; }
  const r = await request(inst.url, '/admin/api/login', { method: 'POST', body: { api_key: inst.key, remember: true } });
  if (r.status >= 200 && r.status < 300) {
    const set = [].concat(r.headers['set-cookie'] || []);
    const cookie = set.map(c => c.split(';')[0]).find(c => /^omlx_admin_session=/.test(c));
    if (cookie) { sessions.set(inst.url, cookie); adminBlocked.delete(inst.url); return cookie; }
    adminBlocked.set(inst.url, 'login answered without a session cookie');
    return null;
  }
  // 400 = no admin key configured on that server yet; 401 = a sub key, or the wrong key
  const detail = (r.json && (r.json.detail || r.json.error)) || ('HTTP ' + r.status);
  adminBlocked.set(inst.url, r.status === 401 ? 'admin data needs the server\'s main API key (a sub key only reads the status)' : String(detail));
  return null;
}

// GET/POST an admin route with the session; a 401 re-logs in once. Returns the JSON, or null when
// the admin side is unavailable (the reason lands in adminBlocked).
async function admin(inst, pathname, method) {
  let cookie = sessions.get(inst.url);
  if (!cookie) {
    if (adminBlocked.has(inst.url) && !inst.key) return null;
    cookie = await login(inst);
    if (!cookie) return null;
  }
  let r = await request(inst.url, pathname, { method: method || 'GET', headers: { Cookie: cookie } });
  if (r.status === 401) {
    sessions.delete(inst.url);
    cookie = await login(inst);
    if (!cookie) return null;
    r = await request(inst.url, pathname, { method: method || 'GET', headers: { Cookie: cookie } });
  }
  if (r.status < 200 || r.status >= 300) throw new Error((r.json && r.json.detail) || ('HTTP ' + r.status + ' from ' + pathname));
  return r.json;
}

const gb = bytes => { const n = Number(bytes) || 0; return n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : n >= 1024 ** 2 ? Math.round(n / 1024 ** 2) + ' MB' : n ? Math.round(n / 1024) + ' KB' : '0'; };
const num = v => (typeof v === 'number' && isFinite(v)) ? v : 0;

async function cached(map, key, ttl, fetcher) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fetcher();
  map.set(key, { at: Date.now(), value });
  return value;
}

// The merged snapshot for one server: the bearer status as the floor, the admin data on top.
async function snapshot(inst) {
  const base = { ok: true, inst: inst.n, name: inst.name, url: inst.url, admin: false, adminNote: '' };
  if (!inst.key) return Object.assign(base, { ok: false, error: 'no API key set — the server\'s Admin → Settings shows it' });
  let s;
  try {
    s = await request(inst.url, '/api/status', { headers: { Authorization: 'Bearer ' + inst.key } });
  } catch (e) {
    return Object.assign(base, { ok: false, error: /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(e.message) ? 'not running or not reachable at ' + inst.url : e.message });
  }
  if (s.status === 401 || s.status === 403) return Object.assign(base, { ok: false, error: 'API key rejected by ' + inst.name });
  if (s.status === 503) return Object.assign(base, { ok: false, error: 'starting up — still loading its pinned models', starting: true });
  if (s.status < 200 || s.status >= 300 || !s.json) return Object.assign(base, { ok: false, error: 'HTTP ' + s.status + ' from /api/status' });
  const st = s.json;
  const out = Object.assign(base, {
    version: str(st.version), uptimeSeconds: num(st.uptime_seconds),
    counts: { discovered: num(st.models_discovered), loaded: num(st.models_loaded), loading: num(st.models_loading) },
    defaultModel: str(st.default_model),
    totals: { requests: num(st.total_requests), active: num(st.active_requests), waiting: num(st.waiting_requests),
      promptTokens: num(st.total_prompt_tokens), completionTokens: num(st.total_completion_tokens), cachedTokens: num(st.total_cached_tokens),
      cacheEfficiency: num(st.cache_efficiency) },
    tps: { prefill: num(st.avg_prefill_tps), generation: num(st.avg_generation_tps) },
    memory: { usedBytes: num(st.model_memory_used), maxBytes: st.model_memory_max == null ? null : num(st.model_memory_max),
      used: str(st.model_memory_used_formatted) || gb(st.model_memory_used), max: str(st.model_memory_max_formatted) || (st.model_memory_max ? gb(st.model_memory_max) : 'unlimited'),
      pressure: null },
    models: [].concat(st.loaded_models || []).map(id => ({ id: String(id), loaded: true, loading: false, activeRequests: 0, waitingRequests: 0, generating: [], waiting: [], prefilling: 0 })),
    available: [],
    device: null,
  });
  // Admin data: best effort, never fails the snapshot.
  try {
    const act = await admin(inst, '/admin/api/activity');
    if (act && act.active_models) {
      const a = act.active_models;
      out.admin = true;
      const p = a.memory_pressure || {};
      out.memory.pressure = { enabled: !!p.enabled, level: str(p.pressure_level) || 'ok', current: str(p.current_formatted), soft: str(p.soft_formatted), hard: str(p.hard_formatted) };
      if (a.model_memory_max) { out.memory.maxBytes = num(a.model_memory_max); out.memory.max = gb(a.model_memory_max); }
      if (a.model_memory_used != null) { out.memory.usedBytes = num(a.model_memory_used); out.memory.used = gb(a.model_memory_used); }
      out.models = [].concat(a.models || []).map(m => ({
        id: str(m.id), loaded: !m.is_loading, loading: !!m.is_loading, pinned: !!m.pinned,
        size: str(m.actual_size_formatted) || str(m.estimated_size_formatted) || gb(m.actual_size || m.estimated_size),
        sizeBytes: num(m.actual_size || m.estimated_size),
        activeRequests: num(m.active_requests), waitingRequests: num(m.waiting_requests),
        loadingElapsed: m.loading_elapsed_seconds == null ? null : num(m.loading_elapsed_seconds),
        loadingRemaining: m.loading_remaining_seconds_estimate == null ? null : num(m.loading_remaining_seconds_estimate),
        idleSeconds: m.idle_seconds == null ? null : num(m.idle_seconds),
        ttlRemaining: m.ttl_remaining_seconds == null ? null : num(m.ttl_remaining_seconds),
        prefilling: [].concat(m.prefilling || []).length,
        generating: [].concat(m.generating || []).map(g => ({ id: str(g.request_id), elapsed: g.elapsed_seconds == null ? null : num(g.elapsed_seconds), tokens: num(g.generated_tokens), tps: num(g.tokens_per_second), promptTokens: num(g.prompt_tokens), maxTokens: g.max_tokens == null ? null : num(g.max_tokens) })),
        waiting: [].concat(m.waiting || []).map(w => ({ id: str(w.request_id), position: num(w.queue_position), elapsed: num(w.elapsed_seconds), promptTokens: num(w.prompt_tokens) })),
      }));
      out.totals.active = num(a.total_active_requests);
      out.totals.waiting = num(a.total_waiting_requests);
    }
  } catch (e) { out.adminNote = 'activity: ' + e.message; }
  if (out.admin) {
    try {
      const list = await cached(modelsCache, inst.url, MODELS_TTL_MS, () => admin(inst, '/admin/api/models'));
      const all = Array.isArray(list) ? list : (list && (list.models || list.data)) || [];
      const shown = new Set(out.models.map(m => m.id));
      out.available = all.map(m => ({ id: str(m.id || m.name), size: str(m.estimated_size_formatted) || (m.estimated_size ? gb(m.estimated_size) : ''), type: str(m.model_type || m.engine_type), loaded: !!m.loaded, loading: !!m.is_loading, pinned: !!m.pinned }))
        .filter(m => m.id && !shown.has(m.id) && !m.loaded && !m.loading);
    } catch (e) { out.adminNote = (out.adminNote ? out.adminNote + '; ' : '') + 'models: ' + e.message; }
    try {
      const d = await cached(deviceCache, inst.url, DEVICE_TTL_MS, () => admin(inst, '/admin/api/device-info'));
      if (d) out.device = { chip: [str(d.chip_name), str(d.chip_variant)].filter(Boolean).join(' '), memoryGb: num(d.memory_gb), gpuCores: num(d.gpu_cores) };
    } catch (e) { /* cosmetic */ }
  } else if (adminBlocked.has(inst.url)) {
    out.adminNote = adminBlocked.get(inst.url);
  }
  return out;
}

async function handle(action, context) {
  const options = (context && context.options) || {};
  const query = (context && context.query) || {};
  const list = instances(options);
  if (action === 'instances') {
    return { ok: true, instances: list.map(i => ({ inst: i.n, name: i.name, url: i.url, hasKey: !!i.key })), refreshSeconds: 2, allowControl: String(options.allowControl) !== 'false' };
  }
  if (!['status', 'load', 'unload'].includes(action)) return { ok: false, error: 'unknown action' };
  const inst = list.find(i => String(i.n) === String(query.inst)) || list[0];
  if (!inst) return { ok: false, error: 'No oMLX server configured — set Server 1 URL and API key in this page\'s settings.' };
  if (action === 'status') {
    try { return await snapshot(inst); }
    catch (e) { return { ok: false, inst: inst.n, name: inst.name, url: inst.url, error: e.message }; }
  }
  if (action === 'load' || action === 'unload') {
    if (String(options.allowControl) === 'false') return { ok: false, error: 'Load / Unload is turned off in this page\'s settings.' };
    const model = str(query.model);
    if (!model) return { ok: false, error: 'no model given' };
    try {
      const r = await admin(inst, '/admin/api/models/' + encodeURIComponent(model) + '/' + action, 'POST');
      if (r == null) return { ok: false, error: adminBlocked.get(inst.url) || 'admin session unavailable' };
      modelsCache.delete(inst.url);
      return { ok: true, model, action, result: r };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: false, error: 'unknown action' };
}

module.exports = { handle, _instances: instances, _resetForTests: () => { sessions.clear(); adminBlocked.clear(); modelsCache.clear(); deviceCache.clear(); } };
