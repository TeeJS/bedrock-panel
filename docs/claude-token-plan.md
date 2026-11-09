# Plan: optional Claude and Copilot token settings

Status: **APPROVED 2026-11-09** with the recommended options (1A, 2A, 3A) and the listed
defaults. Phase 0: the token-free checks are done (see [Spike results](#spike-results)), and
`tools/cli-token-spike.ps1` is ready for the checks that need real tokens. No app code has
changed yet. Separate from `PROJECT.md` (the wake-word charter), which this does not touch.

## TL;DR

Add two optional secrets on the **Auth tab**:
- A **Claude token** from `claude setup-token`, passed as `CLAUDE_CODE_OAUTH_TOKEN`.
- A **GitHub Copilot token** (a fine-grained GitHub token), passed as `COPILOT_GITHUB_TOKEN`.

Each one goes only to the CLI processes Bedrock Panel already starts for that backend. When a
field is empty, nothing changes. No new process, listener, or binary.
Codex is not included; see [Out of scope](#out-of-scope).

---

## Charter (CLAUDE.md #6)

**1. The one thing it must do.**
When a token is saved, every feature that uses that CLI signs in with it, so the feature keeps
working after the interactive login lapses:
- **Claude:** AI Voice (Claude backend), meeting analysis, and LucidType AI.
- **Copilot:** AI Voice (Copilot backend), meeting analysis, and LucidType AI.

**2. What would be wrong if it shipped "working" without it.**
- A token ends up in plaintext on disk, in a log, a URL, a command line, the panel renderer, or a
  crash report.
- An `ANTHROPIC_API_KEY` already in the environment quietly wins, so the Claude token is never
  used, but the Auth tab says it is.
- An empty field changes today's behavior in any way.
- A token runs out with no warning, and the error still says to log in again.

**3. Off-limits as workarounds.**
- Telling users to set a system-wide environment variable by hand.
- Shipping a token in the app, the default config, docs, tests, or fixtures.
- Writing a token into `~/.claude`, `~/.copilot`, or either CLI's credential store.
- Passing a token as a command-line argument.
- A new helper process, a localhost listener, a new shell, or `--bare` (which ignores the Claude
  token).

**4. Deployment target and backup.**
Bedrock Panel public release (Windows first; macOS and Linux use the same code path). Changes go on
a feature branch with a PR, so git is the backup. No live host or user config is edited. Existing
user configs need no migration: a missing `claudeAuth` or `copilotAuth` means "no token".

**5. How we verify it is done.** See [Verification](#verification). In short: with each CLI
signed out (simulated, without touching T.J.'s real logins), all six feature paths work on their
token. With the fields empty, behavior and errors match today. The tokens are encrypted in
`config.json` and appear in no log.

---

## What exists today (verified in this worktree)

| Feature | Spawn site | Env today |
|---|---|---|
| AI Voice (Claude) | `app/claudevoice-session.js:96`, long-running `-p` stream-json | `Object.assign({}, process.env, {OQX_VOICE_*})` at `:115` |
| Meeting analysis (Claude) | `app/meetingAnalyze.js:1476-1480` → `runProc` `:1555` | none passed, so it inherits `process.env` |
| LucidType AI (Claude) | `app/lucidtypeAI.js:105-108` → `runProc` `:120` | none passed, so it inherits `process.env` |
| AI Voice (Copilot) | `app/copilotvoice-session.js:237`, `--acp`, `shell: true` (npm `.cmd` shim) | none passed, so it inherits `process.env` |
| Copilot batch prompt | `runCopilotBatchPrompt`, `copilotvoice-session.js:456-471`, `shell: true` | none passed, so it inherits `process.env` |
| Meeting analysis (Copilot) | `meetingAnalyze.js:1504-1509` → `runCopilotBatchPrompt` | the same |
| LucidType AI (Copilot) | `lucidtypeAI.js:62-64` → `runCopilotBatchPrompt` | the same |
| Editor "CLI installed?" probe | `app/main.js:4939-4941` | PATH lookup only, no auth |

`app/routines.js` starts no process of its own; routines run through the AI Voice session.
The Copilot spawns already use `shell: true`. That is existing behavior: the tokens travel in the
env, never on the command line, so they don't appear in process listings or EDR command-line logs.

Sign-in error text lives in four places:
- Claude: `meetingAnalyze.js:132` ("…run: claude auth login") and `claudevoice-adapter.js:59-62`
  ("…run claude, then type /login").
- Copilot: `copilotvoice-session.js:294` ("not signed in — run `copilot login`") and the generic
  line in `meetingAnalyze.js:133-134`.

## Auth facts (checked 2026-11-09)

### Claude Code
From [code.claude.com/docs/en/authentication](https://code.claude.com/docs/en/authentication)
and the local CLI help (v2.1.314):
- **Precedence:** cloud-provider vars → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` →
  `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → profile → `/login`. In `-p` mode an
  `ANTHROPIC_API_KEY` "is always used when present."
- **`claude setup-token`:** makes a one-year OAuth token, prints it, and saves it nowhere. It
  needs a Pro, Max, Ultra, Team, or Enterprise plan.
- **Limits:** the token can only make model requests. It can't start Remote Control or load
  **claude.ai connectors**, but local MCP servers still work.
- **`--bare`:** never reads the token. Bedrock Panel doesn't use `--bare`.
- **`--safe-mode`** (used by meeting analysis): local help says "Auth, model selection… work
  normally." This is likely fine, but we still test it (check B below).
- **Not documented:** how to revoke the token, what happens when it expires, and whether it is
  scrubbed from tool subprocesses. There are also unverified user reports of 401s in long
  sessions.

### GitHub Copilot CLI
From [docs.github.com (authenticate Copilot CLI)](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli),
the PAT docs, and the local CLI help (v1.0.100):
- **Precedence:** `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` → keychain OAuth (from
  `copilot login`) → `gh auth token`. The env var "silently overrides a stored OAuth token."
- **Token type:** a **fine-grained** personal access token (`github_pat_`), owned by the personal
  account, with the **"Copilot Requests"** permission. Classic `ghp_` tokens are **not** supported.
- **Lifetime:** chosen when the token is created. "Infinite lifetimes are allowed" unless an org
  or enterprise policy blocks them.
- **Usage:** Copilot requests "count towards the user's premium request allowance," the same as
  with a normal sign-in.
- **No free status command** in v1.0.100: `copilot login` has no `status` subcommand.
- **Not verified:** whether a token with only "Copilot Requests" can call `GET
  api.github.com/user`, which would make a free validity check possible (check H).

---

## Design

### Settings
- `settings.claudeAuth = { token: '', createdAt: '' }`. `createdAt` (`YYYY-MM-DD`) is set to today
  when the token changes and can be edited. Expiry is `createdAt` plus 365 days.
- `settings.copilotAuth = { token: '', expiresOn: '' }`. `expiresOn` is the date GitHub showed when
  the token was made; empty means it never expires.
- Both `token` fields are **secrets**, added to `app/secretStore.js` (header list and walker). They
  are stored as `oqenc:v2:` (DPAPI) on Windows and with safeStorage elsewhere, and are plaintext
  only in memory, the same path as `settings.owui.apiKey`. The dates are not secret.

### Where they show
Two new cards on the **Auth tab** (`app/config.js:5091`, beside Home Assistant, Open WebUI, and
OBS):
- **Claude Code:** a token field (`secretInput`, with the show/hide eye), a Created date, a status
  pill, and a Check button. The hint covers `claude setup-token`, which plans qualify, encryption at
  rest, and that claude.ai connectors are off in AI Voice while it is set.
- **GitHub Copilot:** a token field, an Expires date (blank means never), a status pill, and Check
  (see Decision 2). The hint says to create the token on GitHub → Settings → Developer settings →
  Fine-grained tokens with **only** the "Copilot Requests" permission, explains why, and says that
  classic tokens don't work.
- The pills read: *Not set* / *Set, expires about …* (or *Set, no expiry*) / amber
  *Expires in N days* / red *Probably expired*.

### How they are applied
A new small pure module, `app/cliAuth.js`:
- `claudeChildEnv(baseEnv, claudeAuth)`: when the token is empty, returns `baseEnv` unchanged.
  When it is set, adds `CLAUDE_CODE_OAUTH_TOKEN` and applies Decision 1.
- `copilotChildEnv(baseEnv, copilotAuth)`: when the token is empty, returns `baseEnv` unchanged.
  When it is set, adds `COPILOT_GITHUB_TOKEN`. Nothing is removed, because this variable already
  outranks `GH_TOKEN` and `GITHUB_TOKEN`. Using it instead of `GH_TOKEN` means any `gh` commands the
  agent runs are unaffected.

`main.js` injects `getClaudeEnv()` and `getCopilotEnv()` getters. Each spawn site uses only its own
backend's getter. Codex and Open WebUI get nothing new.
- **Claude:** `claudevoice-session.js:115` builds from `getClaudeEnv()`. In `meetingAnalyze.js`
  and `lucidtypeAI.js`, `runClaude` passes `env` through `runProc` (a new optional argument).
- **Copilot:** `copilotvoice-session.js` gains an `env` option on both spawns (`:237`, `:471`).
  `meetingAnalyze.js:1509` and `lucidtypeAI.js:64` pass `getCopilotEnv()` into
  `runCopilotBatchPrompt`.

**When a change takes effect:** meeting analysis and LucidType start a new process for each call,
so a new token applies on their next call. AI Voice (either backend) reads it when its session
next starts. A running session keeps its current sign-in, and the card hint says so.

### Expiry warning
- **Claude:** `createdAt` plus 365 days, shown as "about" because the docs give no exact date.
- **Copilot:** `expiresOn`, if set.
- **Both:** the pill on the Auth card, and one desktop notification per app start (the existing
  `Notification` path, `main.js:117`) once fewer than 30 days remain. Each notice says how to
  make a new token.

### Error text
- **Claude, token rejected:** "Claude rejected the saved token (it may have expired or been
  revoked). Make a new one with `claude setup-token` and paste it on Settings → Auth."
- **Copilot, token rejected:** "GitHub rejected the saved Copilot token (expired, revoked, or
  missing the Copilot Requests permission). Make a new fine-grained token and paste it on Settings
  → Auth."
- **No token:** today's text, plus "…or save a long-lived token on Settings → Auth."
- **Where:** `meetingAnalyze.js:132-134`, `claudevoice-adapter.js:59-62`, and
  `copilotvoice-session.js:294`. The `AUTH_FAILURE_RE` and `SIGN_IN_FAILURE` patterns gain
  whatever wording a bad token really produces (checks C and G).

### Secret hygiene (public app)
- Each user makes their own tokens. The default config ships both empty.
- Tokens are never logged. A test checks that fake token strings never appear in any captured log
  line.
- They never go into a URL, a `sysserver` route, a command line, the panel renderer, or the
  `ai-voice` page options. Only the editor window sees them, the same way it sees the Open WebUI key
  today.
- The editor IPC for Check is guarded with `isFrom(e, configWin)`.

### EDR (CLAUDE.md #16)
The only runtime change is one env var added to `claude` and `copilot` processes Bedrock Panel
already starts (and, under Decision 1, up to two removed from `claude`'s). There is no new binary,
helper, listener, socket, shell, or download. The Copilot spawns' existing `shell: true` is
unchanged. The only extra activity is Check, and only when it is clicked: a short
`claude auth status` run of the same binary, plus, for Copilot, one HTTPS request from the main
process if check H passes.

---

## Decisions

### Your call

**Decision 1: what to do when `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is also in the environment** (Claude only).
Both outrank the token, and in `-p` mode the key is always used.
- **A (recommended): remove those two variables from the child's env only, when a token is set.**
  The token is then actually used. The system environment and every other app are untouched.
  Cost: someone who wants their API key for Bedrock Panel must leave the token field empty.
- **B: warn only.** The Auth card says the key overrides the token. The token does nothing until
  the key is removed system-wide.
- **Either way,** cloud-provider variables are left alone and only warned about. `apiKeyHelper`
  shows up through Check.
- Copilot needs no rule here, because `COPILOT_GITHUB_TOKEN` is already first in its order.

**Decision 2: what Claude's Check does.**
- **A (recommended): `claude auth status --json` with the child env.** It spends no tokens and
  shows which credential Claude would use (`oauth_token` means the token wins). It may not prove the
  token is still valid; check A tells us.
- **B: A, plus a one-word prompt on Haiku.** This proves the token works, but uses a little
  subscription usage on each click.
- **Copilot's Check (default taken):** Copilot has no free status command. If check H shows that a
  "Copilot Requests"-only token can call `GET https://api.github.com/user`, Check makes that one
  request from the main process. It is free and proves the token is valid and not expired, but not
  that it has the Copilot permission. If check H fails, Copilot gets no Check button, and its first
  real use is the proof.

**Decision 3: the voice agents' tools can see the tokens.**
Commands the AI Voice agent runs (Bash, hooks, local MCP) inherit its environment, for both
backends. Today the same agents can already read their CLI's own stored credentials, so the kind of
exposure is the same, but these tokens last longer.
- **A (recommended):**
  - **Claude:** if check E shows that `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` removes
    `CLAUDE_CODE_OAUTH_TOKEN`, set it on the voice spawn when a token is set. If not, accept the
    exposure and document it.
  - **Copilot:** there is no documented scrub, so rely on least privilege. The card tells users to
    give the token only "Copilot Requests". A leaked one can then make Copilot requests and nothing
    else: no repos, no account changes.
- **B: accept the exposure and document it,** for both, with no scrub.

### Defaults taken (reversible, say if you disagree)
- Global settings on the Auth tab rather than per feature: one token per CLI, one expiry, one place.
- Claude's `createdAt` is filled in automatically. Copilot's `expiresOn` is typed in, or filled from
  check H if GitHub reports it.
- A voice session picks up a new token at its next start, with no forced restart.
- An expiry notification once per app start within 30 days, plus the card pill.

---

## Spike results

These are the token-free checks, run 2026-11-09 against claude 2.1.314 and copilot 1.0.100. Each
used a clean environment and bogus tokens, and none touched a real login except where noted.

| Check | Result | What it changes |
|---|---|---|
| Empty `CLAUDE_CONFIG_DIR` | `loggedIn: false`, so it simulates a signed-out CLI | The spike and Phase 2 tests can use it |
| A. `claude auth status` with a bogus token | `loggedIn: true`, `authMethod: oauth_token`: **it doesn't validate the token** | Claude's Check shows which credential wins, not whether the token is valid, and the card hint says so (Decision 2A as approved) |
| C. `claude -p` with a bogus token | `Failed to authenticate. API Error: 401 OAuth access token is invalid.`, exit 1, no tokens spent | Both existing patterns already match "failed to authenticate"; only the message changes |
| D. Bogus token plus a dummy `ANTHROPIC_API_KEY` | `authMethod: api_key`: **the key wins** | Confirms Decision 1A is needed |
| **New:** a bogus Claude token alongside T.J.'s working normal login | **401: Claude does not fall back** | A bad or expired token breaks Claude features even while the normal login works, so the error text adds "…or clear the token to use your normal Claude login", and the expiry warning matters |
| G. A bogus Copilot token | With a normal Copilot login present (Credential Manager), Copilot **quietly falls back to it** and succeeds. This held with the `gh` CLI login hidden too. Only when no other login exists does it fail: `Authentication token found but could not be validated … Bad credentials` | A bad Copilot token breaks nothing while the normal login works, but nobody would notice either. Copilot's Check (`GET /user`) is the way to catch it. Add `could not be validated\|bad credentials` to the auth patterns |
| **New:** a Copilot flag | `--secret-env-vars <names>`: values are "stripped from shell and MCP server environments and redacted from output" | Under Decision 3A, pass `--secret-env-vars=COPILOT_GITHUB_TOKEN` on Copilot spawns when a token is set, if check E4 confirms it (and it works with `--acp`) |

**One proposal outside the approved decisions (needs your OK):** when a Claude token is set, also
remove `CLAUDE_CODE_SIMPLE` from the child env. That variable puts Claude in bare mode, which
ignores the token. Claude Code sets it inside its own sessions, so a Bedrock Panel started from an
agent's shell would inherit it. For the same reason, the Phase 2 manual tests launch the app
normally, not from an agent's shell.

**Still needs real tokens** (`tools/cli-token-spike.ps1`, which T.J. runs):
- **B.** Claude `-p --safe-mode` works on the token.
- **E1 / E2.** A Claude tool command sees the token without the scrub, and doesn't with
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`.
- **F.** Copilot `-p` works on the token. The script reads Copilot's log to rule out a fallback.
- **E3 / E4.** A Copilot tool command sees the token without the flag, and doesn't with
  `--secret-env-vars`.
- **H.** `GET api.github.com/user` returns 200 with the Copilot token, and whether GitHub sends an
  expiry header.

The script reads tokens with hidden input, redacts them from all output, and deletes its temporary
folder. A dry run with bogus tokens confirmed both, and correctly flagged Copilot's fallback.

---

## Build steps (after sign-off)

**Phase 0: spike (no code).** One PowerShell script that T.J. runs himself. It asks for each token
with hidden input, never prints them, and simulates signed-out CLIs with empty temporary
`CLAUDE_CONFIG_DIR` and `COPILOT_HOME` folders, so his real logins are never touched (the spike
confirms both variables first). It prints one pass/fail table:
- **Claude A.** `claude auth status --json` shows `authMethod: oauth_token`. Did it contact the
  server?
- **Claude B.** `claude -p --safe-mode --tools "" --strict-mcp-config --no-session-persistence`
  answers "OK" on the token.
- **Claude C.** A deliberately bogus token: capture the exact error wording. This spends no tokens.
- **Claude D.** `ANTHROPIC_API_KEY=dummy` alongside the token: confirm the key wins, which confirms
  Decision 1 is needed.
- **Claude E.** Does `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` remove the token from tool subprocesses?
- **Copilot F.** `copilot -p "Reply OK"` answers on the token. This uses one premium request.
- **Copilot G.** A bogus `COPILOT_GITHUB_TOKEN`: capture the error wording, and confirm Copilot
  fails rather than quietly falling back to the stored login.
- **Copilot H.** `GET https://api.github.com/user` with the token: is it 200, and does GitHub
  return an expiry header?

**Phase 1: code**, on a branch from `main`:
1. `app/cliAuth.js`: both env builders, expiry math, and message builders.
2. `app/secretStore.js`: header comment and walkers for `settings.claudeAuth.token` and
   `settings.copilotAuth.token`.
3. `app/config.default.json`: empty `claudeAuth` and `copilotAuth` blocks, plus defaulting getters
   in `main.js`.
4. Claude spawn sites: `claudevoice-session.js` (`getEnv` option), `claudevoice-adapter.js`, and
   `runClaude` in `meetingAnalyze.js` and `lucidtypeAI.js`.
5. Copilot spawn sites: `copilotvoice-session.js` (`env` on both spawns) and the
   `runCopilotBatchPrompt` callers in `meetingAnalyze.js` and `lucidtypeAI.js`.
6. `main.js`: wire the getters, the Check IPCs (guarded), and the startup expiry notice.
   `config-preload.js`: expose Check. `config.js`: the two Auth cards.
7. Error text in all four places, and the regex additions from checks C and G.
8. Docs: `docs/ai-voice.md` (~288), `docs/meeting.md` (~101), the LucidType guide, and a short
   "CLI tokens" section covering how to make each token, plans and permissions, limits, and expiry.

**Phase 2: verification** (below), then a PR. Nothing goes to `main` without your merge.

## Verification

**Unit tests** (`npm test`, `node:test`):
- Env builders: an empty token gives the same object contents; with a token, the right variable is
  set (and Decision 1 applied for Claude); other variables are untouched.
- `secretStore`: both tokens round-trip encrypted, and empty tokens are skipped.
- Expiry math: pill states at 31, 30, 1, 0, and -1 days, and Copilot with no expiry.
- Routing: each backend's spawn receives only its own variable. Codex gets neither, and Claude's
  spawn never gets the Copilot token or the reverse. This extends the existing fake-spawn tests in
  meeting analysis, LucidType, and both voice sessions.
- Fake token strings never appear in any captured log line or spawn argument.

**Manual** (`npm start`, simulated signed-out CLIs as in Phase 0):
- [ ] Claude: meeting analysis, LucidType cleanup and rewrite, and AI Voice turns succeed on the
      token.
- [ ] Copilot: the same three succeed on its token.
- [ ] **A long AI Voice session on each backend:** idle for 2 hours or more, then a turn, with no
      auth error.
- [ ] Fields empty: same behavior and the same errors as today.
- [ ] Bogus tokens give the new "rejected the saved token" text on every path.
- [ ] `config.json` shows `oqenc:v2:` for both tokens, and the app log has neither.
- [ ] The Auth cards work in light and dark themes, and Check reports correctly.

## Out of scope
- **Codex.** A ChatGPT plan has no long-lived token. The only long-lived option is an API key
  (`CODEX_API_KEY`), billed per token at API rates instead of through the plan. `codex login
  --with-access-token` exists, but the docs describe it as admin-granted for ChatGPT Enterprise
  (seen in a docs summary, not verbatim). Codex's own sign-in refreshes itself while in use, so it
  lapses less often.
- Making or rotating tokens for the user; both need the user's own browser sign-in.
- Open WebUI and API-backend auth.
- Revocation steps for the Claude token, which are undocumented. Clearing a field stops Bedrock
  Panel using that token. Copilot tokens are revoked on GitHub's token page as usual.
