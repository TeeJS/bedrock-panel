'use strict';

const http = require('http');
const crypto = require('crypto');
const { providerFor } = require('./providers');

function base64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function formBody(obj) {
  const params = new URLSearchParams();
  Object.entries(obj || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  });
  return params;
}

function scopeList(scopes) {
  if (Array.isArray(scopes)) return scopes.map(s => String(s || '').trim()).filter(Boolean);
  if (typeof scopes === 'string') return scopes.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  return [];
}

function uniqueScopes(scopes) {
  return Array.from(new Set(scopeList(scopes)));
}

function scopesFor(provider, requested) {
  return uniqueScopes([].concat(provider.scopes || [], scopeList(requested)));
}

function tokenScopes(tokens) {
  return uniqueScopes(tokens && tokens.scope || []);
}

function comparableScope(scope) {
  const s = String(scope || '').toLowerCase();
  return s && s !== 'offline_access' && s !== 'openid' && s !== 'profile';
}

function hasScopes(tokens, requested) {
  const have = new Set(tokenScopes(tokens).map(s => s.toLowerCase()));
  return scopeList(requested).filter(comparableScope).every(s => have.has(s.toLowerCase()));
}

class OAuthHandler {
  constructor({ storage, openExternal, log = () => {}, fetchImpl = fetch, now = Date.now }) {
    this.storage = storage;
    this.openExternal = openExternal;
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.pending = new Map();
    this.pendingDevices = new Map();
    this.callbackServer = null;
    this.refreshTimers = new Map();
    this.refreshRetries = new Map();
  }

  provider(id) {
    const provider = providerFor(id);
    if (!provider) throw new Error('Unknown OAuth provider: ' + id);
    return provider;
  }

  async generateAuthUrl(providerId, requestedScopes) {
    const provider = this.provider(providerId);
    const settings = this.storage.getProviderSettings(provider.id);
    const clientId = provider.clientId || settings.clientId;
    if (!clientId) throw new Error(provider.name + ' client ID is required');
    const requested = scopesFor(provider, requestedScopes);
    const state = base64Url(crypto.randomBytes(24));
    const verifier = base64Url(crypto.randomBytes(48));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    this.pending.set(state, { providerId: provider.id, verifier, scopes: requested, createdAt: Date.now() });

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: provider.redirectUri,
      response_mode: 'query',
      scope: requested.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (provider.id === 'google') params.set('access_type', 'offline');
    if (provider.id === 'google') params.set('prompt', 'consent');
    return provider.authUrl + '?' + params.toString();
  }

  async connect(providerId, requestedScopes) {
    const provider = this.provider(providerId);
    if (provider.deviceFlow) return this.beginDeviceFlow(provider.id, requestedScopes);
    await this.ensureCallbackServer();
    const url = await this.generateAuthUrl(providerId, requestedScopes);
    if (!this.openExternal(url)) throw new Error('Could not open OAuth sign-in URL');
    return { ok: true };
  }

  async handleCallback(urlObj) {
    const state = urlObj.searchParams.get('state') || '';
    const code = urlObj.searchParams.get('code') || '';
    const err = urlObj.searchParams.get('error') || '';
    const pending = this.pending.get(state);
    if (!pending) throw new Error('OAuth state was not recognized');
    this.pending.delete(state);
    if (err) throw new Error(urlObj.searchParams.get('error_description') || err);
    if (!code) throw new Error('OAuth callback did not include an authorization code');

    const provider = this.provider(pending.providerId);
    const settings = this.storage.getProviderSettings(provider.id);
    const token = await this.fetchToken(provider, {
      grant_type: 'authorization_code',
      client_id: provider.clientId || settings.clientId,
      client_secret: settings.clientSecret,
      code,
      redirect_uri: provider.redirectUri,
      code_verifier: pending.verifier,
    });
    this.storage.setTokens(provider.id, this.normalizeToken(provider.id, token, pending.scopes));
    this.scheduleRefresh(provider.id);
    return { ok: true, provider: provider.id };
  }

  async fetchToken(provider, payload) {
    const res = await this.fetchImpl(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: formBody(payload),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text || res.statusText }; }
    if (!res.ok || data.error) {
      throw new Error(data.error_description || data.error || ('Token request failed: HTTP ' + res.status));
    }
    return data;
  }

  normalizeToken(provider, token, requestedScopes) {
    const now = this.now();
    const expiresIn = token.expires_in === undefined || token.expires_in === null ? null : Number(token.expires_in);
    const refreshExpiresIn = token.refresh_token_expires_in === undefined || token.refresh_token_expires_in === null ? null : Number(token.refresh_token_expires_in);
    return {
      provider,
      tokenType: token.token_type || 'Bearer',
      accessToken: token.access_token || '',
      refreshToken: token.refresh_token || '',
      expiresAt: Number.isFinite(expiresIn) ? now + Math.max(0, expiresIn) * 1000 : null,
      refreshExpiresAt: Number.isFinite(refreshExpiresIn) ? now + Math.max(0, refreshExpiresIn) * 1000 : null,
      scope: token.scope || scopeList(requestedScopes).join(' '),
      authFlow: token.authFlow || '',
    };
  }

  async postForm(url, payload) {
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: formBody(payload),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch (error) { data = Object.fromEntries(new URLSearchParams(text)); }
    if (!res.ok) throw new Error('OAuth request failed: HTTP ' + res.status);
    return data && typeof data === 'object' ? data : {};
  }

  async beginDeviceFlow(providerId, requestedScopes) {
    const provider = this.provider(providerId);
    if (!provider.deviceFlow || !provider.deviceCodeUrl) throw new Error(provider.name + ' does not support device authorization');
    const settings = this.storage.getProviderSettings(provider.id);
    const clientId = String(provider.clientId || settings.clientId || '').trim();
    if (!clientId) throw new Error(provider.name + ' OAuth App client ID is required');
    const scopes = scopesFor(provider, requestedScopes);
    const data = await this.postForm(provider.deviceCodeUrl, { client_id: clientId, scope: scopes.join(' ') });
    if (data.error) throw Object.assign(new Error(data.error_description || data.error), { code: data.error });
    const deviceCode = String(data.device_code || '');
    const userCode = String(data.user_code || '');
    const verificationUri = String(data.verification_uri || '');
    let target;
    try { target = new URL(verificationUri); } catch (error) {}
    if (!deviceCode || !/^[A-Z0-9-]{8,12}$/i.test(userCode) || !target || target.protocol !== 'https:' || target.hostname !== 'github.com' || target.pathname !== '/login/device') {
      throw new Error('GitHub returned an invalid device authorization response');
    }
    const intervalMs = Math.max(5000, Math.min(30000, Number(data.interval || 5) * 1000));
    const expiresAt = this.now() + Math.max(60, Math.min(1800, Number(data.expires_in || 900))) * 1000;
    this.pendingDevices.set(provider.id, { clientId, deviceCode, userCode, verificationUri: target.href, scopes, intervalMs, nextPollAt: this.now() + intervalMs, expiresAt });
    if (this.openExternal && !await this.openExternal(target.href)) {
      this.pendingDevices.delete(provider.id);
      throw new Error('Could not open GitHub device sign-in');
    }
    return { ok: true, pending: true, provider: provider.id, userCode, verificationUri: target.href, expiresAt, retryAfterMs: intervalMs };
  }

  async pollDeviceFlow(providerId) {
    const provider = this.provider(providerId);
    const pending = this.pendingDevices.get(provider.id);
    if (!pending) return { ok: false, pending: false, code: 'device_flow_not_started', error: 'GitHub sign-in has not been started' };
    const now = this.now();
    if (now >= pending.expiresAt) {
      this.pendingDevices.delete(provider.id);
      return { ok: false, pending: false, code: 'expired_token', error: 'GitHub sign-in code expired' };
    }
    if (now < pending.nextPollAt) return { ok: true, pending: true, userCode: pending.userCode, verificationUri: pending.verificationUri, expiresAt: pending.expiresAt, retryAfterMs: pending.nextPollAt - now };
    pending.nextPollAt = now + pending.intervalMs;
    const data = await this.postForm(provider.tokenUrl, {
      client_id: pending.clientId,
      device_code: pending.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (data.error === 'authorization_pending') return { ok: true, pending: true, userCode: pending.userCode, verificationUri: pending.verificationUri, expiresAt: pending.expiresAt, retryAfterMs: pending.intervalMs };
    if (data.error === 'slow_down') {
      pending.intervalMs = Math.min(60000, pending.intervalMs + 5000);
      pending.nextPollAt = now + pending.intervalMs;
      return { ok: true, pending: true, userCode: pending.userCode, verificationUri: pending.verificationUri, expiresAt: pending.expiresAt, retryAfterMs: pending.intervalMs };
    }
    if (data.error) {
      this.pendingDevices.delete(provider.id);
      throw Object.assign(new Error(data.error_description || data.error), { code: data.error });
    }
    if (!data.access_token) throw new Error('GitHub sign-in returned no access token');
    this.pendingDevices.delete(provider.id);
    const tokens = this.normalizeToken(provider.id, Object.assign({}, data, { authFlow: 'device' }), pending.scopes);
    this.storage.setTokens(provider.id, tokens);
    this.scheduleRefresh(provider.id);
    return { ok: true, pending: false, connected: true, provider: provider.id };
  }

  async refreshTokenIfNeeded(providerId, force, requestedScopes) {
    const provider = this.provider(providerId);
    const requested = scopesFor(provider, requestedScopes);
    const tokens = this.storage.getTokens(provider.id);
    if (!tokens) return null;
    if (!hasScopes(tokens, requested)) {
      const err = new Error('Additional ' + provider.name + ' consent is required for: ' + requested.filter(s => !hasScopes(tokens, [s])).join(' '));
      err.code = 'consent_required';
      err.provider = provider.id;
      err.scopes = requested;
      throw err;
    }
    const skew = provider.accessTokenExpiresSkewMs || 300000;
    if (!force && tokens.accessToken && !tokens.expiresAt) return tokens;
    if (!force && tokens.accessToken && tokens.expiresAt && this.now() < Number(tokens.expiresAt) - skew) {
      return tokens;
    }
    if (!tokens.refreshToken) return null;
    if (tokens.refreshExpiresAt && this.now() >= Number(tokens.refreshExpiresAt)) return null;
    const settings = this.storage.getProviderSettings(provider.id);
    const refreshPayload = {
      grant_type: 'refresh_token',
      client_id: provider.clientId || settings.clientId,
      refresh_token: tokens.refreshToken,
    };
    if (tokens.authFlow !== 'device') {
      refreshPayload.client_secret = settings.clientSecret;
      refreshPayload.redirect_uri = provider.redirectUri;
      refreshPayload.scope = requested.join(' ');
    }
    const next = await this.fetchToken(provider, refreshPayload);
    const merged = this.normalizeToken(provider.id, Object.assign({}, next, {
      refresh_token: next.refresh_token || tokens.refreshToken,
      scope: next.scope || tokens.scope || '',
      authFlow: tokens.authFlow || '',
    }), requested);
    this.storage.setTokens(provider.id, merged);
    this.scheduleRefresh(provider.id);
    return merged;
  }

  async getValidAccessToken(providerId, requestedScopes) {
    const tokens = await this.refreshTokenIfNeeded(providerId, false, requestedScopes);
    if (!tokens) return null;
    return {
      provider: tokens.provider,
      tokenType: tokens.tokenType || 'Bearer',
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope || '',
      scopes: tokenScopes(tokens),
    };
  }

  async revokeToken(providerId) {
    const provider = this.provider(providerId);
    this.pendingDevices.delete(provider.id);
    const tokens = this.storage.getTokens(provider.id);
    if (tokens && (tokens.refreshToken || tokens.accessToken)) {
      try { await this.revokeAtProvider(provider, tokens); }
      catch (e) { this.log('[oauth] revoke failed: ' + (e.message || e)); }
    }
    this.clearRefresh(provider.id);
    this.refreshRetries.delete(provider.id);
    this.storage.deleteTokens(provider.id);
    return { ok: true };
  }

  // Invalidate the grant at the provider, not just locally — otherwise a disconnected refresh token
  // stays replayable outside Bedrock Panel. Providers differ: Google exposes an RFC 7009 endpoint;
  // GitHub instead requires DELETE /applications/{client_id}/grant with the OAuth App's client
  // credentials via HTTP Basic. A GitHub app configured as a public client (no secret) cannot be
  // revoked server-side, so we say so and remove the local copy — the best available outcome.
  async revokeAtProvider(provider, tokens) {
    const style = provider.revoke && provider.revoke.style;
    if (style === 'github') {
      const settings = this.storage.getProviderSettings(provider.id) || {};
      const clientId = provider.clientId || settings.clientId;
      const clientSecret = settings.clientSecret;
      if (!clientId || !clientSecret) {
        this.log('[oauth] cannot revoke ' + provider.id + ' at the provider without an OAuth App client secret; removed the local copy only');
        return;
      }
      const apiBase = String(provider.revoke.apiBase || 'https://api.github.com').replace(/\/+$/, '');
      const res = await this.fetchImpl(apiBase + '/applications/' + encodeURIComponent(clientId) + '/grant', {
        method: 'DELETE',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access_token: tokens.accessToken || tokens.refreshToken }),
      });
      const status = res && typeof res.status === 'number' ? res.status : 0;
      if (status >= 400 && status !== 404) throw new Error('GitHub revoke returned HTTP ' + status);   // 404 = already gone
      return;
    }
    if (provider.revokeUrl) {
      await this.fetchImpl(provider.revokeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ token: tokens.refreshToken || tokens.accessToken }),
      });
    }
  }

  status(providerId) {
    return this.storage.status(providerId);
  }

  listStatus() {
    return ['github', 'google'].map(id => this.status(id));
  }

  scheduleAll() {
    this.listStatus().forEach(s => { if (s.connected) this.scheduleRefresh(s.provider); });
  }

  scheduleRefresh(providerId) {
    this.clearRefresh(providerId);
    const provider = this.provider(providerId);
    // A healthy (re)schedule means the last refresh succeeded (or this is a fresh connect), so reset
    // the retry backoff — the next failure starts counting from the beginning again.
    this.refreshRetries.delete(provider.id);
    const tokens = this.storage.getTokens(provider.id);
    if (!tokens || !tokens.refreshToken || !tokens.expiresAt) return;
    const delay = Math.max(30000, Number(tokens.expiresAt) - this.now() - (provider.accessTokenExpiresSkewMs || 300000));
    this.refreshTimers.set(provider.id, setTimeout(() => {
      this.refreshTokenIfNeeded(provider.id, true).catch(e => this.handleRefreshFailure(provider.id, e));
    }, delay));
  }

  // A scheduled refresh that rejects used to be logged and dropped, leaving no timer — so a single
  // transient failure (network blip, provider 5xx) permanently stopped background refresh until the
  // app restarted or a page happened to poll. Reschedule a bounded exponential-backoff retry instead.
  // consent_required is a dead end without user action, so we don't spin on it.
  handleRefreshFailure(providerId, error) {
    const provider = this.provider(providerId);
    if (error && error.code === 'consent_required') {
      this.log('[oauth] refresh needs re-consent for ' + provider.id + '; not retrying automatically: ' + (error.message || error));
      return;
    }
    const attempt = (this.refreshRetries.get(provider.id) || 0) + 1;
    this.refreshRetries.set(provider.id, attempt);
    const retryDelay = Math.min(30 * 60000, 60000 * Math.pow(2, attempt - 1));   // 1m, 2m, 4m, ... capped at 30m
    this.log('[oauth] refresh failed for ' + provider.id + ' (attempt ' + attempt + '), retrying in ' + Math.round(retryDelay / 1000) + 's: ' + (error && error.message || error));
    const t = this.refreshTimers.get(provider.id);
    if (t) clearTimeout(t);
    this.refreshTimers.set(provider.id, setTimeout(() => {
      this.refreshTokenIfNeeded(provider.id, true).catch(e => this.handleRefreshFailure(provider.id, e));
    }, retryDelay));
  }

  clearRefresh(providerId) {
    const t = this.refreshTimers.get(providerId);
    if (t) clearTimeout(t);
    this.refreshTimers.delete(providerId);
  }

  cancelDeviceFlow(providerId) {
    this.pendingDevices.delete(this.provider(providerId).id);
  }

  stop() {
    for (const t of this.refreshTimers.values()) clearTimeout(t);
    this.refreshTimers.clear();
    this.refreshRetries.clear();
    this.pendingDevices.clear();
    if (this.callbackServer) {
      try { this.callbackServer.close(); } catch (e) {}
      this.callbackServer = null;
    }
  }

  ensureCallbackServer() {
    if (this.callbackServer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost:5173');
        if (req.method !== 'GET' || url.pathname !== '/oauth/callback') {
          res.writeHead(404); res.end(); return;
        }
        this.handleCallback(url).then(result => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><title>Bedrock Panel OAuth</title><body style="font:16px Segoe UI,sans-serif;background:#101820;color:#e8f1fb">Connected. You can close this window.</body>');
          this.log('[oauth] connected ' + result.provider);
        }).catch(e => {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><title>Bedrock Panel OAuth</title><body style="font:16px Segoe UI,sans-serif;background:#101820;color:#f3b4a5">OAuth failed: ' + String(e.message || e).replace(/[<>&"]/g, '') + '</body>');
          this.log('[oauth] callback failed: ' + (e.message || e));
        });
      });
      server.once('error', err => {
        this.callbackServer = null;
        reject(new Error('Could not listen on localhost:5173 for OAuth callback: ' + (err.message || err)));
      });
      server.listen(5173, '127.0.0.1', () => {
        this.callbackServer = server;
        resolve();
      });
    });
  }
}

module.exports = { OAuthHandler };
