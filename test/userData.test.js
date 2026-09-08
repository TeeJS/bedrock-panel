'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateDir, applyToApp, OLD_NAME, NEW_NAME } = require('../app/userData');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bp-userdata-')); }
function seed(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}
function fakeApp(appData) {
  const paths = { appData };
  return { getPath: k => paths[k], setPath: (k, v) => { paths[k] = v; }, paths };
}

test('fresh install: nothing to migrate, new folder is used', () => {
  const root = tmp();
  const r = migrateDir(path.join(root, OLD_NAME), path.join(root, NEW_NAME), { marker: 'config.json' });
  assert.equal(r.status, 'none');
  assert.equal(r.dir, path.join(root, NEW_NAME));
});

test('old folder is renamed wholesale, contents intact', () => {
  const root = tmp();
  seed(path.join(root, OLD_NAME), { 'config.json': '{"a":1}', 'apps/x/app.json': '{}', 'Local Storage/leveldb/000.log': 'x' });
  const r = migrateDir(path.join(root, OLD_NAME), path.join(root, NEW_NAME), { marker: 'config.json' });
  assert.equal(r.status, 'moved');
  assert.equal(fs.readFileSync(path.join(root, NEW_NAME, 'config.json'), 'utf8'), '{"a":1}');
  assert.ok(fs.existsSync(path.join(root, NEW_NAME, 'apps/x/app.json')));
  assert.ok(fs.existsSync(path.join(root, NEW_NAME, 'Local Storage/leveldb/000.log')));
  assert.ok(!fs.existsSync(path.join(root, OLD_NAME)));
});

test('an empty pre-created new folder does not block the rename', () => {
  const root = tmp();
  seed(path.join(root, OLD_NAME), { 'config.json': '{}' });
  fs.mkdirSync(path.join(root, NEW_NAME));
  const r = migrateDir(path.join(root, OLD_NAME), path.join(root, NEW_NAME), { marker: 'config.json' });
  assert.equal(r.status, 'moved');
  assert.ok(fs.existsSync(path.join(root, NEW_NAME, 'config.json')));
});

test('a non-live new folder with stray content is merged, without clobbering', () => {
  const root = tmp();
  seed(path.join(root, OLD_NAME), { 'config.json': '{"old":1}', 'GPUCache/data': 'old', 'apps/y/app.json': '{}' });
  seed(path.join(root, NEW_NAME), { 'GPUCache/data': 'new' });
  const r = migrateDir(path.join(root, OLD_NAME), path.join(root, NEW_NAME), { marker: 'config.json' });
  assert.equal(r.status, 'merged');
  assert.equal(fs.readFileSync(path.join(root, NEW_NAME, 'config.json'), 'utf8'), '{"old":1}');
  assert.equal(fs.readFileSync(path.join(root, NEW_NAME, 'GPUCache/data'), 'utf8'), 'new');
  assert.ok(fs.existsSync(path.join(root, NEW_NAME, 'apps/y/app.json')));
});

test('already migrated: a live new folder leaves a leftover old folder alone', () => {
  const root = tmp();
  seed(path.join(root, OLD_NAME), { 'config.json': '{"old":1}' });
  seed(path.join(root, NEW_NAME), { 'config.json': '{"new":1}' });
  const r = migrateDir(path.join(root, OLD_NAME), path.join(root, NEW_NAME), { marker: 'config.json' });
  assert.equal(r.status, 'none');
  assert.equal(fs.readFileSync(path.join(root, NEW_NAME, 'config.json'), 'utf8'), '{"new":1}');
  assert.ok(fs.existsSync(path.join(root, OLD_NAME, 'config.json')));
});

test('a failed rename keeps the old folder authoritative for this run', () => {
  const root = tmp();
  seed(path.join(root, OLD_NAME), { 'config.json': '{}' });
  // A FILE at the new path makes renameSync throw (ENOTDIR/EEXIST) without needing a locked handle.
  fs.writeFileSync(path.join(root, NEW_NAME), 'not a dir');
  const logs = [];
  const r = migrateDir(path.join(root, OLD_NAME), path.join(root, NEW_NAME), { marker: 'config.json', log: m => logs.push(m) });
  assert.equal(r.status, 'failed');
  assert.equal(r.dir, path.join(root, OLD_NAME));
  assert.ok(fs.existsSync(path.join(root, OLD_NAME, 'config.json')));
  assert.equal(logs.length, 1);
});

test('applyToApp points userData and sessionData at the migrated folder and moves LOCALAPPDATA apps', () => {
  const root = tmp();
  const appData = path.join(root, 'Roaming'), local = path.join(root, 'Local');
  seed(path.join(appData, OLD_NAME), { 'config.json': '{}' });
  seed(path.join(local, OLD_NAME, 'apps', 'z'), { 'app.json': '{}' });
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA };
  process.env.LOCALAPPDATA = local; process.env.APPDATA = appData;
  try {
    const app = fakeApp(appData);
    const r = applyToApp(app, () => {});
    assert.equal(r.status, 'moved');
    assert.equal(app.paths.userData, path.join(appData, NEW_NAME));
    assert.equal(app.paths.sessionData, path.join(appData, NEW_NAME));
    assert.ok(fs.existsSync(path.join(local, NEW_NAME, 'apps', 'z', 'app.json')));
    assert.ok(!fs.existsSync(path.join(local, OLD_NAME)), 'empty old LOCALAPPDATA parent is pruned');
  } finally {
    process.env.LOCALAPPDATA = saved.LOCALAPPDATA; process.env.APPDATA = saved.APPDATA;
  }
});
