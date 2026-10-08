'use strict';
// owuivoice-session: the Open WebUI adapter must satisfy the FULL voicepanel-host contract
// (the host calls mode()/validModel()/etc unguarded — a missing method throws at runtime), stream
// turns in the assistant-start → deltas → assistant-final → turn-complete order, keep capped
// multi-turn history, map errors to Auth-tab wordings, and treat truncation as a notice.
// Fake owuiClient (the transport has its own wire tests in owuiClient.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOwuiVoiceAdapter } = require('../app/owuivoice-session');
const { normalizeOwuiUrl } = require('../app/owuiClient');

// Controllable fake transport: streamChat records the request and exposes the handlers so a test
// drives the stream by hand; listModels resolves what the test configured.
function makeAdapter(cfg, opts) {
  opts = opts || {};
  const streams = [];   // [{ url, body, apiKey, h, destroyed }]
  const client = {
    normalizeOwuiUrl,
    // default: an empty list, answered on the next microtask (a turn waits for it: it says which models have tools)
    listModelInfo: () => {
      if (opts.modelsNever) return new Promise(() => {});
      const list = opts.modelInfo || (opts.models || []).map(id => ({ id, toolIds: [], skillIds: [] }));
      return (opts.modelsLater || Promise.resolve()).then(() => list);
    },
    streamChat: (url, body, apiKey, timeoutMs, h) => {
      const rec = { url, body, apiKey, h, destroyed: false };
      streams.push(rec);
      return { destroy() { rec.destroyed = true; } };
    },
  };
  const toolRuns = [];   // [{ opts, resolve, reject, cancelled }]
  client.runToolChat = o => {
    const rec = { opts: o, cancelled: false };
    rec.promise = new Promise((res, rej) => { rec.resolve = res; rec.reject = rej; });
    toolRuns.push(rec);
    return { promise: rec.promise, cancel() { rec.cancelled = true; const e = new Error('cancelled'); e.cancelled = true; rec.reject(e); } };
  };
  const adapter = createOwuiVoiceAdapter({ resolveOwui: () => cfg, log: () => {}, client });
  const events = [];
  for (const ev of ['assistant-start', 'assistant-delta', 'assistant-final', 'turn-complete', 'model', 'models-changed', 'notice', 'error']) {
    adapter.on(ev, payload => events.push({ ev, payload }));
  }
  return { adapter, streams, events, toolRuns };
}
const CFG = { url: 'http://box:3000', apiKey: 'sk-1', model: 'llama3' };
const tick = () => new Promise(r => setImmediate(r));

test('contract completeness: every host-called method exists and is callable pre-start', () => {
  const { adapter } = makeAdapter(CFG);
  // voicepanel-host calls these without guards (only listModes/listModels/handleHookRequest are guarded)
  for (const m of ['start', 'stop', 'sendTurn', 'isRunning', 'sessionId', 'projectDir', 'interrupt',
    'setMode', 'mode', 'listModes', 'setModel', 'currentModel', 'validModel', 'decideApproval', 'cancelApprovals', 'on', 'off']) {
    assert.equal(typeof adapter[m], 'function', m + ' must exist');
  }
  assert.equal(adapter.isRunning(), false);
  assert.equal(adapter.sessionId(), null);
  assert.equal(adapter.projectDir(), '');           // no working directory, ever
  assert.equal(adapter.mode(), '');
  assert.deepEqual(adapter.listModes(), []);        // hides the Mode button
  assert.equal(adapter.setMode('anything'), false);
  assert.equal(adapter.decideApproval('1', 'allow'), false);
  assert.equal(adapter.supportsAlwaysApproval, false);
  adapter.cancelApprovals('quitting');              // must not throw
  assert.equal(adapter.sendTurn('hi'), false);      // not running yet
  assert.equal(adapter.interrupt(), false);
});

test('start refuses without a configured URL and says where to fix it', () => {
  const { adapter, events } = makeAdapter({ url: '', apiKey: '', model: '' });
  assert.equal(adapter.start({}), false);
  assert.equal(adapter.isRunning(), false);
  const err = events.find(e => e.ev === 'error');
  assert.match(err.payload.message, /not configured.*Auth tab/);
});

test('model list loads async after start; validModel is permissive until then', async () => {
  const { adapter, events } = makeAdapter(CFG, { models: ['llama3', 'phi4'] });
  assert.equal(adapter.validModel('anything-goes'), true);    // list not loaded yet
  assert.equal(adapter.start({ model: '' }), true);
  assert.ok(adapter.sessionId());
  await tick(); await tick();
  assert.ok(events.some(e => e.ev === 'models-changed'));
  assert.equal(adapter.validModel('phi4'), true);
  assert.equal(adapter.validModel('not-a-model'), false);
  assert.equal(adapter.validModel(''), true);                 // '' = Auth-tab default, always valid
  const list = adapter.listModels();
  assert.equal(list[0].id, '');                               // default entry first
  assert.match(list[0].label, /llama3/);                      // names the Auth-tab default
  assert.deepEqual(list.slice(1).map(m => m.id), ['llama3', 'phi4']);
  assert.equal(adapter.setModel('phi4'), true);
  assert.equal(adapter.currentModel(), 'phi4');
  assert.equal(adapter.setModel('bogus'), false);
  assert.equal(adapter.currentModel(), 'phi4');
});

test('turn flow: assistant-start → deltas → assistant-final → turn-complete, history grows both roles', async () => {
  const { adapter, streams, events } = makeAdapter(CFG);
  adapter.start({});
  await tick();
  assert.equal(adapter.sendTurn('hello'), true);
  assert.equal(adapter.sendTurn('too soon'), false);          // one turn in flight at a time
  const s1 = streams[0];
  assert.equal(s1.url, 'http://box:3000/api/chat/completions');
  assert.equal(s1.apiKey, 'sk-1');
  assert.equal(s1.body.model, 'llama3');                      // Auth-tab default (no pick)
  assert.equal(s1.body.stream, true);
  assert.deepEqual(s1.body.messages, [{ role: 'user', content: 'hello' }]);
  s1.h.onDelta('Hi '); s1.h.onDelta('there');
  s1.h.onDone({ finishReason: 'stop' });
  const turnEvents = events.filter(e => e.ev !== 'models-changed');
  assert.deepEqual(turnEvents.map(e => e.ev), ['assistant-start', 'assistant-delta', 'assistant-delta', 'assistant-final', 'turn-complete']);
  assert.equal(turnEvents[3].payload.text, 'Hi there');
  assert.deepEqual(turnEvents[4].payload, { text: 'Hi there', error: null });
  // second turn carries the whole conversation
  adapter.sendTurn('and again');
  assert.deepEqual(streams[1].body.messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'Hi there' },
    { role: 'user', content: 'and again' },
  ]);
});

test('history caps at 40 messages', async () => {
  const { adapter, streams } = makeAdapter(CFG);
  adapter.start({});
  await tick();
  for (let i = 0; i < 30; i++) {
    adapter.sendTurn('turn ' + i);
    const s = streams[streams.length - 1];
    s.h.onDelta('r' + i);
    s.h.onDone({ finishReason: 'stop' });
  }
  const last = streams[streams.length - 1];
  assert.ok(last.body.messages.length <= 40, 'got ' + last.body.messages.length);
  assert.equal(last.body.messages[last.body.messages.length - 1].content, 'turn 29');   // newest kept, oldest dropped
});

test('401 maps to the Auth-tab wording and the failed user turn is not left in history', async () => {
  const { adapter, streams, events } = makeAdapter(CFG);
  adapter.start({});
  await tick();
  adapter.sendTurn('hello');
  const e401 = new Error('HTTP 401: unauthorized'); e401.statusCode = 401;
  streams[0].h.onError(e401);
  const done = events.find(e => e.ev === 'turn-complete');
  assert.match(done.payload.error, /rejected the API key.*check the key on the Auth tab/);
  adapter.sendTurn('retry');
  assert.deepEqual(streams[1].body.messages, [{ role: 'user', content: 'retry' }]);   // no doubled 'hello'
});

test('connection failure asks whether the server is running', async () => {
  const { adapter, streams, events } = makeAdapter(CFG);
  adapter.start({});
  await tick();
  adapter.sendTurn('hello');
  streams[0].h.onError(new Error('connect ECONNREFUSED'));
  const done = events.find(e => e.ev === 'turn-complete');
  assert.match(done.payload.error, /is Open WebUI running\?/);
});

test('truncation is a notice, not an error — the partial reply stays', async () => {
  const { adapter, streams, events } = makeAdapter(CFG);
  adapter.start({});
  await tick();
  adapter.sendTurn('write a novel');
  streams[0].h.onDelta('Chapter 1');
  streams[0].h.onDone({ finishReason: 'length' });
  const notice = events.find(e => e.ev === 'notice');
  assert.match(notice.payload.text, /truncated.*context limit/i);
  const done = events.find(e => e.ev === 'turn-complete');
  assert.deepEqual(done.payload, { text: 'Chapter 1', error: null });
});

test('interrupt destroys the stream and settles the turn with the partial text', async () => {
  const { adapter, streams, events } = makeAdapter(CFG);
  adapter.start({});
  await tick();
  adapter.sendTurn('go');
  streams[0].h.onDelta('part');
  assert.equal(adapter.interrupt(), true);
  assert.equal(streams[0].destroyed, true);
  const done = events.find(e => e.ev === 'turn-complete');
  assert.deepEqual(done.payload, { text: 'part', error: null });
  assert.equal(adapter.sendTurn('next'), true);               // adapter is free again
  assert.deepEqual(streams[1].body.messages.slice(-2), [
    { role: 'assistant', content: 'part' },                   // partial kept as context
    { role: 'user', content: 'next' },
  ]);
});

test('no model anywhere: the turn is accepted but fails with a wording that names the fix', async () => {
  const { adapter, events } = makeAdapter({ url: 'http://box:3000', apiKey: '', model: '' });
  adapter.start({});
  await tick();
  assert.equal(adapter.sendTurn('hi'), true);
  await tick();
  const done = events.find(e => e.ev === 'turn-complete');
  assert.match(done.payload.error, /no Open WebUI model set/);
});

test('stop clears the session; a fresh start is a fresh conversation', async () => {
  const { adapter, streams } = makeAdapter(CFG);
  adapter.start({});
  await tick();
  adapter.sendTurn('hello');
  streams[0].h.onDelta('x');
  adapter.stop();
  assert.equal(streams[0].destroyed, true);
  assert.equal(adapter.isRunning(), false);
  assert.equal(adapter.sessionId(), null);
  adapter.start({});
  await tick();
  adapter.sendTurn('new world');
  assert.deepEqual(streams[1].body.messages, [{ role: 'user', content: 'new world' }]);
});

const TOOLED = [
  { id: 'basis-admin', toolIds: ['server:mcp:6', 'server:mcp:4'], skillIds: ['term-tasks'] },
  { id: 'llama3', toolIds: [], skillIds: [] },
];

test('a model with tools attached runs through Open WebUI tool calling, answer arriving whole', async () => {
  const { adapter, streams, toolRuns, events } = makeAdapter(CFG, { modelInfo: TOOLED });
  adapter.start({ model: 'basis-admin', profilePrompt: 'Be brief.' });
  await tick();
  assert.equal(adapter.sendTurn('who is employee 10448?'), true);
  assert.equal(adapter.sendTurn('too soon'), false);
  assert.equal(streams.length, 0);                            // no plain stream for a tool model
  const run = toolRuns[0];
  assert.equal(run.opts.origin, 'http://box:3000');
  assert.equal(run.opts.apiKey, 'sk-1');
  assert.equal(run.opts.model, 'basis-admin');
  assert.deepEqual(run.opts.toolIds, ['server:mcp:6', 'server:mcp:4']);
  assert.deepEqual(run.opts.skillIds, ['term-tasks']);
  assert.deepEqual(run.opts.messages, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'who is employee 10448?' }]);
  run.resolve({ text: '<details type="tool_calls" done="true"><summary>Tool</summary>{"sql":"x"}</details>\nEmployee 10448 is Dana Ruiz.' });
  await tick();
  const turnEvents = events.filter(e => e.ev !== 'models-changed').map(e => e.ev);
  assert.deepEqual(turnEvents, ['assistant-start', 'assistant-delta', 'assistant-final', 'turn-complete']);
  assert.deepEqual(events.find(e => e.ev === 'turn-complete').payload, { text: 'Employee 10448 is Dana Ruiz.', error: null });
  adapter.sendTurn('thanks');
  assert.deepEqual(toolRuns[1].opts.messages.slice(-2), [
    { role: 'assistant', content: 'Employee 10448 is Dana Ruiz.' },
    { role: 'user', content: 'thanks' },
  ]);
});

test('the first turn of a fresh session waits for the model list before picking a path', async () => {
  let release;
  const later = new Promise(r => { release = r; });
  const { adapter, streams, toolRuns } = makeAdapter(CFG, { modelInfo: TOOLED, modelsLater: later });
  adapter.start({ model: 'basis-admin' });
  adapter.sendTurn('run the reconciliation');                 // sent before /api/models answered
  await tick();
  assert.equal(toolRuns.length + streams.length, 0);          // still waiting
  release();
  await tick(); await tick();
  assert.equal(toolRuns.length, 1);
  assert.equal(streams.length, 0);
});

test('a tool turn that fails names the step, and the user turn is not left in history', async () => {
  const { adapter, toolRuns, events } = makeAdapter(CFG, { modelInfo: TOOLED });
  adapter.start({ model: 'basis-admin' });
  await tick();
  adapter.sendTurn('hello');
  toolRuns[0].reject(new Error('Open WebUI: Failed to connect to MCP server 4'));
  await tick();
  assert.match(events.find(e => e.ev === 'turn-complete').payload.error, /Failed to connect to MCP server 4/);
  adapter.sendTurn('retry');
  assert.deepEqual(toolRuns[1].opts.messages, [{ role: 'user', content: 'retry' }]);
});

test('interrupting a tool turn cancels it on the server and frees the adapter', async () => {
  const { adapter, toolRuns, events } = makeAdapter(CFG, { modelInfo: TOOLED });
  adapter.start({ model: 'basis-admin' });
  await tick();
  adapter.sendTurn('long job');
  assert.equal(adapter.interrupt(), true);
  assert.equal(toolRuns[0].cancelled, true);
  await tick();
  const done = events.filter(e => e.ev === 'turn-complete');
  assert.equal(done.length, 1);                               // the cancellation is not a second settle
  assert.deepEqual(done[0].payload, { text: null, error: null });
  assert.equal(adapter.sendTurn('next'), true);
});

test('a model without tools that writes a tool call as text: markup never shown or spoken, a notice says why', async () => {
  const { adapter, streams, events } = makeAdapter(CFG, { modelInfo: TOOLED });
  adapter.start({ model: 'llama3' });
  await tick();
  adapter.sendTurn('compare supervisors');
  const s1 = streams[0];
  for (const d of ['Let me run the full reconciliation now. <tool', '_call>\n<function=execute_tool>\n<parameter=arguments>\n{"sql": "SELECT 1"}\n</parameter>\n',
    '<parameter=tool_name>\ntitan_query\n</parameter>\n</function>\n</tool_call>', ' Done']) s1.h.onDelta(d);
  s1.h.onDone({ finishReason: 'stop' });
  const shown = events.filter(e => e.ev === 'assistant-delta').map(e => e.payload.text).join('');
  assert.equal(shown, 'Let me run the full reconciliation now.  Done');
  assert.doesNotMatch(shown, /tool_call|parameter|titan_query/);
  const notice = events.find(e => e.ev === 'notice');
  assert.match(notice.payload.text, /llama3 tried to use the tool titan_query, but no tools are attached to it in Open WebUI/);
});

test('ordinary angle brackets and a marker-looking prefix that is not one pass through', async () => {
  const { adapter, streams, events } = makeAdapter(CFG, { modelInfo: TOOLED });
  adapter.start({ model: 'llama3' });
  await tick();
  adapter.sendTurn('math');
  for (const d of ['if a < b and <to', 'ols> are listed, use <para', 'graph> tags']) streams[0].h.onDelta(d);
  streams[0].h.onDone({ finishReason: 'stop' });
  const shown = events.filter(e => e.ev === 'assistant-delta').map(e => e.payload.text).join('');
  assert.equal(shown, 'if a < b and <tools> are listed, use <paragraph> tags');
  assert.equal(events.some(e => e.ev === 'notice'), false);
});

test('if the model list never loads, a turn still goes out after a short wait, and a stray tool call is explained', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { adapter, streams, events } = makeAdapter(CFG, { modelsNever: true });
  adapter.start({ model: 'basis-admin' });
  adapter.sendTurn('look it up');
  await tick();
  assert.equal(streams.length, 0);
  t.mock.timers.tick(3000);
  await tick(); await tick();
  assert.equal(streams.length, 1);                            // fell back to the plain stream
  streams[0].h.onDelta('Checking. <tool_call>{"name": "titan_query", "arguments": {}}</tool_call>');
  streams[0].h.onDone({ finishReason: 'stop' });
  assert.match(events.find(e => e.ev === 'notice').payload.text, /titan_query.*couldn't load Open WebUI's model list/);
});
