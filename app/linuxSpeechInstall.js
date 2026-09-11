'use strict';
/*
 * linuxSpeechInstall.js — fetches the built-in Linux speech engine and its voices on first use.
 *
 * Nothing speech-related ships in the deb or the AppImage. That keeps the packages the size they are
 * today, lets the AppImage behave identically to the deb, and means a person downloads the one voice
 * they picked rather than carrying voices for languages they do not speak. The cost is this module.
 *
 * Everything it fetches is pinned and verified in app/linuxSpeechCatalog.js — a URL is not a
 * promise, so the engine is checked by sha256 and each voice by the md5 the upstream index
 * publishes. A file that does not match is deleted rather than installed, because a corrupt voice
 * fails later, deeper, and less legibly than a failed download.
 *
 * Downloads land in a .part file and are renamed into place only once verified, so an interrupted
 * install leaves nothing half-written for `installed()` to find and believe.
 *
 * Dependency-injected (http getter, fs, tar runner) so it unit-tests against a fake server and a
 * temp directory, with no network.
 */
const path = require('path');
const fsDefault = require('fs');
const https = require('https');
const crypto = require('crypto');
const { execFile: execFileDefault } = require('child_process');
const catalog = require('./linuxSpeechCatalog');
const { layout } = require('./linuxSpeech');

// Follows redirects, because the voice host answers with one and a plain GET would store the
// redirect page as a 60 MB model and fail the digest with a confusing message.
function httpsGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'bedrock-panel' } }, res => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { reject(new Error('too many redirects')); return; }
        resolve(httpsGet(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
        return;
      }
      if (code !== 200) { res.resume(); reject(new Error('HTTP ' + code + ' for ' + url)); return; }
      resolve(res);
    }).on('error', reject);
  });
}

function createSpeechInstaller(options) {
  const opts = options || {};
  const baseDir = opts.baseDir || '';
  const log = opts.log || (() => {});
  const get = opts.get || httpsGet;
  const fs = opts.fs || fsDefault;
  const execFile = opts.execFile || execFileDefault;
  const paths = layout(baseDir);

  let cancelled = false;

  function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }

  function engineInstalled() { return fs.existsSync(paths.piperBinary); }

  function installedVoices() {
    try {
      return fs.readdirSync(paths.voicesDir)
        .filter(id => fs.existsSync(path.join(paths.voicesDir, id, id + '.onnx')));
    } catch (e) { return []; }
  }

  /**
   * Fetch one URL to `dest`, hashing as it goes. `digest` is {algo, value}; an empty value skips the
   * check, which is only ever used for the two-kilobyte voice config that the index does not list.
   */
  async function fetchTo(url, dest, digest, onChunk) {
    const part = dest + '.part';
    mkdirp(path.dirname(dest));
    const res = await get(url);
    const hash = digest && digest.value ? crypto.createHash(digest.algo) : null;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part);
      res.on('data', chunk => {
        if (hash) hash.update(chunk);
        if (onChunk) onChunk(chunk.length);
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      res.pipe(out);
    });
    if (cancelled) { try { fs.unlinkSync(part); } catch (e) {} throw new Error('cancelled'); }
    if (hash) {
      const got = hash.digest('hex');
      if (got !== digest.value) {
        try { fs.unlinkSync(part); } catch (e) {}
        throw new Error('checksum mismatch for ' + path.basename(dest) + ' (expected ' + digest.value + ', got ' + got + ')');
      }
    }
    fs.renameSync(part, dest);
  }

  function untar(archive, dest, stripComponents) {
    return new Promise((resolve, reject) => {
      mkdirp(dest);
      const args = ['-xzf', archive, '-C', dest];
      if (stripComponents) args.push('--strip-components=' + stripComponents);
      execFile('tar', args, err => err ? reject(err) : resolve());
    });
  }

  /**
   * Install the engine (once) and one voice. `onProgress({phase, received, total})` is called as
   * bytes arrive; `total` is known before the first byte, from the catalogue.
   */
  async function install(voiceId, onProgress) {
    cancelled = false;
    const voice = catalog.voiceById(voiceId) || catalog.defaultVoice();
    const needEngine = !engineInstalled();
    const total = catalog.downloadBytes(voice, !needEngine);
    let received = 0;
    const tick = n => { received += n; if (onProgress) onProgress({ phase: 'download', received, total }); };
    if (onProgress) onProgress({ phase: 'start', received: 0, total });

    if (needEngine) {
      const archive = path.join(paths.root, 'piper.tar.gz');
      log('downloading the speech engine (' + Math.round(catalog.ENGINE.bytes / 1048576) + ' MB)');
      await fetchTo(catalog.ENGINE.url, archive, { algo: 'sha256', value: catalog.ENGINE.sha256 }, tick);
      if (onProgress) onProgress({ phase: 'extract', received, total });
      await untar(archive, paths.piperDir, catalog.ENGINE.stripComponents);
      try { fs.unlinkSync(archive); } catch (e) {}
      try { fs.chmodSync(paths.piperBinary, 0o755); } catch (e) {}
      log('speech engine installed');
    }

    const voiceDir = path.join(paths.voicesDir, voice.id);
    for (const file of catalog.voiceFiles(voice)) {
      const dest = path.join(voiceDir, file.name);
      if (fs.existsSync(dest) && file.bytes) { received += file.bytes; continue; }
      await fetchTo(file.url, dest, { algo: 'md5', value: file.md5 }, file.bytes ? tick : null);
    }
    log('voice installed: ' + voice.id + ' (' + voice.license + ')');
    if (onProgress) onProgress({ phase: 'done', received: total, total });
    return { voice: voice.id, engineInstalled: true };
  }

  function cancel() { cancelled = true; }

  /** Remove one voice. The engine stays, because another voice may still be using it. */
  function removeVoice(id) {
    const dir = path.join(paths.voicesDir, id);
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch (e) { return false; }
  }

  return { paths, install, cancel, engineInstalled, installedVoices, removeVoice };
}

module.exports = { createSpeechInstaller, httpsGet };
