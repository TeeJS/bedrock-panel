'use strict';
// oMLX Monitor — panel page. Polls /app-api/status for the selected server and draws three regions:
// context (memory, totals, throughput), models (loaded first, then available), requests in flight.
// Nothing is shown as a number until the server has answered; a server that cannot be reached keeps
// the layout and says so in the context column.
const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const RUNNING_VERSION = '1.0.0';

// Theme from the host: dark/light and the runtime accent, with a contrast-safe foreground.
document.documentElement.dataset.theme = params.get('_dark') === '0' ? 'light' : 'dark';
(function accent() {
  const a = params.get('_accent'); if (!a || !/^#?[0-9a-f]{6}$/i.test(a)) return;
  const hex = a.replace('#', ''); const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  document.documentElement.style.setProperty('--accent', '#' + hex);
  document.documentElement.style.setProperty('--accent-fg', lum > 0.55 ? '#06111a' : '#ffffff');
})();

let instances = [], inst = null, refreshSeconds = 2, allowControl = true, timer = null;
let pending = null;   // { inst, model, action, until } — a tapped Load/Unload waiting for its second tap
let last = null;

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const intc = n => Math.round(Number(n) || 0).toLocaleString();
const short = id => { const s = String(id || ''); const i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; };
const dur = s => { s = Math.max(0, Math.round(Number(s) || 0)); if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's'; const h = Math.floor(s / 3600); return h + 'h ' + Math.floor((s % 3600) / 60) + 'm'; };
const tok = n => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : intc(n); };

async function apiCall(action, extra) {
  const url = new URL('/app-api/' + action, location.origin);
  Object.entries(extra || {}).forEach(([k, v]) => { if (v != null && v !== '') url.searchParams.set(k, v); });
  const res = await fetch(url.pathname + url.search, { cache: 'no-store' });
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch (e) { return { ok: false, error: 'bad response' }; }
}

function renderTabs() {
  const el = $('#tabs');
  if (instances.length < 2) { el.innerHTML = ''; return; }
  el.innerHTML = instances.map(i => `<button type="button" data-inst="${i.inst}" class="${inst && inst.inst === i.inst ? 'sel' : ''}"><span class="dot ${i.dot || 'unknown'}"></span>${esc(i.name)}</button>`).join('');
}
function healthDot(s) { return !s ? 'unknown' : !s.ok ? 'bad' : (s.memory && s.memory.pressure && s.memory.pressure.level !== 'ok') ? 'warn' : 'ok'; }

function renderCtx(s) {
  const el = $('#ctx');
  if (!s || !s.ok) {
    el.innerHTML = `<div class="problem ${s && s.starting ? '' : 'err'}"><b>${esc(s && s.name || (inst && inst.name) || 'oMLX')}</b>${esc(s && s.error || 'waiting for the first answer…')}</div>`;
    return;
  }
  const m = s.memory || {};
  const pct = m.maxBytes ? Math.min(100, Math.round(100 * m.usedBytes / m.maxBytes)) : null;
  const lvl = m.pressure && m.pressure.enabled ? m.pressure.level : null;
  const barCls = lvl === 'hard' || lvl === 'critical' ? 'bad' : lvl === 'soft' || lvl === 'warning' ? 'warn' : '';
  const t = s.totals || {}, tps = s.tps || {};
  el.innerHTML = `
    <div class="mem"><div class="label">Model memory</div>
      <div class="big">${esc(m.used || '—')} <small>/ ${esc(m.max || '—')}</small></div>
      <div class="bar"><i class="${barCls}" style="width:${pct == null ? 0 : pct}%"></i></div>
      <div class="pressure">${lvl ? `pressure <span class="pill ${barCls || 'ok'}">${esc(lvl)}</span>` : pct == null ? 'no memory ceiling' : pct + '% of the ceiling'}</div></div>
    <div class="stats">
      <div class="stat"><div class="v">${intc(t.requests)}</div><div class="k">requests this session</div></div>
      <div class="stat"><div class="v">${t.cacheEfficiency != null ? Math.round(t.cacheEfficiency * (t.cacheEfficiency <= 1 ? 100 : 1)) + '%' : '—'}</div><div class="k">prompt cache hits</div></div>
      <div class="stat"><div class="v">${tok(t.promptTokens)}</div><div class="k">prompt tokens</div></div>
      <div class="stat"><div class="v">${tok(t.completionTokens)}</div><div class="k">generated tokens</div></div>
    </div>
    <div class="tps">prefill <b>${intc(tps.prefill)}</b> tok/s · generation <b>${(Number(tps.generation) || 0).toFixed(1)}</b> tok/s</div>`;
}

function actionButton(s, model, action) {
  if (!allowControl || !s.admin) return '';
  const p = pending && pending.inst === s.inst && pending.model === model && pending.action === action && pending.until > Date.now() ? pending : null;
  const label = p ? (action === 'unload' ? 'Unload?' : 'Load?') : (action === 'unload' ? 'Unload' : 'Load');
  return `<button type="button" class="act ${p ? (action === 'unload' ? 'confirm' : 'go') : ''}" data-model="${esc(model)}" data-action="${action}">${label}</button>`;
}
function renderModels(s) {
  const el = $('#modelList');
  if (!s || !s.ok) { el.innerHTML = `<div class="empty"><div class="glyph"></div>${s ? 'no data' : 'connecting…'}</div>`; $('#modelCount').textContent = ''; return; }
  const loaded = s.models || [];
  $('#modelCount').textContent = (s.counts ? s.counts.loaded + ' of ' + s.counts.discovered + ' loaded' : loaded.length + ' loaded') + (s.counts && s.counts.loading ? ', ' + s.counts.loading + ' loading' : '');
  let html = loaded.map(m => {
    const gen = m.generating || [], tpsSum = gen.reduce((a, g) => a + (g.tps || 0), 0);
    const status = m.loading
      ? `<span class="pill accent">loading${m.loadingRemaining != null ? ' · ~' + dur(m.loadingRemaining) + ' left' : m.loadingElapsed != null ? ' · ' + dur(m.loadingElapsed) : ''}</span>`
      : m.activeRequests ? `<span class="pill ok">busy</span>` : `<span class="pill">idle${m.ttlRemaining != null ? ' · unloads in ' + dur(m.ttlRemaining) : ''}</span>`;
    const live = m.loading ? '' : `<div class="live">${m.activeRequests ? `<b>${m.activeRequests}</b> active` : ''}${m.waitingRequests ? ` · <b>${m.waitingRequests}</b> waiting` : ''}${tpsSum ? ` · <b>${tpsSum.toFixed(1)}</b> tok/s` : ''}${m.prefilling ? ` · prefilling ${m.prefilling}` : ''}</div>`;
    const meta = [m.size, m.pinned ? 'pinned' : '', s.defaultModel === m.id ? 'default' : '', m.idleSeconds != null && !m.activeRequests ? 'idle ' + dur(m.idleSeconds) : ''].filter(Boolean).join(' · ');
    return `<div class="row"><div class="main"><div class="name" title="${esc(m.id)}">${esc(short(m.id))}</div><div class="meta">${esc(meta) || '&nbsp;'}</div></div>${live}${status}${m.loading ? '' : actionButton(s, m.id, 'unload')}</div>`;
  }).join('');
  if (!loaded.length) html += `<div class="empty" style="height:120px"><div class="glyph"></div>no model loaded</div>`;
  const avail = s.available || [];
  if (avail.length) {
    html += `<div class="subhead">Available · ${avail.length}</div>` + avail.map(m =>
      `<div class="row avail"><div class="main"><div class="name" title="${esc(m.id)}">${esc(short(m.id))}</div><div class="meta">${esc([m.size, m.type].filter(Boolean).join(' · ')) || '&nbsp;'}</div></div>${actionButton(s, m.id, 'load')}</div>`).join('');
  } else if (s.admin === false && s.adminNote) {
    html += `<div class="subhead">${esc(s.adminNote)}</div>`;
  }
  el.innerHTML = html;
}
function renderLive(s) {
  const el = $('#liveList');
  if (!s || !s.ok) { el.innerHTML = `<div class="empty"><div class="glyph"></div>${s ? '—' : 'connecting…'}</div>`; $('#liveCount').textContent = ''; return; }
  const rows = [];
  for (const m of s.models || []) {
    for (const g of m.generating || []) rows.push(`<div class="req"><div class="who">${esc(short(m.id))}<small>${g.promptTokens ? tok(g.promptTokens) + ' prompt · ' : ''}${g.elapsed != null ? dur(g.elapsed) : ''}</small></div><div class="n">${intc(g.tokens)}<small>tokens</small></div><div class="n">${(g.tps || 0).toFixed(1)}<small>tok/s</small></div></div>`);
    for (let i = 0; i < (m.prefilling || 0); i++) rows.push(`<div class="req"><div class="who">${esc(short(m.id))}<small>prefilling</small></div><div class="n">…<small>prompt</small></div></div>`);
    for (const w of m.waiting || []) rows.push(`<div class="req wait"><div class="who">${esc(short(m.id))}<small>waiting · #${w.position} · ${dur(w.elapsed)}</small></div><div class="n">${tok(w.promptTokens)}<small>prompt</small></div></div>`);
  }
  const t = s.totals || {};
  $('#liveCount').textContent = rows.length ? `${t.active || 0} active · ${t.waiting || 0} waiting` : (s.admin ? '' : `${t.active || 0} active · ${t.waiting || 0} waiting`);
  el.innerHTML = rows.length ? rows.join('') : `<div class="empty"><div class="glyph"></div>nothing in flight</div>`;
}
function renderDevice(s) {
  const d = s && s.device;
  const up = s && s.ok ? `v${esc(s.version)} · up ${dur(s.uptimeSeconds)}` : '';
  $('#device').textContent = [d && d.chip ? d.chip + (d.memoryGb ? ' · ' + d.memoryGb + ' GB' : '') + (d.gpuCores ? ' · ' + d.gpuCores + ' GPU cores' : '') : '', s && s.url ? s.url.replace(/^https?:\/\//, '') : ''].filter(Boolean).join('  ·  ');
  $('#healthText').textContent = s && s.ok ? up : (s && s.error) ? 'unreachable' : 'connecting…';
  $('#health .dot').className = 'dot ' + healthDot(s);
}
function render(s) {
  last = s;
  renderCtx(s); renderModels(s); renderLive(s); renderDevice(s);
  const i = instances.find(x => x.inst === (s && s.inst)); if (i) { i.dot = healthDot(s); renderTabs(); }
}
function stampUpdated() { $('#updated').textContent = 'updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

let inFlight = false;
async function refresh() {
  if (!inst || inFlight) return;
  inFlight = true;
  try { const s = await apiCall('status', { inst: inst.inst }); if (s && s.inst === inst.inst || !s.inst) render(s); stampUpdated(); }
  catch (e) { render({ ok: false, inst: inst.inst, name: inst.name, error: String(e && e.message || e) }); }
  finally { inFlight = false; }
}
function selectInstance(n) {
  const next = instances.find(i => i.inst === Number(n)); if (!next) return;
  inst = next; pending = null; renderTabs(); render(null); refresh();
}

$('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-inst]'); if (b) selectInstance(b.dataset.inst); });
$('#modelList').addEventListener('click', async e => {
  const b = e.target.closest('button.act'); if (!b || !last || !last.ok) return;
  const model = b.dataset.model, action = b.dataset.action;
  const armed = pending && pending.inst === last.inst && pending.model === model && pending.action === action && pending.until > Date.now();
  if (!armed) { pending = { inst: last.inst, model, action, until: Date.now() + 4000 }; renderModels(last); setTimeout(() => { if (pending && pending.until <= Date.now()) { pending = null; if (last) renderModels(last); } }, 4100); return; }
  pending = null; b.disabled = true; b.textContent = action === 'unload' ? 'Unloading…' : 'Loading…';
  const r = await apiCall(action, { inst: last.inst, model }).catch(err => ({ ok: false, error: String(err && err.message || err) }));
  if (!r || !r.ok) { $('#healthText').textContent = (action + ' failed: ' + (r && r.error || 'unknown')).slice(0, 80); }
  setTimeout(refresh, 400);
});

window.oqKnob = function (ev) {
  if (ev.type === 'rotate') {
    if (instances.length > 1) { const i = instances.findIndex(x => inst && x.inst === inst.inst); selectInstance(instances[(i + (ev.dir > 0 ? 1 : -1) + instances.length) % instances.length].inst); return true; }
    const el = $('#modelList'); el.scrollTop += (ev.dir > 0 ? 1 : -1) * 80; return true;
  }
  if (ev.type === 'press' && ev.index === 1) { refresh(); return true; }
  return false;
};

setInterval(async () => {
  try { const m = await (await fetch('app.json', { cache: 'no-store' })).json(); if (m.version && m.version !== RUNNING_VERSION) location.reload(); } catch (e) {}
}, 30000);

(async function boot() {
  render(null);
  const cfg = await apiCall('instances').catch(() => null);
  if (!cfg || !cfg.ok || !cfg.instances.length) { render({ ok: false, name: 'oMLX', error: (cfg && cfg.error) || 'No oMLX server configured — set Server 1 URL and API key in this page\'s settings.' }); return; }
  instances = cfg.instances; refreshSeconds = Math.max(1, Number(cfg.refreshSeconds) || 2); allowControl = cfg.allowControl !== false;
  inst = instances[0]; renderTabs(); refresh();
  timer = setInterval(refresh, refreshSeconds * 1000);
})();
