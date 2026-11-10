'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ca = require('../app/claudeAuth');

test('claudeChildEnv: empty token returns the base env unchanged', () => {
  const base = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'live', FOO: 'bar' };
  const out = ca.claudeChildEnv(base, { token: '', createdAt: '' });
  assert.strictEqual(out, base, 'should be the very same object');
  assert.deepStrictEqual(out, { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'live', FOO: 'bar' });
});

test('claudeChildEnv: no claudeAuth at all is a no-op', () => {
  const base = { PATH: '/usr/bin' };
  assert.strictEqual(ca.claudeChildEnv(base, null), base);
  assert.strictEqual(ca.claudeChildEnv(base, undefined), base);
});

test('claudeChildEnv: a token sets the var and removes the conflicting ones', () => {
  const base = {
    PATH: '/usr/bin', FOO: 'bar',
    ANTHROPIC_API_KEY: 'live', ANTHROPIC_AUTH_TOKEN: 'live2', CLAUDE_CODE_SIMPLE: '1',
  };
  const out = ca.claudeChildEnv(base, { token: 'sk-ant-oat01-abc' });
  assert.strictEqual(out.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-abc');
  assert.ok(!('ANTHROPIC_API_KEY' in out));
  assert.ok(!('ANTHROPIC_AUTH_TOKEN' in out));
  assert.ok(!('CLAUDE_CODE_SIMPLE' in out));
  assert.strictEqual(out.PATH, '/usr/bin');
  assert.strictEqual(out.FOO, 'bar');
  // the base object is not mutated
  assert.strictEqual(base.ANTHROPIC_API_KEY, 'live');
  assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in base));
});

test('claudeChildEnv: a pasted token is sanitized before use', () => {
  const out = ca.claudeChildEnv({ PATH: '/x' }, { token: '  sk-ant-oat01-abc\r\n' });
  assert.strictEqual(out.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-abc');
});

test('sanitizeToken strips all whitespace; looksLikeToken checks the prefix', () => {
  assert.strictEqual(ca.sanitizeToken('  sk-ant-oat01-a b\tc\n'), 'sk-ant-oat01-abc');
  assert.strictEqual(ca.sanitizeToken(null), '');
  assert.ok(ca.looksLikeToken('sk-ant-oat01-abc'));
  assert.ok(ca.looksLikeToken('  sk-ant-oat01-abc '));
  assert.ok(!ca.looksLikeToken('ghp_nope'));
  assert.ok(!ca.looksLikeToken(''));
});

// Expiry: created 2026-01-01 UTC, token lives 365 days. For a target of N days left, "now" is set
// to exactly N days before expiry, so Math.ceil gives N back.
const CREATED = '2026-01-01';
const CREATED_MS = Date.UTC(2026, 0, 1);
const EXPIRES_MS = CREATED_MS + 365 * ca.DAY_MS;
const auth = { token: 'sk-ant-oat01-abc', createdAt: CREATED };
const nowAtDaysLeft = n => EXPIRES_MS - n * ca.DAY_MS;

test('tokenExpiry: state and pill at the boundaries 31/30/1/0/-1', () => {
  const cases = [
    [31, 'ok'],
    [30, 'soon'],
    [1, 'soon'],
    [0, 'soon'],
    [-1, 'expired'],
  ];
  for (const [n, state] of cases) {
    const e = ca.tokenExpiry(auth, nowAtDaysLeft(n));
    assert.strictEqual(e.state, state, `daysLeft ${n} -> ${state}`);
    assert.strictEqual(e.daysLeft, n, `daysLeft ${n}`);
    assert.strictEqual(ca.shouldWarnExpiry(auth, nowAtDaysLeft(n)), state !== 'ok', `warn at ${n}`);
  }
  assert.strictEqual(ca.expiryPill(auth, nowAtDaysLeft(31)).cls, 'ok');
  assert.strictEqual(ca.expiryPill(auth, nowAtDaysLeft(30)).cls, 'warn');
  assert.strictEqual(ca.expiryPill(auth, nowAtDaysLeft(0)).text, 'Expires today');
  assert.strictEqual(ca.expiryPill(auth, nowAtDaysLeft(1)).text, 'Expires in 1 day');
  assert.strictEqual(ca.expiryPill(auth, nowAtDaysLeft(-1)).cls, 'bad');
});

test('tokenExpiry: no token is "none"; dateless token is "unknown"', () => {
  assert.strictEqual(ca.tokenExpiry({ token: '', createdAt: '' }).state, 'none');
  assert.strictEqual(ca.expiryPill({ token: '', createdAt: '' }).text, 'Not set');
  assert.strictEqual(ca.tokenExpiry({ token: 'sk-ant-oat01-abc', createdAt: '' }).state, 'unknown');
  assert.strictEqual(ca.tokenExpiry({ token: 'sk-ant-oat01-abc', createdAt: 'garbage' }).state, 'unknown');
  assert.strictEqual(ca.expiryPill({ token: 'sk-ant-oat01-abc', createdAt: '' }).text, 'Set');
  assert.ok(!ca.shouldWarnExpiry({ token: 'sk-ant-oat01-abc', createdAt: '' }));
});

test('messages mention the token and the clear-the-token fallback', () => {
  assert.match(ca.rejectedTokenMessage(), /setup-token/);
  assert.match(ca.rejectedTokenMessage(), /clear the token/);
  assert.match(ca.expiryNoticeBody(5), /about 5 days/);
  assert.match(ca.expiryNoticeBody(1), /about 1 day\b/);
  assert.match(ca.expiryNoticeBody(0), /expired or expires today/);
});
