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
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 600000;   // 10 min of socket silence before giving up
const MODELS_TIMEOUT_MS = 10000;
const SHORT_TIMEOUT_MS = 30000;      // bookkeeping calls of the tool-chat flow (create/poll/read/delete)
const TOOL_POLL_MS = 600;

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

// "no response after 30 s" / "after 10 min" -- the short bookkeeping calls time out in seconds.
function waited(ms) { return ms < 60000 ? Math.round(ms / 1000) + ' s' : Math.round(ms / 60000) + ' min'; }

function requestOpts(u, apiKey, timeoutMs, extraHeaders, method) {
  const headers = Object.assign({}, extraHeaders);
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  return {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,   // keep any query string the caller appended
    method: method || 'POST',
    timeout: timeoutMs,
    headers,
  };
}

// One JSON request, whole response buffered. Resolves { status, text } for any HTTP status —
// callers map 401/500/etc to their own wordings. Rejects only on transport-level failure
// (connect refused, DNS, inactivity timeout). A null/undefined body sends none (GET/DELETE).
function requestJson(method, url, body, apiKey, timeoutMs, transport) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad server URL: ' + url)); }
    const mod = u.protocol === 'https:' ? ((transport && transport.https) || https) : ((transport && transport.http) || http);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const t = timeoutMs || DEFAULT_TIMEOUT_MS;
    const headers = payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {};
    const req = mod.request(requestOpts(u, apiKey, t, headers, method), res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: out }));
    });
    req.on('timeout', () => req.destroy(new Error('no response after ' + waited(t))));
    req.on('error', e => reject(new Error(e.message || 'request failed')));
    req.end(payload || undefined);
  });
}
function postJson(url, body, apiKey, timeoutMs, transport) { return requestJson('POST', url, body, apiKey, timeoutMs, transport); }

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
  req.on('timeout', () => req.destroy(new Error('no response after ' + waited(t))));
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
// { id }, { name }, or plain strings. listModelInfo returns [{ id, toolIds, skillIds }]: the tools
// and skills attached to a workspace model (info.meta). OWUI's own chat page sends those as
// tool_ids/skill_ids; the backend does not apply them by itself. listModels returns just the ids.
// Both throw on HTTP errors with .statusCode set so callers can word 401 separately.
async function listModelInfo(modelsUrl, apiKey, fetchImpl) {
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
  const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x !== '') : []);
  return arr
    .map(m => {
      if (typeof m === 'string') return { id: m, toolIds: [], skillIds: [] };
      const meta = (m && m.info && m.info.meta) || {};
      return { id: (m && (m.id || m.name)) || '', toolIds: strings(meta.toolIds), skillIds: strings(meta.skillIds) };
    })
    .filter(m => typeof m.id === 'string' && m.id !== '');
}
async function listModels(modelsUrl, apiKey, fetchImpl) {
  return (await listModelInfo(modelsUrl, apiKey, fetchImpl)).map(m => m.id);
}

function jsonOf(r) { try { return JSON.parse(r.text); } catch (e) { return null; } }
function httpError(what, r) {
  const e = new Error(what + ' (HTTP ' + r.status + ')');
  e.statusCode = r.status;
  return e;
}

// One turn with server-side tool calling. Open WebUI runs a model's tools (MCP servers, workspace
// tools, skills) only for a completion attached to a saved chat and assistant message, and writes
// the answer into that chat instead of the HTTP response (docs.openwebui.com/reference/
// server-side-tool-calling, "Path A"). A plain streamed completion gets the tool call back
// unexecuted, which a model like Qwen then writes out as text. So: create a throwaway chat, start
// the completion against it, poll the chat's task list until it drains, read the assistant
// message, and delete the chat. session_id makes the start return at once (and unlocks skills).
//
// opts: { origin, apiKey, model, messages, toolIds, skillIds, timeoutMs, pollMs, transport, newId }
// Returns { promise -> { text }, cancel() }. cancel() stops the server-side task (best effort) and
// makes the promise reject with err.cancelled = true.
function runToolChat(opts) {
  const o = opts || {};
  const key = String(o.apiKey || '');
  const tr = o.transport;
  const newId = o.newId || (() => crypto.randomUUID());
  const pollMs = o.pollMs || TOOL_POLL_MS;
  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
  const api = p => o.origin + p;
  const call = (method, p, body) => requestJson(method, api(p), body, key, SHORT_TIMEOUT_MS, tr);
  let chatId = null, cancelled = false, wake = null, started = false, answered = false, stopped = false;
  const stopTask = () => call('POST', '/api/tasks/chat/' + encodeURIComponent(chatId) + '/stop', {}).catch(() => {});
  const cancelErr = () => { const e = new Error('cancelled'); e.cancelled = true; return e; };
  const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });

  const promise = (async () => {
    const userId = newId(), asstId = newId();
    const ts = Math.floor(Date.now() / 1000);
    const lastUser = [...(o.messages || [])].reverse().find(m => m && m.role === 'user');
    const created = await call('POST', '/api/v1/chats/new', { chat: {
      title: 'Bedrock Panel voice', models: [o.model],
      history: { currentId: asstId, messages: {
        [userId]: { id: userId, role: 'user', content: lastUser ? String(lastUser.content || '') : '', timestamp: ts, models: [o.model], childrenIds: [asstId] },
        [asstId]: { id: asstId, role: 'assistant', content: '', parentId: userId, childrenIds: [], model: o.model, modelName: o.model, modelIdx: 0, done: false, timestamp: ts + 1 },
      } },
    } });
    const chat = created.status === 200 ? jsonOf(created) : null;
    if (!chat || !chat.id) throw httpError('could not create the Open WebUI chat', created);
    chatId = String(chat.id);
    const chatPath = encodeURIComponent(chatId);
    try {
      if (cancelled) throw cancelErr();
      const body = {
        model: o.model, messages: o.messages || [], stream: true,
        chat_id: chatId, id: asstId, session_id: 'bedrock-panel-' + newId(),
        features: { web_search: false, code_interpreter: false, image_generation: false, memory: false },
        background_tasks: { title_generation: false, tags_generation: false, follow_up_generation: false },
      };
      if (o.toolIds && o.toolIds.length) body.tool_ids = o.toolIds;
      if (o.skillIds && o.skillIds.length) body.skill_ids = o.skillIds;
      const begun = await call('POST', '/api/chat/completions', body);
      if (begun.status !== 200) throw httpError('Open WebUI refused the request', begun);
      started = true;

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        await sleep(pollMs);
        if (cancelled) throw cancelErr();
        const t = await call('GET', '/api/tasks/chat/' + chatPath);
        if (t.status !== 200) throw httpError('could not check on the Open WebUI task', t);
        const tasks = jsonOf(t);
        if (!tasks || !Array.isArray(tasks.task_ids) || tasks.task_ids.length === 0) break;
        if (Date.now() > deadline) throw new Error('no response after ' + waited(timeoutMs));
      }

      const read = await call('GET', '/api/v1/chats/' + chatPath);
      if (read.status !== 200) throw httpError('could not read the Open WebUI answer', read);
      const full = jsonOf(read);
      const msgs = full && full.chat && full.chat.history && full.chat.history.messages;
      const msg = (msgs && msgs[asstId]) || {};
      const text = typeof msg.content === 'string' ? msg.content : '';
      answered = true;
      if (!text.trim()) {
        const err = msg.error && typeof msg.error === 'object' ? (msg.error.content || msg.error.detail) : msg.error;
        throw new Error(err ? 'Open WebUI: ' + String(err) : 'Open WebUI finished without an answer');
      }
      return { text };
    } finally {
      // Leaving early (cancelled, timed out, a poll failed) after the task started: stop it here, as
      // cancel()'s own stop may have landed before Open WebUI registered the task. Then delete the
      // chat, which only carried this turn, so nothing is left in the user's chat list.
      const cleanup = started && !answered && !stopped ? stopTask() : Promise.resolve();
      cleanup.then(() => call('DELETE', '/api/v1/chats/' + chatPath)).catch(() => {});
    }
  })();

  return {
    promise,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (wake) wake();
      if (chatId) { stopTask(); stopped = started; }   // before the start landed there's no task yet to stop
    },
  };
}

module.exports = { normalizeOwuiUrl, requestJson, postJson, streamChat, listModels, listModelInfo, runToolChat, DEFAULT_TIMEOUT_MS };
