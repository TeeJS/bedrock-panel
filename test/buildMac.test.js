'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveIdentity } = require('../build-mac');

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
