'use strict';
// A Claude turn that fails because the CLI's sign-in lapsed must tell the user how to fix it; other
// errors pass through untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const { claudeTurnError } = require('../app/claudevoice-adapter');

test('an expired or missing CLI sign-in gets the /login hint', () => {
  for (const msg of [
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'OAuth token has expired. Please obtain a new token or refresh your existing token.',
    'Not logged in · Please run /login',
    'Login expired · Please run /login',
    'Invalid API key · Please run /login',
  ]) {
    const out = claudeTurnError(msg);
    assert.ok(out.startsWith(msg), msg);
    assert.match(out, /open a terminal on this PC, run claude, then type \/login$/, msg);
  }
});

test('other errors are shown as the CLI wrote them', () => {
  assert.equal(claudeTurnError('API Error: 529 Overloaded'), 'API Error: 529 Overloaded');
  assert.equal(claudeTurnError(''), 'error');
  assert.equal(claudeTurnError(undefined), 'error');
});
