'use strict';
// Renderer-only stub for window.bedrockConfig. contextIsolation is off, so this runs in the page
// context before app/config.js and installs the API the real editor expects. No IPC, no main
// process, no servers/devices — the window is the REAL config.js renderer over fake data only.
// Used by main-standalone.js to verify the shared editor's option-validation + preview behaviour.
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'community-apps', 'macro-deck-surface', 'app.json'), 'utf8'));

// Two app pages (A invalid longPressMs, B valid) + a page for a synthetic settings-scope number,
// so the harness exercises the cross-page save-gate, the .aopt and .aset number paths, and the
// separate-device preview placeholder.
const seedConfig = () => ({
  grids: [
    { id: 'g1', kind: 'app', app: 'macro-deck-surface', name: 'Macro Deck A',
      options: { host: '127.0.0.1:8191', clientId: 'Bedrock Panel', longPressMs: '50' } },
    { id: 'g2', kind: 'app', app: 'macro-deck-surface', name: 'Macro Deck B',
      options: { host: '127.0.0.1:8191', clientId: 'Bedrock Panel', longPressMs: '1000' } },
    { id: 'g3', kind: 'app', app: 'synthnum', name: 'Synth Settings', options: {} },
  ],
  groups: [], panes: [], activeGridId: 'g1',
  settings: { synthnum: { delay: '1000' } },
});
const appDef = Object.assign({}, manifest, {
  id: manifest.id, name: manifest.name, entry: manifest.entry, file: manifest.entry,
  served: !!manifest.served, options: Array.isArray(manifest.options) ? manifest.options : [],
});
const synthDef = {
  id: 'synthnum', name: 'Synth Settings', entry: 'index.html', file: 'index.html', served: false, options: [],
  settings: { key: 'synthnum', title: 'Synth Settings', options: [
    { key: 'delay', label: 'Delay (ms)', type: 'number', min: 100, max: 5000, step: 1, advanced: true, default: '1000', help: 'Test settings-scope number.' },
  ] },
};

const overrides = {
  getConfig: () => Promise.resolve(seedConfig()),
  getApps: () => Promise.resolve([appDef, synthDef]),
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
  saveConfig: (cfg) => { window.__lastSaved = cfg; return Promise.resolve({ ok: true }); },
  appPreviewUrl: () => Promise.resolve('about:blank'),   // never hit a real localhost server from the harness
  appEditorUrl: () => Promise.resolve('about:blank'),
  pathToFileURL: (p) => 'file://' + String(p),
  imageToDataUrl: () => null,
  refocusEditor: () => {},
  openExternal: () => {},
  onConfigChangedExternally: () => {},
};
// Catch-all so any un-stubbed method resolves harmlessly instead of throwing during render.
window.bedrockConfig = new Proxy(overrides, {
  get(t, k) {
    if (k in t) return t[k];
    if (typeof k === 'symbol') return undefined;
    return () => Promise.resolve(null);
  },
});
