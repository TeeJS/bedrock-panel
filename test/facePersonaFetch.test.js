'use strict';
// Import-from-URL policy for persona packs, exercised with a fake transport: https only, no
// credentials, no private hosts, bounded redirects re-checked per hop, size cap while streaming,
// time limit, and the same validation as a pasted pack.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchPersona, checkUrl, isPrivateHost } = require('../app/face/persona-fetch');

// A scripted transport: `routes[url] = {status, headers, body, hang}`.
function fakeTransport(routes, calls) {
  return (url, h) => {
    calls.push(url);
    const r = routes[url] || { status: 404, headers: {}, body: '' };
    let aborted = false;
    setImmediate(() => {
      if (aborted || r.hang) return;
      h.onResponse(r.status, r.headers || {});
      if (r.status >= 300 && r.status < 400) return;
      const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body || ''));
      for (let i = 0; i < body.length && !aborted; i += 1024) h.onData(body.subarray(i, i + 1024));
      if (!aborted) h.onEnd();
    });
    return { abort() { aborted = true; } };
  };
}
const GOOD = JSON.stringify({ id: 'shared', name: 'Shared', prompt: 'Be brief.' });

test('checkUrl: https only, no credentials, no private or local hosts', () => {
  assert.equal(checkUrl('https://example.com/p.persona.json'), null);
  assert.match(checkUrl('http://example.com/p.json'), /https/);
  assert.match(checkUrl('https://user:pw@example.com/p.json'), /credentials/);
  assert.match(checkUrl('https://192.168.1.25/p.json'), /local and private/);
  assert.match(checkUrl('https://localhost/p.json'), /local and private/);
  assert.match(checkUrl('https://nas.local/p.json'), /local and private/);
  assert.match(checkUrl('not a url'), /not a URL/);
});

test('isPrivateHost covers the private, loopback, link-local and mapped ranges', () => {
  ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.9.9', '192.168.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1', 'localhost', 'foo.local'].forEach(h => assert.equal(isPrivateHost(h), true, h));
  ['8.8.8.8', '172.32.0.1', '192.169.0.1', '2606:4700::1', 'raw.githubusercontent.com'].forEach(h => assert.equal(isPrivateHost(h), false, h));
});

test('a good pack over https is fetched and validated', async () => {
  const calls = [];
  const r = await fetchPersona('https://example.com/p.json', fakeTransport({ 'https://example.com/p.json': { status: 200, body: GOOD } }, calls));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.persona.id, 'shared');
  assert.deepEqual(calls, ['https://example.com/p.json']);
});

test('redirects are followed at most 3 hops and every hop is re-checked', async () => {
  const calls = [];
  const routes = {
    'https://a.example/1': { status: 302, headers: { location: 'https://a.example/2' } },
    'https://a.example/2': { status: 301, headers: { location: '/3' } },
    'https://a.example/3': { status: 200, body: GOOD },
  };
  const r = await fetchPersona('https://a.example/1', fakeTransport(routes, calls));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(calls, ['https://a.example/1', 'https://a.example/2', 'https://a.example/3']);

  const toPrivate = await fetchPersona('https://b.example/1', fakeTransport({ 'https://b.example/1': { status: 302, headers: { location: 'https://10.0.0.1/p' } } }, []));
  assert.equal(toPrivate.ok, false);
  assert.match(toPrivate.error, /local and private/);

  const toHttp = await fetchPersona('https://c.example/1', fakeTransport({ 'https://c.example/1': { status: 302, headers: { location: 'http://c.example/2' } } }, []));
  assert.equal(toHttp.ok, false);
  assert.match(toHttp.error, /https/);

  const loop = {};
  for (let i = 1; i <= 6; i++) loop['https://d.example/' + i] = { status: 302, headers: { location: 'https://d.example/' + (i + 1) } };
  const tooMany = await fetchPersona('https://d.example/1', fakeTransport(loop, []));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /too many redirects/);
});

test('oversize bodies are refused while streaming, bad JSON and credentials are refused after', async () => {
  const big = await fetchPersona('https://e.example/big', fakeTransport({ 'https://e.example/big': { status: 200, body: 'x'.repeat(70 * 1024) } }, []));
  assert.equal(big.ok, false);
  assert.match(big.error, /64 KB/);
  const bad = await fetchPersona('https://e.example/bad', fakeTransport({ 'https://e.example/bad': { status: 200, body: '{nope' } }, []));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /JSON/);
  const cred = await fetchPersona('https://e.example/cred', fakeTransport({ 'https://e.example/cred': { status: 200, body: JSON.stringify({ id: 'x', apiKey: 'k' }) } }, []));
  assert.equal(cred.ok, false);
  assert.match(cred.error, /credential/);
  const missing = await fetchPersona('https://e.example/none', fakeTransport({}, []));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /HTTP 404/);
});

test('a server that never answers is given up on after the time limit', async () => {
  const r = await fetchPersona('https://f.example/slow', fakeTransport({ 'https://f.example/slow': { hang: true } }, []), { timeoutMs: 120 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
});

test('a transport that throws is reported, not thrown', async () => {
  const r = await fetchPersona('https://g.example/p', () => { throw new Error('no network'); });
  assert.equal(r.ok, false);
  assert.match(r.error, /no network/);
});
