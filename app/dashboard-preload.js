'use strict';
// Session preload for the panel's web pages (the persist:dashboards session, which the dashboards
// and the served app pages share). A web page that asks for "a microphone" -- getUserMedia with no
// deviceId -- gets Chromium's pick, which is the Windows default device, not the mic chosen in
// Bedrock Panel (Settings → General → Audio, or the page's own Audio override). This wraps the page's
// getUserMedia so such a request opens Bedrock Panel's mic instead. A request that names a device is
// left alone, so a page with its own mic picker keeps it. Main answers 'dash-mic-label' with the
// active page's mic, or '' for "leave Chromium's default" (see main.js dashboardMicLabel).

// Runs IN THE PAGE: contextBridge.executeInMainWorld serializes this function, so it must stay
// self-contained (nothing from this file's scope). The name matching mirrors matchMicLabel in
// claudevoice-vad.js. `mediaDevices` is for tests; in the page it is navigator.mediaDevices.
function installMicPreference(label, mediaDevices) {
  const md = mediaDevices || (typeof navigator === 'object' ? navigator.mediaDevices : null);
  if (!label || !md || typeof md.getUserMedia !== 'function') return false;
  const open = md.getUserMedia.bind(md);
  const bare = s => String(s).replace(/^(default|communications)\s*-\s*/i, '').trim().toLowerCase();
  const noId = s => bare(s).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '');
  const real = d => d.deviceId !== 'default' && d.deviceId !== 'communications';
  const pick = list => {
    const inputs = (list || []).filter(d => d && d.kind === 'audioinput' && d.label);
    const exact = inputs.find(d => d.label === label && real(d));
    if (exact) return exact.deviceId;
    for (const key of [bare, noId]) {
      const hit = inputs.find(d => real(d) && key(d.label) === key(label));
      if (hit) return hit.deviceId;
    }
    return '';
  };
  const unnamed = c => !!c && !!c.audio && (c.audio === true || (typeof c.audio === 'object' && !c.audio.deviceId));
  const onDevice = (c, id) => Object.assign({}, c, { audio: Object.assign({}, c.audio === true ? {} : c.audio, { deviceId: { exact: id } }) });
  const listed = async () => { try { return pick(await md.enumerateDevices()); } catch (e) { return ''; } };

  const getUserMedia = async function getUserMedia(constraints) {
    if (!unnamed(constraints)) return open(constraints);
    // Names are listed only once the page may capture, so a first request may have to open
    // Chromium's default before the named mic can be found, then reopen on it.
    let id = await listed();
    if (id) { try { return await open(onDevice(constraints, id)); } catch (e) { return open(constraints); } }
    const stream = await open(constraints);
    id = await listed();
    const track = stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
    const current = track && track.getSettings ? track.getSettings().deviceId : '';
    if (!id || id === current) return stream;
    try {
      const chosen = await open(onDevice(constraints, id));
      stream.getTracks().forEach(t => t.stop());
      return chosen;
    } catch (e) { return stream; }   // the chosen mic won't open: keep what the page already has
  };
  try { Object.defineProperty(md, 'getUserMedia', { value: getUserMedia, configurable: true, writable: true }); }
  catch (e) { md.getUserMedia = getUserMedia; }
  return true;
}

if (typeof process === 'object' && process.type === 'renderer') {
  const { contextBridge, ipcRenderer } = require('electron');
  let label = '';
  try { label = String(ipcRenderer.sendSync('dash-mic-label') || ''); } catch (e) {}
  if (label) {
    try { contextBridge.executeInMainWorld({ func: installMicPreference, args: [label] }); } catch (e) {}
  }
} else if (typeof module === 'object' && module.exports) {
  module.exports = { installMicPreference };   // node:test
}
