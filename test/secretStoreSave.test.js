'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSecretStore, MARKER } = require('../app/secretStore');

// safeStorage stub. `available` toggles whether a real (non-plaintext) encryption backend exists.
function storeWith(available) {
  const safeStorage = {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => 'kwallet',   // a real backend, not the 'basic_text' fallback
    encryptString: s => Buffer.from('enc:' + s),
    decryptString: b => Buffer.from(b).toString().replace(/^enc:/, ''),
  };
  const apps = [{ id: 'demo', options: [{ key: 'apiKey', type: 'secret' }] }];
  return createSecretStore({ safeStorage, dpapi: null, loadApps: () => apps });
}

test('encryptConfigForSave encrypts secrets when a backend is available', () => {
  const store = storeWith(true);
  const cfg = { settings: { spotify: { refreshToken: 'plainsecret' } }, grids: [] };
  const { config, redactedSecrets } = store.encryptConfigForSave(cfg);
  assert.equal(redactedSecrets, 0);
  assert.ok(config.settings.spotify.refreshToken.startsWith(MARKER), 'secret is encrypted at rest');
  assert.notEqual(config.settings.spotify.refreshToken, 'plainsecret');
});

test('encryptConfigForSave redacts an unencryptable plaintext secret instead of failing the whole save', () => {
  const store = storeWith(false);   // no encryption backend (e.g. keyring-less Linux)
  const cfg = {
    settings: { spotify: { refreshToken: 'plainsecret' }, someUrl: 'http://x' },
    grids: [{ kind: 'app', app: 'demo', options: { apiKey: 'k', label: 'not-secret' } }],
  };
  const { config, redactedSecrets } = store.encryptConfigForSave(cfg);
  assert.equal(redactedSecrets, 2, 'both plaintext secrets counted');
  assert.equal(config.settings.spotify.refreshToken, '', 'secret redacted, never written in the clear');
  assert.equal(config.grids[0].options.apiKey, '', 'grid secret redacted');
  assert.equal(config.settings.someUrl, 'http://x', 'non-secret data is preserved');
  assert.equal(config.grids[0].options.label, 'not-secret', 'non-secret grid option is preserved');
});

test('encryptConfigForSave preserves already-encrypted secrets when no backend is available', () => {
  const store = storeWith(false);
  const already = MARKER + 'ZXhpc3Rpbmc=';
  const cfg = { settings: { spotify: { refreshToken: already } }, grids: [] };
  const { config, redactedSecrets } = store.encryptConfigForSave(cfg);
  assert.equal(redactedSecrets, 0, 'nothing to redact — the value is already ciphertext');
  assert.equal(config.settings.spotify.refreshToken, already, 'ciphertext preserved verbatim');
});

test('encryptConfig (strict path) still throws on an unencryptable plaintext secret', () => {
  const store = storeWith(false);
  const cfg = { settings: { spotify: { refreshToken: 'plainsecret' } }, grids: [] };
  assert.throws(() => store.encryptConfig(cfg), /unavailable|failed/i);
});
