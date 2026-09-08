# Connecting Discord to Bedrock Panel

Connect the Discord account from the **Discord app settings**: select the page that uses the
Discord app in the editor, then use the **Discord account** card beneath its settings. By default,
Bedrock Panel uses its built-in Discord Application ID and requests the complete permission set that
the official application is configured to use.

Bedrock Panel uses OAuth 2.0 Authorization Code with PKCE as a public client. The callback is the
loopback URI `http://127.0.0.1:51120/callback`; there is no Client Secret. Access and refresh tokens
are kept in the main process and encrypted at rest.

## Custom Discord applications

A personal or team-owned Discord application can be selected from the Discord page's
**Advanced / developer overrides** section:

1. Create or select an application at <https://discord.com/developers/applications>.
2. Copy its Application ID.
3. Add the exact OAuth2 redirect URI `http://127.0.0.1:51120/callback`.
4. Enter the ID as **Custom Discord Application ID** and save.
5. Choose only the enhanced capability groups the application is allowed to use.
6. Connect or explicitly reconnect from the **Discord account** card in the Discord app settings.

Custom applications request Core by default. Voice, Messages, and Notifications are opt-in so one
unavailable enhanced permission cannot prevent otherwise usable Core authorization.

| Capability group | OAuth scopes | Behaviour when not granted |
|---|---|---|
| Core | `identify`, `rpc` | The local RPC integration cannot authenticate. |
| Voice | `rpc.voice.read`, `rpc.voice.write` | Voice state, devices, channel and participant controls are unavailable. |
| Messages | `messages.read` | Message history and live message events are unavailable. |
| Notifications | `rpc.notifications.read` | Discord notification events are unavailable. |

The same Authorization Code + PKCE implementation is used for personal and team-owned custom
applications. Discord's documentation only describes a team-specific restriction for the separate
Client Credentials grant; Bedrock Panel does not use that grant.

## Discord scope availability

Discord's [OAuth2 scope reference](https://docs.discord.com/developers/topics/oauth2#shared-resources-oauth2-scopes)
currently says:

- `identify` is generally available and exposes the current user's basic profile.
- `rpc` is only available to approved partners.
- `rpc.voice.read`, `rpc.voice.write`, and `rpc.notifications.read` are only available to approved partners.
- `messages.read` allows local RPC to read messages from client channels. The scope table does not
  clearly state whether this scope itself needs separate approval. Discord's
  [RPC documentation](https://docs.discord.com/developers/topics/rpc#authorize) says its optional RPC
  token flow disallows `messages.read`; Bedrock Panel does not use that Client Secret-based flow.

Discord's RPC documentation also says unapproved applications are restricted to users on the
application's tester list (up to 50) until approval. This is less precise than the scope table about
which approval controls each scope. Application ownership alone is not documented as granting every
enhanced scope, so Bedrock Panel does not infer entitlements from ownership or the Developer Portal UI.

Discord documents no supported API that reports an application's permitted OAuth scopes before the
user authorizes it. The `/oauth2/@me` endpoint and RPC `AUTHENTICATE` response report scopes only after
an access token exists. Custom scope choices therefore remain explicit; Bedrock Panel does not repeatedly
launch authorization to guess combinations.

## Scope changes and capability status

Requested and granted scopes are stored as non-secret metadata beside the encrypted token record.
When desired groups are added, the existing authorization remains usable for its already-granted
features and the Discord app settings show that an explicit reconnect is required. OAuth is never
opened silently during startup.

Changing the Application ID removes the incompatible stored Discord authorization. Reconnect is then
an explicit user action.

Panel features are enabled only when both conditions hold:

1. the required OAuth scope was actually granted; and
2. the current Discord RPC session successfully supports the command or event.

The Activity capability popover distinguishes a missing permission from an unsupported RPC operation
or a temporary runtime failure.

## Troubleshooting

| Symptom | Most likely cause / fix |
|---|---|
| Configured application rejected one or more requested permissions | Discord returned `invalid_scope`. For a custom app, turn off unapproved enhanced groups, save, and explicitly reconnect. Core itself includes approval-gated `rpc`, so the application may still need Discord approval or tester access. |
| Redirect URI error or callback timeout | Register `http://127.0.0.1:51120/callback` exactly and make sure local port 51120 is available. |
| Reconnect required after enabling a group | Expected: the stored token lacks the newly requested scope. Existing granted features remain usable until you choose Reconnect. |
| A granted feature still appears unavailable | Discord rejected or did not support the corresponding command/event in the current RPC session. Scope grant alone is not treated as proof of runtime support. |
