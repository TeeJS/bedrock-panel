'use strict';
/*
 * linuxNowPlaying.js — what is playing on this computer, read straight from D-Bus in this process.
 *
 * MPRIS (org.mpris.MediaPlayer2) is the interface every media application on a Linux desktop already
 * publishes: Firefox, Chromium, Spotify, VLC, Elisa, mpv and the rest. KDE's and GNOME's own media
 * applets read exactly this, so whatever the desktop shows is what the panel shows.
 *
 * This talks to the session bus directly with dbus-next, the way node-dbus-next's own MPRIS example
 * and the published Node/Electron media clients do. No helper process, no python3, and less code
 * than the helper it replaced.
 *
 * The low-level Message API is used rather than proxy objects on purpose: a proxy costs an
 * Introspect round trip per player and fails outright on players whose introspection XML is broken,
 * while Properties.GetAll is one call that every MPRIS implementation answers.
 *
 * AppArmor, and why some of this runs in a child
 * ---------------------------------------------
 * On Ubuntu the app runs under an AppArmor profile that electron-builder installs so the Chromium
 * sandbox may create user namespaces. The profile permits everything -- Ubuntu's own profiles for
 * Chrome and VS Code say in a comment that they exist "only to give the application a name instead
 * of having the label unconfined" -- but that name is the problem. A snap-packaged player accepts
 * MPRIS traffic only from peers labelled `unconfined` or `plasmashell`; that rule is written into
 * snapd's mpris interface and appears verbatim in the generated profile:
 *
 *     dbus (receive) bus=session path=/org/mpris/MediaPlayer2
 *         peer=(label="{plasmashell,unconfined}"),
 *
 * Our label is the application's name, so every read of a snap player comes back
 * org.freedesktop.DBus.Error.AccessDenied. On Ubuntu that is Firefox, Chromium and Spotify -- most
 * of what anyone plays music with.
 *
 * A process cannot drop its AppArmor label except across an exec, and the app needs the profile, so
 * when the app is labelled the bus reading happens in a child that sheds the label on its way in: a
 * shell writes "exec unconfined" to /proc/self/attr/exec and then execs this same file, run by the
 * app's own Electron binary in Node mode. Same code, same snapshots, one process further out. Where
 * there is no AppArmor label -- every other distribution, and Ubuntu before the profile existed --
 * the reading stays in this process and no child is started.
 *
 * Snapshots come out in the shape nowplaying.js already reads from the Windows and macOS helpers:
 * seconds rather than MPRIS's microseconds, "Playing" / "Paused" / "Stopped", and null for a field a
 * player does not supply.
 */
const fs = require('fs');
const { spawn } = require('child_process');

const OBJECT = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const PROPS = 'org.freedesktop.DBus.Properties';
const PREFIX = 'org.mpris.MediaPlayer2.';
const BUS = { path: '/org/freedesktop/DBus', destination: 'org.freedesktop.DBus', interface: 'org.freedesktop.DBus' };

// Position simply advances; no player signals it. One second is what a progress bar needs and is the
// rate the Windows helper effectively ran at.
const TICK_MS = 1000;
const ART_MAX = 4 * 1024 * 1024;   // a cover a player wrote to disk; anything larger is not a cover
const ART_MIN_PX = 200;            // below this it is an icon, not a cover -- see artUrl

const BRIDGE_ENV = 'BEDROCK_NOWPLAYING_UNCONFINED';   // set on the child; tells this file to be the child
const BRIDGE_RESPAWN_MS = 5000;

let dbus = null;
let bus = null, timer = null, onSnapshot = null, running = false;
let bridge = null, bridgeRespawn = null, controlSeq = 0;
const controlWaiting = {};   // id -> resolve, for a control command sent to the bridge
const artData = {};    // file:// URL -> data: URL | null  (read once)

function log(message) { console.log('[nowplaying] ' + message); }

/** dbus-next, or null where it is not installed. Required lazily so Windows and macOS never load it. */
function library() {
  if (dbus === null) {
    try { dbus = require('dbus-next'); }
    catch (e) { dbus = false; log('dbus-next is not available — ' + (e && e.message)); }
  }
  return dbus || null;
}

/**
 * Where the session bus is.
 *
 * Normally the desktop says so in the environment. When it does not, the well-known socket under the
 * runtime directory is the same answer every desktop would have given -- and saying it explicitly
 * avoids dbus-next's last-resort path, which reads the machine id and an X11 property and then
 * autolaunches a *private* bus with no media players on it. A fresh empty bus is worse than no bus:
 * it would look like nothing is ever playing.
 */
function busAddress(env = process.env) {
  if (env.DBUS_SESSION_BUS_ADDRESS) return env.DBUS_SESSION_BUS_ADDRESS;
  if (!env.XDG_RUNTIME_DIR) return null;
  const socket = env.XDG_RUNTIME_DIR + '/bus';
  return fs.existsSync(socket) ? 'unix:path=' + socket : null;
}

/** Whether this machine can be asked at all: Linux, with a session bus and the library present. */
function available(platform = process.platform, env = process.env) {
  if (platform !== 'linux') return false;
  if (!busAddress(env)) return false;
  return !!library();
}

function call(options) {
  const { Message } = library();
  return bus.call(new Message(options));
}

/** Ask the bus which MPRIS players exist right now. Cheap: a local round trip to dbus-daemon. */
async function players() {
  const reply = await call(Object.assign({ member: 'ListNames' }, BUS));
  return (reply.body[0] || []).filter(n => n.startsWith(PREFIX)).sort();
}

/**
 * Unwrap what the bus hands back into ordinary JavaScript.
 *
 * Every value in an a{sv} arrives wrapped in a Variant -- including the values inside Metadata, which
 * is itself a Variant holding a dictionary of Variants -- and mpris:length arrives as a BigInt
 * because it does not fit a double. Unwrapping the whole thing once here keeps that detail out of
 * the snapshot code.
 */
function plain(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    if ('value' in value && 'signature' in value) return plain(value.value);
    const out = {};
    for (const key of Object.keys(value)) out[key] = plain(value[key]);
    return out;
  }
  return value;
}

/**
 * A player's cover, as something the page can put in an <img>.
 *
 * Players hand out an artUrl, and on Linux it is usually a file:// path to a thumbnail the player
 * wrote itself (Firefox does exactly this). The page is not served from that directory, so the file
 * is read once and turned into a data: URL; an http(s) artUrl is already usable and passes through.
 */
function artUrl(url) {
  if (!url || !url.startsWith('file://')) return url || null;
  if (url in artData) return artData[url];
  artData[url] = null;                       // claim it, so a slow read is not started twice
  const file = decodeURIComponent(url.slice('file://'.length));
  fs.stat(file, (err, st) => {
    if (err || !st.isFile() || st.size > ART_MAX) return;
    fs.readFile(file, (readErr, buf) => {
      if (readErr || tooSmall(buf)) return;   // stays null, so the online cover lookup runs instead
      artData[url] = 'data:' + artMime(file) + ';base64,' + buf.toString('base64');
    });
  });
  return null;
}
function artMime(file) {
  const ext = file.toLowerCase().slice(file.lastIndexOf('.') + 1);
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext] || 'image/png';
}
/**
 * Whether a player's artwork is too small to show.
 *
 * A browser playing from a web player publishes its own favicon-sized thumbnail -- Firefox writes a
 * 44-pixel PNG -- which would look like a smear across a 1920x480 panel. A PNG says its size in the
 * IHDR chunk that always starts the file, so it costs nothing to check, and a thumbnail rejected
 * here falls through to the Spotify and iTunes cover lookups that already back this page up. Anything
 * that is not a PNG is accepted: a player that goes to the trouble of writing a JPEG cover wrote a
 * real one.
 */
function tooSmall(buf) {
  if (!buf || buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') return false;
  return Math.max(buf.readUInt32BE(16), buf.readUInt32BE(20)) < ART_MIN_PX;
}

/**
 * Spotify's track URI, when the player is playing something from Spotify.
 *
 * Firefox's Spotify tab reports the web player's https URL in xesam:url. The art lookup in
 * nowplaying.js already knows how to turn a spotify:track: URI into a cover through Spotify's public
 * oEmbed endpoint, so converting it here gets the web player real album art instead of the browser's
 * favicon-sized thumbnail.
 */
function spotifyTrack(url) {
  const m = /^https?:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]+)/.exec(String(url || ''));
  return m ? 'spotify:track:' + m[1] : null;
}

/** One player's state, or null when it holds no track or cannot be read this instant. */
async function snapshotOf(name) {
  try {
    const reply = await call({ path: OBJECT, destination: name, interface: PROPS, member: 'GetAll', signature: 's', body: [PLAYER] });
    return snapshotFrom(name, reply.body[0] || {});
  } catch (e) { return null; }
}

/** The player properties as they come off the bus, in the shape the app reads. Null means no track. */
function snapshotFrom(name, all) {
  const meta = plain(all.Metadata) || {};
  const title = meta['xesam:title'] || '';
  if (!title) return null;
  let artists = meta['xesam:artist'] || [];
  if (typeof artists === 'string') artists = [artists];
  return {
    title: String(title),
    artist: artists.filter(Boolean).join(', ') || null,
    album: meta['xesam:album'] || null,
    status: plain(all.PlaybackStatus) || 'Stopped',
    app: name.slice(PREFIX.length),
    position: Math.round((plain(all.Position) || 0) / 1e5) / 10,
    duration: Math.round((meta['mpris:length'] || 0) / 1e5) / 10,
    art: artUrl(meta['mpris:artUrl']),
    trackId: spotifyTrack(meta['xesam:url']),
  };
}

/**
 * The player the panel should show, and whether "nothing" is a fact or a guess.
 *
 * Playing beats paused, which is the rule the desktop's own applet uses and the rule the Windows
 * helper uses: otherwise a paused browser tab outranks the music actually playing. `certain` is
 * false when players exist but none could be read — a momentary failure is not silence, and saying
 * so would clear the display of a track that is still playing.
 */
function pick(snapshots, anyPlayers) {
  if (!anyPlayers) return { snapshot: null, certain: true };
  const readable = snapshots.filter(Boolean);
  const playing = readable.find(s => s.status === 'Playing');
  const best = playing || readable[0] || null;
  return { snapshot: best, certain: !!best };
}

async function choose() {
  const names = await players();
  if (!names.length) return pick([], false);
  const snapshots = [];
  for (const name of names) {
    const snap = await snapshotOf(name);
    if (snap && snap.status === 'Playing') return pick([snap], true);   // a playing player ends the search
    snapshots.push(snap);
  }
  return pick(snapshots, true);
}

async function tick() {
  if (!running) return;
  let result;
  try { result = await choose(); } catch (e) { return; }
  if (!running || (!result.snapshot && !result.certain)) return;
  if (onSnapshot) onSnapshot(result.snapshot);
}

/** Tell the bus we want change signals, so a track change shows before the next tick. */
async function watchSignals() {
  const rules = [
    "type='signal',interface='" + PROPS + "',member='PropertiesChanged',path='" + OBJECT + "'",
    "type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0namespace='org.mpris.MediaPlayer2'",
  ];
  for (const rule of rules) {
    try { await call(Object.assign({ member: 'AddMatch', signature: 's', body: [rule] }, BUS)); } catch (e) {}
  }
  bus.on('message', msg => {
    if (msg && (msg.member === 'PropertiesChanged' || msg.member === 'NameOwnerChanged')) tick();
  });
}

function startReader(callback) {
  if (running) return true;
  const lib = library();
  try { bus = lib.sessionBus({ busAddress: busAddress() }); }
  catch (e) { log('could not reach the session bus — ' + (e && e.message)); bus = null; return false; }
  bus.on('error', e => log('session bus error — ' + (e && e.message)));
  running = true;
  onSnapshot = typeof callback === 'function' ? callback : null;
  watchSignals().catch(() => {});
  tick();
  timer = setInterval(tick, TICK_MS);
  return true;
}

function stopReader() {
  running = false;
  onSnapshot = null;
  if (timer) clearInterval(timer);
  timer = null;
  if (bus) { try { bus.disconnect(); } catch (e) {} }
  bus = null;
  for (const k in artData) delete artData[k];
}

// ---- AppArmor ----

/** This process's AppArmor label, or '' where there is no AppArmor. */
function label(read = () => fs.readFileSync('/proc/self/attr/current', 'utf8')) {
  try { return String(read()).trim(); } catch (e) { return ''; }
}

/**
 * Whether this process carries a label a snap-packaged player will refuse.
 *
 * The label reads like `bedrock-panel (unconfined)` -- a name, and the mode in brackets. The mode
 * does not matter here: snapd's rule matches the NAME against `{plasmashell,unconfined}`, so any
 * name but those two is turned away. No AppArmor at all reads as an empty label and needs nothing.
 */
function confined(current = label()) {
  const name = current.split(' ')[0];
  return !!name && name !== 'unconfined' && name !== 'plasmashell';
}

// ---- the unconfined child ----

/**
 * How to start this file as a child that has shed the AppArmor label.
 *
 * `sh` writes the transition to /proc/self/attr/exec and then execs, because the change can only be
 * made by the process that is about to exec and Node gives no hook between fork and exec. The child
 * is the app's own Electron binary in Node mode, so there is no second runtime to install and it can
 * require this file straight out of the asar. A failed write is not fatal: the exec still happens,
 * the child is simply still labelled, and it reports that rather than pretending.
 */
function bridgeCommand(execPath = process.execPath, file = __filename) {
  return { command: 'sh', args: ['-c', 'echo "exec unconfined" > /proc/self/attr/exec 2>/dev/null; exec "$0" "$@"', execPath, file] };
}

function startBridge(callback) {
  if (bridge) return true;
  onSnapshot = typeof callback === 'function' ? callback : onSnapshot;
  const { command, args } = bridgeCommand();
  let child;
  try {
    child = spawn(command, args, {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', [BRIDGE_ENV]: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    log('could not start the unconfined reader — ' + (e && e.message));
    return false;
  }
  bridge = child;
  running = true;
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onBridgeLine(line);
    }
  });
  child.stderr.on('data', d => log('reader: ' + String(d).trim().slice(0, 200)));
  child.on('error', e => log('unconfined reader failed — ' + (e && e.message)));
  child.on('close', () => {
    bridge = null;
    for (const id of Object.keys(controlWaiting)) { controlWaiting[id](false); delete controlWaiting[id]; }
    if (running && !bridgeRespawn) bridgeRespawn = setTimeout(() => { bridgeRespawn = null; if (running) startBridge(); }, BRIDGE_RESPAWN_MS);
  });
  return true;
}

function onBridgeLine(line) {
  let o;
  try { o = JSON.parse(line); } catch (e) { return; }
  if (o && typeof o.id === 'number') {
    const done = controlWaiting[o.id];
    if (done) { delete controlWaiting[o.id]; done(!!o.ok); }
    return;
  }
  if (o && 'snapshot' in o && onSnapshot) onSnapshot(o.snapshot);
}

function stopBridge() {
  running = false;
  onSnapshot = null;
  if (bridgeRespawn) { clearTimeout(bridgeRespawn); bridgeRespawn = null; }
  if (bridge) { try { bridge.kill(); } catch (e) {} bridge = null; }
  for (const id of Object.keys(controlWaiting)) { controlWaiting[id](false); delete controlWaiting[id]; }
}

function start(callback) {
  if (running) return true;
  if (!available()) return false;
  if (confined()) {
    log('reading MPRIS through an unconfined reader (this app has an AppArmor label, and snap players refuse one)');
    if (startBridge(callback)) return true;
    log('falling back to reading the bus here; snap-packaged players will not answer');
  } else {
    log('reading MPRIS on the session bus');
  }
  return startReader(callback);
}

function stop() {
  if (bridge || bridgeRespawn) stopBridge();
  stopReader();
  running = false;
}

/**
 * Press a transport button on a player. `target` is the `app` from the snapshot the panel is
 * showing, so with two players open the buttons drive the one on screen rather than whichever
 * application currently owns the media keys. Resolves false when nothing could be acted on, which
 * is the caller's cue to fall back to a media-key tap.
 */
async function control(command, target) {
  const member = { playpause: 'PlayPause', next: 'Next', prev: 'Previous' }[command];
  if (!member || !available()) return false;
  // A labelled process cannot press a snap player's buttons any more than it can read its track, so
  // the press goes out through the same unconfined child. Without one running, say so and let the
  // caller fall back to a media-key tap.
  if (bridge) return controlThroughBridge(command, target);
  if (confined()) return false;
  const own = !bus;
  const lib = library();
  if (own) { try { bus = lib.sessionBus({ busAddress: busAddress() }); } catch (e) { return false; } }
  try {
    const names = await players();
    let wanted = names.filter(n => target && n.slice(PREFIX.length) === target);
    if (!wanted.length) {
      const playing = [];
      for (const name of names) {
        const snap = await snapshotOf(name);
        if (snap && snap.status === 'Playing') playing.push(name);
      }
      wanted = playing.length ? playing : names;
    }
    for (const name of wanted) {
      try {
        await call({ path: OBJECT, destination: name, interface: PLAYER, member });
        return true;
      } catch (e) {}
    }
    return false;
  } catch (e) {
    return false;
  } finally {
    if (own && bus) { try { bus.disconnect(); } catch (e) {} bus = null; }
  }
}

/** Hand a press to the unconfined child and wait for its answer, with a ceiling on the wait. */
function controlThroughBridge(command, target) {
  return new Promise(resolve => {
    const id = ++controlSeq;
    let done = false;
    const finish = ok => { if (done) return; done = true; delete controlWaiting[id]; resolve(!!ok); };
    controlWaiting[id] = finish;
    setTimeout(() => finish(false), 4000);
    try { bridge.stdin.write(JSON.stringify({ id, control: command, target: target || '' }) + '\n'); }
    catch (e) { finish(false); }
  });
}

/**
 * This file, run as the unconfined child.
 *
 * It is the same reader, reporting over stdout instead of a callback, and taking presses on stdin.
 * It ends when its stdin closes, which is what happens when the app quits, so it can never outlive
 * the app that started it.
 */
function runAsBridge() {
  const send = o => { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch (e) {} };
  if (!startReader(snapshot => send({ snapshot }))) process.exit(3);
  let buf = '';
  process.stdin.on('data', d => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      control(o.control, o.target).then(ok => send({ id: o.id, ok }));
    }
  });
  process.stdin.on('end', () => { stopReader(); process.exit(0); });
  process.stdin.resume();
}

if (process.env[BRIDGE_ENV] === '1' && require.main === module) runAsBridge();

module.exports = { available, busAddress, label, confined, bridgeCommand, start, stop, control, artUrl, spotifyTrack, plain, tooSmall, snapshotFrom, pick, _internals: { snapshotOf, choose } };
