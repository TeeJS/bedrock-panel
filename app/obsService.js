'use strict';
// Persistent OBS Studio backend service. Same bones as app/discordService.js (start/stop/configure,
// backoff reconnect, _setState, snapshot getters, injectable factory) but much thinner, because
// obs-websocket-js owns the transport, auth handshake, framing, and event subscriptions.
//
// It wraps obs-websocket-js (CommonJS-safe via that package's `require` export), maintains a
// serializable live-state SNAPSHOT (hydrated on connect, updated from OBS events), and emits:
//   'update' (snapshot, full)  -- anything changed; the served app broadcasts this over SSE
//   'state'  ({state,error})   -- connection lifecycle only (for the Auth-tab status)
// The vendor library has NO auto-reconnect, so we reconnect on ConnectionClosed with a backoff,
// exactly as discordService does.

const { EventEmitter } = require('events');

// Loaded lazily so the module still requires in a test/headless context where the dep is injected.
let OBSWebSocket = null, EventSubscription = null;
try { ({ OBSWebSocket, EventSubscription } = require('obs-websocket-js')); } catch (e) { /* injected via clientFactory in tests */ }

const DEFAULT_BACKOFF = [1000, 2000, 5000, 10000, 30000];

// OBS events we forward into snapshot updates. Kept as data so the wiring is one loop.
const FORWARDED_EVENTS = Object.freeze([
  'CurrentProgramSceneChanged', 'CurrentPreviewSceneChanged', 'SceneListChanged',
  'StudioModeStateChanged', 'StreamStateChanged', 'RecordStateChanged', 'ReplayBufferStateChanged',
  'InputMuteStateChanged', 'InputCreated', 'InputRemoved', 'InputNameChanged',
]);

// Event categories we ask OBS to send (bitmask). General/Scenes/Inputs/Transitions/Outputs cover the
// MVP; high-volume meter/active events are deliberately NOT subscribed.
function defaultSubscriptions() {
  if (!EventSubscription) return undefined;   // let the lib default when the enum isn't available (tests)
  return EventSubscription.General | EventSubscription.Scenes | EventSubscription.Inputs
    | EventSubscription.Transitions | EventSubscription.Outputs;
}

function emptySnapshot() {
  return {
    connection: 'disconnected', error: null, obsVersion: null,
    studioMode: false, programScene: null, previewScene: null, scenes: [],
    streaming: { active: false }, recording: { active: false, paused: false }, replay: { active: false },
    inputs: [],   // [{ name, muted }] -- audio inputs only
  };
}

class ObsService extends EventEmitter {
  constructor(options) {
    super();
    const opts = options || {};
    this.url = String(opts.url || 'ws://127.0.0.1:4455');
    this.password = String(opts.password || '');
    // Injectable so unit tests pass a fake OBSWebSocket (mirrors discordService.transportFactory).
    this.clientFactory = opts.clientFactory || (() => new OBSWebSocket());
    this.eventSubscriptions = opts.eventSubscriptions != null ? opts.eventSubscriptions : defaultSubscriptions();
    this.setTimer = opts.setTimer || setTimeout;
    this.clearTimer = opts.clearTimer || clearTimeout;
    this.backoff = opts.backoff || DEFAULT_BACKOFF;
    this.autoReconnect = opts.autoReconnect !== false;
    // Panic config provider (safe scene + inputs to mute); injected by main from config.settings.obs.
    this.getPanicConfig = opts.getPanicConfig || null;

    this.snapshot = emptySnapshot();
    this.client = null;
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.stopped = true;

    this._onClosed = err => this._handleDisconnect(err);
    this._onError = err => { this.snapshot.error = (err && err.message) || String(err || ''); };
    this._forwarded = [];   // { client, name, handler } for detach cleanup
  }

  // Re-dial when the host/port/password change (called from main.js on settings save).
  configure(opts) {
    const nextUrl = opts && opts.url != null ? String(opts.url) : this.url;
    const nextPw = opts && opts.password != null ? String(opts.password) : this.password;
    if (nextUrl === this.url && nextPw === this.password) return;
    const restart = !this.stopped;
    this.stop();
    this.url = nextUrl; this.password = nextPw;
    if (restart) this.start();
  }

  setAutoReconnect(value) {
    this.autoReconnect = value !== false;
    if (!this.autoReconnect && this.retryTimer) {
      this.clearTimer(this.retryTimer); this.retryTimer = null;
      if (this.snapshot.connection === 'reconnecting') this._setConnection('disconnected');
    }
  }

  start() { if (!this.stopped) return; this.stopped = false; this.retryAttempt = 0; this._connect(false); }

  stop() {
    this.stopped = true;
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this._detach(true);
    this._resetLiveState();
    this._setConnection('disconnected');
  }

  async _connect(reconnecting) {
    if (this.stopped) return;
    this._setConnection(reconnecting ? 'reconnecting' : 'connecting');
    const client = this.clientFactory();
    this.client = client;
    client.on('ConnectionClosed', this._onClosed);
    client.on('ConnectionError', this._onError);
    this._attachEventForwarding(client);
    try {
      const hello = await client.connect(this.url, this.password, { rpcVersion: 1, eventSubscriptions: this.eventSubscriptions });
      if (this.stopped || this.client !== client) return;
      this.retryAttempt = 0;
      this.snapshot.obsVersion = (hello && hello.obsWebSocketVersion) || null;
      await this._hydrate();
      if (this.stopped || this.client !== client) return;
      this._setConnection('connected');
      this._emitUpdate();
    } catch (error) {
      if (this.client !== client || this.stopped) return;
      this._detach(false);
      // OBS not launched / WebSocket server off -> connection refused; treat as a calm "not-running".
      const msg = (error && error.message) || '';
      const notRunning = /ECONNREFUSED|refused|not open|EHOSTUNREACH|ETIMEDOUT/i.test(msg) || error.code === 1006;
      this._setConnection(notRunning ? 'not-running' : 'error', error);
      this._scheduleReconnect();
    }
  }

  _handleDisconnect(error) {
    if (this.stopped || !this.client) return;   // ConnectionClosed also fires on our own disconnect()
    this._detach(false);
    this._resetLiveState();
    this._setConnection('reconnecting', error);
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.stopped || !this.autoReconnect || this.retryTimer) return;
    const delay = this.backoff[Math.min(this.retryAttempt, this.backoff.length - 1)];
    this.retryAttempt += 1;
    this.emit('reconnect-scheduled', { delay, attempt: this.retryAttempt });
    this.retryTimer = this.setTimer(() => { this.retryTimer = null; this._connect(true); }, delay);
  }

  _attachEventForwarding(client) {
    for (const name of FORWARDED_EVENTS) {
      const handler = data => this._onObsEvent(name, data);
      this._forwarded.push({ client, name, handler });
      client.on(name, handler);
    }
  }

  _detach(disconnect) {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try { client.off('ConnectionClosed', this._onClosed); client.off('ConnectionError', this._onError); } catch (e) {}
    for (const f of this._forwarded) { try { f.client.off(f.name, f.handler); } catch (e) {} }
    this._forwarded = [];
    if (disconnect) { try { client.disconnect(); } catch (e) {} }
  }

  // ---- live state ----

  async _hydrate() {
    const s = this.snapshot;
    const safe = async (fn, apply) => { try { apply(await fn()); } catch (e) { /* capability absent -> leave default */ } };
    await safe(() => this.client.call('GetStudioModeEnabled'), r => { s.studioMode = !!r.studioModeEnabled; });
    await safe(() => this.client.call('GetSceneList'), r => {
      s.scenes = (r.scenes || []).map(x => x.sceneName);
      s.programScene = r.currentProgramSceneName || null;
      s.previewScene = r.currentPreviewSceneName || null;
    });
    await safe(() => this.client.call('GetStreamStatus'), r => { s.streaming = { active: !!r.outputActive }; });
    await safe(() => this.client.call('GetRecordStatus'), r => { s.recording = { active: !!r.outputActive, paused: !!r.outputPaused }; });
    await safe(() => this.client.call('GetReplayBufferStatus'), r => { s.replay = { active: !!r.outputActive }; });
    await this._hydrateInputs();
  }

  // Audio inputs only: GetInputMute errors on non-audio inputs, so we probe and keep the ones that answer.
  async _hydrateInputs() {
    let list;
    try { list = await this.client.call('GetInputList'); } catch (e) { return; }
    const inputs = [];
    for (const it of (list.inputs || [])) {
      const name = it.inputName;
      try { const m = await this.client.call('GetInputMute', { inputName: name }); inputs.push({ name, muted: !!m.inputMuted }); }
      catch (e) { /* not an audio input */ }
    }
    this.snapshot.inputs = inputs;
  }

  _onObsEvent(name, data) {
    const s = this.snapshot;
    const d = data || {};
    switch (name) {
      case 'CurrentProgramSceneChanged': s.programScene = d.sceneName || null; break;
      case 'CurrentPreviewSceneChanged': s.previewScene = d.sceneName || null; break;
      case 'SceneListChanged': s.scenes = (d.scenes || []).map(x => x.sceneName); break;
      case 'StudioModeStateChanged': s.studioMode = !!d.studioModeEnabled; if (!s.studioMode) s.previewScene = null; break;
      case 'StreamStateChanged': s.streaming = { active: !!d.outputActive }; break;
      case 'RecordStateChanged':
        s.recording = { active: !!d.outputActive, paused: d.outputState === 'OBS_WEBSOCKET_OUTPUT_PAUSED' };
        break;
      case 'ReplayBufferStateChanged': s.replay = { active: !!d.outputActive }; break;
      case 'InputMuteStateChanged': {
        const inp = s.inputs.find(i => i.name === d.inputName);
        if (inp) inp.muted = !!d.inputMuted;
        break;
      }
      case 'InputNameChanged': {
        const inp = s.inputs.find(i => i.name === d.oldInputName);
        if (inp) inp.name = d.inputName;
        break;
      }
      case 'InputCreated': case 'InputRemoved':
        // Audio-input roster changed; re-probe lazily (fire and forget).
        if (this.client) this._hydrateInputs().then(() => this._emitUpdate()).catch(() => {});
        return;   // _hydrateInputs emits its own update
      default: return;
    }
    this._emitUpdate();
    this.emit(name, d);   // also re-emit raw, for anything that wants the event directly
  }

  _resetLiveState() {
    const err = this.snapshot.error, ver = this.snapshot.obsVersion, conn = this.snapshot.connection;
    this.snapshot = emptySnapshot();
    this.snapshot.error = err; this.snapshot.obsVersion = ver; this.snapshot.connection = conn;
  }

  _setConnection(state, error) {
    const err = error ? ((error.message || String(error))) : (state === 'connected' ? null : this.snapshot.error);
    if (this.snapshot.connection === state && this.snapshot.error === err) return;
    this.snapshot.connection = state;
    this.snapshot.error = err;
    this.emit('state', { state, error: err });
    this._emitUpdate();
  }

  _emitUpdate() { this.emit('update', this.getSnapshot()); }

  // ---- public accessors ----
  getSnapshot() { return JSON.parse(JSON.stringify(this.snapshot)); }
  getState() { return { state: this.snapshot.connection, error: this.snapshot.error, obsVersion: this.snapshot.obsVersion }; }
  isConnected() { return this.snapshot.connection === 'connected' && !!this.client; }

  // ---- commands (thin, explicit; the UI decides program vs preview based on studio mode) ----
  call(request, data) {
    if (!this.isConnected()) return Promise.reject(Object.assign(new Error('OBS is not connected'), { code: 'OBS_NOT_CONNECTED' }));
    return this.client.call(request, data);
  }
  setProgramScene(sceneName) { return this.call('SetCurrentProgramScene', { sceneName }); }
  setPreviewScene(sceneName) { return this.call('SetCurrentPreviewScene', { sceneName }); }
  triggerStudioTransition() { return this.call('TriggerStudioModeTransition'); }
  setStudioMode(enabled) { return this.call('SetStudioModeEnabled', { studioModeEnabled: !!enabled }); }
  setInputMute(inputName, muted) { return this.call('SetInputMute', { inputName, inputMuted: !!muted }); }
  toggleInputMute(inputName) { return this.call('ToggleInputMute', { inputName }); }
  setSceneItemEnabled(sceneName, sceneItemId, enabled) { return this.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: !!enabled }); }
  startStream() { return this.call('StartStream'); }
  stopStream() { return this.call('StopStream'); }
  startRecord() { return this.call('StartRecord'); }
  stopRecord() { return this.call('StopRecord'); }
  pauseRecord() { return this.call('PauseRecord'); }
  resumeRecord() { return this.call('ResumeRecord'); }
  startReplayBuffer() { return this.call('StartReplayBuffer'); }
  stopReplayBuffer() { return this.call('StopReplayBuffer'); }
  saveReplayBuffer() { return this.call('SaveReplayBuffer'); }

  // Named-action dispatch for the served switcher (POST /api/obs/action). Scene taps are Studio-aware:
  // with Studio Mode on they set Preview (Cut/Auto takes it to Program); off, they set Program directly.
  action(name, value) {
    switch (name) {
      case 'sceneTap': case 'scene': return this.snapshot.studioMode ? this.setPreviewScene(value) : this.setProgramScene(value);   // 'scene' = tile-editor alias
      case 'setProgramScene': return this.setProgramScene(value);
      case 'setPreviewScene': return this.setPreviewScene(value);
      case 'cut': return this.snapshot.previewScene ? this.setProgramScene(this.snapshot.previewScene) : Promise.resolve();
      case 'auto': case 'transition': return this.triggerStudioTransition();
      case 'studioMode': return this.setStudioMode(value === undefined ? !this.snapshot.studioMode : !!value);
      case 'toggleMute': case 'mute': return this.toggleInputMute(value);   // 'mute' = tile-editor alias
      case 'setMute': return this.setInputMute(value && value.inputName, value && value.muted);
      case 'sceneItemEnabled': return this.setSceneItemEnabled(value.sceneName, value.sceneItemId, value.enabled);
      case 'startStream': return this.startStream();
      case 'stopStream': return this.stopStream();
      case 'startRecord': return this.startRecord();
      case 'stopRecord': return this.stopRecord();
      case 'pauseRecord': return this.pauseRecord();
      case 'resumeRecord': return this.resumeRecord();
      case 'startReplay': return this.startReplayBuffer();
      case 'stopReplay': return this.stopReplayBuffer();
      case 'saveReplay': return this.saveReplayBuffer();
      case 'panic': return this.panic();
      default: return Promise.reject(Object.assign(new Error('Unknown OBS action: ' + name), { code: 'OBS_UNKNOWN_ACTION' }));
    }
  }

  // Panic (recovery): switch to the configured safe scene and mute the configured inputs, best-effort.
  // Stays usable even if a mapped scene/input is missing; reports which parts succeeded.
  async panic() {
    const cfg = (this.getPanicConfig && this.getPanicConfig()) || {};
    const muteInputs = Array.isArray(cfg.muteInputs) ? cfg.muteInputs : [];
    const results = { scene: false, muted: [] };
    if (cfg.safeScene) { try { await this.setProgramScene(cfg.safeScene); results.scene = true; } catch (e) {} }
    for (const name of muteInputs) { try { await this.setInputMute(name, true); results.muted.push(name); } catch (e) {} }
    return results;
  }
}

module.exports = { ObsService, FORWARDED_EVENTS, emptySnapshot, defaultSubscriptions };
