# Plan: optional "Claude token" setting

Status: **APPROVED 2026-11-09** with the recommended options and defaults. **Phase 0 (the spike)
is complete — every check passed**; see [Spike results](#spike-results). No app code has changed
yet. Scope is Claude only: Codex and Copilot were considered and dropped (see
[Out of scope](#out-of-scope)). Separate from `PROJECT.md` (the wake-word charter), which this
does not touch.

## TL;DR

Add one optional secret on the **Auth tab**: a Claude token made with `claude setup-token`.
When it is set, Bedrock Panel passes it as `CLAUDE_CODE_OAUTH_TOKEN` to the `claude` processes
it already starts. When it is empty, nothing changes. No new process, listener, or binary.

---

## Charter (CLAUDE.md #6)

**1. The one thing it must do.**
When a token is saved, every Claude feature in Bedrock Panel signs in with it: AI Voice (Claude
backend), meeting analysis (Claude), and LucidType AI (Claude). They keep working after the
interactive `claude auth login` session lapses.

**2. What would be wrong if it shipped "working" without it.**
- The token ends up in plaintext on disk, in a log, a URL, the panel renderer, or a crash report.
- An `ANTHROPIC_API_KEY` already in the environment quietly wins, so the token is never used,
  but the Auth tab says it is.
- An empty setting changes today's behavior in any way.
- The token runs out after a year with no warning, and the error still says `claude auth login`.

**3. Off-limits as workarounds.**
- Telling users to set a system-wide environment variable by hand.
- Shipping a token in the app, the default config, docs, tests, or fixtures.
- Writing the token into `~/.claude` or the CLI's own credential store.
- Passing the token as a command-line argument.
- A new helper process, a localhost listener, a shell, or `--bare` (which ignores the token).

**4. Deployment target and backup.**
Bedrock Panel public release (Windows first; macOS and Linux use the same code path). Changes go on
a feature branch with a PR, so git is the backup. No live host or user config is edited. Existing
user configs need no migration: a missing `claudeAuth` means "no token".

**5. How we verify it is done.** See [Verification](#verification). In short: with the CLI
signed out (simulated, without touching the real login), all three features work on the token.
With the field empty, behavior and errors match today. The token is encrypted in `config.json` and
appears in no log.

---

## What exists today (verified in this worktree)

| Feature | Spawn site | Env today |
|---|---|---|
| AI Voice (Claude) | `app/claudevoice-session.js:96`, long-running `-p` stream-json process | `Object.assign({}, process.env, {OQX_VOICE_*})` at `:115` |
| Meeting analysis (Claude) | `app/meetingAnalyze.js:1476-1480` via `runProc` (`:1555`) | none passed, so it inherits `process.env` |
| LucidType AI (Claude) | `app/lucidtypeAI.js:105-108` via `runProc` (`:120`) | none passed, so it inherits `process.env` |
| Editor "CLI installed?" probe | `app/main.js:4939` | `where claude` only, no auth |

`app/routines.js` starts no process of its own; routines run through the AI Voice session.
All three find the binary with `findClaudeExe` (`app/claudevoice-session.js:33`).

Sign-in error text lives in two places:
- `app/meetingAnalyze.js:132`: "Claude needs sign-in. On this PC run: claude auth login"
- `app/claudevoice-adapter.js:59-62`: "sign Claude Code back in: open a terminal… /login"

## Claude Code auth facts (checked 2026-11-09)

From [code.claude.com/docs/en/authentication](https://code.claude.com/docs/en/authentication)
and the local CLI help (v2.1.314):
- **Precedence:** cloud-provider vars → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` →
  `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → profile → `/login`. In `-p` mode an
  `ANTHROPIC_API_KEY` "is always used when present." (Confirmed in spike check D.)
- **`claude setup-token`:** makes a one-year OAuth token, prints it, and saves it nowhere. It
  needs a Pro, Max, Ultra, Team, or Enterprise plan.
- **Limits:** the token can only make model requests. It can't start Remote Control or load
  **claude.ai connectors**, but local MCP servers still work.
- **`--bare`:** never reads the token. Bedrock Panel doesn't use `--bare`.
- **`--safe-mode`** (used by meeting analysis): reads the token normally. (Confirmed in spike
  check B.)
- **`CLAUDE_CODE_SIMPLE`:** puts Claude in bare mode, which ignores the token. Claude Code sets it
  inside its own sessions, so a Bedrock Panel launched from an agent's shell would inherit it.

---

## Spike results (2026-11-09, all passed)

Run against claude 2.1.314. Token-free checks used a clean environment and bogus tokens; checks B,
E1, and E2 used a real `setup-token` through `tools/cli-token-spike.ps1`.

| Check | Result | What it settles |
|---|---|---|
| Empty `CLAUDE_CONFIG_DIR` | `loggedIn: false` | Simulates a signed-out CLI for the tests, without touching the real login |
| A. `auth status` with a bogus token | `loggedIn: true`, `authMethod: oauth_token`: **it does not validate the token** | Check shows which credential wins, not whether the token is valid; the card hint says so (Decision 2A) |
| B. **`claude -p --safe-mode` on a real token** | **PASS** (`OK`) | The token works with the exact flags meeting analysis uses |
| C. `claude -p` with a bogus token | `Failed to authenticate. API Error: 401 OAuth access token is invalid.` | The existing patterns already match "failed to authenticate"; only the message changes |
| D. Bogus token + dummy `ANTHROPIC_API_KEY` | `authMethod: api_key`: **the key wins** | Confirms Decision 1A is needed |
| Bogus token + a working normal login | **401, no fallback** | A bad or expired token breaks Claude features even while the normal login works, so the error text and the expiry warning matter |
| E1. **Tool command sees the token, no scrub** | **UNSET** | Claude Code already hides `CLAUDE_CODE_OAUTH_TOKEN` from the agent's Bash/PowerShell tools by default, so Decision 3 needs no action for Claude |
| E2. Same, with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` | UNSET | Consistent with E1 |

**What the results changed in this plan:**
- **Decision 3 is resolved with no work:** E1 shows the token is already invisible to the voice
  agent's tool subprocesses, so there is no scrub to add and nothing to document as exposed.
- **Error text gains "clear the token to use your normal login",** because a bad token does not
  fall back.
- **The Auth card trims whitespace/newlines from a pasted token** and warns if it doesn't look like
  a `sk-ant-oat…` token. (A real paste included trailing text and produced `401 Invalid bearer
  token`; the app should catch that before it reaches the CLI.)

---

## Design

### Setting
`settings.claudeAuth = { token: '', createdAt: '' }`
- `token` is a **secret**. It is added to `app/secretStore.js` (header list and walker), so it is
  stored as `oqenc:v2:` (DPAPI) on Windows and with safeStorage elsewhere. It is plaintext only in
  memory, the same path as `settings.owui.apiKey`.
- `createdAt` (`YYYY-MM-DD`) is not secret. It is set to today when the token value changes, and the
  user can edit it if they pasted an older token. Expiry is `createdAt` plus 365 days.

### Where it shows
A new **"Claude Code"** card on the **Auth tab** (`app/config.js:5091`, beside Home Assistant,
Open WebUI, and OBS). It holds:
- Token field (`secretInput`, with the existing show/hide eye) and a Created date field. On paste,
  the field strips surrounding whitespace and newlines, and warns if the value doesn't start with
  `sk-ant-oat`.
- Status pill: *Not set* / *Set, expires about 2027-11-09* / amber *Expires in N days* /
  red *Probably expired*.
- **Check** button: `claude auth status --json` with the child env (Decision 2A). It spends no
  tokens and shows which credential Claude would use (`oauth_token` means the token wins). It does
  not prove the token is still valid (spike A), and the hint says so.
- Hint: how to make one (`claude setup-token` in a terminal, plans that qualify), that it is
  encrypted at rest, that it is used only by Bedrock Panel's Claude features, and that claude.ai
  connectors won't load in AI Voice while it is set.

### How it is applied
A new small pure module, `app/claudeAuth.js`, with
`claudeChildEnv(baseEnv, claudeAuth) → env`:
- **Token empty:** returns `baseEnv` unchanged. No key is added or removed, so today's behavior is
  byte-for-byte the same.
- **Token set:** copies `baseEnv`, sets `CLAUDE_CODE_OAUTH_TOKEN`, and removes the variables that
  would override or disable it: `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` (Decision 1A) and
  `CLAUDE_CODE_SIMPLE` (bare mode ignores the token). Cloud-provider vars
  (`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`) are left alone and only warned about, because they mean
  a deliberate enterprise setup. `apiKeyHelper` lives in a settings file we don't touch, so Check
  shows it through `authMethod`.

`main.js` injects a `getClaudeEnv()` getter into the three modules. Each one uses it on its Claude
path. Codex, Copilot, and Open WebUI get nothing new.
- `claudevoice-session.js:115` builds its env from `getClaudeEnv()` instead of `process.env`,
  then adds the `OQX_VOICE_*` keys as now.
- `meetingAnalyze.js` and `lucidtypeAI.js`: `runClaude` passes `env` through `runProc` (a new
  optional argument). `runCodex`, `runCopilot`, and the others are unchanged.

**When a change takes effect:** meeting analysis and LucidType start a new process for each call,
so a new token applies on their next call. AI Voice reads it when its session next starts. A
running session keeps its current sign-in, and the card hint says so.

### Expiry warning
Expiry is `createdAt` plus 365 days; the docs give no exact date, so the UI says "about".
- Auth card pill, always visible.
- One desktop notification per app start (the existing `Notification` path, `main.js:117`) once
  fewer than 30 days remain. It says: "Your Claude token expires in about N days. Make a new one
  with `claude setup-token` and paste it on the Auth tab."

### Error text
- **Token set and the CLI reports an auth failure:** "Claude rejected the saved token (it may have
  expired or been revoked). Make a new one with `claude setup-token` and paste it on Settings →
  Auth — or clear the token to use your normal Claude login."
- **No token:** today's text, plus "…or save a long-lived token on Settings → Auth."
- Both `meetingAnalyze.js:132` and `claudevoice-adapter.js:59-62` change. `AUTH_FAILURE_RE` and
  `SIGN_IN_FAILURE` gain `invalid bearer token` alongside the existing patterns.

### Secret hygiene (public app)
- Each user makes their own token. The default config ships `token: ''`.
- The token is never logged. A test checks that a fake token string never appears in any captured
  log line or spawn argument.
- It never goes into a URL, `sysserver` route, command line, panel renderer, or the `ai-voice` page
  options. Only the editor window sees it, the same way it sees the Open WebUI key today.
- The editor IPC for Check is guarded with `isFrom(e, configWin)`, like every other handler.

### EDR (CLAUDE.md #16)
The only runtime change is one env var added to (and up to three removed from) the `claude`
processes Bedrock Panel already starts without a shell. There is no new binary, helper, listener,
socket, or download. The one extra launch is **Check**, a short `claude auth status` run of the
same binary, only when the user clicks it.

---

## Decisions (all settled)

- **1A:** when a token is set, remove `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child
  env only. Confirmed necessary by spike D.
- **Also remove `CLAUDE_CODE_SIMPLE`** from the child env when a token is set (it would put Claude
  in bare mode, which ignores the token). Reversible default.
- **2A:** Check runs `claude auth status --json`. It spends no tokens; it shows which credential
  wins, not validity (spike A).
- **3 — no action:** spike E1 shows Claude already hides the token from the voice agent's tool
  subprocesses, so there is nothing to scrub or document.
- **Defaults:** one global setting on the Auth tab; `createdAt` filled automatically and editable;
  a voice session picks up a new token at its next start, with no forced restart; expiry
  notification once per app start within 30 days plus the card pill.

---

## Build steps (Phase 1, after this plan)

Phase 0 (the spike) is done. Phase 1 is the code, on a branch from `main`:
1. `app/claudeAuth.js`: `claudeChildEnv`, `tokenExpiry(createdAt, now)`, message builders, and the
   paste-sanitize/validate helper.
2. `app/secretStore.js`: header comment and walker for `settings.claudeAuth.token`.
3. `app/config.default.json`: `"claudeAuth": { "token": "", "createdAt": "" }`, plus a
   `claudeAuthSettings()` defaulting getter in `main.js`.
4. Three spawn sites: `claudevoice-session.js` (`getEnv` option), `claudevoice-adapter.js`
   (pass it through and the new message), `meetingAnalyze.js` and `lucidtypeAI.js`
   (`env` on `runProc` for the Claude path only).
5. `main.js`: wire the getter, the Check IPC (`testClaudeToken`, guarded), and the startup expiry
   notice. `config-preload.js`: expose Check. `config.js`: the Auth card with paste-sanitize.
6. Error text in both places, and the `invalid bearer token` pattern addition.
7. Docs: `docs/ai-voice.md` (~288), `docs/meeting.md` (~101), the LucidType guide, and a short
   "Claude token" section covering how to make one, plans, limits, expiry, and connectors.

**Phase 2: verification** (below), then a PR. Nothing goes to `main` without an explicit merge.

## Verification

**Unit tests** (`npm test`, `node:test`):
- `claudeChildEnv`: empty token gives the same object contents; with a token, the var is set and
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_SIMPLE` are removed; other vars are
  untouched.
- the paste helper: trims whitespace/newlines, and flags a value that isn't `sk-ant-oat…`.
- `secretStore`: the token round-trips encrypted, and an empty token is skipped.
- `tokenExpiry`: pill states at 31, 30, 1, 0, and -1 days.
- `meetingAnalyze` and `lucidtypeAI`: the Claude spawn receives the env, and the Codex/Copilot
  spawns don't (extending the existing fake-spawn tests).
- `claudevoice-session`: the spawn env contains the token, plus the existing `OQX_VOICE_*` keys.
- A fake token never appears in any captured log line or spawn argument.

**Manual** (`npm start`, simulated signed-out CLI as in the spike):
- [ ] Meeting analysis, LucidType cleanup and rewrite, and AI Voice turns all succeed on the token.
- [ ] **A long AI Voice session:** idle for 2 hours or more, then a turn, with no 401. This covers
      the reported long-session issue.
- [ ] Field empty: same behavior and the same errors as today.
- [ ] A bogus token gives the new "rejected the saved token" text in all three features.
- [ ] A token pasted with trailing text is cleaned and still works (regression for the 2026-11-09
      paste).
- [ ] `config.json` shows `oqenc:v2:` for `claudeAuth.token`, and the app log has no token.
- [ ] The Auth card works in light and dark themes, and Check reports `authMethod` correctly.

## Out of scope
- **Copilot.** Considered and dropped on 2026-11-09: the Copilot CLI here is not signed in through a
  personal GitHub account, so a `COPILOT_GITHUB_TOKEN` is not the arrangement, and the spike's
  Copilot checks did not apply.
- **Codex.** A ChatGPT plan has no long-lived token. The only long-lived option is an API key
  (`CODEX_API_KEY`), billed per token at API rates. Codex's own sign-in refreshes itself while in
  use, so it lapses less often.
- Making or rotating the token for the user; `setup-token` needs their browser sign-in.
- Open WebUI and API-backend auth.
- Revocation instructions, which are undocumented. Clearing the field stops Bedrock Panel using
  the token.
