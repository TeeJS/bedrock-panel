'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { repoRawBase, indexUrl, zipUrl, cmpVersion, parseIndex, isAllowedRepoUrl, githubContentsCoords, githubContentsUrl } = require('../app/appRepo');

test('githubContentsCoords parses tree, blob, and raw URLs', () => {
  assert.deepEqual(githubContentsCoords('https://github.com/TeeJS/open-quake-apps-private/tree/main/community-apps'),
    { owner: 'TeeJS', repo: 'open-quake-apps-private', ref: 'main', path: 'community-apps' });
  assert.deepEqual(githubContentsCoords('https://github.com/o/r/blob/dev/a/b/'),
    { owner: 'o', repo: 'r', ref: 'dev', path: 'a/b' });
  assert.deepEqual(githubContentsCoords('https://raw.githubusercontent.com/o/r/main/apps'),
    { owner: 'o', repo: 'r', ref: 'main', path: 'apps' });
  assert.equal(githubContentsCoords('https://example.com/x'), null);
});

test('githubContentsUrl builds an authenticated Contents API URL', () => {
  const c = githubContentsCoords('https://github.com/TeeJS/open-quake-apps-private/tree/main/community-apps');
  assert.equal(githubContentsUrl(c, 'index.json'),
    'https://api.github.com/repos/TeeJS/open-quake-apps-private/contents/community-apps/index.json?ref=main');
  assert.equal(githubContentsUrl(c, 'quake-bird.zip'),
    'https://api.github.com/repos/TeeJS/open-quake-apps-private/contents/community-apps/quake-bird.zip?ref=main');
});

test('isAllowedRepoUrl accepts only github hosts', () => {
  assert.equal(isAllowedRepoUrl('https://github.com/TeeJS/bedrock-panel/tree/main/community-apps'), true);
  assert.equal(isAllowedRepoUrl('https://raw.githubusercontent.com/o/r/main/apps'), true);
  assert.equal(isAllowedRepoUrl('https://gitlab.com/o/r/-/tree/main/apps'), false);
  assert.equal(isAllowedRepoUrl('https://evil.example.com/apps'), false);
  assert.equal(isAllowedRepoUrl('https://github.com.evil.com/x'), false);
  assert.equal(isAllowedRepoUrl(''), false);
});

test('repoRawBase normalizes a github tree URL to the raw base', () => {
  assert.equal(repoRawBase('https://github.com/TeeJS/bedrock-panel/tree/main/community-apps'),
    'https://raw.githubusercontent.com/TeeJS/bedrock-panel/main/community-apps');
  assert.equal(repoRawBase('https://github.com/TeeJS/bedrock-panel/tree/main/community-apps/'),
    'https://raw.githubusercontent.com/TeeJS/bedrock-panel/main/community-apps');
  assert.equal(repoRawBase('https://github.com/o/r/blob/dev/apps'),
    'https://raw.githubusercontent.com/o/r/dev/apps');
  assert.equal(repoRawBase('https://github.com/o/r/tree/main'),
    'https://raw.githubusercontent.com/o/r/main');
});

test('repoRawBase passes through raw + custom http(s), rejects junk', () => {
  assert.equal(repoRawBase('https://raw.githubusercontent.com/o/r/main/apps/'),
    'https://raw.githubusercontent.com/o/r/main/apps');
  assert.equal(repoRawBase('https://apps.example.com/quake/'), 'https://apps.example.com/quake');
  assert.equal(repoRawBase(''), '');
  assert.equal(repoRawBase('not a url'), '');
  assert.equal(repoRawBase('ftp://x/y'), '');
});

test('indexUrl and zipUrl resolve against the base', () => {
  const base = 'https://github.com/TeeJS/bedrock-panel/tree/main/community-apps';
  assert.equal(indexUrl(base), 'https://raw.githubusercontent.com/TeeJS/bedrock-panel/main/community-apps/index.json');
  assert.equal(zipUrl(base, { zip: 'quake-bird.zip' }),
    'https://raw.githubusercontent.com/TeeJS/bedrock-panel/main/community-apps/quake-bird.zip');
  assert.equal(zipUrl(base, { zip: 'https://cdn.example.com/x.zip' }), 'https://cdn.example.com/x.zip');
  assert.equal(zipUrl(base, {}), '');
});

test('cmpVersion orders dotted numeric versions', () => {
  assert.equal(cmpVersion('1.0.0', '1.0.0'), 0);
  assert.equal(cmpVersion('1.0', '1.0.0'), 0);
  assert.equal(cmpVersion('1.2.0', '1.10.0'), -1);
  assert.equal(cmpVersion('2.0.0', '1.9.9'), 1);
  assert.equal(cmpVersion('1.0.1', '1.0'), 1);
  assert.equal(cmpVersion('', '0.0.0'), 0);
  assert.equal(cmpVersion('1.0.0', undefined), 1);
});

test('parseIndex accepts {apps:[]} or a bare array and drops invalid entries', () => {
  const j = { apps: [
    { id: 'a', name: 'A', description: 'd', version: '1.2.3', zip: 'a.zip', server: true },
    { id: 'b' },                    // fills defaults
    { name: 'no id' },              // dropped
    null,                           // dropped
  ] };
  const out = parseIndex(j);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: 'a', name: 'A', description: 'd', version: '1.2.3', zip: 'a.zip', server: true });
  assert.deepEqual(out[1], { id: 'b', name: 'b', description: '', version: '0.0.0', zip: 'b.zip', server: false });
  assert.equal(parseIndex([{ id: 'c' }]).length, 1);   // bare array
  assert.equal(parseIndex(null).length, 0);
});
