'use strict';

// IO edge: GitHub REST + asset download + digest verify. Uses Node 18+ global fetch.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const API = 'https://api.github.com';
const UA = 'release-watcher';
const MAX_BYTES = 500 * 1024 * 1024; // 500 MB download cap

function apiHeaders() {
  const h = {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

// The Electron GUI injects Electron's net.fetch here (see electron/main.js) so requests go
// through Chromium's network stack, which trusts the OS/Windows certificate store — including
// a corporate VPN/proxy's root CA that Node's own bundled CA list rejects with
// UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Left unset (headless CLI, tests) we fall back to the
// global fetch; globalThis.fetch is read at call time so tests can still stub it.
let _fetchImpl = null;
function setFetch(fn) { _fetchImpl = typeof fn === 'function' ? fn : null; }
function doFetch(url, init) { return (_fetchImpl || globalThis.fetch)(url, init); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TLS trust failures never recover on retry, and almost always mean a corporate VPN/proxy is
// doing SSL inspection with a root CA the app doesn't trust.
const TLS_CERT_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED',
]);

// Node's global fetch reports EVERY network-level failure (DNS, TLS, a reset or refused
// connection, a timeout, a blocking proxy) as a generic TypeError whose message is just
// "fetch failed" — the real reason sits in err.cause. A connection reset mid-download
// instead surfaces a Node system-error code directly (err.code). Recognize both so we can
// retry them and report something the user can act on.
function isNetworkError(err) {
  if (!err) return false;
  if (err instanceof TypeError && err.cause) return true; // "fetch failed" / "terminated"
  const code = err.code || (err.cause && err.cause.code);
  return typeof code === 'string' && /^(E[A-Z]+|UND_ERR_)/.test(code);
}

// Turn a bare "fetch failed" into an actionable message that names the host that was
// unreachable and the underlying cause, e.g.
// "network error reaching objects.githubusercontent.com: ECONNRESET".
function describeNetworkError(err, url) {
  let host = url;
  try { host = new URL(url).host; } catch {}
  const cause = err && err.cause;
  const code = (cause && cause.code) || (err && err.code) || null;
  const detail = code || (cause && cause.message) || (err && err.message) || String(err);
  let msg = `network error reaching ${host}: ${detail}`;
  if (code && TLS_CERT_CODES.has(code)) {
    msg += " — the network's TLS certificate isn't trusted (common on a corporate VPN/proxy; works off it)";
  }
  const e = new Error(msg);
  e.networkError = true;
  e.code = code;
  return e;
}

// Transient network failures are common on release downloads and usually clear on a second
// try — that's exactly why the Retry button works. Retry them automatically with a short
// exponential backoff. HTTP error *statuses* (404, 403, …) and any other non-network error
// are NOT retried: fn throws them and we rethrow unchanged so the caller decides what they
// mean. Only real network failures are retried, and if they exhaust we throw a described one.
const NET_TRIES = 3;
const NET_BASE_DELAY_MS = 400; // 400ms, then 800ms

async function withNetRetry(fn, url) {
  let lastErr;
  for (let attempt = 1; attempt <= NET_TRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isNetworkError(err)) throw err; // not a network problem: bubble up unchanged
      lastErr = err;
      const code = err.code || (err.cause && err.cause.code) || '';
      if (TLS_CERT_CODES.has(code) || attempt === NET_TRIES) break; // cert errors never recover
      await sleep(NET_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  throw describeNetworkError(lastErr, url);
}

async function ghJson(url) {
  const res = await withNetRetry(() => doFetch(url, { headers: apiHeaders() }), url);
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset') || 0);
    const when = reset ? new Date(reset * 1000).toLocaleTimeString() : 'later';
    const e = new Error(`GitHub rate limit hit (resets ~${when}). Set GITHUB_TOKEN to raise the limit.`);
    e.rateLimited = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`GitHub ${res.status} for ${url}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// True if the repo itself is gone (deleted/renamed/private) rather than just release-less.
async function repoMissing(owner, repo) {
  try {
    await ghJson(`${API}/repos/${owner}/${repo}`);
    return false;
  } catch (e) {
    return e.status === 404;
  }
}

// Some repos (bitwarden/clients, and other monorepos) publish several independent release
// trains under one repo — desktop-vX, web-vX, browser-vX... — interleaved by publish date.
// /releases/latest just returns whichever train published most recently, which is often the
// WRONG product. tagPrefix pins detection to releases whose tag starts with a given prefix.
const TAG_PREFIX_MAX_PAGES = 5; // 500 releases; well past any repo's realistic per-train gap

async function findByTagPrefix(owner, repo, prefix, includePrerelease) {
  for (let page = 1; page <= TAG_PREFIX_MAX_PAGES; page++) {
    const list = await ghJson(`${API}/repos/${owner}/${repo}/releases?per_page=100&page=${page}`);
    if (!list || list.length === 0) break;
    const hit = list.find((r) => !r.draft && (includePrerelease || !r.prerelease) && String(r.tag_name || '').startsWith(prefix));
    if (hit) return hit;
    if (list.length < 100) break; // last page reached
  }
  throw Object.assign(new Error('x'), { status: 404 });
}

// /releases/latest excludes prereleases + drafts; opts.prerelease uses /releases[0] (first non-draft).
// opts.tagPrefix restricts either mode to one release train within a multi-product repo.
// On 404, distinguish a missing repo (deleted/renamed) from a repo with no matching releases.
async function getLatestRelease(owner, repo, opts = {}) {
  try {
    if (opts.tagPrefix) {
      return await findByTagPrefix(owner, repo, opts.tagPrefix, opts.prerelease);
    }
    if (opts.prerelease) {
      const list = await ghJson(`${API}/repos/${owner}/${repo}/releases?per_page=10`);
      const rel = (list || []).find((r) => !r.draft);
      if (!rel) throw Object.assign(new Error('x'), { status: 404 });
      return rel;
    }
    return await ghJson(`${API}/repos/${owner}/${repo}/releases/latest`);
  } catch (e) {
    if (e.status === 404) {
      if (await repoMissing(owner, repo)) throw new Error('repository not found (deleted, renamed, or private)');
      throw new Error(opts.tagPrefix ? `no releases found with tag prefix "${opts.tagPrefix}"` : 'no releases found for this repository');
    }
    throw e;
  }
}

async function listAssets(owner, repo, opts = {}) {
  const rel = await getLatestRelease(owner, repo, opts);
  return { tag: rel.tag_name, assets: (rel.assets || []).map((a) => a.name) };
}

// fetch follows redirects by default; enforce the size cap while streaming.
// onProgress(pct 0-100) is called as bytes arrive (throttled) when a size is known.
async function downloadAsset(url, destPath, onProgress) {
  // Retry the whole download: a reset can hit either the initial connection (fetch rejects)
  // or the body stream (pipeline rejects). Each attempt re-fetches and overwrites destPath,
  // so a partial file from a failed try is never left behind.
  return withNetRetry(async () => {
    const res = await doFetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`download ${res.status} for ${url}`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > MAX_BYTES) throw new Error(`asset too large: ${declared} bytes (cap ${MAX_BYTES})`);
    let seen = 0;
    let lastPct = -1;
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const chunk of source) {
          seen += chunk.length;
          if (seen > MAX_BYTES) throw new Error(`asset exceeded size cap ${MAX_BYTES} bytes`);
          if (onProgress && declared) {
            const pct = Math.floor((seen / declared) * 100);
            if (pct !== lastPct) {
              lastPct = pct;
              onProgress(pct);
            }
          }
          yield chunk;
        }
      },
      fs.createWriteStream(destPath)
    );
    return destPath;
  }, url);
}

// Fallback when GitHub provides no asset.digest: many releases ship a checksums file
// (SHA256SUMS, <name>.sha256, SHA512-SUMS.txt, checksums.txt...). Find one in the same
// release, download it (small), and pull the hash for assetName from it.
// Returns { algo, expected } or null when the release has nothing usable.
const SUMS_FILE = /(sha(256|512)[-_.]?sums?|checksums?)(\.txt)?$|\.(sha256|sha512)$/i;
const MAX_SUMS_BYTES = 1024 * 1024;

async function fetchChecksumFromRelease(rel, assetName) {
  const candidates = (rel.assets || []).filter(
    (a) => SUMS_FILE.test(a.name) && a.size <= MAX_SUMS_BYTES &&
      // "<name>.sha256"-style files must belong to OUR asset
      (!/\.(sha256|sha512)$/i.test(a.name) || a.name.toLowerCase().startsWith(assetName.toLowerCase()))
  );
  for (const c of candidates) {
    try {
      const res = await doFetch(c.browser_download_url, { headers: { 'User-Agent': UA } });
      if (!res.ok) continue;
      const text = await res.text();
      // Lines look like "<hex>  <filename>" (or "<hex> *<filename>"), or a bare hex
      // for per-asset .sha256 files.
      for (const line of text.split(/\r?\n/)) {
        const m = line.trim().match(/^([a-f0-9]{64}|[a-f0-9]{128})\s+\*?(.+)$/i);
        if (m && path.basename(m[2].trim()).toLowerCase() === assetName.toLowerCase()) {
          return { algo: m[1].length === 64 ? 'sha256' : 'sha512', expected: m[1] };
        }
      }
      const bare = text.trim().match(/^([a-f0-9]{64}|[a-f0-9]{128})\b/i);
      if (bare && /\.(sha256|sha512)$/i.test(c.name)) {
        return { algo: bare[1].length === 64 ? 'sha256' : 'sha512', expected: bare[1] };
      }
    } catch {}
  }
  return null;
}

// digest: GitHub asset.digest like "sha256:abc..." . Missing/unsupported -> skip with a note.
function verifyDigest(filePath, digest) {
  if (!digest) return { skipped: true, note: 'no digest from GitHub; checksum skipped' };
  const [algo, expected] = String(digest).split(':');
  if (!['sha256', 'sha512'].includes(algo) || !expected) return { skipped: true, note: `unsupported digest "${digest}"; skipped` };
  const hash = crypto.createHash(algo);
  hash.update(fs.readFileSync(filePath)); // ponytail: whole-file read; stream if assets get very large
  const actual = hash.digest('hex');
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
  }
  return { verified: true };
}

module.exports = { getLatestRelease, listAssets, downloadAsset, verifyDigest, fetchChecksumFromRelease, setFetch };
