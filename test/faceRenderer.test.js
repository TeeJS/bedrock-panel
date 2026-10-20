'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../app/face/renderer');

function harness(face) {
  let now = 0, sequence = 0;
  const pending = new Map(), draws = [];
  const ctx = new Proxy({}, {
    get(target, key) { return target[key] || ((...args) => draws.push([key, ...args])); },
    set(target, key, value) { target[key] = value; return true; },
  });
  const canvas = { width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ width: 420, height: 450 }) };
  const environment = {
    performance: { now: () => now }, devicePixelRatio: 3,
    requestAnimationFrame(cb) { const id = ++sequence; pending.set(id, cb); return id; },
    cancelAnimationFrame(id) { pending.delete(id); },
  };
  const renderer = create(canvas, { environment, persona: { face: face || {} } });
  function tick(ms) { now += ms; const tasks = [...pending.values()]; pending.clear(); tasks.forEach(cb => cb(now)); }
  return { renderer, pending, draws, canvas, tick };
}

test('face starts lazily and stop/destroy cancel the pending frame', () => {
  const h = harness();
  assert.equal(h.pending.size, 0);
  h.renderer.start(); h.renderer.start();
  assert.equal(h.pending.size, 1);
  h.tick(34); assert.equal(h.pending.size, 1);
  h.renderer.stop(); assert.equal(h.pending.size, 0);
  h.renderer.start(); assert.equal(h.pending.size, 1);
  h.renderer.destroy(); assert.equal(h.pending.size, 0);
  h.renderer.start(); h.renderer.wake(); assert.equal(h.pending.size, 0);
});

test('dozing releases the frame loop until actual activity wakes it', () => {
  const h = harness({ dozeAfterSeconds: 1 });
  h.renderer.start(); h.tick(1100);
  assert.equal(h.pending.size, 0);
  h.renderer.wake(); assert.equal(h.pending.size, 1);
  h.tick(34); assert.equal(h.pending.size, 1);
  h.renderer.stop();
});

test('active speech prevents idle dozing and leaving speech closes the mouth', () => {
  const h = harness({ dozeAfterSeconds: 1 });
  h.renderer.setState('speaking'); h.renderer.setLevel(0.8); h.renderer.start();
  h.tick(1500); assert.equal(h.pending.size, 1);
  h.renderer.setState('idle'); h.tick(1100);
  assert.equal(h.pending.size, 0);
  h.renderer.destroy();
});

test('device pixel ratio is capped and all supported persona styles draw', () => {
  for (const style of ['oled', 'cartoon', 'kawaii']) {
    const h = harness({ style });
    assert.equal(h.canvas.width, 840); assert.equal(h.canvas.height, 900);
    h.renderer.setReducedMotion(true); h.renderer.start();
    for (const status of ['listening', 'thinking', 'speaking', 'approval', 'error', 'idle']) {
      h.renderer.setState(status); h.renderer.setLevel(0.4); h.tick(34);
    }
    assert.ok(h.draws.length > 20);
    h.renderer.destroy(); assert.equal(h.pending.size, 0);
  }
});
