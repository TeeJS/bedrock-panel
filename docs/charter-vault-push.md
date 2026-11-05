# Charter: Push the meetings vault after each export

Status: **signed off by T.J. 2026-11-04** (revision 2) · built on branch `vault-push`.

Why now: on the work PC, nothing reached Gitea from Oct 28 to Nov 4. The vault only synced while
Obsidian was open, and when it was reopened the push was refused for a bad saved sign-in. Neither
failure was shown anywhere.

## 1. The one thing it must do

After Bedrock copies a finished meeting file into the vault, **Bedrock commits and pushes the vault
to its git remote itself**. Meetings reach Gitea with Obsidian closed.

## 2. What would be wrong if it shipped "working" without it

- **A push that fails silently.** A refused sign-in, no network, or a merge conflict must show on
  the panel, and the next export must push everything still waiting.
- **A lost edit.** A speaker name fixed on the phone must never be overwritten or discarded by
  Bedrock's push.

## 3. Off-limits as workarounds

- Needing Obsidian open, or auto-starting it.
- A scheduled task or a hidden PowerShell script.
- Starting a shell. Bedrock calls `git.exe` directly, the same thing the Obsidian Git plugin does
  on that PC today.
- Force-push, reset, or anything that rewrites history.
- Bedrock storing, asking for, or handling a password or token. It uses the PC's existing Git
  sign-in and never shows a prompt; if sign-in fails, it reports that and stops.
- Running git anywhere except the configured vault folder.

## 4. Deployment target and backup

- Bedrock Panel on the work PC (TSCHMITZ-S). Vault `C:\Users\tschmitz\GitHub\meetings`, remote
  `https://git.schmitzplex.com/tschmitz/meetings.git`. Works on any PC with Git installed.
- Built on a branch in its own worktree, merged by PR. Git is the backup for the code. The vault is
  a git repo, so every change Bedrock makes there is a commit that can be undone.

## 5. How we verify it's done

Automated (`npm test`, using a throwaway local git remote):

- An export ends with the file committed and on the remote.
- The remote has a phone edit to a different file: Bedrock merges it in and pushes.
- The remote has a phone edit to the same file: nothing is forced, nothing is lost, and the panel
  says a merge is needed.
- Sign-in refused or remote unreachable: the panel shows the error, the commit stays on the PC, and
  the next export pushes both.
- The vault folder is not a git repo, or Git is not installed: the export still succeeds and the
  panel says why nothing was pushed.
- Setting off: no git process is started.

Live, on the work PC: with Obsidian closed, analyze one meeting; the file is in Gitea within a
minute.

## How it works

- Where files go does not change. Only the meeting's `.md` is copied into the vault. The `.md` and
  its details folder are still written to Completed (`M:\meetings\completed`) exactly as now.
- New setting under **Copy meeting files into an Obsidian vault**: **Push the vault to its git
  remote after each export**. Off by default.
- After the vault copy: stage, commit (`vault backup: bedrock <PC name> <date>`), pull by merge,
  push. One run at a time; a run that finds the vault busy waits and tries again.
- If the pull hits a conflict, Bedrock backs the merge out, keeps its commit on the PC, and
  reports it.
- The push result is shown on the meeting panel beside the Obsidian export status. It is not
  written into the meeting file, because that would change the file it just committed.
- Waiting commits are also pushed when Bedrock starts.
- This reverses the Oct 27 rule "Bedrock must not run git" (T.J., 2026-11-04).

## Decisions for T.J.

1. **What gets committed. Decided (T.J., 2026-11-04): the whole vault.** Every push commits
   everything changed in the vault, the same as the Obsidian Git plugin does.
2. **The Obsidian Git plugin on the work PC.** Left enabled (the default taken; this work does not
   change it). The two can share the vault; whichever runs first pushes.

## Not in this change

The Dell's copy of the vault, the backfill of older meetings, the Joplin import, and the meeting
MCP server.
