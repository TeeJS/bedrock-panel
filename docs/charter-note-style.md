# Charter: Meeting Note Style (Classic / Minutes Compatible)

Status: **awaiting sign-off** · 2026-10-29 · the v1.0.0 release is held for this. Revision 2, after
review by Claude (Mac) and Fable (Linux).

## 1. The one thing it must do

A setting at **Settings → Meeting → Advanced settings → Note style** with two choices:

- **Classic**: analyzed meetings are written exactly the way 0.9.9 wrote them, plus one small
  tracking file per meeting (`<recording>.bedrock.json`) that keeps 1.0.0's protections working.
- **Minutes Compatible**: the one-file format built for 1.0.0, unchanged.

People updating from 0.9.9 start on **Classic**, so their meeting notes don't change unless they
switch.

## 2. What would be wrong if it shipped "working" without it

- **Classic without 1.0.0's protections.** A re-analysis overwrites hand edits, Joplin makes
  duplicate notes, a vault copy edited in Obsidian gets overwritten, the task list is sent twice,
  and completed action items reset.
- **Classic that only looks like 0.9.9.** A different file name, transcript times added, or no
  clean-transcript file.
- **An update that quietly moves a 0.9.9 user to Minutes Compatible.**

## 3. Off-limits as workarounds

- The quick version: Classic files with nowhere to keep the meeting's tracking.
- Picking the style by editing `config.json`.
- Changing the setting rewrites or moves nothing. Files change only when a meeting is analyzed
  again, as they do today.
- Any change to what Minutes Compatible writes.
- Publishing v1.0.0 before this ships.

## 4. Deployment target and backup

- Ships in **v1.0.0** for Windows, macOS, and Linux, rebuilt from `main` after this merges. The
  12 files on the v1.0.0 draft are replaced.
- Built on branch `note-style` in its own worktree, merged by PR. Git is the backup.

## 5. How we verify it's done

Automated (`npm test` green on all three build machines):

- **Classic matches 0.9.9, byte for byte.** One test runs the 0.9.9 writer and the new Classic
  writer on the same canned AI reply and compares the files: `<recording>-analysis.md` (no header,
  no transcript times) and, with **Separate Clean Transcript** on, `<recording>-clean_transcript.txt`.
  **Use Details Folder** on puts the sources in `details\`; off puts them beside the `.md`. That
  includes meetings that arrive through **Transcribed Recordings** and **Batch**.
- **Classic keeps every protection:** a hand edit leads to **Review new**, action-item status
  survives re-analysis, a Joplin re-export makes no duplicate, a vault edit leads to
  `<name>.conflict.md`, and the task list goes out once.
- **Apply this version in Classic never deletes the live note.**
- **The tracking file is safe:** written in one step, never half-written. A missing, unreadable, or
  mismatched tracking file is treated as "can't tell whether it was edited", so the re-analysis is
  saved beside the note for **Review new**. It never crashes and never overwrites. The file records
  a fingerprint of the note, so a copied or renamed note is never trusted by mistake.
- **Minutes Compatible is unchanged:** the same input gives the same file as today.
- **Update defaults:** an existing settings file gets **Classic**; the first launch of a new install
  gets **Minutes Compatible**.
- **Switching styles** changes no files. The next analysis of a meeting writes the new style,
  carries its tracking across (header to tracking file or back), and keeps the old-style file as
  the previous revision.
- **Completed** shows Classic and Minutes meetings with the same status. The Obsidian export copies
  only the note, never the tracking file.

On the machines:

- **Mac and Linux:** `npm test`, plus one Classic analysis and one Classic **Batch** run from a
  recorded transcript and a canned AI reply (those machines have no meeting setup).
- **Windows panel, live:** one meeting analyzed in each style, a **Batch** run, both opened from
  **Completed**, and a re-analysis after a hand edit.

## How it works

- One meeting-record store, used by analysis, **Apply this version**, the Joplin, Obsidian, and
  task-list exports, and the **Completed** list.
- **Minutes Compatible:** the record stays in the file's header, as now.
- **Classic:** the record lives in `<recording>.bedrock.json`, next to the sources. The `.md` has
  no header. Earlier revisions and **Review new** versions sit beside the sources too.
- **The AI gets the same prompt in both styles, except one instruction.** Classic leaves out the
  instruction that rewrites transcript lines as `[Name 1:23] text`, so Classic transcripts keep
  0.9.9's `**Name:** text` lines. In Classic, Bedrock removes the structured block it asks for from
  the `.md` and keeps what it found in the tracking file.
- **The Obsidian vault copy keeps the local name:** `<recording>-analysis.md` in Classic.
- **The same in both styles:** the three folders, the **Batch** page, filing by the meeting's date,
  the Obsidian export option, merging recordings, and the quit warning.
- **A 0.9.9 file with no tracking file:** Bedrock can't tell whether it was edited, so a re-analysis
  is saved beside it for **Review new**, as it is today.

## Defaults I took (tell me if any is wrong)

- **Every install that already has settings starts on Classic,** including the beta machines. You
  switch yours to Minutes Compatible once.
- **Classic includes the separate transcript file,** for full 0.9.9 parity.
- **Only Classic uses the tracking file; Minutes Compatible keeps its header.** It leaves the format
  you've been testing untouched.

## Who

- **Windows** (this machine) builds it.
- **Claude** (Mac) and **Fable** (Linux) review every diff and run the checks above on their
  machines before the rebuild.

Estimate: 2 to 3 days.
