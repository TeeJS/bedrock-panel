# AI Usage

A single-glance usage monitor for the panel, covering three AI tools side by side:

| Panel | Source | What it shows | Setup |
| --- | --- | --- | --- |
| **Claude** (Code / Cowork) | Local Claude Code logs at `~/.claude/projects` | Estimated API-rate value, messages, sessions, tokens (in/out/cache), per-model split, 14-day spend | none |
| **ChatGPT** (Codex CLI) | Local Codex CLI logs at `~/.codex` | Weekly + 5-hour rate-limit gauges (read straight from the logs), messages, tokens, 14-day activity | none |
| **Copilot** | GitHub billing API | GitHub AI Credits consumed this month, remaining personal-plan allowance, and billed overage | GitHub username + token |

The period control (Today / 7 days / 30 days / All) rescopes the Claude and ChatGPT numbers.
The Codex and Copilot gauges use their own fixed windows (this week / this calendar month).

## How it works

This is a **served drop-in with a host-side `server.js`**, so installing it shows the standard
"contains executable code" prompt. That code reads local session logs and calls GitHub's billing
API. It returns only aggregated numbers to the page; **raw log contents and your GitHub token never
leave the host**. The first scan of a large history takes a few seconds, then a cached per-file
index makes refreshes near-instant.

The Copilot panel uses GitHub's current personal AI-credit billing endpoint. It falls back to the
legacy premium-request and general usage endpoints for accounts that have not moved to AI credits.
GitHub can report usage after a delay, so a new Copilot interaction may not appear immediately.

> The Claude and ChatGPT figures reflect **CLI usage on this machine** (Claude Code / Cowork and
> the Codex CLI). They cannot see usage from web apps because those do not write local logs. The
> Claude "spend" is an **estimate** at first-party API rates; it is not a bill.

## Options

| Option | Purpose |
| --- | --- |
| **GitHub username** | Your login. Both username and token are required to show the Copilot panel. |
| **GitHub token** | Fine-grained PAT with **Plan** (read-only) user permission. Server-side only; never sent to the page. Create one at github.com/settings/personal-access-tokens. |
| **Copilot monthly AI credits** | Optional gauge denominator for personally billed Pro (1,500), Pro+ (7,000), or Max (20,000). The safe default is unknown, which hides the gauge. |
| **Claude / Codex data folder** | Advanced: override the default `~/.claude` / `~/.codex` locations. |
| **Refresh interval** | How often the panels re-scan and re-poll (15 seconds to 2 minutes). |

User-level GitHub billing only contains Copilot usage billed directly to a personal account. If an
organization or enterprise manages the Copilot license, view the organization's billing usage
instead; this app deliberately shows guidance rather than a misleading zero.

## Knob

Rotate to cycle the time period; single-press to refresh now.

## Requirements

- Claude panel: [Claude Code](https://claude.com/claude-code) session logs on this machine.
- ChatGPT panel: the [Codex CLI](https://github.com/openai/codex) used on this machine.
- Copilot panel: a directly billed personal Copilot plan and a GitHub token with Plan read access.
