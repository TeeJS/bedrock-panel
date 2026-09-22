'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OAuthHandler } = require('../src/auth/oauth-handler');

function ok(status = 200) { return { ok: status >= 200 && status < 300, status, text: async () => '' }; }

// ---- Item 3: a failed scheduled refresh reschedules a retry instead of dropping it ----

test('a failed scheduled refresh schedules a backoff retry instead of dropping it', () => {
  const handler = new OAuthHandler({ storage: { getProviderSettings: () => ({}), getTokens: () => null } });
  assert.equal(handler.refreshTimers.has('github'), false);

  handler.handleRefreshFailure('github', new Error('network down'));
  assert.equal(handler.refreshRetries.get('github'), 1);
  assert.equal(handler.refreshTimers.has('github'), true, 'a retry timer is scheduled');

  handler.handleRefreshFailure('github', new Error('still down'));
  assert.equal(handler.refreshRetries.get('github'), 2, 'backoff attempt advances');
  assert.equal(handler.refreshTimers.has('github'), true);

  handler.stop();
  assert.equal(handler.refreshTimers.has('github'), false, 'stop clears refresh timers');
  assert.equal(handler.refreshRetries.has('github'), false, 'stop clears retry state');
});

test('a consent_required refresh failure does not schedule automatic retries', () => {
  const handler = new OAuthHandler({ storage: { getProviderSettings: () => ({}), getTokens: () => null } });
  const err = Object.assign(new Error('needs consent'), { code: 'consent_required' });
  handler.handleRefreshFailure('github', err);
  assert.equal(handler.refreshTimers.has('github'), false, 'no retry for a dead-end consent error');
  assert.equal(handler.refreshRetries.has('github'), false);
  handler.stop();
});

test('scheduleRefresh resets the retry backoff after a healthy reschedule', () => {
  const handler = new OAuthHandler({ storage: { getProviderSettings: () => ({}), getTokens: () => null } });
  handler.handleRefreshFailure('github', new Error('down'));
  assert.equal(handler.refreshRetries.get('github'), 1);
  handler.scheduleRefresh('github');   // getTokens() is null, so no new timer, but backoff is reset
  assert.equal(handler.refreshRetries.has('github'), false);
  handler.stop();
});

// ---- Item 4: disconnect revokes at the provider, not just locally ----

test('GitHub disconnect revokes the grant at the provider when a client secret is configured', async () => {
  const calls = [];
  let deleted = false;
  const handler = new OAuthHandler({
    storage: {
      getProviderSettings: () => ({ clientId: 'Iv1.synthetic', clientSecret: 'shhh' }),
      getTokens: () => ({ accessToken: 'gho_x', refreshToken: 'ghr_x' }),
      deleteTokens: () => { deleted = true; },
    },
    fetchImpl: async (url, options) => { calls.push({ url, method: options.method, headers: options.headers, body: options.body }); return ok(204); },
  });
  const res = await handler.revokeToken('github');
  assert.equal(res.ok, true);
  assert.equal(deleted, true, 'local copy removed');
  assert.equal(calls.length, 1, 'exactly one provider revoke call');
  assert.equal(calls[0].method, 'DELETE');
  assert.match(calls[0].url, /\/applications\/Iv1\.synthetic\/grant$/, 'deletes the whole grant, so the refresh token dies too');
  assert.match(calls[0].headers.Authorization, /^Basic /);
  assert.equal(Buffer.from(calls[0].headers.Authorization.slice(6), 'base64').toString(), 'Iv1.synthetic:shhh');
  assert.match(String(calls[0].body), /gho_x/);
  handler.stop();
});

test('GitHub disconnect without a client secret removes only the local copy', async () => {
  const calls = [];
  let deleted = false;
  const handler = new OAuthHandler({
    storage: {
      getProviderSettings: () => ({ clientId: 'Iv1.synthetic' }),   // public client, no secret
      getTokens: () => ({ accessToken: 'gho_x', refreshToken: 'ghr_x' }),
      deleteTokens: () => { deleted = true; },
    },
    fetchImpl: async url => { calls.push(url); return ok(204); },
  });
  const res = await handler.revokeToken('github');
  assert.equal(res.ok, true);
  assert.equal(deleted, true);
  assert.equal(calls.length, 0, 'cannot revoke a public-client token server-side; no provider call made');
  handler.stop();
});

test('Google disconnect posts the refresh token to the RFC 7009 revoke endpoint', async () => {
  const calls = [];
  const handler = new OAuthHandler({
    storage: {
      getProviderSettings: () => ({}),
      getTokens: () => ({ accessToken: 'ya29_x', refreshToken: '1//refresh' }),
      deleteTokens: () => {},
    },
    fetchImpl: async (url, options) => { calls.push({ url, method: options.method, body: String(options.body) }); return ok(200); },
  });
  await handler.revokeToken('google');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/revoke');
  assert.match(calls[0].body, /token=1%2F%2Frefresh/, 'revokes the refresh token');
  handler.stop();
});

test('a revoke network failure still clears the local token', async () => {
  let deleted = false;
  const handler = new OAuthHandler({
    storage: {
      getProviderSettings: () => ({ clientId: 'Iv1.synthetic', clientSecret: 'shhh' }),
      getTokens: () => ({ accessToken: 'gho_x', refreshToken: 'ghr_x' }),
      deleteTokens: () => { deleted = true; },
    },
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const res = await handler.revokeToken('github');
  assert.equal(res.ok, true);
  assert.equal(deleted, true, 'a failed provider revoke does not block local disconnect');
  handler.stop();
});
