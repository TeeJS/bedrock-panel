'use strict';

const REDIRECT_URI = 'http://localhost:5173/oauth/callback';
const providers = {
  github: {
    id: 'github',
    name: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    deviceCodeUrl: 'https://github.com/login/device/code',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    revokeUrl: '',
    revoke: { style: 'github', apiBase: 'https://api.github.com' },
    scopes: ['repo', 'offline_access'],
    suggestedScopes: ['repo', 'offline_access'],
    redirectUri: REDIRECT_URI,
    usesPkce: false,
    deviceFlow: true,
    accessTokenExpiresSkewMs: 5 * 60 * 1000,
  },
  google: {
    id: 'google',
    name: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    scopes: ['openid', 'email', 'profile'],
    redirectUri: REDIRECT_URI,
    usesPkce: true,
    accessTokenExpiresSkewMs: 5 * 60 * 1000,
  },
};

const aliases = {};

// Drop-in apps register their own OAuth providers at runtime, always under an `app:<appid>` id so
// they can never collide with or shadow a built-in (the static table is consulted first below).
const appProviders = new Map();
function registerAppProvider(def) {
  const id = String(def && def.id || '').toLowerCase();
  if (id.startsWith('app:')) appProviders.set(id, Object.assign({}, def, { id }));
}
function clearAppProviders() { appProviders.clear(); }

function providerFor(id) {
  const key = String(id || '').toLowerCase();
  return providers[aliases[key] || key] || appProviders.get(key) || null;   // built-ins win
}

function canonicalProviderId(id) {
  const provider = providerFor(id);
  return provider ? provider.id : String(id || '').toLowerCase();
}

module.exports = { REDIRECT_URI, providers, providerFor, canonicalProviderId, registerAppProvider, clearAppProviders };
