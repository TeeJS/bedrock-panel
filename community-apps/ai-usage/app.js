'use strict';

const RUNNING_VERSION = '1.0.7';
const params = new URLSearchParams(location.search);
const refreshSeconds = Math.max(15, Math.min(300, parseInt(params.get('refreshSeconds'), 10) || 30));
const PERIODS = ['today', '7d', '30d', 'all'];
const PERIOD_LABEL = { today: 'today', '7d': '7 days', '30d': '30 days', all: 'all time' };
const ACCENT = { claude: '#e08a5c', codex: '#19c39a', copilot: '#a179f2' };

let period = PERIODS.includes(params.get('period')) ? params.get('period') : '7d';

const $ = s => document.querySelector(s);
const grid = $('#grid');

// ── Formatting ──────────────────────────────────────────────────────────────
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function num(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function intc(n) { return (Number(n) || 0).toLocaleString(); }
function resetIn(sec) {
  if (!sec) return '';
  let ms = sec * 1000 - Date.now();
  if (ms <= 0) return 'now';
  const d = Math.floor(ms / 86400000); ms -= d * 86400000;
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}
function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
function shortModel(m) { return String(m || '').replace(/^claude-/, ''); }
function cap(s) { s = String(s || ''); return s ? s[0].toUpperCase() + s.slice(1) : ''; }
function levelColor(pct) { return pct >= 90 ? 'var(--error)' : pct >= 70 ? 'var(--warning)' : 'var(--success)'; }

function ring(label, pct, resetsAt, opts) {
  opts = opts || {};
  const has = typeof pct === 'number';
  const p = has ? Math.max(0, Math.min(100, pct)) : 0;
  const col = has ? levelColor(pct) : 'var(--track)';
  const resetLine = resetsAt ? 'resets in <b>' + resetIn(resetsAt) + '</b>' : (opts.resetText || '&nbsp;');
  return '<div class="gauge"><div class="glabel">' + label + '</div>'
    + '<div class="ring' + (opts.big ? ' big' : '') + '" style="--pct:' + p + ';--ring:' + col + '">'
    + '<div class="hole"><span class="val">' + (has ? Math.round(pct) + '<span class="u">%</span>' : '&mdash;') + '</span>'
    + (opts.sub ? '<span class="sub">' + opts.sub + '</span>' : '') + '</div></div>'
    + '<div class="reset' + (resetsAt ? '' : ' none') + '">' + resetLine + '</div></div>';
}
function bigstat(v, l) { return '<div class="bigstat"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>'; }
function head(name, sub, chip, chipCls) {
  return '<div class="phead"><div class="pname"><b>' + name + '</b><span>' + sub + '</span></div>'
    + (chip ? '<div class="pchip ' + (chipCls || '') + '">' + chip + '</div>' : '') + '</div>';
}
function card(accent, inner) { return '<section class="panel" style="--accent:' + accent + '">' + inner + '</section>'; }
function errState(msg) { return '<div class="state err"><h3>Error</h3><p>' + esc(msg) + '</p></div>'; }

// ── Cards ───────────────────────────────────────────────────────────────────
function claudeCard(d) {
  if (!d.ok) return card(ACCENT.claude, head('Claude', 'Code &middot; Cowork', '') + errState(d.error));
  if (d.limit) {
    const g = '<div class="gauges">'
      + ring('5-hour', d.limit.fiveHourPct, d.limit.fiveHourResetsAt)
      + ring('Weekly', d.limit.weeklyPct, d.limit.weeklyResetsAt) + '</div>';
    return card(ACCENT.claude, head('Claude', 'Code &middot; Cowork', d.plan ? cap(d.plan) + ' plan' : '', 'good')
      + g + statRow(d.msgs, d.inp + d.out + d.cacheRead + d.cacheWrite, d.sessions));
  }
  const top = d.models && d.models[0] ? shortModel(d.models[0].model) : '&mdash;';
  return card(ACCENT.claude,
    head('Claude', 'Code &middot; Cowork', intc(d.sessions) + ' sessions')
    + '<div class="hero"><div class="hnum">' + intc(d.msgs) + '</div><div class="hlbl">Messages &middot; ' + PERIOD_LABEL[period] + '</div></div>'
    + '<div class="subrow">'
    + bigstat(num(d.inp + d.out + d.cacheRead + d.cacheWrite), 'Tokens')
    + bigstat(intc(d.sessions), 'Sessions')
    + bigstat(esc(top), 'Top model') + '</div>'
    + '<div class="foot">' + (d.limitError ? esc(d.limitError) : '5-hour &amp; weekly limits &mdash; enable in options') + '</div>');
}

function codexCard(d) {
  if (!d.ok) return card(ACCENT.codex, head('ChatGPT', 'Codex CLI', '') + errState(d.error));
  const lim = d.limit;
  const chip = lim && lim.model ? esc(lim.model) : '';
  // The rate-limit % is account-global but read from this machine's newest local
  // snapshot — flag its age so a stale machine's gauge is self-explanatory.
  // Show the signed-in account when live, and clearly mark any non-live reading as a
  // snapshot — so a machine whose live call is failing can't masquerade as fresh, and
  // a different signed-in account is obvious.
  let sub = 'Codex CLI';
  if (lim && lim.live) sub = 'Codex CLI &middot; ' + esc(lim.email || 'live');
  else if (lim && lim.at) sub = 'Codex CLI &middot; snapshot, ' + ago(Date.now() - lim.at);
  let gauges;
  if (lim && (typeof lim.weeklyPct === 'number' || typeof lim.shortPct === 'number')) {
    const parts = [];
    if (lim.hasShort && typeof lim.shortPct === 'number') parts.push(ring('5-hour', lim.shortPct, lim.shortResetsAt));
    if (typeof lim.weeklyPct === 'number') parts.push(ring('Weekly', lim.weeklyPct, lim.weeklyResetsAt));
    gauges = '<div class="gauges">' + parts.join('') + '</div>';
  } else {
    gauges = '<div class="hero"><div class="hnum">' + intc(d.msgs) + '</div><div class="hlbl">Messages &middot; ' + PERIOD_LABEL[period] + '</div></div>';
  }
  return card(ACCENT.codex, head('ChatGPT', sub, chip) + gauges + statRow(d.msgs, d.tokens, d.sessions));
}

function copilotCard(d) {
  if (!d.ok) return card(ACCENT.copilot, head('Copilot', 'GitHub', 'error', 'err') + errState(d.error || 'failed'));
  const included = Number(d.included) || 0;
  const used = Number(d.used) || 0;
  const remaining = Math.max(0, included - used);
  const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).getTime() / 1000;
  let body;
  if (included > 0) {
    const pct = used / included * 100;
    body = '<div class="gauges one"><div class="gauge"><div class="glabel">This month</div>'
      + '<div class="ring big" style="--pct:' + Math.min(100, pct).toFixed(1) + ';--ring:' + levelColor(pct) + '">'
      + '<div class="hole"><span class="val">' + Math.round(pct) + '<span class="u">%</span></span><span class="sub">of quota</span></div></div>'
      + '<div class="reset">resets in <b>' + resetIn(monthEnd) + '</b></div></div>'
      + '<div class="sideblock"><div class="row"><b>' + intc(used) + '</b> used</div>'
      + '<div class="row"><b>' + intc(remaining) + '</b> left of ' + intc(included) + '</div>'
      + (d.net > 0 ? '<div class="row">overage <b>$' + d.net.toFixed(2) + '</b></div>' : '') + '</div></div>';
  } else {
    body = '<div class="hero"><div class="hnum">' + intc(used) + '</div><div class="hlbl">premium requests &middot; this month</div></div>';
  }
  return card(ACCENT.copilot, head('Copilot', 'GitHub', '@' + esc(d.user), 'good') + body);
}

function statRow(msgs, tokens, sessions) {
  return '<div class="subrow">'
    + bigstat(intc(msgs), 'Messages &middot; ' + PERIOD_LABEL[period])
    + bigstat(num(tokens), 'Tokens')
    + bigstat(intc(sessions), 'Sessions') + '</div>';
}

// ── Data loop ────────────────────────────────────────────────────────────────
async function apiCall(action, extra) {
  const url = new URL('/app-api/' + action, location.origin);
  Object.entries(extra || {}).forEach(([k, v]) => { if (v != null && v !== '') url.searchParams.set(k, v); });
  const res = await fetch(url.pathname + url.search, { cache: 'no-store' });
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch (e) { return { ok: false, error: 'bad response' }; }
}
function stampUpdated() {
  const t = new Date();
  $('#updated').innerHTML = 'updated ' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '<span class="dot"></span>';
}
async function refreshAll() {
  const dot = $('#updated').querySelector('.dot'); if (dot) dot.className = 'dot busy';
  const [c, x, p] = await Promise.all([
    apiCall('claude', { period }).catch(e => ({ ok: false, error: String(e.message || e) })),
    apiCall('codex', { period }).catch(e => ({ ok: false, error: String(e.message || e) })),
    apiCall('copilot').catch(e => ({ ok: false, error: String(e.message || e) })),
  ]);
  const cards = [];
  // Show a service only when it has real data (or errored) — never an empty/placeholder panel.
  if (c.ok ? (c.files > 0 || c.limit) : true) cards.push(claudeCard(c));
  if (x.ok ? (x.files > 0 || x.limit) : true) cards.push(codexCard(x));
  if (p.configured) cards.push(copilotCard(p));       // hidden entirely when GitHub isn't set up
  if (!cards.length) {
    cards.push(card('#7f8c8b', '<div class="state"><h3>No AI usage found</h3><p>No Claude&nbsp;Code or Codex logs on this machine yet, and Copilot isn&rsquo;t connected.</p></div>'));
  }
  grid.style.gridTemplateColumns = 'repeat(' + cards.length + ', 1fr)';
  grid.innerHTML = cards.join('');
  stampUpdated();
}
function applyPeriod(pd) {
  if (!PERIODS.includes(pd)) return;
  period = pd;
  document.querySelectorAll('#periods button').forEach(b => b.classList.toggle('sel', b.dataset.p === pd));
  refreshAll();
}

$('#periods').addEventListener('click', e => {
  const b = e.target.closest('button[data-p]');
  if (b) applyPeriod(b.dataset.p);
});

window.oqKnob = function (ev) {
  if (ev.type === 'rotate') {
    let i = PERIODS.indexOf(period) + (ev.dir > 0 ? 1 : -1);
    applyPeriod(PERIODS[(i + PERIODS.length) % PERIODS.length]);
    return true;
  }
  if (ev.type === 'press' && ev.index === 1) { refreshAll(); return true; }
  return false;
};

document.documentElement.dataset.theme = params.get('_dark') === '0' ? 'light' : 'dark';
$('#brandtag').textContent = 'Claude · ChatGPT · Copilot';

setInterval(async () => {
  try {
    const m = await (await fetch('app.json', { cache: 'no-store' })).json();
    if (m.version && m.version !== RUNNING_VERSION) location.reload();
  } catch (e) {}
}, 30000);

document.querySelectorAll('#periods button').forEach(b => b.classList.toggle('sel', b.dataset.p === period));
grid.innerHTML = card('#7f8c8b', '<div class="state"><div class="scan"></div><p>Scanning session logs&hellip;</p></div>');
refreshAll();
setInterval(refreshAll, refreshSeconds * 1000);
