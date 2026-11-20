'use strict';
/*
 * build-portable-launcher — make the Windows portable build unpack OUTSIDE AppData.
 *
 * electron-builder's portable target compiles node_modules/app-builder-lib/templates/nsis/portable.nsi,
 * which unpacks the app to "$TEMP\<build id>" (AppData\Local\Temp) and runs it from there. The
 * portable target accepts no custom script or include (app-builder-lib 26.15: NsisTarget reads that
 * template unconditionally), so the only way to move the folder is to patch the template before
 * electron-builder runs. `npm run dist` does that by running this file first.
 *
 * The patched launcher unpacks to "<base>\<build id>", where <base> is:
 *   1. the folder in %APPDATA%\bedrock-panel\portable-extract-dir.txt (written by app/portableExtract.js
 *      from settings.portableExtractDir), when that file exists and the folder can be created;
 *   2. otherwise %USERPROFILE%\temp.
 * It never falls back to $TEMP: if neither folder can be created it says so and exits.
 *
 * Unlike the best-effort helper builds, this one is FATAL when the template no longer matches: shipping
 * a portable exe that silently unpacks into AppData again is worse than a failed build.
 */
const fs = require('fs');
const path = require('path');

const MARKER = '; bedrock-panel:portable-extract-dir';
const ANCHOR = 'StrCpy $INSTDIR "$TEMP\\${UNPACK_DIR_NAME}"';
const USER_DATA_FOLDER = 'bedrock-panel';             // Electron's userData folder name (package.json "name")
const POINTER_FILE = 'portable-extract-dir.txt';      // keep in step with app/portableExtract.js

const BLOCK = [
  MARKER + ' (build-portable-launcher.js; do not edit here)',
  'StrCpy $R1 ""',
  'ClearErrors',
  'FileOpen $R2 "$APPDATA\\' + USER_DATA_FOLDER + '\\' + POINTER_FILE + '" r',
  'IfErrors bpExtractNoFile',
  'FileReadUTF16LE $R2 $R1',
  'FileClose $R2',
  'bpExtractNoFile:',
  'StrCmp $R1 "" 0 bpExtractTry',
  'StrCpy $R1 "$PROFILE\\temp"',
  'bpExtractTry:',
  'StrCpy $INSTDIR "$R1\\${UNPACK_DIR_NAME}"',
  'ClearErrors',
  'CreateDirectory "$INSTDIR"',
  'IfErrors 0 bpExtractReady',
  'StrCmp $R1 "$PROFILE\\temp" bpExtractFail',
  'StrCpy $R1 "$PROFILE\\temp"',
  'Goto bpExtractTry',
  'bpExtractFail:',
  'System::Call \'user32::MessageBoxW(p 0, w "Bedrock Panel could not create its extract folder:$\\r$\\n$INSTDIR", w "Bedrock Panel", i 0x10)\'',
  'SetErrorLevel 1',
  'Quit',
  'bpExtractReady:',
];

// Returns { text, changed }. Throws when the stock line is missing, so a template change in a new
// electron-builder release stops the build instead of shipping the stock behavior.
function patchPortableScript(source) {
  if (typeof source !== 'string') throw new Error('portable launcher template is not text');
  if (source.includes(MARKER)) return { text: source, changed: false };
  const lines = source.split('\n');
  const hits = lines.map((l, i) => (l.trim() === ANCHOR ? i : -1)).filter(i => i >= 0);
  if (hits.length !== 1) {
    throw new Error('expected exactly one "' + ANCHOR + '" line in the portable launcher template, found ' + hits.length
      + ' (electron-builder changed portable.nsi; update build-portable-launcher.js)');
  }
  const line = lines[hits[0]];
  const eol = line.endsWith('\r') ? '\r' : '';
  const indent = line.slice(0, line.length - line.trimStart().length);
  lines.splice(hits[0], 1, ...BLOCK.map(l => indent + l + eol));
  return { text: lines.join('\n'), changed: true };
}

function templatePath(projectDir) {
  return path.join(projectDir, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'portable.nsi');
}

function run(projectDir = __dirname, log = console.log) {
  const file = templatePath(projectDir);
  const result = patchPortableScript(fs.readFileSync(file, 'utf8'));
  if (result.changed) fs.writeFileSync(file, result.text);
  log('[portable-launcher] ' + (result.changed ? 'patched ' : 'already patched: ') + path.relative(projectDir, file));
  return result.changed;
}

module.exports = { MARKER, ANCHOR, BLOCK, POINTER_FILE, USER_DATA_FOLDER, patchPortableScript, templatePath, run };

if (require.main === module) {
  try { run(); } catch (e) {
    console.error('[portable-launcher] FAILED: ' + (e && e.message));
    process.exit(1);
  }
}
