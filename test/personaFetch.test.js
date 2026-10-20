'use strict';
// Hardening tests for "Import from URL…" on top of facePersonaFetch.test.js: a persona link must not
// let the app reach the user's own machine or network, however the address is written, resolved or
// redirected. Fake transports use the callback contract of app/face/persona-fetch.js; the Electron
// adapter is tested against a fake `net` module (its manual-redirect behaviour was verified against
// real Electron: a 3xx arrives only as the 'redirect' event, then the request errors).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const pf = require('../app/face/persona-fetch');

const GOOD = JSON.stringify({ id: 'sprocket', name: 'Sprocket', prompt: 'Be brief.', face: { style: 'kawaii' } });
const PUBLIC = 'https://raw.githubusercontent.com/someone/packs/main/sprocket.persona.json';
const publicResolve = async () => ['140.82.112.3'];

// A scripted transport: respond(url) -> {status, headers, body (string|Buffer|array of chunks), hang}.
function transportOf(respond, seen) {
  return (url, h) => {
    if (seen) seen.push(url);
    let aborted = false;
    const r = respond(url);
    setImmediate(() => {
      if (aborted || r.hang) return;
      h.onResponse(r.status, r.headers || {});
      if (r.status >= 300 && r.status < 400) return;
      const parts = Array.isArray(r.body) ? r.body : [Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body == null ? '' : r.body))];
      for (const p of parts) { if (aborted) return; h.onData(Buffer.from(p)); }
      if (!aborted) h.onEnd();
    });
    return { abort() { aborted = true; if (r.onAbort) r.onAbort(); } };
  };
}
const redirect = to => ({ status: 302, headers: { location: to } });

// ---- literal addresses and names ------------------------------------------------------------
test('public https URLs pass, by name and by public address', () => {
  for (const u of [PUBLIC, 'https://gist.githubusercontent.com/a/b/raw/x.json', 'https://8.8.8.8/x.json', 'https://[2606:4700:4700::1111]/x.json', 'https://172.32.0.1/x', 'https://[::ffff:8.8.8.8]/x']) {
    assert.equal(pf.checkUrl(u), null, u);
  }
});

test('only https, no credentials, and malformed input is refused with a reason', () => {
  for (const u of ['http://example.com/x', 'ftp://example.com/x', 'file:///C:/x.json', 'javascript:alert(1)', 'data:text/plain,hi']) assert.ok(pf.checkUrl(u), u);
  for (const u of ['', '   ', 'not a url', 'https://', null, undefined]) assert.match(pf.checkUrl(u), /not a URL/, String(u));
  assert.match(pf.checkUrl('https://user:pw@example.com/x'), /credentials/);
  assert.match(pf.checkUrl('https://token@example.com/x'), /credentials/);
});

test('loopback, private, link-local, CGNAT and reserved IPv4 are refused however they are written', () => {
  const bad = ['https://127.0.0.1/x', 'https://127.1.2.3/x', 'https://0.0.0.0/x', 'https://10.0.0.5/x', 'https://172.16.0.1/x', 'https://172.31.255.255/x',
    'https://192.168.1.25/x', 'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/x', 'https://192.0.0.8/x', 'https://198.18.0.1/x',
    'https://224.0.0.1/x', 'https://255.255.255.255/x',
    'https://2130706433/x',         // 127.0.0.1 as a decimal integer (the URL parser normalizes it)
    'https://0x7f.1/x',             // hex / short forms
    'https://017700000001/x'];      // octal integer
  for (const u of bad) assert.match(pf.checkUrl(u), /local and private/, u);
});

test('loopback, unique-local, link-local, multicast, mapped, NAT64 and 6to4 IPv6 are refused', () => {
  const bad = ['https://[::1]/x', 'https://[::]/x', 'https://[fd00::1]/x', 'https://[fc00::1]/x', 'https://[fe80::1]/x', 'https://[ff02::1]/x',
    'https://[::ffff:127.0.0.1]/x', 'https://[::ffff:7f00:1]/x', 'https://[::ffff:192.168.1.1]/x', 'https://[::ffff:c0a8:101]/x',
    'https://[64:ff9b::7f00:1]/x', 'https://[2002:7f00:1::1]/x'];
  for (const u of bad) assert.match(pf.checkUrl(u), /local and private/, u);
});

test('local-looking names are refused: localhost, .local, .internal, .lan, single-label', () => {
  for (const u of ['https://localhost/x', 'https://localhost./x', 'https://app.localhost/x', 'https://nas.local/x', 'https://printer.lan/x',
    'https://thing.internal/x', 'https://router/x', 'https://myserver/x', 'https://host.home.arpa/x', 'https://wiki.corp/x']) {
    assert.match(pf.checkUrl(u), /local and private/, u);
  }
});

test('isPrivateAddress: v4/v6 literals, and anything that is not an address counts as private', () => {
  assert.equal(pf.isPrivateAddress('140.82.112.3'), false);
  assert.equal(pf.isPrivateAddress('2606:50c0:8000::154'), false);
  assert.equal(pf.isPrivateAddress('10.1.2.3'), true);
  assert.equal(pf.isPrivateAddress('::ffff:10.1.2.3'), true);
  assert.equal(pf.isPrivateAddress('not-an-ip'), true);
});

// ---- resolution --------------------------------------------------------------------------------
test('a public name that RESOLVES to a private address is refused before any request', async () => {
  for (const addrs of [['10.0.0.8'], ['140.82.112.3', '192.168.0.9'], ['::ffff:127.0.0.1'], ['fd00::5']]) {
    const seen = [];
    const r = await pf.fetchPersona(PUBLIC, transportOf(() => ({ status: 200, body: GOOD }), seen), { resolveHost: async () => addrs });
    assert.equal(r.ok, false, JSON.stringify(addrs));
    assert.match(r.error, /local and private/);
    assert.deepEqual(seen, [], 'nothing was requested');
  }
  const ok = await pf.fetchPersona(PUBLIC, transportOf(() => ({ status: 200, body: GOOD })), { resolveHost: async () => ['140.82.112.3', '2606:50c0:8000::154'] });
  assert.equal(ok.ok, true, ok.error);
});

test('a name that does not resolve is refused; IP literals are not sent to the resolver', async () => {
  for (const resolveHost of [async () => { throw new Error('ENOTFOUND'); }, async () => [], () => { throw new Error('sync boom'); }]) {
    const r = await pf.fetchPersona(PUBLIC, transportOf(() => ({ status: 200, body: GOOD })), { resolveHost });
    assert.equal(r.ok, false);
    assert.match(r.error, /could not find/);
  }
  let asked = 0;
  const r = await pf.fetchPersona('https://8.8.8.8/x.json', transportOf(() => ({ status: 200, body: GOOD })), { resolveHost: async () => { asked++; return ['8.8.8.8']; } });
  assert.equal(r.ok, true, r.error);
  assert.equal(asked, 0);
});

// ---- the loop ----------------------------------------------------------------------------------
test('a non-https or private URL never reaches the transport', async () => {
  const seen = [];
  for (const u of ['http://example.com/x', 'https://127.0.0.1/x', 'https://u:p@example.com/x', 'https://nas.local/x', 'https://[::ffff:7f00:1]/x']) {
    const r = await pf.fetchPersona(u, transportOf(() => ({ status: 200, body: GOOD }), seen), { resolveHost: publicResolve });
    assert.equal(r.ok, false, u);
  }
  assert.deepEqual(seen, []);
});

test('a public URL cannot redirect into the machine, the LAN, plain http, or credentials, and the target is never requested', async () => {
  for (const target of ['https://192.168.1.25/appdata/secret.json', 'https://127.0.0.1:8080/x', 'http://example.com/x', 'https://u:p@example.com/x', 'https://nas.local/x', 'https://[::1]/x', 'https://[::ffff:7f00:1]/x']) {
    const seen = [];
    const r = await pf.fetchPersona(PUBLIC, transportOf(() => redirect(target), seen), { resolveHost: publicResolve });
    assert.equal(r.ok, false, target);
    assert.deepEqual(seen, [PUBLIC], 'redirect target requested: ' + target);
  }
});

test('a redirect to a name that resolves privately is refused', async () => {
  const seen = [];
  const r = await pf.fetchPersona(PUBLIC, transportOf(() => redirect('https://evil.example.com/x'), seen), { resolveHost: async h => (h === 'evil.example.com' ? ['10.1.1.1'] : ['140.82.112.3']) });
  assert.equal(r.ok, false);
  assert.deepEqual(seen, [PUBLIC]);
});

test('exactly 3 redirects are allowed, the 4th is refused', async () => {
  const hop = limit => { let n = 0; return () => (++n <= limit ? redirect('https://example.com/n' + n) : { status: 200, body: GOOD }); };
  const three = await pf.fetchPersona(PUBLIC, transportOf(hop(3)), { resolveHost: publicResolve });
  assert.equal(three.ok, true, three.error);
  const four = await pf.fetchPersona(PUBLIC, transportOf(hop(4)), { resolveHost: publicResolve });
  assert.equal(four.ok, false);
  assert.match(four.error, /too many redirects/);
});

test('the body is capped while it streams: the download is aborted at the cap', async () => {
  let aborted = false;
  const r = await pf.fetchPersona(PUBLIC, transportOf(() => ({ status: 200, body: [Buffer.alloc(40 * 1024, 97), Buffer.alloc(40 * 1024, 97), Buffer.alloc(40 * 1024, 97)], onAbort: () => { aborted = true; } })));
  assert.equal(r.ok, false);
  assert.match(r.error, /64 KB/);
  assert.equal(aborted, true);
});

test('one total deadline covers the whole redirect chain', async () => {
  let n = 0;
  const slow = (url, h) => { n++; const t = setTimeout(() => h.onResponse(302, { location: 'https://example.com/h' + n }), 90); return { abort() { clearTimeout(t); } }; };
  const r = await pf.fetchPersona(PUBLIC, slow, { timeoutMs: 200, resolveHost: publicResolve });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
  assert.ok(n <= 3);
});

test('a stalled body is aborted at the deadline', async () => {
  let aborted = false;
  const stall = (url, h) => { setImmediate(() => { h.onResponse(200, {}); h.onData(Buffer.from('{"id":')); }); return { abort() { aborted = true; } }; };
  const r = await pf.fetchPersona(PUBLIC, stall, { timeoutMs: 150 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
  assert.equal(aborted, true);
});

test('a result is delivered once even if the transport keeps talking afterwards', async () => {
  let handlers;
  const chatty = (url, h) => { handlers = h; setImmediate(() => { h.onResponse(200, {}); h.onData(Buffer.from(GOOD)); h.onEnd(); h.onData(Buffer.from('late')); h.onEnd(); h.onError(new Error('late error')); }); return { abort() {} }; };
  const r = await pf.fetchPersona(PUBLIC, chatty);
  assert.equal(r.ok, true, r.error);
  assert.ok(handlers);
});

// ---- the Electron net adapter, against a fake `net` ---------------------------------------------
function fakeNet(script) {
  const made = [];
  return { made, request(opts) {
    const req = new EventEmitter();
    req.opts = opts; req.headers = {}; req.aborted = false;
    req.setHeader = (k, v) => { req.headers[k] = v; };
    req.abort = () => { req.aborted = true; };
    req.end = () => setImmediate(() => script(req));
    made.push(req);
    return req;
  } };
}
function fakeResponse(statusCode, headers, parts) {
  const res = new EventEmitter();
  res.statusCode = statusCode; res.headers = headers || {};
  res.emitAll = () => setImmediate(() => { parts.forEach(p => res.emit('data', Buffer.from(p))); res.emit('end'); });
  return res;
}

test('makeNetTransport asks for manual redirects without credentials and streams the body', async () => {
  const net = fakeNet(req => { const res = fakeResponse(200, { 'content-type': 'application/json' }, [GOOD.slice(0, 10), GOOD.slice(10)]); req.emit('response', res); res.emitAll(); });
  const r = await pf.fetchPersona(PUBLIC, pf.makeNetTransport(net), { resolveHost: publicResolve });
  assert.equal(r.ok, true, r.error);
  assert.equal(net.made[0].opts.redirect, 'manual');
  assert.equal(net.made[0].opts.credentials, 'omit');
  assert.equal(net.made[0].opts.method, 'GET');
});

test('makeNetTransport turns the manual-mode redirect event into a hop the policy re-checks (real Electron sends ONLY that event, then errors)', async () => {
  const net = fakeNet(req => {
    if (req.opts.url === PUBLIC) { req.emit('redirect', 302, 'GET', 'https://cdn.example.org/real.json', {}); req.emit('error', new Error('Redirect was cancelled')); }
    else { const res = fakeResponse(200, {}, [GOOD]); req.emit('response', res); res.emitAll(); }
  });
  const r = await pf.fetchPersona(PUBLIC, pf.makeNetTransport(net), { resolveHost: publicResolve });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.persona.id, 'sprocket');
  assert.equal(net.made.length, 2);
  assert.equal(net.made[0].aborted, true, 'the redirected request is not left running');
});

test('makeNetTransport redirect into the LAN is refused without a second request', async () => {
  const net = fakeNet(req => { req.emit('redirect', 301, 'GET', 'https://192.168.1.25/x', {}); req.emit('error', new Error('Redirect was cancelled')); });
  const r = await pf.fetchPersona(PUBLIC, pf.makeNetTransport(net), { resolveHost: publicResolve });
  assert.equal(r.ok, false);
  assert.match(r.error, /local and private/);
  assert.equal(net.made.length, 1);
});

test('makeNetTransport reports network errors, mid-body errors and cut connections', async () => {
  const dead = fakeNet(req => req.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED')));
  assert.match((await pf.fetchPersona(PUBLIC, pf.makeNetTransport(dead))).error, /ERR_NAME_NOT_RESOLVED/);
  const cut = fakeNet(req => { const res = fakeResponse(200, {}, []); req.emit('response', res); setImmediate(() => res.emit('error', new Error('socket hang up'))); });
  assert.match((await pf.fetchPersona(PUBLIC, pf.makeNetTransport(cut))).error, /socket hang up/);
  const aborted = fakeNet(req => { const res = fakeResponse(200, {}, []); req.emit('response', res); setImmediate(() => res.emit('aborted')); });
  assert.match((await pf.fetchPersona(PUBLIC, pf.makeNetTransport(aborted))).error, /cut/);
  const throws = { request() { throw new Error('bad url'); } };
  assert.match((await pf.fetchPersona(PUBLIC, pf.makeNetTransport(throws))).error, /bad url/);
});
