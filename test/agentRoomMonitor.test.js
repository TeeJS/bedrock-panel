'use strict';
// Agent Room Monitor host bridge: assert each named action maps to the EXACT upstream Agent Room
// route + method, and that the browser can never drive an arbitrary path. We stub global.fetch and
// inspect the single request the action makes — the house convention (deckHost/azureDevOps style).
const test = require('node:test');
const assert = require('node:assert/strict');

const server = require('../community-apps/agent-room-monitor/server.js');

// Minimal fake Response matching what the module reads: .status, .headers.get(), .text().
function fakeResponse(status, json) {
  const body = json == null ? '' : JSON.stringify(json);
  return {
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(Buffer.byteLength(body)) : null) },
    text: async () => body,
  };
}

let calls;
function stub(status, json) {
  calls = [];
  global.fetch = async (url, init) => { calls.push({ url: String(url), init: init || {} }); return fakeResponse(status, json); };
}

const OPTS = { host: 'http://127.0.0.1:7331', room: 'AM-TEST' };   // loopback: no token required
const call = (action, { query, body } = {}) =>
  server.handle(action, { appId: 'agent-room-monitor', query: query || {}, options: OPTS, body: body ? Buffer.from(JSON.stringify(body)) : null });

const origFetch = global.fetch;
test.after(() => { global.fetch = origFetch; });

test('answer -> POST /api/rooms/:code/asks/:id/answer {answer}', async () => {
  stub(200, { ask: { id: 493, status: 'answered' }, message: { id: 7 }, asks: [], participants: [{ name: 'Codex' }] });
  const res = await call('answer', { query: { id: '493' }, body: { answer: 'yes' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:7331/api/rooms/AM-TEST/asks/493/answer');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { answer: 'yes' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.asks, []);
  assert.equal(res.participants[0].name, 'Codex');
});

test('dismiss -> POST /api/rooms/:code/asks/:id/dismiss', async () => {
  stub(200, { ask: { id: 493, status: 'dismissed' }, asks: [] });
  const res = await call('dismiss', { query: { id: '493' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:7331/api/rooms/AM-TEST/asks/493/dismiss');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(res.ok, true);
  assert.equal(res.ask.status, 'dismissed');
});

test('poll passes the upstream asks array through to the page', async () => {
  stub(200, { messages: [], latest_message_id: 4, participants: [], status: 'open', asks: [{ id: 2, sender: 'Codex', content: 'go?' }] });
  const res = await call('poll', { query: { after: '0' } });
  assert.equal(res.ok, true);
  assert.equal(res.asks.length, 1);
  assert.equal(res.asks[0].id, 2);
});

test('a non-numeric ask id is rejected before any request is made', async () => {
  stub(200, {});
  const res = await call('answer', { query: { id: '../close' }, body: { answer: 'x' } });
  assert.equal(res.ok, false);
  assert.match(res.error, /invalid ask id/);
  assert.equal(calls.length, 0);   // nothing reached the network
});

test('an empty answer is refused before any request is made', async () => {
  stub(200, {});
  const res = await call('answer', { query: { id: '5' }, body: { answer: '   ' } });
  assert.equal(res.ok, false);
  assert.match(res.error, /answer is empty/);
  assert.equal(calls.length, 0);
});

test('answer surfaces a closed-room 409 as a clear error', async () => {
  stub(409, { error: 'Room AM-TEST is closed' });
  const res = await call('answer', { query: { id: '5' }, body: { answer: 'yes' } });
  assert.equal(res.ok, false);
  assert.match(res.error, /closed/);
});

test('poll with viewer=1 adds &viewer=1 and never a name (the v0.11.0 presence stamp)', async () => {
  stub(200, { messages: [], latest_message_id: 0, participants: [], status: 'open', asks: [] });
  await call('poll', { query: { after: '0', viewer: '1' } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/rooms\/AM-TEST\/messages\?after=0&wait=0&viewer=1$/);
  assert.doesNotMatch(calls[0].url, /name=/);   // presence stamp requires NO name
});

test('poll without viewer does not send viewer=1', async () => {
  stub(200, { messages: [], latest_message_id: 0, participants: [], status: 'open', asks: [] });
  await call('poll', { query: { after: '3' } });
  assert.match(calls[0].url, /messages\?after=3&wait=0$/);
  assert.doesNotMatch(calls[0].url, /viewer=1/);
});

test('seen -> POST /api/rooms/:code/asks/seen {ids}, junk ids filtered out', async () => {
  stub(200, { asks: [] });
  const res = await call('seen', { body: { ids: [493, '494', -1, 0, 'x', 9.5, 500] } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:7331/api/rooms/AM-TEST/asks/seen');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ids: [493, 494, 500] });   // positive integers only
  assert.equal(res.ok, true);
});

test('seen with no valid ids makes no request', async () => {
  stub(200, { asks: [] });
  const res = await call('seen', { body: { ids: ['nope', -3, 0] } });
  assert.equal(calls.length, 0);
  assert.equal(res.ok, true);
});

test('seen on a pre-0.11.0 server (404) is reported unsupported, not an error', async () => {
  stub(404, { error: 'Not found' });
  const res = await call('seen', { body: { ids: [5] } });
  assert.equal(res.ok, false);
  assert.equal(res.unsupported, true);
  assert.equal(res.error, undefined);   // swallowed: no error surfaced to the page
});
