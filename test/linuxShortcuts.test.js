'use strict';
// The Linux global-shortcut path: accelerator translation and the portal wrapper with an injected
// spawn. Nothing here talks to D-Bus, so it runs on any platform.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createLinuxShortcuts, toPortalTrigger, idFor, helperScript } = require('../app/linuxShortcuts');

test('Electron accelerators become portal triggers', () => {
  assert.equal(toPortalTrigger('Ctrl+Alt+S'), 'CTRL+ALT+s');
  assert.equal(toPortalTrigger('CommandOrControl+Shift+P'), 'CTRL+SHIFT+p');
  assert.equal(toPortalTrigger('Super+Space'), 'SUPER+Space', 'named keys keep their spelling');
  assert.equal(toPortalTrigger('F5'), 'F5', 'no modifier is still a trigger');
  assert.equal(toPortalTrigger('Ctrl+Ctrl+A'), 'CTRL+a', 'a repeated modifier collapses');
  assert.equal(toPortalTrigger('Ctrl+Alt'), null, 'modifiers alone are not a shortcut');
  assert.equal(toPortalTrigger(''), null);
  assert.equal(toPortalTrigger(null), null);
});

test('ids are stable, readable, and unique per registration', () => {
  assert.equal(idFor('Ctrl+Alt+S', 0), 'ctrl-alt-s-0');
  assert.equal(idFor('Ctrl+Alt+S', 1), 'ctrl-alt-s-1', 'the index keeps duplicates apart');
  assert.match(idFor('!!!', 0), /^shortcut-0$/, 'never produces an empty id');
});

function harness(extra) {
  const child = {
    writes: [], handlers: {},
    stdin: { destroyed: false, write(s) { this.writes.push(s); }, end() { this.destroyed = true; } },
    stdout: { on(ev, fn) { child.handlers['out:' + ev] = fn; } },
    stderr: { on(ev, fn) { child.handlers['err:' + ev] = fn; } },
    on(ev, fn) { child.handlers[ev] = fn; },
    kill() { child.killed = true; },
  };
  const logs = [];
  const spawned = [];
  const sc = createLinuxShortcuts(Object.assign({
    spawn: (...a) => { spawned.push(a); return child; },
    log: m => logs.push(m),
  }, extra));
  return { sc, child, logs, spawned };
}

test('the whole set is handed to the portal in one call, with triggers and descriptions', () => {
  const { sc, spawned } = harness();
  assert.equal(sc.register('Ctrl+Alt+S', () => {}), true);
  assert.equal(sc.register('Ctrl+Alt+W', () => {}), true);
  assert.equal(spawned.length, 0, 'register() alone must not reach the portal');
  sc.apply();
  assert.equal(spawned.length, 1, 'one session for the whole set');
  const payload = JSON.parse(spawned[0][1][1]);
  assert.deepEqual(payload.map(s => s.trigger), ['CTRL+ALT+s', 'CTRL+ALT+w']);
  assert.deepEqual(payload.map(s => s.id), ['ctrl-alt-s-0', 'ctrl-alt-w-1']);
  for (const s of payload) assert.ok(s.description, 'every shortcut needs a description for the settings UI');
});

test('an accelerator the portal cannot express is refused at register time', () => {
  const { sc, logs, spawned } = harness();
  assert.equal(sc.register('Ctrl+Alt', () => {}), false);
  sc.apply();
  assert.equal(spawned.length, 0, 'nothing to bind');
  assert.match(logs.join(' '), /cannot express "Ctrl\+Alt"/);
});

test('activation runs the callback registered for that id, and only that one', () => {
  const { sc, child } = harness();
  const fired = [];
  sc.register('Ctrl+Alt+S', () => fired.push('s'));
  sc.register('Ctrl+Alt+W', () => fired.push('w'));
  sc.apply();
  child.handlers['out:data']('ready {"ctrl-alt-s-0":"Ctrl+Alt+S","ctrl-alt-w-1":""}\n');
  child.handlers['out:data']('activated ctrl-alt-w-1\n');
  child.handlers['out:data']('activated ctrl-alt-s-0\n');
  child.handlers['out:data']('activated nobody\n');
  assert.deepEqual(fired, ['w', 's'], 'unknown ids are ignored, not thrown');
});

test('a partial stdout line is not acted on until it is complete', () => {
  const { sc, child } = harness();
  const fired = [];
  sc.register('Ctrl+Alt+S', () => fired.push('s'));
  sc.apply();
  child.handlers['out:data']('activa');
  assert.deepEqual(fired, []);
  child.handlers['out:data']('ted ctrl-alt-s-0\n');
  assert.deepEqual(fired, ['s']);
});

test('what the desktop actually bound is reported, so the editor need not imply the typed combo is live', () => {
  const { sc, child, logs } = harness();
  sc.register('Ctrl+Alt+S', () => {});
  sc.register('Ctrl+Alt+W', () => {});
  sc.apply();
  child.handlers['out:data']('ready {"ctrl-alt-s-0":"Meta+S","ctrl-alt-w-1":""}\n');
  assert.deepEqual(sc.triggers(), { 'Ctrl+Alt+S': 'Meta+S', 'Ctrl+Alt+W': '' },
    'the desktop may bind something else entirely, or nothing');
  assert.match(logs.join(' '), /bound 1 of 2/);
  assert.match(logs.join(' '), /assigned in the desktop's shortcut settings/);
  // A later rebind by the desktop updates the same report.
  child.handlers['out:data']('changed {"ctrl-alt-s-0":"Meta+S","ctrl-alt-w-1":"Ctrl+Alt+W"}\n');
  assert.deepEqual(sc.triggers(), { 'Ctrl+Alt+S': 'Meta+S', 'Ctrl+Alt+W': 'Ctrl+Alt+W' });
});

test('a missing portal or PyGObject fails once and stays failed', () => {
  for (const code of [2, 3, 4]) {
    const { sc, child, logs } = harness();
    sc.register('Ctrl+Alt+S', () => {});
    sc.apply();
    child.handlers.exit(code);
    assert.equal(sc.available(), false, 'exit ' + code + ' should be permanent');
    assert.match(logs.join(' '), /global shortcuts unavailable/);
  }
  const { sc, logs } = harness({ spawn: () => { throw new Error('spawn python3 ENOENT'); } });
  sc.register('Ctrl+Alt+S', () => {});
  assert.equal(sc.apply(), false);
  assert.equal(sc.available(), false);
  assert.match(logs.join(' '), /cannot start python3/);
});

test('unregisterAll ends the portal session and clears the set', () => {
  const { sc, child, spawned } = harness();
  sc.register('Ctrl+Alt+S', () => {});
  sc.apply();
  sc.unregisterAll();
  assert.equal(child.killed, true);
  assert.deepEqual(sc.triggers(), {});
  sc.apply();
  assert.equal(spawned.length, 1, 'nothing left to bind, so no second session');
});

test('the helper path reaches outside the asar, since python cannot open a file inside it', () => {
  // Asserted with path.join rather than a written-out path: these tests run on whatever machine the
  // suite runs on, and a path built by path.join is backslashed off Linux. The claim is about where
  // the helper lives, not about which character separates the parts of a path.
  const script = helperScript(path.join('/opt/app/resources/app.asar', 'app'));
  assert.ok(script.includes('app.asar.unpacked'), 'still inside the archive: ' + script);
  assert.ok(script.endsWith(path.join('app.asar.unpacked', 'app', 'linux', 'portal-shortcuts.py')), script);
});

test('main.js routes every shortcut through the shim, never Electron globalShortcut directly', () => {
  // Electron's globalShortcut registers successfully on Linux and never fires. Any call that slips
  // back into main.js is a hotkey that silently does nothing.
  const main = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
  const bare = main.match(/globalShortcut\.(register|unregisterAll|isRegistered)\(/g) || [];
  assert.deepEqual(bare, [], 'use the `shortcuts` shim instead');
  assert.match(main, /shortcuts\.apply\(\)/, 'the collected set has to be handed to the portal');
});
