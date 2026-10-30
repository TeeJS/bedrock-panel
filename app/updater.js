'use strict';

// App self-update on top of electron-updater (GitHub provider, the latest*.yml files every release
// already carries). Plan: auto-update-plan.html (room AM-KUN8MB2YDQ8VT82ZU7SLYX2DR2, draft 11).
//
// - Automatic checks ~60 s after start and every 12 h (+0-30 min, never less) while
//   settings.updates.automatic is on. A failed check still schedules the next one.
// - Nothing downloads until the user picks a choice in the prompt (autoDownload stays false).
// - Install when I close = stock autoInstallOnAppQuit; Install now = the busy check first, then
//   quitAndInstall (it launches the installer BEFORE app.quit, so before-quit is too late to say no).
// - Skip this version is silent until a newer release; Not now re-offers after 24 h or next start.
// - Turning automatic updates off cancels automatic work; a manual check and the choice made in its
//   prompt are the user's own and always work.
// - The portable exe never self-updates: its prompt links to the release page.
// Everything Electron-specific is injected so the logic runs under node:test with fakes.

const FIRST_CHECK_MS = 60 * 1000;
const INTERVAL_MS = 12 * 60 * 60 * 1000;
const JITTER_MS = 30 * 60 * 1000;
const NOT_NOW_MS = 24 * 60 * 60 * 1000;

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// Feed versions are untrusted text: only a plain semver ever becomes a URL, under the fixed release path.
function releasePageUrl(version) { return SEMVER.test(String(version)) ? 'https://github.com/TeeJS/bedrock-panel/releases/tag/v' + encodeURIComponent(version) : null; }

function createUpdater(deps) {
  const au = deps.autoUpdater;
  const now = deps.now || (() => Date.now());
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const random = deps.random || Math.random;
  const startedAt = now();
  const portable = !!(deps.env && deps.env.PORTABLE_EXECUTABLE_FILE);
  const supported = !!deps.isPackaged;
  const reason = supported ? null : 'Updates only run in installed builds, not in development runs.';

  let persisted = Object.assign({ skippedVersion: null, dismissedVersion: null, dismissedAt: null, lastCheckedAt: null, lastError: null }, safe(deps.readState) || {});
  let state = 'idle';
  let manual = false;                 // the result on show came from a manual check
  let available = null;               // { version, releaseName }
  let progress = null;
  let pending = null;                 // { version, choice: 'onClose'|'now', byUser: bool, downloaded: bool }
  let checkSeq = 0;                   // every check gets a number; a reply for an older number is ignored
  let checkOrigin = null;             // 'auto' | 'manual' for the check in flight
  let downloadToken = null;
  let downloadGen = 0;                // every download gets a number; a completion for an older one is ignored
  let offGen = 0;                     // bumped on every switch-off: automatic prompts opened before it are void
  let betaGen = 0;                    // bumped when betas are turned off: beta prompts opened before it are void
  let lastIncludeBetas = null;
  let lastResultVersion = null;       // the version electron-updater's own metadata holds right now
  let timer = null;
  let promptOpen = false;
  let stopped = false;

  lastIncludeBetas = settings().includeBetas;    // tracked from creation, so a betas-off before start() still counts

  function safe(fn) { try { return fn ? fn() : null; } catch (e) { return null; } }
  function settings() { const s = safe(deps.getSettings) || {}; return { automatic: s.automatic !== false, includeBetas: s.includeBetas === true }; }
  function save() { safe(() => deps.writeState(persisted)); }
  function log(msg) { safe(() => deps.log && deps.log('[updater] ' + msg)); }

  function getStatus() {
    return {
      supported, reason, portable,
      currentVersion: deps.currentVersion,
      state, manual,
      available: available ? { version: available.version, releaseName: available.releaseName } : null,
      progress,
      pending: pending ? { version: pending.version, choice: pending.choice } : null,
      skipped: !!(available && persisted.skippedVersion === available.version),
      lastCheckedAt: persisted.lastCheckedAt,
      lastError: persisted.lastError,
    };
  }
  function emit() { safe(() => deps.onStatus && deps.onStatus(getStatus())); }

  // ---- scheduling (automatic checks only) ----
  function schedule(ms) {
    if (timer) clearT(timer);
    timer = null;
    if (stopped || !supported || !settings().automatic) return;
    timer = setT(() => { timer = null; check({ manual: false }); }, ms);
    if (timer && timer.unref) timer.unref();
  }
  function nextInterval() { return INTERVAL_MS + Math.floor(random() * JITTER_MS); }   // spread only adds

  function start() { schedule(FIRST_CHECK_MS); emit(); }
  function stop() { stopped = true; if (timer) clearT(timer); timer = null; }
  // Every way out of a check leaves the next automatic check scheduled (while automatic updates are on),
  // so a superseded or failed check can never end the 12 h chain.
  function ensureScheduled() { if (!timer && !stopped && supported && settings().automatic) schedule(nextInterval()); }

  // ---- checks ----
  async function check(opts) {
    try { await runCheck(opts); } finally { ensureScheduled(); }
  }
  async function runCheck({ manual: isManual }) {
    if (!supported) { if (isManual) await info('Updates', reason); return; }
    if (!isManual && !settings().automatic) return;
    // electron-updater downloads whatever its LAST check found, so no new check may run while a prompt
    // is waiting on a version or a download is under way: the chosen version must stay the fetched one.
    if (promptOpen || state === 'downloading') { if (!isManual) schedule(nextInterval()); return; }
    const seq = ++checkSeq;
    const checkBetaGen = betaGen;                  // a beta reply from before a betas-off is never offered
    checkOrigin = isManual ? 'manual' : 'auto';
    manual = isManual;
    state = 'checking'; emit();
    au.autoDownload = false;
    au.allowDowngrade = false;
    au.allowPrerelease = settings().includeBetas;   // electron-updater turns this on by itself for beta builds
    let result = null;
    try {
      result = await au.checkForUpdates();
    } catch (e) {
      if (seq !== checkSeq || (!isManual && !settings().automatic)) return;   // stale or switched off meanwhile
      persisted.lastError = shortError(e); save();
      state = 'error'; emit();
      log('check failed: ' + persisted.lastError);
      if (!isManual) schedule(INTERVAL_MS);     // a failed check still schedules the next one, 12 h later
      if (isManual) await info('Check for updates', 'Could not check for updates: ' + persisted.lastError);
      return;
    }
    if (seq !== checkSeq || (!isManual && !settings().automatic)) return;
    persisted.lastCheckedAt = new Date(now()).toISOString();
    persisted.lastError = null;
    save();
    if (!isManual) schedule(nextInterval());
    const infoObj = result && result.updateInfo;
    lastResultVersion = infoObj && infoObj.version ? String(infoObj.version) : null;
    const betaNotWanted = isPrerelease(lastResultVersion) && (!settings().includeBetas || betaGen !== checkBetaGen);   // betas went off (even if back on) since this check began
    if (!result || !result.isUpdateAvailable || !infoObj || !SEMVER.test(lastResultVersion) || betaNotWanted) {
      available = null; state = 'up-to-date'; emit();
      if (isManual) await info('Check for updates', 'Bedrock Panel ' + deps.currentVersion + ' is up to date.');
      return;
    }
    available = { version: infoObj.version, releaseName: infoObj.releaseName || '' };
    if (pending && pending.version !== available.version) { cancelDownload(); pending = null; au.autoInstallOnAppQuit = false; }   // a newer release replaces an older pending one
    if (pending && !pending.downloaded) { state = 'downloading'; emit(); return; }                 // already on its way
    if (pending && pending.downloaded) { state = 'ready'; emit(); if (isManual) await prompt(true); return; }
    state = 'available'; emit();
    if (isManual) { await prompt(true); return; }
    if (persisted.skippedVersion === available.version) return;                       // silent until a newer release
    if (persisted.dismissedVersion === available.version && persisted.dismissedAt
      && persisted.dismissedAt >= startedAt && now() - persisted.dismissedAt < NOT_NOW_MS) return;   // Not now: 24 h or next start
    safe(() => deps.notify && deps.notify('Bedrock Panel update', 'Version ' + available.version + ' is available.'));
    await prompt(false);
  }

  function shortError(e) { const m = (e && e.message ? String(e.message) : String(e || 'unknown error')).split('\n')[0]; return m.slice(0, 160); }

  async function info(title, message) { try { await deps.showMessage({ title, message }); } catch (e) {} }

  // ---- the prompt ----
  async function prompt(fromManual) {
    if (!available || promptOpen) return;
    promptOpen = true;
    const v = available.version;
    const skippedNote = persisted.skippedVersion === v ? ' (you skipped this version)' : '';
    const detail = 'You have ' + deps.currentVersion + '.' + (available.releaseName ? ' ' + available.releaseName : '') + skippedNote;
    // An automatic prompt answered after the switch went off is void, even if it was turned back on.
    const openedAtGen = offGen;
    const openedAtBetaGen = betaGen;
    const betaStillWanted = () => !isPrerelease(v) || (settings().includeBetas && betaGen === openedAtBetaGen);
    const stillAllowed = () => betaStillWanted() && (fromManual || (settings().automatic && offGen === openedAtGen));
    try {
      if (portable) {
        const r = await deps.showPrompt({ message: 'Bedrock Panel ' + v + ' is available', detail: detail + '\nThis is the portable version, which does not update itself.', buttons: ['Download ' + v, 'Skip this version', 'Not now'], defaultId: 0, cancelId: 2 });
        if (!stillAllowed()) return;
        const url = releasePageUrl(v);
        if (r === 0) { if (url) safe(() => deps.openExternal(url)); }
        else if (r === 1) skip(v);
        else notNow(v);
        return;
      }
      const ready = !!(pending && pending.downloaded && pending.version === v);
      const r = await deps.showPrompt({ message: 'Bedrock Panel ' + v + (ready ? ' is ready to install' : ' is available'), detail, buttons: ['Install when I close Bedrock Panel', 'Install now and restart', 'Skip this version', 'Not now'], defaultId: 0, cancelId: 3 });
      if (!stillAllowed()) return;
      if (r === 0) choose(v, 'onClose', fromManual);
      else if (r === 1) choose(v, 'now', fromManual);
      else if (r === 2) skip(v);
      else notNow(v);
    } finally {
      promptOpen = false;
      emit();
    }
  }

  function skip(v) {
    persisted.skippedVersion = v; save();
    if (pending && pending.version === v) { cancelDownload(); pending = null; au.autoInstallOnAppQuit = false; }
    emit();
  }
  function notNow(v) { persisted.dismissedVersion = v; persisted.dismissedAt = now(); save(); emit(); }

  function choose(v, choice, byUser) {
    if (persisted.skippedVersion === v) { persisted.skippedVersion = null; save(); }   // choosing to install undoes a skip
    const wasDownloaded = !!(pending && pending.version === v && pending.downloaded);
    pending = { version: v, choice, byUser: !!byUser, downloaded: wasDownloaded };
    au.autoInstallOnAppQuit = false;
    if (wasDownloaded) { onDownloaded(); return; }
    download();
  }

  function download() {
    if (!pending) return;
    if (!allowed(pending)) { pending = null; state = available ? 'available' : 'idle'; emit(); return; }
    // downloadUpdate fetches what electron-updater's last check found. If that isn't the version the
    // user chose, start nothing: the next check offers the current release instead.
    if (lastResultVersion !== pending.version) { log('chosen ' + pending.version + ' but metadata holds ' + lastResultVersion + ', not downloading'); pending = null; state = available ? 'available' : 'idle'; emit(); return; }
    state = 'downloading'; progress = 0; emit();
    downloadToken = deps.makeCancellationToken ? deps.makeCancellationToken() : null;
    const gen = ++downloadGen;
    Promise.resolve(au.downloadUpdate(downloadToken || undefined)).then(() => {
      if (gen !== downloadGen || !pending) return;                 // cancelled, skipped or superseded
      pending.downloaded = true;
      onDownloaded();
    }, (e) => {
      if (gen !== downloadGen || !pending) return;                 // cancelled or replaced
      persisted.lastError = shortError(e); save();
      pending = null; progress = null; state = 'error'; emit();
      log('download failed: ' + persisted.lastError);
    });
  }

  function onDownloaded() {
    progress = null; state = 'ready'; emit();
    if (!pending) return;
    if (!allowed(pending)) { au.autoInstallOnAppQuit = false; return; }
    if (pending.choice === 'onClose') { au.autoInstallOnAppQuit = true; emit(); return; }
    installNow();
  }

  // Automatic updates must be on, or this exact choice was made in a manual check's prompt. A beta also
  // needs "Include beta versions" to still be on: turning it off stops a beta that is waiting to install.
  function allowed(p) {
    if (!p) return false;
    if (isPrerelease(p.version) && !settings().includeBetas) return false;
    return settings().automatic || p.byUser === true;
  }
  function isPrerelease(v) { return /-/.test(String(v)); }

  function installNow() {
    if (!pending || !allowed(pending)) return;
    // quitAndInstall starts the installer before app.quit runs, so the "recording in progress" question
    // has to come first. Keep running leaves the update ready; nothing is scheduled.
    if (!deps.confirmQuitIfBusy()) { pending.choice = 'now'; au.autoInstallOnAppQuit = false; state = 'ready'; emit(); return; }
    try { au.quitAndInstall(true, true); } catch (e) { persisted.lastError = shortError(e); save(); state = 'error'; emit(); }
  }

  function cancelDownload() { downloadGen++; try { if (downloadToken && downloadToken.cancel) downloadToken.cancel(); } catch (e) {} downloadToken = null; progress = null; }

  // ---- settings saved in the editor ----
  function applySettings() {
    au.allowPrerelease = settings().includeBetas;
    if (lastIncludeBetas === true && !settings().includeBetas) betaGen++;   // open beta prompts become void
    lastIncludeBetas = settings().includeBetas;
    if (!settings().includeBetas) {                         // betas turned off: a waiting beta stops, from any origin
      if (pending && isPrerelease(pending.version)) { cancelDownload(); pending = null; au.autoInstallOnAppQuit = false; }
      if (available && isPrerelease(available.version)) { available = null; if (state !== 'checking') state = 'idle'; }
    }
    if (!settings().automatic) {
      offGen++;
      if (timer) clearT(timer);
      timer = null;
      if (checkOrigin === 'auto') checkSeq++;                // a late automatic reply is ignored
      if (pending && !pending.byUser) {                      // automatic work stops; the user's own choice stands
        cancelDownload(); pending = null; au.autoInstallOnAppQuit = false;
        if (state === 'downloading' || state === 'ready') state = available ? 'available' : 'idle';
      }
    } else if (!timer && !stopped) {
      schedule(INTERVAL_MS);
    }
    emit();
  }

  // ---- event wiring ----
  au.on('download-progress', (p) => { if (state === 'downloading') { progress = Math.max(0, Math.min(100, Math.round((p && p.percent) || 0))); emit(); } });
  au.on('error', (e) => { log('error: ' + shortError(e)); });

  // Tray items for the current state, shown under the version line. Empty when there's nothing to say.
  function trayItems() {
    const out = [];
    const visible = settings().automatic || (pending && pending.byUser);
    if (supported && visible && available && persisted.skippedVersion !== available.version) {
      let label;
      if (state === 'downloading') label = 'Downloading v' + available.version + (progress != null ? ' (' + progress + '%)' : '');
      else if (pending && pending.downloaded && pending.choice === 'onClose' && au.autoInstallOnAppQuit) label = 'v' + available.version + ' ready — installs when you close';
      else if (pending && pending.downloaded) label = 'v' + available.version + ' ready to install';
      else label = 'Update available — v' + available.version;
      out.push({ label, click: () => { prompt(manual); } });
    }
    out.push({ label: 'Check for updates', enabled: state !== 'checking' && state !== 'downloading', click: () => { check({ manual: true }); } });
    return out;
  }

  return {
    start, stop, getStatus, applySettings, trayItems,
    checkNow: () => { check({ manual: true }); return { started: true }; },
    openPrompt: () => { if (!available) return { opened: false }; prompt(manual); return { opened: true }; },
    _check: check,                           // tests
  };
}

module.exports = { createUpdater, FIRST_CHECK_MS, INTERVAL_MS, JITTER_MS, NOT_NOW_MS, releasePageUrl };
