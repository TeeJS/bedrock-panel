'use strict';

// Open WebUI client: URL normalization + HTTP transport shared by the meeting-analysis
// backend (meetingAnalyze.runOwui) and the panel voice adapter (owuivoice-session).
//
// The chat endpoints deliberately do NOT use global fetch: undici enforces a hidden ~300 s
// headers timeout regardless of the abort signal (the bug that killed long diarizer uploads,
// see meetingTranscribe.httpPostWav). Chat completions against a local model can easily sit
// past 5 minutes before the first byte, so postJson/streamChat ride raw http/https.request
// where `timeout` is socket INACTIVITY only. listModels is short and cheap, so it may fetch.
//
// Endpoint shape (docs/settings.md, Auth tab): Open WebUI's own API lives under /api — /api/chat/completions
// (OpenAI-compatible, accepts Bearer key) and /api/models. The /v1/... paths reject POST, so any
// pasted path (incl. a /v1 base) is discarded and both URLs are derived from the origin.

const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 600000;   // 10 min of socket silence before giving up
const MODELS_TIMEOUT_MS = 10000;

// Accept any pasted form — bare host, origin, trailing slash, full path (/v1, /api/...), and the
// missing-slash typos the transcription URL field taught us to heal (`http:/host`, `http:host`).
// Returns { origin, chatUrl, modelsUrl } or null when no usable host survives parsing.
function normalizeOwuiUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  // A colon followed by a digit is a PORT ("box:3000"), not a scheme — only treat the prefix as
  // a scheme when what follows the colon is non-numeric.
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?![0-9])/.exec(s);
  if (scheme && !/^https?$/i.test(scheme[1])) return null;   // ws://, ftp:// etc — not a web UI
  if (scheme) s = s.replace(/^https?:\/*/i, m => (/^https/i.test(m) ? 'https://' : 'http://'));
  else s = 'http://' + s.replace(/^\/+/, '');
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (!u.hostname) return null;
  const origin = u.origin;
  return {
    origin,
    chatUrl: origin + '/api/chat/completions',
    modelsUrl: origin + '/api/models',
  };
}

function requestOpts(u, apiKey, timeoutMs, extraHeaders) {
  const headers = Object.assign({}, extraHeaders);
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  return {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,   // keep any query string the caller appended
    method: 'POST',
    timeout: timeoutMs,
    headers,
  };
}

// One JSON POST, whole response buffered. Resolves { status, text } for any HTTP status —
// callers map 401/500/etc to their own wordings. Rejects only on transport-level failure
// (connect refused, DNS, inactivity timeout).
function postJson(url, body, apiKey, timeoutMs, transport) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad server URL: ' + url)); }
    const mod = u.protocol === 'https:' ? ((transport && transport.https) || https) : ((transport && transport.http) || http);
    const payload = Buffer.from(JSON.stringify(body));
    const t = timeoutMs || DEFAULT_TIMEOUT_MS;
    const req = mod.request(requestOpts(u, apiKey, t, {
      'Content-Type': 'application/json', 'Content-Length': payload.length,
    }), res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: out }));
    });
    req.on('timeout', () => req.destroy(new Error('no response after ' + Math.round(t / 60000) + ' min')));
    req.on('error', e => reject(new Error(e.message || 'request failed')));
    req.end(payload);
  });
}

// Streaming chat completion (body should carry stream:true). SSE frames are line-buffered so a
// `data:` line split across TCP chunks reassembles; unparseable or empty-choices chunks are
// skipped, never fatal (OWUI versions vary in what they emit between deltas). `data: [DONE]`
// or the response ending both finish the stream. The socket timeout is inactivity-based, so a
// slow model that keeps trickling tokens never trips it.
//
// handlers: { onDelta(text), onDone({ finishReason }), onError(err — err.statusCode set on HTTP errors) }
// Returns { destroy() } — destroy() aborts silently (no onDone/onError afterwards).
function streamChat(url, body, apiKey, timeoutMs, handlers, transport) {
  const h = handlers || {};
  let settled = false;
  let destroyed = false;
  const finishOk = fr => { if (!settled && !destroyed) { settled = true; if (h.onDone) h.onDone({ finishReason: fr || null }); } };
  const finishErr = e => { if (!settled && !destroyed) { settled = true; if (h.onError) h.onError(e); } };

  let u;
  try { u = new URL(url); } catch (e) { setImmediate(() => finishErr(new Error('bad server URL: ' + url))); return { destroy() { destroyed = true; } }; }
  const mod = u.protocol === 'https:' ? ((transport && transport.https) || https) : ((transport && transport.http) || http);
  const payload = Buffer.from(JSON.stringify(body));
  const t = timeoutMs || DEFAULT_TIMEOUT_MS;

  const req = mod.request(requestOpts(u, apiKey, t, {
    'Content-Type': 'application/json', 'Content-Length': payload.length, 'Accept': 'text/event-stream',
  }), res => {
    if (res.statusCode !== 200) {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => {
        const e = new Error('HTTP ' + res.statusCode + (out ? ': ' + String(out).slice(0, 300) : ''));
        e.statusCode = res.statusCode;
        finishErr(e);
      });
      return;
    }
    let buf = '';
    let finishReason = null;
    res.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();                       // keep the trailing partial line
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { finishOk(finishReason); req.destroy(); return; }
        let obj;
        try { obj = JSON.parse(data); } catch (e) { continue; }   // skip, don't crash
        const choice = obj && Array.isArray(obj.choices) ? obj.choices[0] : null;
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta && typeof choice.delta.content === 'string' ? choice.delta.content : '';
        if (delta && !settled && !destroyed && h.onDelta) h.onDelta(delta);
      }
    });
    res.on('end', () => finishOk(finishReason));
    res.on('error', e => finishErr(new Error(e.message || 'stream failed')));
  });
  req.on('timeout', () => req.destroy(new Error('no response after ' + Math.round(t / 60000) + ' min')));
  req.on('error', e => finishErr(new Error(e.message || 'request failed')));
  req.end(payload);

  return {
    destroy() {
      destroyed = true;
      try { req.destroy(); } catch (e) {}
    },
  };
}

// Fetch the model list (short probe — plain fetch is fine here). Accepts the shapes OWUI
// versions have shipped: { data: [...] }, { models: [...] }, or a bare array; entries may be
// { id }, { name }, or plain strings. Returns an array of model-id strings. Throws on HTTP
// errors with .statusCode set so callers can word 401 separately.
async function listModels(modelsUrl, apiKey, fetchImpl) {
  const f = fetchImpl || fetch;
  const headers = {};
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  const res = await f(modelsUrl, { headers, signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) });
  if (!res.ok) {
    const e = new Error('HTTP ' + res.status);
    e.statusCode = res.status;
    throw e;
  }
  let json;
  try { json = await res.json(); } catch (e) { return []; }
  const arr = Array.isArray(json) ? json
    : (json && Array.isArray(json.data)) ? json.data
    : (json && Array.isArray(json.models)) ? json.models
    : [];
  return arr
    .map(m => (typeof m === 'string' ? m : (m && (m.id || m.name)) || ''))
    .filter(id => typeof id === 'string' && id !== '');
}

module.exports = { normalizeOwuiUrl, postJson, streamChat, listModels, DEFAULT_TIMEOUT_MS };
