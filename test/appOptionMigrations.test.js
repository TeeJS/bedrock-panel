'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { migrateAppOptions } = require('../app/appOptionMigrations');

function aiUsageOptions(options) {
  const config = {
    grids: [{ id: 'usage', kind: 'app', app: 'ai-usage', options: Object.assign({}, options) }],
  };
  migrateAppOptions(config);
  return config.grids[0].options;
}

test('AI Usage migrates the legacy 1,500 allowance to the saved AI-credit option', () => {
  assert.deepEqual(aiUsageOptions({ copilotIncluded: '1500' }), { copilotCreditsIncluded: '1500' });
});

test('AI Usage retires legacy Business and Enterprise allowances without a misleading gauge', () => {
  assert.deepEqual(aiUsageOptions({ copilotIncluded: '300' }), { copilotCreditsIncluded: '0' });
  assert.deepEqual(aiUsageOptions({ copilotIncluded: '1000' }), { copilotCreditsIncluded: '0' });
});

test('AI Usage keeps an explicitly saved AI-credit subscription over the legacy field', () => {
  assert.deepEqual(aiUsageOptions({ copilotIncluded: '300', copilotCreditsIncluded: '7000' }), {
    copilotCreditsIncluded: '7000',
  });
});

test('app option migration leaves other app pages unchanged', () => {
  const config = { grids: [{ kind: 'app', app: 'other', options: { copilotIncluded: '300' } }] };
  migrateAppOptions(config);
  assert.deepEqual(config.grids[0].options, { copilotIncluded: '300' });
});

test('a Claude AI Voice page saved with Haiku goes back to the account default; other picks and backends stay', () => {
  const config = { grids: [
    { id: 'a', kind: 'app', app: 'ai-voice', options: { modelPick: 'haiku' } },                     // backend defaults to claude
    { id: 'b', kind: 'app', app: 'ai-voice', options: { backend: 'claude', modelPick: 'sonnet' } },
    { id: 'c', kind: 'app', app: 'ai-voice', options: { backend: 'copilot', modelPick: 'haiku' } },  // not the Claude CLI's alias there
  ] };
  migrateAppOptions(config);
  assert.deepEqual(config.grids.map(g => g.options.modelPick), ['', 'sonnet', 'haiku']);
});
