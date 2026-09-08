'use strict';

const DEFAULT_DISCORD_SETTINGS = Object.freeze({
  enabled: true,
  applicationIdOverride: '',
  customVoiceScopes: false,
  customMessageScopes: false,
  customNotificationScopes: false,
  defaultView: 'voice',
  autoReconnect: true,
  showUnavailable: true,
  richPresence: false,
});

const VIEWS = new Set(['voice', 'chat', 'activity']);

function cleanId(value, maxLength) {
  return typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, maxLength) : '';
}

function normalizeDiscordSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const legacyClientId = source.clientId == null ? source.applicationId : source.clientId;
  const applicationIdOverride = source.applicationIdOverride == null ? legacyClientId : source.applicationIdOverride;
  const defaultView = VIEWS.has(source.defaultView) ? source.defaultView : DEFAULT_DISCORD_SETTINGS.defaultView;
  return {
    enabled: source.enabled !== false,
    applicationIdOverride: cleanId(applicationIdOverride, 128),
    customVoiceScopes: source.customVoiceScopes === true,
    customMessageScopes: source.customMessageScopes === true,
    customNotificationScopes: source.customNotificationScopes === true,
    defaultView,
    autoReconnect: source.autoReconnect !== false,
    showUnavailable: source.showUnavailable !== false,
    richPresence: source.richPresence === true,
  };
}

// Public application identifier for the Bedrock Panel Discord Developer Portal app.
// This is deliberately not a secret; OAuth tokens remain in the encrypted store.
const DEFAULT_DISCORD_APPLICATION_ID = '1539959318974169088';

const DISCORD_SCOPE_GROUPS = Object.freeze({
  core: Object.freeze(['identify', 'rpc']),
  voice: Object.freeze(['rpc.voice.read', 'rpc.voice.write']),
  messages: Object.freeze(['messages.read']),
  notifications: Object.freeze(['rpc.notifications.read']),
});
const DISCORD_SCOPE_GROUP_ORDER = Object.freeze(['core', 'voice', 'messages', 'notifications']);

function discordApplicationId(settings) {
  const normalized = normalizeDiscordSettings(settings);
  return normalized.applicationIdOverride || DEFAULT_DISCORD_APPLICATION_ID;
}

function discordUsesCustomApplication(settings) {
  return !!normalizeDiscordSettings(settings).applicationIdOverride;
}

function discordRequestedScopeGroups(settings) {
  const normalized = normalizeDiscordSettings(settings);
  if (!normalized.applicationIdOverride) return DISCORD_SCOPE_GROUP_ORDER.slice();
  return ['core'].concat([
    normalized.customVoiceScopes && 'voice',
    normalized.customMessageScopes && 'messages',
    normalized.customNotificationScopes && 'notifications',
  ].filter(Boolean));
}

function discordRequestedScopes(settings) {
  return discordRequestedScopeGroups(settings).flatMap(group => DISCORD_SCOPE_GROUPS[group]);
}

module.exports = {
  DEFAULT_DISCORD_APPLICATION_ID, DEFAULT_DISCORD_SETTINGS, DISCORD_SCOPE_GROUP_ORDER, DISCORD_SCOPE_GROUPS,
  discordApplicationId, discordRequestedScopeGroups, discordRequestedScopes, discordUsesCustomApplication,
  normalizeDiscordSettings,
};
