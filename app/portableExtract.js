'use strict';
/*
 * portableExtract — where the Windows portable build unpacks itself.
 *
 * bedrock-panel-portable.exe is a self-extracting launcher: it unpacks the whole app to a folder and
 * starts Bedrock Panel.exe from there. Stock electron-builder always unpacks under %TEMP%, which is
 * inside AppData, and endpoint security commonly blocks executables that run from AppData. Our patched
 * launcher (build-portable-launcher.js) unpacks under %USERPROFILE%\temp instead, or under the folder
 * named by settings.portableExtractDir.
 *
 * The launcher runs BEFORE the app, so it cannot read config.json. The main process mirrors the
 * setting into a one-line pointer file the launcher reads on its next start:
 *
 *   <userData>\portable-extract-dir.txt   UTF-16LE, no BOM, no newline, an absolute path
 *
 * No file means "use the default". Pure Node; everything it touches is passed in.
 */
const nodeFs = require('fs');
const nodePath = require('path');

const win = nodePath.win32;
const POINTER_FILE = 'portable-extract-dir.txt';
const DEFAULT_SETTING = '%USERPROFILE%\\temp';
const MAX_LENGTH = 200;   // leaves room for the per-build subfolder and the app's own paths under MAX_PATH

function normalizeSetting(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^"(.*)"$/, '$1').trim();
}

// %NAME% -> env value, case-insensitively like Windows. An unknown variable makes the whole path invalid.
function expandEnv(text, env) {
  const names = Object.keys(env || {});
  let unknown = false;
  const out = text.replace(/%([^%]+)%/g, (_m, name) => {
    const key = names.find(k => k.toLowerCase() === name.toLowerCase());
    if (key == null || !env[key]) { unknown = true; return ''; }
    return env[key];
  });
  return unknown ? null : out;
}

function isDriveOrUncAbsolute(p) {
  return /^[A-Za-z]:\\/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
}

// The absolute folder a setting value names, or null when it is empty or unusable.
function resolveSetting(value, env) {
  const raw = normalizeSetting(value);
  if (!raw) return null;
  const expanded = expandEnv(raw.replace(/\//g, '\\'), env || {});
  if (!expanded || !isDriveOrUncAbsolute(expanded)) return null;
  if (/[<>"|?*\r\n]/.test(expanded) || expanded.slice(2).includes(':')) return null;
  const resolved = win.normalize(expanded).replace(/\\+$/, '');
  if (!isDriveOrUncAbsolute(resolved + '\\') || resolved.length > MAX_LENGTH) return null;
  return resolved;
}

function isInside(child, parent) {
  if (!child || !parent) return false;
  const c = win.normalize(child).replace(/\\+$/, '').toLowerCase();
  const p = win.normalize(parent).replace(/\\+$/, '').toLowerCase();
  return c === p || c.startsWith(p + '\\');
}

// True when the folder sits inside the user's AppData tree, the place this feature exists to avoid.
function isUnderAppData(dir, env) {
  const e = env || {};
  const roots = [e.APPDATA, e.LOCALAPPDATA, e.USERPROFILE ? win.join(e.USERPROFILE, 'AppData') : null].filter(Boolean);
  return roots.some(root => isInside(dir, root));
}

function describe(value, env) {
  const raw = normalizeSetting(value);
  const custom = resolveSetting(raw, env);
  const fallback = resolveSetting(DEFAULT_SETTING, env);
  const dir = custom || fallback;
  return {
    setting: raw,
    valid: !raw || !!custom,                 // an empty setting is valid: it means the default
    usingDefault: !custom,
    dir,
    underAppData: !!dir && isUnderAppData(dir, env),
  };
}

function pointerPath(userDataDir) { return nodePath.join(userDataDir, POINTER_FILE); }

// Mirror the setting into the pointer file. Writes only when the content changes; removes the file for
// the default. Returns what it did so the caller can log it. Never throws.
function syncPointerFile({ userDataDir, value, env, fs = nodeFs } = {}) {
  if (!userDataDir) return { ok: false, action: 'none', error: 'no user data folder' };
  const file = pointerPath(userDataDir);
  const info = describe(value, env);
  let current = null;
  try { current = fs.readFileSync(file).toString('utf16le'); } catch (e) {}
  try {
    if (info.usingDefault) {
      if (current == null) return { ok: true, action: 'none', dir: info.dir, valid: info.valid };
      fs.unlinkSync(file);
      return { ok: true, action: 'removed', dir: info.dir, valid: info.valid };
    }
    if (current === info.dir) return { ok: true, action: 'none', dir: info.dir, valid: true };
    fs.writeFileSync(file, Buffer.from(info.dir, 'utf16le'));
    return { ok: true, action: 'written', dir: info.dir, valid: true };
  } catch (e) {
    return { ok: false, action: 'none', dir: info.dir, valid: info.valid, error: String(e && e.message) };
  }
}

module.exports = {
  POINTER_FILE, DEFAULT_SETTING, MAX_LENGTH,
  normalizeSetting, resolveSetting, isUnderAppData, describe, pointerPath, syncPointerFile,
};
