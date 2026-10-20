# Charter: quit warning, merge recordings, meeting-name rename (2026-10-20)

Scope: 3 requested changes. Item 2 (meeting-name rule for a 2nd recording) is **TABLED** until T.J. sees what the 07:22 file is named after the current meeting ends. Nothing for item 2 is built now.

## 1. Quit warning while recording / transcribing
- **Must do:** if a recording OR a transcription is running when the user quits Bedrock Panel on the desktop (tray Quit, and any other app-quit path), show a confirmation ("Recording in progress, really close?"). Cancel keeps the app running. Confirm quits (recording is finalized normally, header patched).
- **Wrong if missing:** a stray close silently kills a live meeting recording (what happened 10-20 07:2x).
- **Off-limits:** a warning only in the log; a warning that does not cover transcription; a quit path that skips the check.
- **Deploy / backup:** feature branch off `main` (git is the backup). No version bump outside a delegated release.
- **Verify:** unit test for the "is busy" predicate; live in `npm start`: start recording, tray Quit -> dialog, Cancel keeps recording, Confirm saves a playable WAV. Same with a transcription running. Idle quit shows no dialog.

## 3. Merge recordings (Unprocessed screen)
- **Must do:** with 2+ recordings checked, a **Merge** button appears. Merge writes ONE new WAV (chronological order by timestamp name, concatenated). Originals (and their sidecars) are MOVED, not deleted, to a `.backups` folder.
- **Details:** `.backups` goes inside the unprocessed folder if list/transcribe/batch/cleanup code all ignore it (verify); otherwise in the meeting root. Merged file name = earliest timestamp, plus meeting name if the inputs share one. WAV format (sample rate / channels / bit depth) must match or the merge is refused with a clear message (no resampling). Sidecar (.json / .capture.json / screenshots) handling for the merged file is decided from the code during build and reported.
- **Wrong if missing:** a merge that loses audio, mis-orders parts, or deletes originals.
- **Off-limits:** deleting originals; resampling; merging a file still being recorded; a merged WAV with a bad header.
- **Deploy / backup:** same branch; originals are the backup (`.backups`).
- **Verify:** unit tests (order, header sizes, mismatched format refused, in-progress file refused, originals moved); live merge of 2 real recordings: duration = sum, plays, originals in `.backups`, Unprocessed list and Batch ignore `.backups`.

## 2. Meeting-name rule (TABLED)
Existing feature: "Append meeting name" renames a recording from the calendar match. Open: why 07:22 was not named (it was a restart after an accidental close, so the earlier recording was a separate file). Revisit after the meeting ends.
