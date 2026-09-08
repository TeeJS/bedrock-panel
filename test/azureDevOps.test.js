'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');

const appDir = path.join(__dirname, '..', 'community-apps', 'azure-devops');
const serverPath = path.join(appDir, 'server.js');
const server = require(serverPath);

function manifest() {
  return JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8'));
}

function response(value, status, responseHeaders) {
  const body = JSON.stringify(value);
  return {
    ok: !status || status < 400,
    status: status || 200,
    headers: { get(name) {
      if (name.toLowerCase() === 'content-length') return String(Buffer.byteLength(body));
      return responseHeaders && responseHeaders[name.toLowerCase()] || null;
    } },
    async text() { return body; }
  };
}

function context(overrides) {
  return Object.assign({
    query: {},
    options: {},
    oauth: {
      async status() { return { configured: true, connected: true, scopes: server._test.OAUTH_SCOPES }; },
      async getAccessToken() { return { accessToken: 'server-only-token' }; },
      async connect() { return { connected: true }; },
      async disconnect() { return { connected: false }; }
    }
  }, overrides || {});
}

test.beforeEach(() => server._test.reset());

test('manifest is a self-contained served drop-in with server-only credentials', () => {
  const data = manifest();
  assert.equal(data.id, 'azure-devops');
  assert.equal(data.entry, 'index.html');
  assert.equal(data.served, true);
  assert.equal(data.server, 'server.js');
  assert.deepEqual(data.oauth.scopes, server._test.OAUTH_SCOPES);
  assert.deepEqual(data.options.map(option => option.key), ['oauthClientId', 'oauthClientSecret', 'enablePipelineActions']);
  for (const key of ['oauthClientId', 'oauthClientSecret', 'enablePipelineActions']) {
    assert.equal(data.options.find(option => option.key === key).serverOnly, true, `${key} must stay out of the page URL`);
  }
  assert.equal(data.options.find(option => option.key === 'oauthClientSecret').type, 'secret');
});

test('community catalog and importable zip contain the Azure DevOps drop-in', () => {
  const communityDir = path.join(__dirname, '..', 'community-apps');
  const catalog = JSON.parse(fs.readFileSync(path.join(communityDir, 'index.json'), 'utf8'));
  const entry = catalog.apps.find(app => app.id === 'azure-devops');
  assert.deepEqual(entry, {
    id: 'azure-devops',
    name: 'Azure DevOps',
    description: 'Project-focused Azure DevOps repositories, pipelines, pull requests, and work items.',
    version: '1.0.4',
    zip: 'azure-devops.zip',
    server: true
  });
  const names = new AdmZip(path.join(communityDir, entry.zip)).getEntries().map(item => item.entryName.replace(/\\/g, '/'));
  for (const file of ['app.json', 'index.html', 'style.css', 'app.js', 'server.js', 'SETUP.md']) {
    assert.ok(names.includes(`azure-devops/${file}`), `${file} must be present under the archive root`);
  }
});

test('app assets are relative and the panel defines exactly four overview slots', () => {
  const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
  const data = manifest();
  assert.match(html, /href="style\.css"/);
  assert.match(html, /src="app\.js"/);
  assert.match(html, /<svg[^>]*viewBox="0 0 24 24"/);
  assert.doesNotMatch(html, /(?:src|href)="\//);
  assert.equal(data.options.filter(option => /^card[1-4]$/.test(option.key)).length, 0);
});

test('overview cards present healthy, warning, and failure states from existing datasets', () => {
  const datasets = {
    repositories: { repositories: [{ name: 'Bedrock Panel', defaultBranch: 'main' }] },
    pipelines: { pipelines: [{ id: 1 }], runs: [{ result: 'succeeded', status: 'completed' }] },
    pullRequests: { pullRequests: [] },
    workItems: { workItems: [] }
  };
  const repository = server._test.metricFor('repositories', datasets);
  const pipeline = server._test.metricFor('pipelines', datasets);
  const pullRequests = server._test.metricFor('pull-requests', datasets);
  const workItems = server._test.metricFor('work-items', datasets);
  assert.equal(repository.message, 'Bedrock Panel · main');
  assert.equal(repository.unit, 'Repository');
  assert.equal(pipeline.tone, 'healthy');
  assert.equal(pipeline.message, 'No recent pipeline failures');
  assert.equal(pullRequests.tone, 'healthy');
  assert.equal(pullRequests.message, 'No PRs need attention');
  assert.equal(workItems.tone, 'healthy');
  assert.equal(workItems.message, 'No active work items');

  datasets.pipelines.runs.push({ result: 'failed', status: 'completed' });
  datasets.pullRequests.pullRequests.push({ isDraft: true });
  datasets.workItems.workItems.push({ type: 'Bug', assignedTo: 'Alex' });
  assert.equal(server._test.metricFor('pipelines', datasets).tone, 'danger');
  assert.equal(server._test.metricFor('pull-requests', datasets).tone, 'warning');
  assert.equal(server._test.metricFor('work-items', datasets).tone, 'warning');
});

test('renderer persists project context and guards against stale project responses', () => {
  const source = fs.readFileSync(path.join(appDir, 'app.js'), 'utf8');
  assert.match(source, /localStorage\.setItem\('azure-devops\.organization'/);
  assert.match(source, /localStorage\.setItem\('azure-devops\.project'/);
  assert.match(source, /contextVersion\+\+/);
  assert.match(source, /contextMatches\(/);
  assert.doesNotMatch(source, /accessToken|refreshToken|oauthClientSecret/);
  assert.match(source, /diagnosticSummary/);
  assert.match(source, /navigator\.clipboard\.writeText/);
});

test('external Azure DevOps links are limited to the selected organization', () => {
  assert.equal(
    server._test.safeExternalUrl('https://dev.azure.com/contoso/Project/_build', 'contoso'),
    'https://dev.azure.com/contoso/Project/_build'
  );
  assert.equal(server._test.safeExternalUrl('http://dev.azure.com/contoso/Project', 'contoso'), '');
  assert.equal(server._test.safeExternalUrl('https://evil.example/contoso/Project', 'contoso'), '');
  assert.equal(server._test.safeExternalUrl('https://dev.azure.com/other/Project', 'contoso'), '');
  assert.equal(server._test.safeExternalUrl('https://user:pass@dev.azure.com/contoso/Project', 'contoso'), '');
});

test('overview card order is fixed even when legacy card options remain in saved config', () => {
  assert.deepEqual(server._test.configuredCards({ card1: 'pipelines', card2: 'not-a-card' }), [
    'repositories', 'pipelines', 'pull-requests', 'work-items'
  ]);
});

test('organization discovery uses the token server-side and never returns it', async () => {
  const calls = [];
  server._test.setFetch(async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    if (url.includes('/profiles/me')) return response({ id: '11111111-1111-1111-1111-111111111111' });
    return response({ value: [{ accountId: 'org-1', accountName: 'contoso' }] });
  });

  const result = await server.handle('organizations', context());
  assert.equal(result.ok, true);
  assert.deepEqual(result.organizations.map(item => item.name), ['contoso']);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.authorization === 'Bearer server-only-token'));
  assert.doesNotMatch(JSON.stringify(result), /server-only-token/);
});

test('OAuth lifecycle uses the Azure DevOps resource scopes', async () => {
  let connectedWith;
  let disconnected = false;
  const ctx = context({
    options: { oauthClientId: 'client-id', oauthClientSecret: 'client-secret' },
    oauth: {
      async status() { return { configured: true, connected: false }; },
      async connect(scopes, credentials) { connectedWith = { scopes, credentials }; return { connected: true }; },
      async disconnect() { disconnected = true; return { connected: false }; }
    }
  });
  assert.equal((await server.handle('auth-status', ctx)).connected, false);
  assert.equal((await server.handle('connect', ctx)).connected, true);
  assert.deepEqual(connectedWith.scopes, server._test.OAUTH_SCOPES);
  assert.equal(connectedWith.credentials.clientId, 'client-id');
  assert.equal((await server.handle('disconnect', ctx)).connected, false);
  assert.equal(disconnected, true);
});

test('simultaneous organization refreshes are deduplicated', async () => {
  let calls = 0;
  server._test.setFetch(async url => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return url.includes('/profiles/me')
      ? response({ id: '11111111-1111-1111-1111-111111111111' })
      : response({ value: [{ accountId: 'org-1', accountName: 'contoso' }] });
  });
  const ctx = context({ query: { force: '1' } });
  const [first, second] = await Promise.all([
    server.handle('organizations', ctx),
    server.handle('organizations', ctx)
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls, 2);
});

test('failed project refresh returns the last successful dataset as stale', async () => {
  let fail = false;
  server._test.setFetch(async () => {
    if (fail) throw new Error('offline');
    return response({ value: [{ id: 'project-1', name: 'Quake', state: 'wellFormed' }] });
  });
  const first = await server.handle('projects', context({ query: { organization: 'contoso' } }));
  assert.equal(first.ok, true);
  fail = true;
  const second = await server.handle('projects', context({ query: { organization: 'contoso', force: '1' } }));
  assert.equal(second.ok, true);
  assert.equal(second.stale, true);
  assert.equal(second.projects[0].name, 'Quake');
  assert.equal(second.diagnostic.source, 'Projects');
  assert.equal(second.diagnostic.providerCode, 'network_error');
});

test('repository discovery and detail map branches, commits, and pull requests', async () => {
  server._test.setFetch(async url => {
    if (url.includes('/_apis/projects')) return response({ value: [{ id: 'project-1', name: 'Quake', state: 'wellFormed' }] });
    if (url.includes('/git/repositories?')) return response({ value: [{ id: 'repo-1', name: 'Bedrock Panel', defaultBranch: 'refs/heads/main', size: 1000 }] });
    if (url.includes('/refs?')) return response({ value: [{ name: 'refs/heads/main', objectId: 'abcdef' }] });
    if (url.includes('/commits?')) return response({ value: [{ commitId: 'abcdef', comment: 'Change', author: { name: 'Alex', date: '2026-08-26T10:00:00Z' } }] });
    if (url.includes('/pullrequests?')) return response({ value: [{ pullRequestId: 8, title: 'Review', status: 'active', repository: { id: 'repo-1', name: 'Bedrock Panel' } }] });
    throw new Error(`Unexpected request: ${url}`);
  });
  const ctx = context({ query: { organization: 'contoso', project: 'project-1', repository: 'repo-1' } });
  const result = await server.handle('repository', ctx);
  assert.equal(result.ok, true);
  assert.equal(result.repository.defaultBranch, 'main');
  assert.equal(result.branches[0].name, 'main');
  assert.equal(result.commits[0].id, 'abcdef');
  assert.equal(result.pullRequests[0].id, 8);
  assert.match(result.commits[0].url, /^https:\/\/dev\.azure\.com\/contoso\//);
});

test('work item batches request relations without the conflicting fields parameter', async () => {
  const bodies = [];
  server._test.setFetch(async (url, options) => {
    if (url.includes('/_apis/projects')) return response({ value: [{ id: 'project-1', name: 'Quake', state: 'wellFormed' }] });
    if (url.includes('/wit/wiql?')) return response({ workItems: [{ id: 73 }] });
    if (url.includes('/wit/workitemsbatch')) {
      bodies.push(JSON.parse(options.body));
      return response({ value: [{ id: 73, fields: { 'System.Title': 'Fix issue', 'System.WorkItemType': 'Bug', 'System.State': 'Active' }, relations: [] }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const result = await server.handle('work-items', context({ query: { organization: 'contoso', project: 'project-1' } }));
  assert.equal(result.ok, true);
  assert.equal(result.workItems[0].id, 73);
  assert.deepEqual(bodies, [{ ids: [73], '$expand': 'Relations' }]);
});

test('pipeline detail maps stage failures and reliable run relationships', async () => {
  server._test.setFetch(async url => {
    if (url.includes('/_apis/projects')) return response({ value: [{ id: 'project-1', name: 'Quake', state: 'wellFormed' }] });
    if (url.includes('/timeline?')) return response({ records: [{ id: 'stage-1', name: 'Test', type: 'Stage', state: 'completed', result: 'failed', issues: [{ message: 'Tests failed' }] }] });
    if (url.includes('/workitems?')) return response({ value: [{ id: 55 }] });
    if (url.includes('/build/builds/42?')) return response({ id: 42, buildNumber: '42', status: 'completed', result: 'failed', sourceBranch: 'refs/heads/main', sourceVersion: 'abcdef', definition: { id: 7, name: 'Build' }, repository: { id: 'repo-1', name: 'Bedrock Panel' } });
    throw new Error(`Unexpected request: ${url}`);
  });
  const result = await server.handle('run', context({ query: { organization: 'contoso', project: 'project-1', run: '42' } }));
  assert.equal(result.ok, true);
  assert.equal(result.stages[0].issues[0], 'Tests failed');
  assert.equal(result.workItems[0].id, 55);
  assert.match(result.run.commitUrl, /\/commit\/abcdef$/);
});

test('pull requests and work items stay read-only and retain explicit links', async () => {
  const workItemBodies = [];
  server._test.setFetch(async (url, options) => {
    if (url.includes('/_apis/projects')) return response({ value: [{ id: 'project-1', name: 'Quake', state: 'wellFormed' }] });
    if (url.includes('/git/pullrequests/9/workitems')) return response({ value: [{ id: 73 }] });
    if (url.includes('/git/pullrequests/9?')) return response({ pullRequestId: 9, title: 'Review', status: 'active', description: 'Read only', repository: { id: 'repo-1', name: 'Bedrock Panel' }, reviewers: [{ displayName: 'Sam', vote: 10 }] });
    if (url.includes('/wit/workitemsbatch')) {
      const body = JSON.parse(options.body);
      workItemBodies.push(body);
      return response({ value: [{ id: body.ids[0], fields: { 'System.Title': 'Fix issue', 'System.WorkItemType': 'Bug', 'System.State': 'Active' }, relations: [{ rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/x', attributes: { name: 'Pull Request' } }] }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const base = { organization: 'contoso', project: 'project-1' };
  const pr = await server.handle('pull-request', context({ query: Object.assign({ pullRequest: '9' }, base) }));
  assert.equal(pr.ok, true);
  assert.equal(pr.reviewers[0].vote, 10);
  assert.equal(pr.workItems[0].id, 73);
  const work = await server.handle('work-item', context({ query: Object.assign({ workItem: '73' }, base) }));
  assert.equal(work.ok, true);
  assert.equal(work.workItem.relations[0].name, 'Pull Request');
  assert.deepEqual(workItemBodies, [{ ids: [73], '$expand': 'Relations' }]);
});

test('cache entries remain isolated between selected projects', async () => {
  const repoCalls = [];
  server._test.setFetch(async url => {
    if (url.includes('/_apis/projects')) return response({ value: [{ id: 'p1', name: 'One', state: 'wellFormed' }, { id: 'p2', name: 'Two', state: 'wellFormed' }] });
    if (url.includes('/git/repositories?')) {
      repoCalls.push(url);
      return response({ value: [{ id: `repo-${repoCalls.length}`, name: repoCalls.length === 1 ? 'one-repo' : 'two-repo' }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const first = await server.handle('repositories', context({ query: { organization: 'contoso', project: 'p1' } }));
  const second = await server.handle('repositories', context({ query: { organization: 'contoso', project: 'p2' } }));
  assert.equal(first.repositories[0].name, 'one-repo');
  assert.equal(second.repositories[0].name, 'two-repo');
  assert.equal(repoCalls.length, 2);
});

test('permission failures are sanitized and legitimate empty states succeed', async () => {
  server._test.setFetch(async url => {
    if (url.includes('/_apis/projects')) return response({ value: [{ id: 'project-1', name: 'Quake', state: 'wellFormed' }] });
    if (url.includes('/git/repositories?')) return response({
      message: 'TF401019: Repository access denied. Bearer secret-token-value',
      typeKey: 'GitRepositoryNotFoundException',
      errorCode: 'TF401019'
    }, 403, { 'x-vss-e2eid': '11111111-2222-3333-4444-555555555555' });
    if (url.includes('/wit/wiql?')) return response({ workItems: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  const base = { organization: 'contoso', project: 'project-1' };
  const denied = await server.handle('repositories', context({ query: base }));
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'forbidden');
  assert.equal(denied.diagnostic.source, 'Repositories');
  assert.equal(denied.diagnostic.status, 403);
  assert.equal(denied.diagnostic.providerCode, 'TF401019');
  assert.equal(denied.diagnostic.providerType, 'GitRepositoryNotFoundException');
  assert.equal(denied.diagnostic.requestId, '11111111-2222-3333-4444-555555555555');
  assert.match(denied.diagnostic.providerMessage, /Repository access denied/);
  assert.match(denied.diagnostic.providerMessage, /Bearer \[redacted\]/);
  assert.doesNotMatch(JSON.stringify(denied), /secret-token-value/);
  const empty = await server.handle('work-items', context({ query: base }));
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.workItems, []);
});

test('pipeline mutations are denied before any state-changing request when disabled', async () => {
  let postCalls = 0;
  server._test.setFetch(async (url, options) => {
    if (options.method === 'POST') postCalls++;
    if (url.includes('/_apis/projects')) return response({ value: [{ id: 'project-1', name: 'Quake', state: 'wellFormed' }] });
    return response({ value: [] });
  });
  const result = await server.handle('run-pipeline', context({
    query: { organization: 'contoso', project: 'project-1' },
    options: { enablePipelineActions: false },
    body: Buffer.from(JSON.stringify({ pipelineId: 7 }))
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'actions_disabled');
  assert.equal(postCalls, 0);
});

test('enabled pipeline run is previewed before it is queued', async () => {
  const requests = [];
  server._test.setFetch(async (url, options) => {
    requests.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    if (url.includes('/_apis/projects')) return response({ value: [{ id: 'project-1', name: 'Quake', state: 'wellFormed' }] });
    if (url.includes('/_apis/pipelines?')) return response({ value: [{ id: 7, name: 'Build' }] });
    if (url.includes('/_apis/build/builds?')) return response({ value: [] });
    if (url.includes('/_apis/pipelines/7/runs')) return response({ id: 41, state: 'inProgress' });
    throw new Error(`Unexpected request: ${url}`);
  });
  const result = await server.handle('run-pipeline', context({
    query: { organization: 'contoso', project: 'project-1' },
    options: { enablePipelineActions: true },
    body: Buffer.from(JSON.stringify({ pipelineId: 7, refName: 'refs/heads/main' }))
  }));
  const runRequests = requests.filter(item => item.url.includes('/_apis/pipelines/7/runs'));
  assert.equal(result.ok, true);
  assert.equal(runRequests.length, 2);
  assert.equal(runRequests[0].body.previewRun, true);
  assert.equal(runRequests[0].body.resources.repositories.self.refName, 'refs/heads/main');
  assert.equal(runRequests[1].body.previewRun, undefined);
});

test('unknown server actions use the drop-in contract response', async () => {
  const result = await server.handle('not-real', context());
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unknown action');
});
