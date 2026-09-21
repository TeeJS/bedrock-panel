'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const server = require('./server');

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function run() {
  const appSource = fs.readFileSync(require.resolve('./app'), 'utf8');
  const inferredParentSource = appSource.match(/function inferredParentId\(item\) \{[\s\S]*?\n\}/);
  assert(inferredParentSource, 'inferredParentId should remain testable');
  const browserFallback = {};
  vm.runInNewContext(`${inferredParentSource[0]}; result = inferredParentId({ relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/org/_apis/wit/workItems/456' }] });`, browserFallback);
  assert.strictEqual(browserFallback.result, 456);
  const pipelineRankSource = appSource.match(/function pipelineStatusRank\(pipeline\) \{[\s\S]*?\n\}/);
  const pipelineTimeSource = appSource.match(/function pipelineRunTime\(pipeline\) \{[\s\S]*?\n\}/);
  const pipelineCompareSource = appSource.match(/function comparePipelines\(left, right\) \{[\s\S]*?\n\}/);
  assert(pipelineRankSource, 'pipelineStatusRank should remain testable');
  assert(pipelineTimeSource, 'pipelineRunTime should remain testable');
  assert(pipelineCompareSource, 'comparePipelines should remain testable');
  vm.runInNewContext(`${pipelineRankSource[0]}; ${pipelineTimeSource[0]}; ${pipelineCompareSource[0]}; result = [
    { name: 'Never', latestRun: null },
    { name: 'Success', latestRun: { status: 'completed', result: 'succeeded', queuedAt: '2026-09-09T09:00:00Z' } },
    { name: 'Failed old', latestRun: { status: 'completed', result: 'failed', queuedAt: '2026-09-08T09:00:00Z' } },
    { name: 'Failed new', latestRun: { status: 'completed', result: 'failed', queuedAt: '2026-09-09T10:00:00Z' } },
    { name: 'Running', latestRun: { status: 'inProgress', queuedAt: '2026-09-07T09:00:00Z' } }
  ].sort(comparePipelines).map(item => item.name).join(',');`, browserFallback);
  assert.strictEqual(browserFallback.result, 'Running,Failed new,Failed old,Success,Never');
  const pipelineControlSource = appSource.match(/function pipelineControl\(run\) \{[\s\S]*?\n\}/);
  assert(pipelineControlSource, 'pipelineControl should remain testable');
  vm.runInNewContext(`${pipelineControlSource[0]}; result = [pipelineControl({ status: 'inProgress' }), pipelineControl({ status: 'notStarted' }), pipelineControl({ status: 'completed' })].join(',');`, browserFallback);
  assert.strictEqual(browserFallback.result, 'stop,cancel,');
  assert(appSource.includes('class="pipeline-action run"'), 'pipeline cards should expose a run button');
  assert(!appSource.includes('${runStatusIcon(pipeline.latestRun)}'), 'pipeline cards should not render a leading status icon');

  server._test.reset();
  server._test.setFetch(async (url, options = {}) => {
    if (url.includes('/_apis/projects?')) return json({ value: [{ id: 'project-1', name: 'Panel' }] });
    if (url.includes('/_apis/profile/profiles/me?')) return json({ id: 'user-1', displayName: 'Panel User' });
    if (url.includes('/_apis/work/teamsettings/iterations?')) return json({ value: [{ name: 'Sprint 7', path: 'Panel\\Sprint 7' }] });
    if (url.includes('/_apis/wit/wiql?')) {
      const query = JSON.parse(options.body).query;
      if (query.includes('[System.AssignedTo] = @Me')) return json({ workItems: [{ id: 102 }, { id: 103 }] });
      return json({ workItems: [{ id: 101 }, { id: 102 }, { id: 103 }] });
    }
    if (url.includes('/_apis/wit/workitemsbatch?')) return json({ value: [
      {
        id: 101,
        fields: {
          'System.Title': 'Create touch-friendly board',
          'System.WorkItemType': 'User Story',
          'System.State': 'New',
          'System.AssignedTo': { id: 'user-2', displayName: 'Another User' },
          'System.IterationPath': 'Panel\\Sprint 7'
        },
        relations: []
      },
      {
        id: 102,
        fields: {
          'System.Title': 'Colour the work cards',
          'System.Description': '<p>Colour <strong>cards</strong> &amp; status.</p>',
          'System.WorkItemType': 'Task',
          'System.State': 'Done',
          'System.AssignedTo': { id: 'user-1', displayName: 'Panel User' },
          'System.IterationPath': 'Panel\\Sprint 7'
        },
        relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/org/_apis/wit/workItems/101' }]
      },
      {
        id: 103,
        fields: {
          'System.Title': 'Unrelated task',
          'System.WorkItemType': 'Task',
          'System.State': 'Active',
          'System.AssignedTo': { id: 'user-1', displayName: 'Panel User' },
          'System.IterationPath': 'Panel\\Sprint 6'
        },
        relations: []
      }
    ] });
    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await server.handle('work-items', {
    query: { organization: 'org', project: 'project-1' },
    options: {},
    oauth: { getAccessToken: async () => ({ accessToken: 'test-token' }) }
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.workItemContextVersion, 1);
  assert.strictEqual(result.currentIteration, 'Panel\\Sprint 7');
  assert.strictEqual(result.currentIterationSource, 'team');
  assert.strictEqual(result.currentUser, 'Panel User');
  assert.strictEqual(result.meFilterAvailable, true);
  assert.strictEqual(result.currentIterationFilterAvailable, true);
  assert.strictEqual(result.workItems.find(item => item.id === 102).parentId, 101);
  assert.strictEqual(result.workItems.find(item => item.id === 102).isAssignedToMe, true);
  assert.strictEqual(result.workItems.find(item => item.id === 102).isCurrentIteration, true);
  assert.strictEqual(result.workItems.find(item => item.id === 102).description, 'Colour cards & status.');
  assert.strictEqual(result.workItems.find(item => item.id === 103).isCurrentIteration, false);
  assert(appSource.includes('data-external-url'), 'work-item links should use the validated external-link handler');
  assert(!/<a [^>]*target="_blank"/.test(appSource), 'external links should route through openExternal, not raw target=_blank anchors');
  console.log('azure-devops tests passed');
}

run().finally(() => server._test.reset()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
