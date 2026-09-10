'use strict';
// community-apps/omlx-monitor/server.js against a fake oMLX server that speaks the routes the real one
// does (field names taken from oMLX 0.6.4's server.py / admin/routes.py): bearer status, cookie
// session from the main key (a sub key is refused), admin activity/models/device-info, load/unload.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const mod = require('../community-apps/omlx-monitor/server.js');

function fakeOmlx() {
  const state = { cookie: 'omlx_admin_session=tok1', logins: 0, unloads: [], loads: [], sessionValid: true };
  const json = (res, code, obj, extraHeaders) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {})); res.end(JSON.stringify(obj)); };
  const hasSession = req => state.sessionValid && String(req.headers.cookie || '').includes(state.cookie);
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/api/status') {
        const auth = req.headers.authorization || '';
        if (auth !== 'Bearer main' && auth !== 'Bearer sub') return json(res, 401, { detail: 'Invalid API key' });
        return json(res, 200, { status: 'ok', version: '0.6.4', uptime_seconds: 3725, models_discovered: 3, models_loaded: 1, models_loading: 0, default_model: 'mlx-community/qwen3-8b',
          loaded_models: ['mlx-community/qwen3-8b'], total_requests: 42, active_requests: 1, waiting_requests: 0, total_prompt_tokens: 120000, total_completion_tokens: 34000, total_cached_tokens: 50000,
          cache_efficiency: 0.41, avg_prefill_tps: 1240.5, avg_generation_tps: 61.2, model_memory_used: 8 * 1024 ** 3, model_memory_max: 96 * 1024 ** 3, model_memory_used_formatted: '8.0GB', model_memory_max_formatted: '96.0GB' });
      }
      if (u.pathname === '/admin/api/login' && req.method === 'POST') {
        state.logins++;
        const b = JSON.parse(body || '{}');
        if (b.api_key === 'main') { state.sessionValid = true; return json(res, 200, { success: true }, { 'Set-Cookie': state.cookie + '; Path=/; HttpOnly' }); }
        return json(res, 401, { detail: 'Invalid API key' });
      }
      if (u.pathname.startsWith('/admin/')) {
        if (!hasSession(req)) return json(res, 401, { detail: 'Admin authentication required' });
        if (u.pathname === '/admin/api/activity') return json(res, 200, { active_models: { models: [{ id: 'mlx-community/qwen3-8b', estimated_size: 8 * 1024 ** 3, estimated_size_formatted: '8.0GB', actual_size: 0, actual_size_formatted: null, pinned: true, is_loading: false,
          loading_elapsed_seconds: null, loading_estimated_seconds: null, loading_remaining_seconds_estimate: null, active_requests: 1, waiting_requests: 1,
          waiting: [{ request_id: 'w1', queue_position: 1, elapsed_seconds: 2.5, prompt_tokens: 900 }], activities: [], prefilling: [],
          generating: [{ request_id: 'g1', elapsed_seconds: 4.2, generated_tokens: 260, tokens_per_second: 61.9, last_activity_age_seconds: 0.1, prompt_tokens: 1200, max_tokens: null }],
          idle_seconds: null, ttl_remaining_seconds: null, dflash: null }],
          model_memory_used: 8 * 1024 ** 3, model_memory_max: 96 * 1024 ** 3,
          memory_pressure: { enabled: true, current_bytes: 8 * 1024 ** 3, soft_bytes: 80 * 1024 ** 3, hard_bytes: 90 * 1024 ** 3, current_formatted: '8.0GB', soft_formatted: '80.0GB', hard_formatted: '90.0GB', pressure_level: 'ok' },
          total_active_requests: 1, total_waiting_requests: 1 } });
        if (u.pathname === '/admin/api/models') return json(res, 200, [
          { id: 'mlx-community/qwen3-8b', loaded: true, is_loading: false, estimated_size: 8 * 1024 ** 3, model_type: 'qwen3' },
          { id: 'mlx-community/gemma-3-27b', loaded: false, is_loading: false, estimated_size: 17 * 1024 ** 3, estimated_size_formatted: '17.0GB', model_type: 'gemma3' },
          { id: 'mlx-community/whisper-large', loaded: false, is_loading: false, estimated_size: 3 * 1024 ** 3, model_type: 'whisper' }]);
        if (u.pathname === '/admin/api/device-info') return json(res, 200, { chip_name: 'Apple M4 Max', chip_variant: '', memory_gb: 128, gpu_cores: 40, owner_hash: 'x' });
        const m = u.pathname.match(/^\/admin\/api\/models\/(.+)\/(load|unload)$/);
        if (m && req.method === 'POST') { (m[2] === 'load' ? state.loads : state.unloads).push(decodeURIComponent(m[1])); return json(res, 200, { success: true }); }
      }
      json(res, 404, { detail: 'Not Found' });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: 'http://127.0.0.1:' + server.address().port })));
}

test('instances: the first server plus the ones revealed by Add another server, named after the host; unknown action refused', async () => {
  mod._resetForTests();
  const r = await mod.handle('instances', { options: { url1: 'http://127.0.0.1:8000/', key1: 'k', more2: true, url2: '', key2: 'x', more3: true, url3: 'http://box:8000' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.instances, [{ inst: 1, name: '127.0.0.1:8000', url: 'http://127.0.0.1:8000', hasKey: true }, { inst: 3, name: 'box:8000', url: 'http://box:8000', hasKey: false }]);
  assert.equal(r.refreshSeconds, 2);
  const hidden = await mod.handle('instances', { options: { url1: 'http://127.0.0.1:8000', key1: 'k', more2: false, url2: 'http://left-over:8000', key2: 'x' } });
  assert.deepEqual(hidden.instances.map(i => i.inst), [1], 'a server behind an unticked Add another server is ignored');
  assert.equal(r.allowControl, true);
  assert.deepEqual(await mod.handle('nope', { options: {} }), { ok: false, error: 'unknown action' });
  assert.match((await mod.handle('status', { options: {} })).error, /No oMLX server configured/);
});

test('status with the main key: bearer status merged with the admin activity, models, and device info', async () => {
  mod._resetForTests();
  const { server, state, url } = await fakeOmlx();
  try {
    const s = await mod.handle('status', { options: { url1: url, key1: 'main' }, query: { inst: '1' } });
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.admin, true);
    assert.equal(s.version, '0.6.4');
    assert.equal(s.uptimeSeconds, 3725);
    assert.deepEqual(s.counts, { discovered: 3, loaded: 1, loading: 0 });
    assert.equal(s.totals.requests, 42);
    assert.equal(s.totals.active, 1, 'admin totals win');
    assert.equal(s.totals.waiting, 1);
    assert.equal(s.tps.generation, 61.2);
    assert.equal(s.memory.max, '96.0 GB');
    assert.equal(s.memory.pressure.level, 'ok');
    assert.equal(s.models.length, 1);
    const m = s.models[0];
    assert.equal(m.id, 'mlx-community/qwen3-8b'); assert.equal(m.pinned, true); assert.equal(m.size, '8.0GB');
    assert.deepEqual(m.generating[0], { id: 'g1', elapsed: 4.2, tokens: 260, tps: 61.9, promptTokens: 1200, maxTokens: null });
    assert.deepEqual(m.waiting[0], { id: 'w1', position: 1, elapsed: 2.5, promptTokens: 900 });
    assert.deepEqual(s.available.map(a => a.id), ['mlx-community/gemma-3-27b', 'mlx-community/whisper-large'], 'loaded models are not offered to load');
    assert.equal(s.available[0].size, '17.0GB');
    assert.deepEqual(s.device, { chip: 'Apple M4 Max', memoryGb: 128, gpuCores: 40 });
    assert.equal(state.logins, 1);
    // the session is reused; an expired one is renewed once, transparently
    await mod.handle('status', { options: { url1: url, key1: 'main' }, query: { inst: '1' } });
    assert.equal(state.logins, 1);
    state.sessionValid = false;
    const again = await mod.handle('status', { options: { url1: url, key1: 'main' }, query: { inst: '1' } });
    assert.equal(again.admin, true); assert.equal(state.logins, 2);
    // unload goes through the session and names the model
    const u = await mod.handle('unload', { options: { url1: url, key1: 'main' }, query: { inst: '1', model: 'mlx-community/qwen3-8b' } });
    assert.equal(u.ok, true); assert.deepEqual(state.unloads, ['mlx-community/qwen3-8b']);
    const off = await mod.handle('load', { options: { url1: url, key1: 'main', allowControl: false }, query: { inst: '1', model: 'x' } });
    assert.match(off.error, /turned off/);
  } finally { server.close(); }
});

test('a sub key reads the status only and says why the admin data is missing; a wrong key and a dead port are named', async () => {
  mod._resetForTests();
  const { server, url } = await fakeOmlx();
  try {
    const s = await mod.handle('status', { options: { url1: url, key1: 'sub' }, query: { inst: '1' } });
    assert.equal(s.ok, true); assert.equal(s.admin, false);
    assert.match(s.adminNote, /main API key/);
    assert.equal(s.models[0].id, 'mlx-community/qwen3-8b', 'the loaded model still shows, from the bearer status');
    assert.equal(s.memory.pressure, null);
    const bad = await mod.handle('status', { options: { url1: url, key1: 'wrong' }, query: { inst: '1' } });
    assert.equal(bad.ok, false); assert.match(bad.error, /API key rejected/);
    const none = await mod.handle('status', { options: { url1: url }, query: { inst: '1' } });
    assert.match(none.error, /no API key set/);
  } finally { server.close(); }
  const dead = await mod.handle('status', { options: { url1: 'http://127.0.0.1:1', key1: 'main' }, query: { inst: '1' } });
  assert.equal(dead.ok, false); assert.match(dead.error, /not running or not reachable/);
});
