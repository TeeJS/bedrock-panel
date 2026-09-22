'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const server = require('../community-apps/deck-host/server.js');
const MiniSocket = server._MiniSocket;
const MAX = server._MAX_WS_MESSAGE;

// A fake TCP socket: MiniSocket attaches 'data'/'close'/'error'/'end' and calls write/end/destroy.
function fakeSocket() {
  const s = new EventEmitter();
  s.written = [];
  s.destroyed = false;
  s.write = buf => { s.written.push(buf); return true; };
  s.end = () => {};
  s.destroy = () => { s.destroyed = true; };
  return s;
}

// Build one unmasked WebSocket frame with a 64-bit length header. `declaredLen` can lie about the
// payload size — the point of the oversize test is that the guard fires on the header alone.
function mkFrame(opcode, fin, declaredLen, payload) {
  const head = Buffer.alloc(10);
  head[0] = (fin ? 0x80 : 0) | opcode;
  head[1] = 127;   // 64-bit length follows
  head.writeBigUInt64BE(BigInt(declaredLen), 2);
  return payload ? Buffer.concat([head, payload]) : head;
}

test('an oversized declared frame length terminates the socket before buffering the payload', () => {
  const s = fakeSocket();
  const ws = new MiniSocket(s);
  let gotMessage = false;
  ws.on('message', () => { gotMessage = true; });
  s.emit('data', mkFrame(0x02, true, MAX + 1));   // header only, declaring a payload over the cap
  assert.equal(s.destroyed, true, 'socket destroyed on oversized declared length');
  assert.equal(ws.readyState, 3, 'socket marked closed');
  assert.equal(gotMessage, false, 'no message emitted');
});

test('a normal small binary message is still delivered intact', () => {
  const s = fakeSocket();
  const ws = new MiniSocket(s);
  const messages = [];
  ws.on('message', m => messages.push(m));
  const payload = Buffer.from('hello deck');
  s.emit('data', mkFrame(0x02, true, payload.length, payload));
  assert.equal(s.destroyed, false, 'a legitimate frame is not terminated');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].toString(), 'hello deck');
});

test('a fragment run whose total exceeds the cap terminates the socket', () => {
  const s = fakeSocket();
  const ws = new MiniSocket(s);
  let gotMessage = false;
  ws.on('message', () => { gotMessage = true; });
  const part = Buffer.alloc(Math.floor(MAX * 0.6), 0x61);   // each fragment is UNDER the per-frame cap
  s.emit('data', mkFrame(0x02, false, part.length, part));  // first fragment (FIN=0), accepted
  assert.equal(s.destroyed, false, 'first under-cap fragment accepted');
  s.emit('data', mkFrame(0x00, true, part.length, part));   // continuation; running total ~1.2x cap
  assert.equal(s.destroyed, true, 'the accumulated fragment run over the cap terminates the socket');
  assert.equal(gotMessage, false);
});
