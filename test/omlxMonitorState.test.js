'use strict';
// community-apps/omlx-monitor/state.js — the page's pure state: per-model state words, the Activity
// summary, freshness/connection labels, memory view. Snapshot shapes match what server.js returns.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../community-apps/omlx-monitor/state.js');

const ok = extra => Object.assign({ ok: true, inst: 1, name: 'mac', admin: true, models: [], available: [], totals: { active: 0, waiting: 0 }, counts: { discovered: 3, loaded: 1, loading: 0 }, defaultModel: '' }, extra);
const model = extra => Object.assign({ id: 'mlx-community/qwen3-8b', loaded: true, loading: false, activeRequests: 0, waitingRequests: 0, generating: [], waiting: [], prefilling: 0, size: '8.0 GB' }, extra);

test('formatters: tokens, durations, basename, cache efficiency fraction vs percent', () => {
  assert.equal(S.tok(999), '999'); assert.equal(S.tok(12345), '12k'); assert.equal(S.tok(2500000), '2.5M');
  assert.equal(S.dur(42), '42s'); assert.equal(S.dur(125), '2m 5s'); assert.equal(S.dur(3725), '1h 2m');
  assert.equal(S.short('mlx-community/qwen3-8b'), 'qwen3-8b'); assert.equal(S.short('plain'), 'plain');
  assert.equal(S.cachePct(0.41), '41%'); assert.equal(S.cachePct(41), '41%'); assert.equal(S.cachePct(null), '—'); assert.equal(S.cachePct(0), '0%');
});

test('modelState: loading, generating, prefilling, busy, waiting, idle, and Loaded when admin data is absent', () => {
  const snap = ok();
  assert.deepEqual(S.modelState(model({ loading: true, loadingRemaining: 90 }), snap, null), { key: 'loading', label: 'Loading', detail: '~1m 30s left', tone: 'accent' });
  assert.equal(S.modelState(model({ loading: true, loadingElapsed: 12 }), snap, null).detail, '12s elapsed');
  const gen = S.modelState(model({ activeRequests: 2, waitingRequests: 1, generating: [{ id: 'a', tps: 30.25 }, { id: 'b', tps: 31 }] }), snap, null);
  assert.equal(gen.key, 'generating'); assert.equal(gen.detail, '2 requests · 61.3 tok/s · 1 waiting');
  assert.equal(S.modelState(model({ activeRequests: 1, prefilling: 1 }), snap, null).key, 'prefilling');
  assert.equal(S.modelState(model({ activeRequests: 1 }), snap, null).key, 'busy');
  assert.equal(S.modelState(model({ waitingRequests: 3 }), snap, null).key, 'waiting');
  assert.deepEqual(S.modelState(model({ ttlRemaining: 300 }), snap, null), { key: 'idle', label: 'Idle', detail: 'unloads in 5m 0s', tone: '' });
  assert.equal(S.modelState(model({ idleSeconds: 61 }), snap, null).detail, 'idle 1m 1s');
  // status-only: per-model zeros are placeholders, never Idle
  assert.equal(S.modelState(model(), ok({ admin: false }), null).key, 'loaded');
  // a pending unload wins over everything the snapshot says
  assert.equal(S.modelState(model({ activeRequests: 1 }), snap, { action: 'unload', state: 'pending' }).key, 'unloading');
});

test('modelMeta: size, Pinned, Default, and the unload countdown only when idle', () => {
  const snap = ok({ defaultModel: 'mlx-community/qwen3-8b' });
  const m = model({ pinned: true, ttlRemaining: 120 });
  assert.equal(S.modelMeta(m, snap, S.modelState(m, snap, null)), '8.0 GB · Pinned · Default · unloads in 2m 0s');
  const busy = model({ activeRequests: 1, ttlRemaining: 120 });
  assert.equal(S.modelMeta(busy, snap, S.modelState(busy, snap, null)), '8.0 GB · Default');
});

test('actionView: hidden without admin or control; plain, armed, and pending labels', () => {
  assert.equal(S.actionView('unload', null, false, ok({ admin: false }), true), null);
  assert.equal(S.actionView('unload', null, false, ok(), false), null);
  assert.equal(S.actionView('unload', null, false, { ok: false, admin: true }, true), null);
  assert.deepEqual(S.actionView('load', null, false, ok(), true), { label: 'Load', tone: 'go', disabled: false });
  assert.deepEqual(S.actionView('unload', null, false, ok(), true), { label: 'Unload', tone: 'quiet', disabled: false });
  assert.deepEqual(S.actionView('unload', null, true, ok(), true), { label: 'Confirm unload', tone: 'confirm', disabled: false });
  assert.deepEqual(S.actionView('load', null, true, ok(), true), { label: 'Confirm load', tone: 'go', disabled: false });
  assert.deepEqual(S.actionView('unload', { action: 'unload', state: 'pending' }, false, ok(), true), { label: 'Unloading…', tone: 'pending', disabled: true });
});

test('activitySummary: connecting, offline, starting, unavailable, none, loading, idle, active rows in order', () => {
  assert.equal(S.activitySummary(null).kind, 'connecting');
  assert.deepEqual(S.activitySummary({ ok: false, error: 'not reachable' }), { kind: 'error', title: 'Offline', text: 'not reachable', rows: [] });
  assert.equal(S.activitySummary({ ok: false, starting: true, error: 'starting up' }).title, 'Starting');
  const sub = S.activitySummary(ok({ admin: false, adminNote: 'needs the main key', models: [model()] }));
  assert.equal(sub.kind, 'unavailable'); assert.equal(sub.text, 'needs the main key'); assert.equal(sub.rows.length, 0);
  assert.deepEqual(S.activitySummary(ok({ models: [], available: [{ id: 'x' }] })), { kind: 'none', title: 'No model loaded', text: 'Load one from Available', rows: [] });
  assert.equal(S.activitySummary(ok({ models: [], available: [] })).text, 'No models discovered');
  assert.equal(S.activitySummary(ok({ models: [model({ loading: true })] })).kind, 'loading');
  assert.deepEqual(S.activitySummary(ok({ models: [model()] })), { kind: 'idle', title: 'Idle', text: 'No requests in progress', rows: [] });
  const act = S.activitySummary(ok({ totals: { active: 2, waiting: 1 }, models: [model({ activeRequests: 2, waitingRequests: 1, prefilling: 1,
    generating: [{ id: 'g1', elapsed: 4.2, tokens: 260, tps: 61.9, promptTokens: 1200 }],
    waiting: [{ id: 'w1', position: 1, elapsed: 2.5, promptTokens: 900 }] })] }));
  assert.equal(act.kind, 'active'); assert.equal(act.text, '2 active · 1 waiting');
  assert.deepEqual(act.rows.map(r => [r.key, r.phase]), [['g:g1', 'generating'], ['p:mlx-community/qwen3-8b:0', 'prefilling'], ['w:w1', 'waiting']]);
  assert.equal(act.rows[0].model, 'qwen3-8b'); assert.equal(act.rows[0].tps, 61.9); assert.equal(act.rows[2].position, 1);
});

test('activityCount and modelsCount read the bearer totals, so they work in status-only mode', () => {
  assert.equal(S.activityCount(ok({ admin: false, totals: { active: 1, waiting: 2 } })), '1 active · 2 waiting');
  assert.equal(S.activityCount({ ok: false }), '');
  assert.equal(S.modelsCount(ok({ counts: { discovered: 3, loaded: 1, loading: 1 } })), '1 of 3 loaded · 1 loading');
  assert.equal(S.modelsCount(ok({ counts: null, models: [model()] })), '1 loaded');
});

test('freshness: threshold max(15, 3x poll); stale past it; age text; connection labels', () => {
  const t0 = 1_000_000;
  assert.deepEqual(S.freshness(null, t0, 2), { ageSeconds: null, threshold: 15, stale: false });
  assert.deepEqual(S.freshness(t0 - 4000, t0, 2), { ageSeconds: 4, threshold: 15, stale: false });
  assert.deepEqual(S.freshness(t0 - 16000, t0, 2), { ageSeconds: 16, threshold: 15, stale: true });
  assert.equal(S.freshness(t0, t0, 10).threshold, 30);
  assert.equal(S.ageText(0), 'just now'); assert.equal(S.ageText(4), '4s ago'); assert.equal(S.ageText(null), '');
  assert.deepEqual(S.connectionLabel(null, null), { label: 'Connecting', dot: 'unknown' });
  assert.deepEqual(S.connectionLabel({ ok: false, starting: true }, null), { label: 'Starting', dot: 'warn' });
  assert.deepEqual(S.connectionLabel({ ok: false }, null), { label: 'Offline', dot: 'bad' });
  assert.deepEqual(S.connectionLabel(ok(), { stale: true }), { label: 'Stale', dot: 'warn' });
  assert.deepEqual(S.connectionLabel(ok(), { stale: false }), { label: 'Connected', dot: 'ok' });
  // pressure is a memory warning, not a connectivity change
  assert.equal(S.healthDot(ok({ memory: { pressure: { enabled: true, level: 'hard' } } })), 'ok');
});

test('memoryView: percent of a known ceiling, no ceiling, pressure tone', () => {
  assert.deepEqual(S.memoryView({ usedBytes: 8, maxBytes: 96, used: '8.0 GB', max: '96.0 GB', pressure: { enabled: true, level: 'ok' } }), { used: '8.0 GB', max: '96.0 GB', pct: 8, ceiling: '8% of ceiling', level: 'ok', tone: '' });
  assert.deepEqual(S.memoryView({ usedBytes: 8, maxBytes: null, used: '8.0 GB', max: 'unlimited', pressure: null }), { used: '8.0 GB', max: 'unlimited', pct: null, ceiling: 'No configured ceiling', level: null, tone: '' });
  assert.equal(S.memoryView({ usedBytes: 90, maxBytes: 96, pressure: { enabled: true, level: 'hard' } }).tone, 'bad');
  assert.equal(S.memoryView({ usedBytes: 85, maxBytes: 96, pressure: { enabled: true, level: 'soft' } }).tone, 'warn');
  assert.equal(S.memoryView(null).used, '—');
});
