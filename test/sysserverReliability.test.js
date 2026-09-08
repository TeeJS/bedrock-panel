'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const sysserver = require('../app/sysserver');

function openSse(port, route) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: route,
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    }, res => {
      res.once('data', () => resolve({ req, res }));
    });
    req.on('error', reject);
  });
}

function responseClosed(res, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSE response stayed open')), timeoutMs);
    const done = () => { clearTimeout(timer); resolve(); };
    res.once('end', done);
    res.once('close', done);
    res.once('aborted', done);
  });
}

test.afterEach(() => sysserver.stop());

test('stop closes every built-in SSE stream and shuts down cached app servers', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock Panel-sysserver-'));
  const serverFile = path.join(root, 'server.js');
  const marker = path.join(root, 'shutdown.txt');
  fs.writeFileSync(serverFile,
    "'use strict';\nconst fs = require('node:fs');\n"
    + `exports.handle = async () => ({ ok: true });\nexports._shutdown = () => fs.writeFileSync(${JSON.stringify(marker)}, 'done');\n`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const obsApp = new EventEmitter();
  obsApp.getSnapshot = () => ({ connection: 'connected' });
  const port = await sysserver.start({
    obsApp,
    appFolders: { fixture: { root, server: serverFile, autoStart: true } },
  });
  const lucid = await openSse(port, '/lucidtype-events');
  const obs = await openSse(port, '/api/obs/events');
  t.after(() => { lucid.req.destroy(); obs.req.destroy(); });
  const lucidClosed = responseClosed(lucid.res);
  const obsClosed = responseClosed(obs.res);

  sysserver.stop();

  await Promise.all([lucidClosed, obsClosed]);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'done');
  assert.equal(obsApp.listenerCount('update'), 0);
});

test('a failed listen resets the singleton so a later start can succeed', async () => {
  class FailedServer extends EventEmitter {
    address() { return null; }
    close() {}
    listen() {
      const error = Object.assign(new Error('bind denied'), { code: 'EACCES' });
      queueMicrotask(() => this.emit('error', error));
    }
  }

  const discordApp = new EventEmitter();
  discordApp.startCalls = 0;
  discordApp.stopCalls = 0;
  discordApp.start = () => { discordApp.startCalls += 1; };
  discordApp.stop = () => { discordApp.stopCalls += 1; };
  discordApp.getSnapshot = () => ({});

  await assert.rejects(
    sysserver.start({ createServer: () => new FailedServer(), discordApp }),
    error => error && error.code === 'EACCES',
  );
  assert.equal(discordApp.startCalls, 1);
  assert.equal(discordApp.stopCalls, 1);
  assert.equal(discordApp.listenerCount('update'), 0);
  const port = await sysserver.start({});
  assert.ok(port > 0);
});

test('concurrent starts share one in-flight bind', async () => {
  const first = sysserver.start({});
  const second = sysserver.start({});

  assert.strictEqual(second, first);
  const [firstPort, secondPort] = await Promise.all([first, second]);
  assert.equal(secondPort, firstPort);
});

test('handler failures emit sanitized route diagnostics while preserving the 500 response', async () => {
  const diagnostics = [];
  const port = await sysserver.start({
    onDiagnostic: event => diagnostics.push(event),
    getDeviceDiagnostics() { throw new TypeError('secret-token-should-not-be-reported'); },
  });

  const response = await fetch(`http://127.0.0.1:${port}/device-diagnostics?token=do-not-log`, {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(response.status, 500);
  assert.deepEqual(diagnostics, [{
    type: 'request-error',
    method: 'GET',
    route: '/device-diagnostics',
    errorType: 'TypeError',
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-token|do-not-log/);
});

test('preferred-port fallback emits an explicit diagnostic', async t => {
  const blocker = http.createServer(() => {});
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const preferredPort = blocker.address().port;
  const diagnostics = [];

  const actualPort = await sysserver.start({
    preferredPort,
    onDiagnostic: event => diagnostics.push(event),
  });

  assert.notEqual(actualPort, preferredPort);
  assert.deepEqual(diagnostics, [{
    type: 'port-fallback',
    preferredPort,
    reason: 'EADDRINUSE',
  }]);
});
