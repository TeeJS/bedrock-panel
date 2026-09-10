'use strict';
// oMLX Monitor — panel page. Polls /app-api/status for the selected server every refreshSeconds and
// draws four regions on the 1920×480 panel: header (server, connection, update age, Details), context
// (model memory, server-average throughput), Models (loaded then Available, keyed rows), Activity
// (what is running now, then the session totals). State words come from state.js; this file only
// owns fetching, the DOM, and the page-side bookkeeping:
//   perInst   — per server: last answer, last good answer + its time, so a failure keeps "Last known"
//   commands  — Load/Unload in progress or failed, keyed inst:model:action, so a poll never forgets one
//   armed     — the first tap of a two-tap action, waiting 4 s for the confirming tap
//   seq       — a sequence per refresh; an answer for an older request or another server is dropped
// Rows are reconciled by key (model id / request id) and updated in place, so focus, scroll position,
// and a pending button survive the 2-second poll.
const S = window.OmlxState;
const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const RUNNING_VERSION = '1.1.0';

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
const perInst = new Map();     // inst -> { last, lastGood, lastGoodAt, seq }
const commands = new Map();    // "inst:model:action" -> { inst, model, action, state: 'pending'|'failed', error, afterSeq }
let armed = null;              // { inst, model, action, until }
let seq = 0;                   // global refresh counter

const state = n => { let p = perInst.get(n); if (!p) { p = { last: null, lastGood: null, lastGoodAt: null, seq: 0 }; perInst.set(n, p); } return p; };
const cmdKey = (n, model, action) => n + ':' + model + ':' + action;
const setText = (el, text) => { text = text == null ? '' : String(text); if (el.textContent !== text) el.textContent = text; };
const setHidden = (el, hidden) => { if (el.hidden !== !!hidden) el.hidden = !!hidden; };
const setClass = (el, cls) => { if (el.className !== cls) el.className = cls; };

async function apiCall(action, extra) {
  const url = new URL('/app-api/' + action, location.origin);
  Object.entries(extra || {}).forEach(([k, v]) => { if (v != null && v !== '') url.searchParams.set(k, v); });
  const ctl = new AbortController(); const kill = setTimeout(() => ctl.abort(), 60000);   // a hung request must not hold the connection forever
  let text;
  try { const res = await fetch(url.pathname + url.search, { cache: 'no-store', signal: ctl.signal }); text = await res.text(); }
  finally { clearTimeout(kill); }
  try { return text ? JSON.parse(text) : {}; } catch (e) { return { ok: false, error: 'bad response' }; }
}

// ---- keyed reconciliation: items carry .key; existing children with that data-key are reused ----
function reconcile(container, items, make, update) {
  const existing = new Map();
  for (const el of Array.from(container.children)) if (el.dataset.key) existing.set(el.dataset.key, el);
  items.forEach((it, i) => {
    let el = existing.get(it.key);
    if (el) existing.delete(it.key); else { el = make(it); el.dataset.key = it.key; }
    update(el, it);
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
  });
  for (const el of existing.values()) el.remove();
}
function h(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; }

// ---- header ----
function renderTabs() {
  const el = $('#tabs');
  const multi = instances.length > 1;
  setHidden($('#serverName'), multi || !inst);
  if (!multi) { el.replaceChildren(); if (inst) setText($('#serverName'), inst.name); return; }
  reconcile(el, instances.map(i => ({ key: 'inst:' + i.inst, i })), it => {
    const b = h('button'); b.type = 'button'; b.dataset.inst = it.i.inst; b.append(h('span', 'dot unknown'), h('span', 'nm')); return b;
  }, (b, it) => {
    setClass(b, inst && inst.inst === it.i.inst ? 'sel' : '');
    setClass(b.firstChild, 'dot ' + (S.healthDot(state(it.i.inst).last) || 'unknown'));
    setText(b.lastChild, it.i.name);
    if (b.getAttribute('aria-pressed') !== String(inst && inst.inst === it.i.inst)) b.setAttribute('aria-pressed', String(inst && inst.inst === it.i.inst));
  });
}
function renderConnection() {
  const p = inst ? state(inst.inst) : null;
  const snap = p ? p.last : null;
  const fresh = p ? S.freshness(p.lastGoodAt, Date.now(), refreshSeconds) : null;
  const c = S.connectionLabel(snap, fresh);
  setClass($('#connDot'), 'dot ' + c.dot);
  setText($('#connLabel'), c.label);
  setText($('#connAge'), fresh && fresh.ageSeconds != null ? 'updated ' + S.ageText(fresh.ageSeconds) : '');
  $('#conn').dataset.state = c.label.toLowerCase();
}

// ---- context column ----
function renderContext(snap, lastKnown) {
  const m = S.memoryView(snap && snap.ok ? snap.memory : null);
  setText($('#memUsed'), m.used); setText($('#memMax'), m.max);
  const bar = $('#memBar'); setClass(bar, m.tone); const w = (m.pct == null ? 0 : m.pct) + '%'; if (bar.style.width !== w) bar.style.width = w;
  const pr = $('#memPressure');
  if (!snap || !snap.ok) { setText(pr, '—'); setClass(pr, 'pressure'); }
  else if (m.level) { setText(pr, 'Pressure ' + m.level + (m.pct != null ? ' · ' + m.pct + '%' : '')); setClass(pr, 'pressure ' + (m.tone || 'ok')); }
  else { setText(pr, m.ceiling); setClass(pr, 'pressure'); }
  setHidden($('#memLastKnown'), !lastKnown);
  const t = snap && snap.ok ? (snap.tps || {}) : null;
  setText($('#tpsGen'), t ? S.tps1(t.generation) : '—');
  setText($('#tpsPre'), t ? S.intc(t.prefill) : '—');
  $('#mem').dataset.lastknown = lastKnown ? '1' : '0';
  $('#tps').dataset.lastknown = lastKnown ? '1' : '0';
  setHidden($('#tpsLastKnown'), !lastKnown);
}

// ---- models ----
function rowItems(snap, lastKnown) {
  if (!snap) return [{ key: 'empty', kind: 'empty', text: 'Connecting…' }];
  if (!snap.ok) return [{ key: 'empty', kind: 'empty', text: snap.starting ? 'Starting up…' : 'No data' }];
  const items = [];
  for (const m of snap.models || []) {
    const cmd = commands.get(cmdKey(snap.inst, m.id, 'unload')) || null;
    const st = S.modelState(m, snap, cmd);
    const isArmed = !!(armed && armed.inst === snap.inst && armed.model === m.id && armed.action === 'unload' && armed.until > Date.now());
    const act = m.loading || lastKnown ? null : S.actionView('unload', cmd, isArmed, snap, allowControl);
    items.push({ key: 'm:' + m.id, kind: 'loaded', id: m.id, name: S.short(m.id), st, meta: S.modelMeta(m, snap, st), action: 'unload', act, error: cmd && cmd.state === 'failed' ? cmd.error : '' });
  }
  const avail = snap.available || [];
  if (!(snap.models || []).length) items.push(avail.length ? { key: 'sub:none', kind: 'sub', text: 'No model loaded' } : { key: 'empty', kind: 'empty', text: 'No model loaded' });
  if (avail.length) {
    items.push({ key: 'sub:avail', kind: 'sub', text: 'Available · ' + avail.length });
    for (const m of avail) {
      const cmd = commands.get(cmdKey(snap.inst, m.id, 'load')) || null;
      const isArmed = !!(armed && armed.inst === snap.inst && armed.model === m.id && armed.action === 'load' && armed.until > Date.now());
      const act = lastKnown ? null : S.actionView('load', cmd, isArmed, snap, allowControl);
      const st = cmd && cmd.state === 'pending' ? { key: 'loading', label: 'Loading', detail: '', tone: 'accent' } : null;
      items.push({ key: 'm:' + m.id, kind: 'avail', id: m.id, name: S.short(m.id), st, meta: [m.size, m.type].filter(Boolean).join(' · '), action: 'load', act, error: cmd && cmd.state === 'failed' ? cmd.error : '' });
    }
  } else if (snap.admin === false) {
    items.push({ key: 'sub:note', kind: 'sub', text: 'Available models need the main API key' });
  }
  return items;
}
function makeRow(it) {
  if (it.kind === 'empty') { const e = h('div', 'empty'); e.append(h('div', 'text')); return e; }
  if (it.kind === 'sub') return h('div', 'subhead');
  const row = h('div', 'row');
  const main = h('div', 'main');
  const name = h('div', 'name'); name.append(h('span', 'nm'), h('span', 'pill state'));
  const meta = h('div', 'meta'); const err = h('button', 'err'); err.type = 'button'; err.title = 'Tap to dismiss'; meta.append(h('span', 'txt'), err);
  main.append(name, meta);
  const ctl = h('div', 'ctl');
  const act = h('button', 'act'); act.type = 'button';
  const info = h('button', 'info', 'i'); info.type = 'button'; info.setAttribute('aria-label', 'Model details');
  ctl.append(act, info);
  row.append(main, ctl);
  return row;
}
function updateRow(el, it) {
  if (it.kind === 'empty') { setText(el.firstChild, it.text); return; }
  if (it.kind === 'sub') { setText(el, it.text); return; }
  setClass(el, 'row ' + it.kind + (it.st ? ' is-' + it.st.key : '') + (it.error ? ' has-error' : ''));
  el.dataset.model = it.id;
  const name = el.querySelector('.nm'), pill = el.querySelector('.pill'), txt = el.querySelector('.meta .txt'), err = el.querySelector('.meta .err');
  setText(name, it.name); if (name.title !== it.id) name.title = it.id;
  // The pill carries the state word only; its detail (tok/s, queue, time left) leads the metadata line.
  if (it.st) { setHidden(pill, false); setText(pill, it.st.label); setClass(pill, 'pill state ' + (it.st.tone || '')); }
  else setHidden(pill, true);
  const detail = it.st && it.st.key !== 'idle' ? it.st.detail : '';
  setText(txt, [detail, it.meta].filter(Boolean).join(' · ')); setText(err, it.error || ''); setHidden(err, !it.error);
  if (it.error) { const t = it.error + ' — tap to dismiss'; if (err.title !== t) err.title = t; }
  const act = el.querySelector('.act'), info = el.querySelector('.info');
  act.dataset.model = it.id; act.dataset.action = it.action; info.dataset.model = it.id;
  if (it.act) { setHidden(act, false); setText(act, it.act.label); setClass(act, 'act ' + it.act.tone); if (act.disabled !== it.act.disabled) act.disabled = it.act.disabled; }
  else setHidden(act, true);
}
function renderModels(snap, lastKnown) {
  const el = $('#modelList');
  const top = el.scrollTop;
  reconcile(el, rowItems(snap, lastKnown), makeRow, updateRow);
  if (el.scrollTop !== top) el.scrollTop = top;
  setText($('#modelCount'), S.modelsCount(snap) + (lastKnown ? ' · last known' : ''));
}

// ---- activity ----
function renderActivity(snap, lastKnown, failed) {
  // On a failure with last-known data, the current-activity region reports the failure; the totals keep the last good numbers.
  const a = S.activitySummary(failed || snap);
  const cur = $('#activity');
  if (cur.dataset.kind !== a.kind) cur.dataset.kind = a.kind;
  setText($('#actTitle'), a.title); setText($('#actText'), a.text);
  const list = $('#reqList');
  setHidden(list, !a.rows.length);
  setHidden(cur.querySelector('.state'), !!a.rows.length);
  if (a.rows.length) {
    const top = list.scrollTop;
    reconcile(list, a.rows, () => {
      const r = h('div', 'req');
      const who = h('div', 'who'); who.append(h('span', 'nm'), h('small', 'phase'));
      const n1 = h('div', 'n'); n1.append(h('span', 'v'), h('small', 'u'));
      const n2 = h('div', 'n'); n2.append(h('span', 'v'), h('small', 'u'));
      r.append(who, n1, n2); return r;
    }, (r, it) => {
      setClass(r, 'req ' + it.phase);
      setText(r.querySelector('.who .nm'), it.model);
      const sub = it.phase === 'generating' ? ['Generating', it.promptTokens ? S.tok(it.promptTokens) + ' prompt' : '', it.elapsed != null ? S.dur(it.elapsed) : ''].filter(Boolean).join(' · ')
        : it.phase === 'prefilling' ? 'Prefilling'
        : ['Waiting', it.position != null ? '#' + it.position : '', it.elapsed != null ? S.dur(it.elapsed) : ''].filter(Boolean).join(' · ');
      setText(r.querySelector('.who .phase'), sub);
      const ns = r.querySelectorAll('.n');
      if (it.phase === 'generating') { setText(ns[0].firstChild, S.tps1(it.tps)); setText(ns[0].lastChild, 'tok/s'); setText(ns[1].firstChild, S.intc(it.tokens)); setText(ns[1].lastChild, 'tokens'); setHidden(ns[1], false); }
      else if (it.phase === 'waiting') { setText(ns[0].firstChild, S.tok(it.promptTokens)); setText(ns[0].lastChild, 'prompt'); setHidden(ns[1], true); }
      else { setText(ns[0].firstChild, '…'); setText(ns[0].lastChild, 'prompt'); setHidden(ns[1], true); }
    });
    if (list.scrollTop !== top) list.scrollTop = top;
  }
  setText($('#activityCount'), lastKnown ? S.activityCount(snap) + ' · last known' : S.activityCount(snap));
  const t = snap && snap.ok ? (snap.totals || {}) : null;
  setText($('#totRequests'), t ? S.intc(t.requests) : '—');
  setText($('#totCache'), t ? S.cachePct(t.cacheEfficiency) : '—');
  setText($('#totPrompt'), t ? S.tok(t.promptTokens) : '—');
  setText($('#totGen'), t ? S.tok(t.completionTokens) : '—');
  $('#totals').dataset.lastknown = lastKnown ? '1' : '0';
  setHidden($('#totLastKnown'), !lastKnown);
}

// ---- whole page ----
function render() {
  const p = inst ? state(inst.inst) : null;
  const last = p ? p.last : null;
  // A failed answer after a good one: draw the good one marked Last known, and let the header + Activity carry the failure.
  const lastKnown = !!(last && !last.ok && p.lastGood);
  const snap = lastKnown ? p.lastGood : last;
  renderTabs(); renderConnection();
  renderContext(snap, lastKnown);
  renderModels(snap, lastKnown);
  renderActivity(snap, lastKnown, lastKnown ? last : null);
}

let inFlightSince = 0, stalledRetryAt = 0;
async function refresh() {
  if (!inst) return;
  // One poll at a time — unless the previous one has stalled past the stale threshold. Then a fresh one
  // starts, and keeps retrying every third poll while the stall lasts; a late answer from the stalled
  // request is dropped by the sequence check below, so the page recovers within a few seconds of the host.
  if (inFlightSince) {
    const stalled = Date.now() - inFlightSince >= S.freshness(null, 0, refreshSeconds).threshold * 1000;
    if (!stalled || Date.now() < stalledRetryAt) return;
    stalledRetryAt = Date.now() + 3 * refreshSeconds * 1000;
  } else stalledRetryAt = 0;
  if (!inFlightSince) inFlightSince = Date.now();
  const n = inst.inst, mySeq = ++seq, p = state(n);
  p.seq = mySeq;
  let s;
  try { s = await apiCall('status', { inst: n }); }
  catch (e) { s = { ok: false, inst: n, name: inst.name, error: e && e.name === 'AbortError' ? 'no answer from the panel host' : String(e && e.message || e) }; }
  if (p.seq !== mySeq) return;                       // a newer request for this server is in flight or landed
  inFlightSince = 0;
  if (s && s.inst != null && Number(s.inst) !== n) return;   // answer for another server
  p.last = s;
  if (s && s.ok) {
    p.lastGood = s; p.lastGoodAt = Date.now();
    for (const [k, c] of commands) if (c.inst === n && c.state === 'pending' && c.afterSeq != null && mySeq > c.afterSeq) commands.delete(k);
  }
  if (inst && inst.inst === n) render();
  else renderTabs();
}
function selectInstance(n) {
  const next = instances.find(i => i.inst === Number(n)); if (!next || (inst && inst.inst === next.inst)) return;
  inst = next; armed = null; seq++;
  render(); refresh();
}

// ---- Details overlay ----
let overlayOpener = null;
function openDetails(title, pairs, opener, actions) {
  overlayOpener = opener || document.activeElement;
  setText($('#ovTitle'), title);
  const dl = $('#ovBody'); dl.replaceChildren();
  for (const [k, v] of pairs) { if (v == null || v === '') continue; dl.append(h('dt', null, k), h('dd', null, String(v))); }
  const acts = $('#ovActions'); acts.replaceChildren();
  for (const a of actions || []) { const b = h('button', null, a.label); b.type = 'button'; b.addEventListener('click', a.onClick); acts.append(b); }
  setHidden(acts, !(actions && actions.length));
  $('#sheet').scrollTop = 0;
  setHidden($('#overlay'), false);
  $('#ovClose').focus();
}
// Tab / Shift+Tab stay inside the open sheet (aria-modal); Escape closes.
function trapFocus(e) {
  const ov = $('#overlay'); if (ov.hidden || e.key !== 'Tab') return;
  const f = [...ov.querySelectorAll('button:not([hidden])')].filter(el => !el.disabled && el.offsetParent !== null);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === first || !ov.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !ov.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
}
function closeDetails() {
  if ($('#overlay').hidden) return;
  setHidden($('#overlay'), true);
  const o = overlayOpener; overlayOpener = null;
  if (o && document.contains(o) && typeof o.focus === 'function') o.focus();
}
function serverDetails() {
  const p = inst ? state(inst.inst) : null, s = p && (p.lastGood || p.last), d = s && s.device;
  return [['Server', inst ? inst.name : '—'], ['URL', inst ? inst.url : ''], ['Status', $('#connLabel').textContent + ($('#connAge').textContent ? ' · ' + $('#connAge').textContent : '')],
    ['Version', s && s.ok ? s.version : ''], ['Uptime', s && s.ok ? S.dur(s.uptimeSeconds) : ''],
    ['Chip', d && d.chip], ['Unified memory', d && d.memoryGb ? d.memoryGb + ' GB' : ''], ['GPU cores', d && d.gpuCores],
    ['Access', s && s.ok ? (s.admin ? 'Main key · admin data' : 'Status only' + (s.adminNote ? ' · ' + s.adminNote : '')) : ''],
    ['Last error', s && !s.ok ? s.error : (p && p.last && !p.last.ok ? p.last.error : '')]];
}
function failedCommand(n, id) { return ['load', 'unload'].map(a => commands.get(cmdKey(n, id, a))).find(c => c && c.state === 'failed') || null; }
function modelDetails(id) {
  const p = inst ? state(inst.inst) : null, s = p && (p.lastGood || p.last);
  const m = s && s.ok ? [].concat(s.models || [], s.available || []).find(x => x.id === id) : null;
  const loaded = !!(m && (s.models || []).includes(m));
  const st = loaded ? S.modelState(m, s, commands.get(cmdKey(s.inst, id, 'unload')) || null) : null;
  const admin = !!(s && s.admin);   // without the main key the per-model numbers are server.js placeholders, not facts
  const failed = inst ? failedCommand(inst.inst, id) : null;
  return [['Model', id], ['State', st ? st.label + (st.detail ? ' · ' + st.detail : '') : (m ? 'Available' : '')], ['Size', m && m.size], ['Type', m && m.type],
    ['Pinned', m && m.pinned ? 'yes' : ''], ['Default', s && s.defaultModel === id ? 'yes' : ''],
    ['Active requests', loaded ? (admin ? m.activeRequests : 'unavailable without the main API key') : ''], ['Waiting requests', loaded && admin ? m.waitingRequests : ''],
    ['Idle', admin && m && m.idleSeconds != null ? S.dur(m.idleSeconds) : ''], ['Unloads in', admin && m && m.ttlRemaining != null ? S.dur(m.ttlRemaining) : ''],
    ['Last action error', failed ? failed.error : '']];
}
function modelDetailActions(id) {
  const n = inst && inst.inst;
  return n != null && failedCommand(n, id) ? [{ label: 'Dismiss error', onClick: () => { for (const k of ['load', 'unload']) commands.delete(cmdKey(n, id, k)); render(); closeDetails(); } }] : [];
}

// ---- events ----
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-inst]'); if (b) selectInstance(b.dataset.inst); });
$('#detailsBtn').addEventListener('click', e => openDetails('Server', serverDetails(), e.currentTarget));
$('#ovClose').addEventListener('click', closeDetails);
$('#overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeDetails(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetails(); else trapFocus(e); });

$('#modelList').addEventListener('click', async e => {
  const info = e.target.closest('button.info');
  if (info) { openDetails('Model', modelDetails(info.dataset.model), info, modelDetailActions(info.dataset.model)); return; }
  const errEl = e.target.closest('.meta .err');
  if (errEl) { const row = errEl.closest('.row'); const id = row && row.dataset.model; for (const k of ['load', 'unload']) commands.delete(cmdKey(inst.inst, id, k)); render(); return; }
  const b = e.target.closest('button.act'); if (!b || !inst) return;
  const p = state(inst.inst), s = p.last;
  if (!s || !s.ok) return;
  const n = inst.inst, model = b.dataset.model, action = b.dataset.action, key = cmdKey(n, model, action);
  const cmd = commands.get(key);
  if (cmd && cmd.state === 'pending') return;
  if (cmd && cmd.state === 'failed') commands.delete(key);
  const isArmed = armed && armed.inst === n && armed.model === model && armed.action === action && armed.until > Date.now();
  if (!isArmed) {
    armed = { inst: n, model, action, until: Date.now() + 4000 }; render();
    setTimeout(() => { if (armed && armed.until <= Date.now()) { armed = null; render(); } }, 4100);
    return;
  }
  armed = null;
  commands.set(key, { inst: n, model, action, state: 'pending', error: '', afterSeq: null }); render();
  const r = await apiCall(action, { inst: n, model }).catch(err => ({ ok: false, error: String(err && err.message || err) }));
  const c = commands.get(key); if (!c) return;
  if (!r || !r.ok) { c.state = 'failed'; c.error = (action === 'unload' ? 'Unload failed: ' : 'Load failed: ') + (r && r.error || 'unknown'); }
  else c.afterSeq = seq;   // stays "pending" until a snapshot newer than this one lands
  render();
  setTimeout(refresh, 400);
});

window.oqKnob = function (ev) {
  if (!$('#overlay').hidden) {   // a dialog is open: the knob works the dialog, never the page behind it
    if (ev.type === 'rotate') { $('#sheet').scrollTop += (ev.dir > 0 ? 1 : -1) * 80; return true; }
    if (ev.type === 'press' && ev.index === 1) { closeDetails(); return true; }
    return false;
  }
  if (ev.type === 'rotate') {
    if (instances.length > 1) { const i = instances.findIndex(x => inst && x.inst === inst.inst); selectInstance(instances[(i + (ev.dir > 0 ? 1 : -1) + instances.length) % instances.length].inst); return true; }
    const el = $('#modelList'); el.scrollTop += (ev.dir > 0 ? 1 : -1) * 120; return true;
  }
  if (ev.type === 'press' && ev.index === 1) { refresh(); return true; }
  return false;
};

setInterval(renderConnection, 1000);   // the update age and Stale advance on their own, whatever polling does
setInterval(async () => {
  try { const m = await (await fetch('app.json', { cache: 'no-store' })).json(); if (m.version && m.version !== RUNNING_VERSION) location.reload(); } catch (e) {}
}, 30000);

(async function boot() {
  render();
  const cfg = await apiCall('instances').catch(() => null);
  if (!cfg || !cfg.ok || !cfg.instances.length) {
    instances = [{ inst: 0, name: 'oMLX', url: '' }]; inst = instances[0];
    state(0).last = { ok: false, inst: 0, name: 'oMLX', error: (cfg && cfg.error) || 'No oMLX server configured — set Server 1 URL and API key in this page\'s settings.' };
    render(); return;
  }
  instances = cfg.instances; refreshSeconds = Math.max(1, Number(cfg.refreshSeconds) || 2); allowControl = cfg.allowControl !== false;
  inst = instances[0]; render(); refresh();
  timer = setInterval(refresh, refreshSeconds * 1000);
})();
