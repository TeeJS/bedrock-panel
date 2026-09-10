'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecretStore, MARKER2 } = require('../app/secretStore');
const { TokenStorage } = require('../src/auth/token-storage');

const root = path.join(__dirname, '..');
const dpapi = process.platform === 'win32' ? require('../app/dpapi') : null;
const windowsTest = process.platform === 'win32' ? test : test.skip;
const canary = 'OQ_SYNTHETIC_CANARY_9f2b7c';

function storeFor(backend, logs) {
  return createSecretStore({
    safeStorage: null,
    dpapi: backend,
    loadApps: () => [],
    log: message => logs && logs.push(message),
  });
}

function tokenConfig(accessToken, refreshToken) {
  return {
    grids: [],
    settings: { oauth: { providers: {}, tokens: { 'app:office': { accessToken, refreshToken } } } },
  };
}

windowsTest('native DPAPI round trip handles ASCII and Unicode synthetic values', () => {
  assert.equal(dpapi.available(), true);
  for (const value of [canary, 'synthetic 秘密 🔐 café']) {
    const blob = dpapi.protectOne(value);
    assert.match(blob, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(dpapi.unprotectOne(blob), value);
  }
});

windowsTest('native DPAPI ciphertext survives a fresh process restart', () => {
  const encrypt = "const d=require('./app/dpapi');process.stdout.write(d.protectOne(process.argv[1])||'')";
  const decrypt = "const d=require('./app/dpapi');process.stdout.write(d.unprotectOne(process.argv[1])||'')";
  const first = childProcess.spawnSync(process.execPath, ['-e', encrypt, canary], { cwd: root, encoding: 'utf8' });
  assert.equal(first.status, 0);
  assert.notEqual(first.stdout, '');
  assert.doesNotMatch(first.stdout, new RegExp(canary));
  const second = childProcess.spawnSync(process.execPath, ['-e', decrypt, first.stdout], { cwd: root, encoding: 'utf8' });
  assert.equal(second.status, 0);
  assert.equal(second.stdout, canary);
  assert.doesNotMatch(first.stderr + second.stderr, new RegExp(canary));
});

windowsTest('existing oqenc:v2 raw DPAPI blobs decrypt without migration', () => {
  const existing = MARKER2 + dpapi.protectOne(canary);
  const store = storeFor(dpapi);
  assert.equal(store.decryptValue(existing), canary);
  assert.equal(store.needsRewrite({ grids: [], settings: { haAuth: { token: existing } } }), false);
});

windowsTest('settings.owui.apiKey round-trips through the settings walker (url/model stay plaintext)', () => {
  const store = storeFor(dpapi);
  const cfg = { grids: [], settings: { owui: { url: 'http://h:3000', apiKey: canary, model: 'llama3' } } };
  assert.equal(store.hasPlaintextSecret(cfg), true);
  const enc = store.encryptConfig(cfg);
  assert.ok(enc.settings.owui.apiKey.startsWith(MARKER2));
  assert.equal(enc.settings.owui.url, 'http://h:3000');     // not a secret — stays readable
  assert.equal(enc.settings.owui.model, 'llama3');          // not a secret — stays readable
  assert.equal(store.hasPlaintextSecret(enc), false);
  assert.equal(store.decryptConfig(enc).settings.owui.apiKey, canary);
});

windowsTest('malformed and corrupted ciphertext fail generically without logging secrets', () => {
  const logs = [];
  const store = storeFor(dpapi, logs);
  assert.equal(dpapi.unprotectOne('not base64!'), null);
  const blob = Buffer.from(dpapi.protectOne(canary), 'base64');
  blob[Math.floor(blob.length / 2)] ^= 0xff;
  assert.equal(dpapi.unprotectOne(blob.toString('base64')), null);
  const stored = MARKER2 + blob.toString('base64');
  assert.equal(store.decryptValue(stored), stored);
  assert.doesNotMatch(logs.join('\n'), new RegExp(canary));
});

test('encryption backend failure never downgrades a changed secret to plaintext', () => {
  const failing = { available: () => true, protectOne: () => null, unprotectOne: () => null };
  const store = storeFor(failing);
  assert.throws(() => store.encryptValue(canary), /Secret encryption failed/);
  assert.throws(() => store.encryptConfig(tokenConfig(canary, canary + '-refresh')), /Secret encryption failed/);
});

test('OAuth token mutations roll back when secure persistence fails', () => {
  let config = tokenConfig('old-access', 'old-refresh');
  const storage = new TokenStorage({ getConfig: () => config, saveConfig: () => false });
  assert.throws(() => storage.setTokens('app:office', { accessToken: canary, refreshToken: canary + '-refresh' }), /stored securely/);
  assert.equal(config.settings.oauth.tokens['app:office'].accessToken, 'old-access');
  assert.equal(config.settings.oauth.tokens['app:office'].refreshToken, 'old-refresh');
  assert.throws(() => storage.deleteTokens('app:office'), /deletion could not be stored/);
  assert.equal(config.settings.oauth.tokens['app:office'].refreshToken, 'old-refresh');
});

windowsTest('OAuth save, restart restore, refresh rotation, and logout stay encrypted at rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock Panel-dpapi-'));
  const file = path.join(dir, 'config.json');
  const store = storeFor(dpapi);
  let config = tokenConfig(canary + '-access', canary + '-refresh');
  const saveConfig = () => {
    fs.writeFileSync(file, JSON.stringify(store.encryptConfig(config)));
    return true;
  };
  const storage = new TokenStorage({ getConfig: () => config, saveConfig });
  try {
    assert.equal(saveConfig(), true);
    let persisted = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(persisted, new RegExp(canary));

    config = store.decryptConfig(JSON.parse(persisted));
    assert.equal(storage.getTokens('app:office').refreshToken, canary + '-refresh');

    storage.setTokens('app:office', { accessToken: canary + '-rotated-access', refreshToken: canary + '-rotated-refresh' });
    persisted = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(persisted, new RegExp(canary));
    config = store.decryptConfig(JSON.parse(persisted));
    assert.equal(storage.getTokens('app:office').refreshToken, canary + '-rotated-refresh');

    storage.deleteTokens('app:office');
    config = store.decryptConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.equal(storage.getTokens('app:office'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DPAPI implementation has no shell or PowerShell process brokerage', () => {
  const source = fs.readFileSync(path.join(root, 'app', 'dpapi.js'), 'utf8');
  const nativeSource = fs.readFileSync(path.join(root, 'native', 'dpapi', 'dpapi.cc'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]child_process|spawnSync\s*\(|execFile\s*\(|powershell\.exe/i);
  assert.match(nativeSource, /CRYPTPROTECT_UI_FORBIDDEN/);
  assert.doesNotMatch(nativeSource, /CRYPTPROTECT_LOCAL_MACHINE/);
  assert.match(nativeSource, /LocalFree/);
  assert.match(nativeSource, /SecureZeroMemory/);
});

// ---- Linux: refuse Chromium's plaintext safeStorage backend ----
// On Linux with no reachable keyring, Chromium falls back to "basic_text": it encrypts under a
// HARDCODED key and still reports encryption as available. Storing tokens that way is obfuscation
// wearing the costume of encryption, so the store must treat it as no backend at all.
function safeStorageStub(backend, { throws = false } = {}) {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => { if (throws) throw new Error('not implemented'); return backend; },
    encryptString: s => Buffer.from('enc:' + s),
    decryptString: b => String(b).replace(/^enc:/, ''),
  };
}
const safeStore = (backend, logs, opts) => createSecretStore({
  safeStorage: safeStorageStub(backend, opts), dpapi: null, loadApps: () => [], log: m => logs && logs.push(m),
});

test('a keyring-backed safeStorage encrypts normally', () => {
  for (const backend of ['gnome_libsecret', 'kwallet6', 'kwallet5', 'basic_text_but_not_really']) {
    const store = safeStore(backend, []);
    const out = store.encryptValue('synthetic-token');
    assert.ok(out.startsWith('oqenc:v1:'), backend + ' should encrypt');
  }
});

test('the plaintext backend is refused, loudly and once', () => {
  const logs = [];
  const store = safeStore('basic_text', logs);
  assert.throws(() => store.encryptValue('synthetic-token'), /Secret encryption is unavailable/);
  assert.throws(() => store.encryptValue('another'), /Secret encryption is unavailable/);
  assert.equal(logs.length, 1, 'warned once, not once per secret');
  assert.match(logs[0], /no keyring/);
  assert.match(logs[0], /hardcoded key/);
  assert.match(logs[0], /kwallet|gnome-keyring/, 'names what to install');
});

test('already-stored secrets still decrypt on a plaintext-backend session', () => {
  // Refusing to WRITE must never mean refusing to READ: a machine whose keyring stopped answering
  // would otherwise look like it had lost every saved token.
  const store = safeStore('basic_text', []);
  assert.equal(store.decryptValue('oqenc:v1:' + Buffer.from('enc:synthetic').toString('base64')), 'synthetic');
  assert.equal(store.decryptValue('plain-value'), 'plain-value');
});

test('an Electron without getSelectedStorageBackend is left alone', () => {
  // Windows and macOS never expose it, and older Electrons may not either. Absence must not be read
  // as a plaintext backend, or secrets would stop saving on the two platforms that already work.
  const store = createSecretStore({
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from('enc:' + s), decryptString: b => String(b) },
    dpapi: null, loadApps: () => [], log: () => {},
  });
  assert.ok(store.encryptValue('synthetic-token').startsWith('oqenc:v1:'));
  const throwing = safeStore('basic_text', [], { throws: true });
  assert.ok(throwing.encryptValue('synthetic-token').startsWith('oqenc:v1:'), 'a throwing probe is not treated as plaintext');
});
