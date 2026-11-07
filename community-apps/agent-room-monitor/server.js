'use strict';

// Agent Room Monitor — host-side action bridge.
//
// The panel page never supplies an upstream URL or path. It calls a small set of
// named actions; this module maps each to an EXACT Agent Room API route + method,
// validates the room code, and talks only to the configured origin. That keeps the
// browser side incapable of driving arbitrary server-side requests (SSRF-safe).
//
// Server policy (v1.1): the default target is the hosted Docker instance over https
// (the agent lane, arh-api), authenticated with a bearer token held in the panel's
// credential store — the `token` option, type "secret". The token is only ever read
// here, on the host side; it is never sent to the page. Plain http is still accepted,
// but only for a loopback host (a local dev server on this machine).
//
// Actions:
//   list            GET  /api/rooms?status=open        -> { ok, rooms }
//   hydrate ?room=  GET  /api/rooms/:code              -> { ok, room }
//   poll ?room=&after=  GET /api/rooms/:code/messages?after=N&wait=0
//                                                       -> { ok, messages, latest_message_id, participants, status }
//   send ?room= (POST {content}) POST /api/rooms/:code/viewer/messages {content}
//                                                       -> { ok, message, participants }
//   close ?room= (POST {summary}) POST /api/rooms/:code/close {name, summary}
//                                                       -> { ok, room, already_closed? }
//   history         GET  /api/rooms?status=closed      -> { ok, rooms } (newest 30)
//   answer ?room=&id= (POST {answer}) POST /api/rooms/:code/asks/:id/answer {answer}
//                                                       -> { ok, ask, message, asks, participants }
//   dismiss ?room=&id= (POST)     POST /api/rooms/:code/asks/:id/dismiss
//                                                       -> { ok, ask, asks }
//   poll ?room=&after=&viewer=1   adds &viewer=1 (nameless) so a v0.11.0 server marks the human
//                                 present; the page sends viewer=1 only when the panel is composited.
//   seen ?room= (POST {ids})      POST /api/rooms/:code/asks/seen {ids} -> { ok, asks }; a pre-0.11.0
//                                 server 404s -> { ok:false, unsupported:true } (swallowed by the page).

const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
// Hosted rooms use 128-bit codes (24 chars after "AM-"); local ones use 4. Accept both.
const ROOM_CODE_RE = /^AM-[A-Z0-9]{2,32}$/;
const DEFAULT_HOST = 'https://arh-api.schmitzplex.com';
const MAX_MESSAGE_CHARS = 20000; // mirrors Agent Room's server-side cap
const MAX_ANSWER_CHARS = 20000;  // mirrors Agent Room's ask-answer cap
const MAX_SUMMARY_CHARS = 10000; // mirrors Agent Room's close cap
const DEFAULT_CLOSE_SUMMARY = 'Closed from panel';

function optionString(options, key) {
  const value = options && options[key];
  return value == null ? '' : String(value).trim();
}

function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

// Resolve the upstream origin from the user's host option: https for any host, http only for
// loopback, no credentials in the URL, and NO path/query/fragment (rejected, not silently dropped).
function baseOrigin(options) {
  const raw = optionString(options, 'host') || DEFAULT_HOST;
  let url;
  try { url = new URL(raw); } catch (error) { throw new Error('invalid Server URL'); }
  if (url.username || url.password) throw new Error('Server URL must not contain credentials');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('Server URL must be an origin only (no path, query, or fragment)');
  }
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return url.origin;
  if (url.protocol === 'http:') throw new Error('plain http is only allowed for a loopback host; use https for a remote server');
  throw new Error('Server URL must use https (or http for loopback)');
}

// Bearer token from the `token` secret option. Required for any non-loopback origin.
function authHeaders(options, base) {
  const token = optionString(options, 'token');
  if (token.startsWith('oqenc:')) throw new Error('bearer token could not be decrypted by the panel');
  if (!token) {
    if (isLoopback(new URL(base).hostname)) return {};
    throw new Error('bearer token is not set (app options → Bearer token)');
  }
  return { Authorization: 'Bearer ' + token };
}

function roomCode(query, options) {
  const raw = String((query && query.room) || optionString(options, 'room') || '').trim().toUpperCase();
  if (!raw) throw new Error('no room selected');
  if (!ROOM_CODE_RE.test(raw)) throw new Error('invalid room code');
  return raw;
}

// An ask id is the id of the message that raised it: a positive integer (message ids start at 1).
// Validated here so the browser can never drive an arbitrary path segment onto the upstream
// /asks/:id/... routes.
function askId(query) {
  const raw = String((query && query.id) || '').trim();
  if (!/^[1-9][0-9]{0,14}$/.test(raw)) throw new Error('invalid ask id');
  return raw;
}

function safeError(error) {
  return String((error && error.message) || error || 'request failed').slice(0, 400);
}

async function rawFetch(url, headers, init) {
  const merged = Object.assign({}, headers || {}, (init && init.headers) || {});
  let response;
  try {
    response = await fetch(url, Object.assign({
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, init || {}, { headers: merged }));
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('room server timed out');
    throw new Error('room server unreachable');
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error('response too large');
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('response too large');
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch (error) { json = null; }
  return { status: response.status, json };
}

function apiError(status, json) {
  if (status === 401 || status === 403) {
    const denied = new Error('unauthorized: check the bearer token');
    denied.status = status;
    return denied;
  }
  const msg = json && json.error ? String(json.error) : ('room server returned ' + status);
  const error = new Error(msg);
  error.status = status;
  return error;
}

async function listRooms(base, headers) {
  const { status, json } = await rawFetch(base + '/api/rooms?status=open', headers);
  // The server answers 404 when the list endpoint is disabled (AGENT_ROOM_ENABLE_ROOM_LIST unset).
  if (status === 404) throw new Error('room list is disabled on the server (set AGENT_ROOM_ENABLE_ROOM_LIST=1)');
  if (status !== 200 || !json) throw apiError(status, json);
  return { ok: true, rooms: Array.isArray(json.rooms) ? json.rooms : [] };
}

// Newest closed rooms for the panel's History picker. The server sorts by updated_at, newest first.
const HISTORY_LIMIT = 30;
async function listHistory(base, headers) {
  const { status, json } = await rawFetch(base + '/api/rooms?status=closed', headers);
  if (status === 404) throw new Error('room list is disabled on the server (set AGENT_ROOM_ENABLE_ROOM_LIST=1)');
  if (status !== 200 || !json) throw apiError(status, json);
  const rooms = (Array.isArray(json.rooms) ? json.rooms : []).slice(0, HISTORY_LIMIT).map((room) => ({
    code: room.code,
    title: room.title,
    status: room.status,
    updated_at: room.updated_at,
    latest_message_id: Number(room.latest_message_id) || 0,
  }));
  return { ok: true, rooms };
}

async function hydrate(base, headers, code) {
  const { status, json } = await rawFetch(base + '/api/rooms/' + code, headers);
  if (status === 404) throw new Error('room ' + code + ' not found');
  if (status !== 200 || !json) throw apiError(status, json);
  return { ok: true, room: json };
}

async function poll(base, headers, code, after, viewer) {
  const cursor = Math.max(0, parseInt(after, 10) || 0);
  // viewer=1 (and NEVER a name) is the v0.11.0 "human present" stamp; the page only asks for it when
  // the panel is actually composited (rAF heartbeat). An older server simply ignores the param.
  const presence = String(viewer) === '1' ? '&viewer=1' : '';
  const { status, json } = await rawFetch(base + '/api/rooms/' + code + '/messages?after=' + cursor + '&wait=0' + presence, headers);
  if (status === 404) throw new Error('room ' + code + ' not found');
  if (status !== 200 || !json) throw apiError(status, json);
  return {
    ok: true,
    messages: Array.isArray(json.messages) ? json.messages : [],
    latest_message_id: Number(json.latest_message_id) || cursor,
    participants: Array.isArray(json.participants) ? json.participants : [],
    status: String(json.status || 'open'),
    addressed_only: Boolean(json.addressed_only),
    asks: Array.isArray(json.asks) ? json.asks : [],
  };
}

function bodyJson(context) {
  const raw = context && context.body;
  if (!raw) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch (error) { return {}; }
}

async function send(base, headers, code, context) {
  const content = String(bodyJson(context).content || '').trim();
  if (!content) throw new Error('message is empty');
  if (content.length > MAX_MESSAGE_CHARS) throw new Error('message exceeds ' + MAX_MESSAGE_CHARS + ' characters');
  const { status, json } = await rawFetch(base + '/api/rooms/' + code + '/viewer/messages', headers, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (status === 409) throw new Error('room is closed');
  if (status !== 201 || !json) throw apiError(status, json);
  return { ok: true, message: json.message, participants: Array.isArray(json.participants) ? json.participants : [] };
}

// Close a room on behalf of the human viewer. The server records the closer by name, so the
// room's viewer name is used; the summary is posted to the transcript as a `summary` message.
// The server's close is idempotent (always 200); an already-closed room is reported as such.
async function closeRoom(base, headers, code, context) {
  const summary = String(bodyJson(context).summary || '').trim().slice(0, MAX_SUMMARY_CHARS) || DEFAULT_CLOSE_SUMMARY;
  const current = await hydrate(base, headers, code);
  if (current.room && current.room.status === 'closed') return { ok: true, room: current.room, already_closed: true };
  const name = String((current.room && current.room.viewer_name) || 'Panel').trim().slice(0, 80) || 'Panel';
  const { status, json } = await rawFetch(base + '/api/rooms/' + code + '/close', headers, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, summary }),
  });
  if (status === 404) throw new Error('room ' + code + ' not found');
  if (status !== 200 || !json) throw apiError(status, json);
  return { ok: true, room: json };
}

// Answer an ask from the panel's Needs-you view. The server posts a human message "@Asker <answer>"
// and records it on the ask, so the asking agent's watcher sees "[answer to your ask #N]". Returns
// the refreshed open-asks list so the page can clear the answered card everywhere.
async function answerAsk(base, headers, code, id, context) {
  const answer = String(bodyJson(context).answer || '').trim();
  if (!answer) throw new Error('answer is empty');
  if (answer.length > MAX_ANSWER_CHARS) throw new Error('answer exceeds ' + MAX_ANSWER_CHARS + ' characters');
  const { status, json } = await rawFetch(base + '/api/rooms/' + code + '/asks/' + id + '/answer', headers, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  });
  if (status === 404) throw new Error('ask #' + id + ' not found');
  if (status === 409) throw new Error('room is closed');
  if (status !== 200 || !json) throw apiError(status, json);
  return {
    ok: true,
    ask: json.ask,
    message: json.message,
    asks: Array.isArray(json.asks) ? json.asks : [],
    participants: Array.isArray(json.participants) ? json.participants : [],
  };
}

// Dismiss an ask without answering (the human has handled it another way). The server marks it
// dismissed; the ask message stays in the transcript. Idempotent (an already-resolved ask returns 200).
async function dismissAsk(base, headers, code, id) {
  const { status, json } = await rawFetch(base + '/api/rooms/' + code + '/asks/' + id + '/dismiss', headers, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (status === 404) throw new Error('ask #' + id + ' not found');
  if (status !== 200 || !json) throw apiError(status, json);
  return { ok: true, ask: json.ask, asks: Array.isArray(json.asks) ? json.asks : [] };
}

// Mark the given open asks seen — the human has them in front of him on the panel. The page reports
// once per id and retries on failure. IDs are validated here (positive integers, capped) so the
// browser can't push junk. A pre-0.11.0 server 404s the route; we report that as `unsupported` so
// the page stops trying rather than surfacing an error.
async function seenAsks(base, headers, code, context) {
  const body = bodyJson(context);
  const raw = Array.isArray(body.ids) ? body.ids : [];
  const ids = [];
  for (const v of raw) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && n <= 1e15) ids.push(n);
    if (ids.length >= 200) break;
  }
  if (!ids.length) return { ok: true, asks: [] };   // nothing valid to report — make no request
  const { status, json } = await rawFetch(base + '/api/rooms/' + code + '/asks/seen', headers, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
  });
  if (status === 404) return { ok: false, unsupported: true };   // pre-0.11.0 server: swallow silently
  if (status !== 200 || !json) throw apiError(status, json);
  return { ok: true, asks: Array.isArray(json.asks) ? json.asks : [] };
}

// The addressed-only mode is shown as a read-only badge (from poll), not mutated here — so there
// is no `mode` action (avoids a dead, unvalidated write path).

async function handle(action, context) {
  const options = (context && context.options) || {};
  const query = (context && context.query) || {};
  try {
    const base = baseOrigin(options);
    const headers = authHeaders(options, base);
    if (action === 'list') return await listRooms(base, headers);
    if (action === 'history') return await listHistory(base, headers);
    if (action === 'hydrate') return await hydrate(base, headers, roomCode(query, options));
    if (action === 'poll') return await poll(base, headers, roomCode(query, options), query.after, query.viewer);
    if (action === 'send') return await send(base, headers, roomCode(query, options), context);
    if (action === 'close') return await closeRoom(base, headers, roomCode(query, options), context);
    if (action === 'answer') return await answerAsk(base, headers, roomCode(query, options), askId(query), context);
    if (action === 'dismiss') return await dismissAsk(base, headers, roomCode(query, options), askId(query));
    if (action === 'seen') return await seenAsks(base, headers, roomCode(query, options), context);
    return { ok: false, error: 'unknown action' };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

module.exports = { handle };
