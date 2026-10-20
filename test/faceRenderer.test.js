'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../app/face/renderer');

function harness(face) {
  let now = 0, sequence = 0;
  const pending = new Map(), draws = [], fills = [];
  let path = [];
  const ctx = new Proxy({}, {
    get(target, key) { return target[key] || ((...args) => {
      draws.push([key, ...args]);
      if (key === 'beginPath') path = [];
      else if (key === 'fill') fills.push({ color: target.fillStyle, path: path.slice() });
      else if (['arc', 'roundRect', 'moveTo', 'lineTo', 'quadraticCurveTo', 'closePath'].includes(key)) path.push([key, ...args]);
    }); },
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
  return { renderer, pending, draws, fills, canvas, tick };
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
  for (const style of ['oled', 'cartoon', 'kawaii', 'crt', 'sprite']) {
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

// Assert rendered geometry, so a blink/lid or mouth-animation regression is observable.
test('cartoon persona keeps open circular eyes and a fixed grille through every emotion, blink and sleep', () => {
  const h = harness({ style: 'cartoon', dozeAfterSeconds: 0 });
  h.renderer.start();
  let grille;
  const check = () => {
    const mouth = h.fills.find(f => f.path[0]?.join() === 'moveTo,-31,25');
    assert.ok(mouth, 'fixed grin is drawn');
    if (!grille) grille = mouth.path;
    assert.deepEqual(mouth.path, grille, 'grin geometry never changes');
    const whites = h.fills.filter(f => f.path[0]?.[0] === 'arc' && f.path[0][3] === 14.5);
    assert.equal(whites.length, 2, 'both eyes remain fully open and circular');
    assert.ok(whites.every(f => f.color === '#fffaf1'));
    const head = h.fills.find(f => f.color === '#f5c49f');
    const coords = head.path.flatMap(op => op.slice(1)).filter(Number.isFinite);
    assert.ok(coords.includes(-59) && coords.includes(58), 'tall shell retains forehead and chin bounds');
    assert.ok(!coords.some(n => Math.abs(n) > 59), 'shell stays narrower than its 117-unit height');
    h.fills.length = 0;
    return mouth.color;
  };
  h.fills.length = 0;
  for (const emotion of ['neutral', 'happy', 'sad', 'angry', 'surprised', 'thinking', 'sleepy']) {
    h.renderer.setEmotion(emotion); h.tick(34); check();
  }
  for (const status of ['thinking', 'approval', 'error', 'idle']) {
    h.renderer.setState(status); h.tick(34); check();
  }
  h.tick(3000); check(); h.tick(90); check(); // Mid-blink on other face styles.
  h.renderer.setState('speaking'); h.renderer.setLevel(1); h.tick(34);
  assert.equal(check(), '#7cfc3a', 'speech illuminates the fixed grin green');
  h.renderer.setLevel(0); for (let i = 0; i < 30; i++) h.tick(34);
  // Keep only the last frame's fill operations for this assertion.
  h.fills.length = 0; h.tick(34);
  assert.equal(check(), '#fffaf1', 'silence switches the mouth light off');
  h.renderer.setState('sleepy'); h.tick(34); check();
  assert.equal(h.pending.size, 0, 'fixed open eyes do not prevent idle suspension');
  h.renderer.destroy();
});