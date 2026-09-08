'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubService, nextApiPath, normalizeClientId, normalizeSettings, parseRepository, parseWorkflowDispatch, repositorySummary, validRef, validateDispatchInputs } = require('../app/githubService');

function response(status, data, headers = {}) { return { status, ok: status >= 200 && status < 300, headers: { get: name => headers[String(name).toLowerCase()] || null }, json: async () => data }; }
function oauth(token = 'gho_synthetic') { return { status: () => ({ connected: !!token, scopes: token ? ['repo'] : [] }), getValidAccessToken: async () => token ? { accessToken: token, scope: 'repo' } : null, beginDeviceFlow: async () => ({ ok: true, pending: true, userCode: 'ABCD-EFGH' }), pollDeviceFlow: async () => ({ ok: true, pending: true }), revokeToken: async () => ({ ok: true }) }; }

test('GitHub settings validation accepts owner/name and safe refs', () => {
  assert.deepEqual(normalizeSettings({}), { clientId:'', repository:'', branch:'' });
  assert.deepEqual(normalizeSettings({ clientId:' x ', repository:' acme/repo ', branch:' feature/a ' }), { clientId:'x', repository:'acme/repo', branch:'feature/a' });
  assert.deepEqual(parseRepository('acme/repo'), { owner:'acme', repo:'repo', fullName:'acme/repo' });
  assert.equal(validRef('feature/touch'), 'feature/touch');
  assert.equal(normalizeClientId(' Iv1.public '), 'Iv1.public');
  assert.throws(() => normalizeClientId('bad client id'), /invalid/);
  assert.throws(() => parseRepository('../repo'), /owner\/name/);
  assert.throws(() => validRef('main..bad'), /invalid/);
});

test('GitHub connection requires only the OAuth client id, not a preconfigured repository', async () => {
  const service = new GitHubService({ getSettings: () => ({ clientId:'Iv1.x', repository:'', branch:'' }), oauth: oauth(), openExternal: () => true });
  assert.equal(service.publicSettings().configured, true);
  assert.equal((await service.connect()).ok, true);
});

test('repository discovery follows GitHub pagination and returns sanitized accessible repositories', async () => {
  const calls = [];
  const service = new GitHubService({
    getSettings: () => ({ clientId:'Iv1.x', repository:'', branch:'' }), oauth: oauth(), openExternal: () => true,
    fetchImpl: async url => {
      calls.push(url);
      if (url.includes('page=2')) return response(200, [
        { full_name:'org/second', private:false, default_branch:'trunk', updated_at:'2026-08-23T10:00:00Z', permissions:{push:true} },
        { full_name:'acme/private', private:true, default_branch:'main', permissions:{admin:true} },
      ]);
      return response(200, [
        { full_name:'acme/private', private:true, archived:false, fork:false, default_branch:'main', updated_at:'2026-08-24T10:00:00Z', html_url:'https://evil.example', permissions:{admin:true} },
        { full_name:'../invalid', private:false },
      ], { link:'<https://api.github.com/user/repos?visibility=all&per_page=100&page=2>; rel="next", <https://api.github.com/user/repos?visibility=all&per_page=100&page=2>; rel="last"' });
    },
  });
  const result = await service.repositories();
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map(item => item.fullName), ['acme/private','org/second']);
  assert.equal(result.items[0].url, 'https://github.com/acme/private');
  assert.equal(result.items[0].permission, 'admin');
  assert.equal(result.items[1].permission, 'write');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /affiliation=owner%2Ccollaborator%2Corganization_member/);
  assert.equal(nextApiPath('<https://evil.example/user/repos?page=2>; rel="next"'), '');
  assert.equal(repositorySummary({ full_name:'../bad' }), null);
});

test('repository discovery includes accessible parent and original repositories for forks', async () => {
  const calls = [];
  const service = new GitHubService({
    getSettings: () => ({ clientId:'Iv1.x', repository:'', branch:'' }), oauth: oauth(), openExternal: () => true,
    fetchImpl: async url => {
      calls.push(url);
      if (url.endsWith('/repos/mark/bedrock-panel')) return response(200, {
        full_name:'mark/bedrock-panel', private:false, fork:true, default_branch:'main',
        parent:{ full_name:'TeeJS/bedrock-panel', private:false, fork:false, default_branch:'main', updated_at:'2026-08-24T09:00:00Z', permissions:{pull:true} },
        source:{ full_name:'original/bedrock-panel', private:false, fork:false, default_branch:'trunk', updated_at:'2026-08-23T09:00:00Z' },
      });
      if (url.endsWith('/repos/mark/unavailable')) return response(403, {message:'Forbidden'});
      return response(200, [
        { full_name:'mark/bedrock-panel', private:false, fork:true, default_branch:'main', updated_at:'2026-08-24T10:00:00Z', permissions:{admin:true} },
        { full_name:'mark/unavailable', private:true, fork:true, default_branch:'main', permissions:{admin:true} },
      ]);
    },
  });
  const result = await service.repositories();
  assert.equal(result.ok, true);
  assert.equal(result.upstreamsIncomplete, true);
  assert.deepEqual(result.items.map(item => item.fullName), [
    'mark/bedrock-panel', 'mark/unavailable', 'TeeJS/bedrock-panel', 'original/bedrock-panel',
  ]);
  assert.deepEqual(result.items[2], {
    fullName:'TeeJS/bedrock-panel', private:false, archived:false, fork:false, defaultBranch:'main',
    permission:'read', updatedAt:'2026-08-24T09:00:00Z', url:'https://github.com/TeeJS/bedrock-panel',
    relationship:'upstream', upstreamOf:'mark/bedrock-panel',
  });
  assert.equal(result.items[3].relationship, 'upstream');
  assert.equal(result.items[3].upstreamOf, 'mark/bedrock-panel');
  assert.equal(calls.length, 3);
});

test('fork upstreams already present in the authenticated repository list are not duplicated', async () => {
  const service = new GitHubService({
    getSettings: () => ({ clientId:'Iv1.x', repository:'', branch:'' }), oauth: oauth(), openExternal: () => true,
    fetchImpl: async url => {
      if (url.endsWith('/repos/mark/fork')) return response(200, {
        full_name:'mark/fork', fork:true,
        parent:{ full_name:'acme/upstream', private:false, fork:false, default_branch:'main' },
        source:{ full_name:'acme/upstream', private:false, fork:false, default_branch:'main' },
      });
      return response(200, [
        { full_name:'mark/fork', private:false, fork:true, default_branch:'main' },
        { full_name:'acme/upstream', private:false, fork:false, default_branch:'main', permissions:{push:true} },
      ]);
    },
  });
  const result = await service.repositories();
  assert.deepEqual(result.items.map(item => item.fullName), ['mark/fork','acme/upstream']);
  assert.equal(result.items[1].permission, 'write');
  assert.equal(result.items[1].relationship, undefined);
});

test('Issues filters use documented read-only parameters and cache authenticated identity', async () => {
  const calls = [];
  const service = new GitHubService({
    getSettings: () => ({ clientId:'Iv1.x', repository:'acme/repo', branch:'main' }), oauth:oauth(), openExternal:()=>true,
    fetchImpl: async url => {
      calls.push(url);
      if (url.endsWith('/user')) return response(200,{login:'octocat'});
      if (url.includes('page=1')) return response(200,[
        {number:9,title:'Issue',state:'open',user:{login:'a'}},
        {number:10,title:'PR',state:'open',pull_request:{url:'https://api.github.com/pulls/10'}},
      ], {link:'<https://api.github.com/repos/acme/repo/issues?state=open&page=2>; rel="next"'});
      return response(200,[]);
    },
  });
  const open = await service.issues('open',1,'acme/repo');
  const assigned = await service.issues('assigned',2,'acme/repo');
  const closed = await service.issues('closed',2,'acme/repo');
  assert.deepEqual(open.items.map(item => item.number), [9]);
  assert.equal(open.hasMore, true);
  assert.match(calls[0], /state=open/);
  assert.match(calls.find(url => url.includes('assignee=')), /assignee=octocat/);
  assert.match(calls.find(url => url.includes('state=closed')), /sort=updated/);
  assert.equal(calls.filter(url => url.endsWith('/user')).length, 1);
  assert.equal(assigned.filter, 'assigned');
  assert.equal(closed.filter, 'closed');
  assert.equal(closed.hasMore, false);
});

test('Issues list and detail caching respect manual refresh and derive trusted URLs', async () => {
  let calls = 0;
  const service = new GitHubService({
    getSettings:()=>({repository:'acme/repo'}), oauth:oauth(), openExternal:()=>true,
    fetchImpl:async url => {
      calls += 1;
      if (/\/issues\/7$/.test(url)) return response(200,{number:7,title:'Detail',state:'open',body_text:'Body',html_url:'https://evil.example/7'});
      return response(200,[{number:7,title:'Summary',state:'open'}]);
    },
  });
  assert.equal((await service.issues('open',1,'acme/repo')).cached, undefined);
  assert.equal((await service.issues('open',1,'acme/repo')).cached, true);
  await service.issues('open',1,'acme/repo',true);
  const detail = await service.issueDetails(7,'acme/repo');
  assert.equal((await service.issueDetails(7,'acme/repo')).cached, true);
  assert.equal(detail.item.url,'https://github.com/acme/repo/issues/7');
  assert.equal(calls,3);
});

test('Issues failures distinguish disabled, malformed, invalid, and removed resources', async () => {
  let mode = 'disabled';
  const service = new GitHubService({
    getSettings:()=>({repository:'acme/repo'}), oauth:oauth(), openExternal:()=>true,
    fetchImpl:async url => mode === 'disabled' ? response(410,{message:'Issues disabled'})
      : mode === 'malformed' ? response(200,{items:[]})
        : response(404,{message:'Not Found'}),
  });
  assert.equal((await service.issues('bad',1,'acme/repo')).code,'invalid_issue_filter');
  assert.equal((await service.issues('open',0,'acme/repo')).code,'invalid_issue_page');
  assert.equal((await service.issueDetails('../7','acme/repo')).code,'invalid_issue');
  assert.equal((await service.issues('open',1,'acme/repo')).code,'issues_unavailable');
  mode = 'malformed';
  assert.equal((await service.issues('closed',1,'acme/repo')).code,'invalid_response');
  mode = 'missing';
  assert.equal((await service.issueDetails(7,'acme/repo')).code,'issue_unavailable');
});

test('Issues surface permission and rate-limit failures without discarding their meaning', async () => {
  let mode = 'permission';
  const service = new GitHubService({
    getSettings:()=>({repository:'acme/repo'}), oauth:oauth(), openExternal:()=>true,
    fetchImpl:async () => mode === 'permission'
      ? response(403,{message:'Forbidden'},{'x-ratelimit-remaining':'12'})
      : response(403,{message:'Rate limited'},{'x-ratelimit-remaining':'0','x-ratelimit-reset':'1787587200'}),
  });
  assert.equal((await service.issues('open',2,'acme/repo')).code,'insufficient_permissions');
  mode = 'rate';
  const limited = await service.issues('closed',2,'acme/repo');
  assert.equal(limited.code,'rate_limited');
  assert.match(limited.resetAt,/^2026-/);
});

test('public settings and failures never return OAuth tokens', async () => {
  const service = new GitHubService({ getSettings: () => ({ clientId:'Iv1.x', repository:'acme/repo', branch:'main' }), oauth: oauth('gho_do_not_return'), openExternal: () => true, fetchImpl: async () => response(401,{ message:'bad' }) });
  assert.doesNotMatch(JSON.stringify(service.publicSettings()), /gho_do_not_return/);
  const result = await service.overview();
  assert.equal(result.code, 'authentication_failed');
  assert.doesNotMatch(JSON.stringify(result), /gho_do_not_return/);
});

test('an old placeholder token is not treated as an authorized GitHub app connection', () => {
  const oldOauth = oauth('gho_old');
  oldOauth.status = () => ({ connected: true, scopes: ['read:user'] });
  const service = new GitHubService({ getSettings: () => ({ clientId:'Iv1.x', repository:'acme/repo', branch:'main' }), oauth: oldOauth, openExternal: () => true });
  assert.equal(service.publicSettings().connected, false);
});

test('a device-flow token is removed when GitHub identity validation fails', async () => {
  let revoked = false;
  const auth = oauth('gho_unvalidated');
  auth.pollDeviceFlow = async () => ({ ok:true, connected:true, pending:false });
  auth.revokeToken = async () => { revoked = true; return { ok:true }; };
  const service = new GitHubService({ getSettings: () => ({ clientId:'Iv1.x', repository:'acme/repo', branch:'main' }), oauth: auth, openExternal: () => true, fetchImpl: async () => response(401,{ message:'bad' }) });
  const result = await service.pollConnect();
  assert.equal(result.code, 'authentication_failed');
  assert.equal(revoked, true);
});

test('Actions commands use only the allowlisted documented endpoints', async () => {
  const calls = [];
  const workflowSource = Buffer.from('on:\n  workflow_dispatch:\n').toString('base64');
  const service = new GitHubService({
    getSettings: () => ({ clientId:'Iv1.x', repository:'acme/repo', branch:'main' }), oauth: oauth(), openExternal: () => true,
    fetchImpl: async (url, options) => {
      calls.push({url,options});
      if (url.endsWith('/actions/workflows/8')) return response(200,{id:8,name:'CI',path:'.github/workflows/ci.yml'});
      if (url.includes('/contents/.github/workflows/ci.yml')) return response(200,{encoding:'base64',content:workflowSource});
      return response(201,{});
    },
  });
  assert.equal((await service.action('delete-branch',{runId:1})).code,'invalid_action');
  assert.equal((await service.action('rerun-failed',{runId:7})).ok,true);
  assert.equal((await service.action('rerun',{runId:7})).ok,true);
  assert.equal((await service.action('cancel',{runId:7})).ok,true);
  assert.equal((await service.action('dispatch',{workflowId:8,ref:'main'})).ok,true);
  assert.deepEqual(calls.filter(call => call.options.method === 'POST').map(call => call.url.replace('https://api.github.com','')), ['/repos/acme/repo/actions/runs/7/rerun-failed-jobs','/repos/acme/repo/actions/runs/7/rerun','/repos/acme/repo/actions/runs/7/cancel','/repos/acme/repo/actions/workflows/8/dispatches']);
  assert.ok(calls.every(call => call.options.headers.Authorization === 'Bearer gho_synthetic'));
});

test('panel-selected repositories scope API actions and external links without changing settings', async () => {
  const calls = [];
  const service = new GitHubService({ getSettings: () => ({ clientId:'Iv1.x', repository:'acme/default', branch:'main' }), oauth: oauth(), openExternal: () => true, fetchImpl: async (url, options) => { calls.push({url,options}); return response(201,{}); } });
  assert.equal((await service.action('cancel',{runId:9,repository:'org/selected'})).ok,true);
  assert.equal(calls[0].url,'https://api.github.com/repos/org/selected/actions/runs/9/cancel');
  assert.equal(service.externalUrl('https://github.com/org/selected/actions/runs/9','org/selected'),'https://github.com/org/selected/actions/runs/9');
  assert.equal(service.externalUrl('https://github.com/acme/default/actions','org/selected'),null);
  assert.equal(service.settings().repository,'acme/default');
});

test('browsed repositories use their own default branch instead of the editor fallback branch', async () => {
  const calls = [];
  const service = new GitHubService({
    getSettings: () => ({ clientId:'Iv1.x', repository:'acme/default', branch:'main' }), oauth: oauth(), openExternal: () => true,
    fetchImpl: async url => {
      calls.push(url);
      if (url.endsWith('/repos/org/selected')) return response(200,{full_name:'org/selected',default_branch:'trunk',html_url:'https://github.com/org/selected'});
      if (url.includes('/commits/trunk')) return response(200,{sha:'abcdef123456',commit:{message:'Selected repo',author:{name:'A',date:'2026-08-24T10:00:00Z'}},html_url:'https://github.com/org/selected/commit/abcdef'});
      if (url.includes('/releases/latest')) return response(404,{message:'Not Found'});
      if (url.includes('/actions/runs')) return response(200,{workflow_runs:[]});
      return response(200,[]);
    },
  });
  const result = await service.overview('org/selected');
  assert.equal(result.ok,true);
  assert.equal(result.selectedBranch,'trunk');
  assert.ok(calls.some(url=>url.includes('/repos/org/selected/commits/trunk')));
  assert.ok(calls.every(url=>url.includes('/repos/org/selected')));
});

test('external links stay under the configured repository or OAuth setup page', () => {
  const service = new GitHubService({ getSettings: () => ({ clientId:'Iv1.x', repository:'acme/repo', branch:'main' }), oauth: oauth(), openExternal: () => true });
  assert.equal(service.externalUrl('https://github.com/acme/repo/actions/runs/1'),'https://github.com/acme/repo/actions/runs/1');
  assert.equal(service.externalUrl('https://github.com/settings/applications/new'),'https://github.com/settings/applications/new');
  assert.equal(service.externalUrl('https://github.com/acme/other'),null);
  assert.equal(service.externalUrl('file:///C:/Windows/System32/calc.exe'),null);
});

test('workflow dispatch input parser supports string, boolean, and choice inputs conservatively', () => {
  const parsed = parseWorkflowDispatch(`
on:
  push:
  workflow_dispatch:
    inputs:
      channel:
        description: Release channel
        required: true
        type: choice
        options:
          - stable
          - preview
      sign:
        type: boolean
        default: false
      note:
        type: string
        default: "touch build"
`);
  assert.equal(parsed.supported, true);
  assert.equal(parsed.hasDispatch, true);
  assert.deepEqual(parsed.inputs.map(input => input.type), ['choice','boolean','string']);
  assert.deepEqual(parsed.inputs[0].options, ['stable','preview']);
  assert.deepEqual(validateDispatchInputs(parsed.inputs, { channel:'preview', sign:true, note:'ship it' }), { channel:'preview', sign:true, note:'ship it' });
  assert.throws(() => validateDispatchInputs(parsed.inputs, { channel:'invented' }), /workflow choices/);
  assert.equal(parseWorkflowDispatch('on: [push, workflow_dispatch]\n').hasDispatch, true);
  assert.equal(parseWorkflowDispatch('on:\n  workflow_dispatch: { inputs: { x: y } }\n').supported, false);
  assert.equal(parseWorkflowDispatch('on:\n  workflow_dispatch:\n    inputs:\n      ? [complex, key]\n      : { type: string }\n').supported, false);
});

test('workflow dispatch metadata is read from the allowlisted workflow content path and validates required inputs', async () => {
  const calls = [];
  const source = Buffer.from('on:\n  workflow_dispatch:\n    inputs:\n      target:\n        required: true\n        type: choice\n        options: [staging, production]\n').toString('base64');
  const service = new GitHubService({
    getSettings: () => ({ clientId:'Iv1.x', repository:'acme/repo', branch:'main' }), oauth:oauth(), openExternal:()=>true,
    fetchImpl: async (url, options) => {
      calls.push({url,options});
      if (url.endsWith('/actions/workflows/4')) return response(200,{id:4,name:'Deploy',path:'.github/workflows/deploy.yml',html_url:'https://github.com/acme/repo/actions/workflows/deploy.yml'});
      if (url.includes('/contents/.github/workflows/deploy.yml')) return response(200,{encoding:'base64',content:source});
      if (url.endsWith('/dispatches')) return response(200,{workflow_run_id:81});
      return response(404,{message:'Not Found'});
    },
  });
  const info = await service.workflowDispatchInfo(4,'main','acme/repo');
  assert.equal(info.inputs[0].name,'target');
  assert.equal((await service.action('dispatch',{workflowId:4,ref:'main',repository:'acme/repo',inputs:{}})).code,'invalid_workflow_inputs');
  const dispatched = await service.action('dispatch',{workflowId:4,ref:'main',repository:'acme/repo',inputs:{target:'production'}});
  assert.deepEqual(dispatched,{ok:true,runId:81});
  const dispatch = calls.find(call => call.url.endsWith('/dispatches'));
  assert.deepEqual(JSON.parse(dispatch.options.body),{ref:'main',inputs:{target:'production'}});
});

test('run detail reuses one Actions model for jobs, steps, failure, controls, and artifacts', async () => {
  const service = new GitHubService({
    getSettings: () => ({ clientId:'Iv1.x', repository:'acme/repo', branch:'main' }), oauth:oauth(), openExternal:()=>true,
    fetchImpl: async url => {
      if (url.endsWith('/actions/runs/7')) return response(200,{id:7,workflow_id:2,run_number:3,name:'CI',status:'completed',conclusion:'failure'});
      if (url.includes('/jobs?')) return response(200,{jobs:[{id:9,name:'Tests',status:'completed',conclusion:'failure',steps:[{number:1,name:'npm test',status:'completed',conclusion:'failure'}]}]});
      if (url.includes('/artifacts?')) return response(200,{artifacts:[{id:5,name:'results',size_in_bytes:42,expired:false}]});
      return response(404,{message:'Not Found'});
    },
  });
  const result = await service.runDetails(7,'acme/repo');
  assert.equal(result.item.failure.stepName,'npm test');
  assert.equal(result.item.controls.rerunFailed,true);
  assert.equal(result.item.artifacts[0].id,5);
});

test('artifact download keeps the privileged redirect out of the result and handles expiry and failure', async () => {
  const opened = [];
  let mode = 'redirect';
  const service = new GitHubService({
    getSettings: () => ({ clientId:'Iv1.x', repository:'acme/repo', branch:'main' }), oauth:oauth(), openExternal:value => { opened.push(value); return true; },
    fetchImpl: async () => mode === 'redirect' ? response(302,null,{location:'https://objects.example.test/signed-download?secret=value'}) : mode === 'expired' ? response(410,{}) : response(500,{}),
  });
  assert.deepEqual(await service.action('download-artifact',{artifactId:3,repository:'acme/repo'}),{ok:true});
  assert.equal(opened.length,1);
  assert.doesNotMatch(JSON.stringify(await service.action('download-artifact',{artifactId:3,repository:'acme/repo'})),/signed-download/);
  mode = 'expired';
  assert.equal((await service.action('download-artifact',{artifactId:3,repository:'acme/repo'})).code,'artifact_expired');
  mode = 'failed';
  assert.equal((await service.action('download-artifact',{artifactId:3,repository:'acme/repo'})).code,'artifact_download_failed');
});

test('rate limits and network errors remain explicit and never expose authorization data', async () => {
  const limited = new GitHubService({ getSettings:()=>({repository:'acme/repo',branch:'main'}), oauth:oauth('gho_private'), openExternal:()=>true, fetchImpl:async()=>response(403,{message:'rate'},{'x-ratelimit-remaining':'0','x-ratelimit-reset':'1787558400'}) });
  const limitedResult = await limited.overview();
  assert.equal(limitedResult.code,'rate_limited');
  assert.ok(limitedResult.resetAt);
  assert.doesNotMatch(JSON.stringify(limitedResult),/gho_private/);
  const offline = new GitHubService({ getSettings:()=>({repository:'acme/repo',branch:'main'}), oauth:oauth(), openExternal:()=>true, fetchImpl:async()=>{ throw new Error('socket secret'); } });
  assert.equal((await offline.overview()).code,'network_unavailable');
});
