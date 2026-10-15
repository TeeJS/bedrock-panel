'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { foldersError } = require('../app/meetingFolders');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-meeting-roots-'));
  const folders = { unprocessed: path.join(root, 'unprocessed'), transcribed: path.join(root, 'transcribed'), processed: path.join(root, 'completed') };
  // Test directories are isolated under this known temp root; no user paths are removed.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, folders };
}

test('independent nonexistent roots are valid and validation creates nothing', t => {
  const { root, folders } = setup(t);
  assert.equal(foldersError(folders), '');
  assert.deepEqual(fs.readdirSync(root), []);
});

test('every resolved root is required, and existing file paths are refused', t => {
  const { root, folders } = setup(t);
  for (const key of Object.keys(folders)) for (const value of ['', '  ', undefined, null, 7]) {
    assert.match(foldersError({ ...folders, [key]: value }), /not configured/);
  }
  assert.match(foldersError(null), /not configured/);
  const file = path.join(root, 'not-a-folder'); fs.writeFileSync(file, 'keep');
  assert.match(foldersError({ ...folders, transcribed: file }), /not a directory/);
  assert.match(foldersError({ ...folders, transcribed: path.join(file, 'child') }), /not a directory/);
});

test('equal roots, normalized dot segments and trailing separators are rejected', t => {
  const { folders } = setup(t);
  assert.match(foldersError({ ...folders, transcribed: folders.processed + path.sep }), /same path/);
  assert.match(foldersError({ ...folders, transcribed: path.join(folders.processed, '..', 'completed') }), /same path/);
  assert.equal(foldersError(Object.fromEntries(Object.entries(folders).map(([key, p]) => [key, p + path.sep]))), '');
});

test('nesting is rejected in both directions; similarly named siblings are valid', t => {
  const { folders } = setup(t);
  assert.match(foldersError({ ...folders, transcribed: path.join(folders.processed, 'waiting') }), /Transcribed folder is inside the Completed/);
  assert.match(foldersError({ ...folders, processed: path.join(folders.transcribed, 'archive') }), /Completed folder is inside the Transcribed/);
  assert.equal(foldersError({ ...folders, transcribed: folders.processed + '-waiting' }), '');
  assert.match(foldersError({ ...folders, processed: path.parse(folders.processed).root }), /inside the Completed/);
});

test('case folding applies to Windows roots only', t => {
  const { root, folders } = setup(t);
  const sameCasePair = { ...folders, transcribed: path.join(root, 'CaseRoot'), processed: path.join(root, 'caseroot') };
  const virtualFs = { existsSync: () => true, realpathSync: p => p, statSync: () => ({ isDirectory: () => true }) };
  assert.match(foldersError(sameCasePair, { platform: 'win32', fs: virtualFs }), /same path/);
  assert.equal(foldersError(sameCasePair, { platform: 'linux', fs: virtualFs }), '');
  assert.match(foldersError({ ...sameCasePair, processed: path.join(root, 'CASEROOT', 'child') }, { platform: 'win32', fs: virtualFs }), /inside/);
});

test('unresolvable physical paths fail closed', t => {
  const { folders } = setup(t);
  assert.match(foldersError(folders, { fs: { existsSync: () => true, realpathSync: () => { throw new Error('access denied'); } } }), /Cannot resolve/);
});

test('physical aliases and missing children below junctions cannot overlap another stage', t => {
  const { root, folders } = setup(t);
  fs.mkdirSync(folders.processed);
  const alias = path.join(root, 'alias');
  try { fs.symlinkSync(folders.processed, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) { t.skip('directory link unavailable'); return; } throw e; }
  assert.match(foldersError({ ...folders, transcribed: alias }), /same path/);
  assert.match(foldersError({ ...folders, transcribed: path.join(alias, 'not-created', 'waiting') }), /Transcribed folder is inside the Completed/);
  assert.match(foldersError({ ...folders, transcribed: path.join(alias, 'not-created'), processed: path.join(folders.processed, 'not-created', 'completed') }), /Completed folder is inside the Transcribed/);
  assert.equal(fs.readdirSync(folders.processed).length, 0, 'physical validation does not create missing directories');
});
