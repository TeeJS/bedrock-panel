---
name: bedrock-panel-drop-in-app
description: Scaffold, build, modify, migrate, or troubleshoot standalone Bedrock Panel drop-in apps. Use when working in the Bedrock Panel repository on apps/<app-id>/ structure, app.json manifests, index.html/style.css/app.js files, served drop-in apps, app options, server-only options, app-local server.js handlers, or existing generic app capabilities such as /app-proxy and /app-api.
---

# Bedrock Panel Drop-In App

Use this skill when creating or changing standalone drop-in apps in the Bedrock Panel repo.

## Contract

- Treat `apps/<app-id>/` as the app boundary.
- A normal app is self-contained with `app.json`, `index.html`, optional `style.css`, optional `app.js`, optional local assets, and optional `server.js` only when using the generic app server capability.
- Keep `app.json.id` stable, lowercase, and unique. Prefer matching the folder name for new apps.
- During migration, preserve an existing app id even if the folder name differs.
- Do not edit host/runtime files for a normal app.
- Do not add "Demo data" / mock-mode options — apps show real data or an honest empty/error state.
- Treat changes to app discovery, serving, editor behavior, IPC, packaging, local server behavior, or build files as platform work, not app work.
- Use relative asset URLs in HTML, such as `style.css` and `app.js`.

## Standalone Structure

For a new app, create:

```text
apps/<app-id>/
  app.json
  index.html
  style.css
  app.js
```

Minimal `app.json`:

```json
{
  "id": "<app-id>",
  "name": "<App Name>",
  "entry": "index.html",
  "options": []
}
```

Use `"served": true` when the app needs `/app-proxy`, `/app-api`, `/apptiles`, `/launch`, or other same-origin local server features.

Declare `"knob": true` (served apps) to receive the panel's rotary knob: define `window.oqKnob(ev)` on the page — events are `{type:'rotate',dir:±1}`, `{type:'press',index:1|2}`, `{type:'hold',phase:'start'|'end'}`; return `false` to decline an event back to the panel's default handling. Drive the knob LED ring with `console.log('OQX_RING::custom:{"hue":0-255,"sat":0-255,"effect":0-43,"speed":0-255}')` (or the named states / `idle`). See docs/drop-in-spec.md §5.4.

# Repository Rules

- Future requests to add, create, or scaffold a normal drop-in app should only edit files under `apps/<app-id>/`.
- Do not touch `app/main.js`, `app/sysserver.js`, `app/config.html`, packaging, or runtime code for a normal app request unless the user explicitly asks to change the platform.

## Workflow

1. Read `Repository Rules` first and follow its drop-in app rules.
2. Inspect a nearby existing app, `apps/test-app`, before creating patterns.
3. Create or edit only the app folder unless the user explicitly asks for platform work.
4. Keep app options in `app.json`; read them from `location.search` for served apps or `location.hash` for file apps, matching the host loader behavior.
5. Build the actual app screen first; avoid landing pages for tool/dashboard apps.
6. Validate JSON manifests and syntax-check JavaScript with `node --check` when possible.

## Served Apps

- Use `"served": true` when the app needs same-origin calls to the local Bedrock Panel server, shared app tile APIs, or host-provided generic APIs.
- Served drop-ins load at `/apps/<id>/<entry>` on the local server.
- Use relative asset paths such as `style.css` and `app.js`.

## Options

- Define app options in `app.json`.
- For served apps, non-server-only options are encoded into `location.search`.
- For file apps, options are encoded into `location.hash`.
- Mark sensitive or host-only values with `"serverOnly": true`; access those through `/app-proxy/config` or an app-local `server.js` handler.
- Use `"type": "secret"` for passwords/API keys.

Example:

```json
{
  "key": "apiKey",
  "label": "API key",
  "type": "secret",
  "default": "",
  "serverOnly": true
}
```

## Existing Generic Capabilities

Use existing generic capabilities from `app.json`; do not modify host/runtime files during normal app scaffolding.

For reusable API access, prefer a generic capability instead of app-specific hooks:

- App declares proxy permissions in `app.json`.
- Host exposes a stable generic endpoint for allowed requests.
- Host enforces origin/pattern allowlists and method limits.
- Host keeps secrets out of logs and responses.
- Host supports self-signed TLS only through explicit per-app/per-request opt-in.

Current proxy contract:

- Add `"served": true` to apps that need the proxy.
- Add an `app.json` `proxy` block, for example:

```json
{
  "proxy": {
    "methods": ["GET"],
    "verifySslOption": "verifySsl",
    "allow": [{ "option": "host" }]
  }
}
```

- Use `GET /app-proxy/config` to read active app options, including server-only options.
- Use `GET /app-proxy?url=<encoded-url>` to fetch an allowed upstream URL.

Folder picker (host-mediated, opt-in — never add an app-specific host route for this):

- Declare `"hostCapabilities": ["pick-folder"]` in `app.json` (served apps only; do NOT add it
  to templates by default — only when the app genuinely needs a directory from the user).
- `POST /app-host/pick-folder` with a JSON body `{ "defaultPath": "<absolute path, optional>" }`
  opens a host-owned directory-only dialog and resolves to `{ok:true,path}` on selection,
  `{ok:false,canceled:true}` on cancel, `409 {code:'busy'}` while one is already open, and
  `503 {code:'unavailable'}` when the host can't show one — degrade to a typed path field.
- The page gets only the user's explicit selection; relative defaults are ignored, paths never
  go in URLs or logs, and the app gains no dialog/filesystem authority. See
  `docs/drop-in-spec.md` §5.6.

For app-local server code, declare `"server": "server.js"` and export `handle(action, context)`.

```js
'use strict';

async function handle(action, context) {
  if (action === 'summary') return { ok: true };
  return { ok: false, error: 'unknown action' };
}

module.exports = { handle };
```

The active app can call `GET /app-api/<action>`. Keep integration-specific server code inside the app folder.

Avoid adding routes named for a single integration, such as `/api/qnap/...`, unless the user asks for a built-in one-off integration.

### Interactive editor management surface

A served app that manages app-owned state MAY expose its own desktop management UI without
adding app-specific code to the host editor:

```json
"editor": { "entry": "index.html", "label": "Manage jobs" }
```

The editor entry MUST be a contained relative path and is loaded with `_surface=editor`, theme
parameters, and non-secret app options. Reusing the panel entry is encouraged when it can switch
to a responsive desktop layout. The iframe has scripts, forms, and its app origin, but no preload,
Node, raw IPC, or parent-editor access. Persist app-owned changes through `/app-api/*`; those
changes take effect immediately and are outside the host editor's **Save & apply** transaction.
Use `/app-host/*` only for generic host capabilities explicitly declared by the app.

### OAuth (per-app)

A served app can integrate with one OAuth 2.0 + PKCE provider. Declare it in `app.json`. A shipped public client may put its non-secret `clientId` in the OAuth block; otherwise the user supplies client credentials via app options:

```json
"oauth": { "name": "Spotify", "clientId": "public-client-id",
  "authUrl": "https://accounts.spotify.com/authorize",
  "tokenUrl": "https://accounts.spotify.com/api/token", "scopes": ["playlist-read-private"] },
"options": [
  { "key": "oauthClientId", "label": "Client ID", "type": "text" },
  { "key": "oauthClientSecret", "label": "Client secret", "type": "secret" }
]
```

The provider registers as `app:<your-app-id>`; the redirect URI is always `http://localhost:5173/oauth/callback` (register that with the provider). The editor renders an account panel for the app (one collapsed line when healthy, full controls otherwise); if your app ships its OWN complete connect/disconnect UI, add `"selfManaged": true` to the `oauth` block to suppress the editor panel — your app then owns first-connect AND recovery, including disconnect. `handle()` receives `context.oauth`, already scoped to your app — you cannot reach another app's or a built-in provider:

```js
async function handle(action, context) {
  const o = context.oauth, opt = context.options;
  if (action === 'auth-status') return o.status();                       // { connected, configured, scopes }
  if (action === 'connect') return o.connect(['playlist-read-private'],  // opens the browser to sign in
    opt.oauthClientId ? { clientId: opt.oauthClientId, clientSecret: opt.oauthClientSecret } : undefined);
  if (action === 'disconnect') return o.disconnect();
  if (action === 'my-playlists') {                                       // use the token HERE, in main:
    const t = await o.getAccessToken();                                 // { accessToken, ... } or null
    if (!t) return { ok: false, error: 'not connected' };
    const r = await fetch('https://api.spotify.com/v1/me/playlists', { headers: { Authorization: 'Bearer ' + t.accessToken } });
    return { ok: true, playlists: await r.json() };                     // return RESULTS to the page, not the token
  }
}
```

`getAccessToken()` auto-refreshes. **Never return the token to your page** — make the API call in `server.js` and hand back only the data. Tokens/secrets are stored encrypted by the host.

## Platform Work

Only touch host/runtime code when the user explicitly asks to change the platform itself.

Platform files include app discovery, serving, editor behavior, IPC, packaging, build files, and local server behavior. When platform work is explicitly requested, prefer generic, reusable capabilities over app-specific hooks.

## Validation

- Parse edited JSON: `node -e "JSON.parse(require('fs').readFileSync('apps/<app-id>/app.json','utf8'))"`.
- Check JavaScript: `node --check apps/<app-id>/app.js` and `node --check apps/<app-id>/server.js` when present.
- Search for accidental host hooks: `rg -n "<app-id>|/api/<app-id>" app apps`.
- Confirm the app uses relative asset paths and no absolute legacy paths.

## QNAP Lesson

QNAP direct browser fetch can fail on TLS or CORS. If live LAN APIs must work from a drop-in app, use a generic host capability or app-local `server.js` rather than a specific host route.
