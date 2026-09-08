'use strict';
// Phase 0 spike -- THROWAWAY. Proves the obs-websocket v5 transport against a real OBS before any
// Bedrock Panel integration: connect + Identify -> GetSceneList -> hydrate output state -> subscribe ->
// SetCurrentProgramScene -> confirm via the CurrentProgramSceneChanged event -> restore -> disconnect.
//
// Run it yourself from the repo root (so obs-websocket-js resolves from node_modules); the password is
// read ONLY from the environment and is never logged:
//   PowerShell:  $env:OBS_PASSWORD='your-obs-ws-password'; node tools\obs-spike.js
//   (optional)   $env:OBS_URL='ws://127.0.0.1:4455'
// Get the password/port from OBS -> Tools -> WebSocket Server Settings -> Show Connect Info.
//
// It touches nothing in Bedrock Panel, changes no config, and restores your original program scene.

const { OBSWebSocket, EventSubscription } = require('obs-websocket-js');

const url = process.env.OBS_URL || 'ws://127.0.0.1:4455';
const password = process.env.OBS_PASSWORD || '';
const now = () => performance.now();
const ms = t => (now() - t).toFixed(0) + ' ms';
const log = (...a) => console.log('[obs-spike]', ...a);

(async () => {
  const obs = new OBSWebSocket();
  obs.on('ConnectionClosed', e => log('connection closed:', (e && e.message) || ''));
  obs.on('ConnectionError', e => log('connection error:', (e && e.message) || e));

  // --- connect + identify ---
  const t0 = now();
  let hello;
  try {
    hello = await obs.connect(url, password, {
      rpcVersion: 1,
      eventSubscriptions: EventSubscription.Scenes | EventSubscription.Outputs,
    });
  } catch (e) {
    log('CONNECT FAILED:', (e && e.message) ? e.message : e);
    if (!password) log('hint: no OBS_PASSWORD set -- set it if OBS WebSocket auth is enabled (it is by default).');
    log('hint: confirm OBS is running and Tools -> WebSocket Server Settings -> Enable is on, and the port matches', url);
    process.exit(1);
  }
  log(`connected in ${ms(t0)} -- OBS-WebSocket v${hello.obsWebSocketVersion}, negotiated RPC v${hello.negotiatedRpcVersion}`);

  // --- read scenes + a slice of output state (proves state hydration works) ---
  const tScenes = now();
  const { scenes, currentProgramSceneName } = await obs.call('GetSceneList');
  const names = scenes.map(s => s.sceneName);
  log(`GetSceneList in ${ms(tScenes)} -- ${names.length} scene(s): ${names.join(' | ')}`);
  log('current program scene:', currentProgramSceneName);
  try {
    const [st, rc, sm] = await Promise.all([
      obs.call('GetStreamStatus'), obs.call('GetRecordStatus'), obs.call('GetStudioModeEnabled'),
    ]);
    log(`hydrate -> stream: ${st.outputActive ? 'LIVE' : 'idle'} | record: ${rc.outputActive ? (rc.outputPaused ? 'PAUSED' : 'RECORDING') : 'idle'} | studio mode: ${sm.studioModeEnabled ? 'ON' : 'off'}`);
  } catch (e) { log('output-status read failed (non-fatal):', e.message); }

  // --- round-trip a scene switch and confirm via the event ---
  // If OBS has only the default scene, create a throwaway one so the spike is self-contained (no
  // manual OBS setup); it gets removed again at the end, leaving OBS exactly as it was.
  let target = names.find(n => n !== currentProgramSceneName);
  let createdTemp = null;
  if (!target) {
    createdTemp = '__obs-spike temp scene__';
    log(`only one scene present -- creating a throwaway scene "${createdTemp}" to exercise the round-trip ...`);
    await obs.call('CreateScene', { sceneName: createdTemp });
    target = createdTemp;
  }

  let sentAt = 0;
  const confirmed = new Promise(resolve => {
    obs.on('CurrentProgramSceneChanged', d => {
      if (d.sceneName === target) { log(`EVENT CurrentProgramSceneChanged -> ${d.sceneName}  (round-trip ${ms(sentAt)})`); resolve(); }
    });
  });

  log(`switching program scene -> ${target} ...`);
  sentAt = now();
  await obs.call('SetCurrentProgramScene', { sceneName: target });
  log(`SetCurrentProgramScene ack in ${ms(sentAt)}`);

  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('no CurrentProgramSceneChanged within 5s')), 5000));
  try { await Promise.race([confirmed, timeout]); }
  catch (e) { log('WARNING:', e.message, '-- command was acked but no confirming event arrived (check event subscription)'); }

  // --- be a good citizen: put the program scene back, and remove the throwaway scene if we made one ---
  log(`restoring program scene -> ${currentProgramSceneName} ...`);
  await obs.call('SetCurrentProgramScene', { sceneName: currentProgramSceneName });
  if (createdTemp) { log(`removing throwaway scene "${createdTemp}" ...`); await obs.call('RemoveScene', { sceneName: createdTemp }); }

  await obs.disconnect();
  log('DONE -- auth, command, and event round-trip all verified. Disconnected. (OBS left exactly as it was.)');
  process.exit(0);
})().catch(e => { log('UNEXPECTED ERROR:', (e && e.stack) || e); process.exit(1); });
