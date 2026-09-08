'use strict';

(function () {
  const q = new URLSearchParams(location.search);
  const HOST = MAClient.baseUrl(q.get('host') || '');
  const WS_URL = MAClient.wsUrl(q.get('host') || '');
  const DEFAULT_PLAYER = String(q.get('defaultPlayer') || '').trim();
  const MOCK = q.get('mock') === '1' || q.get('mock') === 'true';
  const MOCK_STATE = q.get('mockState') || 'playing';
  const APP_ID = 'music-assistant';

  // ── theme ────────────────────────────────────────────────
  document.documentElement.dataset.theme = q.get('_dark') === '0' ? 'light' : 'dark';
  const accent = q.get('_accent');
  if (/^#[0-9a-fA-F]{6}$/.test(accent || '')) {
    document.documentElement.style.setProperty('--accent', accent);
    const r = parseInt(accent.slice(1, 3), 16) / 255;
    const g = parseInt(accent.slice(3, 5), 16) / 255;
    const b = parseInt(accent.slice(5, 7), 16) / 255;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.style.setProperty('--accent-fg', lum > 0.55 ? '#04121f' : '#f7f8f5');
  }

  const $ = s => document.querySelector(s);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  // ── state ────────────────────────────────────────────────
  const S = {
    client: null,
    status: 'connecting',
    statusDetail: '',
    players: new Map(),
    queues: new Map(),
    activePlayerId: null,
    activeQueueId: null,
    queueItems: [],
    progress: { elapsed: 0, ts: Date.now(), playing: false, duration: 0 },
    everLoaded: false,
    volDrag: null,
    lastQueueTouch: 0,
    idleTilesLoaded: false,
    lastSnapId: '',
    lastRing: '',
  };

  function snapKey() { return 'ma:' + HOST + ':' + DEFAULT_PLAYER; }
  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }

  function activePlayer() { return S.players.get(S.activePlayerId) || null; }
  function activeQueue() { return S.queues.get(S.activeQueueId) || null; }
  function fmt(sec) { return MAClient.formatDuration(sec); }
  function imageFor(item, size) { return MOCK ? '' : MAClient.imageUrl(HOST, item, size); }

  // ── artwork placeholder (monogram) ──────────────────────
  // Radio stations (and some library items) have missing or dead logo URLs;
  // MA's own apps show a generated placeholder rather than a broken image, so
  // we render a monogram behind every artwork and hide the <img> if it fails.
  function artHue(str) {
    let h = 0; const s = String(str || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function initials(str) {
    const words = String(str || '').replace(/[^\p{L}\p{N} ]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '♪';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  function monoHtml(name) {
    const h = artHue(name);
    return '<span class="mono" style="background:linear-gradient(135deg,hsl(' + h + ' 42% 30%),hsl(' + ((h + 40) % 360) + ' 46% 22%))">' + esc(initials(name)) + '</span>';
  }
  // CSP forbids inline onerror, so wire failure handlers after inserting markup:
  // a failed (or already-failed, from cache) art image is hidden, revealing the
  // monogram painted behind it.
  function wireArt(root) {
    (root || document).querySelectorAll('img[data-art]').forEach(img => {
      const hide = () => { img.style.display = 'none'; };
      img.addEventListener('error', hide);
      if (img.complete && img.naturalWidth === 0) hide();
    });
  }

  function itemTitle(qi) {
    if (!qi) return '';
    const mi = qi.media_item || qi;
    return mi.name || qi.name || '';
  }
  function itemArtist(qi) {
    if (!qi) return '';
    const mi = qi.media_item || qi;
    if (Array.isArray(mi.artists) && mi.artists.length) return mi.artists.map(a => a && a.name).filter(Boolean).join(', ');
    if (mi.artist_str) return mi.artist_str;
    if (mi.media_type === 'album' && mi.owner) return mi.owner;
    return '';
  }
  function itemAlbum(qi) {
    const mi = (qi && qi.media_item) || qi || {};
    return (mi.album && mi.album.name) || '';
  }
  function itemDuration(qi) {
    const mi = (qi && qi.media_item) || qi || {};
    return Number(qi && qi.duration) || Number(mi.duration) || 0;
  }

  // ── dirty-zone renderer ─────────────────────────────────
  const dirty = new Set();
  let flushQueued = false;
  const renderers = {};
  function invalidate() {
    for (const z of arguments) dirty.add(z);
    if (flushQueued) return;
    flushQueued = true;
    // setTimeout, not requestAnimationFrame: rAF never fires while the page is
    // hidden or not composited, which would leave a preloaded page stale.
    setTimeout(() => {
      flushQueued = false;
      const zones = Array.from(dirty);
      dirty.clear();
      for (const z of zones) { try { renderers[z](); } catch (e) { console.error('render', z, e); } }
    }, 16);
  }
  function invalidateAll() { invalidate('pill', 'now', 'transport', 'volume', 'queue', 'players'); }

  // ── status pill / state card / ring ──────────────────────
  const PILL = {
    ready: ['ok', 'Connected'], connecting: ['warn', 'Connecting'], authenticating: ['warn', 'Connecting'],
    reconnecting: ['err', 'Reconnecting'], 'auth-failed': ['err', 'Auth failed'],
    'setup-required': ['err', 'Setup needed'], unconfigured: ['warn', 'Not configured'], idle: ['warn', 'Offline'],
  };

  function emitRing(name) {
    if (name === S.lastRing) return;
    S.lastRing = name;
    console.log('OQX_RING::' + name);
  }

  renderers.pill = function renderPill() {
    const pill = $('#status-pill');
    const [cls, label] = PILL[S.status] || ['warn', S.status];
    pill.className = 'status-pill ' + cls;
    $('#status-text').textContent = MOCK && S.status === 'ready' ? 'Demo' : label;
    $('#deck').classList.toggle('stale', S.status !== 'ready');
    const disabled = S.status !== 'ready';
    document.querySelectorAll('#transport button, #volrow button, #dstm-btn, #queue-menu-btn, #fav-btn')
      .forEach(b => { b.disabled = disabled; });
    renderStateCard();
    const queue = activeQueue();
    if (S.status !== 'ready') emitRing('thinking');
    else if (queue && queue.state === 'playing') emitRing('speaking');
    else emitRing('idle');
  };

  function renderStateCard() {
    const card = $('#state-card');
    let title = '', body = '';
    if (S.status === 'unconfigured') {
      title = 'Connect Music Assistant';
      body = '<ol><li>Open this page’s options in the Bedrock Panel editor</li>' +
        '<li>Set the Music Assistant URL</li>' +
        '<li>Paste a long-lived token from Music Assistant → Settings → Profile</li></ol>';
    } else if (S.status === 'auth-failed' && S.statusDetail === 'token-missing') {
      title = 'Token needed';
      body = '<p>Create a long-lived token in Music Assistant under <b>Settings → Profile</b> and paste it into this page’s options in the editor.</p>';
    } else if (S.status === 'auth-failed') {
      title = 'Authentication failed';
      body = '<p>Music Assistant rejected the token' + (S.statusDetail ? ': ' + esc(S.statusDetail) : '') + '.</p><p>Check the token in this page’s options.</p>';
    } else if (S.status === 'setup-required') {
      title = 'Finish Music Assistant setup';
      body = '<p>The server at ' + esc(HOST) + ' has no users yet. Open it in a browser and finish onboarding first.</p>';
    } else if (S.status === 'reconnecting' && !S.everLoaded) {
      title = 'Can’t reach Music Assistant';
      body = '<p>No answer from ' + esc(HOST) + ' — retrying automatically.</p>';
    }
    card.hidden = !title;
    if (title) { $('#state-title').textContent = title; $('#state-body').innerHTML = body; }
  }

  // ── now playing ──────────────────────────────────────────
  renderers.now = function renderNow() {
    const queue = activeQueue();
    const item = queue && queue.current_item;
    // "idle" (scaled art + recently-played strip) only when NO track is loaded.
    // A stopped queue with a current item keeps the normal metadata layout.
    const idle = !item;
    document.body.classList.toggle('idle', idle);

    const cover = $('#cover');
    const art = item ? imageFor(item, 512) : '';
    if (!item) {
      if (!cover.querySelector('.ph')) cover.innerHTML = '<span class="ph">♪</span>';
      cover.dataset.key = '';
    } else {
      // Monogram behind the art so a missing/broken cover (radio!) degrades
      // to a placeholder instead of a broken image; keyed so ticks don't thrash.
      const key = itemTitle(item) + '|' + art;
      if (cover.dataset.key !== key) {
        cover.dataset.key = key;
        cover.innerHTML = monoHtml(itemTitle(item)) + (art ? '<img alt="" data-art src="' + esc(art) + '">' : '');
        wireArt(cover);
      }
    }

    $('#track-title').textContent = item ? itemTitle(item) : (idle ? 'Nothing playing' : ' ');
    $('#track-artist').textContent = item ? itemArtist(item) : '';
    $('#track-album').textContent = item ? itemAlbum(item) : '';
    $('#fav-btn').hidden = !item;

    S.progress.duration = itemDuration(item);
    $('#duration').textContent = S.progress.duration ? fmt(S.progress.duration) : '--:--';
    $('#progress-track').classList.toggle('unknown', !S.progress.duration);
    tickProgress();

    const snapId = item ? itemTitle(item) + '|' + itemArtist(item) : '';
    if (item && snapId !== S.lastSnapId) {
      S.lastSnapId = snapId;
      lsSet(snapKey() + ':snap', JSON.stringify({
        title: itemTitle(item), artist: itemArtist(item), album: itemAlbum(item), art, player: MAClient.playerName(activePlayer()),
      }));
    }
    if (idle && !S.idleTilesLoaded && S.status === 'ready') loadIdleTiles();
  };

  function paintSnapshot() {
    const raw = lsGet(snapKey() + ':snap');
    if (!raw) return;
    try {
      const snap = JSON.parse(raw);
      $('#track-title').textContent = snap.title || ' ';
      $('#track-artist').textContent = snap.artist || '';
      $('#track-album').textContent = snap.album || '';
      const cover = $('#cover');
      cover.innerHTML = monoHtml(snap.title) + (snap.art ? '<img alt="" data-art src="' + esc(snap.art) + '">' : '');
      cover.dataset.key = '';
      wireArt(cover);
    } catch (e) {}
  }

  async function loadIdleTiles() {
    S.idleTilesLoaded = true;
    let items = [];
    try { items = await S.client.request('music/recently_played_items', { limit: 4 }); } catch (e) { items = []; }
    const strip = $('#idle-strip');
    if (!Array.isArray(items) || !items.length) { strip.innerHTML = '<span class="idle-hint">Browse the library to start something</span>'; return; }
    strip.innerHTML = items.map((it, i) => {
      const art = imageFor(it, 80);
      return '<button class="idle-tile" type="button" data-idle="' + i + '" aria-label="Play ' + esc(itemTitle(it)) + '">' +
        monoHtml(itemTitle(it)) + (art ? '<img alt="" data-art src="' + esc(art) + '">' : '') + '</button>';
    }).join('') + '<span class="idle-hint">Recently played — tap to play</span>';
    strip.querySelectorAll('[data-idle]').forEach(btn => {
      btn.addEventListener('click', () => playMedia(items[Number(btn.dataset.idle)], 'play'));
    });
    wireArt(strip);
  }

  // ── progress tick (bypasses the render path) ─────────────
  function shownElapsed() {
    const p = S.progress;
    let e = p.elapsed + (p.playing ? (Date.now() - p.ts) / 1000 : 0);
    if (p.duration) e = Math.min(e, p.duration);
    return Math.max(0, e);
  }
  function tickProgress() {
    const p = S.progress;
    const e = shownElapsed();
    $('#elapsed').textContent = (p.duration || p.playing) ? fmt(e) : '--:--';
    if (p.duration) {
      const pct = Math.max(0, Math.min(100, (e / p.duration) * 100));
      $('#progress-fill').style.width = pct + '%';
      $('#progress-track').setAttribute('aria-valuenow', String(Math.round(pct)));
    } else {
      $('#progress-fill').style.width = '0%';
    }
  }
  setInterval(() => { if (!document.hidden) tickProgress(); }, 1000);

  // ── transport / volume ───────────────────────────────────
  renderers.transport = function renderTransport() {
    const queue = activeQueue();
    const playing = !!(queue && queue.state === 'playing');
    $('#play-btn').classList.toggle('toggled', playing);
    $('#play-btn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('#shuffle-btn').classList.toggle('on', !!(queue && queue.shuffle_enabled));
    const repeat = (queue && queue.repeat_mode) || 'off';
    $('#repeat-btn').classList.toggle('on', repeat !== 'off');
    $('#repeat-badge').hidden = repeat !== 'one';
  };

  renderers.volume = function renderVolume() {
    const p = activePlayer();
    const slider = $('#vol-slider');
    const grouped = !!(p && Array.isArray(p.group_childs) && p.group_childs.length);
    const level = p ? Number(grouped && p.group_volume != null ? p.group_volume : p.volume_level) : NaN;
    const known = p && Number.isFinite(level);
    slider.classList.toggle('unknown', !known);
    if (known && !S.volDrag) {
      $('#vol-fill').style.width = level + '%';
      $('#vol-thumb').style.left = level + '%';
    }
    $('#mute-btn').classList.toggle('on', !!(p && p.volume_muted));
  };

  // ── queue rail ───────────────────────────────────────────
  renderers.queue = function renderQueue() {
    const queue = activeQueue();
    const list = $('#queue-list');
    const items = S.queueItems;
    const currentId = queue && queue.current_item && queue.current_item.queue_item_id;
    const currentIndex = items.findIndex(it => it.queue_item_id === currentId);

    $('#queue-count').textContent = queue && queue.items ? queue.items + ' track' + (queue.items === 1 ? '' : 's') : '';
    const dstm = !!(queue && queue.dont_stop_the_music_enabled);
    $('#dstm-btn').classList.toggle('on', dstm);
    $('#dstm-btn').setAttribute('aria-pressed', String(dstm));

    $('#queue-empty').hidden = !!items.length;
    list.innerHTML = items.map((it, i) => {
      const cls = i === currentIndex ? ' now' : (currentIndex >= 0 && i < currentIndex ? ' played' : '');
      const art = imageFor(it, 80);
      return '<div class="qrow' + cls + '" data-qi="' + esc(it.queue_item_id) + '" data-i="' + i + '">' +
        '<span class="qthumb">' + monoHtml(itemTitle(it)) + (art ? '<img alt="" data-art src="' + esc(art) + '">' : '') + '</span>' +
        '<span class="qtxt"><span class="qtitle">' + esc(itemTitle(it)) + '</span>' +
        '<span class="qartist">' + esc(itemArtist(it)) + '</span></span>' +
        '<span class="qdur">' + (itemDuration(it) ? fmt(itemDuration(it)) : '') + '</span>' +
        '<span class="qhandle" aria-hidden="true">≡</span></div>';
    }).join('') + (queue && queue.items > items.length
      ? '<div class="list-note">Showing first ' + items.length + ' of ' + queue.items + '</div>' : '');
    wireArt(list);

    if (currentIndex >= 0 && Date.now() - S.lastQueueTouch > 5000) {
      const row = list.children[currentIndex];
      if (row) list.scrollTop = Math.max(0, row.offsetTop - list.clientHeight / 3);
    }
    syncQueueSbar();
  };

  // ── players rail ─────────────────────────────────────────
  function playerStateLine(p) {
    const queue = S.queues.get(p.player_id);
    const grouped = Array.isArray(p.group_childs) && p.group_childs.length;
    const state = queue && queue.state === 'playing' ? 'Playing' : queue && queue.state === 'paused' ? 'Paused' : p.powered === false ? 'Off' : 'Idle';
    const vol = Number.isFinite(Number(p.volume_level)) ? ' · ' + Math.round(p.volume_level) + '%' : '';
    return (grouped ? 'Group of ' + (p.group_childs.length + 1) + ' · ' : '') + state + vol;
  }

  renderers.players = function renderPlayers() {
    const p = activePlayer();
    $('#pcur-name').textContent = p ? MAClient.playerName(p) : '—';
    $('#pcur-state').textContent = p ? playerStateLine(p) : '';
    const others = Array.from(S.players.values()).filter(x => x.player_id !== S.activePlayerId && x.hidden !== true);
    $('#player-list').innerHTML = others.map(x => {
      const queue = S.queues.get(x.player_id);
      const on = queue && queue.state === 'playing';
      return '<button class="prow" type="button" data-player="' + esc(x.player_id) + '">' +
        '<span class="pdot' + (on ? ' on' : x.powered === false ? ' off' : '') + '"></span>' +
        '<span class="pname">' + esc(MAClient.playerName(x)) + '</span>' +
        '<span class="pvol">' + (Number.isFinite(Number(x.volume_level)) ? Math.round(x.volume_level) + '%' : '') + '</span></button>';
    }).join('') || '<div class="list-note">No other players</div>';
  };

  // ── commands ─────────────────────────────────────────────
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 3000);
  }

  async function cmd(command, args, patch) {
    if (patch) { try { patch(); } catch (e) {} }
    try {
      return await S.client.request(command, args);
    } catch (e) {
      if (e && e.message === 'not connected') toast('Not connected to Music Assistant');
      else { toast('Music Assistant: ' + (e.message || 'command failed')); loadSnapshotData(); }
      throw e;
    }
  }
  const swallow = () => {};

  function playerCmd(name, args, patch) {
    if (!S.activePlayerId) return Promise.resolve();
    return cmd('players/cmd/' + name, Object.assign({ player_id: S.activePlayerId }, args), patch).catch(swallow);
  }
  function queueCmd(name, args, patch) {
    if (!S.activeQueueId) return Promise.resolve();
    return cmd('player_queues/' + name, Object.assign({ queue_id: S.activeQueueId }, args), patch).catch(swallow);
  }
  function playMedia(item, option) {
    const media = item && (item.uri || item);
    return queueCmd('play_media', { media, option: option || 'play' });
  }

  function setVolume(level, targetId) {
    level = Math.max(0, Math.min(100, Math.round(level)));
    const id = targetId || S.activePlayerId;
    const p = S.players.get(id);
    if (!p) return;
    const grouped = !targetId && Array.isArray(p.group_childs) && p.group_childs.length;
    const command = grouped ? 'players/cmd/group_volume' : 'players/cmd/volume_set';
    cmd(command, { player_id: id, volume_level: level }, () => {
      if (grouped) p.group_volume = level; else p.volume_level = level;
      invalidate('volume', 'players');
    }).catch(swallow);
  }

  // ── client wiring ────────────────────────────────────────
  function onStatus(status, detail) {
    S.status = status;
    S.statusDetail = detail || '';
    invalidate('pill');
  }

  function loadToken() {
    if (MOCK) return Promise.resolve('demo');
    return fetch('/app-config?app=' + APP_ID, { cache: 'no-store' })
      .then(r => r.json())
      .then(cfg => (cfg && cfg.options && cfg.options.token) || '')
      .catch(() => '');
  }

  function wireClientEvents() {
    const c = S.client;
    c.on('connected', '*', () => { loadSnapshotData(); });
    c.on('disconnected', '*', () => { invalidate('pill'); });
    c.on('player_updated', '*', msg => {
      if (msg.data) S.players.set(msg.object_id, msg.data);
      if (msg.object_id === S.activePlayerId) invalidate('volume', 'players', 'pill');
      else invalidate('players');
      if (!$('#gpanel').classList.contains('open')) return;
      renderGroupPanel();
    });
    c.on('player_added', '*', msg => { if (msg.data) S.players.set(msg.object_id, msg.data); invalidate('players'); });
    c.on('player_removed', '*', msg => {
      S.players.delete(msg.object_id);
      if (msg.object_id === S.activePlayerId) loadSnapshotData();
      else invalidate('players');
    });
    c.on('queue_updated', '*', msg => {
      if (!msg.data) return;
      S.queues.set(msg.object_id, msg.data);
      if (msg.object_id !== S.activeQueueId) { invalidate('players'); return; }
      const queue = msg.data;
      S.progress.elapsed = Number(queue.elapsed_time) || 0;
      S.progress.ts = Date.now();
      S.progress.playing = queue.state === 'playing';
      invalidate('now', 'transport', 'queue', 'pill');
    });
    let itemsTimer = null;
    c.on('queue_items_updated', '*', msg => {
      if (msg.data) S.queues.set(msg.object_id, msg.data);
      if (msg.object_id !== S.activeQueueId) return;
      clearTimeout(itemsTimer);
      itemsTimer = setTimeout(loadQueueItems, 300);
    });
    c.on('queue_time_updated', '*', msg => {
      if (msg.object_id !== S.activeQueueId) return;
      S.progress.elapsed = Number(msg.data) || 0;
      S.progress.ts = Date.now();
      S.progress.playing = true;
    });
    c.on('media_item_played', '*', () => { S.idleTilesLoaded = false; if (window.LibraryView) window.LibraryView.invalidateCache('recent'); });
    ['media_item_added', 'media_item_updated', 'media_item_deleted', 'music_sync_completed'].forEach(ev => {
      c.on(ev, '*', () => { if (window.LibraryView) window.LibraryView.invalidateCache('*'); });
    });
  }

  async function loadSnapshotData() {
    if (S.status !== 'ready') return;
    try {
      const [players, queues] = await Promise.all([
        S.client.request('players/all'),
        S.client.request('player_queues/all'),
      ]);
      S.players = new Map((players || []).map(p => [p.player_id, p]));
      S.queues = new Map((queues || []).map(x => [x.queue_id, x]));
      S.everLoaded = true;

      const lastUsed = lsGet(snapKey() + ':player');
      const picked = MAClient.pickPlayer(players || [], DEFAULT_PLAYER, lastUsed);
      await selectPlayer(picked, true);
    } catch (e) {
      console.error('snapshot load failed', e);
    }
  }

  async function selectPlayer(playerId, silent) {
    S.activePlayerId = playerId;
    if (playerId) lsSet(snapKey() + ':player', playerId);
    S.activeQueueId = null;
    S.queueItems = [];
    if (playerId) {
      try {
        const queue = await S.client.request('player_queues/get_active_queue', { player_id: playerId });
        if (queue) {
          S.queues.set(queue.queue_id, queue);
          S.activeQueueId = queue.queue_id;
          S.progress.elapsed = Number(queue.elapsed_time) || 0;
          S.progress.ts = Date.now();
          S.progress.playing = queue.state === 'playing';
          await loadQueueItems();
        }
      } catch (e) { if (!silent) toast('Couldn’t load the queue'); }
    }
    invalidateAll();
  }

  async function loadQueueItems() {
    if (!S.activeQueueId) { S.queueItems = []; invalidate('queue'); return; }
    try {
      const items = await S.client.request('player_queues/items', { queue_id: S.activeQueueId, limit: 200, offset: 0 });
      S.queueItems = Array.isArray(items) ? items : [];
    } catch (e) { S.queueItems = []; }
    invalidate('queue', 'now');
  }

  // ── sliders (volume + scrub) ─────────────────────────────
  function wireSlider(el, opts) {
    const track = el.querySelector('.bar-track');
    let dragging = null;
    let lastSend = 0;
    function pct(ev) {
      const r = track.getBoundingClientRect();
      return Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100));
    }
    el.addEventListener('pointerdown', ev => {
      if (el.classList.contains('unknown')) return;
      dragging = ev.pointerId;
      el.classList.add('dragging');
      try { el.setPointerCapture(ev.pointerId); } catch (e) {}
      opts.onMove(pct(ev));
    });
    el.addEventListener('pointermove', ev => {
      if (dragging !== ev.pointerId) return;
      const value = pct(ev);
      opts.onMove(value);
      if (opts.onDrag && Date.now() - lastSend > 100) { lastSend = Date.now(); opts.onDrag(value); }
    });
    function finish(ev) {
      if (dragging !== ev.pointerId) return;
      dragging = null;
      el.classList.remove('dragging');
      opts.onEnd(pct(ev));
    }
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', ev => { if (dragging === ev.pointerId) { dragging = null; el.classList.remove('dragging'); } });
  }

  wireSlider($('#vol-slider'), {
    onMove(v) {
      S.volDrag = v;
      $('#vol-fill').style.width = v + '%';
      $('#vol-thumb').style.left = v + '%';
    },
    onDrag(v) { setVolume(v); },
    onEnd(v) { S.volDrag = null; setVolume(v); },
  });

  wireSlider($('#scrub-hit'), {
    onMove(v) {
      if (!S.progress.duration) return;
      $('#progress-fill').style.width = v + '%';
      $('#elapsed').textContent = fmt((v / 100) * S.progress.duration);
    },
    onEnd(v) {
      if (!S.progress.duration) return;
      const position = Math.round((v / 100) * S.progress.duration);
      S.progress.elapsed = position;
      S.progress.ts = Date.now();
      queueCmd('seek', { position });
    },
  });

  // ── custom queue scrollbar ───────────────────────────────
  function syncQueueSbar() {
    const list = $('#queue-list');
    const sbar = $('#queue-sbar');
    const thumb = $('#queue-sbar-thumb');
    const overflow = list.scrollHeight - list.clientHeight;
    sbar.classList.toggle('hidden', overflow <= 4);
    if (overflow <= 4) return;
    const h = Math.max(64, (list.clientHeight / list.scrollHeight) * sbar.clientHeight);
    thumb.style.height = h + 'px';
    thumb.style.top = ((list.scrollTop / overflow) * (sbar.clientHeight - h)) + 'px';
  }
  $('#queue-list').addEventListener('scroll', syncQueueSbar);
  (function wireSbar() {
    const list = $('#queue-list');
    const sbar = $('#queue-sbar');
    const thumb = $('#queue-sbar-thumb');
    let drag = null;
    sbar.addEventListener('pointerdown', ev => {
      S.lastQueueTouch = Date.now();
      const tr = thumb.getBoundingClientRect();
      if (ev.clientY >= tr.top && ev.clientY <= tr.bottom) {
        drag = { id: ev.pointerId, offset: ev.clientY - tr.top };
        try { sbar.setPointerCapture(ev.pointerId); } catch (e) {}
      } else {
        list.scrollTop += (ev.clientY < tr.top ? -1 : 1) * list.clientHeight;
      }
    });
    sbar.addEventListener('pointermove', ev => {
      if (!drag || drag.id !== ev.pointerId) return;
      const sr = sbar.getBoundingClientRect();
      const h = thumb.clientHeight;
      const y = Math.max(0, Math.min(sr.height - h, ev.clientY - sr.top - drag.offset));
      list.scrollTop = (y / (sr.height - h)) * (list.scrollHeight - list.clientHeight);
    });
    ['pointerup', 'pointercancel'].forEach(ev => sbar.addEventListener(ev, e => { if (drag && drag.id === e.pointerId) drag = null; }));
  })();

  // ── context menu ─────────────────────────────────────────
  let ctxCleanup = null;
  function openCtx(x, y, title, actions) {
    const ctx = $('#ctx');
    ctx.innerHTML = (title ? '<div class="ctx-title">' + esc(title) + '</div>' : '') +
      actions.map((a, i) => '<button type="button" data-a="' + i + '"' + (a.danger ? ' class="danger"' : '') + '>' + esc(a.label) + '</button>').join('');
    ctx.hidden = false;
    const backdrop = $('#backdrop');
    backdrop.hidden = false;
    const r = ctx.getBoundingClientRect();
    ctx.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x - r.width / 2)) + 'px';
    ctx.style.top = Math.max(8, Math.min(window.innerHeight - r.height - 8, y)) + 'px';
    function close() {
      ctx.hidden = true;
      backdrop.hidden = true;
      backdrop.removeEventListener('click', close);
      ctxCleanup = null;
    }
    ctxCleanup = close;
    backdrop.addEventListener('click', close);
    ctx.querySelectorAll('[data-a]').forEach(btn => {
      btn.addEventListener('click', () => { close(); actions[Number(btn.dataset.a)].fn(); });
    });
  }
  window.MApp = null; // assigned at the bottom once everything exists

  function mediaActions(item, extra) {
    const actions = [
      { label: 'Play now', fn: () => playMedia(item, 'play') },
      { label: 'Play next', fn: () => playMedia(item, 'next') },
      { label: 'Add to queue', fn: () => playMedia(item, 'add') },
      { label: 'Replace queue', fn: () => playMedia(item, 'replace') },
    ];
    if (item && item.media_type && item.media_type !== 'radio') {
      actions.push({
        label: item.favorite ? 'Remove from favorites' : 'Add to favorites',
        fn: () => {
          const command = item.favorite ? 'music/favorites/remove_item' : 'music/favorites/add_item';
          cmd(command, { item: item.uri || item }, () => { item.favorite = !item.favorite; }).then(() => toast('Favorites updated')).catch(swallow);
        },
      });
    }
    return actions.concat(extra || []);
  }

  // ── long-press helper ────────────────────────────────────
  function attachLongPress(container, selector, cb) {
    let timer = null, start = null, target = null;
    container.addEventListener('pointerdown', ev => {
      target = ev.target.closest(selector);
      if (!target) return;
      start = { x: ev.clientX, y: ev.clientY };
      timer = setTimeout(() => {
        timer = null;
        target.style.background = 'var(--surface-raised)';
        setTimeout(() => { target.style.background = ''; }, 150);
        cb(target, start.x, start.y);
      }, 450);
    });
    container.addEventListener('pointermove', ev => {
      if (timer && start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 10) { clearTimeout(timer); timer = null; }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
      container.addEventListener(ev, () => { clearTimeout(timer); timer = null; }));
  }

  // ── queue interactions ───────────────────────────────────
  const queueList = $('#queue-list');
  TouchDragScroll.attach(queueList);
  queueList.addEventListener('pointerdown', () => { S.lastQueueTouch = Date.now(); });
  queueList.addEventListener('click', ev => {
    if (ev.target.closest('.qhandle')) return;
    const row = ev.target.closest('.qrow');
    if (!row) return;
    queueCmd('play_index', { index: row.dataset.qi });
  });
  attachLongPress(queueList, '.qrow', (row, x, y) => {
    const qi = row.dataset.qi;
    const i = Number(row.dataset.i);
    const item = S.queueItems[i];
    const queue = activeQueue();
    const currentIndex = S.queueItems.findIndex(it => it.queue_item_id === (queue && queue.current_item && queue.current_item.queue_item_id));
    openCtx(x, y, itemTitle(item), [
      { label: 'Play from here', fn: () => queueCmd('play_index', { index: qi }) },
      { label: 'Move next', fn: () => queueCmd('move_item', { queue_item_id: qi, pos_shift: (currentIndex + 1) - i }) },
      { label: 'Move to end', fn: () => queueCmd('move_item_end', { queue_item_id: qi }) },
      { label: 'Remove', danger: true, fn: () => queueCmd('delete_item', { item_id_or_index: qi }) },
    ]);
  });

  // drag-to-reorder on the handle
  (function wireQueueReorder() {
    let drag = null;
    queueList.addEventListener('pointerdown', ev => {
      const handle = ev.target.closest('.qhandle');
      if (!handle) return;
      const row = handle.closest('.qrow');
      drag = { id: ev.pointerId, from: Number(row.dataset.i), qi: row.dataset.qi, over: null };
      try { queueList.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.stopPropagation();
    });
    queueList.addEventListener('pointermove', ev => {
      if (!drag || drag.id !== ev.pointerId) return;
      const row = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = row && row.closest && row.closest('.qrow');
      queueList.querySelectorAll('.qrow.drag-over').forEach(r => r.classList.remove('drag-over'));
      if (target) { target.classList.add('drag-over'); drag.over = Number(target.dataset.i); }
      ev.preventDefault();
    });
    function finish(ev) {
      if (!drag || drag.id !== ev.pointerId) return;
      queueList.querySelectorAll('.qrow.drag-over').forEach(r => r.classList.remove('drag-over'));
      const shift = drag.over == null ? 0 : drag.over - drag.from;
      if (shift) queueCmd('move_item', { queue_item_id: drag.qi, pos_shift: shift });
      drag = null;
    }
    queueList.addEventListener('pointerup', finish);
    queueList.addEventListener('pointercancel', () => { drag = null; queueList.querySelectorAll('.qrow.drag-over').forEach(r => r.classList.remove('drag-over')); });
  })();

  $('#dstm-btn').addEventListener('click', () => {
    const queue = activeQueue();
    queueCmd('dont_stop_the_music', { dont_stop_the_music_enabled: !(queue && queue.dont_stop_the_music_enabled) },
      () => { if (queue) { queue.dont_stop_the_music_enabled = !queue.dont_stop_the_music_enabled; invalidate('queue'); } });
  });

  $('#queue-menu-btn').addEventListener('click', ev => {
    const others = Array.from(S.players.values()).filter(x => x.player_id !== S.activePlayerId && x.hidden !== true);
    openCtx(ev.clientX, ev.clientY, 'Queue', [
      { label: 'Clear queue', danger: true, fn: () => queueCmd('clear') },
      { label: 'Save as playlist', fn: () => {
        const name = 'Panel queue ' + new Date().toISOString().slice(0, 10);
        cmd('player_queues/save_as_playlist', { queue_id: S.activeQueueId, name })
          .then(() => toast('Saved as “' + name + '”')).catch(swallow);
      } },
    ].concat(others.map(p => ({
      label: 'Transfer to ' + MAClient.playerName(p),
      fn: () => cmd('player_queues/transfer', { source_queue_id: S.activeQueueId, target_queue_id: p.player_id, auto_play: true })
        .then(() => { selectPlayer(p.player_id); toast('Queue moved to ' + MAClient.playerName(p)); }).catch(swallow),
    }))));
  });

  // ── transport / volume buttons ───────────────────────────
  document.querySelectorAll('#transport [data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.cmd;
      const queue = activeQueue();
      if (name === 'shuffle') return void queueCmd('shuffle', { shuffle_enabled: !(queue && queue.shuffle_enabled) },
        () => { if (queue) { queue.shuffle_enabled = !queue.shuffle_enabled; invalidate('transport'); } });
      if (name === 'repeat') {
        const next = { off: 'all', all: 'one', one: 'off' }[(queue && queue.repeat_mode) || 'off'];
        return void queueCmd('repeat', { repeat_mode: next }, () => { if (queue) { queue.repeat_mode = next; invalidate('transport'); } });
      }
      if (name === 'play_pause') {
        return void queueCmd('play_pause', {}, () => {
          if (!queue) return;
          queue.state = queue.state === 'playing' ? 'paused' : 'playing';
          S.progress.playing = queue.state === 'playing';
          S.progress.elapsed = shownElapsed();
          S.progress.ts = Date.now();
          invalidate('transport', 'pill');
        });
      }
      queueCmd(name);
    });
  });
  $('#vol-down').addEventListener('click', () => nudgeVolume(-1));
  $('#vol-up').addEventListener('click', () => nudgeVolume(1));
  function nudgeVolume(dir) {
    const p = activePlayer();
    if (!p) return;
    const grouped = Array.isArray(p.group_childs) && p.group_childs.length;
    playerCmd(grouped ? (dir > 0 ? 'group_volume_up' : 'group_volume_down') : (dir > 0 ? 'volume_up' : 'volume_down'));
  }
  $('#mute-btn').addEventListener('click', () => {
    const p = activePlayer();
    if (!p) return;
    playerCmd('volume_mute', { muted: !p.volume_muted }, () => { p.volume_muted = !p.volume_muted; invalidate('volume'); });
  });
  $('#fav-btn').addEventListener('click', () => {
    playerCmd('add_currently_playing_to_favorites').then(() => toast('Added to favorites'));
  });

  // ── players rail interactions ────────────────────────────
  const playerList = $('#player-list');
  TouchDragScroll.attach(playerList);
  playerList.addEventListener('click', ev => {
    const row = ev.target.closest('[data-player]');
    if (row) selectPlayer(row.dataset.player);
  });
  attachLongPress(playerList, '[data-player]', (row, x, y) => {
    const p = S.players.get(row.dataset.player);
    if (!p) return;
    openCtx(x, y, MAClient.playerName(p), [
      { label: 'Transfer queue here', fn: () => cmd('player_queues/transfer', { source_queue_id: S.activeQueueId, target_queue_id: p.player_id, auto_play: true })
        .then(() => { selectPlayer(p.player_id); }).catch(swallow) },
      { label: 'Group with ' + (MAClient.playerName(activePlayer()) || 'current'), fn: () =>
        cmd('players/cmd/group', { player_id: p.player_id, target_player: S.activePlayerId }).catch(swallow) },
      { label: p.powered === false ? 'Power on' : 'Power off', fn: () =>
        cmd('players/cmd/power', { player_id: p.player_id, powered: p.powered === false }).catch(swallow) },
    ]);
  });
  $('#player-current').addEventListener('click', openGroupPanel);
  $('#group-btn').addEventListener('click', openGroupPanel);

  // ── grouping overlay ─────────────────────────────────────
  function groupLeader() {
    const p = activePlayer();
    if (!p) return null;
    if (Array.isArray(p.group_childs) && p.group_childs.length) return p;
    if (p.synced_to && S.players.get(p.synced_to)) return S.players.get(p.synced_to);
    return p;
  }

  function renderGroupPanel() {
    const leader = groupLeader();
    const members = leader && Array.isArray(leader.group_childs) ? leader.group_childs : [];
    const isGroup = members.length > 0;
    $('#gmaster').hidden = !isGroup;
    if (isGroup) {
      const level = Number(leader.group_volume != null ? leader.group_volume : leader.volume_level) || 0;
      const slider = $('#gvol-slider');
      slider.querySelector('.bar-fill').style.width = level + '%';
      slider.querySelector('.vthumb').style.left = level + '%';
    }
    const rows = Array.from(S.players.values()).filter(p => p.hidden !== true);
    $('#glist').innerHTML = rows.map(p => {
      const inGroup = leader && (p.player_id === leader.player_id || members.includes(p.player_id));
      const level = Number(p.volume_level) || 0;
      const isLeader = leader && p.player_id === leader.player_id;
      return '<div class="grow" data-player="' + esc(p.player_id) + '">' +
        '<button class="gcheck' + (inGroup ? ' on' : '') + '" type="button" data-check="' + esc(p.player_id) + '"' +
        (isLeader ? ' disabled' : '') + ' aria-label="' + (inGroup ? 'Remove from group' : 'Add to group') + '">' + (inGroup ? '✓' : '') + '</button>' +
        '<span class="gname">' + esc(MAClient.playerName(p)) + '</span>' +
        '<div class="vslider" data-vol="' + esc(p.player_id) + '"><div class="bar-track"><i class="bar-fill" style="width:' + level + '%"></i></div>' +
        '<div class="vthumb" style="left:' + level + '%"></div></div>' +
        '<button class="gmute ic" type="button" data-mute="' + esc(p.player_id) + '" aria-label="Mute">' +
        '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4V5Z"></path>' + (p.volume_muted ? '<path d="m16 9 5 6M21 9l-5 6"></path>' : '<path d="M15.5 8.5a5 5 0 0 1 0 7"></path>') + '</svg></button></div>';
    }).join('');
    $('#glist').querySelectorAll('[data-check]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.check;
        const on = btn.classList.contains('on');
        const command = on ? 'players/cmd/ungroup' : 'players/cmd/group';
        const args = on ? { player_id: id } : { player_id: id, target_player: (groupLeader() || activePlayer()).player_id };
        cmd(command, args).then(renderGroupPanel).catch(swallow);
      });
    });
    $('#glist').querySelectorAll('[data-vol]').forEach(el => {
      wireSlider(el, {
        onMove(v) {
          el.querySelector('.bar-fill').style.width = v + '%';
          el.querySelector('.vthumb').style.left = v + '%';
        },
        onDrag(v) { setVolume(v, el.dataset.vol); },
        onEnd(v) { setVolume(v, el.dataset.vol); },
      });
    });
    $('#glist').querySelectorAll('[data-mute]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = S.players.get(btn.dataset.mute);
        if (!p) return;
        cmd('players/cmd/volume_mute', { player_id: p.player_id, muted: !p.volume_muted }).then(renderGroupPanel).catch(swallow);
      });
    });
  }
  wireSlider($('#gvol-slider'), {
    onMove(v) {
      const slider = $('#gvol-slider');
      slider.querySelector('.bar-fill').style.width = v + '%';
      slider.querySelector('.vthumb').style.left = v + '%';
    },
    onDrag(v) { const l = groupLeader(); if (l) setVolume(v, null); },
    onEnd(v) { const l = groupLeader(); if (l) setVolume(v, null); },
  });
  $('#gvol-mute').addEventListener('click', () => {
    const l = groupLeader();
    if (!l) return;
    cmd('players/cmd/group_volume_mute', { player_id: l.player_id, muted: !l.volume_muted }).then(renderGroupPanel).catch(swallow);
  });

  let gpanelOpener = null;
  function openGroupPanel() {
    if (S.status !== 'ready') return;
    renderGroupPanel();
    gpanelOpener = document.activeElement;
    const panel = $('#gpanel');
    panel.removeAttribute('inert');
    panel.setAttribute('aria-hidden', 'false');
    panel.classList.add('open');
    $('#backdrop').hidden = false;
    $('#backdrop').addEventListener('click', closeGroupPanel);
  }
  function closeGroupPanel() {
    const panel = $('#gpanel');
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    panel.setAttribute('inert', '');
    $('#backdrop').hidden = true;
    $('#backdrop').removeEventListener('click', closeGroupPanel);
    if (gpanelOpener && gpanelOpener.focus) gpanelOpener.focus();
    invalidate('volume', 'players');
  }
  $('#gpanel-close').addEventListener('click', closeGroupPanel);
  $('#gpanel-done').addEventListener('click', closeGroupPanel);

  // ── library drawer buttons ───────────────────────────────
  $('#library-btn').addEventListener('click', () => { if (window.LibraryView) window.LibraryView.open('home'); });
  $('#search-btn').addEventListener('click', () => { if (window.LibraryView) window.LibraryView.open('search'); });

  // ── knob ─────────────────────────────────────────────────
  function overlayOpen() {
    return $('#drawer').classList.contains('open') || $('#gpanel').classList.contains('open') || !$('#ctx').hidden;
  }
  window.oqKnob = function (ev) {
    if (!ev || overlayOpen() || S.status !== 'ready') return false;
    if (ev.type === 'rotate') { nudgeVolume(ev.dir > 0 ? 1 : -1); return true; }
    if (ev.type === 'press' && ev.index === 1) {
      const btn = $('#play-btn');
      if (!btn.disabled) btn.click();
      return true;
    }
    return false; // double-press keeps the page selector, hold keeps push-to-talk
  };

  // ── startup ──────────────────────────────────────────────
  window.MApp = {
    S, cmd, playMedia, openCtx, mediaActions, toast, imageFor, esc, fmt,
    itemTitle, itemArtist, itemDuration, monoHtml, wireArt,
    request: (command, args) => S.client.request(command, args),
    playerName: MAClient.playerName,
  };

  paintSnapshot();
  if (!MOCK && !HOST) {
    onStatus('unconfigured');
  } else {
    const factory = MOCK ? MAMock : MAClient;
    S.client = factory.create({
      url: WS_URL,
      mockState: MOCK_STATE,
      tokenPromise: loadToken(),
      deviceName: 'Bedrock Panel',
      onStatus,
    });
    wireClientEvents();
    S.client.connect();
    // /app-config only answers while this page is the active grid; if the token
    // fetch raced a page switch, retry when we become visible again.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && S.status === 'auth-failed' && S.statusDetail === 'token-missing' && !MOCK) {
        S.client.close();
        S.client = MAClient.create({ url: WS_URL, tokenPromise: loadToken(), deviceName: 'Bedrock Panel', onStatus });
        wireClientEvents();
        S.client.connect();
      }
    });
  }
  invalidateAll();
})();
