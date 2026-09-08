'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const server = require('./server');

const SERVICE = {
  id: 'angular-ui',
  name: 'Angular UI',
  port: 4200,
  protocol: 'http',
  host: 'localhost',
  path: '',
  expectedProcess: 'node.exe',
  projectFolder: '',
};

function context(body, extra) {
  return Object.assign({
    appId: 'dev-services',
    body: Buffer.from(JSON.stringify(body)),
    host: { openExternal: async () => true },
  }, extra || {});
}

function inspector(ownersRef) {
  return {
    async inspect(ports) {
      return new Map(ports.map(port => [port, ownersRef.value.map(owner => Object.assign({}, owner))]));
    },
    close() {},
  };
}

test.afterEach(() => server._test.reset());

test('shared settings migrate once, persist editor changes, and drive panel status', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-panel-dev-services-'));
  const settingsFile = path.join(directory, 'settings.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  server._test.setDependencies({
    platform: 'linux',
    settingsFile: () => settingsFile,
    probe: async (host, port) => ({ listening: host === 'localhost' && port === 4200 }),
    inspector: inspector({ value: [] }),
    now: () => 1234,
  });

  const migrated = await server.handle('settings', context({
    fallback: { refreshSeconds: 30, services: [SERVICE] },
  }));
  assert.equal(migrated.ok, true);
  assert.equal(migrated.settings.refreshSeconds, 30);
  assert.equal(migrated.settings.services[0].id, SERVICE.id);
  assert.equal(fs.existsSync(settingsFile), true);

  const api = Object.assign({}, SERVICE, { id: 'api', name: 'API', port: 5000, expectedProcess: '' });
  const saved = await server.handle('save-settings', context({
    settings: { refreshSeconds: 60, services: [api] },
  }));
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.services[0].name, 'API');

  const status = await server.handle('status', context({
    useStoredSettings: true,
    fallback: { refreshSeconds: 10, services: [SERVICE] },
  }));
  assert.equal(status.ok, true);
  assert.equal(status.settings.refreshSeconds, 60);
  assert.equal(status.services[0].id, 'api');
  assert.equal(status.services[0].state, 'stopped');
});

test('shared settings reject unsafe values without replacing the last valid file', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-panel-dev-services-'));
  const settingsFile = path.join(directory, 'settings.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  server._test.setDependencies({ settingsFile: () => settingsFile });

  const valid = { refreshSeconds: 15, services: [SERVICE] };
  assert.equal((await server.handle('save-settings', context({ settings: valid }))).ok, true);
  const before = fs.readFileSync(settingsFile, 'utf8');
  const aggressive = await server.handle('save-settings', context({
    settings: { refreshSeconds: 1, services: [SERVICE] },
  }));
  assert.equal(aggressive.ok, false);
  assert.match(aggressive.error, /Refresh interval/);
  const badPort = await server.handle('save-settings', context({
    settings: { refreshSeconds: 15, services: [Object.assign({}, SERVICE, { port: 70000 })] },
  }));
  assert.equal(badPort.ok, false);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), before);
});

test('status maps a verified matching owner and issues an opaque stop observation', async () => {
  const owners = { value: [{ pid: 424242, processName: 'node', executablePath: 'C:\\Program Files\\nodejs\\node.exe' }] };
  server._test.setDependencies({
    platform: 'win32',
    probe: async () => ({ listening: true }),
    inspector: inspector(owners),
    now: () => 1000,
  });
  const result = await server.handle('status', context({ services: [SERVICE] }));
  assert.equal(result.ok, true);
  assert.equal(result.services[0].state, 'running');
  assert.equal(result.services[0].pid, 424242);
  assert.equal(result.services[0].processName, 'node');
  assert.equal(result.services[0].canStop, true);
  assert.match(result.services[0].observationToken, /^[A-Za-z0-9_-]{20,}$/);
});

test('expected-process mismatch is explicit and cannot produce a stop token', async () => {
  const owners = { value: [{ pid: 424242, processName: 'python' }] };
  server._test.setDependencies({
    platform: 'win32',
    probe: async () => ({ listening: true }),
    inspector: inspector(owners),
  });
  const result = await server.handle('status', context({ services: [SERVICE] }));
  assert.equal(result.services[0].state, 'unexpected');
  assert.equal(result.services[0].canStop, false);
  assert.equal(result.services[0].observationToken, '');
  assert.match(result.services[0].detail, /Expected node\.exe, found python/);
});

test('stop revalidates the exact port owner before terminating it', async () => {
  const owners = { value: [{ pid: 424242, processName: 'node' }] };
  const killed = [];
  server._test.setDependencies({
    platform: 'win32',
    probe: async () => ({ listening: true }),
    inspector: inspector(owners),
    kill: (pid, signal) => killed.push({ pid, signal }),
    now: () => 1000,
  });
  const status = await server.handle('status', context({ services: [SERVICE] }));
  const observed = status.services[0];
  const stopped = await server.handle('stop', context({
    serviceId: SERVICE.id,
    observationToken: observed.observationToken,
  }));
  assert.equal(stopped.ok, true);
  assert.deepEqual(killed, [{ pid: 424242, signal: 'SIGTERM' }]);
});

test('stop fails safely when port ownership changes after confirmation', async () => {
  const owners = { value: [{ pid: 424242, processName: 'node' }] };
  const killed = [];
  server._test.setDependencies({
    platform: 'win32',
    probe: async () => ({ listening: true }),
    inspector: inspector(owners),
    kill: pid => killed.push(pid),
    now: () => 1000,
  });
  const status = await server.handle('status', context({ services: [SERVICE] }));
  owners.value = [{ pid: 434343, processName: 'node' }];
  const result = await server.handle('stop', context({
    serviceId: SERVICE.id,
    observationToken: status.services[0].observationToken,
  }));
  assert.equal(result.ok, false);
  assert.match(result.error, /ownership changed/);
  assert.deepEqual(killed, []);
});

test('stop boundary rejects forged, cross-app, and reused observations', async () => {
  const owners = { value: [{ pid: 424242, processName: 'node' }] };
  const killed = [];
  server._test.setDependencies({
    platform: 'win32',
    probe: async () => ({ listening: true }),
    inspector: inspector(owners),
    kill: pid => killed.push(pid),
  });
  const forged = await server.handle('stop', context({ serviceId: SERVICE.id, observationToken: 'forged' }));
  assert.equal(forged.ok, false);
  const unauthorized = await server.handle('status', context({ services: [SERVICE] }, { appId: 'another-app' }));
  assert.deepEqual(unauthorized, { ok: false, error: 'unauthorized' });

  const status = await server.handle('status', context({ services: [SERVICE] }));
  const request = { serviceId: SERVICE.id, observationToken: status.services[0].observationToken };
  assert.equal((await server.handle('stop', context(request))).ok, true);
  assert.equal((await server.handle('stop', context(request))).ok, false);
  assert.deepEqual(killed, [424242]);
});

test('status rejects malformed and duplicate service input before probing', async () => {
  let probes = 0;
  server._test.setDependencies({ probe: async () => { probes += 1; return { listening: false }; } });
  const invalid = await server.handle('status', context({ services: [{ id: 'bad', name: 'Bad', port: 70000, protocol: 'http', host: 'localhost' }] }));
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /Port must be/);
  const duplicate = await server.handle('status', context({ services: [SERVICE, SERVICE] }));
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /unique/);
  assert.equal(probes, 0);
});

test('external navigation uses the trusted host and only accepts HTTP service URLs', async () => {
  const opened = [];
  const result = await server.handle('open', context({ service: SERVICE }, {
    host: { openExternal: async url => { opened.push(url); return true; } },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(opened, ['http://localhost:4200/']);

  const invalid = await server.handle('open', context({
    service: Object.assign({}, SERVICE, { protocol: 'file' }),
  }));
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /HTTP or HTTPS/);
});

test('copy and open-folder actions stay behind validated host-side operations', async () => {
  const copied = [];
  const openedFolders = [];
  server._test.setDependencies({
    copy: value => copied.push(value),
    openPath: async value => { openedFolders.push(value); return ''; },
  });
  const folder = path.resolve(__dirname);
  const service = Object.assign({}, SERVICE, { projectFolder: folder });
  assert.equal((await server.handle('copy', context({ service }))).ok, true);
  assert.deepEqual(copied, ['http://localhost:4200/']);
  assert.equal((await server.handle('open-folder', context({ service }))).ok, true);
  assert.deepEqual(openedFolders, [folder]);

  const relative = await server.handle('open-folder', context({
    service: Object.assign({}, SERVICE, { projectFolder: 'relative/project' }),
  }));
  assert.equal(relative.ok, false);
  assert.match(relative.error, /absolute project folder/);
});

test('a PID without a process name is shown but cannot be stopped', async () => {
  const owners = { value: [{ pid: 424242, processName: '' }] };
  server._test.setDependencies({
    platform: 'win32',
    probe: async () => ({ listening: true }),
    inspector: inspector(owners),
  });
  const service = Object.assign({}, SERVICE, { expectedProcess: '' });
  const result = await server.handle('status', context({ services: [service] }));
  assert.equal(result.services[0].state, 'running');
  assert.equal(result.services[0].pid, 424242);
  assert.equal(result.services[0].canStop, false);
  assert.equal(result.services[0].observationToken, '');
});

test('non-local services can be checked but never receive local stop authority', async () => {
  let inspectedPorts = null;
  server._test.setDependencies({
    platform: 'linux',
    probe: async () => ({ listening: true }),
    inspector: {
      async inspect(ports) { inspectedPorts = ports; return new Map(); },
      close() {},
    },
  });
  const remote = Object.assign({}, SERVICE, { host: 'devbox.local', expectedProcess: '' });
  const result = await server.handle('status', context({ services: [remote] }));
  assert.equal(result.services[0].state, 'running');
  assert.equal(result.services[0].canStop, false);
  assert.deepEqual(inspectedPorts, []);
});

test('Windows ownership lookups reuse one persistent helper process', async () => {
  let spawnCount = 0;
  let killCount = 0;
  const spawnImpl = () => {
    spawnCount += 1;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stdin = {
      write(line) {
        const request = JSON.parse(line);
        queueMicrotask(() => child.stdout.emit('data', JSON.stringify({
          id: request.id,
          ok: true,
          rows: request.ports.map(port => ({ port, pid: 424242, processName: 'node' })),
        }) + '\n'));
      },
      end() {},
    };
    child.kill = () => { killCount += 1; };
    return child;
  };
  const processInspector = new server._test.WindowsPowerShellInspector(spawnImpl);
  assert.equal((await processInspector.inspect([4200])).get(4200)[0].pid, 424242);
  assert.equal((await processInspector.inspect([5000])).get(5000)[0].processName, 'node');
  assert.equal(spawnCount, 1);
  processInspector.close();
  assert.equal(killCount, 1);
});
