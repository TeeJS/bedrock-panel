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

if (require.main === module) {
  const { identity, source } = resolveIdentity();
  console.log('[build:mac] signing identity: ' + (identity === '-' ? 'ad-hoc (every build is a new app to macOS — see docs/building.md to fix that)' : JSON.stringify(identity)) + ' [' + source + ']');
  const bin = path.join(__dirname, 'node_modules', '.bin', 'electron-builder');
  const args = ['--mac', '-c.mac.identity=' + identity, ...process.argv.slice(2)];
  const r = spawnSync(bin, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(r.status == null ? 1 : r.status);
}

module.exports = { resolveIdentity };
