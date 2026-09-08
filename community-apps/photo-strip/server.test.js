'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const server = require('./server');

const tempRoots = [];

function tempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-panel-photo-strip-'));
  tempRoots.push(root);
  return root;
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content || Buffer.from([1, 2, 3]));
  return file;
}

test.beforeEach(() => {
  server._test.resetCache();
  server._test.setTrashFileImpl(null);
  server._test.setDeleteFileImpl(null);
});
test.after(() => {
  for (const root of tempRoots) {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('supported file filtering accepts browser-safe photo formats only', () => {
  ['photo.jpg', 'PHOTO.JPEG', 'image.png', 'still.webp', 'loop.gif'].forEach(name => assert.equal(server._test.supportedImage(name), true, name));
  ['vector.svg', 'bitmap.bmp', 'movie.mp4', 'script.js', 'photo.jpg.exe', ''].forEach(name => assert.equal(server._test.supportedImage(name), false, name));
});

test('folder list settings trim blanks and deduplicate selected folders', () => {
  const root = tempDir();
  const duplicate = process.platform === 'win32' ? root.toUpperCase() : root;
  assert.deepEqual(server._test.configuredFolders({
    folder1: `  ${root}  `,
    folder2: '',
    folder3: duplicate,
    folder4: '   ',
  }), [path.resolve(root)]);
});

test('library size defaults to 500 and stays within the hard ceiling', () => {
  assert.equal(server._test.DEFAULT_IMAGE_LIMIT, 500);
  assert.equal(server._test.imageLimit({}), 500);
  assert.equal(server._test.imageLimit({ maxPhotos: '' }), 500);
  assert.equal(server._test.imageLimit({ maxPhotos: '250.9' }), 250);
  assert.equal(server._test.imageLimit({ maxPhotos: '0' }), 1);
  assert.equal(server._test.imageLimit({ maxPhotos: '50000' }), server._test.MAX_IMAGES);
});

test('configured library size stops scanning early and participates in the cache key', async () => {
  const root = tempDir();
  ['one.jpg', 'two.jpg', 'three.jpg', 'four.jpg'].forEach(name => write(root, name));
  const one = await server.handle('library', { options: { folder1: root, maxPhotos: '1' }, query: {} });
  const three = await server.handle('library', { options: { folder1: root, maxPhotos: '3' }, query: {} });
  assert.equal(one.count, 1);
  assert.equal(one.limit, 1);
  assert.match(one.messages.join(' '), /limited to 1 photo/i);
  assert.equal(three.count, 3);
  assert.equal(three.limit, 3);
});

test('non-recursive scans ignore subfolders and unsupported files', async () => {
  const root = tempDir();
  write(root, 'one.jpg');
  write(root, 'two.PNG');
  write(root, 'notes.txt');
  write(root, path.join('nested', 'three.webp'));
  const result = await server._test.scanLibrary({ folder1: root, recursive: false });
  assert.deepEqual(result.items.map(item => item.name), ['one.jpg', 'two.PNG']);
});

test('recursive scans include supported images from subfolders only when enabled', async () => {
  const root = tempDir();
  write(root, 'top.gif');
  write(root, path.join('nested', 'inside.webp'));
  const flat = await server._test.scanLibrary({ folder1: root, recursive: false });
  const recursive = await server._test.scanLibrary({ folder1: root, recursive: true });
  assert.deepEqual(flat.items.map(item => item.name), ['top.gif']);
  assert.deepEqual(recursive.items.map(item => item.name).sort(), ['inside.webp', 'top.gif']);
});

test('missing and empty folders return honest renderer states', async () => {
  const root = tempDir();
  const empty = server._test.publicLibrary(await server._test.scanLibrary({ folder1: root }));
  assert.equal(empty.status, 'empty');
  assert.equal(empty.count, 0);
  const missing = server._test.publicLibrary(await server._test.scanLibrary({ folder1: path.join(root, 'gone') }));
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.availableFolders, 0);
  assert.match(missing.messages.join(' '), /missing or unreadable/i);
  const unconfigured = server._test.publicLibrary(await server._test.scanLibrary({}));
  assert.equal(unconfigured.status, 'unconfigured');
});

test('renderer boundary exposes opaque ids and rejects arbitrary path-shaped requests', async () => {
  const root = tempDir();
  write(root, 'safe.jpg', Buffer.from('synthetic-image'));
  const context = { options: { folder1: root }, query: {} };
  const library = await server.handle('library', context);
  assert.equal(library.ok, true);
  assert.equal(library.images.length, 1);
  assert.match(library.images[0].id, /^[a-f0-9]{24}$/);
  assert.equal('file' in library.images[0], false);
  assert.doesNotMatch(JSON.stringify(library), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

  const image = await server.handle('image', { options: context.options, query: { id: library.images[0].id } });
  assert.equal(image.ok, true);
  assert.match(image.dataUrl, /^data:image\/jpeg;base64,/);
  const traversal = await server.handle('image', { options: context.options, query: { id: '..\\outside.jpg' } });
  assert.deepEqual(traversal, { ok: false, error: 'invalid image id' });
});

test('deletion stays disabled unless the editor option is enabled', async () => {
  const root = tempDir();
  const file = write(root, 'keep.jpg');
  let trashCalls = 0;
  server._test.setTrashFileImpl(async () => { trashCalls += 1; });
  const library = await server.handle('library', { options: { folder1: root }, query: {} });
  const result = await server.handle('delete', {
    options: { folder1: root, allowDelete: false },
    body: Buffer.from(JSON.stringify({ id: library.images[0].id })),
  });
  assert.deepEqual(result, { ok: false, error: 'photo deletion is disabled' });
  assert.equal(trashCalls, 0);
  assert.equal(fs.existsSync(file), true);
});

test('enabled deletion moves only a scanned opaque-id photo through the trash adapter', async () => {
  const root = tempDir();
  const file = write(root, 'remove.jpg');
  const trashed = `${file}.trashed`;
  const options = { folder1: root, allowDelete: true };
  const library = await server.handle('library', { options, query: {} });
  server._test.setTrashFileImpl(async target => {
    assert.equal(target, fs.realpathSync(file));
    fs.renameSync(target, trashed);
  });

  const result = await server.handle('delete', {
    options,
    body: Buffer.from(JSON.stringify({ id: library.images[0].id })),
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, library.images[0].id);
  assert.equal(result.name, 'remove.jpg');
  assert.equal(result.method, 'trash');
  assert.equal('file' in result, false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(trashed), true);

  const refreshed = await server.handle('library', { options, query: {} });
  assert.equal(refreshed.count, 0);
});

test('a failed Recycle Bin operation keeps the file when direct fallback is disabled', async () => {
  const root = tempDir();
  const file = write(root, 'network.jpg');
  const options = { folder1: root, allowDelete: true, allowDirectDelete: false };
  const library = await server.handle('library', { options, query: {} });
  let directCalls = 0;
  server._test.setTrashFileImpl(async () => { throw new Error('network shares are unsupported'); });
  server._test.setDeleteFileImpl(async () => { directCalls += 1; });

  const result = await server.handle('delete', {
    options,
    body: Buffer.from(JSON.stringify({ id: library.images[0].id })),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Allow direct delete fallback/);
  assert.equal(directCalls, 0);
  assert.equal(fs.existsSync(file), true);
});

test('opted-in direct fallback deletes from a network-style share after recycling fails', async () => {
  const root = tempDir();
  const file = write(root, 'network.jpg');
  const options = { folder1: root, allowDelete: true, allowDirectDelete: true };
  const library = await server.handle('library', { options, query: {} });
  server._test.setTrashFileImpl(async () => { throw new Error('network shares are unsupported'); });

  const result = await server.handle('delete', {
    options,
    body: Buffer.from(JSON.stringify({ id: library.images[0].id })),
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'direct');
  assert.equal(result.name, 'network.jpg');
  assert.equal('file' in result, false);
  assert.equal(fs.existsSync(file), false);
});

test('direct fallback reports a share failure without claiming the photo was removed', async () => {
  const root = tempDir();
  const file = write(root, 'readonly.jpg');
  const options = { folder1: root, allowDelete: true, allowDirectDelete: true };
  const library = await server.handle('library', { options, query: {} });
  server._test.setTrashFileImpl(async () => { throw new Error('network shares are unsupported'); });
  server._test.setDeleteFileImpl(async () => { throw new Error('access denied'); });

  const result = await server.handle('delete', {
    options,
    body: Buffer.from(JSON.stringify({ id: library.images[0].id })),
  });
  assert.deepEqual(result, { ok: false, error: 'photo could not be deleted from the network share' });
  assert.equal(fs.existsSync(file), true);
});

test('delete rejects malformed bodies and path-shaped identifiers without touching the filesystem', async () => {
  const root = tempDir();
  write(root, 'safe.jpg');
  let trashCalls = 0;
  server._test.setTrashFileImpl(async () => { trashCalls += 1; });
  const options = { folder1: root, allowDelete: true };

  assert.deepEqual(await server.handle('delete', { options, body: Buffer.from('{') }), { ok: false, error: 'invalid request body' });
  assert.deepEqual(await server.handle('delete', {
    options,
    body: Buffer.from(JSON.stringify({ id: '..\\outside.jpg' })),
  }), { ok: false, error: 'invalid image id' });
  assert.equal(trashCalls, 0);
});

test('manifest keeps every picked folder out of the renderer URL', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'app.json'), 'utf8'));
  assert.equal(manifest.id, 'photo-strip');
  assert.equal(manifest.served, true);
  assert.equal(manifest.server, 'server.js');
  assert.equal(manifest.knob, true);
  assert.equal(manifest.version, '1.0.4');
  const folders = manifest.options.filter(option => /^folder[1-4]$/.test(option.key));
  assert.equal(folders.length, 4);
  folders.forEach(option => {
    assert.equal(option.type, 'folder');
    assert.equal(option.serverOnly, true);
  });
  const maxPhotos = manifest.options.find(option => option.key === 'maxPhotos');
  assert.equal(maxPhotos.type, 'select');
  assert.equal(maxPhotos.default, '500');
  assert.equal(maxPhotos.serverOnly, true);
  assert.deepEqual(maxPhotos.choices.map(choice => choice[0]), ['100', '250', '500', '1000', '2500', '10000']);
  const allowDelete = manifest.options.find(option => option.key === 'allowDelete');
  assert.equal(allowDelete.type, 'bool');
  assert.equal(allowDelete.default, false);
  const allowDirectDelete = manifest.options.find(option => option.key === 'allowDirectDelete');
  assert.equal(allowDirectDelete.type, 'bool');
  assert.equal(allowDirectDelete.default, false);
  assert.deepEqual(allowDirectDelete.showIf, { key: 'allowDelete', value: true });
  const renderer = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.doesNotMatch(renderer, /\brequire\s*\(|\bnode:fs\b|\bfs\.(?:read|readdir|stat)/);
});

test('panel uses two complete strip decks and keeps deletion behind the configured control', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  assert.equal((html.match(/class="strip-deck/g) || []).length, 2);
  assert.match(html, /id="deleteButton"[^>]*hidden/);
  assert.match(renderer, /elements\.delete\.hidden = !settings\.allowDelete/);
  assert.match(renderer, /allowDirectDelete: readBool\('allowDirectDelete', false\)/);
  assert.match(renderer, /Recovery then depends on your NAS Network Recycle Bin/);
  assert.match(renderer, /fetchJson\('\/app-api\/delete'/);
  assert.match(css, /\.controls button\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /deck-fade-in/);
  assert.match(css, /deck-slide-in-forward/);
});
