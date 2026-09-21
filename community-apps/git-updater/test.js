'use strict';
// node --test community-apps/git-updater/test.js
// Isolated: config path is pointed at a scratch file BEFORE the server loads —
// never the live %APPDATA%\git-updater\config.json.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-dropin-'));
const cfgPath = path.join(scratch, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ portableRoot: path.join(scratch, 'apps'), repos: [] }));
process.env.GITUPDATER_CONFIG = cfgPath;

const core = require('./engine/core');
const server = require('./server');

test('vendored core: version handling', () => {
  assert.strictEqual(core.normTag('v1.2.3'), '1.2.3');
  assert.strictEqual(core.normTag('Audacity-3.7.8'), '3.7.8');
  assert.ok(core.cmpVersion('1.2.1', '1.2') > 0);
  assert.strictEqual(core.cmpVersion('1.2.0', '1.2'), 0);
  assert.ok(core.cmpVersion('1.0.0-beta.1', '1.0.0') < 0);
});

test('vendored core: windows asset auto-pick', () => {
  const assets = [
    { name: 'tool-1.0-linux-x64.tar.gz' },
    { name: 'tool-1.0-win-x64.zip' },
    { name: 'tool-1.0-setup.exe' },
  ];
  assert.strictEqual(core.pickWindowsAsset(assets, 'portable').name, 'tool-1.0-win-x64.zip');
  assert.strictEqual(core.pickWindowsAsset(assets, 'installer').name, 'tool-1.0-setup.exe');
});

test('list: empty tracked list from scratch config', async () => {
  const r = await server.handle('list', { query: {} });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.apps, []);
  assert.strictEqual(r.running, false);
});

test('unknown action -> ok:false', async () => {
  const r = await server.handle('nonsense', { query: {} });
  assert.strictEqual(r.ok, false);
});

test('openRelease rejects a malformed key', async () => {
  const r = await server.handle('openRelease', { query: { key: 'not-a-key' } });
  assert.strictEqual(r.ok, false);
});

test('add: rejects missing fields', async () => {
  const r = await server.handle('add', { query: {}, body: Buffer.from('{}') });
  assert.strictEqual(r.ok, false);
});

test('remove: unknown key -> ok:false', async () => {
  const r = await server.handle('remove', { query: {}, body: Buffer.from(JSON.stringify({ key: 'nope/nope#installer' })) });
  assert.strictEqual(r.ok, false);
});

test('edit: unknown key -> ok:false', async () => {
  const r = await server.handle('edit', { query: {}, body: Buffer.from(JSON.stringify({ key: 'nope/nope#installer', owner: 'a', repo: 'b', type: 'installer' })) });
  assert.strictEqual(r.ok, false);
});

test('closeApp: unknown key -> ok:false', async () => {
  const r = await server.handle('closeApp', { query: {}, body: Buffer.from(JSON.stringify({ key: 'nope/nope#installer' })) });
  assert.strictEqual(r.ok, false);
});

test('setRoot writes the scratch config', async () => {
  const r = await server.handle('setRoot', { query: {}, body: Buffer.from(JSON.stringify({ path: 'X:\\portable' })) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).portableRoot, 'X:\\portable');
});

test('manifest: declares the host folder picker the Settings Browse button uses', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'app.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.hostCapabilities) && manifest.hostCapabilities.includes('pick-folder'));
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
