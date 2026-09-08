'use strict';
/*
 * afterPack.js — electron-builder afterPack hook. Signs bundled native helpers that the normal Windows
 * `sign` hook never sees (it only signs electron-builder's own artifacts: the app exe, portable, NSIS,
 * uninstaller, elevate). Reuses sign.js's Azure Trusted Signing logic verbatim. Runs after the app dir
 * is packed into win-unpacked, so the *signed* helper is what gets wrapped into the portable + installer.
 */
const path = require('path');
const fs = require('fs');
const sign = require('./sign');

exports.default = async function (context) {
  // Windows only: the helpers are .exe/.node files signed with Azure Trusted Signing. A macOS build
  // is signed (ad-hoc for now) by electron-builder itself, which also covers everything under
  // <Name>.app/Contents/Resources/app.asar.unpacked — nothing for this hook to do there.
  if (context.electronPlatformName !== 'win32') { console.log('  • afterPack: ' + context.electronPlatformName + ' — no Windows helper signing'); return; }
  const dir = path.join(context.appOutDir, 'resources', 'app.asar.unpacked', 'app', 'native');
  let natives = [];
  try { natives = fs.readdirSync(dir).filter(f => /\.(?:exe|node)$/i.test(f)); } catch (e) {}
  if (!natives.length) { console.log('  • afterPack: no bundled native helper to sign'); return; }
  for (const f of natives) {
    const file = path.join(dir, f);
    console.log('  • afterPack: signing bundled helper →', file);
    await sign.default({ path: file });   // same Trusted Signing path as the main artifacts
  }
};
