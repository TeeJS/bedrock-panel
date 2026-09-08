'use strict';
// Publishes busy presence to Home Assistant over MQTT discovery.
//
// WHY MQTT AND NOT THE HA REST API: HA's WebSocket API has no equivalent of POST /api/states, so an
// entity published from outside HA can only be created over REST — and a REST-created state does not
// survive an HA restart, which would mean heartbeating forever to keep a phantom entity alive. MQTT
// discovery gives a real, persistent, auto-provisioned entity with no manual setup in HA at all.
//
// THE WILL IS THE POINT. The availability topic is registered as the MQTT last-will at CONNECT time,
// so if Bedrock Panel is killed, crashes, or loses power, the broker publishes 'offline' on our behalf
// and every HA automation sees the entity go unavailable. That is the exact counterpart to the
// Busylight's own 30s keepalive timeout: both ends fail safe without anyone remembering to clean up.
//
// CONSEQUENCE, and the easiest thing to get wrong here: the connection MUST be long-lived. A client
// that connects, publishes, and disconnects per state change has no will registered between changes,
// which throws away the entire failsafe. Open once, keep it, let MQTT.js reconnect.

const os = require('os');

const DISCOVERY_PREFIX = 'homeassistant';
const OBJECT_ID = 'bedrock_panel_busy';
// 0.9.0/0.9.1 shipped this feature under the old name. Its retained discovery document would leave a dead
// entity in HA, so announce() clears it. The old default base topic is mapped to the new one below.
const LEGACY_OBJECT_ID = 'open_quake_busy';
const LEGACY_BASE_TOPIC = 'open-quake';
const DEFAULT_BASE_TOPIC = 'bedrock-panel';

// A hostname is not guaranteed to be topic-safe (MQTT dislikes '+', '#', '/'), and HA object ids
// want [a-z0-9_]. Normalise once, here, so topic and unique_id can never disagree.
function safeNodeId(hostname) {
  const s = String(hostname || DEFAULT_BASE_TOPIC).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || DEFAULT_BASE_TOPIC;
}

function buildTopics(baseTopic, hostname) {
  let base = String(baseTopic || DEFAULT_BASE_TOPIC).replace(/^\/+|\/+$/g, '') || DEFAULT_BASE_TOPIC;
  if (base === LEGACY_BASE_TOPIC) base = DEFAULT_BASE_TOPIC;   // saved by a pre-rename install
  const node = safeNodeId(hostname);
  return {
    node,
    state: base + '/' + node + '/busy',
    attributes: base + '/' + node + '/attributes',
    availability: base + '/' + node + '/availability',
    discovery: DISCOVERY_PREFIX + '/binary_sensor/' + node + '_' + OBJECT_ID + '/config',
    legacyDiscovery: DISCOVERY_PREFIX + '/binary_sensor/' + node + '_' + LEGACY_OBJECT_ID + '/config',
  };
}

// The retained discovery document HA reads to create the entity. `device` groups it under one
// "Bedrock Panel" device rather than leaving a loose entity, and unique_id is what makes it editable in
// the HA UI and stable across restarts.
function buildDiscoveryConfig(topics, opts) {
  const o = opts || {};
  return {
    name: o.name || 'Busy',
    unique_id: topics.node + '_' + OBJECT_ID,
    object_id: OBJECT_ID,
    state_topic: topics.state,
    payload_on: 'ON',
    payload_off: 'OFF',
    availability_topic: topics.availability,
    payload_available: 'online',
    payload_not_available: 'offline',
    json_attributes_topic: topics.attributes,
    // 'occupancy' reads as Detected/Clear in the UI, which is the closest built-in wording for
    // "someone is on a call". Not 'sound' — that implies noise, not availability.
    device_class: 'occupancy',
    icon: 'mdi:video-account',
    device: {
      identifiers: [topics.node + '_bedrock_panel'],
      name: 'Bedrock Panel (' + topics.node + ')',
      manufacturer: 'Bedrock Panel',
      model: 'Presence',
    },
  };
}

// State -> the two payloads published on every change. Kept pure and separate from the client so the
// mapping can be tested without a broker.
function buildPayloads(state) {
  const s = state || {};
  return {
    state: s.busy ? 'ON' : 'OFF',
    attributes: {
      reason: s.reason || null,
      app: s.app || null,
      since: s.since ? new Date(s.since).toISOString() : null,
      recording: !!s.recording,
      override: s.override || 'auto',
    },
  };
}

// deps.mqtt is injected for tests; production lazily requires the real module.
function createPresenceMqtt(deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  let mqttLib = d.mqtt || null;
  let client = null;
  let topics = null;
  let discovery = null;
  let settings = null;
  let lastState = null;
  let lastError = null;
  let connected = false;

  function loadMqtt() {
    if (mqttLib) return mqttLib;
    try { mqttLib = require('mqtt'); } catch (e) { lastError = 'mqtt module unavailable: ' + e.message; }
    return mqttLib;
  }

  function publish(topic, payload, opts) {
    if (!client) return false;
    try {
      client.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload),
        Object.assign({ qos: 0, retain: true }, opts || {}));
      return true;
    } catch (e) { lastError = e.message; return false; }
  }

  // Everything that must be re-asserted after a (re)connect. A broker restart drops retained
  // messages, so re-publishing discovery and current state here is what makes the entity heal
  // itself rather than sitting unavailable until the next busy transition.
  function announce() {
    if (!client || !topics) return;
    publish(topics.discovery, discovery);
    publish(topics.legacyDiscovery, '');   // empty retained payload = HA removes the old open_quake_busy entity
    publish(topics.availability, 'online');
    // Always publish a state, even before anything has happened. An entity that is available but has
    // never received a state shows as "unknown" in HA, which no automation can sensibly branch on —
    // and "unknown" is indistinguishable from "broken" to whoever is looking at the dashboard.
    // Not-yet-busy is honestly OFF.
    const p = buildPayloads(lastState || { busy: false });
    publish(topics.state, p.state);
    publish(topics.attributes, p.attributes);
  }

  function stop() {
    if (!client) { connected = false; return; }
    const c = client;
    client = null;
    connected = false;
    try {
      // A clean quit should say offline immediately rather than waiting for the broker to notice a
      // dropped socket and fire the will.
      if (topics) c.publish(topics.availability, 'offline', { qos: 0, retain: true });
      c.end(false);
    } catch (e) {}
  }

  // One-shot connection probe for the editor's Test button. Uses a SEPARATE short-lived client so the
  // long-lived presence connection and its registered will are never disturbed. Resolves {ok, error};
  // never rejects. reconnectPeriod:0 so a bad address reports once instead of retrying forever.
  function testConnection(params) {
    const p = params || {};
    return new Promise(resolve => {
      if (!p.url) { resolve({ ok: false, error: 'broker URL required' }); return; }
      const lib = loadMqtt();
      if (!lib) { resolve({ ok: false, error: lastError || 'mqtt module unavailable' }); return; }
      let done = false;
      let c = null;
      const finish = res => {
        if (done) return;
        done = true;
        try { if (c) c.end(true); } catch (e) {}
        resolve(res);
      };
      try {
        c = lib.connect(p.url, {
          username: p.username || undefined,
          password: p.password || undefined,
          clientId: 'bedrock-panel-test-' + Math.random().toString(16).slice(2, 8),
          reconnectPeriod: 0,
          connectTimeout: 8000,
        });
      } catch (e) { finish({ ok: false, error: e.message }); return; }
      const timer = setTimeout(() => finish({ ok: false, error: 'no response (timed out)' }), 9000);
      if (timer.unref) timer.unref();
      c.on('connect', () => { clearTimeout(timer); finish({ ok: true }); });
      c.on('error', e => { clearTimeout(timer); finish({ ok: false, error: e && e.message ? e.message : String(e) }); });
    });
  }

  return {
    // Idempotent: safe to call whenever settings change. Reconnects only when the connection
    // parameters actually changed, so editing an unrelated setting does not drop the will.
    apply(next) {
      const n = next || {};
      const same = settings &&
        settings.enabled === !!n.enabled &&
        settings.url === (n.url || '') &&
        settings.username === (n.username || '') &&
        settings.password === (n.password || '') &&
        settings.baseTopic === (n.baseTopic || '');
      if (same) return;
      settings = {
        enabled: !!n.enabled, url: n.url || '', username: n.username || '',
        password: n.password || '', baseTopic: n.baseTopic || DEFAULT_BASE_TOPIC,
      };
      stop();
      if (!settings.enabled) return;
      if (!settings.url) { lastError = 'broker URL required'; return; }
      const lib = loadMqtt();
      if (!lib) return;

      topics = buildTopics(settings.baseTopic, d.hostname || os.hostname());
      discovery = buildDiscoveryConfig(topics, {});
      try {
        client = lib.connect(settings.url, {
          username: settings.username || undefined,
          password: settings.password || undefined,
          clientId: 'bedrock-panel-' + topics.node,
          reconnectPeriod: 10000,
          connectTimeout: 10000,
          // Registered at CONNECT. This is the crash failsafe — see the header.
          will: { topic: topics.availability, payload: 'offline', qos: 0, retain: true },
        });
      } catch (e) { lastError = e.message; client = null; return; }

      client.on('connect', () => { connected = true; lastError = null; log('mqtt connected'); announce(); });
      client.on('reconnect', () => { log('mqtt reconnecting'); });
      client.on('close', () => { connected = false; });
      // Without a handler MQTT.js emits an unhandled 'error' and takes the process down. A bad
      // broker address must never be able to kill the app.
      client.on('error', e => { connected = false; lastError = e && e.message ? e.message : String(e); });
    },

    publishState(state) {
      lastState = state || null;
      if (!client || !topics || !lastState) return false;
      const p = buildPayloads(lastState);
      const a = publish(topics.state, p.state);
      const b = publish(topics.attributes, p.attributes);
      return a && b;
    },

    status() {
      return {
        enabled: !!(settings && settings.enabled),
        connected,
        error: lastError,
        entity: topics ? 'binary_sensor.' + OBJECT_ID : null,
        topics,
      };
    },

    testConnection,

    stop,
  };
}

module.exports = {
  createPresenceMqtt, buildTopics, buildDiscoveryConfig, buildPayloads, safeNodeId,
  DISCOVERY_PREFIX, OBJECT_ID,
};
