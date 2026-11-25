'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { patchManifestEntry } = require('../build-mac.js');
const { checkManifest } = require('../tools/verify-update-manifests.js');

const MAC_YML = [
  'version: 1.0.1',
  'files:',
  '  - url: bedrock-panel-arm64.zip',
  '    sha512: ZIPHASH',
  '    size: 100',
  '  - url: bedrock-panel-arm64.dmg',
  '    sha512: OLDDMG',
  '    size: 200',
  'path: bedrock-panel-arm64.zip',
  'sha512: ZIPHASH',
  "releaseDate: '2026-11-25T00:00:00.000Z'",
  '',
].join('\n');

test('patchManifestEntry rewrites only the named entry', () => {
  const out = patchManifestEntry(MAC_YML, 'bedrock-panel-arm64.dmg', 'NEWDMG', 2490);
  assert.match(out, /- url: bedrock-panel-arm64\.dmg\n    sha512: NEWDMG\n    size: 2490\n/);
  assert.match(out, /- url: bedrock-panel-arm64\.zip\n    sha512: ZIPHASH\n    size: 100\n/);
  assert.match(out, /\npath: bedrock-panel-arm64\.zip\nsha512: ZIPHASH\n/);
  assert.equal(out.split('\n').length, MAC_YML.split('\n').length);
});

test('patchManifestEntry keeps CRLF line endings', () => {
  const crlf = MAC_YML.replace(/\n/g, '\r\n');
  const out = patchManifestEntry(crlf, 'bedrock-panel-arm64.dmg', 'NEWDMG', 7);
  assert.ok(out.includes('    sha512: NEWDMG\r\n    size: 7\r\n'));
});

test('patchManifestEntry refuses a manifest without the entry', () => {
  assert.throws(() => patchManifestEntry(MAC_YML, 'other.dmg', 'X', 1), /no "- url: other\.dmg" entry/);
});

function fixture(files, ymlFor) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-manifest-'));
  const meta = {};
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
    meta[name] = { size: Buffer.byteLength(body), sha512: crypto.createHash('sha512').update(body).digest('base64') };
  }
  const yml = path.join(dir, 'latest.yml');
  fs.writeFileSync(yml, ymlFor(meta));
  return yml;
}

test('checkManifest passes a manifest that matches its files', () => {
  const yml = fixture({ 'setup.exe': 'installer bytes' }, m => [
    'version: 1.0.1', 'files:', '  - url: setup.exe', '    sha512: ' + m['setup.exe'].sha512, '    size: ' + m['setup.exe'].size,
    'path: setup.exe', 'sha512: ' + m['setup.exe'].sha512, '',
  ].join('\n'));
  assert.deepEqual(checkManifest(yml).problems, []);
});

test('checkManifest names a stale size, a stale hash and a missing file', () => {
  const yml = fixture({ 'a.dmg': 'stapled image', 'b.zip': 'zip' }, m => [
    'version: 1.0.1', 'files:',
    '  - url: a.dmg', '    sha512: stale', '    size: 1',
    '  - url: b.zip', '    sha512: ' + m['b.zip'].sha512, '    size: ' + m['b.zip'].size,
    '  - url: gone.AppImage', '    sha512: x', '    size: 1',
    'path: b.zip', 'sha512: ' + m['b.zip'].sha512, '',
  ].join('\n'));
  const p = checkManifest(yml).problems;
  assert.equal(p.length, 3);
  assert.ok(p.some(s => /^a\.dmg: size 1 in the manifest/.test(s)));
  assert.ok(p.some(s => /^a\.dmg: sha512 does not match/.test(s)));
  assert.ok(p.some(s => /^gone\.AppImage: file missing/.test(s)));
});
