'use strict';
/*
 * appIcon.js — a program's own icon as a PNG data: URL, for the "App icon" tile option. [MIT]
 *
 * Electron's app.getFileIcon() is the natural call and is what Windows and Linux use. On macOS the
 * 'large' size — the only one big enough for a 64–104 px panel tile — hits a CHECK inside Chromium's
 * icon loader on macOS 26+ and takes the whole process down with SIGTRAP (issue #67; reproducible
 * with any .app on Electron 44.3.0, while 'small' and 'normal' are fine). So a Mac renders the icon
 * through the app-icon helper (native/mac/app-icon.swift: NSWorkspace + AppKit, 256 px) and only
 * ever asks Electron for 'normal' when the helper is missing or fails — a 32 px icon beats no app.
 *
 * The helper also takes a bare name, the same word `open -a` gets at launch ('outlook' ->
 * "Microsoft Outlook"), so a tile that launches by name gets its icon too; Electron's path needs a
 * real file and `which` never finds a .app bundle.
 *
 * Pure: every platform call comes in through `deps`, so the policy unit-tests without Electron.
 */
const MAC_ICON_PX = 256;                   // crisp at 104 px (the span tile) on a 2x panel
const MAX_PNG_BYTES = 4 * 1024 * 1024;     // a 256 px icon is ~50-150 KB; anything near this is wrong
const HELPER_TIMEOUT_MS = 10000;

function readHelperIcon(target, deps) {
  return new Promise(resolve => {
    try {
      deps.execFile(deps.helper, [target, String(MAC_ICON_PX)],
        { encoding: 'buffer', maxBuffer: MAX_PNG_BYTES, timeout: HELPER_TIMEOUT_MS },
        (err, stdout) => {
          if (err || !stdout || !stdout.length) return resolve(null);
          resolve('data:image/png;base64,' + Buffer.from(stdout).toString('base64'));
        });
    } catch (e) { resolve(null); }
  });
}

async function viaElectron(value, size, deps) {
  const p = await deps.resolveAppPath(value);
  if (!p) return null;
  const img = await deps.getFileIcon(p, { size });
  return (!img || img.isEmpty()) ? null : img.toDataURL();
}

/**
 * deps: { platform, helper (path or null), execFile, resolveAppPath, getFileIcon, macAppName,
 *         hasPathSeparator }. Resolves to a data: URL or null; never throws.
 */
async function getAppIconDataUrl(value, deps) {
  if (!value || typeof value !== 'string') return null;
  try {
    const platform = deps.platform || process.platform;
    if (platform !== 'darwin') return await viaElectron(value, 'large', deps);
    if (deps.helper) {
      const target = deps.hasPathSeparator(value) ? value : deps.macAppName(value);
      const d = await readHelperIcon(target, deps);
      if (d) return d;
    }
    return await viaElectron(value, 'normal', deps);   // never 'large' on a Mac — see the header
  } catch (e) { return null; }
}

module.exports = { getAppIconDataUrl, MAC_ICON_PX };
