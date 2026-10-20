'use strict';
// Renderer-only stub for window.bedrockConfig, for the persona editor harness. contextIsolation is
// off, so this runs in the page context before app/config.js. The persona methods mirror the real
// IPC handlers in app/main.js (validatePersona / personaJson / exportPersonaFile) over the REAL
// app/face/persona.js, but ASYNC like ipcRenderer.invoke, so a handler that forgets to await shows
// up here the way it would in the app. No main process, servers or devices.
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
const personaLib = require(path.join(REPO, 'app', 'face', 'persona.js'));

const later = fn => new Promise(res => setTimeout(() => res(fn()), 15));   // a real IPC hop is async
window.__exportFileCalls = [];

const seedConfig = () => {
  const c = {
    grids: [{ id: 'g1', kind: 'app', app: 'ai-voice', name: 'AI Voice', options: {} }],
    groups: [], panes: [], activeGridId: 'g1', settings: {},
  };
  personaLib.ensurePersonas(c);
  return c;
};

const overrides = {
  getConfig: () => Promise.resolve(seedConfig()),
  getApps: () => Promise.resolve([]),
  getAppVersion: () => Promise.resolve('test'),
  getHaCache: () => Promise.resolve({}),
  getStarterPages: () => Promise.resolve([]),
  listDropInApps: () => Promise.resolve([]),
  getDropInInfo: () => Promise.resolve(null),
  getLighting: () => Promise.resolve({}),
  getMonitorState: () => Promise.resolve(null),
  getVoiceModes: () => Promise.resolve({}),
  listRunningApps: () => Promise.resolve([]),
  getEmojiIndex: () => Promise.resolve([]),
  getSystemVolume: () => Promise.resolve(null),
  saveConfig: (cfg) => { window.__lastSaved = JSON.parse(JSON.stringify(cfg)); return Promise.resolve({ ok: true }); },
  pathToFileURL: (p) => 'file://' + String(p),
  imageToDataUrl: () => null,
  refocusEditor: () => {},
  openExternal: () => {},
  onConfigChangedExternally: () => {},
  // Phase 2: the TTS voice list (mode set by the harness) and a URL fetch over fixtures, both async.
  // The fetch stub applies the same size cap and validation as app/main.js importPersonaUrl.
  listTtsVoices: () => later(() => window.__voicesMode === 'fail'
    ? { ok: false, voices: [], error: 'connect ECONNREFUSED 127.0.0.1:10200' }
    : { ok: true, host: '127.0.0.1:10200', voices: [
      { name: 'en_US-lessac-medium', languages: ['en_US'], description: 'Lessac', installed: true },
      { name: 'en_US-ryan-high', languages: ['en_US'], installed: true },
    ] }),
  importPersonaUrl: (url) => later(() => {
    const fx = (window.__urlFixtures || {})[url];
    if (fx === undefined) return { ok: false, persona: null, error: 'HTTP 404 from that URL' };
    if (typeof fx === 'object') return { ok: false, persona: null, error: fx.error };
    if (Buffer.byteLength(fx, 'utf8') > personaLib.MAX_PACK_BYTES) return { ok: false, persona: null, error: 'that file is larger than 64 KB, which is more than a persona can be' };
    return personaLib.importPersonaText(fx);
  }),
  // ---- the persona IPC, async, same behaviour as app/main.js ----
  validatePersona: (src) => later(() => personaLib.validatePersona(src)),
  personaJson: (p) => later(() => personaLib.exportPersonaJson(p)),
  exportPersonaFile: (p) => later(() => {
    const json = personaLib.exportPersonaJson(p);
    window.__exportFileCalls.push({ id: p && p.id, file: personaLib.personaFileName(p), bytes: json.length });
    return json ? { ok: true, path: 'C:\\harness\\' + personaLib.personaFileName(p) } : { ok: false, error: 'that persona cannot be exported' };
  }),
};
window.bedrockConfig = new Proxy(overrides, {
  get(t, k) {
    if (k in t) return t[k];
    if (typeof k === 'symbol') return undefined;
    return () => Promise.resolve(null);
  },
});
