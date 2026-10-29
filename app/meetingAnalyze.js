'use strict';

// Transcript analysis: feeds a processed transcript JSON plus the shared prompt
// (meeting-analysis-prompt.md) to the configured Analysis AI — Claude (`claude -p`), ChatGPT
// Codex (`codex exec`), GitHub Copilot (`copilot --acp`, one-shot ACP session — see
// copilotvoice-session.js's runCopilotBatchPrompt), or Open WebUI (HTTP chat completion against
// the Auth-tab connection, see runOwui) — and writes the returned markdown next to the transcript
// as <basename>.md. One job at a time, no queue: analysis takes seconds-to-minutes and the panel
// disables the button while running.
//
// The three CLIs authenticate themselves; the OWUI backend uses the shared settings.owui
// credentials (apiKey encrypted at rest by secretStore). Every backend is tool-free for analysis
// — transcripts are untrusted third-party speech, so nothing they say may reach a shell: the CLIs
// run with tools denied/absent and OWUI is a plain completion API with no tools at all.
// Deps are injected for tests: resolveFolders, resolveAi, resolveOwui, spawn, fs, prompt path, clock.

const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { safeRelPath, wavDurationMs } = require('./meetingLibrary');
const { runCopilotBatchPrompt } = require('./copilotvoice-session');
const owuiClientMod = require('./owuiClient');
const joplinNotesMod = require('./joplinNotes');
const obsidianExportMod = require('./obsidianExport');
const { parseStructuredTail, buildFrontmatter, validateFrontmatter, serializeFrontmatter, readFrontmatter } = require('./meetingFrontmatter');
const { newId, sha256, formatTime, applyTurnTimes, aiHeadingsOf, baselineHash, mergeOwnership, assignItemIds, assembleFile } = require('./meetingFile');
const meetingRecord = require('./meetingRecord');

// The analysis rewrites the whole transcript, so its run time grows with the meeting: observed
// 2026-10-22 with claude -p, a 124 KB / 78-min diarizer JSON took 9m39s and a 162 KB / 89-min one
// never finished inside a flat 10 min. The limit therefore scales with the input at roughly twice
// the observed rate, between a floor (short meetings, CLI cold start) and a ceiling (a hung CLI
// must still fail eventually).
const ANALYZE_TIMEOUT_MS = 10 * 60 * 1000;
const ANALYZE_TIMEOUT_MAX_MS = 60 * 60 * 1000;
const ANALYZE_MS_PER_INPUT_CHAR = 10;
function analysisTimeoutMs(inputChars) {
  const scaled = (Number(inputChars) || 0) * ANALYZE_MS_PER_INPUT_CHAR;
  return Math.min(ANALYZE_TIMEOUT_MAX_MS, Math.max(ANALYZE_TIMEOUT_MS, scaled));
}
// Unattended analysis must never let transcript text reach a tool. These flag sets are what the
// comment above actually means, verified against the installed CLIs on 2026-10-15:
//   claude 2.1.292:  `--tools ""` disables every built-in tool, `--strict-mcp-config` with no
//     --mcp-config loads zero MCP servers, `--safe-mode` disables CLAUDE.md/skills/plugins/hooks,
//     `--no-session-persistence` writes nothing to disk. Smoke: a prompt asking it to list files
//     with a tool answered "NO TOOLS AVAILABLE".
//   codex-cli 0.154.0: `--sandbox read-only` (shell commands can't write), `--ephemeral` (no
//     persisted session), `-c mcp_servers={}` (overrides every MCP server in ~/.codex/config.toml),
//     `--disable browser_use/computer_use/apps` (the agent-tool features), cwd = fresh empty temp
//     dir. The arguments are accepted by the installed CLI; a tool-use smoke like Claude's could
//     not be run because the configured Codex model is rejected for the account — so for Codex
//     this is "sandboxed, no MCP, agent features off", not an observed refusal to use tools.
// Exported so the tests pin the exact child-process arguments.
const CLAUDE_ISOLATION_ARGS = Object.freeze(['--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence']);

// Appended by code to WHATEVER analysis prompt is in use (built-in or the user's edited copy), so a
// custom prompt keeps producing its own sections while the app still gets machine-readable facts.
// The model never writes YAML: meetingFrontmatter.js parses this block and builds the frontmatter.
// Versioned: a change to the block's shape bumps the anchor's version and the parser together.
const STRUCTURED_TAIL_VERSION = 1;
const STRUCTURED_TAIL_INSTRUCTION = `

---
ADDITIONAL REQUIRED OUTPUT (overrides only two earlier rules: "nothing after these sections" and
the transcript line shape; every other instruction above still applies).

1. Transcript lines: write each turn as "[Name m:ss] text" — the speaker's name (or the diarizer's
   label if unresolved) and the start time of the turn's first diarizer segment, taken from that
   segment's "start" field (seconds, rounded down to m:ss or h:mm:ss). Never invent a time.

2. After the last section, append a block in exactly the shape shown below, between the two
   marker lines. Rules: section headers in English exactly as shown; one "- " bullet per item;
   write "- (none)" when a section has nothing; no commentary, headings or prose inside the
   block. ACTION ITEMS and COMMITMENTS bullets are "@Full Name: text" when the owner was named
   and plain text when not; append " (by <deadline>)" only when a deadline was stated. Every
   SPEAKER MAP bullet is "<diarizer label> -> <Full Name> (<evidence>)" where evidence is one of
   enrolled, captions, direct address, self-introduction, elimination; a label you could not
   resolve is "<label> -> unresolved (no evidence)". TURNS has one bullet per transcript turn, in
   order, giving the zero-based inclusive index range of the diarizer segments that turn was
   built from. The example values below are placeholders.

<!-- BEDROCK-STRUCTURED v${STRUCTURED_TAIL_VERSION} -->
KEY POINTS:
- example point

DECISIONS:
- example decision

ACTION ITEMS:
- @Example Name: example task (by Friday)

OPEN QUESTIONS:
- (none)

COMMITMENTS:
- (none)

PARTICIPANTS:
- Example Name

SPEAKER MAP:
- Speaker A -> Example Name (direct address)

TURNS:
- 1: segments 0-3
- 2: segments 4-4
<!-- /BEDROCK-STRUCTURED -->
`;
// Classic note style: the same block, without rule 1 — the transcript keeps the prompt's own
// "**Name:**" turn labels exactly as 0.9.9 wrote them (Classic carries no turn times).
const STRUCTURED_TAIL_INSTRUCTION_CLASSIC = STRUCTURED_TAIL_INSTRUCTION
  .replace(/ADDITIONAL REQUIRED OUTPUT \(overrides only two earlier rules: "nothing after these sections" and\n\s*the transcript line shape; every other instruction above still applies\)\./,
    'ADDITIONAL REQUIRED OUTPUT (overrides only one earlier rule: "nothing after these sections"; every\nother instruction above still applies).')
  .replace(/\n1\. Transcript lines:[\s\S]*?Never invent a time\.\n\n2\. After the last section/, '\nAfter the last section');
// Rewording the block above must not silently re-send the timing rule to Classic: fail at load.
if (STRUCTURED_TAIL_INSTRUCTION_CLASSIC === STRUCTURED_TAIL_INSTRUCTION || /Transcript lines:/.test(STRUCTURED_TAIL_INSTRUCTION_CLASSIC)
  || !STRUCTURED_TAIL_INSTRUCTION_CLASSIC.includes('<!-- BEDROCK-STRUCTURED v' + STRUCTURED_TAIL_VERSION + ' -->')) {
  throw new Error('meetingAnalyze: the Classic structured-tail instruction no longer derives from the Minutes one — update STRUCTURED_TAIL_INSTRUCTION_CLASSIC');
}
const CODEX_ISOLATION_ARGS = Object.freeze(['--sandbox', 'read-only', '--ephemeral', '-c', 'mcp_servers={}',
  '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'apps']);
// Work bounds: a transcript past this is refused up front (one call cannot cover it honestly), and
// a reply past this is cut off. Both fail loudly; neither ever publishes a "complete" file.
const MAX_INPUT_CHARS = 2000000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;   // diagnostics only; anything past this is dropped, not buffered
// CLI sign-in failures (Claude prints these on stdout: "Failed to authenticate: OAuth session expired
// and could not be refreshed"; Codex/Copilot use "not logged in" wording). Matched case-insensitively.
const AUTH_FAILURE_RE = /failed to authenticate|not logged in|please run \/login|oauth[^\n]*expired|invalid api key/i;
// Only Claude's sign-in command is verified (`claude auth login`); other backends get a generic line.
function authRequiredMsg(ai) {
  if (ai === 'claude') return 'Claude needs sign-in. On this PC run: claude auth login — then try again.';
  const label = { codex: 'Codex', copilot: 'Copilot', owui: 'Open WebUI' }[ai] || 'The analysis AI';
  return label + ' needs sign-in. Sign in to it on this PC, then try again.';
}

// Analysis markdown lives beside the transcript, named after the recording: the raw diarizer
// response is <base>-diarizer-response.json (legacy plain <base>.json still accepted), the
// analysis is <base>-analysis.md — matching the naming T.J.'s pre-existing pipeline used, which
// other services key off.
// Minutes Compatible writes one file per meeting: <base>.md beside (or one level above) the
// transcript. Classic keeps that original <base>-analysis.md name (meetingRecord.js); readers accept both.
function mdPathFor(jsonPath) {
  return jsonPath.replace(/-diarizer-response\.json$/i, '.json').replace(/\.json$/i, '.md');
}
// Duration from the wav header without reading the whole file (headers are tiny; the data is not).
function wavDurationFromHeader(fsMod, wavPath) {
  try {
    const fd = fsMod.openSync(wavPath, 'r');
    try {
      const head = Buffer.alloc(64);
      const n = fsMod.readSync(fd, head, 0, head.length, 0);
      return wavDurationMs(head.slice(0, n));
    } finally { fsMod.closeSync(fd); }
  } catch (e) { return null; }
}
function readJsonIfExists(fsMod, p) {
  try { return fsMod.existsSync(p) ? JSON.parse(fsMod.readFileSync(p, 'utf8')) : null; } catch (e) { return null; }
}
// With "Use Details Folder" on, the transcript lives in <home>/details/ while the analysis .md
// belongs at <home>/ — write (and read) the .md one level up when the transcript sits in details.
function mdTargetFor(jsonPath) {
  const p = mdPathFor(jsonPath);
  const dir = path.dirname(p);
  return path.basename(dir).toLowerCase() === 'details' ? path.join(path.dirname(dir), path.basename(p)) : p;
}
// Recurring-meeting folder names, sanitized exactly like the OpenHiNotes pipeline: illegal chars
// and whitespace become hyphens, runs collapse, edges trimmed.
function sanitizeSubjectFolder(subject) {
  let s = String(subject || '');
  for (const c of '/\\:*?"<>|') s = s.split(c).join('-');
  s = s.split(/\s+/).filter(Boolean).join('-');
  while (s.includes('--')) s = s.split('--').join('-');
  return s.replace(/^-+|-+$/g, '');
}

// Mid-meeting highlights → a prompt block, or null when the recording has none. The spans are
// stored as ms offsets from the recording's start; the diarizer reports segment start/end as float
// SECONDS from the same origin (docs/meetings-api.md), so converting here means the model compares
// like with like. mm:ss labels ride along so a human reading the notes can find the moment.
//
// The instruction to emit a Highlights section lives HERE and not only in meeting-analysis-prompt.md
// because main prefers the user's editable copy of that file when one exists — anyone who ever
// customized their prompt would otherwise silently never get the section.
function highlightsBlock(metaText) {
  if (!metaText) return null;
  let spans;
  try { spans = (JSON.parse(metaText) || {}).highlights; } catch (e) { return null; }
  if (!Array.isArray(spans) || !spans.length) return null;
  const clock = ms => clockSec(ms / 1000);   // same mm:ss formatter, seconds from ms
  const rows = spans
    .filter(h => h && Number.isFinite(h.startMs) && Number.isFinite(h.endMs) && h.endMs > h.startMs)
    .map((h, i) => '  ' + (i + 1) + '. ' + clock(h.startMs) + '–' + clock(h.endMs) +
      '  (seconds ' + (h.startMs / 1000).toFixed(1) + '–' + (h.endMs / 1000).toFixed(1) + ')');
  if (!rows.length) return null;
  return '\n\nHighlighted moments follow. During the meeting the user flagged these spans as worth\n' +
    'calling out. Times are seconds from the start of the recording — the same origin as the\n' +
    "diarizer's segment start/end, so match each span against the segments it covers.\n\n" +
    rows.join('\n') +
    '\n\nBecause this input is present, add a "## Highlights" section to the document, placed\n' +
    'immediately after ## Summary. Give one bullet per span, in order, saying what was actually\n' +
    'being discussed there and why it matters, attributed by name, with the mm:ss span in\n' +
    'parentheses. Cover every span. If a span holds nothing substantive, say so plainly rather\n' +
    'than inventing content. Highlights supplement the other sections — a decision or action item\n' +
    'inside a highlighted span still belongs in Decisions or Action Items as well.';
}

// Slim a diarizer response down to `Speaker: text` lines for the OWUI backend — local models
// can't afford the raw JSON's timestamps, speaker_report, and cluster scores (~3-4x the tokens).
// Consecutive segments from the same speaker merge into one line. Unparseable or segment-less
// JSON THROWS: silently analyzing a raw blob the model can't fit would produce a confidently
// wrong summary, and that must never look like success.
// `stamps` prefixes each merged turn with its [m:ss] start — dead weight normally, but highlights
// need something to align to, so the OWUI path turns them on for those runs only.
function slimTranscript(transcriptJson, stamps) {
  let obj;
  try { obj = JSON.parse(transcriptJson); } catch (e) { throw new Error('transcript is not valid JSON: ' + e.message); }
  const segs = obj && Array.isArray(obj.segments) ? obj.segments : null;
  if (!segs) throw new Error('transcript has no segments array');
  const merged = [];
  for (const s of segs) {
    if (!s || typeof s !== 'object') continue;
    const text = String(s.text || '').trim();
    if (!text) continue;
    const speaker = String(s.speaker || '').trim() || 'UNKNOWN';
    if (merged.length && merged[merged.length - 1].speaker === speaker) merged[merged.length - 1].text += ' ' + text;
    else merged.push({ speaker, text, start: Number.isFinite(s.start) ? s.start : null });
  }
  if (!merged.length) throw new Error('transcript has no spoken segments');
  return merged.map(l => (stamps && l.start !== null ? '[' + clockSec(l.start) + '] ' : '') + l.speaker + ': ' + l.text).join('\n');
}

// m:ss from float seconds — the diarizer's unit for segment start/end (docs/meetings-api.md).
function clockSec(sec) {
  const t = Math.max(0, Math.round(sec));
  const m = Math.floor(t / 60), s = t % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function createMeetingAnalyzer(deps) {
  const fsMod = deps.fs || require('fs');
  const fsp = fsMod.promises;
  const spawnImpl = deps.spawn || require('child_process').spawn;
  const resolveFolders = deps.resolveFolders;        // () => { unprocessed, transcribed, processed }
  const resolveAi = deps.resolveAi;                  // () => 'claude' | 'codex' | 'copilot' | 'owui'
  const resolveOwui = deps.resolveOwui || (() => ({}));   // () => { url, apiKey, model } (settings.owui)
  const owuiClient = deps.owuiClient || owuiClientMod;
  const findClaudeExe = deps.findClaudeExe || require('./claudevoice-session').findClaudeExe;
  const findCodexExe = deps.findCodexExe || require('./codexvoice-session').findCodexExe;
  const findCopilotExe = deps.findCopilotExe || require('./copilotvoice-session').findCopilotExe;
  // promptPath may be a function (main.js prefers the user's editable copy in userData over the
  // bundled template) or a fixed string (tests).
  const promptPath = deps.promptPath || path.join(__dirname, 'meeting-analysis-prompt.md');
  const resolvePromptPath = () => (typeof promptPath === 'function' ? promptPath() : promptPath);
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  // A fixed deps.timeoutMs (tests) overrides the per-job limit from analysisTimeoutMs().
  const jobTimeoutMs = inputChars => deps.timeoutMs || analysisTimeoutMs(inputChars);
  // () => { separateRecurring, separateTranscript, useDetailsFolder } — the Advanced filing options.
  const filingOptions = deps.filingOptions || (() => ({}));
  // () => { enabled, folder } — post-analysis batch task lists ('' folder = <processed>/task-list).
  const resolveTaskList = deps.resolveTaskList || (() => ({}));
  // () => { enabled, url, token, notebook } — post-analysis Joplin notes (settings.meeting).
  const resolveJoplin = deps.resolveJoplin || (() => ({}));
  const joplinNotes = deps.joplinNotes || joplinNotesMod;
  // () => { enabled, vault } — post-analysis copy of the meeting file into an Obsidian vault (settings.meeting).
  const resolveObsidian = deps.resolveObsidian || (() => ({}));
  const obsidianExport = deps.obsidianExport || obsidianExportMod;
  const batchDone = [];   // successful analyses in the current batch, flushed to a task list on drain

  // Every job names its root: kind 'transcribed' (a flat transcript waiting in the transcribed
  // folder — analysis publishes it into completed) or 'processed' (a meeting already in completed,
  // re-analyzed in place). The same base name may exist in both roots; nothing guesses.
  const queue = [];      // [{ name, kind }] waiting (supports the panel's Analyze Selected)
  let running = null;    // { name, kind, ai, startedAt } while a job runs
  let lastError = null;  // { name, kind, error, finishedAt }
  let lastDone = null;   // { name, kind, finishedAt, md?, warning? } — md: completed-relative path of the published file
  const published = new Map();   // transcribed name -> absolute .md it was published as (for the panel's View)
  let completed = 0, failed = 0;   // lifetime outcomes, never lost when lastError is cleared
  let lastJoplin = null; // { name, ok, error?, applied?, skipped?, finishedAt } for the panel
  let lastObsidian = null; // { name, ok, state?, path?, conflict?, error?, finishedAt } for the panel
  let lastProposed = null; // { name, path, finishedAt } — a re-analysis saved for review instead of replacing edited notes
  const outcomeListeners = new Set();
  const resolveMyName = deps.resolveMyName || null;   // () => the operator's enrolled name (Settings → Meeting → My name)
  const foldersError = deps.foldersError || (() => '');   // () => '' or why the three roots overlap; re-checked as each job starts

  function onOutcome(listener) {
    if (typeof listener !== 'function') throw new TypeError('outcome listener must be a function');
    outcomeListeners.add(listener);
    return () => outcomeListeners.delete(listener);
  }

  function emitOutcome(entry) {
    for (const listener of Array.from(outcomeListeners)) {
      // A subscriber cannot turn a successful publication into a failed job.
      try { listener(Object.assign({}, entry)); } catch (e) {}
    }
  }

  function getState() {
    return {
      ok: true,
      running: !!running,
      name: running ? running.name : null,
      kind: running ? running.kind : null,
      startedAt: running ? running.startedAt : null,
      queue: queue.map(q => ({ name: q.name, kind: q.kind })),
      error: lastError,
      lastDone,
      completed,
      failed,
      joplin: lastJoplin,
      obsidian: lastObsidian,
      proposed: lastProposed,
    };
  }

  // The meeting .md is the row the panel shows; resolve it to the transcript it was (or will be)
  // built from: <base>-diarizer-response.json beside it, or in details/, or a legacy plain
  // <base>.json. Returns the processed-relative JSON name, or null when no transcript exists.
  function transcriptForMd(mdRel) {
    const processed = resolveFolders().processed;
    const dir = path.posix.dirname(mdRel);
    // Legacy analysis names from the pre-format archive: -analysis, _analysis, -meeting-analysis,
    // " - meeting analysis"; the migration's name map covers the rest. A name that only ends in
    // "analysis" can also be the whole meeting name (a Minutes note for "Q3 Cost Analysis" or
    // "project-analysis"), so each reading is tried, the Classic one first.
    for (const base of noteBases(path.posix.basename(mdRel))) {
      const dirs = dir === '.' ? ['', 'details'] : [dir, dir + '/details'];
      // The named diarizer transcript wins in either location; a plain <base>.json is only the
      // legacy transcript name and is usually the calendar sidecar, so it is the last resort.
      for (const f of [base + '-diarizer-response.json', base + '.json']) {
        for (const d of dirs) {
          const rel = d ? d + '/' + f : f;
          if (fsMod.existsSync(path.join(processed, rel))) return rel;
        }
      }
    }
    return null;
  }
  // The meeting names a note file could stand for, most likely first: the Classic / archive rule,
  // the older broad "analysis" rule, then the whole name.
  function noteBases(file) {
    const whole = String(file).replace(/\.md$/i, '');
    return [...new Set([meetingRecord.baseOfNote(file), String(file).replace(/(?:[-_ ]+meeting)?[-_ ]+analysis\.md$/i, '').replace(/\.md$/i, ''), whole])];
  }

  function normKind(kind) { return kind === 'transcribed' ? 'transcribed' : 'processed'; }
  function rootFor(kind) { const f = resolveFolders() || {}; return kind === 'transcribed' ? f.transcribed : f.processed; }

  // Is this name analyzing or queued in that root? The library's transcribed Delete refuses while
  // true (main wires it), so a source set is never removed under a running job.
  function isBusy(name, kind) {
    const k = normKind(kind), n = String(name || '');
    return !!(running && running.kind === k && running.name === n) || queue.some(q => q.kind === k && q.name === n);
  }

  function start(name, kind) {
    const k = normKind(kind);
    let n = safeRelPath(name);
    if (k === 'transcribed') {
      // A transcribed row IS the transcript: flat name, no subfolder, never a .md.
      if (!n || n.includes('/') || !/-diarizer-response\.json$/i.test(n)) return { ok: false, error: 'bad name' };
      if (!rootFor(k)) return { ok: false, error: 'no transcribed folder configured' };
    } else {
      if (n && /\.md$/i.test(n)) {
        const json = transcriptForMd(n);
        if (!json) return { ok: false, error: 'no transcript for this meeting' };
        n = json;
      }
      if (!n || !/\.json$/i.test(n)) return { ok: false, error: 'bad name' };
    }
    if (isBusy(n, k)) return { ok: false, error: 'already queued' };
    if (!fsMod.existsSync(path.join(rootFor(k), n))) return { ok: false, error: 'not found' };
    queue.push({ name: n, kind: k });
    pump();
    return Object.assign({}, getState());
  }

  function pump() {
    if (running || !queue.length) return;
    const job = queue.shift();
    const n = job.name, kind = job.kind;
    const jsonPath = path.join(rootFor(kind), n);
    const aiSetting = resolveAi();
    const ai = ['codex', 'copilot', 'owui'].includes(aiSetting) ? aiSetting : 'claude';
    running = { name: n, kind, ai, startedAt: now() };
    log('analysis started (' + ai + ', ' + kind + '): ' + n);
    // Settings can change while a batch is queued: the roots are checked again as each job starts,
    // so an overlap introduced meanwhile fails the job instead of filing into another stage.
    const bad = foldersError();
    (bad ? Promise.reject(new Error('meeting folders misconfigured: ' + bad)) : runJob(n, ai, jsonPath, kind))
      .then(r => {
        completed++;
        lastDone = Object.assign({ name: n, kind, finishedAt: now() }, r || {});
        lastError = null;
        log('analysis done: ' + n + (r && r.warning ? ' — ' + r.warning : ''));
        emitOutcome(Object.assign({ status: 'done', error: null }, lastDone));
      })
      .catch(e => {
        failed++;
        const raw = (e && e.message) || 'failed';
        log('analysis failed: ' + n + ' — ' + raw);
        // The CLI's "session expired" lands on stdout and reads as noise on a 480px panel; swap it
        // for the one instruction that fixes it. authRequired lets the batch coordinator stop early.
        lastError = AUTH_FAILURE_RE.test(raw)
          ? { name: n, kind, error: authRequiredMsg(ai), authRequired: true, finishedAt: now() }
          : { name: n, kind, error: raw, finishedAt: now() };
        emitOutcome(Object.assign({ status: 'error' }, lastError));
      })
      .finally(() => {
        running = null;
        if (!queue.length) flushTaskList();   // batch drained — write the post-analysis task list
        pump();
      });
  }

  async function runJob(name, ai, jsonPath, kind) {
    kind = normKind(kind);
    const opts = filingOptions() || {};
    // Note style (Settings → Meeting → Advanced settings): main always says which; a caller that
    // doesn't (tests, older wiring) gets Minutes Compatible, the format this module was built on.
    const classic = styleOf(opts) === 'classic';
    const dir = path.dirname(jsonPath);
    const base = path.basename(jsonPath).replace(/-diarizer-response\.json$/i, '').replace(/\.json$/i, '');
    if (kind === 'transcribed') {
      for (const s of sourceSet(jsonPath, base)) await assertOwned(s.src, s.dir);   // links refused before any model call
      // A run that committed its .md but could not finish removing the originals left a journal
      // (<base>.completed.json) naming the file. Trust it before any date rule: the sidecars that
      // decided the date may be the very files that were already removed.
      const journal = readJournal(dir, base);
      if (journal) {
        if (fsMod.existsSync(journal.md)) return clearLeftovers(name, jsonPath, base, journal.md);
        await fsp.rm(journal.path, { force: true }).catch(() => {});   // stale: its file is gone; decide afresh
      }
    }
    // Final destination first (date rule and recurring rule included); the meeting file is written there once.
    const target = await resolveTarget(jsonPath, base, opts, kind);
    const mdPath = target.mdPath;
    // A finished file already where this transcript would publish: a leftover set (cleared, no
    // model call) or a genuinely different meeting with the same name (refused) — clearLeftovers decides.
    const existingAtTarget = notePaths(path.dirname(mdPath), base, classic).find(p => fsMod.existsSync(p));
    if (kind === 'transcribed' && existingAtTarget) return clearLeftovers(name, jsonPath, base, existingAtTarget);
    // The structured-tail contract rides on whatever prompt is configured (built-in or the user's
    // edited copy) — the user's text is never modified, only followed by the fixed block.
    const promptPath = resolvePromptPath();
    const tailInstruction = classic ? STRUCTURED_TAIL_INSTRUCTION_CLASSIC : STRUCTURED_TAIL_INSTRUCTION;
    const prompt = (await fsp.readFile(promptPath, 'utf8')) + tailInstruction;
    const transcript = await fsp.readFile(jsonPath, 'utf8');
    if (transcript.length > MAX_INPUT_CHARS) throw new Error('transcript too large for one analysis (' + transcript.length + ' chars, limit ' + MAX_INPUT_CHARS + ') — not analyzed');

    // Re-analysis: the previous meeting file is read ONCE, before the model call, and its byte
    // hash is re-checked at publish so an edit made meanwhile is never overwritten. A pre-format
    // <base>-analysis.md (no frontmatter) is left untouched: the new file lands as .proposed.md.
    // A file left in the transcript's own folder by an earlier layout counts as the previous too.
    // A transcribed-kind job has no previous (the existence check above already returned): the
    // transcript's own folder is a waiting room, never a place a meeting file lives.
    // Either note style's file counts as the previous one (this style's name first), so switching
    // styles carries the record across; the record is read from the file's own style, never the setting.
    const previousCandidates = kind === 'transcribed' ? [] : notePaths(path.dirname(mdPath), base, classic);
    const dateFolderHome = path.dirname(mdTargetFor(jsonPath));
    if (kind !== 'transcribed' && dateFolderHome !== path.dirname(mdPath)) previousCandidates.push(...notePaths(dateFolderHome, base, classic));
    const previousPath = previousCandidates.find(p => fsMod.existsSync(p)) || null;
    if (previousPath) await reconcilePendingExports(previousPath);   // a pending Joplin export from a crashed run, before we snapshot the bytes
    const previous = previousPath ? meetingRecord.readRecord(fsMod, previousPath) : null;
    if (previous && !previous.ok && previous.reason === 'unreadable') throw new Error('the existing meeting file could not be read — not analyzed');
    if (previous && !previous.ok && previous.reason === 'record-conflict') log('two tracking files for ' + path.basename(previousPath) + ' — treated as untracked: ' + (previous.paths || []).join(', '));
    const previousBytes = previous ? previous.bytes || null : null;
    const previousHash = previousBytes ? sha256(previousBytes) : null;
    const previousFm = previous && previous.ok ? previous.data : null;
    const previousBedrock = (previousFm && previousFm.bedrock && typeof previousFm.bedrock === 'object') ? previousFm.bedrock : {};

    // Companion speaker-identity sources, when the recording produced them: the calendar
    // meeting-info sidecar (<base>.json — subject/organizer/attendees) and a Teams live-caption
    // .vtt (per-account attribution, far more reliable than voice clustering). Both are optional
    // extras for the prompt's identity rules — a read failure never blocks the analysis.
    let metaText = null, vttText = null;
    try {
      const sidecar = path.join(dir, base + '.json');
      // legacy plain <base>.json transcripts make the sidecar path the transcript itself — skip
      if (sidecar !== jsonPath && fsMod.existsSync(sidecar)) metaText = await fsp.readFile(sidecar, 'utf8');
    } catch (e) { log('meeting-info sidecar unreadable: ' + e.message); }
    try {
      const vttPath = companionVtt(dir, base, kind);
      if (vttPath) { vttText = await fsp.readFile(vttPath, 'utf8'); log('companion VTT found: ' + path.basename(vttPath)); }
    } catch (e) { log('companion VTT unreadable: ' + e.message); }
    // Mid-meeting highlights ride inside that same sidecar (meetingHighlights writes them there).
    const hlText = highlightsBlock(metaText);

    // The CLI trio gets the raw diarizer JSON in one combined prompt (big context windows),
    // plus the metadata and VTT when present; OWUI gets the prompt as the system message and a
    // slimmed Speaker: text transcript (+ the small metadata) as the user message — local models
    // can't afford the raw JSON's 3-4x token overhead, and a whole VTT even less.
    // Every backend gets the same size-scaled limit, measured on the full (unslimmed) inputs.
    const limitMs = jobTimeoutMs(prompt.length + transcript.length + (metaText || '').length + (vttText || '').length + (hlText || '').length);
    log('analysis time limit: ' + Math.round(limitMs / 60000) + ' min');
    let markdown;
    if (ai === 'owui') {
      markdown = await runOwui({ prompt, transcriptJson: transcript, metaText, hlText }, limitMs);
    } else {
      const input = prompt
        + (metaText ? '\n\nMeeting metadata JSON follows (calendar info — subject, organizer, attendees):\n\n' + metaText : '')
        + (vttText ? '\n\nTeams live-caption VTT transcript follows (speaker-identity aid only — never a replacement for the diarizer text):\n\n' + vttText : '')
        + (hlText || '')
        + '\n\nDiarizer JSON follows:\n\n' + transcript;
      markdown = ai === 'codex' ? await runCodex(input, limitMs) : ai === 'copilot' ? await runCopilot(input, limitMs) : await runClaude(input, limitMs);
    }
    if (!markdown.trim()) throw new Error('AI returned no output');

    // ---- the meeting file: parse the structured tail, derive turn times, build + validate ----
    const inputHash = sha256([prompt, transcript, metaText || '', vttText || '', hlText || ''].join('\u0000'));
    const tail = parseStructuredTail(markdown);
    if (tail.malformed) log('structured block malformed (' + tail.errors.join('; ') + ') — prose kept, extraction marked');
    let segments = [];
    try { const t = JSON.parse(transcript); segments = Array.isArray(t.segments) ? t.segments : []; } catch (e) { /* builder tolerates */ }
    // Classic writes the AI's text as 0.9.9 did: no turn times and no appended diarizer transcript;
    // with Separate Clean Transcript on, everything from "## Transcript" on goes to its own .txt.
    const timed = classic ? { body: tail.bodyWithoutTail, evidence: 'limited', turns: 0, unverified: 0 } : applyTurnTimes(tail.bodyWithoutTail, tail.structured.turns, segments);
    let body = timed.body;
    let cleanTranscript = null;
    if (classic && opts.separateTranscript) {
      const split = splitCleanTranscript(body);
      if (split) { body = split.notes; cleanTranscript = split.transcript; }
      else log('no "## Transcript" heading in the AI output — keeping the combined .md');
    }
    if (timed.unverified) log('transcript turns without a verifiable time: ' + timed.unverified + ' of ' + timed.turns + ' — evidence limited');
    // A complete meeting file always carries the full transcript. If the model's output has no
    // transcript turns (notes-only prompt, truncated reply), the raw diarizer transcript is
    // appended with its real labels and times — never a "complete" file with the dialogue missing.
    let transcriptSource = 'model';
    if (classic) {
      if (cleanTranscript === null && !/^##\s*Transcript\s*$/im.test(body)) transcriptSource = 'none';
    } else if (!timed.turns) {
      const raw = segments.map(s => '[' + String((s && s.speaker) || 'Speaker') + ' ' + formatTime(Number(s && s.start) || 0) + '] ' + String((s && s.text) || '').trim()).filter(l => l.length > 3);
      if (raw.length) {
        body = body.replace(/\s+$/, '') + '\n\n## Transcript\n' + raw.join('\n') + '\n';
        transcriptSource = 'diarizer';
        log('model output had no transcript turns — raw diarizer transcript appended (evidence limited)');
      } else {
        // Nothing was transcribed at all (empty diarizer result): the file says so explicitly
        // rather than pretending a transcript exists or failing a legitimately empty recording.
        transcriptSource = 'none';
        log('no transcript turns in the model output and no diarizer segments — file marked transcript: absent');
      }
    }

    const metaObj = metaText ? (() => { try { return JSON.parse(metaText); } catch (e) { return null; } })() : null;
    const built = buildFrontmatter({
      base,
      sources: { transcriptJson: transcript, meta: metaObj, capture: readJsonIfExists(fsMod, path.join(dir, base + '.capture.json')),
        wavDurationMs: wavDurationFromHeader(fsMod, path.join(dir, base + '.wav')) },
      parsed: tail, settings: { myName: resolveMyName ? (resolveMyName() || '') : '' },
      tags: joplinNotes.tagsFor ? joplinNotes.tagsFor(base) : [], previous: previousFm, now: now(),
    });
    const fm = built.frontmatter;
    fm.bedrock = Object.assign({}, fm.bedrock, {
      meeting_id: previousBedrock.meeting_id || newId('mt', now()),
      revision: (Number(previousBedrock.revision) || 0) + 1,
      input_hash: inputHash,
      evidence: transcriptSource === 'model' ? timed.evidence : 'limited',
      transcript_source: transcriptSource,
      transcript: transcriptSource === 'none' ? 'absent' : 'present',
      ai_sections: aiHeadingsOf(body),
      exports: Object.assign({}, previousBedrock.exports || {}),
      note_style: classic ? 'classic' : 'minutes',
    });
    if (cleanTranscript !== null) fm.bedrock.clean_transcript = base + '-clean_transcript.txt';
    else delete fm.bedrock.clean_transcript;
    assignItemIds(fm, previousFm, now());
    // Which date chose the folder (calendar start, capture start, or the file-name stamp) is
    // recorded in the file, with the warning when the calendar's start could not be read.
    if (target.dateSource) fm.bedrock.filing_date = target.dateSource;
    if (target.dateWarning) { fm.bedrock.filing_warning = target.dateWarning; log('filing: ' + target.dateWarning); }

    // Ownership: a user edit inside an AI-owned section (baseline hash moved) or an unreadable /
    // pre-format previous file means NO automatic replacement — the new analysis is written as a
    // proposal beside the sources and the panel says so. User-owned sections always come along.
    let proposed = false;
    if (previousFm && previousBedrock.baseline_hash) {
      const edited = baselineHash(previous.body, previousBedrock.ai_sections || []) !== previousBedrock.baseline_hash;
      if (edited) proposed = true;
      body = mergeOwnership(previous.body, body, fm.bedrock.ai_sections);
    } else if (previousBytes && !(previousFm && previousFm.status === 'processing')) {
      proposed = true;   // legacy -analysis.md or frontmatter we can't read: never overwrite it
    }
    fm.bedrock.baseline_hash = baselineHash(body, fm.bedrock.ai_sections);
    const valid = validateFrontmatter(fm);
    if (!valid.ok) throw new Error('meeting file failed validation — not published: ' + valid.errors.join('; '));
    // Classic: the .md is the body alone (no header); the record goes to <base>.bedrock.json.
    const fileText = classic ? body : assembleFile(serializeFrontmatter(fm), body);
    for (const w of built.warnings || []) log('frontmatter: ' + w);

    // Stale-write checks: the previous file's bytes must still be what the job read, no file may
    // have appeared at the destination meanwhile, and every input the model saw must still hash
    // the same (the analysis describes THOSE bytes, not whatever is on disk now).
    // When the previous was the other style's file, this style's name must still be free: a note
    // that appeared there meanwhile is not the one the analysis read, and is never replaced.
    const ownNoteAppeared = () => !!previousPath && path.resolve(previousPath) !== path.resolve(mdPath) && fsMod.existsSync(mdPath);
    if (previousPath) {
      const nowBytes = await fsp.readFile(previousPath);
      if (sha256(nowBytes) !== previousHash) throw new Error('meeting file changed during analysis — not published (re-run to analyze the current file)');
      if (ownNoteAppeared()) throw new Error('a meeting file appeared during analysis — not published (re-run to analyze the current file)');
    } else if (notePaths(path.dirname(mdPath), base, classic).some(p => fsMod.existsSync(p))) {
      throw new Error('a meeting file appeared during analysis — not published (re-run to analyze the current file)');
    }
    const inputsHashNow = async () => sha256([
      (await fsp.readFile(promptPath, 'utf8')) + tailInstruction,
      await fsp.readFile(jsonPath, 'utf8').catch(() => ''),
      await readOptional(path.join(dir, base + '.json'), jsonPath), await readOptional(companionVtt(dir, base, kind)), highlightsBlock(await readOptional(path.join(dir, base + '.json'), jsonPath)) || '',
    ].join('\u0000'));
    if (await inputsHashNow() !== inputHash) throw new Error('analysis inputs changed during analysis — not published (re-run to analyze the current files)');
    // Source filing is checked BEFORE anything is published: a differently-hashed file already at a
    // source's destination is a conflict the user must look at, not something to skip or overwrite.
    // From transcribed the publish is STAGED, never a chain of moves: every source is copied into
    // completed\…\details\ and hash-verified first, only then is the .md written, only then are
    // the originals removed. A failure before the .md is committed leaves transcribed intact (the
    // copies made here are rolled back); a failure during the cleanup after commit is reported as
    // "committed, with leftovers" — the meeting is done and the next run clears the duplicates.
    let staged = null;
    if (kind === 'transcribed') {
      staged = await stageSources(jsonPath, base, target);
      // Copying a long recording takes time: nothing may have appeared at the destination meanwhile,
      // and the inputs must still be the bytes the analysis describes. Re-checked right before commit.
      if (notePaths(path.dirname(mdPath), base, classic).some(p => fsMod.existsSync(p))) { await staged.rollback(); throw new Error('a meeting file appeared during analysis — not published (re-run to analyze the current file)'); }
      if (await inputsHashNow() !== inputHash) { await staged.rollback(); throw new Error('analysis inputs changed during analysis — not published (re-run to analyze the current files)'); }
    } else if (!proposed) await preflightSources(jsonPath, base, target);
    let publishedMd = null;
    if (proposed) {
      // The proposal remembers the exact bytes it was generated against, so applying it later can
      // refuse if the file moved on. Sources stay where they are: the kept notes still own them.
      fm.bedrock.proposal_base_hash = previousHash;
      fm.bedrock.proposal_base_path = path.basename(previousPath);
      // A Classic proposal uses the same header + body form (it is a review copy, not a note); its
      // body is exactly the .md Apply will write, and a split-off transcript waits beside it.
      const proposedText = assembleFile(serializeFrontmatter(fm), body);
      // The proposal lives beside the notes it would replace (the row the user sees), even when
      // the recurring rule would file a fresh analysis elsewhere; apply moves it to the final home.
      // Where the existing note's own style keeps it: beside a Classic note only with Use Details
      // Folder off; a Minutes (or other) note's proposal is always in details\ (the list looks there).
      const detDir = meetingRecord.isClassicName(previousPath) ? meetingRecord.sideDirFor(previousPath, 'classic', opts.useDetailsFolder) : path.join(path.dirname(previousPath), 'details');
      await fsp.mkdir(detDir, { recursive: true });
      const proposedPath = path.join(detDir, base + '.proposed.md');
      const tmp = proposedPath + '.tmp';
      await fsp.writeFile(tmp, proposedText);
      await fsp.rename(tmp, proposedPath);
      const proposedTxt = path.join(detDir, base + '.proposed-clean_transcript.txt');
      if (cleanTranscript !== null) { await fsp.writeFile(proposedTxt + '.tmp', cleanTranscript); await fsp.rename(proposedTxt + '.tmp', proposedTxt); }
      else await fsp.rm(proposedTxt, { force: true });
      lastProposed = { name: base, path: proposedPath, finishedAt: now() };
      log('existing notes were edited by hand (or are pre-format) — new analysis saved for review: ' + proposedPath);
      return;
    } else {
      if (previousPath === mdPath && previousFm && previousFm.status !== 'processing') {
        const detDir = meetingRecord.sideDirFor(mdPath, classic ? 'classic' : 'minutes', opts.useDetailsFolder);
        await fsp.mkdir(detDir, { recursive: true });
        await fsp.copyFile(mdPath, path.join(detDir, base + '.rev' + (Number(previousBedrock.revision) || 0) + '.md'));
      }
      try {
        await fsp.mkdir(path.dirname(mdPath), { recursive: true });   // a recurring or date folder may not exist yet
        const tmp = mdPath + '.tmp';
        await fsp.writeFile(tmp, fileText);
        // Replacing the note the analysis read: rename. A new name (first analysis, or the other style's
        // note was the previous): place without ever overwriting a note that appeared meanwhile.
        if (previousPath && path.resolve(previousPath) === path.resolve(mdPath)) await fsp.rename(tmp, mdPath);
        else if (!(await placeNew(tmp, mdPath))) throw new Error('a meeting file appeared during analysis — not published (re-run to analyze the current file)');
      } catch (e) {
        if (staged) await staged.rollback();   // nothing committed: the copies go, transcribed stays whole
        throw new Error('could not write the meeting file: ' + e.message);
      }
      publishedMd = mdPath;
    }
    // Classic: the .md is committed; the clean transcript and the record follow. A failure here
    // leaves a note without a (current) record, which the next analysis treats as edited: a
    // proposal, never an overwrite. It is reported, not thrown — the note itself is published.
    const sideWarning = classic ? await writeClassicSide(mdPath, base, fm, cleanTranscript, Number(previousBedrock.revision) || 0, opts.useDetailsFolder) : null;
    if (staged) {
      // Committed. Sources are already filed; now the originals leave transcribed — companions
      // first, the transcript last, so the Analysis row disappears only when its set is gone. The
      // journal written first names the finished file, so a retry after a failed cleanup never has
      // to re-derive the home from sidecars that may already be gone.
      published.set(name, mdPath);
      let left;
      try { await writeJournal(dir, base, mdPath); left = await removeOriginals(jsonPath, base); }
      catch (e) {
        // No journal, no cleanup: removing anything without it could leave a retry re-deriving a
        // different home. The whole set stays; the meeting is still done.
        log('cleanup journal not written (' + e.message + ') — originals left in transcribed');
        left = sourceSet(jsonPath, base).map(s => s.name);
      }
      const tl0 = fm.bedrock.exports && fm.bedrock.exports.task_list;
      if (!sideWarning && !(tl0 && tl0.state === 'succeeded')) batchDone.push({ base, md: mdPath, sidecar: target.meta ? path.join(target.fileDir, base + '.json') : null, meta: target.meta });
      const warnings = [
        sideWarning,
        sideWarning ? null : await createJoplinNote(base, mdPath, fileText, fm.bedrock.exports),   // no record, no export state: skip rather than half-export
        sideWarning ? null : await exportToObsidian(base, mdPath, fm.bedrock.exports),
      ].filter(Boolean);
      const out = { md: relToProcessed(mdPath) };
      if (left.length) { warnings.unshift('committed, with leftovers in transcribed: ' + left.join(', ')); log('analysis committed; cleanup left files in transcribed: ' + left.join(', ')); }
      if (warnings.length) out.warning = warnings.join('\n');
      return out;
    }

    // An earlier-layout file (date folder) or the other note style's file that served as the
    // previous moves aside as a revision; a Classic record it leaves behind is retired with it.
    if (publishedMd && previousPath && previousPath !== mdPath) {
      const rev = Number(previousBedrock.revision) || 0;
      const detDir = meetingRecord.sideDirFor(mdPath, classic ? 'classic' : 'minutes', opts.useDetailsFolder);
      await fsp.mkdir(detDir, { recursive: true });
      await fsp.rename(previousPath, path.join(detDir, base + '.rev' + rev + '.md')).catch(e => log('could not move the earlier file aside: ' + e.message));
      if (!classic && previous && previous.style === 'classic') await retireClassicRecords(previousPath, base, rev, null);
    }
    // Sources travel into details/ beside the published file; the .md itself is already in place.
    // A filing failure after publish is a visible job failure (the file is saved; the sources are not where the file says).
    const filed = await fileSet(jsonPath, null, null, base, opts, target);
    // Hand-offs happen once per meeting: a re-analysis whose task-list export already succeeded is not listed again.
    const tl = fm.bedrock.exports && fm.bedrock.exports.task_list;
    if (!sideWarning && !(tl && tl.state === 'succeeded')) batchDone.push({ base, md: mdPath, sidecar: filed ? filed.sidecar : null, meta: filed ? filed.meta : target.meta });
    const warnings = [
      sideWarning,
      sideWarning ? null : await createJoplinNote(base, mdPath, fileText, fm.bedrock.exports),   // no record, no export state: skip rather than half-export
      sideWarning ? null : await exportToObsidian(base, mdPath, fm.bedrock.exports),
    ].filter(Boolean);
    const out = { md: relToProcessed(mdPath) };
    if (warnings.length) out.warning = warnings.join('\n');
    return out;
  }

  // A meeting's pending proposal: details\<base>.proposed.md, or beside the note when it is a
  // Classic proposal (Use Details Folder off). Anything else beside a note is not a proposal.
  function findProposal(home, base) {
    const inDetails = path.join(home, 'details', base + '.proposed.md');
    if (fsMod.existsSync(inDetails)) return inDetails;
    const beside = path.join(home, base + '.proposed.md');
    try {
      const fm = readFrontmatter(fsMod.readFileSync(beside, 'utf8'));
      return fm.ok && fm.data.bedrock && fm.data.bedrock.note_style === 'classic' ? beside : null;
    } catch (e) { return null; }
  }
  // Put a finished temp file at a name that must still be free: checked, then renamed. (A hard
  // link would make this atomic, but on Windows a linked note under an antivirus scan refuses the
  // next rename onto it with EPERM; one writer per meeting makes the gap acceptable.) Returns false,
  // with the temp file removed, when the name is taken.
  async function placeNew(tmp, dest) {
    if (fsMod.existsSync(dest)) { await fsp.rm(tmp, { force: true }); return false; }
    await fsp.rename(tmp, dest);
    return true;
  }
  // Note style from the filing options; absent = Minutes Compatible (see runJob).
  function styleOf(opts) { return opts && opts.noteStyle === 'classic' ? 'classic' : 'minutes'; }
  // A meeting's note in one folder, this style's name first, then the other style's (a style switch,
  // or a 0.9.9 -analysis.md under Minutes Compatible).
  function notePaths(home, base, classic) {
    const own = classic ? meetingRecord.classicName(base) : meetingRecord.minutesName(base);
    const other = classic ? meetingRecord.minutesName(base) : meetingRecord.classicName(base);
    return [path.join(home, own), path.join(home, other)];
  }
  // Split a Classic body at its "## Transcript" heading exactly as 0.9.9 did (c0f45d8,
  // meetingAnalyze.js:235-245): the notes keep everything before it, the transcript file gets the rest.
  function splitCleanTranscript(markdown) {
    const m = /^##\s*Transcript\s*$/im.exec(markdown);
    if (!m) return null;
    return { notes: markdown.slice(0, m.index).trimEnd() + '\n', transcript: markdown.slice(m.index + m[0].length).trim() + '\n' };
  }
  // Classic side files after the .md is committed: the clean transcript (or none), then the record,
  // both in the side folder. Copies found anywhere else (Use Details Folder flipped since the last
  // analysis) are kept as revisions, so exactly one record ever names the note. Returns a warning or null.
  async function writeClassicSide(mdPath, base, data, cleanTranscript, rev, useDetailsFolder) {
    try {
      const side = meetingRecord.sideDirFor(mdPath, 'classic', useDetailsFolder);
      await fsp.mkdir(side, { recursive: true });
      const txtLeaf = base + '-clean_transcript.txt', txtPath = path.join(side, txtLeaf);
      for (const p of meetingRecord.findSide(fsMod, mdPath, txtLeaf)) {
        const keep = path.join(path.dirname(p), base + '-clean_transcript.rev' + rev + '.txt');
        if (!fsMod.existsSync(keep)) await fsp.copyFile(p, keep);
        if (cleanTranscript === null || path.resolve(p) !== path.resolve(txtPath)) await fsp.rm(p, { force: true });
      }
      if (cleanTranscript !== null) { await fsp.writeFile(txtPath + '.tmp', cleanTranscript); await fsp.rename(txtPath + '.tmp', txtPath); }
      const recPath = path.join(side, meetingRecord.recordName(base));
      // The record being replaced is kept beside its .revN.md, like the clean transcript above.
      const revRec = path.join(side, base + '.rev' + rev + '.bedrock.json');
      if (rev && fsMod.existsSync(recPath) && !fsMod.existsSync(revRec)) await fsp.copyFile(recPath, revRec);
      meetingRecord.writeClassicRecord(fsMod, recPath, mdPath, data);
      await retireClassicRecords(mdPath, base, rev, recPath);
      return null;
    } catch (e) {
      log('classic tracking file not written for ' + path.basename(mdPath) + ': ' + e.message);
      return 'tracking file not written (' + e.message + ') — the next analysis of this meeting is saved for review';
    }
  }
  // Every Classic record for this note other than `keep` becomes <base>.revN.bedrock.json.
  async function retireClassicRecords(mdPath, base, rev, keep) {
    for (const p of meetingRecord.findSide(fsMod, mdPath, meetingRecord.recordName(base))) {
      if (keep && path.resolve(p) === path.resolve(keep)) continue;
      await fsp.rename(p, path.join(path.dirname(p), base + '.rev' + rev + '.bedrock.json')).catch(e => log('could not retire ' + p + ': ' + e.message));
    }
  }

  function relToProcessed(p) { return path.relative(resolveFolders().processed, p).split(path.sep).join('/'); }

  // SHA-256 of a file without holding it in memory (recordings run to hundreds of MB).
  function hashFile(p) {
    if (typeof fsMod.createReadStream !== 'function') return fsp.readFile(p).then(sha256);
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fsMod.createReadStream(p).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve('sha256:' + h.digest('hex')));
    });
  }
  async function sameBytes(a, b) { const [x, y] = await Promise.all([hashFile(a), hashFile(b)]); return x === y; }

  // The exact source set a transcript brings along: [{ name, src, dir }] for what exists in its folder.
  // The exact source set a waiting transcript brings along — exact companions ONLY (<base>.wav,
  // <base>.json, <base>.capture.json, <base>.vtt, <base>-screenshots\); the stamp-prefix caption
  // fallback of the old archive layout could claim another meeting's captions here. Names are
  // matched case-insensitively but the ACTUAL on-disk name is carried (a .WAV stays .WAV).
  function actualName(dir, want) {
    try { return fsMod.readdirSync(dir).find(e => e.toLowerCase() === want.toLowerCase()) || null; } catch (e) { return null; }
  }
  function sourceSet(jsonPath, base) {
    const dir = path.dirname(jsonPath);
    const names = [path.basename(jsonPath), base + '.wav', base + '.json', base + '.capture.json', base + '.vtt'].map(n => actualName(dir, n)).filter(Boolean);
    const set = [...new Set(names)].filter(n => fsMod.existsSync(path.join(dir, n))).map(n => ({ name: n, src: path.join(dir, n), dir: false }));
    const shots = actualName(dir, base + '-screenshots');
    if (shots && fsMod.existsSync(path.join(dir, shots))) set.push({ name: shots, src: path.join(dir, shots), dir: true });
    return set;
  }
  // Captions for the prompt: a waiting transcript uses its exact <base>.vtt only; a meeting in
  // completed keeps the legacy stamp-prefix fallback (its folder holds one meeting's files).
  function companionVtt(dir, base, kind) {
    if (normKind(kind) !== 'transcribed') return findCompanionVtt(dir, base);
    const n = actualName(dir, base + '.vtt');
    return n ? path.join(dir, n) : null;
  }

  // Sources are the app's own files, never links: a symlink or junction anywhere in a source (or a
  // source tree) is refused before anything is copied or removed, so nothing outside the folder
  // can be read into completed or deleted through it.
  async function assertOwned(p, isDir) {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) throw new Error('source "' + path.basename(p) + '" is a link — refused');
    if (isDir && st.isDirectory()) for (const e of await fsp.readdir(p)) await assertOwned(path.join(p, e), true);
  }
  // The destination must resolve inside the completed root (no junction under it pointing elsewhere).
  async function assertInsideProcessed(dirPath) {
    const norm = s => process.platform === 'win32' ? s.toLowerCase() : s;
    const root = norm(await fsp.realpath(resolveFolders().processed)), real = norm(await fsp.realpath(dirPath));
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('destination resolves outside the completed folder — refused');
  }

  // Cleanup journal: <base>.completed.json beside the originals, written after the .md is
  // committed and removed last. It names the finished file so a retry never re-derives the home.
  const journalPath = (dir, base) => path.join(dir, base + '.completed.json');
  function readJournal(dir, base) {
    const p = journalPath(dir, base);
    const j = readJsonIfExists(fsMod, p);
    const rel = j && typeof j.md === 'string' ? safeRelPath(j.md) : null;
    if (!rel || !/\.md$/i.test(rel)) return null;
    return { path: p, md: path.join(resolveFolders().processed, rel) };
  }
  async function writeJournal(dir, base, mdPath) {
    const p = journalPath(dir, base), tmp = p + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ schema: 1, md: relToProcessed(mdPath), committed_at: new Date(now()).toISOString() }, null, 2));
    await fsp.rename(tmp, p);
  }

  // A finished file already exists for this waiting set: either every source is already filed
  // beside it byte for byte (the leftover of a cleanup that failed after commit) — remove the
  // originals, no model call — or it is a different meeting with the same name: refuse.
  async function clearLeftovers(name, jsonPath, base, mdPath) {
    // A Classic note may have its sources beside it (Use Details Folder off), so both side folders count.
    let filed = false;
    for (const fileDir of meetingRecord.isClassicName(mdPath) ? meetingRecord.sideDirs(mdPath) : [path.join(path.dirname(mdPath), 'details')]) {
      if (await sourcesAlreadyFiled(jsonPath, base, { mdPath, fileDir })) { filed = true; break; }
    }
    if (!filed) {
      throw new Error('a completed meeting file already exists at ' + relToProcessed(mdPath) + ' — not published (rename the transcript or remove the finished file first)');
    }
    const left = await removeOriginals(jsonPath, base);
    published.set(name, mdPath);
    if (left.length) return { md: relToProcessed(mdPath), warning: 'already completed; leftovers still in transcribed: ' + left.join(', ') };
    log('leftover sources cleared from transcribed (meeting already completed): ' + base);
    return { md: relToProcessed(mdPath), warning: 'already completed; leftovers cleared' };
  }
  function walkFiles(root) {
    const out = [];
    const walk = d => { for (const e of fsMod.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(root, p)); } };
    walk(root);
    return out.sort();
  }
  async function sameTree(a, b) {
    const fa = walkFiles(a), fb = walkFiles(b);
    if (fa.length !== fb.length || fa.some((f, i) => f !== fb[i])) return false;
    for (const f of fa) if (!(await sameBytes(path.join(a, f), path.join(b, f)))) return false;
    return true;
  }

  // Copy every source into the destination details folder and verify each copy by hash. A file
  // already there with the same bytes is accepted as filed; different bytes are a conflict and
  // nothing further is copied. Returns { rollback } — removes only what this call created.
  async function stageSources(jsonPath, base, target) {
    const created = [];
    const rollback = async () => {
      for (const c of created.reverse()) await fsp.rm(c.dest, { recursive: !!c.dir, force: true }).catch(e => log('rollback could not remove ' + c.dest + ': ' + e.message));
      created.length = 0;
    };
    try {
      const set = sourceSet(jsonPath, base);
      for (const s of set) await assertOwned(s.src, s.dir);
      await fsp.mkdir(target.fileDir, { recursive: true });
      await assertInsideProcessed(target.fileDir);
      for (const s of set) {
        const dest = path.join(target.fileDir, s.name);
        if (fsMod.existsSync(dest)) {
          await assertOwned(dest, s.dir);
          const same = s.dir ? await sameTree(s.src, dest) : await sameBytes(s.src, dest);
          if (!same) throw new Error('source filing conflict: a different "' + s.name + '" already exists in ' + relToProcessed(target.fileDir) + ' — not published');
          continue;   // already filed, byte for byte
        }
        // Registered as ours BEFORE the copy, so a copy that dies halfway (partial bytes) is still
        // rolled back. Exclusive mode: a destination that exists by the time we write is NEVER ours —
        // it is unregistered and reported as a conflict, not rolled back. A folder is copied into an
        // isolated staging name and renamed into place for the same reason (a foreign folder that
        // appears meanwhile makes the rename fail and is left alone).
        if (s.dir) {
          const staging = dest + '.staging-' + process.pid;
          created.push({ dest: staging, dir: true });
          await fsp.cp(s.src, staging, { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true });
          if (fsMod.existsSync(dest)) throw new Error('source filing conflict: "' + s.name + '" appeared in ' + relToProcessed(target.fileDir) + ' during filing — not published');
          await fsp.rename(staging, dest);
          created[created.length - 1].dest = dest;
        } else {
          created.push({ dest, dir: false });
          try { await fsp.copyFile(s.src, dest, fsMod.constants ? fsMod.constants.COPYFILE_EXCL : 1); }
          catch (e) {
            if (e && e.code === 'EEXIST') { created.pop(); throw new Error('source filing conflict: "' + s.name + '" appeared in ' + relToProcessed(target.fileDir) + ' during filing — not published'); }
            throw e;
          }
        }
        const ok = s.dir ? await sameTree(s.src, dest) : await sameBytes(s.src, dest);
        if (!ok) throw new Error('copy of "' + s.name + '" did not verify — not published');
      }
    } catch (e) { await rollback(); throw e; }
    return { rollback };
  }

  // Are all of this transcript's sources already in the destination, byte for byte?
  async function sourcesAlreadyFiled(jsonPath, base, target) {
    const set = sourceSet(jsonPath, base);
    for (const s of set) await assertOwned(s.src, s.dir);
    if (!fsMod.existsSync(target.fileDir)) return false;
    await assertInsideProcessed(target.fileDir);
    for (const s of set) {
      const dest = path.join(target.fileDir, s.name);
      if (!fsMod.existsSync(dest)) return false;
      await assertOwned(dest, s.dir);
      if (!(s.dir ? await sameTree(s.src, dest) : await sameBytes(s.src, dest))) return false;
    }
    return true;
  }

  // Remove the originals after commit, in an order that keeps a retry pointed at the SAME home:
  // bulk companions first (wav, captions, screenshots), then the two sidecars that decide the
  // date, the transcript last (it is the row). The first failure stops the cleanup, so whatever
  // is left still includes the date sidecars and the row; the next run finds the finished file,
  // verifies the leftovers byte for byte and clears them. Returns the names left behind.
  async function removeOriginals(jsonPath, base) {
    const dir = path.dirname(jsonPath);
    const set = sourceSet(jsonPath, base);
    for (const s of set) await assertOwned(s.src, s.dir).catch(e => { throw new Error('cleanup refused: ' + e.message); });
    const rank = s => s.src === jsonPath ? 3 : /\.capture\.json$/i.test(s.name) ? 1 : s.name.toLowerCase() === (base + '.json').toLowerCase() ? 2 : 0;
    const ordered = set.slice().sort((a, b) => rank(a) - rank(b));
    const jp = journalPath(dir, base);
    if (fsMod.existsSync(jp)) ordered.push({ name: path.basename(jp), src: jp, dir: false });   // the journal goes last of all
    for (let i = 0; i < ordered.length; i++) {
      try { await fsp.rm(ordered[i].src, { recursive: !!ordered[i].dir, force: true }); }
      catch (e) {
        log('could not remove ' + ordered[i].src + ' after publish: ' + e.message);
        return ordered.slice(i).map(s => s.name);
      }
    }
    return [];
  }

  // Every source this meeting will file into details/ must either not exist there yet or be the
  // very same bytes; anything else stops the job before the .md is written.
  async function preflightSources(jsonPath, base, target) {
    const dir = path.dirname(jsonPath);
    const names = [path.basename(jsonPath), base + '.wav', base + '.json', base + '.capture.json'];
    const vtt = findCompanionVtt(dir, base);
    if (vtt) names.push(path.basename(vtt));
    for (const n of names) {
      const src = path.join(dir, n), dest = path.join(target.fileDir, n);
      if (src === dest || !fsMod.existsSync(src) || !fsMod.existsSync(dest)) continue;
      const [a, b] = await Promise.all([fsp.readFile(src), fsp.readFile(dest)]);
      if (sha256(a) !== sha256(b)) throw new Error('source filing conflict: a different "' + n + '" already exists in ' + path.relative(resolveFolders().processed, target.fileDir) + ' — not published');
    }
  }

  async function readOptional(p, notThis) {
    if (!p || p === notThis) return '';
    try { return await fsp.readFile(p, 'utf8'); } catch (e) { return ''; }
  }

  // A Joplin export left `pending` by a crash or timeout: the note was created with OUR id, so
  // asking Joplin for that id settles it without a second note. An Obsidian export left `pending`
  // is settled by re-hashing the vault copy: the bytes the record names are there, or they are not.
  async function reconcilePendingExports(mdFile) {
    let exports = null;
    try {
      const parsed = meetingRecord.readRecord(fsMod, mdFile);
      if (parsed.reason === 'unreadable') throw new Error('meeting file unreadable');
      exports = (parsed.ok && parsed.data.bedrock && parsed.data.bedrock.exports) || null;
    } catch (e) { log('export reconcile skipped: ' + e.message); return; }
    try {
      const pending = exports && exports.joplin;
      if (pending && pending.state === 'pending' && pending.id) {
        const cfg = resolveJoplin() || {};
        if (cfg.enabled && joplinNotes.getNote) {
          const note = await joplinNotes.getNote({ url: cfg.url, token: cfg.token, id: pending.id });
          if (note) {
            await patchFrontmatter(mdFile, d => { d.bedrock.exports = Object.assign({}, d.bedrock.exports, { joplin: { id: pending.id, state: 'succeeded' } }); });
            log('joplin export reconciled as succeeded: ' + path.basename(mdFile));
          }
        }
      }
    } catch (e) { log('joplin export reconcile skipped: ' + e.message); }
    try {
      const pending = exports && exports.obsidian;
      if (pending && pending.state === 'pending') {
        const cfg = resolveObsidian() || {};
        if (cfg.enabled && await obsidianExport.verifyExport({ fs: fsMod, vaultRoot: cfg.vault, record: pending })) {
          await patchFrontmatter(mdFile, d => { d.bedrock.exports = Object.assign({}, d.bedrock.exports, { obsidian: { state: 'succeeded', path: pending.path, hash: pending.hash } }); });
          log('obsidian export reconciled as succeeded: ' + path.basename(mdFile));
        }
      }
    } catch (e) { log('obsidian export reconcile skipped: ' + e.message); }
  }

  // Apply a reviewed proposal (details/<base>.proposed.md) over the current meeting file: the
  // current file becomes the next revision backup, the proposal becomes the file with its
  // revision/identity/exports carried from the current one, and the proposal is removed.
  async function applyProposed(name) {
    const n = safeRelPath(name);
    if (!n || !/\.md$/i.test(n)) return { ok: false, error: 'bad name' };
    const processed = resolveFolders().processed;
    const home = path.dirname(path.join(processed, n));
    // The meeting the row stands for: the first reading of its name that has a proposal waiting.
    let base = null, proposedPath = null;
    for (const b of noteBases(path.basename(n))) { const p = findProposal(home, b); if (p) { base = b; proposedPath = p; break; } }
    if (!proposedPath) return { ok: false, error: 'no proposal to apply' };
    if (running && running.kind === 'processed' && running.name && transcriptForMd(n) === running.name) return { ok: false, error: 'this meeting is being analyzed right now' };
    try {
      const proposed = readFrontmatter(await fsp.readFile(proposedPath, 'utf8'));
      if (!proposed.ok) return { ok: false, error: 'proposal unreadable' };
      const pb = proposed.data.bedrock || {};
      // The note takes the style the proposal was written in (its body is that style's), whatever
      // the setting says now; a proposal from before the setting existed is Minutes Compatible.
      const classic = pb.note_style === 'classic';
      const opts = filingOptions() || {};
      const mdFile = path.join(home, classic ? meetingRecord.classicName(base) : meetingRecord.minutesName(base));
      const detDir = meetingRecord.sideDirFor(mdFile, classic ? 'classic' : 'minutes', opts.useDetailsFolder);
      // The proposal was generated against specific bytes; the file it would replace must still be
      // exactly those bytes, or the user's later edits / completed items would be lost.
      const basePath = pb.proposal_base_path ? path.join(home, String(pb.proposal_base_path)) : (notePaths(home, base, classic).find(p => fsMod.existsSync(p)) || mdFile);
      if (path.dirname(path.resolve(basePath)) !== path.dirname(path.resolve(mdFile))) return { ok: false, error: 'proposal base path outside the meeting folder' };
      const baseBytes = fsMod.existsSync(basePath) ? await fsp.readFile(basePath) : null;
      if (pb.proposal_base_hash && (!baseBytes || sha256(baseBytes) !== pb.proposal_base_hash)) {
        return { ok: false, error: 'the notes changed after this proposal was made — re-analyze to get a fresh proposal' };
      }
      // A proposal in the other style lands on a different file: if a note already sits there (a
      // copy, a sync restore, an analysis since), it is nobody's base and is never replaced.
      const otherNoteInTheWay = () => path.resolve(basePath) !== path.resolve(mdFile) && fsMod.existsSync(mdFile);
      const inTheWay = () => ({ ok: false, error: 'a meeting file already exists at ' + path.relative(processed, mdFile) + ' — nothing replaced (move or remove it, then apply again)' });
      if (otherNoteInTheWay()) return inTheWay();
      let revision = 0, carry = {}, current = null;
      if (baseBytes) {
        current = meetingRecord.readRecord(fsMod, basePath);
        if (current.ok && current.data.bedrock) {
          revision = Number(current.data.bedrock.revision) || 0;
          carry = { meeting_id: current.data.bedrock.meeting_id, exports: current.data.bedrock.exports };
        }
      }
      const data = proposed.data;
      delete data.bedrock.proposal_base_hash; delete data.bedrock.proposal_base_path;
      data.bedrock = Object.assign({}, data.bedrock, carry, { revision: revision + 1 });
      if (!data.bedrock.meeting_id) data.bedrock.meeting_id = newId('mt', now());
      data.bedrock.baseline_hash = baselineHash(proposed.body, data.bedrock.ai_sections || []);
      const valid = validateFrontmatter(data);
      if (!valid.ok) return { ok: false, error: 'proposal failed validation: ' + valid.errors.join('; ') };
      // Classic: the proposal's body IS the note; its record and split-off transcript go beside it.
      const text = classic ? proposed.body : assembleFile(serializeFrontmatter(data), proposed.body);
      const proposedTxt = path.join(path.dirname(proposedPath), base + '.proposed-clean_transcript.txt');
      const cleanTranscript = classic && fsMod.existsSync(proposedTxt) ? await fsp.readFile(proposedTxt, 'utf8') : null;
      // validated; now back up, re-check the base once more, and replace
      if (baseBytes) {
        await fsp.mkdir(detDir, { recursive: true });
        await fsp.copyFile(basePath, path.join(detDir, base + '.rev' + revision + '.md'));
        if (sha256(await fsp.readFile(basePath)) !== sha256(baseBytes)) return { ok: false, error: 'the notes changed while applying — nothing replaced' };
      }
      const tmp = mdFile + '.tmp';
      await fsp.writeFile(tmp, text);
      // In place: replace. Onto the other style's name: place without ever overwriting (atomic where the disk allows).
      if (path.resolve(basePath) === path.resolve(mdFile)) await fsp.rename(tmp, mdFile);
      else if (!(await placeNew(tmp, mdFile))) return inTheWay();
      // The other style's file (backed up above) is retired. A Classic note replaced in place is
      // never removed: basePath IS mdFile.
      if (baseBytes && path.resolve(basePath) !== path.resolve(mdFile)) {
        await fsp.unlink(basePath).catch(() => {});
        if (!classic && current && current.style === 'classic') await retireClassicRecords(basePath, base, revision, null);
      }
      const sideWarning = classic ? await writeClassicSide(mdFile, base, data, cleanTranscript, revision, opts.useDetailsFolder) : null;
      await fsp.unlink(proposedPath);
      await fsp.rm(proposedTxt, { force: true });
      // Final destination (recurring rule) and source filing happen now, as they would after an
      // ordinary publish: the applied file moves to its home and the sources follow into details/.
      let mdFinal = mdFile;
      try {
        const jsonRel = transcriptForMd(path.posix.join(path.posix.dirname(n) === '.' ? '' : path.posix.dirname(n), base + '.md'));
        if (jsonRel) {
          const jsonAbs = path.join(processed, jsonRel);
          const fileOpts = Object.assign({}, opts, { noteStyle: classic ? 'classic' : 'minutes' });
          const target = await resolveTarget(jsonAbs, base, fileOpts);
          if (path.resolve(target.mdPath) !== path.resolve(mdFile)) {
            // Either style's note already in the destination folder is another file: never joined, never replaced.
            const clash = notePaths(path.dirname(target.mdPath), base, classic).find(p => fsMod.existsSync(p));
            if (clash) throw new Error('a meeting file already exists at ' + path.relative(processed, clash));
            await preflightSources(jsonAbs, base, target);
            await fsp.mkdir(path.dirname(target.mdPath), { recursive: true });
            await fsp.rename(mdFile, target.mdPath);
            mdFinal = target.mdPath;   // the note is there now, whatever happens next
            if (classic) {
              // The record and the clean transcript follow the note: written and checked at the new
              // folder first, and only then removed from the old one (a failure keeps the originals).
              const moved = await writeClassicSide(target.mdPath, base, data, cleanTranscript, revision, opts.useDetailsFolder);
              if (moved) throw new Error(moved + '; the tracking file and clean transcript are still in ' + path.relative(processed, path.dirname(mdFile)));
              for (const leaf of [meetingRecord.recordName(base), base + '-clean_transcript.txt']) {
                for (const p of meetingRecord.findSide(fsMod, mdFile, leaf)) await fsp.rm(p, { force: true });
              }
            }
          }
          await fileSet(jsonAbs, null, null, base, fileOpts, target);
          mdFinal = target.mdPath;
        }
      } catch (e) {
        log('applied proposal is saved, but filing it to its final folder failed: ' + e.message);
        return { ok: true, name: n, md: relToProcessed(mdFinal), warning: 'applied as ' + relToProcessed(mdFinal) + '; filing failed: ' + e.message };
      }
      // The applied version is the meeting file now: the vault copy follows it (same edit guard).
      await exportToObsidian(base, mdFinal, carry.exports);
      if (lastProposed && lastProposed.name === base) lastProposed = null;
      log('proposed analysis applied: ' + n);
      return sideWarning ? { ok: true, name: n, warning: sideWarning } : { ok: true, name: n };
    } catch (e) { return { ok: false, error: (e && e.message) || 'apply failed' }; }
  }

  // Rewrite only the record of a published meeting (export state, revision bookkeeping), in either
  // note style: the Minutes header with the SAME body, or the Classic <base>.bedrock.json. Refuses
  // if the bytes moved between read and write (meetingRecord.patchRecord).
  async function patchFrontmatter(filePath, mutate) {
    meetingRecord.patchRecord(fsMod, filePath, mutate);
  }

  // Post-analysis Joplin note (replaces the retired Cowork pipeline's note step). The body is the
  // analysis markdown — with "Separate Clean Transcript" on that's the notes without the
  // transcript, matching what the old pipeline filed. A Joplin failure never fails the analysis
  // (the .md is already saved); it's logged and surfaced on the panel via getState().joplin.
  // Durable export state so a crash or timeout between "note created in Joplin" and "id stored
  // here" can never produce a second note: the id is allocated and written into the meeting file
  // as `pending` BEFORE the request, the note is created WITH that id, and the state flips to
  // `succeeded` afterwards. A re-analysis with a succeeded export does not export again.
  async function createJoplinNote(base, mdFile, markdown, exports) {
    const cfg = resolveJoplin() || {};
    if (!cfg.enabled) return;
    const prior = (exports && exports.joplin) || null;
    if (prior && prior.state === 'succeeded') return;
    const id = (prior && prior.id) || crypto.randomBytes(16).toString('hex');
    try {
      await patchFrontmatter(mdFile, d => { d.bedrock = d.bedrock || {}; d.bedrock.exports = Object.assign({}, d.bedrock.exports, { joplin: { id, state: 'pending' } }); });
      const r = await joplinNotes.createAnalysisNote({
        url: cfg.url, token: cfg.token, notebook: cfg.notebook, title: base, body: markdown, id,
      });
      await patchFrontmatter(mdFile, d => { d.bedrock.exports = Object.assign({}, d.bedrock.exports, { joplin: { id: r.id || id, state: 'succeeded' } }); });
      lastJoplin = { name: base, ok: true, applied: r.applied, skipped: r.skipped, finishedAt: now() };
      log('joplin note created: ' + base + ' [' + r.applied.join(', ') + ']'
        + (r.skipped.length ? ' — tag(s) not in Joplin, skipped: ' + r.skipped.join(', ') : ''));
    } catch (e) {
      lastJoplin = { name: base, ok: false, error: (e && e.message) || 'failed', finishedAt: now() };
      log('joplin note failed: ' + base + ' — ' + lastJoplin.error + ' (export left pending; reconciled on the next analysis of this meeting)');
      return 'Joplin export failed: ' + lastJoplin.error;
    }
  }

  // Post-analysis Obsidian export: the published meeting file, byte for byte, copied into the
  // vault at its Completed-relative path (see obsidianExport.js). Unlike Joplin this runs on EVERY
  // publish — a re-analysis is new content — and never overwrites a vault copy that was edited
  // there: that one gets <base>.conflict.md beside it. The meeting file records the export as
  // `pending` (with the hash of the bytes being written) before the copy and `succeeded` /
  // `conflict` after; the vault is checked first so a missing vault records nothing. A failure
  // never fails the analysis (the .md is already saved); it is logged and shown on the panel.
  async function exportToObsidian(base, mdFile, exports) {
    const cfg = resolveObsidian() || {};
    if (!cfg.enabled) return;
    const prior = (exports && exports.obsidian) || null;
    const relPath = relToProcessed(mdFile);
    try {
      obsidianExport.resolveVault(fsMod, cfg.vault);
      const bytes = await fsp.readFile(mdFile);   // as published (any Joplin record included), before this export's own bookkeeping
      const pending = { state: 'pending', path: relPath, hash: sha256(bytes) };
      if (prior && prior.hash) pending.prior_hash = prior.hash;
      await patchFrontmatter(mdFile, d => { d.bedrock = d.bedrock || {}; d.bedrock.exports = Object.assign({}, d.bedrock.exports, { obsidian: pending }); });
      const r = await obsidianExport.exportMeetingFile({ fs: fsMod, vaultRoot: cfg.vault, relPath, bytes, prior, log });
      await patchFrontmatter(mdFile, d => { d.bedrock.exports = Object.assign({}, d.bedrock.exports, { obsidian: r }); });
      if (r.state === 'conflict') {
        lastObsidian = { name: base, ok: false, state: r.state, path: r.path, conflict: r.conflict, error: 'the vault copy was edited there — new analysis saved beside it as ' + path.posix.basename(r.conflict), finishedAt: now() };
        log('obsidian export conflict: ' + base + ' — vault copy edited, new analysis written to ' + r.conflict);
        return 'Obsidian export conflict: ' + lastObsidian.error;
      } else {
        lastObsidian = { name: base, ok: true, state: r.state, path: r.path, finishedAt: now() };
        log('obsidian export written: ' + r.path + (r.left ? ' (earlier copy left in place: ' + r.left + ')' : ''));
      }
    } catch (e) {
      lastObsidian = { name: base, ok: false, error: (e && e.message) || 'failed', finishedAt: now() };
      log('obsidian export failed: ' + base + ' — ' + lastObsidian.error);
      return 'Obsidian export failed: ' + lastObsidian.error;
    }
  }

  // Locate the Teams .vtt shipped alongside the diarizer JSON. Exact <base>.vtt first; Teams
  // sometimes swaps a separator in the shared date/time prefix (observed: "_" where the JSON has
  // "-"), so fall back to the single .vtt whose normalized 19-char stamp prefix matches. Two
  // ambiguous candidates → none (never guess which meeting a caption file belongs to).
  function findCompanionVtt(dir, base) {
    const exact = path.join(dir, base + '.vtt');
    if (fsMod.existsSync(exact)) return exact;
    const stamp = s => String(s).slice(0, 19).replace(/[_]/g, '-');
    if (!/^\d{4}/.test(base)) return null;   // no leading date stamp — nothing safe to match on
    let found = null;
    let names;
    try { names = fsMod.readdirSync(dir); } catch (e) { return null; }
    for (const f of names) {
      if (!/\.vtt$/i.test(f)) continue;
      if (stamp(f) !== stamp(base)) continue;
      if (found) return null;
      found = path.join(dir, f);
    }
    return found;
  }

  // Post-analysis filing: recurring meetings move to <processed>/YYYY/<Meeting-Name>/, and with
  // "Use Details Folder" everything except the .md tucks into a details/ subfolder. Runs after
  // the .md exists so unanalyzed meetings always stay in the easy-to-find date folders.
  // Where this meeting's file and sources belong, decided BEFORE anything is written: the
  // transcript's folder (or its parent when it sits in details/), or the recurring-meeting folder
  // when the calendar sidecar says so and the option is on. The sidecar also feeds the task list.
  async function resolveTarget(jsonPath, base, opts, kind) {
    kind = normKind(kind);
    const dir = path.dirname(jsonPath);
    const inDetails = path.basename(dir).toLowerCase() === 'details';
    let home = inDetails ? path.dirname(dir) : dir;
    let meta = null;
    try {
      const sidecar = path.join(dir, base + '.json');
      if (sidecar !== jsonPath && fsMod.existsSync(sidecar)) meta = JSON.parse(await fsp.readFile(sidecar, 'utf8')) || null;
    } catch (e) { log('meeting-info sidecar unreadable: ' + e.message); }
    const recurringName = opts.separateRecurring && meta && meta.is_recurring ? sanitizeSubjectFolder(meta.subject) : '';
    let dateSource = null, dateWarning = null;
    if (kind === 'transcribed') {
      // From the waiting room the home is decided by the meeting's own date (never the processing
      // date): the recurring folder, the YYYY\MM folder when Organize by date is on, else the root.
      const when = meetingDate(meta, dir, base);
      if (!when.date) throw new Error(when.error);
      dateSource = when.source; dateWarning = when.warning;
      const processed = resolveFolders().processed;
      const y = String(when.date.getFullYear()), m = pad2(when.date.getMonth() + 1);
      home = recurringName ? path.join(processed, y, recurringName) : opts.byDate ? path.join(processed, y, m) : processed;
    } else if (recurringName) {
      // Re-analysis in completed: a recurring meeting still moves to its folder; the year follows
      // the same date rule, falling back to the old file-name year when no date can be found.
      const when = meetingDate(meta, dir, base);
      const ym = /^(\d{4})/.exec(base);
      const year = when.date ? String(when.date.getFullYear()) : ym ? ym[1] : String(new Date(now()).getFullYear());
      home = path.join(resolveFolders().processed, year, recurringName);
    }
    // Classic files the sources exactly as Use Details Folder says, from any stage; Minutes
    // Compatible always into details\ (main passes useDetailsFolder: true for it).
    const classic = styleOf(opts) === 'classic';
    const fileDir = classic ? (opts.useDetailsFolder ? path.join(home, 'details') : home)
      : opts.useDetailsFolder || kind === 'transcribed' ? path.join(home, 'details') : home;
    return { dir, home, fileDir, meta, mdPath: path.join(home, classic ? meetingRecord.classicName(base) : meetingRecord.minutesName(base)), dateSource, dateWarning };
  }

  // The date that files a meeting (decided 2026-10-15): the calendar sidecar's start, in this
  // machine's local time; without a calendar entry, the capture sidecar's start; without that,
  // the date stamp in the recording's file name. A calendar start that cannot be read falls back
  // with a warning; no usable date at all is an error (the transcript stays where it is).
  function meetingDate(meta, dir, base) {
    const valid = d => d instanceof Date && !isNaN(d.getTime()) && d.getFullYear() >= 2000 && d.getFullYear() <= 2100;
    let warning = null;
    if (meta && meta.start !== undefined && meta.start !== null && meta.start !== '') {
      const d = new Date(String(meta.start));
      if (valid(d)) return { date: d, source: 'calendar', warning: null };
      warning = 'calendar start "' + String(meta.start) + '" is not a readable date — filed by the recording date instead';
    } else if (meta) {
      warning = 'calendar entry has no start — filed by the recording date instead';
    }
    const capture = readJsonIfExists(fsMod, path.join(dir, base + '.capture.json'));
    if (capture && capture.started_at) {
      const d = new Date(String(capture.started_at));
      if (valid(d)) return { date: d, source: 'capture', warning };
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})-(\d{2})-(\d{2}))?/.exec(base);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
      if (valid(d) && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3]) return { date: d, source: 'filename', warning };
    }
    return { date: null, source: null, warning, error: 'no usable date for this meeting (no calendar start, no capture start, no date in the file name) — not filed; it stays in transcribed' };
  }

  async function fileSet(jsonPath, mdPath, txtPath, base, opts, target) {
    const { dir, home, fileDir, meta } = target || await resolveTarget(jsonPath, base, opts);

    // Move a file/dir into place: skip if missing or the target already exists; try an atomic rename,
    // and on a cross-device failure fall back to copy+delete (recursive for a directory).
    const move = async (src, dest, recursive) => {
      if (!src || src === dest || !fsMod.existsSync(src)) return;
      if (fsMod.existsSync(dest)) {
        if (recursive) { log('filing skipped (folder exists): ' + path.basename(dest)); return; }
        // Same bytes already there (an earlier interrupted run): drop the duplicate source.
        // Different bytes: a real conflict — preflightSources should have caught it; fail loudly.
        const [a, b] = await Promise.all([fsp.readFile(src), fsp.readFile(dest)]);
        if (sha256(a) === sha256(b)) { await fsp.unlink(src); return; }
        throw new Error('a different "' + path.basename(dest) + '" already exists at the destination');
      }
      try { await fsp.rename(src, dest); }
      catch (e) {
        if (recursive) { await fsp.cp(src, dest, { recursive: true }); await fsp.rm(src, { recursive: true, force: true }); }
        else { await fsp.copyFile(src, dest); await fsp.unlink(src); }
      }
    };
    const mv = (src, dest) => move(src, dest, false);
    // The slide-capture folder (<base>-screenshots\) travels with the WAV — same target dir, recursive.
    const mvDir = (src, dest) => move(src, dest, true);
    try {
      await fsp.mkdir(fileDir, { recursive: true });
      if (mdPath) await mv(mdPath, path.join(home, path.basename(mdPath)));   // null = the .md is already at its final path
      await mv(jsonPath, path.join(fileDir, path.basename(jsonPath)));
      await mv(path.join(dir, base + '.wav'), path.join(fileDir, base + '.wav'));
      await mv(path.join(dir, base + '.json'), path.join(fileDir, base + '.json'));
      await mv(path.join(dir, base + '.capture.json'), path.join(fileDir, base + '.capture.json'));   // capture start + offset
      await mv(txtPath, txtPath ? path.join(fileDir, path.basename(txtPath)) : null);
      const vtt = findCompanionVtt(dir, base);   // Teams captions travel with the WAV
      if (vtt) await mv(vtt, path.join(fileDir, path.basename(vtt)));
      await mvDir(path.join(dir, base + '-screenshots'), path.join(fileDir, base + '-screenshots'));
    } catch (e) { throw new Error('analysis published, but filing its sources failed: ' + e.message); }
    return {
      md: mdPath ? path.join(home, path.basename(mdPath)) : path.join(home, base + ".md"),
      sidecar: meta ? path.join(fileDir, base + '.json') : null,
      meta,
    };
  }

  // "Create task-lists for post-analysis processing": one checklist per analysis batch, written
  // when the queue drains — the hand-off T.J.'s kanban ingestion picks up. Mirrors the old
  // diarizer-batch format but points at the finished -analysis.md files. Only successful analyses
  // are listed; failures stay visible on the panel instead.
  function pad2(n) { return String(n).padStart(2, '0'); }
  async function flushTaskList() {
    const items = batchDone.splice(0);
    const cfg = resolveTaskList() || {};
    if (!cfg.enabled || !items.length) return;
    try {
      const processed = resolveFolders().processed;
      const folder = String(cfg.folder || '').trim() || path.join(processed, 'task-list');
      await fsp.mkdir(folder, { recursive: true });
      const d = new Date(now());
      const stamp = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
        + '_' + pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds());
      const rel = p => path.relative(processed, p).split(path.sep).join('/');
      const lines = [
        '# Analysis batch — ' + stamp.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2'),
        '',
        items.length + ' meeting(s) analyzed. Paths below are relative to the meetings root. For each item, review the Action Items in the analysis and pick up the ones assigned to you.',
        '',
        '## Meetings',
        '',
      ];
      for (const it of items) {
        const title = (it.meta && String(it.meta.subject || '').trim()) || it.base;
        const tags = it.meta
          ? (it.meta.is_recurring ? ' (recurring)' : '') + (it.meta.organizer ? ' — ' + it.meta.organizer : '')
          : '';
        lines.push('- [ ] **' + title + '**' + tags);
        lines.push('    - Analysis: `' + rel(it.md) + '`');
        if (it.sidecar && fsMod.existsSync(it.sidecar)) lines.push('    - Meeting metadata: `' + rel(it.sidecar) + '`');
      }
      lines.push('');
      // The hand-off identity is persisted on each meeting file as `pending` BEFORE the list is
      // written and flipped to `succeeded` after. A crash in between leaves `pending` with the
      // list's file name, and the next batch REUSES that name (overwriting the partial list)
      // instead of allocating a fresh one — one hand-off per meeting, even across a crash.
      let dest = null, pendingHash = null;
      for (const it of items) {
        try {
          const tl = meetingRecord.readRecord(fsMod, it.md).data.bedrock.exports.task_list;
          if (tl && tl.state === 'pending' && tl.file) { dest = path.join(folder, path.basename(String(tl.file))); pendingHash = tl.hash || null; break; }
        } catch (e) { /* no readable export state: a fresh name below */ }
      }
      if (!dest) {
        dest = path.join(folder, stamp + '.md');
        for (let i = 1; fsMod.existsSync(dest); i++) dest = path.join(folder, stamp + '_' + i + '.md');
      }
      const payload = lines.join('\n');
      const payloadHash = sha256(payload);
      // Reusing a pending name: a list that already exists is a hand-off that was delivered. If it
      // is byte-for-byte what we recorded, nothing is rewritten; if someone has edited it (ticked
      // a box), it is left exactly as is and noted — it was consumed. Only a MISSING list is written.
      let state = 'succeeded', consumed = null, mustWrite = true;
      if (fsMod.existsSync(dest)) {
        const existing = sha256(await fsp.readFile(dest));
        mustWrite = false;
        consumed = existing === pendingHash ? 'delivered' : 'edited';
      }
      // A meeting whose pending identity cannot be persisted is left out of this list (it stays
      // in batchDone's place for the next run) rather than handed off without a durable record.
      const listed = [];
      for (const it of items) {
        try {
          await patchFrontmatter(it.md, d => { d.bedrock = d.bedrock || {}; d.bedrock.exports = Object.assign({}, d.bedrock.exports, { task_list: { file: path.basename(dest), state: 'pending', hash: payloadHash } }); });
          listed.push(it);
        } catch (e) { log('task-list hand-off deferred for ' + path.basename(it.md) + ' (could not record it): ' + e.message); }
      }
      if (!listed.length) return;
      if (mustWrite) {
        const tmp = dest + '.tmp';
        await fsp.writeFile(tmp, payload);
        await fsp.rename(tmp, dest);
        log('task list written: ' + dest + ' (' + listed.length + ' meeting(s))');
      } else {
        log('task list ' + path.basename(dest) + ' already exists (' + consumed + ') — kept as is, hand-off recorded');
      }
      for (const it of listed) {
        const record = { file: path.basename(dest), state, hash: mustWrite ? payloadHash : (pendingHash || payloadHash) };
        if (consumed) record.consumed = consumed;
        try { await patchFrontmatter(it.md, d => { d.bedrock.exports = Object.assign({}, d.bedrock.exports, { task_list: record }); }); }
        catch (e) { log('task-list export left pending for ' + path.basename(it.md) + ': ' + e.message); }
      }
    } catch (e) { log('task-list write failed: ' + e.message); }
  }

  function runClaude(input, timeoutMs) {
    const exe = findClaudeExe();
    if (!exe) return Promise.reject(new Error('Claude CLI not found on PATH'));
    // `claude -p` with no positional prompt reads the whole prompt from stdin; response on stdout.
    // CLAUDE_ISOLATION_ARGS is what makes "tools denied" true (see the constant for the smoke test).
    return runProc(exe, ['-p'].concat(CLAUDE_ISOLATION_ARGS), input, false, timeoutMs).then(r => r.stdout);
  }

  async function runCodex(input, timeoutMs) {
    if (!findCodexExe()) throw new Error('Codex CLI not found on PATH');
    // codex exec: `-` = read instructions from stdin; --output-last-message captures just the final
    // reply (stdout carries progress noise); --skip-git-repo-check because the processed folder is
    // not a repo. shell:true because npm's codex shim is a .cmd on Windows (codexvoice-session:249).
    // Isolation (CODEX_ISOLATION_ARGS): read-only sandbox, no persisted session, and the working
    // directory is a fresh empty temp folder so even read-only commands see nothing of ours.
    const stamp = now();
    const workDir = path.join(os.tmpdir(), 'oqx-analysis-' + stamp + '-cwd');
    const outFile = path.join(os.tmpdir(), 'oqx-analysis-' + stamp + '.md');
    try {
      await fsp.mkdir(workDir, { recursive: true });
      await runProc('"' + findCodexExe() + '"',
        ['exec', '-', '--skip-git-repo-check'].concat(CODEX_ISOLATION_ARGS, ['-C', workDir, '--output-last-message', outFile]), input, true, timeoutMs);
      return await fsp.readFile(outFile, 'utf8');
    } finally {
      try { await fsp.unlink(outFile); } catch (e) {}
      try { await fsp.rm(workDir, { recursive: true, force: true }); } catch (e) {}
    }
  }

  function runCopilot(input, timeoutMs) {
    const exe = findCopilotExe();
    if (!exe) return Promise.reject(new Error('Copilot CLI not found on PATH'));
    // Copilot has no plain -p-to-stdout mode -- it's an ACP JSON-RPC session (see
    // copilotvoice-session.js's runCopilotBatchPrompt), not a runProc-shaped stdin/stdout CLI.
    return runCopilotBatchPrompt({ text: input, timeoutMs, log, spawn: spawnImpl, exe });
  }

  // Open WebUI analysis: one non-streaming chat completion against the shared Auth-tab
  // connection (settings.owui). The analysis prompt rides as the system message, the slimmed
  // transcript as the user message. Every failure maps to a wording that names the fix.
  async function runOwui({ prompt, transcriptJson, metaText, hlText }, timeoutMs) {
    const cfg = resolveOwui() || {};
    const ep = owuiClient.normalizeOwuiUrl(cfg.url);
    if (!ep) throw new Error("Open WebUI is not configured — set the URL on the editor's Auth tab");
    const model = String(cfg.model || '').trim();
    if (!model) throw new Error("no Open WebUI model set — pick a default model on the editor's Auth tab");
    const slim = slimTranscript(transcriptJson, !!hlText);   // highlights need turn timestamps to align to
    const body = {
      model,
      stream: false,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content:
          (metaText ? 'Meeting metadata JSON follows (calendar info — subject, organizer, attendees):\n\n' + metaText + '\n\n' : '')
          + (hlText ? hlText.trim() + '\n\n' : '')
          + 'Transcript follows' + (hlText ? ' (each turn prefixed with its [m:ss] start)' : '') + ':\n\n' + slim },
      ],
    };
    let res;
    try { res = await owuiClient.postJson(ep.chatUrl, body, String(cfg.apiKey || ''), timeoutMs); }
    catch (e) {
      const msg = String((e && e.message) || 'request failed');
      if (/no response after/.test(msg)) throw new Error('Open WebUI timed out after ' + Math.round(timeoutMs / 60000) + ' min');
      throw new Error('could not reach Open WebUI (' + msg + ') — is Open WebUI running?');
    }
    if (res.status === 401 || res.status === 403) throw new Error('Open WebUI rejected the API key (HTTP ' + res.status + ') — check the key on the Auth tab');
    if (res.status !== 200) throw new Error('Open WebUI error (HTTP ' + res.status + ')' + (res.text ? ': ' + String(res.text).slice(0, 300) : ''));
    let obj;
    try { obj = JSON.parse(res.text); } catch (e) { throw new Error('Open WebUI returned an unparseable response'); }
    // Some OWUI failures come back as 200 with an { error } body — treat those as errors too.
    if (obj && obj.error) throw new Error('Open WebUI error: ' + String((obj.error && obj.error.message) || obj.error).slice(0, 300));
    const choice = obj && Array.isArray(obj.choices) ? obj.choices[0] : null;
    if (choice && choice.finish_reason === 'length') {
      throw new Error("the model's context window is too small for this meeting — pick a larger-context model on the Auth tab");
    }
    const content = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
    if (!content.trim()) throw new Error('Open WebUI returned no output');
    return content;
  }

  function runProc(cmd, args, stdinText, shell, timeoutMs) {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawnImpl(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: !!shell });
      } catch (e) { return reject(new Error('spawn failed: ' + e.message)); }
      let out = '', err = '', settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch (e) {}
        // What the CLI had said by then is the only clue to WHY it hung (retrying the API, waiting
        // for a sign-in, printing nothing): keep the tail of both streams in the error.
        const tail = s => String(s || '').trim().slice(-300).replace(/\s+/g, ' ');
        const seen = [tail(err) && 'stderr: ' + tail(err), tail(out) && 'stdout: ' + tail(out)].filter(Boolean).join(' | ');
        reject(new Error('timed out after ' + Math.round(timeoutMs / 60000) + ' min' + (seen ? ' — ' + seen : ' — the CLI printed nothing')));
      }, timeoutMs);
      const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      // Byte-counted caps on both streams; nothing is appended once the call is settled.
      let outBytes = 0, errBytes = 0;
      proc.stdout.on('data', d => {
        if (settled) return;
        outBytes += Buffer.byteLength(d);
        if (outBytes > MAX_OUTPUT_BYTES) {   // never accumulate an unbounded reply
          settled = true; clearTimeout(timer);
          try { proc.kill(); } catch (e) {}
          reject(new Error('AI output exceeded ' + Math.round(MAX_OUTPUT_BYTES / 1048576) + ' MB — not analyzed'));
          return;
        }
        out += d;
      });
      proc.stderr.on('data', d => { if (settled) return; errBytes += Buffer.byteLength(d); if (errBytes <= MAX_STDERR_BYTES) err += d; });
      proc.on('error', e => finish(reject, new Error('spawn failed: ' + e.message)));
      proc.on('close', code => {
        if (code === 0) finish(resolve, { stdout: out });
        else {
          // The Claude CLI reports auth failures on stdout with nothing on stderr — fall back to it
          // so the panel shows the reason instead of a bare "exited 1".
          // stderr keeps its head (first 300 chars); the stdout fallback takes the TAIL, since a
          // CLI prints its banner first and the failure reason last.
          const detail = err.trim() ? err.trim().slice(0, 300) : out.trim().slice(-300);
          finish(reject, new Error('exited ' + code + (detail ? ': ' + detail : '')));
        }
      });
      proc.stdin.on('error', () => {});   // EPIPE if the CLI dies early — close handler reports it
      proc.stdin.end(stdinText);
    });
  }

  // Read a finished analysis for the panel's View action. The .md may live beside the transcript
  // or (details layout) one folder up; legacy plain <base>.md still accepted.
  function result(name, proposed, kind) {
    const n = safeRelPath(name);
    if (!n) return { ok: false, error: 'bad name' };
    if (normKind(kind) === 'transcribed') {
      // A transcribed row has no analysis of its own; once published, View shows the file it became.
      const p = published.get(n);
      if (!p) return { ok: false, error: 'not analyzed' };
      try { return { ok: true, markdown: fsMod.readFileSync(p, 'utf8'), md: relToProcessed(p) }; } catch (e) { return { ok: false, error: 'not analyzed' }; }
    }
    if (proposed) {   // the reviewable new analysis kept beside the sources
      const leaf = path.posix.basename(n);
      const home = path.join(resolveFolders().processed, path.posix.dirname(n) === '.' ? '' : path.posix.dirname(n));
      const bases = /\.json$/i.test(leaf) ? [leaf.replace(/(-diarizer-response)?\.json$/i, '')] : noteBases(leaf);
      const p = bases.map(b => findProposal(home, b)).find(Boolean);
      try { return { ok: true, markdown: fsMod.readFileSync(p, 'utf8'), proposed: true }; } catch (e) { return { ok: false, error: 'no proposal to review' }; }
    }
    const jsonAbs = path.join(resolveFolders().processed, n).replace(/\.md$/i, '.json');
    for (const p of [mdTargetFor(jsonAbs), mdPathFor(jsonAbs), mdPathFor(jsonAbs).replace(/-analysis\.md$/i, '.md')]) {
      try { return { ok: true, markdown: fsMod.readFileSync(p, 'utf8') }; } catch (e) { /* next */ }
    }
    return { ok: false, error: 'not analyzed' };
  }

  // No arguments drops every pending job for existing auth-stop callers. A selective
  // removal requires the exact root, so a batch never drops an unrelated re-analysis.
  function clearQueue(names, kind) {
    const all = arguments.length === 0;
    const selected = new Set(Array.isArray(names) ? names : []);
    if (!all && kind !== 'transcribed' && kind !== 'processed') return 0;
    let removed = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (all || (queue[i].kind === kind && selected.has(queue[i].name))) {
        queue.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  return { start, getState, result, clearQueue, onOutcome, applyProposed, isBusy };
}

module.exports = { createMeetingAnalyzer, slimTranscript, highlightsBlock, analysisTimeoutMs, CLAUDE_ISOLATION_ARGS, CODEX_ISOLATION_ARGS };
