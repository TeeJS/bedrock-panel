'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');

const appDir = path.join(__dirname, '..', 'community-apps', 'ai-usage');
const communityDir = path.dirname(appDir);
const server = require(path.join(appDir, 'server.js'));
const NOW = '2026-10-23T12:34:56.000Z';
const TOKEN = 'test-token-never-echo-this-value';

function response(body, status) {
  return {
    status: status == null ? 200 : status,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

function copilotItem(quantity, overrides) {
  return Object.assign({
    date: '2026-10-20',
    product: 'Copilot AI Credits',
    sku: 'AI Credit',
    unitType: 'ai-credits',
    grossQuantity: quantity,
    grossAmount: quantity / 100,
    netAmount: 0,
  }, overrides || {});
}

function options(overrides) {
  return Object.assign({
    githubUser: 'octocat',
    githubToken: TOKEN,
    copilotCreditsIncluded: '1500',
  }, overrides || {});
}

async function usage(fetchImpl, optionOverrides) {
  return server._test.copilotUsage(options(optionOverrides), { fetch: fetchImpl, now: NOW });
}

test('AI-credit usage uses the current endpoint/version and updates on consecutive refreshes', async () => {
  const quantities = [12.5, 48.75];
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return response({ usageItems: [copilotItem(quantities.shift())] });
  };

  const first = await usage(fetchImpl);
  const second = await usage(fetchImpl);

  assert.equal(first.used, 12.5);
  assert.equal(second.used, 48.75);
  assert.equal(second.source, 'ai_credit');
  assert.equal(second.unit, 'ai-credits');
  assert.equal(second.period, '2026-10');
  assert.deepEqual(second.freshness, { fetchedAt: NOW, live: true });
  assert.equal(second.included, 1500);
  assert.match(requests[0].url, /\/users\/octocat\/settings\/billing\/ai_credit\/usage\?year=2026&month=10$/);
  assert.equal(requests[0].init.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer ' + TOKEN);
});

test('AI-credit rows are filtered to the requested month and aggregated without unrelated products', async () => {
  const result = await usage(async () => response({ usageItems: [
    copilotItem(10),
    copilotItem(2.5, { model: 'GPT-5' }),
    copilotItem(99, { date: '2026-09-30' }),
    copilotItem(500, { product: 'GitHub Models', sku: 'AI Credit' }),
  ] }));

  assert.equal(result.used, 12.5);
  assert.equal(result.gross, 0.125);
  assert.equal(result.net, 0);
});

test('legacy premium-request and general usage endpoints remain ordered fallbacks', async () => {
  const premiumUrls = [];
  const premium = await usage(async url => {
    premiumUrls.push(url);
    if (url.includes('/ai_credit/')) return response({ message: 'not found' }, 404);
    return response({ usageItems: [{ product: 'Copilot', sku: 'Copilot Premium Request', grossQuantity: 23, unitType: 'requests' }] });
  });
  assert.equal(premium.source, 'premium_request');
  assert.equal(premium.unit, 'requests');
  assert.equal(premium.used, 23);
  assert.equal(premium.included, 0);
  assert.equal(premiumUrls.length, 2);

  const generalUrls = [];
  const general = await usage(async url => {
    generalUrls.push(url);
    if (!url.includes('/settings/billing/usage?')) return response({ message: 'not found' }, 404);
    return response({ usageItems: [{ date: '2026-10-02', product: 'Copilot', sku: 'Copilot usage', quantity: 7, unitType: 'credits' }] });
  });
  assert.equal(general.source, 'usage');
  assert.equal(general.used, 7);
  assert.equal(generalUrls.length, 3);
});

test('empty and non-Copilot AI-credit rows are explicit rather than a zero reading', async () => {
  for (const usageItems of [[], [copilotItem(5, { product: 'GitHub Models', sku: 'AI Credit' })]]) {
    const result = await usage(async () => response({ usageItems }));
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'empty');
    assert.equal(result.source, 'ai_credit');
    assert.match(result.error, /no Copilot AI-credit usage/i);
    assert.equal(Object.hasOwn(result, 'used'), false);
  }
});

test('GitHub authentication, permission, unsupported scope, and server failures are distinct', async () => {
  const cases = [
    { status: 401, kind: 'authentication', message: /rejected the token/i },
    { status: 403, kind: 'permission', message: /Plan.*read-only/i },
    { status: 500, kind: 'github', message: /HTTP 500/i },
    { status: 503, kind: 'github', message: /HTTP 503/i },
  ];
  for (const item of cases) {
    const result = await usage(async () => response({ message: 'failure' }, item.status));
    assert.equal(result.ok, false);
    assert.equal(result.kind, item.kind);
    assert.match(result.error, item.message);
  }

  const unsupported = await usage(async () => response({ message: 'not found' }, 404));
  assert.equal(unsupported.kind, 'unsupported-scope');
  assert.match(unsupported.error, /organization- or enterprise-managed/i);
});

test('malformed JSON and malformed successful payloads are reported explicitly', async () => {
  const invalidJson = await usage(async () => response('{not json'));
  assert.equal(invalidJson.kind, 'malformed');
  assert.match(invalidJson.error, /malformed/i);

  const missingItems = await usage(async () => response({ timePeriod: { year: 2026, month: 10 } }));
  assert.equal(missingItems.kind, 'malformed');
  assert.match(missingItems.error, /malformed/i);
});

test('timeout and network failures are distinct and never expose the token', async () => {
  const timeoutError = new Error('request for ' + TOKEN + ' timed out');
  timeoutError.name = 'TimeoutError';
  const timeout = await usage(async () => { throw timeoutError; });
  assert.equal(timeout.kind, 'timeout');
  assert.match(timeout.error, /timed out/i);

  const network = await usage(async () => { throw new Error('socket failed with ' + TOKEN); });
  assert.equal(network.kind, 'network');
  assert.match(network.error, /Could not reach GitHub/i);

  for (const result of [timeout, network]) assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
});

test('manifest uses the new allowance key and renderer prevents stale refresh overwrites', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8'));
  const allowance = manifest.options.find(option => option.key === 'copilotCreditsIncluded');
  assert.ok(allowance);
  assert.equal(allowance.default, '0');
  assert.deepEqual(allowance.choices.map(choice => choice[0]), ['0', '1500', '7000', '20000']);
  assert.equal(manifest.options.some(option => option.key === 'copilotIncluded'), false);

  const renderer = fs.readFileSync(path.join(appDir, 'app.js'), 'utf8');
  assert.match(renderer, /const requestId = \+\+refreshRequestId/);
  assert.match(renderer, /if \(requestId !== refreshRequestId\) return/);
  assert.match(renderer, /AI credits/);
  assert.match(renderer, /Personal billing unavailable/);
});

test('source, archive, running asset, and catalog versions match', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8'));
  const renderer = fs.readFileSync(path.join(appDir, 'app.js'), 'utf8');
  const catalog = JSON.parse(fs.readFileSync(path.join(communityDir, 'index.json'), 'utf8'));
  const entry = catalog.apps.find(app => app.id === 'ai-usage');
  assert.ok(entry);
  assert.equal(entry.version, manifest.version);
  assert.match(renderer, new RegExp("RUNNING_VERSION = '" + manifest.version.replace(/\./g, '\\.') + "'"));

  const zip = new AdmZip(path.join(communityDir, entry.zip));
  const archivedManifest = JSON.parse(zip.readAsText('ai-usage/app.json'));
  assert.equal(archivedManifest.version, manifest.version);
  for (const file of ['app.json', 'app.js', 'index.html', 'style.css', 'server.js', 'README.md']) {
    const entryName = 'ai-usage/' + file;
    assert.ok(zip.getEntry(entryName), file + ' must be present in the archive');
    assert.equal(zip.readAsText(entryName), fs.readFileSync(path.join(appDir, file), 'utf8'), file + ' must match the source');
  }
});
