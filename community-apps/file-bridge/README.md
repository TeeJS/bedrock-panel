# FileBridge (`file-bridge`)

Bring files together from **local folders, Google Drive, and subscription sites**
into local folders, on a schedule. FileBridge is a from-scratch folder-replicator
in the spirit of the classic Windows sync tools (Karen's Replicator and friends) —
change-only copying, mirror deletions, dated backups, filter groups, and a full
live progress band — plus two things those tools never had: a **Google Drive API**
source and **subscription-site "web-drop"** downloads.

It runs on all three surfaces — the 1920×480 **panel**, the **editor** job-manager
embed, and a **pop-out window** — and every job type shares one run engine, one
schedule model, and one live progress/result view.

## Three kinds of job

**📁 Folder** — copy one local (or mounted) folder into another.
- Change detection by **modification time, size, or content hash** (any combination),
  optionally **source-newer-only**.
- **Mirror deletions** (remove destination files the source no longer has) with the
  **Recycle Bin**, a **test-source safety guard** (an empty/unmounted source won't
  wipe the destination), and **skip-pattern protection**.
- **Safe replace** — a failed or interrupted copy restores the previous file; the
  destination is never left truncated.
- **Follow Drive/`.lnk` shortcuts** to copy their targets.
- **Date tokens** like `<yyyy-mm-dd>` in the source/destination for dated backups.
- **Mirror source timestamps + the read-only attribute** onto the copy (opt-in).

**☁️ Google Drive** — paste a Drive **folder link** and read it through the **Drive
API** (not the local mount).
- Sees **everything shared with you**, including files the desktop mount hides.
- Optionally **export Google Docs / Sheets / Slides to Office files** (`.docx` /
  `.xlsx` / `.pptx`) as they copy.
- **Names match Google Drive for Desktop** — a Windows-illegal character in a Drive
  name (e.g. the `/` in `Star Wars Blasters/Weapons`, or the `:` in `1:6 Scale`)
  becomes a space, so FileBridge recognizes your mount-made copies instead of
  re-downloading them into duplicate folders.

**🌐 Web-drop** — auto-download new releases from a subscription site.
- Paste the site's **listing URL** and supply a **per-site rule file** (matched by
  hostname; authorable in-app under **Rules**).
- **Sign in once** in a real browser window; a **seen-ledger** fetches only what's
  new on the next run.

## Shared across every job

- **Schedules:** manual, **cron**, or a sliding **repeat-every** interval, with
  weekday exclusions. A global **Pause schedules** switch stops all scheduled runs
  without disabling jobs.
- **Per-run Pause / Resume** — suspend the running job and continue from the same
  spot: *finish the current file* or *pause now* (aborting an in-flight Drive
  download and redoing that file on resume).
- **Reusable filter groups** — named include/exclude sets with `#`, `[list]`, and
  `*.*` wildcards, referenced **live** (edit the group, every job that links it
  updates) and optionally applied as a **global exclusion** everywhere.
- **Live progress band** — the full source/destination path of the current file, a
  running **up-to-date · copy · filtered** verdict tally, within-file progress,
  transfer rate, and live destination free space.
- **Uncapped dry-run Preview** — shows exactly what a real run would copy and delete,
  no truncation.
- **Results + logging** — a per-run result view (with the **reason each file copied**),
  a configurable **activity log** (choose which per-file events are recorded) with a
  **warnings-vs-errors** tier (a copied file whose timestamp couldn't be set is a
  warning, not a failure), and lifetime per-job **and** grand-total statistics.
- **Manual job ordering**, **Duplicate job**, and a per-job three-dot menu.

## Setup

1. **Add job** → choose the type, then set the pieces:
   - **Folder / Google Drive:** pick the **source** and **destination** folders (the
     panel's native folder picker), the compare criteria, any filters, and a schedule.
     For a Drive job, paste the Drive **folder link** as the source and turn on
     **read via the Drive API**.
   - **Web-drop:** add a **rule file** under **Rules**, paste the site's listing URL,
     then sign in when prompted.
2. **Connect Google Drive** (Drive jobs only) — FileBridge manages its **own** Google
   sign-in (read-only Drive scope) from the **Accounts** strip / editor, so no
   host-wide Google account is required. Connect once; it's reused on every run.

## Notes

- **Jobs live in** `%APPDATA%\bedrock-panel\file-bridge\jobs.json` — copy that file to
  move all your jobs (and their stats) to another machine.
- **Read-only on the source.** FileBridge reads the source and writes only the
  destination; it never modifies or deletes anything on the source side.
- The **Drive connection is read-only** (`drive.readonly`) — FileBridge can read and
  download, never change your Drive.
- **Google-native docs** with no export produce no file — they're reported as
  **skips**, not errors, exactly like the local mount.
- After updating the app, **restart Bedrock Panel**: `server.js` changes only load with
  the host process.
