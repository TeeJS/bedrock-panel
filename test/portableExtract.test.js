'use strict';
// The Windows portable build must never unpack into AppData. Two halves are covered here without a
// real build: the setting -> pointer-file logic (app/portableExtract.js) and the patch applied to
// electron-builder's portable launcher template (build-portable-launcher.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pe = require('../app/portableExtract');
const launcher = require('../build-portable-launcher');

const ENV = {
  USERPROFILE: 'C:\\Users\\pat',
  APPDATA: 'C:\\Users\\pat\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\pat\\AppData\\Local',
  TEMP: 'C:\\Users\\pat\\AppData\\Local\\Temp',
};

test('an empty setting means the default, %USERPROFILE%\\temp, which is outside AppData', () => {
  const d = pe.describe('', ENV);
  assert.equal(d.valid, true);
  assert.equal(d.usingDefault, true);
  assert.equal(d.dir, 'C:\\Users\\pat\\temp');
  assert.equal(d.underAppData, false);
});

test('a custom folder is expanded, normalized and stripped of quotes and trailing slashes', () => {
  assert.equal(pe.resolveSetting('D:\\Apps\\bp\\', ENV), 'D:\\Apps\\bp');
  assert.equal(pe.resolveSetting('  "D:/Apps/bp"  ', ENV), 'D:\\Apps\\bp');
  assert.equal(pe.resolveSetting('%userprofile%\\tools\\..\\bp', ENV), 'C:\\Users\\pat\\bp');
  assert.equal(pe.resolveSetting('\\\\server\\share\\bp', ENV), '\\\\server\\share\\bp');
});

test('unusable values are rejected and fall back to the default', () => {
  for (const bad of ['temp', '..\\temp', 'C:temp', '%NOPE%\\temp', 'D:\\a|b', 'D:\\a:b', 'D:\\' + 'x'.repeat(300), 42, null]) {
    assert.equal(pe.resolveSetting(bad, ENV), null, String(bad));
  }
  const d = pe.describe('relative\\folder', ENV);
  assert.equal(d.valid, false);
  assert.equal(d.usingDefault, true);
  assert.equal(d.dir, 'C:\\Users\\pat\\temp');
});

test('folders inside AppData are flagged, however they are spelled', () => {
  assert.equal(pe.describe('%TEMP%', ENV).underAppData, true);
  assert.equal(pe.describe('c:\\users\\PAT\\appdata\\local\\programs', ENV).underAppData, true);
  assert.equal(pe.describe('%APPDATA%\\..\\..\\temp', ENV).underAppData, false);
  assert.equal(pe.describe('C:\\Users\\pat\\AppDataBackup', ENV).underAppData, false);
});

test('the pointer file holds the folder as UTF-16LE with no BOM or newline, and is rewritten only on change', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-portable-'));
  const file = pe.pointerPath(userDataDir);

  let r = pe.syncPointerFile({ userDataDir, value: '', env: ENV });
  assert.deepEqual([r.ok, r.action], [true, 'none']);
  assert.equal(fs.existsSync(file), false);

  r = pe.syncPointerFile({ userDataDir, value: 'D:\\Äpps\\bp', env: ENV });
  assert.deepEqual([r.ok, r.action, r.dir], [true, 'written', 'D:\\Äpps\\bp']);
  const bytes = fs.readFileSync(file);
  assert.deepEqual(bytes, Buffer.from('D:\\Äpps\\bp', 'utf16le'));
  assert.notDeepEqual([bytes[0], bytes[1]], [0xff, 0xfe]);

  r = pe.syncPointerFile({ userDataDir, value: 'D:\\Äpps\\bp\\', env: ENV });
  assert.equal(r.action, 'none');

  r = pe.syncPointerFile({ userDataDir, value: 'not absolute', env: ENV });
  assert.deepEqual([r.ok, r.action, r.valid], [true, 'removed', false]);
  assert.equal(fs.existsSync(file), false);
});

test('a pointer file that cannot be written is reported, not thrown', () => {
  const failing = {
    readFileSync() { throw new Error('ENOENT'); },
    writeFileSync() { throw new Error('EACCES: denied'); },
    unlinkSync() {},
  };
  const r = pe.syncPointerFile({ userDataDir: 'C:\\nowhere', value: 'D:\\bp', env: ENV, fs: failing });
  assert.equal(r.ok, false);
  assert.match(r.error, /EACCES/);
  assert.equal(pe.syncPointerFile({}).ok, false);
});

// The shape of electron-builder 26.15's portable.nsi around the line we replace.
const STOCK = [
  'Section',
  '  StrCpy $INSTDIR "$PLUGINSDIR\\app"',
  '  !ifdef UNPACK_DIR_NAME',
  '    StrCpy $INSTDIR "$TEMP\\${UNPACK_DIR_NAME}"',
  '  !endif',
  '',
  '  RMDir /r $INSTDIR',
  '  SetOutPath $INSTDIR',
  'SectionEnd',
  '',
].join('\n');

test('the launcher patch replaces the %TEMP% line and never leaves a path under $TEMP', () => {
  const { text, changed } = launcher.patchPortableScript(STOCK);
  assert.equal(changed, true);
  assert.equal(text.includes(launcher.ANCHOR), false);
  assert.equal(/\$TEMP\b/.test(text), false);
  assert.ok(text.includes('StrCpy $R1 "$PROFILE\\temp"'));
  assert.ok(text.includes('FileOpen $R2 "$APPDATA\\bedrock-panel\\' + pe.POINTER_FILE + '" r'));
  assert.ok(text.includes('StrCpy $INSTDIR "$R1\\${UNPACK_DIR_NAME}"'));
  // the block sits inside the !ifdef, indented like the line it replaced, with the rest untouched
  const lines = text.split('\n');
  const start = lines.indexOf('  !ifdef UNPACK_DIR_NAME');
  assert.ok(lines[start + 1].startsWith('    ' + launcher.MARKER));
  assert.equal(lines[start + 1 + launcher.BLOCK.length], '  !endif');
  assert.deepEqual(lines.slice(-5), STOCK.split('\n').slice(-5));
});

test('the launcher and the app agree on the pointer file', () => {
  assert.equal(launcher.POINTER_FILE, pe.POINTER_FILE);
  assert.equal(launcher.USER_DATA_FOLDER, require('../package.json').name);
});

test('patching twice changes nothing, and CRLF templates keep their line endings', () => {
  const once = launcher.patchPortableScript(STOCK).text;
  assert.deepEqual(launcher.patchPortableScript(once), { text: once, changed: false });
  const crlf = launcher.patchPortableScript(STOCK.replace(/\n/g, '\r\n')).text;
  assert.equal(/[^\r]\n/.test(crlf), false);
});

test('a template without the expected line fails the build instead of shipping the stock launcher', () => {
  assert.throws(() => launcher.patchPortableScript(STOCK.replace('$TEMP', '$LOCALAPPDATA')), /found 0/);
  assert.throws(() => launcher.patchPortableScript(STOCK + STOCK), /found 2/);
  assert.throws(() => launcher.patchPortableScript(null), /not text/);
});

test('npm run dist patches the launcher before electron-builder runs, and the script is not packaged', () => {
  const pkg = require('../package.json');
  const dist = pkg.scripts.dist;
  assert.ok(dist.indexOf('node build-portable-launcher.js') >= 0);
  assert.ok(dist.indexOf('node build-portable-launcher.js') < dist.indexOf('electron-builder --win'));
  assert.ok(pkg.build.files.includes('!build-portable-launcher.js'));
});
