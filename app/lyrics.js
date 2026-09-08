'use strict';
/*
 * lyrics.js — synced lyrics for the Music app, from LRCLIB (https://lrclib.net, free, no key). [MIT]
 *
 * Fetched in the main process (the page CSP is connect-src 'self') and served over loopback. Only the
 * track's title / artist / album / duration leave the machine, and only while the lyrics box is shown
 * (the page polls /lyrics on demand). Results are cached per track. Synced lyrics scroll; if only plain
 * lyrics exist, they're shown without auto-scroll; no match -> "No lyrics found".
 */
const { net } = require('electron');

let snapshot = { ok: false, key: '', synced: false, lines: [], plain: '' };
let curKey = '', busy = false;
const cache = {};   // trackKey -> { synced, lines:[{t,line}], plain }

function trackKey(t) { return t ? (t.title || '') + '\t' + (t.artist || '') : ''; }

// Parse an LRC body ("[mm:ss.xx] line") into time-sorted {t, line} entries. One line can carry several stamps.
function parseLRC(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach(raw => {
    const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g; let m; const stamps = [];
    while ((m = re.exec(raw))) stamps.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (m[3] ? parseInt((m[3] + '00').slice(0, 3), 10) / 1000 : 0));
    const line = raw.replace(/\[[^\]]*\]/g, '').trim();
    stamps.forEach(t => out.push({ t, line }));
  });
  return out.sort((a, b) => a.t - b.t);
}

function fetchLyrics(track) {
  return new Promise(resolve => {
    const artist = (track.artist || '').trim(), title = (track.title || '').trim();
    if (!artist || !title) return resolve(null);
    const p = new URLSearchParams({ artist_name: artist, track_name: title });
    if (track.album) p.set('album_name', track.album);
    if (track.duration > 0) p.set('duration', String(Math.round(track.duration)));
    let req, to, done = false; const chunks = [];
    const finish = v => { if (done) return; done = true; if (to) clearTimeout(to); resolve(v); };
    try { req = net.request('https://lrclib.net/api/get?' + p.toString()); } catch (e) { return resolve(null); }
    req.setHeader('User-Agent', 'bedrock-panel (https://github.com/TeeJS/bedrock-panel)');
    to = setTimeout(() => { try { req.abort(); } catch (e) {} finish(null); }, 6000);
    req.on('error', () => finish(null));
    req.on('response', resp => {
      if (resp.statusCode !== 200) { resp.resume(); return finish(null); }   // 404 = no match
      resp.on('data', d => chunks.push(d));
      resp.on('error', () => finish(null));
      resp.on('end', () => { try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { finish(null); } });
    });
    req.end();
  });
}

// Make the snapshot reflect `track`, fetching (once, cached) if needed. Called on-demand from /lyrics.
async function ensure(track) {
  const key = trackKey(track);
  if (!key) { curKey = ''; snapshot = { ok: false, key: '', synced: false, lines: [], plain: '' }; return; }
  if (cache[key]) { curKey = key; snapshot = Object.assign({ ok: true, key }, cache[key]); return; }
  curKey = key;
  if (busy) return;                                  // a fetch is in flight; the next poll will pick up the result
  busy = true;
  const data = await fetchLyrics(track).catch(() => null);
  busy = false;
  if (curKey !== key) return;                        // track changed mid-fetch — drop this result
  const lines = (data && data.syncedLyrics) ? parseLRC(data.syncedLyrics) : [];
  cache[key] = { synced: lines.length > 0, lines, plain: (data && data.plainLyrics) || '' };
  snapshot = Object.assign({ ok: true, key }, cache[key]);
}

function getSnapshot() { return snapshot; }

module.exports = { ensure, getSnapshot };
