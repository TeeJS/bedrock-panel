'use strict';
// owuiClient: URL normalization matrix, raw-http postJson/streamChat against a REAL local http
// server (auth header, query preserved, SSE reassembly across split chunks, [DONE], inactivity
// timeout), and defensive listModels parsing. No fakes on the wire — the transport is the point.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { normalizeOwuiUrl, postJson, streamChat, listModels, listModelInfo, runToolChat } = require('../app/owuiClient');

test('normalizeOwuiUrl: every pasted form derives the same /api endpoints from the origin', () => {
  const want = origin => ({ origin, chatUrl: origin + '/api/chat/completions', modelsUrl: origin + '/api/models' });
  assert.deepEqual(normalizeOwuiUrl('http://box:3000'), want('http://box:3000'));
  assert.deepEqual(normalizeOwuiUrl('http://box:3000/'), want('http://box:3000'));
  assert.deepEqual(normalizeOwuiUrl('https://owui.example.com'), want('https://owui.example.com'));
  assert.deepEqual(normalizeOwuiUrl('http://box:3000/v1'), want('http://box:3000'));                    // /v1 paths discarded
  assert.deepEqual(normalizeOwuiUrl('http://box:3000/api/chat/completions'), want('http://box:3000'));  // full path accepted
  assert.deepEqual(normalizeOwuiUrl('box:3000'), want('http://box:3000'));                              // bare host:port
  assert.deepEqual(normalizeOwuiUrl('192.168.1.25:3000'), want('http://192.168.1.25:3000'));
  assert.deepEqual(normalizeOwuiUrl('http:/box:3000'), want('http://box:3000'));                        // missing-slash typo heals
  assert.deepEqual(normalizeOwuiUrl('https:box:3000'), want('https://box:3000'));
  assert.deepEqual(normalizeOwuiUrl('  http://box:3000  '), want('http://box:3000'));
  assert.equal(normalizeOwuiUrl(''), null);
  assert.equal(normalizeOwuiUrl('   '), null);
  assert.equal(normalizeOwuiUrl(null), null);
  assert.equal(normalizeOwuiUrl('ftp://box:3000'), null);   // non-web scheme refused, not silently rewritten
});

// One tiny disposable server per test; handler sees (req, res, bodyText).
function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => handler(req, res, body));
    });
    srv.listen(0, '127.0.0.1', async () => {
      const base = 'http://127.0.0.1:' + srv.address().port;
      try { resolve(await fn(base)); }
      catch (e) { reject(e); }
      finally { srv.close(); }
    });
  });
}

test('postJson: JSON body, Bearer auth, query preserved, non-200 passes through', async () => {
  await withServer((req, res, body) => {
    if (req.url === '/api/chat/completions?probe=1') {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, 'Bearer sk-abc');
      assert.equal(req.headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(body), { model: 'm', stream: false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404); res.end('nope');
    }
  }, async base => {
    const r = await postJson(base + '/api/chat/completions?probe=1', { model: 'm', stream: false }, 'sk-abc', 5000);
    assert.deepEqual(r, { status: 200, text: '{"ok":true}' });
    const bad = await postJson(base + '/other', {}, 'sk-abc', 5000);
    assert.equal(bad.status, 404);
    assert.equal(bad.text, 'nope');
  });
});

test('postJson: no Authorization header when the key is empty; connection refused rejects', async () => {
  await withServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(200); res.end('{}');
  }, async base => {
    await postJson(base + '/x', {}, '', 5000);
  });
  await assert.rejects(postJson('http://127.0.0.1:1/x', {}, '', 5000));   // port 1: nothing listens
});

test('streamChat: SSE deltas reassemble across split chunks; [DONE] finishes with the last finish_reason', async () => {
  const frame = obj => 'data: ' + JSON.stringify(obj) + '\n\n';
  await withServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer k2');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const full = frame({ choices: [{ delta: { content: 'Hel' } }] })
      + frame({ choices: [{ delta: { content: 'lo world' } }] })
      + 'data: {"garbage\n\n'                                      // unparseable — skipped, not fatal
      + frame({ choices: [] })                                     // empty choices — skipped
      + frame({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      + 'data: [DONE]\n\n';
    // Split mid-frame to prove line buffering: byte 10 lands inside the first data: line.
    res.write(full.slice(0, 10));
    setTimeout(() => { res.write(full.slice(10)); res.end(); }, 20);
  }, base => new Promise((resolve, reject) => {
    const deltas = [];
    streamChat(base + '/api/chat/completions', { stream: true }, 'k2', 5000, {
      onDelta: t => deltas.push(t),
      onDone: ({ finishReason }) => {
        try {
          assert.equal(deltas.join(''), 'Hello world');
          assert.equal(finishReason, 'stop');
          resolve();
        } catch (e) { reject(e); }
      },
      onError: e => reject(new Error('unexpected error: ' + e.message)),
    });
  }));
});

test('streamChat: HTTP error carries statusCode; destroy() aborts silently', async () => {
  await withServer((req, res) => {
    if (req.url === '/err') { res.writeHead(401); res.end('{"detail":"bad key"}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');   // then hang — destroy() cuts it
  }, async base => {
    await new Promise((resolve, reject) => {
      streamChat(base + '/err', {}, 'k', 5000, {
        onDelta: () => reject(new Error('no deltas expected')),
        onDone: () => reject(new Error('must not complete')),
        onError: e => {
          try { assert.equal(e.statusCode, 401); assert.match(e.message, /bad key/); resolve(); }
          catch (e2) { reject(e2); }
        },
      });
    });
    await new Promise((resolve, reject) => {
      const s = streamChat(base + '/hang', {}, 'k', 5000, {
        onDelta: () => setImmediate(() => { s.destroy(); setTimeout(resolve, 50); }),   // no callbacks after destroy
        onDone: () => reject(new Error('destroyed stream must not call onDone')),
        onError: () => reject(new Error('destroyed stream must not call onError')),
      });
    });
  });
});

test('streamChat: server going silent trips the inactivity timeout', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // one delta, then silence forever
    res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
  }, base => new Promise((resolve, reject) => {
    streamChat(base + '/x', {}, '', 300, {
      onDone: () => reject(new Error('must not complete')),
      onError: e => {
        try { assert.match(e.message, /no response after/); resolve(); }
        catch (e2) { reject(e2); }
      },
    });
  }));
});

test('listModels: accepts {data}, {models}, and bare-array shapes; 401 throws with statusCode', async () => {
  const fake = body => async () => ({ ok: true, status: 200, json: async () => body });
  assert.deepEqual(await listModels('http://x/api/models', 'k', fake({ data: [{ id: 'llama3' }, { name: 'phi' }, 7] })), ['llama3', 'phi']);
  assert.deepEqual(await listModels('http://x/api/models', 'k', fake({ models: ['a', 'b'] })), ['a', 'b']);
  assert.deepEqual(await listModels('http://x/api/models', 'k', fake(['c'])), ['c']);
  assert.deepEqual(await listModels('http://x/api/models', 'k', fake({ weird: true })), []);
  await assert.rejects(
    listModels('http://x/api/models', 'bad', async () => ({ ok: false, status: 401 })),
    e => e.statusCode === 401,
  );
});

test('listModelInfo: reads the tools and skills attached to workspace models', async () => {
  const fake = body => async () => ({ ok: true, status: 200, json: async () => body });
  const list = await listModelInfo('http://x/api/models', 'k', fake({ data: [
    { id: 'basis-admin', info: { meta: { toolIds: ['server:mcp:6', 'server:mcp:4', 7], skillIds: ['term-tasks'] } } },
    { id: 'qwen3.8-27b', info: { meta: {} } },
    { id: 'gemma' },
    'plain',
  ] }));
  assert.deepEqual(list, [
    { id: 'basis-admin', toolIds: ['server:mcp:6', 'server:mcp:4'], skillIds: ['term-tasks'] },
    { id: 'qwen3.8-27b', toolIds: [], skillIds: [] },
    { id: 'gemma', toolIds: [], skillIds: [] },
    { id: 'plain', toolIds: [], skillIds: [] },
  ]);
});

// A small stand-in for Open WebUI's server-side tool-calling routes.
function fakeOwui(opts) {
  const o = opts || {};
  const seen = { completion: null, deleted: [], stopped: [], polls: 0 };
  let asstId = null, pollsLeft = o.polls == null ? 2 : o.polls;
  const handler = (req, res, body) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    assert.equal(req.headers.authorization, 'Bearer sk-tools');
    if (req.method === 'POST' && req.url === '/api/v1/chats/new') {
      const chat = JSON.parse(body).chat;
      asstId = chat.history.currentId;
      assert.equal(chat.history.messages[asstId].parentId !== undefined, true);
      return json(200, { id: 'chat-1' });
    }
    if (req.method === 'POST' && req.url === '/api/chat/completions') {
      seen.completion = JSON.parse(body);
      return json(200, { status: true, task_ids: ['t1'], chat_id: 'chat-1' });
    }
    if (req.method === 'GET' && req.url === '/api/tasks/chat/chat-1') {
      seen.polls++;
      return json(200, { task_ids: pollsLeft-- > 0 ? ['t1'] : [] });
    }
    if (req.method === 'GET' && req.url === '/api/v1/chats/chat-1') {
      return json(200, { id: 'chat-1', chat: { history: { messages: { [asstId]: o.message || { content: 'Dana Ruiz, supervisor M. Ito.', done: true } } } } });
    }
    if (req.method === 'POST' && req.url === '/api/tasks/chat/chat-1/stop') { seen.stopped.push(true); return json(200, {}); }
    if (req.method === 'DELETE' && req.url === '/api/v1/chats/chat-1') { seen.deleted.push(true); return json(200, true); }
    json(404, { detail: 'not found ' + req.method + ' ' + req.url });
  };
  return { handler, seen };
}
const settle = () => new Promise(r => setTimeout(r, 30));

test('runToolChat: creates a chat, starts the tool loop on it, waits for the task, reads the answer, deletes the chat', async () => {
  const f = fakeOwui();
  await withServer(f.handler, async base => {
    const job = runToolChat({ origin: base, apiKey: 'sk-tools', model: 'basis-admin', pollMs: 5,
      messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'who is 10448?' }],
      toolIds: ['server:mcp:6'], skillIds: ['term-tasks'] });
    assert.deepEqual(await job.promise, { text: 'Dana Ruiz, supervisor M. Ito.' });
    await settle();
  });
  const c = f.seen.completion;
  assert.equal(c.stream, true);                              // the native tool loop is streaming-only
  assert.equal(c.chat_id, 'chat-1');
  assert.ok(c.id && c.session_id);                           // the assistant message, and async start
  assert.deepEqual(c.tool_ids, ['server:mcp:6']);
  assert.deepEqual(c.skill_ids, ['term-tasks']);
  assert.equal('tools' in c, false);                         // a tools array would switch server-side tools off
  assert.deepEqual(c.messages.map(m => m.role), ['system', 'user']);
  assert.deepEqual(c.background_tasks, { title_generation: false, tags_generation: false, follow_up_generation: false });
  assert.equal(f.seen.polls, 3);
  assert.equal(f.seen.deleted.length, 1);
});

test('runToolChat: the server-side error stored on the message is what the caller gets', async () => {
  const f = fakeOwui({ polls: 0, message: { content: '', error: { content: "Failed to connect to MCP server '4'" } } });
  await withServer(f.handler, async base => {
    const job = runToolChat({ origin: base, apiKey: 'sk-tools', model: 'm', pollMs: 5, messages: [{ role: 'user', content: 'hi' }] });
    await assert.rejects(job.promise, /Open WebUI: Failed to connect to MCP server '4'/);
    await settle();
  });
  assert.equal(f.seen.deleted.length, 1);                    // cleaned up on failure too
});

test('runToolChat: cancel stops the server-side task and still deletes the chat', async () => {
  const f = fakeOwui({ polls: 1000 });
  await withServer(f.handler, async base => {
    const job = runToolChat({ origin: base, apiKey: 'sk-tools', model: 'm', pollMs: 20, messages: [{ role: 'user', content: 'hi' }] });
    await new Promise(r => setTimeout(r, 60));
    job.cancel();
    await assert.rejects(job.promise, e => e.cancelled === true);
    await settle();
  });
  assert.equal(f.seen.stopped.length, 1);
  assert.equal(f.seen.deleted.length, 1);
});

test('runToolChat: a refused chat creation reports its HTTP status', async () => {
  await withServer((req, res) => { res.writeHead(401); res.end('{"detail":"Not authenticated"}'); }, async base => {
    const job = runToolChat({ origin: base, apiKey: 'bad', model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    await assert.rejects(job.promise, e => e.statusCode === 401 && /create the Open WebUI chat/.test(e.message));
  });
});
