'use strict';

// Music Assistant WebSocket client. UMD so the pure helpers are node-requirable
// by check.js; the connection half is browser-only.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MAClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const IMAGE_SIZES = [80, 160, 256, 512, 1024];
  const AUTH_SCHEMA = 28; // auth is mandatory from this schema version (MA 2.7)

  function baseUrl(hostText) {
    let t = String(hostText == null ? '' : hostText).trim();
    if (!t) return '';
    if (!/^https?:\/\//i.test(t)) t = 'http://' + t;
    return t.replace(/\/+$/, '').replace(/\/ws$/i, '');
  }

  function wsUrl(hostText) {
    const b = baseUrl(hostText);
    return b ? b.replace(/^http/i, 'ws') + '/ws' : '';
  }

  // MA's imageproxy only accepts these sizes; everything else is HTTP 400.
  function roundSize(n) {
    n = Number(n) || 0;
    if (n <= 0) return 0;
    for (const s of IMAGE_SIZES) if (n <= s) return s;
    return IMAGE_SIZES[IMAGE_SIZES.length - 1];
  }

  function pickImage(item) {
    if (!item) return null;
    if (item.image && (item.image.path || item.image.proxy_id)) return item.image;
    const images = item.metadata && item.metadata.images;
    if (Array.isArray(images) && images.length) {
      return images.find(i => i && i.type === 'thumb') || images[0];
    }
    if (item.media_item) return pickImage(item.media_item);
    if (item.current_item) return pickImage(item.current_item);
    return null;
  }

  function imageUrl(base, item, size) {
    const image = pickImage(item);
    if (!image || !base) return '';
    const s = roundSize(size);
    if (image.proxy_id) return base + '/imageproxy/' + image.proxy_id + '?size=' + s + '&fmt=jpeg';
    if (image.remotely_accessible && /^https?:\/\//i.test(image.path || '')) return image.path;
    if (!image.path) return '';
    return base + '/imageproxy?path=' + encodeURIComponent(encodeURIComponent(image.path)) +
      '&provider=' + encodeURIComponent(image.provider || '') + '&size=' + s;
  }

  // Large listings arrive as partial frames before the final one.
  function mergeChunk(pending, msg) {
    if (msg.partial) {
      if (!pending.chunks) pending.chunks = [];
      if (Array.isArray(msg.result)) pending.chunks.push.apply(pending.chunks, msg.result);
      return null;
    }
    if (pending.chunks) {
      if (Array.isArray(msg.result)) return pending.chunks.concat(msg.result);
      return pending.chunks;
    }
    return msg.result;
  }

  function nextBackoff(prevMs) {
    const p = Number(prevMs) || 0;
    if (p <= 0) return 1000;
    return Math.min(p * 2, 15000);
  }

  function playerName(p) {
    return String((p && (p.display_name || p.name)) || '');
  }

  function pickPlayer(players, defaultName, lastUsedId) {
    const list = (players || []).filter(p => p && p.available !== false && p.hidden !== true);
    if (defaultName) {
      const needle = String(defaultName).trim().toLowerCase();
      const hit = list.find(p => playerName(p).toLowerCase() === needle);
      if (hit) return hit.player_id;
    }
    if (lastUsedId && list.some(p => p.player_id === lastUsedId)) return lastUsedId;
    return list.length ? list[0].player_id : null;
  }

  function formatDuration(seconds) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = n % 60;
    if (h) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }

  function create(opts) {
    opts = opts || {};
    const client = {
      status: 'idle',
      serverInfo: null,
      connect,
      close,
      request,
      on,
    };
    let ws = null;
    let msgId = 0;
    let backoffMs = 0;
    let retryTimer = null;
    let closed = false;      // close() called - never reconnect
    let haltRetry = false;   // terminal state (bad token / setup) - reconnect only via connect()
    const pending = new Map();
    const subs = [];

    function setStatus(status, detail) {
      client.status = status;
      if (typeof opts.onStatus === 'function') {
        try { opts.onStatus(status, detail); } catch (e) {}
      }
    }

    function emit(msg) {
      for (const sub of subs.slice()) {
        if (sub.e !== '*' && sub.e !== msg.event) continue;
        if (sub.o !== '*' && msg.object_id && sub.o !== msg.object_id) continue;
        try { sub.h(msg); } catch (e) {}
      }
    }

    function on(eventType, objectId, handler) {
      const sub = { e: eventType || '*', o: objectId || '*', h: handler };
      subs.push(sub);
      return function unsubscribe() {
        const i = subs.indexOf(sub);
        if (i >= 0) subs.splice(i, 1);
      };
    }

    function failAllPending(reason) {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      pending.clear();
    }

    function request(command, args, timeoutMs) {
      if (client.status !== 'ready') return Promise.reject(new Error('not connected'));
      const id = String(++msgId);
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, chunks: null };
        entry.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('timeout'));
        }, timeoutMs || 10000);
        pending.set(id, entry);
        try {
          ws.send(JSON.stringify({ message_id: id, command, args: args || {} }));
        } catch (e) {
          clearTimeout(entry.timer);
          pending.delete(id);
          reject(e);
        }
      });
    }

    function sendAuth(token) {
      setStatus('authenticating');
      const id = 'auth-' + (++msgId);
      const entry = {
        resolve: () => { authReady(); },
        reject: (err) => {
          haltRetry = true;
          setStatus('auth-failed', err && err.message || 'authentication failed');
          try { ws.close(); } catch (e) {}
        },
        chunks: null,
      };
      entry.timer = setTimeout(() => { pending.delete(id); entry.reject(new Error('auth timeout')); }, 15000);
      pending.set(id, entry);
      ws.send(JSON.stringify({ message_id: id, command: 'auth', args: { token, device_name: opts.deviceName || 'Bedrock Panel' } }));
    }

    function authReady() {
      backoffMs = 0;
      setStatus('ready');
      emit({ event: 'connected' });
    }

    function onMessage(raw) {
      let msg = null;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.event) { emit(msg); return; }

      // First frame is the ServerInfo message (no message_id, no event).
      if (!client.serverInfo && msg.server_version !== undefined) {
        client.serverInfo = msg;
        const schema = Number(msg.schema_version) || 0;
        if (schema < AUTH_SCHEMA) { authReady(); return; }
        Promise.resolve(opts.tokenPromise).then(token => {
          if (closed || !ws || ws.readyState !== 1) return;
          if (!token) {
            haltRetry = true;
            setStatus('auth-failed', 'token-missing');
            try { ws.close(); } catch (e) {}
            return;
          }
          sendAuth(String(token));
        });
        return;
      }

      // MA refuses connections with "Setup required" before any users exist.
      if (msg.message_id === 'connection' && msg.error_code) {
        haltRetry = true;
        setStatus('setup-required', msg.details || 'Setup required');
        return;
      }

      const p = pending.get(String(msg.message_id));
      if (!p) return;
      if (msg.error_code !== undefined && msg.error_code !== null) {
        clearTimeout(p.timer);
        pending.delete(String(msg.message_id));
        const err = new Error(msg.details || ('error ' + msg.error_code));
        err.error_code = msg.error_code;
        p.reject(err);
        return;
      }
      const merged = mergeChunk(p, msg);
      if (merged === null && msg.partial) return; // more chunks coming
      clearTimeout(p.timer);
      pending.delete(String(msg.message_id));
      p.resolve(merged);
    }

    function scheduleRetry() {
      if (closed || haltRetry || retryTimer) return;
      backoffMs = nextBackoff(backoffMs);
      setStatus('reconnecting');
      retryTimer = setTimeout(() => { retryTimer = null; openSocket(); }, backoffMs);
    }

    function retryNow() {
      if (closed || haltRetry) return;
      if (client.status === 'ready' || client.status === 'connecting' || client.status === 'authenticating') return;
      clearTimeout(retryTimer);
      retryTimer = null;
      backoffMs = 0;
      openSocket();
    }

    function openSocket() {
      if (!opts.url) { setStatus('unconfigured'); return; }
      client.serverInfo = null;
      setStatus('connecting');
      try {
        ws = new WebSocket(opts.url);
      } catch (e) {
        scheduleRetry();
        return;
      }
      ws.onmessage = ev => onMessage(ev.data);
      ws.onclose = () => {
        const wasReady = client.status === 'ready';
        failAllPending('disconnected');
        if (wasReady) emit({ event: 'disconnected' });
        if (!closed && !haltRetry) scheduleRetry();
      };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
    }

    function connect() {
      closed = false;
      haltRetry = false;
      clearTimeout(retryTimer);
      retryTimer = null;
      openSocket();
    }

    function close() {
      closed = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      failAllPending('closed');
      try { if (ws) ws.close(); } catch (e) {}
      setStatus('idle');
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('online', retryNow);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) retryNow(); });
    }

    return client;
  }

  return { create, baseUrl, wsUrl, roundSize, pickImage, imageUrl, mergeChunk, nextBackoff, pickPlayer, playerName, formatDuration };
});
