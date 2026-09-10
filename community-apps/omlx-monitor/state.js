'use strict';
// oMLX Monitor — pure state and formatting for the panel page. No DOM, no fetch: app.js feeds it the
// snapshot that server.js returns and draws what comes back, and test/omlxMonitorState.test.js runs
// the same functions under node. Loaded by index.html as a plain script (the drop-in CSP allows only
// 'self' scripts) and by node through module.exports.
//
// Known limitation, recorded on purpose: server.js folds a missing numeric field to 0 (its num()), so
// a per-model activeRequests of 0 cannot by itself prove the model is idle. The snapshot's `admin`
// flag is what says whether per-model activity was actually read; every function here checks it
// before claiming Idle. [MIT]
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OmlxState = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ---- formatters ----
  const intc = n => Math.round(Number(n) || 0).toLocaleString('en-US');
  const short = id => { const s = String(id || ''); const i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; };
  const dur = s => {
    s = Math.max(0, Math.round(Number(s) || 0));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    const h = Math.floor(s / 3600); return h + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  };
  const tok = n => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : intc(n); };
  const tps1 = n => (Number(n) || 0).toFixed(1);
  // oMLX reports cache_efficiency as a fraction (0.41) in the versions seen so far; a value above 1 is
  // taken as an already-scaled percentage. Same rule app.js 1.0.1 used — kept until confirmed otherwise.
  const cachePct = v => (v == null || !isFinite(Number(v))) ? '—' : Math.round(Number(v) * (Number(v) <= 1 ? 100 : 1)) + '%';

  // ---- memory ----
  // { used, max, pct|null, ceiling, level|null, tone }  tone: '' | 'warn' | 'bad'
  function memoryView(mem) {
    const m = mem || {};
    const pct = m.maxBytes ? Math.min(100, Math.round(100 * (Number(m.usedBytes) || 0) / m.maxBytes)) : null;
    const level = m.pressure && m.pressure.enabled ? (m.pressure.level || 'ok') : null;
    const tone = level === 'hard' || level === 'critical' ? 'bad' : level === 'soft' || level === 'warning' ? 'warn' : '';
    const ceiling = pct == null ? 'No configured ceiling' : pct + '% of ceiling';
    return { used: m.used || '—', max: m.max || '—', pct, ceiling, level, tone };
  }

  // ---- per-model state ----
  // cmd: the page's pending command for this model, { action, state: 'pending'|'failed', error } or null.
  // Returns { key, label, detail, tone } — key is one of
  //   loading | unloading | generating | prefilling | busy | waiting | idle | loaded
  function modelState(m, snap, cmd) {
    m = m || {}; snap = snap || {};
    if (cmd && cmd.state === 'pending' && cmd.action === 'unload') return { key: 'unloading', label: 'Unloading', detail: '', tone: 'accent' };
    if (m.loading) {
      const detail = m.loadingRemaining != null ? '~' + dur(m.loadingRemaining) + ' left' : m.loadingElapsed != null ? dur(m.loadingElapsed) + ' elapsed' : '';
      return { key: 'loading', label: 'Loading', detail, tone: 'accent' };
    }
    const gen = m.generating || [];
    if (gen.length) {
      const tps = gen.reduce((a, g) => a + (Number(g.tps) || 0), 0);
      const extra = [m.prefilling ? m.prefilling + ' prefilling' : '', m.waitingRequests ? m.waitingRequests + ' waiting' : ''].filter(Boolean).join(' · ');
      return { key: 'generating', label: 'Generating', detail: [gen.length + (gen.length === 1 ? ' request' : ' requests'), tps1(tps) + ' tok/s', extra].filter(Boolean).join(' · '), tone: 'ok' };
    }
    if (m.prefilling) return { key: 'prefilling', label: 'Prefilling', detail: m.prefilling + (m.prefilling === 1 ? ' request' : ' requests') + (m.waitingRequests ? ' · ' + m.waitingRequests + ' waiting' : ''), tone: 'ok' };
    if (m.activeRequests) return { key: 'busy', label: 'Busy', detail: m.activeRequests + ' active' + (m.waitingRequests ? ' · ' + m.waitingRequests + ' waiting' : ''), tone: 'ok' };
    if (m.waitingRequests) return { key: 'waiting', label: 'Waiting', detail: m.waitingRequests + ' queued', tone: 'warn' };
    if (snap.admin) return { key: 'idle', label: 'Idle', detail: m.ttlRemaining != null ? 'unloads in ' + dur(m.ttlRemaining) : m.idleSeconds != null ? 'idle ' + dur(m.idleSeconds) : '', tone: '' };
    return { key: 'loaded', label: 'Loaded', detail: '', tone: '' };
  }

  // Metadata line under a loaded model's name: size, flags, then the unload countdown when Idle.
  function modelMeta(m, snap, state) {
    m = m || {}; snap = snap || {};
    const parts = [m.size, m.pinned ? 'Pinned' : '', snap.defaultModel && snap.defaultModel === m.id ? 'Default' : ''];
    if (state && state.key === 'idle' && state.detail) parts.push(state.detail);
    return parts.filter(Boolean).join(' · ');
  }

  // Load / Unload button text and tone for a model given the pending command.
  // Returns null when no button should show. armed = first tap done, waiting for the confirming tap.
  function actionView(action, cmd, armed, snap, allowControl) {
    if (allowControl === false || !snap || !snap.admin || !snap.ok) return null;
    if (cmd && cmd.state === 'pending') return { label: action === 'unload' ? 'Unloading…' : 'Loading…', tone: 'pending', disabled: true };
    if (armed) return { label: action === 'unload' ? 'Confirm unload' : 'Confirm load', tone: action === 'unload' ? 'confirm' : 'go', disabled: false };
    return { label: action === 'unload' ? 'Unload' : 'Load', tone: action === 'unload' ? 'quiet' : 'go', disabled: false };
  }

  // ---- activity ----
  // { kind, title, text, rows: [{ key, model, phase, tps, tokens, promptTokens, elapsed, position }] }
  // kind: connecting | error | unavailable | none | loading | idle | active
  function activitySummary(snap) {
    if (!snap) return { kind: 'connecting', title: 'Connecting', text: 'Waiting for the first answer', rows: [] };
    if (!snap.ok) return { kind: 'error', title: snap.starting ? 'Starting' : 'Offline', text: snap.error || '', rows: [] };
    const models = snap.models || [];
    const rows = [];
    for (const m of models) {
      for (const g of m.generating || []) rows.push({ key: 'g:' + g.id, model: short(m.id), modelId: m.id, phase: 'generating', tps: Number(g.tps) || 0, tokens: Number(g.tokens) || 0, promptTokens: Number(g.promptTokens) || 0, elapsed: g.elapsed == null ? null : Number(g.elapsed), position: null });
      for (let i = 0; i < (Number(m.prefilling) || 0); i++) rows.push({ key: 'p:' + m.id + ':' + i, model: short(m.id), modelId: m.id, phase: 'prefilling', tps: null, tokens: null, promptTokens: null, elapsed: null, position: null });
      for (const w of m.waiting || []) rows.push({ key: 'w:' + w.id, model: short(m.id), modelId: m.id, phase: 'waiting', tps: null, tokens: null, promptTokens: Number(w.promptTokens) || 0, elapsed: w.elapsed == null ? null : Number(w.elapsed), position: w.position == null ? null : Number(w.position) });
    }
    const t = snap.totals || {};
    if (!snap.admin) return { kind: 'unavailable', title: 'Activity details unavailable', text: snap.adminNote || 'The main API key unlocks per-request activity.', rows: [] };
    if (rows.length) return { kind: 'active', title: 'Active', text: (t.active || 0) + ' active · ' + (t.waiting || 0) + ' waiting', rows };
    const loading = models.filter(m => m.loading);
    if (loading.length) return { kind: 'loading', title: 'Loading', text: loading.map(m => short(m.id)).join(', '), rows: [] };
    if (!models.length) return { kind: 'none', title: 'No model loaded', text: (snap.available || []).length ? 'Load one from Available' : 'No models discovered', rows: [] };
    return { kind: 'idle', title: 'Idle', text: 'No requests in progress', rows: [] };
  }

  // Heading count for the Activity section; uses the bearer totals so it works in status-only mode.
  function activityCount(snap) {
    if (!snap || !snap.ok) return '';
    const t = snap.totals || {};
    return (t.active || 0) + ' active · ' + (t.waiting || 0) + ' waiting';
  }

  // ---- freshness / connection ----
  // lastGoodAt: ms timestamp of the last successful snapshot for this server (null if none).
  function freshness(lastGoodAt, now, refreshSeconds) {
    const threshold = Math.max(15, 3 * (Number(refreshSeconds) || 2));
    if (lastGoodAt == null) return { ageSeconds: null, threshold, stale: false };
    const ageSeconds = Math.max(0, Math.floor((now - lastGoodAt) / 1000));
    return { ageSeconds, threshold, stale: ageSeconds > threshold };
  }
  function ageText(ageSeconds) {
    if (ageSeconds == null) return '';
    if (ageSeconds < 1) return 'just now';
    return dur(ageSeconds) + ' ago';
  }
  // { label, dot }  label: Connecting | Starting | Connected | Stale | Offline ; dot: unknown | ok | warn | bad
  function connectionLabel(snap, fresh) {
    if (!snap) return { label: 'Connecting', dot: 'unknown' };
    if (!snap.ok) return snap.starting ? { label: 'Starting', dot: 'warn' } : { label: 'Offline', dot: 'bad' };
    if (fresh && fresh.stale) return { label: 'Stale', dot: 'warn' };
    return { label: 'Connected', dot: 'ok' };
  }
  // Tab dot for a server: memory pressure does not change connectivity, so it stays 'ok'.
  function healthDot(snap) { return !snap ? 'unknown' : !snap.ok ? (snap.starting ? 'warn' : 'bad') : 'ok'; }

  function modelsCount(snap) {
    if (!snap || !snap.ok) return '';
    const c = snap.counts, loaded = (snap.models || []).length;
    let s = c ? c.loaded + ' of ' + c.discovered + ' loaded' : loaded + ' loaded';
    if (c && c.loading) s += ' · ' + c.loading + ' loading';
    return s;
  }

  return { intc, short, dur, tok, tps1, cachePct, memoryView, modelState, modelMeta, actionView, activitySummary, activityCount, freshness, ageText, connectionLabel, healthDot, modelsCount };
});
