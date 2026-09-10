'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveIdentity, resolveNotary, extraBuilderArgs, notarytoolAuth, isDeveloperId } = require('../build-mac');

test('the signing identity comes from the environment, else .signing/mac-identity, else ad-hoc', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-build-'));
  assert.deepEqual(resolveIdentity({}, root), { identity: '-', source: 'default' });
  fs.mkdirSync(path.join(root, '.signing'));
  fs.writeFileSync(path.join(root, '.signing', 'mac-identity'), '# the certificate created in Keychain Access\n  Bedrock Panel Dev  \n');
  assert.deepEqual(resolveIdentity({}, root), { identity: 'Bedrock Panel Dev', source: '.signing/mac-identity' });
  assert.deepEqual(resolveIdentity({ BEDROCK_MAC_IDENTITY: 'Developer ID Application: T.J. (TEAMID)' }, root), { identity: 'Developer ID Application: T.J. (TEAMID)', source: 'BEDROCK_MAC_IDENTITY' });
  assert.deepEqual(resolveIdentity({ BEDROCK_MAC_IDENTITY: '-' }, root), { identity: '-', source: 'BEDROCK_MAC_IDENTITY' }, 'an explicit "-" forces ad-hoc');
  assert.deepEqual(resolveIdentity({ BEDROCK_MAC_IDENTITY: '   ' }, root).source, '.signing/mac-identity', 'blank env falls through');
});

test('package.json routes dist:mac through the wrapper and keeps the build scripts out of the app bundle', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(pkg.scripts['dist:mac'], /node build-mac\.js/);
  for (const f of ['!build-mac.js', '!build-mac-helpers.js']) assert.ok(pkg.build.files.includes(f), f + ' must be excluded from the asar');
  assert.equal(pkg.build.mac.identity, '-', 'the default stays ad-hoc for machines without a certificate');
});

test('notarization credentials: keychain profile from the environment or .signing/notary-profile, the Apple ID trio, the API key trio, else none', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-'));
  assert.equal(resolveNotary({}, root), null);
  assert.deepEqual(resolveNotary({ APPLE_KEYCHAIN_PROFILE: 'bedrock-notary' }, root), { kind: 'profile', profile: 'bedrock-notary', keychain: null, source: 'APPLE_KEYCHAIN_PROFILE' });
  assert.equal(resolveNotary({ APPLE_KEYCHAIN_PROFILE: 'p', APPLE_KEYCHAIN: '/k.db' }, root).keychain, '/k.db');
  fs.mkdirSync(path.join(root, '.signing')); fs.writeFileSync(path.join(root, '.signing', 'notary-profile'), '# the notarytool profile\nbedrock-notary\n');
  assert.deepEqual(resolveNotary({}, root), { kind: 'profile', profile: 'bedrock-notary', keychain: null, source: '.signing/notary-profile' });
  assert.equal(resolveNotary({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }, fs.mkdtempSync(path.join(os.tmpdir(), 'bm2-'))).kind, 'apple-id');
  assert.equal(resolveNotary({ APPLE_API_KEY: 'a', APPLE_API_KEY_ID: 'b', APPLE_API_ISSUER: 'c' }, fs.mkdtempSync(path.join(os.tmpdir(), 'bm3-'))).kind, 'api-key');
});

test('notarize only with a Developer ID and credentials; notarytool auth flags follow the credential kind', () => {
  const dev = 'Developer ID Application: T.J. Schmitz (ABCDE12345)';
  assert.equal(isDeveloperId(dev), true); assert.equal(isDeveloperId('Bedrock Panel Dev'), false); assert.equal(isDeveloperId('-'), false);
  const profile = { kind: 'profile', profile: 'bedrock-notary', keychain: null };
  assert.deepEqual(extraBuilderArgs(dev, profile), ['-c.mac.notarize=true']);
  assert.deepEqual(extraBuilderArgs(dev, null), [], 'a Developer ID without credentials is signed only');
  assert.deepEqual(extraBuilderArgs('Bedrock Panel Dev', profile), [], 'a self-signed identity cannot notarize');
  assert.deepEqual(notarytoolAuth(profile), ['--keychain-profile', 'bedrock-notary']);
  assert.deepEqual(notarytoolAuth({ kind: 'profile', profile: 'p', keychain: '/k.db' }), ['--keychain-profile', 'p', '--keychain', '/k.db']);
  assert.equal(notarytoolAuth(null), null);
});
