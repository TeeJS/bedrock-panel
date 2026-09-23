'use strict';
// Pure helpers for installing/updating drop-in apps from a repository. No electron/fs -- unit-tested
// in test/appRepo.test.js. The main process (app/main.js) wraps these with net.fetch + downloads.
//
// A "repo" is just a base URL that serves an index.json catalog and the per-app <id>.zip files. The
// default the UI ships is a github.com tree URL; repoRawBase() turns that into the raw.githubusercontent
// base actually fetched from, so users can paste either form (or point at any other static host).

// github.com/<o>/<r>/tree|blob/<branch>/<path...>  ->  raw.githubusercontent.com/<o>/<r>/<branch>/<path...>
// raw URLs and other http(s) bases pass through (trailing slash trimmed). Junk / non-http -> ''.
function repoRawBase(url) {
  var s = String(url || '').trim();
  if (!s) return '';
  var m = s.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)(?:\/(.*))?$/i);
  if (m) {
    var path = (m[4] || '').replace(/\/+$/, '');
    return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3] + (path ? '/' + path : '');
  }
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  return '';
}

// The repo was renamed TeeJS/open-quake -> TeeJS/bedrock-panel. Pre-rename installs saved the old URL
// (settings and per-app sources), and raw.githubusercontent.com serves a FROZEN pre-rename catalog for
// it rather than redirecting -- so update checks silently never see new versions. Map it to the new
// name. Anchored on the exact repo segment: TeeJS/open-quake-apps-private is a different repo.
function canonicalRepoUrl(url) {
  return String(url == null ? '' : url)
    .replace(/^(\s*https?:\/\/(?:www\.)?(?:github\.com|raw\.githubusercontent\.com)\/TeeJS\/)open-quake(?=\/|\s*$)/i, '$1bedrock-panel');
}

function indexUrl(base) { return repoRawBase(base) + '/index.json'; }

// Parse a github.com tree/blob URL (or a raw.githubusercontent base) into Contents-API coordinates
// { owner, repo, ref, path }, used to read PRIVATE repos with an OAuth token. Returns null otherwise.
function githubContentsCoords(url) {
  var s = String(url || '').trim();
  var m = s.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)(?:\/(.*))?$/i);
  if (!m) m = s.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(.*))?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[3], path: (m[4] || '').replace(/\/+$/, '') };
}

// GitHub Contents API URL for a file inside the repo path (fetch with Accept: application/vnd.github.raw).
function githubContentsUrl(coords, file) {
  if (!coords) return '';
  var p = (coords.path ? coords.path + '/' : '') + String(file || '').replace(/^\/+/, '');
  return 'https://api.github.com/repos/' + coords.owner + '/' + coords.repo + '/contents/' + p + '?ref=' + encodeURIComponent(coords.ref);
}

// Only GitHub-hosted repositories are allowed for now (github.com tree/blob URLs and the
// raw.githubusercontent.com bases they resolve to). Blocks pointing the installer at an arbitrary host.
function isAllowedRepoUrl(url) {
  var m = String(url || '').trim().match(/^https?:\/\/([^/]+)/i);
  var host = m ? m[1].toLowerCase() : '';
  return host === 'github.com' || host === 'raw.githubusercontent.com';
}

// Resolve an index entry's zip to an absolute URL. An entry.zip may be an absolute http(s) URL
// (custom hosting) or a bare filename resolved against the repo base.
function zipUrl(base, entry) {
  var z = String((entry && entry.zip) || '').trim();
  if (!z) return '';
  if (/^https?:\/\//i.test(z)) return z;
  return repoRawBase(base) + '/' + z.replace(/^\/+/, '');
}

// Compare dotted numeric versions. Returns -1 (a<b), 0 (equal), 1 (a>b). Non-numeric parts count as 0,
// so "1.2" < "1.2.1" and "1.0" == "1.0.0".
function cmpVersion(a, b) {
  var pa = String(a == null ? '' : a).split('.');
  var pb = String(b == null ? '' : b).split('.');
  var n = Math.max(pa.length, pb.length);
  for (var i = 0; i < n; i++) {
    var x = parseInt(pa[i], 10); if (!isFinite(x)) x = 0;
    var y = parseInt(pb[i], 10); if (!isFinite(y)) y = 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// Normalize a fetched catalog (either { apps:[...] } or a bare array) into a clean app list.
// Drops entries without a usable id.
function parseIndex(json) {
  var arr = json && Array.isArray(json.apps) ? json.apps : (Array.isArray(json) ? json : []);
  var out = [];
  arr.forEach(function (a) {
    if (!a || typeof a.id !== 'string' || !a.id.trim()) return;
    out.push({
      id: a.id.trim(),
      name: (typeof a.name === 'string' && a.name) || a.id.trim(),
      description: typeof a.description === 'string' ? a.description : '',
      version: typeof a.version === 'string' ? a.version : '0.0.0',
      zip: typeof a.zip === 'string' ? a.zip : (a.id.trim() + '.zip'),
      server: !!a.server,
    });
  });
  return out;
}

module.exports = { canonicalRepoUrl, repoRawBase, indexUrl, zipUrl, cmpVersion, parseIndex, isAllowedRepoUrl, githubContentsCoords, githubContentsUrl };
