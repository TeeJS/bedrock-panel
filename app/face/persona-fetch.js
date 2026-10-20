'use strict';
// Fetch policy for "Import persona from URL": the rules live here, pure, with the transport
// injected, so they are unit-testable without a network. The contract documented in
// docs/personas.md:
//   - https only; a URL with user:pass@ is refused
//   - hosts that are loopback, private, link-local, CGNAT, multicast/reserved, "localhost"/".local"/
//     ".internal"-style or single-label names are refused, by the literal host and (when the caller
//     supplies opts.resolveHost) by every address the name resolves to. This is for sharing public
//     packs; a LAN file is imported by pasting or choosing the file.
//   - redirects are followed by hand, at most MAX_REDIRECTS hops, each hop re-checked
//   - TOTAL_TIMEOUT_MS for the whole thing, MAX_PACK_BYTES enforced while the body streams
//   - the body then goes through importPersonaText (JSON, shape, no credentials)
// Known limit: a public name that resolves to a public address when checked and a private one when
// connected (DNS rebinding) is not detected; the body is still only ever parsed as a persona.
//
// `transport(url, {onResponse(status, headers), onData(chunk), onEnd(), onError(err)}) -> {abort()}`
// is the one thing the caller supplies (makeNetTransport(electron.net) in main.js, a fake in tests).
// It must NOT follow redirects itself: a 3xx is reported through onResponse with a `location` header.

const nodeNet = require('net');
const { importPersonaText, MAX_PACK_BYTES } = require('./persona');

const MAX_REDIRECTS = 3;
const TOTAL_TIMEOUT_MS = 15000;
const LOCAL_MSG = 'local and private addresses cannot be imported from a URL; paste the JSON or choose the file instead';

function fail(error) { return { ok: false, persona: null, error }; }

// Returns null when the URL may be fetched (as far as the literal URL can tell), else the reason.
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw == null ? '' : raw).trim()); } catch (e) { return 'that is not a URL'; }
  if (u.protocol !== 'https:') return 'only https URLs can be imported (paste the JSON or choose a file for anything else)';
  if (u.username || u.password) return 'a URL with credentials in it is refused';
  if (isPrivateHost(u.hostname)) return LOCAL_MSG;
  return null;
}

function ipv4Private(a, b) {
  if (a === 0 || a === 10 || a === 127) return true;           // "this" network, private, loopback
  if (a === 169 && b === 254) return true;                      // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;             // private
  if (a === 192 && b === 168) return true;                      // private
  if (a === 100 && b >= 64 && b <= 127) return true;            // carrier-grade NAT
  if (a === 192 && b === 0) return true;                        // IETF protocol assignments / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;         // benchmarking
  if (a >= 224) return true;                                    // multicast, reserved, broadcast
  return false;
}
// 8 hextets for an IPv6 literal (no brackets), or null if it is not one. Handles :: and a trailing dotted quad.
function expandIpv6(addr) {
  let s = addr.toLowerCase();
  const zone = s.indexOf('%'); if (zone >= 0) s = s.slice(0, zone);
  const m = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m) {
    const n = [m[2], m[3], m[4], m[5]].map(Number);
    if (n.some(x => x > 255)) return null;
    s = m[1] + ((n[0] << 8) | n[1]).toString(16) + ':' + ((n[2] << 8) | n[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let parts;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    parts = head.concat(new Array(fill).fill('0'), tail);
  } else parts = head;
  if (parts.length !== 8) return null;
  const out = parts.map(p => parseInt(p || '0', 16));
  return out.some(x => !Number.isInteger(x) || x < 0 || x > 0xffff) ? null : out;
}
// true when `addr` is a literal IPv4/IPv6 address (no brackets) that must not be fetched. Anything
// that is not an address at all returns true.
function isPrivateAddress(addr) {
  const kind = nodeNet.isIP(addr);
  if (kind === 4) { const p = addr.split('.').map(Number); return ipv4Private(p[0], p[1]); }
  if (kind === 6) {
    const h = expandIpv6(addr);
    if (!h) return true;
    const embedded = () => ipv4Private(h[6] >> 8, h[6] & 255);   // the IPv4 in the last 32 bits
    if (h.every(x => x === 0)) return true;                                  // ::
    if (h.slice(0, 7).every(x => x === 0) && h[7] === 1) return true;       // ::1
    if (h.slice(0, 5).every(x => x === 0) && h[5] === 0xffff) return embedded();                // ::ffff:a.b.c.d (also its hex form ::ffff:7f00:1)
    if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every(x => x === 0)) return embedded();   // 64:ff9b::/96 NAT64
    if (h[0] === 0x2002) return ipv4Private(h[1] >> 8, h[1] & 255);          // 6to4 carries the IPv4 in hextets 1-2
    if ((h[0] & 0xfe00) === 0xfc00) return true;                             // fc00::/7 unique local
    if ((h[0] & 0xffc0) === 0xfe80) return true;                             // fe80::/10 link-local
    if ((h[0] & 0xff00) === 0xff00) return true;                             // multicast
    return false;
  }
  return true;
}
// Hostname (as URL.hostname gives it: IPv4 normalized to dotted form, IPv6 in brackets) -> true when
// it is local/private. Names without a dot are intranet names; known local suffixes are refused.
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (nodeNet.isIP(h)) return isPrivateAddress(h);
  if (!h.includes('.')) return true;
  return h === 'localhost' || /\.(localhost|local|internal|lan|home|corp|intranet|localdomain|home\.arpa)$/.test(h);
}

// Fetches and validates. Resolves to { ok, persona, error } (never rejects).
// opts: { maxBytes, timeoutMs, maxRedirects, resolveHost(hostname) -> Promise<address[]> }
function fetchPersona(url, transport, opts) {
  const o = opts || {};
  const maxBytes = o.maxBytes || MAX_PACK_BYTES;
  const totalMs = o.timeoutMs || TOTAL_TIMEOUT_MS;
  const maxHops = o.maxRedirects != null ? o.maxRedirects : MAX_REDIRECTS;
  return new Promise(resolve => {
    let settled = false, active = null, hops = 0;
    const finish = r => { if (settled) return; settled = true; clearTimeout(timer); if (active) { try { active.abort(); } catch (e) {} } resolve(r); };
    const timer = setTimeout(() => finish(fail('the download timed out')), totalMs);

    function go(current) {
      const why = checkUrl(current);
      if (why) return finish(fail(why));
      if (!o.resolveHost) return request(current);
      // Every address the name resolves to must be public, and the name must resolve at all.
      const host = new URL(current).hostname.replace(/^\[|\]$/g, '');
      if (nodeNet.isIP(host)) return request(current);   // a literal was already judged by checkUrl
      Promise.resolve().then(() => o.resolveHost(host)).then(addrs => {
        if (settled) return;
        if (!Array.isArray(addrs) || !addrs.length) return finish(fail('could not find ' + host));
        if (addrs.some(a => isPrivateAddress(String(a).replace(/^\[|\]$/g, '')))) return finish(fail(LOCAL_MSG));
        request(current);
      }, () => { if (!settled) finish(fail('could not find ' + host)); });
    }

    function request(current) {
      if (settled) return;
      const chunks = []; let size = 0, redirected = false;
      try {
        active = transport(current, {
          onResponse(status, headers) {
            const loc = headers && (headers.location || headers.Location);
            if (status >= 300 && status < 400 && loc) {
              redirected = true;
              if (++hops > maxHops) return finish(fail('too many redirects'));
              let next;
              try { next = new URL(Array.isArray(loc) ? loc[0] : loc, current).toString(); } catch (e) { return finish(fail('bad redirect from that URL')); }
              try { active.abort(); } catch (e) {}
              go(next);
              return;
            }
            if (status < 200 || status >= 300) return finish(fail('HTTP ' + status + ' from that URL'));
          },
          onData(chunk) {
            if (redirected || settled) return;
            size += chunk.length;
            if (size > maxBytes) return finish(fail('that file is larger than 64 KB, which is more than a persona can be'));
            chunks.push(chunk);
          },
          onEnd() {
            if (redirected || settled) return;
            finish(importPersonaText(Buffer.concat(chunks).toString('utf8')));
          },
          onError(err) { if (!redirected) finish(fail((err && err.message) || 'download failed')); },
        });
      } catch (err) { finish(fail((err && err.message) || 'download failed')); }
    }
    go(url);
  });
}

// The Electron adapter: makeNetTransport(electron.net) -> transport. Redirects are NOT followed
// (redirect: 'manual'). Verified against Electron: in manual mode a 3xx arrives ONLY as the
// 'redirect' event (never as 'response') and the request then errors with "Redirect was cancelled",
// so the event is turned into onResponse(status, { location }) for the policy to re-check. No
// cookies or saved credentials are sent (credentials: 'omit').
function makeNetTransport(netModule) {
  return function transport(url, h) {
    let req;
    try { req = netModule.request({ method: 'GET', url, redirect: 'manual', credentials: 'omit' }); }
    catch (e) { h.onError(e); return { abort() {} }; }
    let redirected = false;
    req.setHeader('Accept', 'application/json, text/plain;q=0.9, */*;q=0.1');
    req.on('redirect', (status, method, redirectUrl) => { redirected = true; h.onResponse(status, { location: redirectUrl }); });
    req.on('response', res => {
      h.onResponse(res.statusCode, res.headers || {});
      res.on('data', c => h.onData(c));
      res.on('end', () => h.onEnd());
      res.on('error', err => h.onError(err));
      res.on('aborted', () => h.onError(new Error('the connection was cut')));
    });
    req.on('error', err => { if (!redirected) h.onError(err); });
    req.end();
    return { abort() { try { req.abort(); } catch (e) {} } };
  };
}

module.exports = { fetchPersona, checkUrl, isPrivateHost, isPrivateAddress, makeNetTransport, MAX_REDIRECTS, TOTAL_TIMEOUT_MS };
