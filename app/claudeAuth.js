'use strict';
// Optional "Claude token" (made with `claude setup-token`) support. This module is PURE and
// dependency-free so it unit-tests without Electron: it builds the child-process environment for the
// `claude` CLI spawns, computes token expiry for the Auth-tab card, and holds the operator-facing
// messages. The token itself is a secret (settings.claudeAuth.token) encrypted at rest by
// app/secretStore.js; nothing here reads or writes config. See docs/claude-token-plan.md.

const DAY_MS = 86400000;
const TOKEN_TTL_DAYS = 365;        // `claude setup-token` makes a one-year token
const EXPIRY_WARN_DAYS = 30;       // warn (pill + one startup notice) when this many days or fewer remain

// Variables removed from the CHILD env only (never the real environment) when a token is set, so the
// token is actually the credential Claude Code uses:
//  - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN: both rank ABOVE the OAuth token in Claude Code's
//    precedence, and in -p mode the API key is always used when present (verified in the spike).
//  - CLAUDE_CODE_SIMPLE: bare mode, which does not read the OAuth token at all. Claude Code sets it
//    inside its own sessions, so a Bedrock Panel launched from an agent's shell would inherit it.
const CONFLICTING_VARS = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_SIMPLE']);

// Added to each backend's auth-failure pattern: a token pasted with trailing text yields a CLI error
// of "401 Invalid bearer token" rather than the usual "OAuth access token is invalid".
const AUTH_FAILURE_PATTERN = 'invalid bearer token';

// Strip ALL whitespace (spaces, tabs, newlines) from a pasted token. A real paste once carried
// surrounding text and failed with "Invalid bearer token"; a setup-token contains no whitespace.
function sanitizeToken(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, '');
}

// A setup-token looks like `sk-ant-oat01-...`. Used only to warn in the UI, never to reject a value.
function looksLikeToken(token) {
  return /^sk-ant-oat/.test(sanitizeToken(token));
}

// Build the environment for a `claude` child process. baseEnv is normally process.env.
//  - No token: returns baseEnv UNCHANGED (the same object) so today's behavior is byte-for-byte identical.
//  - Token set: a shallow copy with CLAUDE_CODE_OAUTH_TOKEN set and the conflicting vars removed.
function claudeChildEnv(baseEnv, claudeAuth) {
  const env = baseEnv || {};
  const token = sanitizeToken(claudeAuth && claudeAuth.token);
  if (!token) return env;
  const out = Object.assign({}, env);
  out.CLAUDE_CODE_OAUTH_TOKEN = token;
  for (const k of CONFLICTING_VARS) delete out[k];
  return out;
}

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? null : ms;
}
function ymd(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

// Expiry state for the Auth-tab pill and the startup notice. `createdAt` is 'YYYY-MM-DD' (the day the
// token was pasted). The docs give no exact expiry instant, so callers phrase daysLeft as "about".
//   -> { state, daysLeft, expiresOn }
//      state 'none'     no token
//            'unknown'  token set but no / unparseable createdAt (cannot date it)
//            'ok'       more than EXPIRY_WARN_DAYS left
//            'soon'     0..EXPIRY_WARN_DAYS left (warn)
//            'expired'  past expiry
function tokenExpiry(claudeAuth, now) {
  const token = sanitizeToken(claudeAuth && claudeAuth.token);
  if (!token) return { state: 'none', daysLeft: null, expiresOn: '' };
  const created = parseYmd(claudeAuth && claudeAuth.createdAt);
  if (created == null) return { state: 'unknown', daysLeft: null, expiresOn: '' };
  const expiresAt = created + TOKEN_TTL_DAYS * DAY_MS;
  const nowMs = now == null ? Date.now() : Number(now);
  const daysLeft = Math.ceil((expiresAt - nowMs) / DAY_MS);
  const state = daysLeft < 0 ? 'expired' : daysLeft <= EXPIRY_WARN_DAYS ? 'soon' : 'ok';
  return { state, daysLeft, expiresOn: ymd(expiresAt) };
}

// True when the one-per-launch expiry notice should fire (token set, dated, inside the warn window or past).
function shouldWarnExpiry(claudeAuth, now) {
  const s = tokenExpiry(claudeAuth, now).state;
  return s === 'soon' || s === 'expired';
}

// { cls, text } for the Auth-tab status pill. cls is a token the card maps to a colour.
function expiryPill(claudeAuth, now) {
  const e = tokenExpiry(claudeAuth, now);
  switch (e.state) {
    case 'unknown': return { cls: 'ok', text: 'Set' };
    case 'ok': return { cls: 'ok', text: 'Set · expires about ' + e.expiresOn };
    case 'soon': return { cls: 'warn', text: e.daysLeft <= 0 ? 'Expires today' : 'Expires in ' + e.daysLeft + ' day' + (e.daysLeft === 1 ? '' : 's') };
    case 'expired': return { cls: 'bad', text: 'Probably expired' };
    default: return { cls: 'off', text: 'Not set' };
  }
}

// Shown when the CLI rejects a saved token. A bad token does NOT fall back to the normal login
// (confirmed in the spike), so the fix is to replace or clear it.
function rejectedTokenMessage() {
  return 'Claude rejected the saved token (it may have expired or been revoked). Make a new one with '
    + '`claude setup-token` and paste it on Settings → Auth — or clear the token to use your normal Claude login.';
}
// Body for the one-per-launch desktop notification.
function expiryNoticeBody(daysLeft) {
  const when = daysLeft == null ? 'is set'
    : daysLeft <= 0 ? 'has expired or expires today'
      : 'expires in about ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's');
  return 'Your saved Claude token ' + when + '. Make a new one with `claude setup-token` and paste it on the Auth tab.';
}

module.exports = {
  DAY_MS, TOKEN_TTL_DAYS, EXPIRY_WARN_DAYS, CONFLICTING_VARS, AUTH_FAILURE_PATTERN,
  sanitizeToken, looksLikeToken, claudeChildEnv, tokenExpiry, shouldWarnExpiry, expiryPill,
  rejectedTokenMessage, expiryNoticeBody,
};
