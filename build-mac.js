'use strict';
/*
 * build-mac.js — run electron-builder for macOS with a STABLE signing identity when one is
 * configured, ad-hoc otherwise. [build tooling, MIT]
 *
 * Why: macOS ties every privacy grant (Input Monitoring for the touchscreen, Accessibility,
 * Microphone, …) to the app's code signature. An ad-hoc signature is new on every build, so every
 * build is a new app to macOS: grants go stale, the prompts do not come back, and the person has to
 * re-add the app by hand. Signing every build with the same certificate — a Developer ID, or until
 * then a self-signed "Bedrock Panel Dev" code-signing certificate created once in Keychain Access —
 * keeps the designated requirement identical across builds, so grants survive updates.
 *
 * Identity, first match wins:
 *   BEDROCK_MAC_IDENTITY   environment variable (the certificate's common name, or "-" for ad-hoc)
 *   .signing/mac-identity  a one-line file in the ignored .signing/ folder (per machine)
 *   "-"                    ad-hoc (what package.json's mac.identity says)
 *
 * Notarization runs when the identity is a Developer ID AND credentials are known:
 *   APPLE_KEYCHAIN_PROFILE        a `xcrun notarytool store-credentials <name>` profile (+ APPLE_KEYCHAIN)
 *   .signing/notary-profile       the same profile name as a one-line file (per machine)
 *   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or the App Store Connect API key trio
 * electron-builder then notarizes and staples the .app (mac.notarize=true on the command line), and
 * this script signs the DMG, submits it and staples it, so a downloaded disk image opens without any
 * "could not verify" step. It then refreshes latest-mac.yml and the dmg .blockmap, which electron-builder
 * wrote before the image changed. A Developer ID without credentials builds a signed but un-notarized app
 * and says so.
 *
 * Anything else electron-builder needs (targets, entitlements, hardened runtime) stays in
 * package.json; this only overrides mac.identity on the command line.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function resolveIdentity(env = process.env, root = __dirname) {
  const fromEnv = (env.BEDROCK_MAC_IDENTITY || '').trim();
  if (fromEnv) return { identity: fromEnv, source: 'BEDROCK_MAC_IDENTITY' };
  try {
    const line = fs.readFileSync(path.join(root, '.signing', 'mac-identity'), 'utf8').split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith('#'));
    if (line) return { identity: line, source: '.signing/mac-identity' };
  } catch (e) {}
  return { identity: '-', source: 'default' };
}

const isDeveloperId = identity => /^Developer ID Application:/i.test(String(identity || ''));
// electron-builder refuses the "Developer ID Application:" prefix (it picks the certificate type itself);
// the .signing file keeps the full name as the keychain shows it, this strips it for the command line.
const builderIdentity = identity => String(identity || '').replace(/^Developer ID Application:\s*/i, '');

// How notarization can authenticate on this machine: a notarytool keychain profile (env or the
// .signing file), the Apple ID trio, or the API key trio. null = no credentials.
function resolveNotary(env = process.env, root = __dirname) {
  const profile = (env.APPLE_KEYCHAIN_PROFILE || '').trim();
  if (profile) return { kind: 'profile', profile, keychain: (env.APPLE_KEYCHAIN || '').trim() || null, source: 'APPLE_KEYCHAIN_PROFILE' };
  try {
    const line = fs.readFileSync(path.join(root, '.signing', 'notary-profile'), 'utf8').split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith('#'));
    if (line) return { kind: 'profile', profile: line, keychain: null, source: '.signing/notary-profile' };
  } catch (e) {}
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) return { kind: 'apple-id', source: 'APPLE_ID' };
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) return { kind: 'api-key', source: 'APPLE_API_KEY' };
  return null;
}

// electron-builder flags beyond the identity: notarize only with a Developer ID and credentials.
function extraBuilderArgs(identity, notary) {
  return isDeveloperId(identity) && notary ? ['-c.mac.notarize=true'] : [];
}

// notarytool arguments that authenticate for a given credential source (the profile case adds the
// keychain when one was named); null when notarytool cannot be driven from this source.
function notarytoolAuth(notary) {
  if (!notary) return null;
  if (notary.kind === 'profile') return ['--keychain-profile', notary.profile, ...(notary.keychain ? ['--keychain', notary.keychain] : [])];
  if (notary.kind === 'apple-id') return ['--apple-id', process.env.APPLE_ID, '--team-id', process.env.APPLE_TEAM_ID, '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD];
  if (notary.kind === 'api-key') return ['--key', process.env.APPLE_API_KEY, '--key-id', process.env.APPLE_API_KEY_ID, '--issuer', process.env.APPLE_API_ISSUER];
  return null;
}

if (require.main === module) {
  const { identity, source } = resolveIdentity();
  const notary = resolveNotary();
  console.log('[build:mac] signing identity: ' + (identity === '-' ? 'ad-hoc (every build is a new app to macOS — see docs/building.md to fix that)' : JSON.stringify(identity)) + ' [' + source + ']');
  if (isDeveloperId(identity)) {
    console.log('[build:mac] notarization: ' + (notary ? 'on, via ' + notary.source : 'OFF — no credentials (see docs/building.md); the app will be signed but Gatekeeper still blocks downloads'));
  }
  const env = Object.assign({}, process.env);
  if (notary && notary.kind === 'profile' && !env.APPLE_KEYCHAIN_PROFILE) env.APPLE_KEYCHAIN_PROFILE = notary.profile;   // electron-builder reads it from the environment
  const bin = path.join(__dirname, 'node_modules', '.bin', 'electron-builder');
  const args = ['--mac', '-c.mac.identity=' + builderIdentity(identity), ...extraBuilderArgs(identity, notary), ...process.argv.slice(2)];
  const r = spawnSync(bin, args, { stdio: 'inherit', shell: process.platform === 'win32', env });
  if (r.status !== 0) process.exit(r.status == null ? 1 : r.status);
  // The .app inside is notarized and stapled by electron-builder; the disk image itself is not, and a
  // downloaded DMG is what Gatekeeper assesses first. Submit it too and staple the ticket into it.
  // Gatekeeper rejects an UNSIGNED disk image outright ("no usable signature"), even one with a stapled
  // ticket, so the image gets its own Developer ID signature first. The order matters: signing voids an
  // earlier staple, so it is sign, then submit, then staple.
  const auth = notarytoolAuth(notary);
  if (isDeveloperId(identity) && auth) {
    const dist = path.join(__dirname, 'dist');
    const dmgs = fs.existsSync(dist) ? fs.readdirSync(dist).filter(f => f.endsWith('.dmg')).map(f => path.join(dist, f)) : [];
    (async () => {
      for (const dmg of dmgs) {
        const sig = spawnSync('codesign', ['--force', '--sign', identity, '--timestamp', dmg], { stdio: 'inherit' });
        if (sig.status !== 0) { console.error('[build:mac] signing ' + path.basename(dmg) + ' failed'); process.exit(sig.status || 1); }
        console.log('[build:mac] notarizing ' + path.basename(dmg) + ' (Apple usually answers within a few minutes) …');
        const sub = spawnSync('xcrun', ['notarytool', 'submit', dmg, '--wait', ...auth], { stdio: 'inherit' });
        if (sub.status !== 0) { console.error('[build:mac] DMG notarization failed — the app inside is still notarized; see the notarytool output above'); process.exit(sub.status || 1); }
        const st = spawnSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
        if (st.status !== 0) { console.error('[build:mac] stapling the DMG failed'); process.exit(st.status || 1); }
        console.log('[build:mac] disk image signed, notarized and stapled: ' + path.basename(dmg));
        await refreshDmgManifest(dmg);
      }
      process.exit(0);
    })().catch(e => { console.error('[build:mac] ' + (e && e.message || e)); process.exit(1); });
  } else {
    process.exit(0);
  }
}

// electron-builder writes latest-mac.yml and the dmg's .blockmap BEFORE the image is signed and stapled
// above, so both describe bytes that no longer exist. Rebuild the blockmap from the final image with
// electron-builder's own generator and put its sha512 and size into the yml's dmg entry.
async function refreshDmgManifest(dmg) {
  const yml = path.join(path.dirname(dmg), 'latest-mac.yml');
  if (!fs.existsSync(yml)) return;
  const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js');
  const r = await buildBlockMap(dmg, 'gzip', dmg + '.blockmap');
  const text = fs.readFileSync(yml, 'utf8');
  const next = patchManifestEntry(text, path.basename(dmg), r.sha512, r.size);
  fs.writeFileSync(yml, next);
  console.log('[build:mac] latest-mac.yml and ' + path.basename(dmg) + '.blockmap updated for the stapled image (' + r.size + ' bytes)');
}

// Replace sha512 and size in the `- url: <name>` entry of an electron-builder update manifest, leaving
// every other line as written. Throws when the entry is missing or incomplete.
function patchManifestEntry(text, name, sha512, size) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => l.trim() === '- url: ' + name);
  if (start < 0) throw new Error('no "- url: ' + name + '" entry in the update manifest');
  let did = { sha512: false, size: false };
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*- /.test(l) || !/^\s/.test(l)) break;   // next entry, or back at the top level
    const m = /^(\s+)(sha512|size):/.exec(l);
    if (m) { lines[i] = m[1] + m[2] + ': ' + (m[2] === 'sha512' ? sha512 : size) + (l.endsWith('\r') ? '\r' : ''); did[m[2]] = true; }
  }
  if (!did.sha512 || !did.size) throw new Error('the "' + name + '" entry in the update manifest has no ' + (did.sha512 ? 'size' : 'sha512'));
  return lines.join('\n');
}

module.exports = { resolveIdentity, resolveNotary, extraBuilderArgs, notarytoolAuth, isDeveloperId, builderIdentity, patchManifestEntry };
