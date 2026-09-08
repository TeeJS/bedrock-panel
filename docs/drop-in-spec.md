# Drop-in apps — integration specification

**Audience:** maintainers of Bedrock Panel forks (or compatible launchers) who want to support
**drop-in apps** — self-contained app folders a user installs at runtime without rebuilding.

**Spec version:** 1 · **Reference implementation:** Bedrock Panel (formerly open-quake) ≥ 0.3.0.

This document is normative for the **package format** and the **runtime/security contract**: an
app authored against this spec MUST run unmodified on any conforming host, and a host MUST NOT
weaken the security rules in §6. The §7 manager and §9 file map describe *how* the reference
implementation does it — adapt those freely as long as §2–§6 hold.

Keywords **MUST / SHOULD / MAY** are used in the RFC 2119 sense.

---

## 1. Concept and invariants

A drop-in app is a folder containing a **manifest** (`app.json` or `manifest.json`) plus its
web assets. The host discovers it, lists it in the editor, and renders it full-screen on the
panel as an app page. Two delivery modes exist: **static** (`file://`) and **served** (a local
loopback HTTP server).

Design invariants a conforming host MUST preserve:

1. **Update-safe storage.** Drop-in apps live in a per-user data folder, never in the install
   directory, so updating the host never deletes them (§3).
2. **Path containment.** An app can only read/serve files inside its own folder (§6.1).
3. **Informed consent for host code.** Installing an app that can run code on the host
   (a server module or bundled executables) MUST warn the user first (§6.3).
4. **Loopback isolation.** The served-app HTTP server is reachable only by the host's own
   pages, and only over loopback (§6.2).

---

## 2. Package format

### 2.1 Folder layout

```text
<app-id>/
  app.json          # or manifest.json
  index.html        # the entry document
  app.js  style.css # any other assets (served/loaded relative to the folder)
  server.js         # OPTIONAL host-side Node module (served apps only — see §5.1)
```

### 2.2 Manifest

`app.json` (preferred) or `manifest.json`, UTF-8 JSON:

```json
{
  "id": "my-app",
  "name": "My App",
  "entry": "index.html",
  "served": false,
  "options": [
    { "key": "host",  "label": "Server URL", "type": "text" },
    { "key": "token", "label": "API token",  "type": "secret", "serverOnly": true }
  ],
  "server": "server.js",
  "oauth": {
    "name": "Example account",
    "clientId": "public-client-id",
    "authUrl": "https://identity.example/authorize",
    "tokenUrl": "https://identity.example/token",
    "scopes": ["profile.read"]
  },
  "proxy": { "methods": ["GET"], "verifySslOption": "verifySsl", "allow": [{ "option": "host" }] }
}
```

(This example is illustrative, composing every field in one manifest — no single real app
uses all of them at once. See `apps/apps.json` or any `community-apps/` folder for real ones.)

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | **yes** | Stable identifier. MUST match `^[a-z0-9][a-z0-9_-]*$`. Folder name SHOULD equal it. |
| `name` | string | no | Display name. Defaults to `id`. |
| `entry` (alias `file`) | string | **yes** | Relative path to the entry document. MUST pass the safe-path rule (§2.4). |
| `served` | bool | no | `false` = static `file://`; `true` = served over loopback HTTP. Default `false`. |
| `editor` | object | served only | Optional interactive editor management surface: `{ "entry": "index.html", "label": "Manage app" }` (§4.4). Its entry MUST pass the same safe-path rule as `entry`. |
| `options` | array | no | User-set option descriptors (§2.5). Default `[]`. |
| `server` | string | served only | Relative path to a host-side Node module (§5.1). Triggers the exec-code warning on import. |
| `serverAutoStart` | bool | served only | When `true`, the host loads the `server` module at startup (and again after the app is installed or updated) instead of on the first `/app-api` call — for apps whose server runs background work such as schedules. Default `false`: request/response-only servers SHOULD stay lazy. |
| `oauth` | object | served only | App-scoped OAuth provider definition (§5.5). |
| `proxy` | object | served only | Outbound-fetch allow-list for the app's page (§5.2). |
| `knob` | bool | served only | `true` = the panel knob defaults to "App controlled" on this app's pages, delivering knob events to the page's `window.oqKnob` (§5.4). Default `false`. |
| `grid` | object | served only | OPTIONAL embedded editable tile grid carried by the app: `{ cols, rows, defaults }` (column/row count + default tile contents). MAY be ignored by a host that doesn't support in-app grids. |
| `hideGridInEditor` | bool | no | When `true`, the editor hides this app's embedded-grid controls (the app manages its own layout). Default `false`. |
| `hostCapabilities` | array | served only | Host-mediated capabilities the app requests (§5.6). Recognized values: `"pick-folder"`. Unknown values MUST be ignored (forward compatibility). Default `[]`. |

A host MUST ignore unknown manifest keys (forward compatibility).

### 2.3 `id` rules

`id` MUST match `^[a-z0-9][a-z0-9_-]*$` (lowercase alphanumeric, `_`, `-`; not starting with
`-`/`_`). A folder whose manifest `id` is missing or invalid MUST be skipped, not loaded.

### 2.4 Safe-path rule (entry, server, served files)

Any manifest-supplied relative path, and any served request path, MUST be rejected if, after
normalizing `\` → `/`, it:

- contains `..`, or
- starts with `/`, or
- is absolute, or
- carries a scheme/drive prefix (matches `^[A-Za-z][A-Za-z0-9+.-]*:`).

Resolved paths MUST additionally be confirmed to stay inside the app root (string-prefix check
against `root + path.sep`). This is the core of §6.1.

### 2.5 Option descriptors

Each entry of `options` describes one user-configurable value the editor renders:

| Key | Meaning |
| --- | --- |
| `key` | Option name; becomes the URL param / hash key and the `options` map key. |
| `label` | Editor label. |
| `type` | `text` \| `bool` \| `secret` \| `select` \| (host-defined extras). `bool` is coerced to a real boolean. |
| `default` | Default value when unset. |
| `choices` | **Required for `type: "select"`.** Array of `[value, label]` pairs the editor renders as a dropdown. |
| `help` | Optional help text shown under the field in the editor. |
| `showIf` | Optional conditional visibility: `{ key, value }` — this field only renders when the option named `key` currently equals `value`. Lets an option's own fields hide/show based on a sibling (e.g. a set of manual fields that only appear when a "use defaults" toggle is off). |
| `serverOnly` | If `true`, the value is **never** placed in the page URL — it reaches the app only via the host-side server adapter / `/app-config` (§5.3). |

`type: "secret"` values MUST be stored encrypted at rest and MUST NOT appear in the page URL;
they are delivered only through the same-origin config route (§5.3).

---

## 3. Storage and discovery

### 3.1 Where apps live

Drop-in apps MUST be discovered **only** from a per-user data folder, never the install dir:

```
%APPDATA%\bedrock-panel\apps\        (default)
%LOCALAPPDATA%\bedrock-panel\apps\   (when the user selects the "localappdata" location)
```

The location is a host setting (`settings.dropInLocation`: unset/`appdata` → `%APPDATA%`,
`localappdata` → `%LOCALAPPDATA%`). The host MUST create this folder on startup and import into
it. Non-Windows hosts SHOULD use the platform-equivalent per-user data dir (e.g.
`~/.config/bedrock-panel/apps`).

> Rationale: the install directory is overwritten on update. Bundled first-party apps may ship
> in the install tree, but **user** drop-ins must survive updates, so they live in user data.

### 3.2 Scan algorithm

For each immediate subdirectory of the apps folder:

1. Read `app.json` or `manifest.json`; skip the folder if neither parses.
2. Validate `id` (§2.3) and `entry` (§2.4); skip on failure (log a one-time warning).
3. **Dedup by `id`, first registration wins.** Bundled apps are registered before drop-ins, so a
   drop-in MUST NOT shadow a bundled app of the same `id`.
4. If `served`, register the app's root (+ optional `proxy`, `server`) with the loopback server.

Discovery is recomputed on demand (and after any import/delete), so newly added folders appear
without a restart.

---

## 4. Runtime modes

### 4.1 Static (`served: false`)

The host loads the entry document directly via `file://`. Because a `file://` URL drops its
query string, options are passed in the **hash**:

```
file:///…/<app-id>/index.html#host=example.com&theme=dark&_grid=1
```

Only non-secret, non-`serverOnly` options are included. The host MAY append its own hash params
(e.g. theme, a `_grid=1` hint when a native button strip is shown). Best for self-contained
HTML/CSS/JS with no live host data.

### 4.2 Served (`served: true`)

The host serves the app folder over a loopback HTTP server and navigates the panel to it.
Options are normal query params (secrets/`serverOnly` excluded):

```
http://127.0.0.1:<port>/apps/<app-id>/<entry>?host=example.com&theme=dark
```

`<port>` is ephemeral — the app MUST use **relative** URLs / same-origin `fetch`, never a
hard-coded port. Use served mode when the app needs same-origin `fetch`, a secure context
(e.g. microphone), or host-side helpers (§5).

### 4.3 Served static files

`GET /apps/<app-id>/<relative-path>` serves files from the app root, subject to §2.4
containment. Unknown app id or escaping path → `404`/`403`.

### 4.4 Interactive editor management surface (`editor`)

A served drop-in MAY own its desktop management UI instead of requiring app-specific editor
code. Declare a contained entry and a short section label:

```json
"editor": { "entry": "index.html", "label": "Manage sync jobs" }
```

The editor embeds that page as an interactive sandboxed iframe on the app page editor. It loads
from the app's normal loopback origin with the page's non-secret options, theme parameters, and
`_surface=editor`. The app may use that hint to switch from its fixed panel layout to a responsive
desktop layout. Because the page remains under `/apps/<id>/…`, relative `/app-api/*`, `/app-host/*`,
and `/app-proxy` requests retain the existing same-origin and per-app Referer gates.

The iframe receives scripts, forms, and same-origin access, but no preload, Node, raw IPC, or
parent-editor access. App-owned changes SHOULD persist through the app's server API and take effect
immediately; they are not part of the editor's global **Save & apply** transaction. The editor MUST
say so beside the surface. Hosts that do not implement this optional extension ignore `editor` and
continue to show the ordinary panel preview.

---

## 5. Host-side extensions (served apps only)

### 5.1 Server module (`server`)

`server` names a Node module inside the app folder that the host `require`s on first use (only
if the resolved path is inside the app root) — or at startup when the manifest sets
`serverAutoStart: true`, so module-level timers/schedules arm without waiting for a page
visit. A load error MUST be logged and skipped, never break host startup. It MUST export:

```js
exports.handle = async function (action, context) {
  // context = { appId, query, options, body, oauth, host }
  //   appId   : string  — this app's id
  //   query   : object  — parsed query params of the /app-api/<action> request
  //   options : object  — the app's resolved options (incl. secrets and serverOnly)
  // return a JSON-serializable value; { ok: false, error: 'unknown action' } -> HTTP 400
  if (action === 'feed') return { ok: true, items: await loadFeed(options.host) };
  return { ok: false, error: 'unknown action' };
};
```

The page calls it with `fetch('/app-api/<action>?…')`. The host resolves the **requesting app
id from the `Referer`** (it MUST be one of our own `/apps/<id>/…` pages), so an app can only
reach its own server module. Exceptions become HTTP 500 `{ ok:false, error }`.

If no server module is present, the host still answers a built-in `/app-api/open?url=…` action
that opens an `http(s)` URL in the user's external browser (host's `openExternal`). A fork MAY
offer additional built-in actions but MUST keep them side-effect-safe and same-origin-gated.

`body` is a raw `Buffer` for POST requests and `null` for GET. `oauth` is present only when the
manifest declares §5.5. The reference host also exposes trusted platform operations through
`host` to installed server modules; these are host-specific, and server modules already run with
the full privileges described in §6.3.

### 5.2 Outbound proxy (`proxy`)

Served apps cannot fetch arbitrary cross-origin URLs from the page. To reach an allowed remote,
the page calls `GET /app-proxy?url=<encoded>`; the host fetches server-side and returns the
body. The manifest `proxy` block governs what's allowed:

| `proxy` key | Meaning |
| --- | --- |
| `methods` | Allowed methods. The reference host proxies **GET only**; a block that excludes `GET` is denied. |
| `allow` | Array of allow-rules (below). Empty/absent ⇒ nothing is proxied. |
| `verifySslOption` | Name of a `bool` option; when the user sets it `false`, TLS verification is skipped for this app's proxy fetches (for self-signed LAN hosts). |

Allow-rules:

- `{ "option": "host" }` — allow requests whose origin+path are under the URL the user stored in
  option `host`. This is how an app reaches its **configured** server, **including private/LAN
  addresses**.
- `{ "pattern": "<regex>" }` — allow requests whose full URL matches the regex, **but
  private/loopback/LAN hosts are always blocked for pattern rules** (anti-SSRF). Use this only
  for fixed public endpoints.

The reference proxy also enforces: `http`/`https` only, ≤ 5 MB response, 12 s timeout, ≤ 3
redirects. A conforming host MUST keep the private-host block on `pattern` rules and the
per-app `Referer` check.

`GET /app-proxy/config` returns the requesting app's resolved config (same data as §5.3) for an
app that needs its options server-trip-free.

### 5.3 Secret / server-only delivery (`/app-config`)

`GET /app-config?app=<id>` returns `{ app, options }` with the app's **fully resolved** options
— including `secret` and `serverOnly` values and `bool` coercion. This route is **same-origin
gated** (§6.2), so only the host's own served page can read it. This is the only channel by
which secrets reach a served app; they are never in the URL.

### 5.4 Panel knob (`knob`, `window.oqKnob`, `OQX_RING::`)

An app that declares `"knob": true` gets the panel's rotary knob routed to its page by default:
every gesture's mode resolves to **"App controlled"** for that app's pages (the user's Hardware-tab
per-page-type settings and the per-page Advanced knob override still win). Users can also select
"App controlled" manually for any page.

**Receiving events.** The page defines a single global:

```js
window.oqKnob = function (ev) {
  // ev is the VERBATIM hardware vocabulary:
  //   { type:'rotate', dir: 1 | -1 }        one detent; clockwise = 1
  //   { type:'press',  index: 1 | 2 }       single / double click (detected in hardware)
  //   { type:'hold',   phase:'start'|'end' }
  // Return false to DECLINE this event — the panel then performs its base default for the
  // gesture (rotate -> page cycling, press -> rotation toggle / page selector, hold -> the
  // push-to-talk injection). Any other return value counts as consumed.
};
```

Only the **active** page ever receives events (the injection targets the foreground webview).
If the page hasn't loaded yet or never defines `oqKnob`, the knob falls back to its normal
behavior — the knob is never dead. `hold` is offered to `oqKnob` first on app-controlled pages;
declined holds fall through to the `window.pttStart`/`window.pttStop` push-to-talk hooks.

**Driving the knob LED ring.** Any served page may set the ring while it is active via the
console-tag channel: `console.log('OQX_RING::<state>')` with a named state
(`listening | thinking | speaking | approval`), `idle` to release it, or a custom value:

```js
console.log('OQX_RING::custom:' + JSON.stringify({ hue: 200, sat: 255, effect: 1, speed: 128 }));
```

`hue`/`sat`/`speed` are 0–255, `effect` is a QMK RGB-Matrix id 0–43; fields are optional and
clamped; malformed payloads are ignored. Brightness always follows the user's setting, and the
host restores the normal ring automatically when the page changes.

### 5.5 App-scoped OAuth (`oauth`, `context.oauth`)

A served app MAY declare an OAuth public client with `name`, `authUrl`, `tokenUrl`, optional
`revokeUrl`, `scopes`, and optional fixed public `clientId`. Authorization and token endpoints
MUST use HTTPS. The host registers it only as `app:<app-id>`; an app MUST NOT choose or access a
global provider id.

The app's server module receives `context.oauth` with `status()`, `connect(scopes, credentials?)`,
`disconnect()`, and `getAccessToken(scopes)`. Every operation is already bound to the requesting
app id. Tokens remain in the host process and MUST NOT be returned to page JavaScript. Apps without
a fixed public `clientId` MAY collect client credentials as secret/server-only options and pass
them to `connect`; fixed public clients SHOULD declare `clientId` in the manifest.

The reference editor also shows account status, Connect/Reconnect, declared permissions, and
Disconnect controls inside the settings for every app page whose installed manifest declares
`oauth`. A healthy connected account collapses to a one-line summary with a **Manage**
expander; first connect, errors, and expired tokens render the full controls so recovery is
never hidden. An app that ships its own complete connect/disconnect UI MAY set
`"oauth": { …, "selfManaged": true }` to suppress the editor's account panel entirely —
provider registration and `context.oauth` are unchanged, and the app then owns first-connect
and recovery (including disconnect) itself. Those controls use the same `app:<app-id>` binding; app OAuth providers do not appear in
the global OAuth settings list. An app may additionally expose the lifecycle in its panel UI
through its server module, as long as tokens remain inside the host process.

### 5.6 Host-mediated folder picker (`hostCapabilities: ["pick-folder"]`)

A served app that declares `"hostCapabilities": ["pick-folder"]` may ask the user to choose a
directory. The page calls the reserved `/app-host/` namespace (never routed through the app's
own server module, so `/app-api/*` actions cannot intercept it):

```js
const r = await fetch('/app-host/pick-folder', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ defaultPath: currentValue }),   // optional; absolute Windows/UNC only
}).then(res => res.json());
```

Responses:

- `200` `{ "ok": true, "path": "D:\\Selected\\Folder" }` — the directory the user selected
- `200` `{ "ok": false, "canceled": true }` — the user dismissed the dialog (normal)
- `409` `{ "ok": false, "code": "busy", "error": "A folder picker is already open" }`
- `503` `{ "ok": false, "code": "unavailable", "error": "Folder picker unavailable" }`
- `400` malformed body · `403` missing capability / unregistered app · `405` non-POST

Guarantees a conforming implementation MUST keep:

- Served drop-ins only, same-origin gated, requester resolved via the `Referer` app id — an
  app without the exact `pick-folder` capability gets `403`.
- POST only; paths never appear in URLs, query strings, or host logs.
- The host constructs the dialog itself: directory selection only, fixed host-generated title;
  the app supplies nothing but an optional `defaultPath` (string, ≤ 4096 chars). Relative
  input is ignored — never resolved against the host's working directory.
- The page receives ONLY the directory the user explicitly selected. The host does not read,
  enumerate, create, or validate it, and the app gains no filesystem, Electron, or IPC access.
- One picker dialog globally at a time (`busy` otherwise), with a short per-app cooldown after
  the dialog closes.

This capability is an OPTIONAL host extension — it is not part of the §8 cross-fork
compatibility contract; apps SHOULD degrade gracefully (e.g. fall back to a typed path field)
when `/app-host/pick-folder` answers `404`/`503`.

---

## 6. Security model (normative)

A conforming host MUST implement all of the following.

### 6.1 Path containment

Every manifest path and every served request path passes §2.4, **and** the resolved absolute
path is verified to equal the app root or start with `root + separator`. Reject with `403`
otherwise. Applies to: `entry`, `server`, and all `/apps/<id>/…` requests.

### 6.2 Loopback isolation

The served server binds `127.0.0.1` only, and:

- **Host-header check (anti-DNS-rebinding):** every request whose `Host` is not
  `127.0.0.1:<port>` or `localhost:<port>` is rejected `403`. Browsers set `Host` from the URL
  and page JS cannot forge it, so this defeats rebinding.
- **Same-origin gate:** all **side-effecting, live-data, and secret** routes (`/app-config`,
  `/app-proxy`, `/app-proxy/config`, `/app-api/*`, plus host routes like launch/media/metrics)
  require `Sec-Fetch-Site: same-origin` (with an `Origin`-based fallback that fails closed). Only
  the static page + asset routes are reachable by top-level navigation.
- **No global OAuth-token API:** same-origin request metadata is not app or native-process
  authentication. A served or drop-in app MUST NOT receive another provider's OAuth access or
  refresh tokens. App OAuth is exposed only to that app's trusted server module through the
  `app:<app-id>`-bound §5.5 facade; tokens MUST never be returned to page JavaScript.

### 6.3 Informed consent for host code (import warning)

On import, before installing, the host MUST detect whether the package can run code on the host
and, if so, warn the user and require explicit confirmation. "Can run host code" means:

- the manifest declares a `server` module, **or**
- the folder bundles an executable/script by extension: `.exe .dll .com .scr .msi .bat .cmd
  .ps1 .psm1 .vbs .vbe .wsf .wsh .jar .sh .cpl` (recursively).

Client-side `.js` runs sandboxed in the webview and is **not** flagged. A server module or
native binary runs with the **full privileges of the host process** — there is no sandbox. The
warning text SHOULD make the trust decision explicit (e.g. *"This drop-in app contains
executable code; only import it if you trust the source."*).

### 6.4 Content-Security-Policy

Served responses carry a restrictive CSP and `Cache-Control: no-store`. A fork SHOULD keep a CSP
that confines app pages to same-origin resources.

---

## 7. Manager operations (reference)

The editor's **Settings → Drop-In Apps** tab is backed by these host operations. A fork MAY
expose them however it likes; the **behaviors** matter, not the transport.

| Operation | Behavior |
| --- | --- |
| **list** | Enumerate installed drop-in apps: `{ id, name, served, hasServer, managed }`. `managed` = lives in the user-data dir (only those can be exported/deleted). |
| **import(zip, forceId?, confirmExec?)** | Unzip to a temp dir; locate the app root (`findAppRoot`: manifest at top level or in a single subfolder); run the §6.3 exec check (unless `confirmExec`); on id conflict return a rename prompt (retry with `forceId`); rewrite `manifest.id` if renamed; move into `<apps>/<id>`. |
| **export(id)** | Zip the app folder to a user-chosen path (managed apps only). |
| **delete(id)** | Remove the app folder — **only** if it resolves inside the user-data dir. |
| **refresh** | Recompute discovery (also done automatically after import/delete). |
| **getInfo / setLocation** | Read/switch the storage location (§3.1); switching affects where new imports land. |

Import results are a tagged union: `{ ok:true, id, name }` · `{ ok:false, warnExec:true, id,
server }` (needs `confirmExec`) · `{ ok:false, conflict:true, id }` (needs `forceId`) ·
`{ ok:false, error }`.

Reference IPC channel names (renderer → main): `listDropInApps`, `pickZip`,
`importDropInApp(zipPath, forceId, confirmExec)`, `exportDropInApp(id)`, `deleteDropInApp(id)`,
`getDropInInfo`, `setDropInLocation(loc)`, `openExternal(url)`.

The reference implementation zips/unzips via Windows `Expand-Archive` / `Compress-Archive` (no
extra dependency); a cross-platform fork SHOULD substitute a portable zip library.

---

## 8. Cross-fork compatibility contract

For an app authored against one fork to install and run on another, all conforming hosts MUST
agree on:

1. The manifest schema and field semantics (§2), including `id`/path rules.
2. Static option delivery via URL **hash**; served option delivery via **query**; secrets and
   `serverOnly` excluded from both (§4, §5.3).
3. The served route shape: `/apps/<id>/<entry>`, `/app-config?app=<id>`, `/app-proxy?url=…`,
   `/app-proxy/config`, `/app-api/<action>`.
4. The server-module contract: `exports.handle(action, { appId, query, options, body, oauth })` (§5.1).
5. The proxy allow-rule semantics and the private-host block on `pattern` rules (§5.2).

Hosts MAY add fields/routes/option types beyond these; apps relying on extensions are
host-specific and SHOULD degrade gracefully where the extension is absent.

---

## 9. Reference file/function map (Bedrock Panel)

| Concern | Where |
| --- | --- |
| Manifest parse, id/entry validation, discovery | `app/main.js` — `SAFE_APP_ID`, `safeAppEntry`, `readFolderAppManifest`, `scanAppDir`, `appCatalog` |
| User-data location | `app/main.js` — `dropInDir`, `ensureDropInDir` |
| App-page URL (static hash / served query) | `app/main.js` — `appPageUrl`, `appOptionQuery` |
| Import / export / delete / exec-check | `app/main.js` — `importDropInApp`, `exportDropInApp`, `deleteDropInApp`, `findAppRoot`, `RISKY_EXT`, `folderHasExecutable`, `listDropInApps` |
| Served static files + containment | `app/sysserver.js` — `serveDropInApp` |
| Proxy + SSRF guards | `app/sysserver.js` — `proxyAllowed`, `privateHost`, `verifySslFor`, `proxyFetch`, `serveAppProxy` |
| Server module + API | `app/sysserver.js` — `appServer`, `serveAppApi` |
| Loopback hardening | `app/sysserver.js` — `hostOk`, `sameOrigin`, `requestingAppId` |
| Manager bridge | `app/config-preload.js`, IPC handlers in `app/main.js` |
| Author guide / template | `docs/apps.md`, `docs/app-template/` |

---

*See also: [Apps & drop-ins](apps.md) (app-author guide) and
[Community apps](community-apps.md) (distribution).*
