'use strict';

const { canonicalProviderId, providerFor } = require('./providers');

class TokenStorage {
  constructor({ getConfig, saveConfig }) {
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
  }

  oauthRoot() {
    const config = this.getConfig();
    if (!config.settings) config.settings = {};
    if (!config.settings.oauth || typeof config.settings.oauth !== 'object') {
      config.settings.oauth = { providers: {}, tokens: {} };
    }
    if (!config.settings.oauth.providers || typeof config.settings.oauth.providers !== 'object') config.settings.oauth.providers = {};
    if (!config.settings.oauth.tokens || typeof config.settings.oauth.tokens !== 'object') config.settings.oauth.tokens = {};
    let migrated = false;
    const legacyToken = config.settings.oauth.tokens.microsoft || config.settings.oauth.tokens.teams;
    if (legacyToken && !config.settings.oauth.tokens['app:office']) {
      config.settings.oauth.tokens['app:office'] = Object.assign({}, legacyToken, { provider: 'app:office' });
      migrated = true;
    }
    for (const id of ['microsoft', 'teams']) {
      if (Object.hasOwn(config.settings.oauth.providers, id)) { delete config.settings.oauth.providers[id]; migrated = true; }
      if (Object.hasOwn(config.settings.oauth.tokens, id)) { delete config.settings.oauth.tokens[id]; migrated = true; }
    }
    if (migrated) this.saveConfig();
    return config.settings.oauth;
  }

  getProviderSettings(provider) {
    provider = canonicalProviderId(provider);
    const root = this.oauthRoot();
    const fixed = providerFor(provider);
    return Object.assign({}, root.providers[provider] || {}, fixed && fixed.clientId ? { clientId: fixed.clientId } : {});
  }

  setProviderSettings(provider, patch) {
    provider = canonicalProviderId(provider);
    const fixed = providerFor(provider);
    if (fixed && fixed.clientId) throw new Error(fixed.name + ' client settings are built into Bedrock Panel');
    const root = this.oauthRoot();
    const previous = root.providers[provider];
    root.providers[provider] = Object.assign({}, previous || {}, patch || {});
    if (this.saveConfig() === false) {
      if (previous === undefined) delete root.providers[provider]; else root.providers[provider] = previous;
      throw new Error('OAuth settings could not be stored securely');
    }
    return Object.assign({}, root.providers[provider]);
  }

  getTokens(provider) {
    provider = canonicalProviderId(provider);
    const root = this.oauthRoot();
    const t = root.tokens[provider];
    return t && typeof t === 'object' ? Object.assign({}, t) : null;
  }

  setTokens(provider, tokens) {
    provider = canonicalProviderId(provider);
    const root = this.oauthRoot();
    const previous = root.tokens[provider];
    root.tokens[provider] = Object.assign({}, tokens || {}, { provider, updatedAt: Date.now() });
    if (this.saveConfig() === false) {
      if (previous === undefined) delete root.tokens[provider]; else root.tokens[provider] = previous;
      throw new Error('OAuth tokens could not be stored securely');
    }
    return Object.assign({}, root.tokens[provider]);
  }

  deleteTokens(provider) {
    provider = canonicalProviderId(provider);
    const root = this.oauthRoot();
    const previous = root.tokens[provider];
    delete root.tokens[provider];
    if (this.saveConfig() === false) {
      if (previous !== undefined) root.tokens[provider] = previous;
      throw new Error('OAuth token deletion could not be stored');
    }
  }

  status(provider) {
    provider = canonicalProviderId(provider);
    const settings = this.getProviderSettings(provider);
    const tokens = this.getTokens(provider);
    return {
      provider,
      configured: !!settings.clientId,
      connected: !!(tokens && (tokens.accessToken || tokens.refreshToken)),
      expiresAt: tokens && tokens.expiresAt || null,
      updatedAt: tokens && tokens.updatedAt || null,
      scopes: tokens && tokens.scope ? String(tokens.scope).split(/[,\s]+/).filter(Boolean) : [],
    };
  }
}

module.exports = { TokenStorage };
