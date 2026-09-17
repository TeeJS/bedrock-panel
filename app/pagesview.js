function $(id) { return document.getElementById(id); }

// theme + options — host passes _dark=1/0 and _accent=#hex on the served query, same as every other
// app page; `order` is this app's one per-instance option (editor | alpha).
var ORDER = 'editor';
(function () {
  try {
    var q = new URLSearchParams(location.search);
    document.body.classList.toggle('light', q.get('_dark') === '0');
    var a = q.get('_accent') || '';
    if (/^#[0-9a-fA-F]{6}$/.test(a)) document.documentElement.style.setProperty('--accent', a);
    if (q.get('order') === 'alpha') ORDER = 'alpha';
  } catch (e) {}
})();

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// Guard against a navigation storm from repeated taps while the page is still on screen.
var navPending = false;
function goto(id) {
  if (navPending) return;
  navPending = true;
  fetch('/goto?id=' + encodeURIComponent(id), { cache: 'no-store' })
    .catch(function () {})
    .then(function () { setTimeout(function () { navPending = false; }, 400); });
}

// Auto-fit tuning. The floor T.J. signed off on: tiles never shrink below MIN_H / MIN_FS before the
// grid is allowed to fall back to scrolling (only an extreme page count ever reaches that).
var GAP = 8;          // px between tiles — kept tight so space goes to the tiles, not the gutters
var MIN_H = 52;       // smallest tile height we'll render before allowing scroll
var MIN_W = 150;      // narrowest tile width we'll accept for a column count
var MIN_FS = 16;      // smallest label size (px)
var MAX_FS = 26;      // largest label size (px)
var TARGET_ASPECT = 2.8;   // preferred tile width:height — wide buttons, like the rest of the panel

// Choose the columns x rows split that fills the card best for N tiles, then stretch the tiles to fill
// it. Runs on first render, on resize, and whenever the page list changes.
function layout(n) {
  var card = $('card'), grid = $('grid');
  if (!card || !grid || !n) return;
  var cs = getComputedStyle(card);
  var usableW = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  var usableH = card.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (usableW <= 0 || usableH <= 0) return;

  var fit = null, fallback = null;
  for (var c = 1; c <= n; c++) {
    var r = Math.ceil(n / c);
    var tw = (usableW - (c - 1) * GAP) / c;
    if (tw < MIN_W) continue;                       // columns too narrow to read
    var th = (usableH - (r - 1) * GAP) / r;
    if (th >= MIN_H) {
      // Fits without scrolling: prefer the split whose tile aspect is closest to TARGET_ASPECT.
      var score = Math.abs((tw / th) - TARGET_ASPECT);
      if (!fit || score < fit.score) fit = { c: c, r: r, th: th, score: score };
    } else if (!fallback) {
      // Widest layout that still meets MIN_W — used only if nothing fits (grid then scrolls).
      fallback = { c: c, r: r };
    }
  }

  grid.style.gap = GAP + 'px';
  if (fit) {
    grid.style.height = '100%';
    grid.style.gridTemplateColumns = 'repeat(' + fit.c + ', 1fr)';
    grid.style.gridTemplateRows = 'repeat(' + fit.r + ', 1fr)';
    grid.style.gridAutoRows = '';
    var fs = Math.max(MIN_FS, Math.min(MAX_FS, Math.round(fit.th * 0.30)));
    grid.style.setProperty('--name-fs', fs + 'px');
  } else {
    // Extreme count: minimum-size tiles, let #card scroll.
    var fb = fallback || { c: Math.max(1, Math.floor((usableW + GAP) / (MIN_W + GAP))) };
    grid.style.height = 'auto';
    grid.style.gridTemplateColumns = 'repeat(' + fb.c + ', 1fr)';
    grid.style.gridTemplateRows = '';
    grid.style.gridAutoRows = MIN_H + 'px';
    grid.style.setProperty('--name-fs', MIN_FS + 'px');
  }
}

var lastKey = '';
var currentCount = 0;
function render(list) {
  list = Array.isArray(list) ? list.slice() : [];
  if (ORDER === 'alpha') {
    list.sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    });
  }
  // Skip a re-render (which would drop focus/press feedback) when nothing that affects the DOM changed.
  var key = ORDER + '|' + list.map(function (p) { return p.id + ':' + (p.name || ''); }).join(',');
  if (key === lastKey) return;
  lastKey = key;
  currentCount = list.length;

  var grid = $('grid');
  if (!list.length) {
    grid.style.height = '';
    grid.innerHTML = '<div class="empty">No pages yet — add pages in the editor.</div>';
    return;
  }
  grid.innerHTML = list.map(function (p) {
    return '<button type="button" class="tile" data-id="' + esc(p.id) + '">'
      + '<span class="name">' + esc(p.name || p.id) + '</span>'
      + '</button>';
  }).join('');
  Array.prototype.forEach.call(grid.querySelectorAll('.tile'), function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.getAttribute('data-id');
      if (id) goto(id);
    });
  });
  layout(list.length);
}

// Re-fit when the viewport changes (theme swap, orientation, software-window pane resize).
var relayoutT = null;
window.addEventListener('resize', function () {
  clearTimeout(relayoutT);
  relayoutT = setTimeout(function () { layout(currentCount); }, 100);
});

function load() {
  fetch('/pagelist', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) { render((d && d.pages) || []); })
    .catch(function () {});
}

load();
setInterval(load, 4000);
