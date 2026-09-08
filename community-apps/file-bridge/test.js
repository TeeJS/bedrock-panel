'use strict';
// FileBridge self-check — exercises the pure engine (sync.js) against real temp trees.
//   node community-apps/file-bridge/test.js
// No frameworks; throws (non-zero exit) on the first failure.

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const sync = require('./sync');
const drive = require('./drive');
const manifest = require('./app.json');

// ── host integration contract ──
assert.equal(manifest.id, 'file-bridge');
assert.equal(manifest.served, true);
assert.deepEqual(manifest.editor, { entry: 'index.html', label: 'Manage sync jobs' });
assert(Array.isArray(manifest.hostCapabilities) && manifest.hostCapabilities.includes('pick-folder'));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'file-bridge-test-'));
const SRC = path.join(ROOT, 'src');
const DST = path.join(ROOT, 'dst');

function write(base, rel, text) {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
const exists = (base, rel) => fs.existsSync(path.join(base, rel));
function reset() {
  fs.rmSync(SRC, { recursive: true, force: true });
  fs.rmSync(DST, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });
  fs.mkdirSync(DST, { recursive: true });
}
const job = o => ({ name: 't', source: SRC, dest: DST, ...o });
async function run(j) {
  const p = await sync.plan(j);
  const e = await sync.execute(j, p.actions, { folderMeta: p.folderMeta }); // as the server calls it
  return { plan: p, exec: e };
}

(async () => {
  // ── globs ──
  const g = sync.compileGlobs('*.docx; backup*; photos/*.raw');
  assert(sync.matches(g, 'a.docx', 'a.docx'));
  assert(sync.matches(g, 'a.DOCX', 'sub/a.DOCX'));           // case-insensitive, name match in subdir
  assert(sync.matches(g, 'backup-old', 'backup-old'));
  assert(sync.matches(g, 'x.raw', 'photos/x.raw'));          // relative-path match
  assert(!sync.matches(g, 'x.raw', 'other/x.raw'));          // * doesn't cross /
  assert(!sync.matches(g, 'a.doc', 'a.doc'));

  // ── validation ──
  assert.equal(sync.validateJob(job({})), null);
  assert(sync.validateJob(job({ source: 'relative\\path' })));
  assert(sync.validateJob(job({ dest: SRC })));                                  // same folder
  assert(sync.validateJob(job({ dest: path.join(SRC, 'inner') })));              // dest inside source
  assert(sync.validateJob(job({ source: path.join(DST, 'inner') })));            // source inside dest
  assert.equal(sync.validateJob(job({ source: '\\\\server\\share\\docs' })), null); // UNC ok
  assert(sync.validateJob(job({ schedule: { type: 'interval', every: 0 } })));
  assert(sync.validateJob(job({ schedule: { type: 'weekly', at: '03:00', days: [] } })));

  // ── schedule math ──
  const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime();
  assert.equal(sync.nextOccurrence({ type: 'manual' }, 0), null);
  assert.equal(sync.nextOccurrence({ type: 'interval', every: 30 }, 1000), 1000 + 30 * 60000);
  // daily 03:00 after Tue 2026-01-06 14:00 -> Wed 03:00
  assert.equal(sync.nextOccurrence({ type: 'daily', at: '03:00' }, at(2026, 0, 6, 14, 0)), at(2026, 0, 7, 3, 0));
  // daily 15:00 after Tue 14:00 -> same day 15:00
  assert.equal(sync.nextOccurrence({ type: 'daily', at: '15:00' }, at(2026, 0, 6, 14, 0)), at(2026, 0, 6, 15, 0));
  // weekly Mon 03:00 after Tue -> next Monday (2026-01-12)
  assert.equal(sync.nextOccurrence({ type: 'weekly', at: '03:00', days: [1] }, at(2026, 0, 6, 14, 0)), at(2026, 0, 12, 3, 0));

  // ── cron ── (2026-01-06 is a Tuesday)
  const cn = (expr, t) => sync.cronNext(expr, t);
  assert.equal(cn('*/15 * * * *', at(2026, 0, 6, 14, 7)), at(2026, 0, 6, 14, 15));
  assert.equal(cn('*/15 * * * *', at(2026, 0, 6, 14, 45)), at(2026, 0, 6, 15, 0));
  assert.equal(cn('0 3 * * *', at(2026, 0, 6, 14, 0)), at(2026, 0, 7, 3, 0));       // daily
  assert.equal(cn('30 3 * * mon-fri', at(2026, 0, 9, 14, 0)), at(2026, 0, 12, 3, 30)); // Fri 14:00 -> Mon
  assert.equal(cn('0 0 1 * *', at(2026, 0, 6, 14, 0)), at(2026, 1, 1, 0, 0));       // 1st of month
  assert.equal(cn('0 12 * jan *', at(2026, 0, 31, 13, 0)), at(2027, 0, 1, 12, 0));  // month rollover to next Jan
  assert.equal(cn('0 3 * * 0', at(2026, 0, 6, 0, 0)), cn('0 3 * * 7', at(2026, 0, 6, 0, 0))); // 0 and 7 = Sunday
  // Vixie OR: dom 7 OR Friday — from Tue Jan 6, Friday Jan 9 comes before the 7th? No: 7th is Wed -> the 7th wins
  assert.equal(cn('0 0 7 * fri', at(2026, 0, 6, 14, 0)), at(2026, 0, 7, 0, 0));
  assert.equal(cn('0 0 20 * fri', at(2026, 0, 6, 14, 0)), at(2026, 0, 9, 0, 0));    // Friday the 9th beats the 20th
  // exactly on a match minute -> strictly after
  assert.equal(cn('0 3 * * *', at(2026, 0, 6, 3, 0)), at(2026, 0, 7, 3, 0));
  // steps on ranges and start/step
  assert.equal(cn('0 8-18/2 * * *', at(2026, 0, 6, 9, 0)), at(2026, 0, 6, 10, 0));
  assert.equal(cn('5/20 * * * *', at(2026, 0, 6, 9, 30)), at(2026, 0, 6, 9, 45));   // 5,25,45
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', 'x * * * *', '*/0 * * * *', '5-2 * * * *']) {
    assert.throws(() => sync.parseCron(bad), undefined, 'should reject: ' + bad);
  }
  assert(sync.validateJob(job({ schedule: { type: 'cron', expr: 'bogus' } })));
  assert.equal(sync.validateJob(job({ schedule: { type: 'cron', expr: '0 3 * * 1-5' } })), null);
  assert.equal(sync.nextOccurrence({ type: 'cron', expr: '0 3 * * *' }, at(2026, 0, 6, 14, 0)), at(2026, 0, 7, 3, 0));

  // ── folder counts: scanned in source, created at dest ──
  reset();
  write(SRC, 'a.txt', 'A');
  write(SRC, 'sub/b.txt', 'B');
  write(SRC, 'sub/deep/c.txt', 'C');
  let r = await run(job({}));
  assert.equal(r.exec.copied, 3);
  assert.equal(r.plan.foldersScanned, 3, 'root + sub + sub/deep scanned');
  assert.equal(r.exec.foldersCreated, 2, 'sub and sub/deep created at dest');
  r = await run(job({}));
  assert.equal(r.exec.foldersCreated, 0, 'nothing new to create on the second pass');

  // ── basic copy ──
  reset();
  write(SRC, 'a.txt', 'A');
  write(SRC, 'sub/b.txt', 'B');
  r = await run(job({}));
  assert.equal(r.exec.copied, 2);
  assert.equal(fs.readFileSync(path.join(DST, 'sub/b.txt'), 'utf8'), 'B');

  // ── live scan verdicts: per-file up-to-date / copy / filtered progress (Karen's band) ──
  write(SRC, 'skipme.tmp', 't');
  const seq = {};
  await sync.plan(job({ exclude: ['*.tmp'] }), { onProgress: p => { if (p.phase === 'scan' && p.rel) (seq[p.rel] = seq[p.rel] || []).push(p.op); } });
  // Two-emission contract: first WITHOUT a verdict (live paths during a slow compare), then WITH it.
  assert.deepEqual(seq['a.txt'], [undefined, 'same'], 'examining emission, then the up-to-date verdict');
  assert.deepEqual(seq['skipme.tmp'], [undefined, 'filtered']);
  const seq2 = {};
  write(SRC, 'a.txt', 'A-changed');
  await sync.plan(job({}), { onProgress: p => { if (p.phase === 'scan' && p.rel) (seq2[p.rel] = seq2[p.rel] || []).push(p.op); } });
  assert.deepEqual(seq2['a.txt'], [undefined, 'copy'], 'changed file reports copy live');
  // Mirror dest-walk announces itself (phase 'mirror') instead of freezing the scan verdict.
  write(DST, 'orphan.txt', 'o');
  const phases = new Set();
  await sync.plan(job({ mirror: true }), { onProgress: p => phases.add(p.phase) });
  assert(phases.has('mirror'), 'mirror planning emits its own progress phase');
  fs.rmSync(path.join(DST, 'orphan.txt'));
  write(SRC, 'a.txt', 'A'); // restore the fixture for the sections below
  fs.rmSync(path.join(SRC, 'skipme.tmp'));
  await run(job({}));       // re-sync so the changed-only section starts from a clean state

  // ── changed-only: second pass copies nothing; touched file recopied ──
  r = await run(job({}));
  assert.equal(r.plan.actions.length, 0);
  assert.equal(r.plan.unchanged, 2);
  write(SRC, 'a.txt', 'A-changed');
  r = await run(job({}));
  assert.equal(r.exec.copied, 1);
  // mtime preserved => third pass sees it unchanged again
  r = await run(job({}));
  assert.equal(r.plan.actions.length, 0);

  // ── changedOnly=false copies everything every time ──
  r = await run(job({ changedOnly: false }));
  assert.equal(r.exec.copied, 2);

  // ── mirror: deletes dest-only file and folder ──
  reset();
  write(SRC, 'keep.txt', 'k');
  write(DST, 'keep.txt', 'k');
  write(DST, 'gone.txt', 'g');
  write(DST, 'goner/x.txt', 'x');
  r = await run(job({ mirror: true }));
  assert(exists(DST, 'keep.txt'));
  assert(!exists(DST, 'gone.txt'));
  assert(!exists(DST, 'goner'));
  assert.equal(r.exec.deleted, 2);
  assert.equal(r.exec.foldersDeleted, 1, 'the goner folder counts as a deleted folder');

  // ── mirror + exclude: skip-matched items are PROTECTED — never copied, never deleted ──
  reset();
  write(SRC, 'keep.tmp', 'k');            // exists in source, excluded from copying
  write(DST, 'keep.tmp', 'old');
  write(DST, 'orphan.tmp', 'o');          // dest-only but excluded -> protected (Karen parity)
  write(DST, 'gone.txt', 'g');            // dest-only, not excluded -> deleted
  r = await run(job({ mirror: true, exclude: ['*.tmp'] }));
  assert(exists(DST, 'keep.tmp'));
  assert.equal(fs.readFileSync(path.join(DST, 'keep.tmp'), 'utf8'), 'old'); // and not overwritten
  assert(exists(DST, 'orphan.tmp'), 'excluded dest orphan must be protected from mirror deletion');
  assert(!exists(DST, 'gone.txt'));
  assert(r.plan.mirrorProtected >= 1);
  // an excluded dest FOLDER is protected wholesale (no recursion into it)
  reset();
  write(SRC, 'a.txt', 'a');
  write(DST, 'a.txt', 'a');
  write(DST, 'logs/x.log', 'x');
  r = await run(job({ mirror: true, exclude: ['logs'] }));
  assert(exists(DST, 'logs/x.log'), 'excluded dest folder must be protected from mirror deletion');

  // ── follow shortcuts: .lnk expands to its target's content (resolver injected by host) ──
  const TGT = path.join(ROOT, 'tgt');
  const lnkResolver = map => async abs => map[path.basename(abs)] ?? null;
  const runLnk = async (j, resolver) => {
    const p = await sync.plan(j, { resolveShortcut: resolver });
    const e = await sync.execute(j, p.actions, {});
    return { plan: p, exec: e };
  };
  reset();
  fs.rmSync(TGT, { recursive: true, force: true });
  write(TGT, 'inner.txt', 'I');
  write(TGT, 'sub/deep.txt', 'D');
  write(SRC, 'Stuff.lnk', 'not a real lnk'); // resolution is injected, content never read
  write(SRC, 'plain.txt', 'p');
  r = await runLnk(job({ followShortcuts: true }), lnkResolver({ 'Stuff.lnk': TGT }));
  assert.equal(fs.readFileSync(path.join(DST, 'Stuff/inner.txt'), 'utf8'), 'I', 'folder shortcut expands under its own name');
  assert.equal(fs.readFileSync(path.join(DST, 'Stuff/sub/deep.txt'), 'utf8'), 'D', 'expansion recurses');
  assert(exists(DST, 'plain.txt'));
  assert(!exists(DST, 'Stuff.lnk'), 'the .lnk itself is not copied when followed');
  // second changed-only pass sees the expansion as up to date
  let lp = await sync.plan(job({ followShortcuts: true, compare: { mode: 'changed', time: true, size: true } }),
    { resolveShortcut: lnkResolver({ 'Stuff.lnk': TGT }) });
  assert.equal(lp.actions.filter(a => a.op === 'copy').length, 0, 'expanded copies compare as unchanged next run');
  // mirror must NOT delete what the expansion materialized — but still deletes real orphans
  write(DST, 'orphan.txt', 'o');
  r = await runLnk(job({ followShortcuts: true, mirror: true }), lnkResolver({ 'Stuff.lnk': TGT }));
  assert(exists(DST, 'Stuff/inner.txt'), 'mirror keeps shortcut-expanded files');
  assert(exists(DST, 'Stuff/sub/deep.txt'));
  assert(!exists(DST, 'orphan.txt'), 'mirror still deletes genuine orphans');
  // a shortcut to a FILE copies the target under the shortcut's name
  reset();
  write(TGT, 'real-report.pdf', 'PDF');
  write(SRC, 'Report.pdf.lnk', 'x');
  r = await runLnk(job({ followShortcuts: true }), lnkResolver({ 'Report.pdf.lnk': path.join(TGT, 'real-report.pdf') }));
  assert.equal(fs.readFileSync(path.join(DST, 'Report.pdf'), 'utf8'), 'PDF', 'file shortcut copies its target');
  // loops are cut: a shortcut inside the target pointing back at the target
  reset();
  fs.rmSync(TGT, { recursive: true, force: true });
  write(TGT, 'ok.txt', 'ok');
  write(TGT, 'back.lnk', 'x');
  write(SRC, 'Loop.lnk', 'x');
  r = await runLnk(job({ followShortcuts: true }), lnkResolver({ 'Loop.lnk': TGT, 'back.lnk': TGT }));
  assert(exists(DST, 'Loop/ok.txt'), 'loop shortcut does not stop the rest of the expansion');
  assert(r.plan.errors.some(e => /loop/.test(e.error)), 'shortcut loop is reported');
  // unresolvable shortcut = per-entry error, run continues
  reset();
  write(SRC, 'Dead.lnk', 'x');
  write(SRC, 'alive.txt', 'a');
  r = await runLnk(job({ followShortcuts: true }), lnkResolver({}));
  assert(exists(DST, 'alive.txt'));
  assert(r.plan.errors.some(e => /shortcut/.test(e.error)), 'unresolvable shortcut is reported');
  // option OFF: the .lnk copies as a plain file, exactly as before
  reset();
  write(SRC, 'Stuff.lnk', 'raw');
  r = await run(job({}));
  assert.equal(fs.readFileSync(path.join(DST, 'Stuff.lnk'), 'utf8'), 'raw', 'follow off keeps .lnk files as files');
  // mirror protection is case-insensitive: dest dirent casing can drift from the shortcut's
  reset();
  fs.rmSync(TGT, { recursive: true, force: true });
  write(TGT, 'inner.txt', 'I');
  write(SRC, 'MiXeD.lnk', 'x');
  write(DST, 'mixed/inner.txt', 'I');
  r = await runLnk(job({ followShortcuts: true, mirror: true }), lnkResolver({ 'MiXeD.lnk': TGT }));
  assert(!r.plan.actions.some(a => a.op === 'deldir' || a.op === 'del'), 'mirror must not delete a case-drifted expansion');
  assert(exists(DST, 'mixed/inner.txt'));
  // a shortcut pointing at the DESTINATION (or into it) is refused, not expanded
  reset();
  write(SRC, 'Backup.lnk', 'x');
  write(SRC, 'ok.txt', 'k');
  write(DST, 'old.txt', 'o');
  r = await runLnk(job({ followShortcuts: true }), lnkResolver({ 'Backup.lnk': DST }));
  assert(!exists(DST, 'Backup'), 'dest-targeted shortcut must not copy dest into itself');
  assert(r.plan.errors.some(e => /destination/.test(e.error)), 'dest-targeted shortcut is reported');
  assert(exists(DST, 'ok.txt'));
  // a real sibling with the shortcut's expanded name = refused ambiguity, real entry wins
  reset();
  fs.rmSync(TGT, { recursive: true, force: true });
  write(TGT, 'other.pdf', 'FROM-SHORTCUT');
  write(SRC, 'Report.pdf', 'REAL');
  write(SRC, 'Report.pdf.lnk', 'x');
  r = await runLnk(job({ followShortcuts: true }), lnkResolver({ 'Report.pdf.lnk': path.join(TGT, 'other.pdf') }));
  assert.equal(fs.readFileSync(path.join(DST, 'Report.pdf'), 'utf8'), 'REAL', 'the real sibling wins the collision');
  assert(r.plan.errors.some(e => /already exists/.test(e.error)), 'the collision is reported');
  // excluding the literal .lnk name opts the shortcut out of expansion (parity with follow off)
  reset();
  fs.rmSync(TGT, { recursive: true, force: true });
  write(TGT, 'inner.txt', 'I');
  write(SRC, 'Stuff.lnk', 'x');
  write(SRC, 'a.txt', 'a');
  r = await runLnk(job({ followShortcuts: true, exclude: ['*.lnk'] }), lnkResolver({ 'Stuff.lnk': TGT }));
  assert(!exists(DST, 'Stuff'), 'excluded .lnk must not expand');
  assert(exists(DST, 'a.txt'));
  assert(r.plan.filtered >= 1);
  // a transiently unreachable target must NOT let mirror wipe the previous expansion
  reset();
  fs.rmSync(TGT, { recursive: true, force: true });
  write(TGT, 'inner.txt', 'I');
  write(SRC, 'Stuff.lnk', 'x');
  r = await runLnk(job({ followShortcuts: true }), lnkResolver({ 'Stuff.lnk': TGT }));
  assert(exists(DST, 'Stuff/inner.txt'));
  r = await runLnk(job({ followShortcuts: true, mirror: true }), lnkResolver({ 'Stuff.lnk': path.join(ROOT, 'no-such-dir') }));
  assert(exists(DST, 'Stuff/inner.txt'), 'unreachable target must not mirror-delete the previous expansion');
  assert(r.plan.errors.some(e => /unreachable/.test(e.error)));

  // ── include filter ──
  reset();
  write(SRC, 'a.docx', '1');
  write(SRC, 'b.txt', '2');
  write(SRC, 'sub/c.docx', '3');
  r = await run(job({ include: ['*.docx'] }));
  assert(exists(DST, 'a.docx') && exists(DST, 'sub/c.docx') && !exists(DST, 'b.txt'));
  assert.equal(r.plan.filtered, 1);

  // ── exclude directory prunes the whole subtree ──
  reset();
  write(SRC, 'a.txt', '1');
  write(SRC, 'node_modules/deep/x.js', 'x');
  r = await run(job({ exclude: ['node_modules'] }));
  assert(exists(DST, 'a.txt') && !exists(DST, 'node_modules'));

  // ── subfolders off: top-level files only, dest subfolders untouched by mirror ──
  reset();
  write(SRC, 'top.txt', 't');
  write(SRC, 'sub/deep.txt', 'd');
  write(DST, 'other/keep.txt', 'k');
  r = await run(job({ subfolders: false, mirror: true }));
  assert(exists(DST, 'top.txt') && !exists(DST, 'sub'));
  assert(exists(DST, 'other/keep.txt'));

  // ── read-only dest file gets overwritten (Windows attrib clear + retry) ──
  reset();
  write(SRC, 'ro.txt', 'new');
  const roDst = write(DST, 'ro.txt', 'old');
  fs.chmodSync(roDst, 0o444);
  r = await run(job({ changedOnly: false }));
  assert.equal(r.exec.errors.length, 0);
  assert.equal(fs.readFileSync(roDst, 'utf8'), 'new');

  // ── Section 2: granular compare (time / newer-only / size / content) ──
  const touch = (base, rel, when) => fs.utimesSync(path.join(base, rel), when, when);
  const T0 = new Date(2026, 0, 1, 12, 0, 0), T1 = new Date(2026, 0, 2, 12, 0, 0);
  // size-only: same size different mtime -> NOT copied; different size -> copied
  reset();
  write(SRC, 'a.txt', 'hello'); write(DST, 'a.txt', 'world'); // same size (5), diff content
  touch(SRC, 'a.txt', T1); touch(DST, 'a.txt', T0);
  let p = await sync.plan(job({ compare: { mode: 'changed', size: true } }));
  assert.equal(p.actions.length, 0, 'size-only: equal sizes = unchanged');
  write(SRC, 'a.txt', 'longer content');
  p = await sync.plan(job({ compare: { mode: 'changed', size: true } }));
  assert.equal(p.actions.length, 1, 'size-only: different size = copy');
  // time-only, any direction
  reset();
  write(SRC, 'a.txt', 'x'); write(DST, 'a.txt', 'x');
  touch(SRC, 'a.txt', T0); touch(DST, 'a.txt', T1); // source OLDER
  p = await sync.plan(job({ compare: { mode: 'changed', time: true } }));
  assert.equal(p.actions.length, 1, 'time any-direction: differ = copy');
  // newer-only: source older -> skip; source newer -> copy
  p = await sync.plan(job({ compare: { mode: 'changed', time: true, newerOnly: true } }));
  assert.equal(p.actions.length, 0, 'newer-only: older source = skip');
  touch(SRC, 'a.txt', T1); touch(DST, 'a.txt', T0);
  p = await sync.plan(job({ compare: { mode: 'changed', time: true, newerOnly: true } }));
  assert.equal(p.actions.length, 1, 'newer-only: newer source = copy');
  // content: same size + same mtime but different bytes -> copied only when content on
  reset();
  write(SRC, 'a.txt', 'AAAAA'); write(DST, 'a.txt', 'BBBBB');
  touch(SRC, 'a.txt', T0); touch(DST, 'a.txt', T0);
  p = await sync.plan(job({ compare: { mode: 'changed', time: true, size: true } }));
  assert.equal(p.actions.length, 0, 'time+size blind to same-size same-time edit');
  p = await sync.plan(job({ compare: { mode: 'changed', content: true } }));
  assert.equal(p.actions.length, 1, 'content: different bytes = copy');
  write(DST, 'a.txt', 'AAAAA'); touch(DST, 'a.txt', T0);
  p = await sync.plan(job({ compare: { mode: 'changed', content: true } }));
  assert.equal(p.actions.length, 0, 'content: identical bytes = skip');
  // mode 'all' copies everything; no-criteria only copies missing
  reset();
  write(SRC, 'a.txt', 'x'); write(DST, 'a.txt', 'x'); touch(SRC, 'a.txt', T0); touch(DST, 'a.txt', T0);
  write(SRC, 'new.txt', 'n');
  p = await sync.plan(job({ compare: { mode: 'all' } }));
  assert.equal(p.actions.length, 2, "mode 'all' copies both");
  p = await sync.plan(job({ compare: { mode: 'changed' } })); // no criteria
  assert.equal(p.actions.length, 1, 'no criteria: only the missing file copies');
  assert.equal(p.actions[0].rel, 'new.txt');
  // back-compat: old changedOnly:false still means 'all'
  reset();
  write(SRC, 'a.txt', 'x'); write(DST, 'a.txt', 'x'); touch(SRC, 'a.txt', T0); touch(DST, 'a.txt', T0);
  p = await sync.plan(job({ changedOnly: false }));
  assert.equal(p.actions.length, 1, 'legacy changedOnly:false = copy all');

  // ── Section 1: test-source guard — empty source must NOT wipe a full destination ──
  reset();
  write(DST, 'precious.txt', 'keep me');
  write(DST, 'sub/also.txt', 'keep me too');
  p = await sync.plan(job({ mirror: true }));               // testSource defaults on
  assert.equal(p.actions.length, 0);
  assert(p.mirrorSkipped, 'mirrorSkipped should be set for empty source');
  p = await sync.plan(job({ mirror: true, testSource: false })); // opt out -> wipe is planned
  assert.equal(p.mirrorSkipped, null);
  assert.equal(p.actions.filter(a => a.op === 'del' || a.op === 'deldir').length, 2);
  reset();                                                   // non-empty source mirrors normally
  write(SRC, 'a.txt', 'a'); write(DST, 'a.txt', 'a'); write(DST, 'gone.txt', 'x');
  p = await sync.plan(job({ mirror: true }));
  assert.equal(p.mirrorSkipped, null);
  assert.equal(p.actions.filter(a => a.op === 'del').length, 1);

  // ── Section 1: Recycle Bin — trash() is used, permanent rm is not ──
  reset();
  write(SRC, 'a.txt', 'a'); write(DST, 'a.txt', 'a');
  const rmDst = write(DST, 'gone.txt', 'x');
  const trashed = [];
  let e2 = await sync.execute(job({ mirror: true, recycle: true }),
    (await sync.plan(job({ mirror: true }))).actions,
    { trash: async pth => { trashed.push(pth); return true; } });
  assert.equal(e2.recycled, 1);
  assert.equal(e2.deleted, 1);
  assert.equal(trashed.length, 1);
  assert(fs.existsSync(rmDst), 'trash() stub should not actually remove the file');
  e2 = await sync.execute(job({ mirror: true, recycle: true }), [{ op: 'del', rel: 'gone.txt' }], { trash: async () => false });
  assert.equal(e2.deleted, 0);
  assert.equal(e2.errors.length, 1);
  assert(fs.existsSync(rmDst), 'failed trash must not fall back to permanent delete');
  e2 = await sync.execute(job({ mirror: true, recycle: false }), [{ op: 'del', rel: 'gone.txt' }], {});
  assert.equal(e2.deleted, 1);
  assert(!fs.existsSync(rmDst));

  // ── Section 5: delete-old-before-new still produces the correct final content ──
  reset();
  write(SRC, 'a.txt', 'fresh');
  const dbOld = write(DST, 'a.txt', 'stale');
  fs.chmodSync(dbOld, 0o444); // read-only dest — delete-before must clear it and write fresh
  r = await run(job({ changedOnly: false, deleteBeforeCopy: true }));
  assert.equal(r.exec.errors.length, 0);
  assert.equal(fs.readFileSync(dbOld, 'utf8'), 'fresh');

  // ── Karen wildcard semantics: # digit, [list]/[!list] classes, *.* special case ──
  let gx = sync.compileGlobs('log#.txt');
  assert(sync.matches(gx, 'log1.txt', 'log1.txt'));
  assert(!sync.matches(gx, 'logx.txt', 'logx.txt'));
  assert(!sync.matches(gx, 'log#.txt', 'log#.txt'));           // # is a digit class (VB6 Like)
  gx = sync.compileGlobs('[abc]*.txt');
  assert(sync.matches(gx, 'apple.txt', 'apple.txt'));
  assert(!sync.matches(gx, 'dog.txt', 'dog.txt'));
  gx = sync.compileGlobs('[!a]*.txt');
  assert(sync.matches(gx, 'dog.txt', 'dog.txt'));
  assert(!sync.matches(gx, 'apple.txt', 'apple.txt'));
  gx = sync.compileGlobs('report[0-9][0-9].xls');
  assert(sync.matches(gx, 'report07.xls', 'report07.xls'));
  assert(!sync.matches(gx, 'reportab.xls', 'reportab.xls'));
  gx = sync.compileGlobs('*.*');
  assert(sync.matches(gx, 'a.txt', 'a.txt'));
  assert(sync.matches(gx, 'README', 'README'), '*.* matches extensionless files (Karen)');
  gx = sync.compileGlobs('a[b.txt');                           // unmatched [ stays literal
  assert(sync.matches(gx, 'a[b.txt', 'a[b.txt'));

  // ── date tokens in paths ──
  const TD = new Date(2026, 7, 30, 14, 5, 9);                  // Sunday, Aug 30 2026, 14:05:09
  const ex = s => sync.expandTokens(s, TD);
  assert.equal(ex('D:\\Backup\\<yyyy-mm-dd>'), 'D:\\Backup\\2026-08-30');
  assert.equal(ex('X:\\<yyyy>\\<mm>\\<dd>'), 'X:\\2026\\08\\30');
  assert.equal(ex('<hh>.<nn>.<ss>'), '14.05.09');
  assert.equal(ex('<day>'), 'Sun');
  assert.equal(ex('<month>'), 'Aug');
  assert.equal(ex('<dow>'), '1');                              // Sunday = 1
  assert.equal(ex('<quarter>'), '3');
  assert.equal(ex('<yy><q>'), '263');
  assert.equal(ex('<ddoy>'), '242');                           // Aug 30 = day 242 of non-leap 2026
  assert.equal(ex('C:\\plain\\path'), 'C:\\plain\\path');      // no tokens -> untouched
  assert.equal(ex('<zz>'), 'zz');                              // unknown text passes through

  // ── 'every' sliding schedule ──
  const ev = (o, t) => sync.nextOccurrence({ type: 'every', ...o }, t);
  // every 90 min from 10:00 — asked at exactly 10:00, the next is 11:30 (strictly after)
  assert.equal(ev({ mins: 90, start: at(2026, 0, 6, 10, 0) }, at(2026, 0, 6, 10, 0)), at(2026, 0, 6, 11, 30));
  // before the start, the start itself is the first run
  assert.equal(ev({ mins: 90, start: at(2026, 0, 6, 10, 0) }, at(2026, 0, 6, 9, 0)), at(2026, 0, 6, 10, 0));
  // started years ago: fast-forwarded, still aligned to the start's series
  const far = ev({ mins: 90, start: at(2020, 0, 1, 0, 0) }, at(2026, 0, 6, 10, 0));
  assert(far > at(2026, 0, 6, 10, 0) && far - at(2026, 0, 6, 10, 0) <= 90 * 60000);
  assert.equal((far - at(2020, 0, 1, 0, 0)) % (90 * 60000), 0);
  // additive units: 1 day + 1 hour = every 25 hours
  assert.equal(ev({ days: 1, hours: 1, start: at(2026, 0, 6, 9, 0) }, at(2026, 0, 6, 9, 0)), at(2026, 0, 7, 10, 0));
  // a skipped weekday rolls a whole interval forward: daily from Tue, never Wed -> Thu
  assert.equal(ev({ days: 1, start: at(2026, 0, 6, 9, 0), skipDays: [3] }, at(2026, 0, 6, 10, 0)), at(2026, 0, 8, 9, 0));
  // month steps clamp and cascade like Karen's DateAdd: Jan 31 -> Feb 28 -> Mar 28
  assert.equal(ev({ months: 1, start: at(2026, 0, 31, 12, 0) }, at(2026, 1, 1, 0, 0)), at(2026, 1, 28, 12, 0));
  assert.equal(ev({ months: 1, start: at(2026, 0, 31, 12, 0) }, at(2026, 1, 28, 12, 0)), at(2026, 2, 28, 12, 0));
  // month step is applied LAST (Karen's DateAdd order): 1 month + 2 days from Jan 30
  // -> +2d = Feb 1, +1mo = Mar 1 (months-first would clamp to Feb 28 and give Mar 2)
  assert.equal(ev({ months: 1, days: 2, start: at(2026, 0, 30, 12, 0) }, at(2026, 0, 30, 12, 0)), at(2026, 2, 1, 12, 0));
  assert(sync.validateJob(job({ schedule: { type: 'every', mins: 0, start: Date.now() } })));  // no interval
  assert(sync.validateJob(job({ schedule: { type: 'every', mins: 5 } })));                     // no start
  assert(sync.validateJob(job({ schedule: { type: 'every', days: 1, start: Date.now(), skipDays: [0, 1, 2, 3, 4, 5, 6] } })));
  assert(sync.validateJob(job({ schedule: { type: 'every', days: 0.5, start: Date.now() } })), 'fractional units are rejected');
  assert(sync.validateJob(job({ schedule: { type: 'every', mins: 1, start: Date.now(), skipDays: [9] } })), 'bad skipDays rejected');
  assert(sync.validateJob(job({ schedule: { type: 'every', mins: 1, start: Date.now(), skipDays: 'sun' } })), 'non-array skipDays rejected');
  assert.equal(sync.validateJob(job({ schedule: { type: 'every', hours: 1, mins: 30, start: Date.now() } })), null);

  // an invalid class range (legal pre-1.3 as literal text) must not throw — matches literally
  gx = sync.compileGlobs('file[z-a].txt');
  assert(sync.matches(gx, 'file[z-a].txt', 'file[z-a].txt'));
  assert(!sync.matches(gx, 'fileb.txt', 'fileb.txt'));

  // ── safe replace: a failed copy restores the old destination file ──
  reset();
  write(DST, 'x.txt', 'precious old');
  // hand-crafted action whose source file doesn't exist -> copyFile fails mid-replace
  const se = await sync.execute(job({}), [{ op: 'copy', rel: 'x.txt', size: 1, mtimeMs: Date.now() }]);
  assert.equal(se.errors.length, 1);
  assert.equal(fs.readFileSync(path.join(DST, 'x.txt'), 'utf8'), 'precious old', 'failed copy must restore the old file');
  assert(!exists(DST, 'x.txt.~fsync-old'), 'no temp leftover after rollback');
  // successful replace leaves no temp file either
  reset();
  write(SRC, 'x.txt', 'new');
  write(DST, 'x.txt', 'old');
  r = await run(job({ changedOnly: false }));
  assert.equal(r.exec.errors.length, 0);
  assert.equal(fs.readFileSync(path.join(DST, 'x.txt'), 'utf8'), 'new');
  assert(!exists(DST, 'x.txt.~fsync-old'));
  // a leftover .~fsync-old (crashed earlier attempt, dest missing) is RESTORED, not deleted:
  // if the copy fails again, the old backup must survive
  reset();
  write(DST, 'x.txt.~fsync-old', 'last good');
  let se2 = await sync.execute(job({}), [{ op: 'copy', rel: 'x.txt', size: 1, mtimeMs: Date.now() }]);
  assert.equal(se2.errors.length, 1);                       // source x.txt doesn't exist
  assert.equal(fs.readFileSync(path.join(DST, 'x.txt'), 'utf8'), 'last good', 'leftover backup must be restored, never deleted');
  // and when the retry SUCCEEDS, the leftover is consumed and replaced by fresh content
  reset();
  write(SRC, 'x.txt', 'fresh');
  write(DST, 'x.txt.~fsync-old', 'last good');
  se2 = await sync.execute(job({}), (await sync.plan(job({}))).actions);
  assert.equal(se2.errors.length, 0);
  assert.equal(fs.readFileSync(path.join(DST, 'x.txt'), 'utf8'), 'fresh');
  assert(!exists(DST, 'x.txt.~fsync-old'));

  // ── Google-native placeholders: copy EISDIR on *.gdoc etc. is a benign skip ──
  // (Drive mounts list them as tiny files but open them as directory-like objects.
  //  Simulated here with an actual directory named like a placeholder.)
  reset();
  fs.mkdirSync(path.join(SRC, 'fake.gdoc'));
  let ph = await sync.execute(job({}), [{ op: 'copy', rel: 'fake.gdoc', size: 176, mtimeMs: Date.now() }]);
  assert.equal(ph.errors.length, 0);
  assert.equal(ph.skipped.length, 1, 'gdoc EISDIR counts as a skip');
  assert.equal(ph.copied, 0);
  // ...but EISDIR on a NON-placeholder name stays a real error (nothing gets masked)
  fs.mkdirSync(path.join(SRC, 'realdir'));
  ph = await sync.execute(job({}), [{ op: 'copy', rel: 'realdir', size: 1, mtimeMs: Date.now() }]);
  assert.equal(ph.errors.length, 1, 'non-placeholder EISDIR is still an error');
  assert.equal(ph.skipped.length, 0);

  // ── Google Drive folder links ──
  const gid = '1AbCdEfGhIjKlMnOpQrStUvWxYz12345';
  const durl = 'https://drive.google.com/drive/folders/' + gid;
  assert.equal(sync.parseDriveLink(durl + '?usp=drive_link'), gid);
  assert.equal(sync.parseDriveLink('https://drive.google.com/drive/u/0/folders/' + gid), gid);
  assert.equal(sync.parseDriveLink('https://drive.google.com/open?id=' + gid), gid);
  assert.equal(sync.parseDriveLink('C:\\normal\\path'), null);
  assert.equal(sync.parseDriveLink('https://example.com/drive/folders/' + gid), null, 'only google.com hosts');
  const MOUNT = path.join(ROOT, 'fakedrive', '.shortcut-targets-by-id');
  fs.mkdirSync(path.join(MOUNT, gid, 'My Folder'), { recursive: true });
  assert.equal(sync.resolveDriveLink(durl, [MOUNT]), path.join(MOUNT, gid, 'My Folder'), 'single child dir resolves to the named folder');
  const gid2 = '1MultiChildFolderIdXxYyZz0000000';
  fs.mkdirSync(path.join(MOUNT, gid2, 'One'), { recursive: true });
  fs.mkdirSync(path.join(MOUNT, gid2, 'Two'), { recursive: true });
  assert.equal(sync.resolveDriveLink('https://drive.google.com/drive/folders/' + gid2, [MOUNT]), path.join(MOUNT, gid2), 'multiple children fall back to the id dir');
  assert.throws(() => sync.resolveDriveLink('https://drive.google.com/drive/folders/1MissingIdAaBbCc1111111111111', [MOUNT]), /shortcut/i, 'missing id explains the Add-shortcut step');
  assert.throws(() => sync.resolveDriveLink(durl, []), /Drive for Desktop/i, 'no mount explains Drive for Desktop');
  assert.equal(sync.validateJob(job({ source: durl })), null, 'Drive link accepted as source');
  assert.equal(sync.validateJob(job({ dest: durl })), null, 'Drive link accepted as destination');
  assert(sync.validateJob(job({ source: durl, dest: durl + '?usp=x' })), 'same Drive folder both sides rejected');

  // ── missing source is a clean failure, not a hang ──
  await assert.rejects(() => sync.plan(job({ source: path.join(ROOT, 'nope') })));

  // ── server integration: token expansion in pump, stats/grand accumulation, runAll, save hygiene ──
  process.env.APPDATA = path.join(ROOT, 'appdata');
  const server = require('./server');
  const call = (action, body) => server.handle(action, { body: Buffer.from(JSON.stringify(body || {})) });
  try {
    reset();
    write(SRC, 'a.txt', 'A');
    const sv = await call('save', { job: { name: 'srv', source: SRC, dest: path.join(ROOT, 'dated-<yyyy>'), recycle: false, schedule: { type: 'manual' }, stats: { runs: 999 } } });
    assert(sv.ok, sv.error);
    const jid = sv.id;
    let lr = await call('list');
    assert(!lr.jobs.find(x => x.id === jid).stats, 'a new job must not accept client-forged stats');
    const ra = await call('runAll');
    assert(ra.ok && ra.queued === 1, 'runAll queues the one enabled job');
    let settled = false;
    for (let i = 0; i < 100 && !settled; i++) {
      await new Promise(rs => setTimeout(rs, 100));
      const st = await call('status');
      settled = !st.current && !st.queue.length && (await call('result', { id: jid })).ok;
    }
    assert(settled, 'server run did not finish in time');
    const rr = await call('result', { id: jid });
    assert(!rr.result.fatal, 'run failed: ' + rr.result.fatal);
    assert(fs.existsSync(path.join(ROOT, 'dated-' + new Date().getFullYear(), 'a.txt')), 'date token in dest must expand at run time');
    // slim results carry the counts the last-run band renders
    const sl = (await call('status')).lastResults[jid];
    assert(typeof sl.scanned === 'number' && typeof sl.unchanged === 'number' && typeof sl.ms === 'number' && typeof sl.bytes === 'number', 'slim() must include band counts');
    lr = await call('list');
    const sj = lr.jobs.find(x => x.id === jid);
    assert.equal(sj.stats.runs, 1, 'lifetime stats accumulate');
    assert.equal(sj.stats.copied, 1);
    assert(lr.grand && lr.grand.runs >= 1, 'grand totals accumulate');
    // a stale client snapshot echoed through save must not clobber server-side stats
    const echo = await call('save', { job: { ...sj, stats: { runs: 999 } } });
    assert(echo.ok, echo.error);
    lr = await call('list');
    assert.equal(lr.jobs.find(x => x.id === jid).stats.runs, 1, 'save must keep server-owned stats');
    // duplicate: clones settings under a new id, "(copy)" name, disabled, fresh bookkeeping
    const dup = await call('duplicate', { id: jid });
    assert(dup.ok && dup.id && dup.id !== jid, 'duplicate returns a new id');
    lr = await call('list');
    const cp = lr.jobs.find(x => x.id === dup.id);
    assert(cp, 'the copy appears in the list');
    assert.equal(cp.name, sj.name + ' (copy)', 'copy is named "<name> (copy)"');
    assert.equal(cp.enabled, false, 'copy is disabled so it never auto-runs unreviewed');
    assert.equal(cp.source, SRC, 'copy keeps the source');
    assert.equal(cp.dest, sj.dest, 'copy keeps the (raw, token) dest');
    assert(!cp.stats && !cp.lastRun, 'copy starts with fresh bookkeeping, not the original run history');
    assert(!(await call('duplicate', { id: 'nope' })).ok, 'duplicate of a missing job fails cleanly');
    await call('remove', { id: dup.id }); // don't perturb later job-count assertions
    await call('resetStats', { id: jid });
    lr = await call('list');
    assert(!lr.jobs.find(x => x.id === jid).stats, 'resetStats clears the accumulators');
    await call('resetGrand');
    assert.equal((await call('list')).grand, null, 'resetGrand clears the totals');
    // sched preview validates with the same code the scheduler uses
    assert((await call('sched', { schedule: { type: 'every', mins: 90, start: Date.now() } })).ok);
    assert(!(await call('sched', { schedule: { type: 'every', days: 0.5, start: Date.now() } })).ok);
    // global scheduler pause: persisted, reported by list + status, resumable
    assert.equal((await call('list')).paused, false, 'not paused by default');
    assert.equal((await call('setPaused', { paused: true })).paused, true);
    assert.equal((await call('list')).paused, true, 'list reflects the pause');
    assert.equal((await call('status')).paused, true, 'status reflects the pause (for the live poll)');
    await call('setPaused', { paused: false });
    assert.equal((await call('status')).paused, false, 'resumed');
    // manual job ordering: moveJob reorders the stored list (drives run-all + scheduler order)
    const ma = await call('save', { job: { name: 'orderA', source: SRC, dest: DST, schedule: { type: 'manual' } } });
    const mb = await call('save', { job: { name: 'orderB', source: SRC, dest: DST, schedule: { type: 'manual' } } });
    const names = async () => (await call('list')).jobs.map(x => x.name);
    let o = await names();
    assert(o.indexOf('orderA') < o.indexOf('orderB'), 'inserted A before B');
    await call('moveJob', { id: ma.id, dir: 'down' });
    o = await names();
    assert(o.indexOf('orderA') > o.indexOf('orderB'), 'move down puts A below B');
    await call('moveJob', { id: ma.id, dir: 'up' });
    o = await names();
    assert(o.indexOf('orderA') < o.indexOf('orderB'), 'move up restores A above B');
    assert((await call('moveJob', { id: (await call('list')).jobs[0].id, dir: 'up' })).unchanged, 'moving the top job up is a no-op');
    assert(!(await call('moveJob', { id: 'nope', dir: 'up' })).ok, 'moving a missing job fails');
    await call('remove', { id: ma.id }); await call('remove', { id: mb.id });
    // runMany: explicitly selected jobs run even when disabled (Karen's Run Highlighted)
    const sv2 = await call('save', { job: { name: 'srv2', source: SRC, dest: path.join(ROOT, 'dst2'), enabled: false, recycle: false, schedule: { type: 'manual' } } });
    assert(sv2.ok, sv2.error);
    const rm = await call('runMany', { ids: [jid, sv2.id] });
    assert(rm.ok && rm.queued === 2, 'runMany queues both, including the disabled job');
    settled = false;
    for (let i = 0; i < 100 && !settled; i++) {
      await new Promise(rs => setTimeout(rs, 100));
      const st = await call('status');
      settled = !st.current && !st.queue.length;
    }
    assert(settled, 'runMany batch did not finish');
    lr = await call('list');
    assert(lr.jobs.find(x => x.id === sv2.id).lastRun, 'disabled-but-selected job ran');
    // subfolderFromSource: destination gains a subfolder named after the source folder
    reset();
    write(SRC, 'a.txt', 'A');
    const sv3 = await call('save', { job: { name: 'srv3', source: SRC, dest: path.join(ROOT, 'subdest'), recycle: false, subfolderFromSource: true, schedule: { type: 'manual' } } });
    assert(sv3.ok, sv3.error);
    assert((await call('run', { id: sv3.id })).ok);
    settled = false;
    for (let i = 0; i < 100 && !settled; i++) {
      await new Promise(rs => setTimeout(rs, 100));
      const st = await call('status');
      settled = !st.current && !st.queue.length;
    }
    assert(settled, 'subfolder run did not finish');
    assert(fs.existsSync(path.join(ROOT, 'subdest', 'src', 'a.txt')), 'copied into <dest>\\<source-name> subfolder');
    lr = await call('list');
    assert.equal(lr.jobs.find(x => x.id === sv3.id).resolvedDest, path.join(ROOT, 'subdest', 'src'), 'list shows the computed destination');

    // filter groups resolve LIVE: literal patterns + referenced groups + every global group
    const fdir = path.join(ROOT, 'appdata', 'bedrock-panel', 'file-bridge');
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'filters.json'), JSON.stringify({ groups: [
      { id: 'g1', name: 'logs', wildcards: ['*.log'], global: true },
      { id: 'g2', name: 'junk', wildcards: ['skipme.txt', 'node_modules'] },
      { id: 'g3', name: 'onlydocs', wildcards: ['*.docx'] },
    ] }));
    let fj = { include: ['*.keep'], exclude: ['own.tmp'], includeGroups: [], excludeGroups: ['g2'] };
    server._resolveFilters(fj);
    assert.deepEqual(fj.exclude.slice().sort(), ['*.log', 'node_modules', 'own.tmp', 'skipme.txt'], 'exclude = literal + referenced group + global');
    assert.deepEqual(fj.include, ['*.keep'], 'a global group is skip-only — it never touches include');
    fj = { include: [], exclude: [], includeGroups: ['g3'], excludeGroups: [] };
    server._resolveFilters(fj);
    assert(fj.include.includes('*.docx'), 'includeGroups resolve into the include list');
    assert.deepEqual(fj.exclude, ['*.log'], 'the global group still applies even with no explicit excludes');
    // a missing/deleted referenced group id just resolves to nothing (no crash)
    fj = { include: [], exclude: ['x'], includeGroups: [], excludeGroups: ['gone'] };
    server._resolveFilters(fj);
    assert.deepEqual(fj.exclude.slice().sort(), ['*.log', 'x'], 'a deleted group reference is ignored');
    // a STRING exclude (hand-edited jobs.json) must be split on ';', not exploded into chars
    fj = { include: [], exclude: '*.tmp; *.bak', includeGroups: [], excludeGroups: [] };
    server._resolveFilters(fj);
    assert(fj.exclude.includes('*.tmp') && fj.exclude.includes('*.bak'), 'string exclude is split into patterns');
    assert(!fj.exclude.includes('*'), 'string exclude is NOT exploded into a match-all "*"');
    // a GLOBAL group referenced as an INCLUDE must NOT feed the include list (would collide
    // with its own global exclude and copy nothing) — it only ever applies as a skip
    fj = { include: [], exclude: [], includeGroups: ['g1'], excludeGroups: [] };
    server._resolveFilters(fj);
    assert(!fj.include.includes('*.log'), 'a global group never contributes to include');
    assert(fj.exclude.includes('*.log'), 'a global group still applies as a skip');
    // a malformed filters.json (null entry) must not crash resolution
    fs.writeFileSync(path.join(fdir, 'filters.json'), JSON.stringify({ groups: [null, { id: 'g1', name: 'x', wildcards: ['*.log'], global: true }] }));
    fj = { include: [], exclude: [] };
    assert.doesNotThrow(() => server._resolveFilters(fj), 'a null group entry does not crash');
    assert(fj.exclude.includes('*.log'), 'valid groups still resolve past a bad entry');
    fs.rmSync(path.join(fdir, 'filters.json'), { force: true });
  } finally {
    server._shutdown();
  }

  // ── mirror source timestamps (opt-in mirrorMeta): file atime + folder mtime, applied
  //    after the copies so a folder's time isn't re-bumped by writing its children ──
  reset();
  const oldT = new Date('2021-06-07T08:09:10Z'), oldA = new Date('2021-06-08T01:02:03Z');
  write(SRC, 'keep/a.txt', 'A');
  fs.utimesSync(path.join(SRC, 'keep/a.txt'), oldA, oldT); // atime=oldA, mtime=oldT
  fs.utimesSync(path.join(SRC, 'keep'), oldA, oldT);       // source folder time (set LAST)
  r = await run(job({ mirrorMeta: true }));
  let da = fs.statSync(path.join(DST, 'keep/a.txt'));
  assert(Math.abs(da.mtimeMs - oldT.getTime()) < 2000, 'copied file mtime matches source');
  assert(Math.abs(da.atimeMs - oldA.getTime()) < 2000, 'copied file access time matches source (mirrorMeta)');
  assert(Math.abs(fs.statSync(path.join(DST, 'keep')).mtimeMs - oldT.getTime()) < 2000, 'dest folder mtime matches source, applied after the copies');
  // OFF (default): folder time is NOT mirrored — the dest folder keeps its just-created time
  reset();
  write(SRC, 'sub/c.txt', 'C');
  fs.utimesSync(path.join(SRC, 'sub'), oldA, oldT);
  await run(job({}));
  assert(Math.abs(fs.statSync(path.join(DST, 'sub')).mtimeMs - oldT.getTime()) > 2000, 'folder time NOT mirrored when the option is off');

  // ── Drive API source (drive.js) against a fake Drive REST server ──
  {
    const crypto = require('crypto');
    const { Readable } = require('stream');
    const md5 = s => crypto.createHash('md5').update(s).digest('hex');
    const T1 = '2026-08-01T12:00:00.000Z', T1ms = Date.parse(T1);
    // Fake Drive: folders (id -> children metas) and file contents (id -> bytes).
    const makeFake = (folders, contents) => async (url, opts) => {
      const ok = obj => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj), body: null });
      const fail = (status, msg) => ({ ok: false, status, json: async () => ({}), text: async () => msg || 'err', body: null });
      const u = new URL(url);
      const ex = /\/drive\/v3\/files\/([^/?]+)\/export/.exec(u.pathname);
      if (ex) {
        const id = decodeURIComponent(ex[1]);
        const key = 'export:' + id;
        if (contents[key] === '__TOOBIG__') return fail(403, '{"error":{"errors":[{"reason":"exportSizeLimitExceeded"}]}}');
        if (!(key in contents)) return fail(403, 'no export');
        return { ok: true, status: 200, body: Readable.from([Buffer.from(contents[key])]) };
      }
      const m = /\/drive\/v3\/files\/([^/?]+)/.exec(u.pathname);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (u.searchParams.get('alt') === 'media') {
          if (!(id in contents)) return fail(403, 'no content');
          return { ok: true, status: 200, body: Readable.from([Buffer.from(contents[id])]) };
        }
        // Known folder ids answer as folders automatically; '#meta' overrides for
        // shortcut/file roots and shortcut targets.
        const meta = (folders['#meta'] && folders['#meta'][id])
          || (folders[id] ? { id, name: 'F-' + id, mimeType: 'application/vnd.google-apps.folder' } : null);
        return meta ? ok(meta) : fail(404, 'not found');
      }
      const q = /'([^']+)' in parents/.exec(decodeURIComponent(u.search));
      const kids = q && folders[q[1]];
      if (!kids) return fail(403, 'forbidden folder');
      const page = u.searchParams.get('pageToken');
      if (kids.length > 2 && !page) return ok({ files: kids.slice(0, 2), nextPageToken: 'p2' });
      return ok({ files: page ? kids.slice(2) : kids });
    };
    const file = (id, name, content, extra) => ({ id, name, mimeType: 'text/plain', size: String(content.length), md5Checksum: md5(content), modifiedTime: T1, ...extra });
    const folder = (id, name) => ({ id, name, mimeType: 'application/vnd.google-apps.folder' });
    const deps = fake => ({ getToken: async () => 'tok', fetchImpl: fake });
    const djob = o => ({ name: 'd', folderId: 'root', dest: DST, ...o });

    // list + plan + execute: new files download, pagination works, natives are skips
    reset();
    let contents = { f1: 'AAA', f2: 'BBBB', f3: 'CC' };
    let fake = makeFake({
      root: [file('f1', 'a.txt', 'AAA'), folder('sub1', 'Sub'), { id: 'g1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' }, file('f3', 'c.txt', 'CC')],
      sub1: [file('f2', 'b.txt', 'BBBB')],
    }, contents);
    let dp = await drive.planDrive(djob({}), deps(fake));
    assert.equal(dp.actions.filter(a => a.op === 'copy').length, 3, 'three files planned (root paginated + subfolder)');
    assert(dp.actions.every(a => a.reason === 'new file' || a.reason === 'all files'));
    assert.equal(dp.nativeSkipped.length, 1, 'Google-native doc is a skip');
    assert.equal(dp.errors.length, 0);
    let de = await drive.executeDrive(djob({}), dp.actions, deps(fake));
    assert.equal(de.copied, 3);
    assert.equal(fs.readFileSync(path.join(DST, 'a.txt'), 'utf8'), 'AAA');
    assert.equal(fs.readFileSync(path.join(DST, 'Sub/b.txt'), 'utf8'), 'BBBB');
    // timestamps stick -> second changed-only plan is all-unchanged
    dp = await drive.planDrive(djob({ compare: { mode: 'changed', time: true, size: true } }), deps(fake));
    assert.equal(dp.actions.filter(a => a.op === 'copy').length, 0, 'downloaded files compare unchanged next run');
    assert.equal(dp.unchanged, 3);
    // content compare uses Drive's md5 against the local file
    fs.writeFileSync(path.join(DST, 'a.txt'), 'AAX'); // same size, same mtime problem: reset mtime
    fs.utimesSync(path.join(DST, 'a.txt'), new Date(T1ms), new Date(T1ms));
    dp = await drive.planDrive(djob({ compare: { mode: 'changed', content: true } }), deps(fake));
    assert.deepEqual(dp.actions.filter(a => a.op === 'copy').map(a => a.rel), ['a.txt'], 'md5 mismatch plans a copy without downloading');
    // mirror: orphan deleted, remote-present kept even with case drift, excluded protected, natives NOT deleted
    fs.writeFileSync(path.join(DST, 'orphan.txt'), 'o');
    fs.writeFileSync(path.join(DST, 'keep.tmp'), 'k');
    dp = await drive.planDrive(djob({ mirror: true, exclude: ['*.tmp'] }), deps(fake));
    const dels = dp.actions.filter(a => a.op === 'del' || a.op === 'deldir').map(a => a.rel);
    assert.deepEqual(dels, ['orphan.txt'], 'mirror deletes only the true orphan: ' + JSON.stringify(dels));
    assert(dp.mirrorProtected >= 1);
    // a listing error anywhere = deletions refused wholesale
    fake = makeFake({ root: [file('f1', 'a.txt', 'AAA'), folder('subX', 'Sub')] }, contents); // subX listing -> 403
    dp = await drive.planDrive(djob({ mirror: true }), deps(fake));
    assert(dp.mirrorSkipped, 'listing error must skip mirror deletions');
    assert(!dp.actions.some(a => a.op !== 'copy'));
    // empty remote root + testSource guard
    fake = makeFake({ root: [] }, {});
    dp = await drive.planDrive(djob({ mirror: true }), deps(fake));
    assert(dp.mirrorSkipped, 'empty Drive folder must not mirror-wipe the destination');
    // shortcuts: follow=off -> skip note; follow=on -> expands under the shortcut's name; loops cut
    reset();
    const sc = { id: 's1', name: 'Linked', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 'tdir' } };
    fake = makeFake({
      root: [sc],
      tdir: [file('f9', 'inner.txt', 'IN'), { id: 's2', name: 'Back', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 'tdir' } }],
      '#meta': { tdir: folder('tdir', 'RealName') },
    }, { f9: 'IN' });
    dp = await drive.planDrive(djob({}), deps(fake));
    assert.equal(dp.actions.length, 0, 'follow off: shortcut is not expanded');
    assert(dp.nativeSkipped.some(n => /shortcut/i.test(n.note)));
    dp = await drive.planDrive(djob({ followShortcuts: true }), deps(fake));
    assert.deepEqual(dp.actions.map(a => a.rel), ['Linked/inner.txt'], 'follow on: target content under the SHORTCUT name');
    assert(dp.errors.some(e => /loop/.test(e.error)), 'shortcut loop back to the same folder is cut');
    // duplicate names in one Drive folder (DIFFERENT items): keep the first, report as a SKIP not an error
    fake = makeFake({ root: [file('f1', 'x.txt', 'AAA'), file('f3', 'x.txt', 'CC')] }, contents);
    dp = await drive.planDrive(djob({}), deps(fake));
    assert.equal(dp.actions.length, 1);
    assert.equal(dp.actions[0].driveId, 'f1');
    assert.equal(dp.errors.length, 0, 'a same-name collision is a skip, not an error');
    assert(dp.nativeSkipped.some(n => /already here/.test(n.note)), 'the collision is reported as a skip');
    // the SAME file id listed twice (Drive multi-parent / shared-added quirk) is collapsed silently
    fake = makeFake({ root: [file('f1', 'x.txt', 'AAA'), file('f1', 'x.txt', 'AAA')] }, contents);
    dp = await drive.planDrive(djob({}), deps(fake));
    assert.equal(dp.actions.length, 1, 'a doubly-listed same-id file counts once');
    assert.equal(dp.errors.length, 0, 'no phantom duplicate error for a re-listed id');
    assert(!dp.nativeSkipped.some(n => /already here/.test(n.note)), 'a re-listed id is not even a skip');
    // the listing phase emits live progress (folders/errors) so the run bar shows motion
    let sawListing = false, sawFolders = 0;
    fake = makeFake({ root: [folder('s1', 'Sub'), file('f1', 'a.txt', 'AAA')], s1: [file('f2', 'b.txt', 'BB')] }, { f1: 'AAA', f2: 'BB' });
    await drive.planDrive(djob({}), { ...deps(fake), onProgress: pr => { if (pr.listing) { sawListing = true; sawFolders = Math.max(sawFolders, pr.foldersScanned || 0); } } });
    assert(sawListing, 'listing phase emits live progress');
    assert(sawFolders >= 2, 'progress reports folders as they are walked');
    // failed download restores the previous good copy (safe replace)
    reset();
    fs.mkdirSync(DST, { recursive: true });
    fs.writeFileSync(path.join(DST, 'a.txt'), 'GOOD-OLD');
    fake = makeFake({ root: [file('fMissing', 'a.txt', 'ZZZ')] }, {}); // no content -> download 403
    de = await drive.executeDrive(djob({}), [{ op: 'copy', rel: 'a.txt', size: 3, mtimeMs: T1ms, driveId: 'fMissing' }], deps(fake));
    assert.equal(de.copied, 0);
    assert.equal(de.errors.length, 1);
    assert.equal(fs.readFileSync(path.join(DST, 'a.txt'), 'utf8'), 'GOOD-OLD', 'failed download must leave the old file untouched');
    assert(!fs.existsSync(path.join(DST, 'a.txt.~fsync-dl')), 'temp download file is cleaned up');
    // include/exclude
    reset();
    fake = makeFake({ root: [file('f1', 'a.txt', 'AAA'), file('f3', 'b.log', 'CC')] }, contents);
    dp = await drive.planDrive(djob({ exclude: ['*.log'] }), deps(fake));
    assert.deepEqual(dp.actions.map(a => a.rel), ['a.txt']);
    assert.equal(dp.filtered, 1);
    // a pasted link that carries a SHORTCUT's id resolves to its target folder
    reset();
    fake = makeFake({
      root: [file('f1', 'a.txt', 'AAA')],
      '#meta': { scRoot: { id: 'scRoot', name: 'My Shortcut', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 'root' } } },
    }, contents);
    dp = await drive.planDrive(djob({ folderId: 'scRoot' }), deps(fake));
    assert.deepEqual(dp.actions.map(a => a.rel), ['a.txt'], 'shortcut root resolves to its target folder');
    assert.equal(await drive.folderName(deps(fake), 'scRoot'), 'My Shortcut', 'dest subfolder keeps the pasted item\'s own name');
    // a link to a FILE is refused, not treated as an empty folder
    fake = makeFake({ '#meta': { fRoot: file('fRoot', 'movie.mp4', 'XX') } }, {});
    await assert.rejects(drive.planDrive(djob({ folderId: 'fRoot' }), deps(fake)), /file, not a folder/);
    // restore-first: a leftover .~fsync-old survives a failed download as the live file
    reset();
    fs.mkdirSync(DST, { recursive: true });
    fs.writeFileSync(path.join(DST, 'a.txt.~fsync-old'), 'GOOD-OLD');
    fake = makeFake({ root: [file('fMissing', 'a.txt', 'ZZZ')] }, {});
    de = await drive.executeDrive(djob({}), [{ op: 'copy', rel: 'a.txt', size: 3, mtimeMs: T1ms, driveId: 'fMissing' }], deps(fake));
    assert.equal(fs.readFileSync(path.join(DST, 'a.txt'), 'utf8'), 'GOOD-OLD', 'leftover backup is restored before the download can fail');
    // mirror never touches the engine's own swap temps, and natives are remote-present
    reset();
    fs.mkdirSync(DST, { recursive: true });
    fs.writeFileSync(path.join(DST, 'x.txt.~fsync-old'), 'o');
    fs.writeFileSync(path.join(DST, 'Notes'), 'exported once');
    fake = makeFake({ root: [{ id: 'g1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' }] }, {});
    dp = await drive.planDrive(djob({ mirror: true }), deps(fake));
    assert(!dp.actions.some(a => a.op !== 'copy'), 'no mirror deletions for swap temps or native-named entries: ' + JSON.stringify(dp.actions));
    // a Drive file and folder sharing one name cannot share one Windows path
    fake = makeFake({ root: [folder('subA', 'Thing'), file('f1', 'Thing', 'AAA')], subA: [file('f3', 'in.txt', 'CC')] }, contents);
    dp = await drive.planDrive(djob({}), deps(fake));
    assert.deepEqual(dp.actions.map(a => a.rel), ['Thing/in.txt'], 'a folder beats a same-named file (keep the whole subtree)');
    assert.equal(dp.errors.length, 0, 'file/folder name clash is a skip, not an error');
    assert(dp.nativeSkipped.some(n => /already here/.test(n.note)));
    // "/"-> space means a slashed Drive name can now collide with a real space-named sibling.
    // The winner must be DETERMINISTIC (Drive's list order isn't) and prefer the no-slash original
    // (it already matches the desktop-client copy on disk), regardless of which is listed first.
    for (const order of [['gSlash', 'gSpace'], ['gSpace', 'gSlash']]) {
      const byId = { gSlash: folder('gSlash', 'Guns/Ammo'), gSpace: folder('gSpace', 'Guns Ammo') };
      const cf = makeFake({
        root: order.map(id => byId[id]),
        gSlash: [file('x1', 'from-slash.txt', 'S')],
        gSpace: [file('x2', 'from-space.txt', 'P')],
      }, contents);
      const cdp = await drive.planDrive(djob({}), deps(cf));
      assert.deepEqual(cdp.actions.map(a => a.rel), ['Guns Ammo/from-space.txt'],
        'the no-slash original wins the collision, and the winner never flips with listing order (' + order.join(',') + ')');
    }
    // per-run pause "pause now": a download aborted mid-file (throws 'paused') waits for resume
    // and RETRIES the same file — it is neither skipped nor counted as an error.
    reset(); fs.mkdirSync(DST, { recursive: true });
    let dlAttempts = 0, resumeWaits = 0;
    const pauseDl = (id, to) => { dlAttempts++; if (dlAttempts === 1) return Promise.reject(new Error('paused')); fs.writeFileSync(to, 'X'); return Promise.resolve(); };
    const pde = await drive.executeDrive(djob({}), [{ op: 'copy', rel: 'x.txt', size: 1, mtimeMs: T1ms, driveId: 'd1' }], {
      downloadTo: pauseDl, shouldStop: () => false, waitIfPaused: () => { resumeWaits++; return Promise.resolve(); },
    });
    assert.equal(dlAttempts, 2, 'a pause-now abort retries the same file');
    assert.equal(pde.copied, 1, 'the retried file is copied');
    assert.equal(pde.errors.length, 0, 'a pause abort is not an error');
    assert(resumeWaits >= 1, 'the loop waited for resume before retrying');
    assert(exists(DST, 'x.txt'), 'the file lands after resume');
    // a stop DURING the resume wait ends the run cleanly (no retry loop)
    reset(); fs.mkdirSync(DST, { recursive: true });
    let stopAfter = false;
    const stopDl = () => Promise.reject(new Error('paused'));
    const sde = await drive.executeDrive(djob({}), [{ op: 'copy', rel: 'y.txt', size: 1, mtimeMs: T1ms, driveId: 'd2' }], {
      downloadTo: stopDl, shouldStop: () => stopAfter, waitIfPaused: () => { stopAfter = true; return Promise.resolve(); },
    });
    assert.equal(sde.stopped, true, 'Stop during a pause ends the run');
    assert.equal(sde.copied, 0, 'nothing copied when stopped out of a pause');
    // DATA SAFETY: a paused mirror job's destination deletions must NOT run while parked — the
    // whole point of pausing a mirror job is to inspect before the destructive delete phase.
    reset(); fs.mkdirSync(DST, { recursive: true });
    fs.writeFileSync(path.join(DST, 'gone.txt'), 'x');
    let releaseDel; const delGate = new Promise(r => releaseDel = r);
    let delWaits = 0;
    const delExecP = drive.executeDrive(djob({}), [{ op: 'del', rel: 'gone.txt' }], {
      shouldStop: () => false, waitIfPaused: () => (delWaits++ === 0 ? delGate : Promise.resolve()),
    });
    await new Promise(r => setTimeout(r, 25));
    assert(exists(DST, 'gone.txt'), 'the mirror deletion waits at the copy->delete boundary while paused');
    releaseDel();
    const delExec = await delExecP;
    assert(!exists(DST, 'gone.txt'), 'the deletion runs once resumed');
    assert.equal(delExec.deleted, 1, 'the deletion is counted after resume');
    // newer-only reason matches the local engine's vocabulary
    reset();
    fake = makeFake({ root: [file('f1', 'a.txt', 'AAA')] }, contents);
    fs.mkdirSync(DST, { recursive: true });
    fs.writeFileSync(path.join(DST, 'a.txt'), 'AAA');
    fs.utimesSync(path.join(DST, 'a.txt'), new Date(T1ms - 3600000), new Date(T1ms - 3600000));
    dp = await drive.planDrive(djob({ compare: { mode: 'changed', time: true, newerOnly: true } }), deps(fake));
    assert.equal(dp.actions[0] && dp.actions[0].reason, 'source newer');
    // excluded remote folders count as filtered (parity with the local walk)
    fake = makeFake({ root: [folder('sub1', 'node_modules'), file('f1', 'a.txt', 'AAA')], sub1: [] }, contents);
    reset();
    dp = await drive.planDrive(djob({ exclude: ['node_modules'] }), deps(fake));
    assert.equal(dp.filtered, 1, 'excluded remote folder counted as filtered');
    // Google's 403-flavored rate limit is retried like a 429
    let flaked = 0;
    const flaky = async (url, opts) => {
      if (/files\?q=/.test(url) && flaked++ === 0) return { ok: false, status: 403, json: async () => ({}), text: async () => '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}', body: null };
      return makeFake({ root: [file('f1', 'a.txt', 'AAA')] }, contents)(url, opts);
    };
    reset();
    dp = await drive.planDrive(djob({}), deps(flaky));
    assert.equal(dp.actions.length, 1, '403 userRateLimitExceeded is retried, not fatal');
    assert.equal(dp.errors.length, 0);
    // export Google-native docs to Office files (opt-in)
    reset();
    const gsheet = { id: 'gs1', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: T1 };
    const gdoc = { id: 'gd1', name: 'Readme', mimeType: 'application/vnd.google-apps.document', modifiedTime: T1 };
    const gform = { id: 'gf1', name: 'Survey', mimeType: 'application/vnd.google-apps.form', modifiedTime: T1 };
    fake = makeFake({ root: [gsheet, gdoc, gform] }, { 'export:gs1': 'XLSXBYTES', 'export:gd1': 'DOCXBYTES' });
    // off: all three are skips
    dp = await drive.planDrive(djob({}), deps(fake));
    assert.equal(dp.actions.length, 0, 'export off: natives are not copied');
    assert.equal(dp.nativeSkipped.length, 3);
    // on: sheet+doc export under Office names, form (no Office export) stays a skip
    dp = await drive.planDrive(djob({ exportNative: true }), deps(fake));
    assert.deepEqual(dp.actions.map(a => a.rel).sort(), ['Budget.xlsx', 'Readme.docx']);
    assert.equal(dp.nativeSkipped.length, 1, 'a Form has no Office export and stays a skip');
    assert(dp.actions.every(a => a.exportMime), 'exported actions carry exportMime');
    de = await drive.executeDrive(djob({ exportNative: true }), dp.actions, deps(fake));
    assert.equal(de.copied, 2);
    assert.equal(fs.readFileSync(path.join(DST, 'Budget.xlsx'), 'utf8'), 'XLSXBYTES');
    assert.equal(fs.readFileSync(path.join(DST, 'Readme.docx'), 'utf8'), 'DOCXBYTES');
    assert(de.bytes > 0, 'export bytes are measured from the written file');
    // second changed-only run: time compare sees the stamped mtime -> unchanged
    dp = await drive.planDrive(djob({ exportNative: true, compare: { mode: 'changed', time: true } }), deps(fake));
    assert.equal(dp.actions.length, 0, 'exported doc compares unchanged by mtime next run');
    assert.equal(dp.unchanged, 2);
    // size/content-only compare can't apply to an export -> re-export (never silently skip)
    dp = await drive.planDrive(djob({ exportNative: true, compare: { mode: 'changed', size: true } }), deps(fake));
    assert.equal(dp.actions.filter(a => a.op === 'copy').length, 2, 'size-only compare re-exports (no size signal)');
    assert(dp.actions.every(a => a.reason === 'exported doc'));
    // a Sheet "Budget" and a real "Budget.xlsx" in one folder both want DST\Budget.xlsx —
    // caught as a duplicate on the EXPORTED name, not silently overwritten
    reset();
    fake = makeFake({ root: [gsheet, file('fb', 'Budget.xlsx', 'REALXLSX')] }, { 'export:gs1': 'XLSXBYTES' });
    dp = await drive.planDrive(djob({ exportNative: true }), deps(fake));
    assert.equal(dp.actions.filter(a => a.op === 'copy' && a.rel === 'Budget.xlsx').length, 1, 'only one action targets Budget.xlsx');
    assert(dp.nativeSkipped.some(n => /already here/.test(n.note)), 'the export-vs-real collision is reported as a skip');
    // a Sheet "Doc" and a Doc "Doc" do NOT collide (Doc.xlsx vs Doc.docx) — both export
    reset();
    fake = makeFake({ root: [{ id: 'gs2', name: 'Doc', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: T1 }, { id: 'gd2', name: 'Doc', mimeType: 'application/vnd.google-apps.document', modifiedTime: T1 }] },
      { 'export:gs2': 'X', 'export:gd2': 'D' });
    dp = await drive.planDrive(djob({ exportNative: true }), deps(fake));
    assert.deepEqual(dp.actions.map(a => a.rel).sort(), ['Doc.docx', 'Doc.xlsx'], 'same-named natives with different export types both survive');
    assert.equal(dp.errors.length, 0, 'no phantom duplicate error for non-colliding exports');
    // pure no-criteria compare leaves an already-present export alone (binary parity)
    reset();
    fake = makeFake({ root: [gsheet] }, { 'export:gs1': 'XLSXBYTES' });
    fs.mkdirSync(DST, { recursive: true });
    fs.writeFileSync(path.join(DST, 'Budget.xlsx'), 'XLSXBYTES');
    dp = await drive.planDrive(djob({ exportNative: true, compare: { mode: 'changed' } }), deps(fake));
    assert.equal(dp.actions.length, 0, 'no-criteria compare does not re-export a present doc');
    assert.equal(dp.unchanged, 1);
    // 10 MB export cap surfaces as a clear per-file error, not a raw 403
    reset();
    fake = makeFake({ root: [gsheet] }, { 'export:gs1': '__TOOBIG__' });
    dp = await drive.planDrive(djob({ exportNative: true }), deps(fake));
    de = await drive.executeDrive(djob({ exportNative: true }), dp.actions, deps(fake));
    assert.equal(de.copied, 0);
    assert(de.errors.some(e => /10 MB/.test(e.error)), 'export-too-large gives a readable error: ' + JSON.stringify(de.errors));
    // sanitize: Drive names with characters Windows can't hold -> a space each (Drive-for-Desktop parity)
    assert.equal(drive.sanitizeName('Ren: der*?.zip'), 'Ren  der  .zip');
    assert.equal(drive.sanitizeName('dots...'), 'dots');
    assert.equal(manifest.oauth.scopes[0], 'https://www.googleapis.com/auth/drive.readonly', 'manifest asks for read-only Drive access');
    // Stop aborts an IN-FLIGHT download (not just between files): a never-ending stream is
    // cut when the stop flag flips, and the run ends stopped with no error.
    reset(); fs.mkdirSync(DST, { recursive: true });
    let stopFlag = false;
    const hangFetch = async (url, opts) => {
      const r = new Readable({ read() {} }); // never emits 'end'
      if (opts && opts.signal) {
        const onAbort = () => r.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort);
      }
      return { ok: true, status: 200, body: r, text: async () => '' };
    };
    setTimeout(() => { stopFlag = true; }, 60);
    const stoppedRes = await drive.executeDrive(djob({}),
      [{ op: 'copy', rel: 'big.bin', size: 1, mtimeMs: T1ms, driveId: 'x' }],
      { getToken: async () => 't', fetchImpl: hangFetch, shouldStop: () => stopFlag });
    assert.equal(stoppedRes.stopped, true, 'in-flight download is aborted on stop');
    assert.equal(stoppedRes.errors.length, 0, 'a stop is not an error');
    assert(!fs.existsSync(path.join(DST, 'big.bin')), 'no partial file left behind on stop');
    // within-file progress: streamed bytes are reported as fileBytes / fileTotal
    reset(); fs.mkdirSync(DST, { recursive: true });
    const streamFetch = async () => ({ ok: true, status: 200, text: async () => '',
      body: Readable.from([Buffer.alloc(1000, 65), Buffer.alloc(1000, 66)]) });
    const seenP = [];
    const de3 = await drive.executeDrive(djob({}),
      [{ op: 'copy', rel: 'big.bin', size: 2000, mtimeMs: T1ms, driveId: 'x' }],
      { getToken: async () => 't', fetchImpl: streamFetch, shouldStop: () => false, onProgress: p => { if (p.fileTotal) seenP.push(p); } });
    assert.equal(de3.copied, 1);
    assert(seenP.some(p => p.fileBytes > 0 && p.fileTotal === 2000), 'within-file byte progress is reported');
    assert.equal(fs.readFileSync(path.join(DST, 'big.bin')).length, 2000, 'the file is written whole');
  }

  // ── web jobs: rule validation, URL matching, ledger decisions (web.js, pure part) ──
  const web = require('./web');
  const goodRule = {
    site: 'demo', name: 'Demo', match: ['demo-drops.example'],
    sources: [{ id: 'drops', mode: 'sequential', pattern: '/drops/drop-{n}' }],
    collection: { itemSel: "a[href*='/product/']" },
    item: { downloadClickText: 'download files' },
    delayMs: 3000,
  };
  assert.equal(web.validateRule(goodRule), null);
  assert(web.validateRule(null));
  assert(web.validateRule({ ...goodRule, site: 'Bad Site!' }));
  assert(web.validateRule({ ...goodRule, match: [] }), 'match hostnames required');
  assert(web.validateRule({ ...goodRule, match: ['no spaces here!'] }));
  assert(web.validateRule({ ...goodRule, sources: [{ id: 'x', mode: 'sequential' }] }), 'sequential needs {n}');
  assert(web.validateRule({ ...goodRule, sources: [{ id: 'x', mode: 'listing' }] }), 'listing needs collectionHrefIncludes');
  assert.equal(web.validateRule({ ...goodRule, sources: [{ id: 'x', mode: 'listing', collectionHrefIncludes: '/release/' }] }), null);
  assert(web.validateRule({ ...goodRule, item: {} }), 'downloadClickText required');
  // downloadClickText step forms: string, drill-in list, drill-in + multi-download last step
  assert.equal(web.validateRule({ ...goodRule, item: { downloadClickText: ['open menu', 'download'] } }), null);
  assert.equal(web.validateRule({ ...goodRule, item: { downloadClickText: ['download files', ['pdf', 'stl', 'media package']] } }), null);
  assert(web.validateRule({ ...goodRule, item: { downloadClickText: [] } }), 'empty steps rejected');
  assert(web.validateRule({ ...goodRule, item: { downloadClickText: [['a'], 'b'] } }), 'list only allowed as the LAST step');
  assert(web.validateRule({ ...goodRule, item: { downloadClickText: ['a', []] } }), 'empty terminal list rejected');
  assert.equal(web.validateRule({ ...goodRule, item: { downloadClickText: 'open', downloadAllSel: '[class*=Row]' } }), null, 'downloadAllSel accepted');
  assert.equal(web.validateRule({ ...goodRule, collection: { selfItem: true } }), null, 'selfItem replaces itemSel');
  assert(web.validateRule({ ...goodRule, collection: {} }), 'itemSel or selfItem required');
  assert(web.validateRule({ ...goodRule, item: { downloadClickText: 'open', downloadAllSel: 42 } }), 'downloadAllSel must be a string');
  // URL -> rule matching: exact host and subdomain-suffix, nothing else
  const ruleMap = { demo: goodRule };
  assert.equal(web.findRule('https://demo-drops.example/anything', ruleMap), goodRule);
  assert.equal(web.findRule('https://platform.demo-drops.example/drops', ruleMap), goodRule);
  assert.equal(web.findRule('https://evil-demo-drops.example/x', ruleMap), null, 'no partial-hostname match');
  assert.equal(web.findRule('https://other.example/', ruleMap), null);
  assert.equal(web.findRule('not a url', ruleMap), null);
  assert.equal(web.sanitizeName('3D City Frames: Pamplona?'), '3D City Frames Pamplona');
  assert.equal(web.sanitizeName('<>:"/\\|?*'), 'unnamed');
  assert.equal(web.itemDir('{collection}\\{item}', { collection: 'drop-360', item: 'City: Frames' }), path.join('drop-360', 'City Frames'));
  assert.equal(web.itemDir('{yyyy}-{mm}/{item}', { item: 'X' }, new Date(2026, 7, 30)), path.join('2026-08', 'X'));
  assert.equal(web.itemDir('', { item: 'Solo' }), 'Solo', 'missing tokens drop their segment');
  const wnums = web.numbersFromHrefs('/drops/drop-{n}', [
    'https://demo-drops.example/drops/drop-360?x=1',
    'https://demo-drops.example/drops/drop-359',
    'https://demo-drops.example/drops/community-drop-23', // different pattern — ignored
  ]);
  assert.deepEqual(wnums, [360, 359]);
  assert.deepEqual(web.sequentialIds('/drops/drop-{n}', [359, 360, 360, 12]), ['/drops/drop-360', '/drops/drop-359', '/drops/drop-12']);
  // ledger walk: the newest N UNSEEN collections per run — seen ones are skipped over,
  // so older unseen history behind newer seen items stays reachable run after run
  let wplan = web.planCollections(['drop-360', 'drop-359', 'drop-358', 'drop-357', 'drop-356', 'drop-355'],
    new Set(['drop-360', 'drop-359']), 2);
  assert.deepEqual(wplan, ['drop-358', 'drop-357'], 'per-run cap digs past already-seen newest');
  wplan = web.planCollections(['drop-360', 'drop-359', 'drop-358'], new Set(), 2);
  assert.deepEqual(wplan, ['drop-360', 'drop-359']);
  assert.deepEqual(web.planCollections(['drop-360', 'drop-359'], new Set(['drop-360']), 'all'), ['drop-359']);
  assert.deepEqual(web.planCollections(['drop-360'], new Set(), 0), [], 'cap 0 fetches nothing');
  assert.equal(web.collectionKey('drops', 'drop-360'), 'drops:drop-360');
  // web-job validation: a URL that a rule matches + an absolute dest folder
  assert.equal(web.validateWebJob({ name: 'w', url: 'https://demo-drops.example/drops', dest: 'D:\\Drops' }, ruleMap), null);
  assert(web.validateWebJob({ name: 'w', url: 'https://unmatched.example/x', dest: 'D:\\Drops' }, ruleMap), 'unmatched URL rejected');
  assert(web.validateWebJob({ name: 'w', url: 'ftp://demo-drops.example/', dest: 'D:\\Drops' }, ruleMap), 'https only');
  assert(web.validateWebJob({ name: 'w', url: 'https://demo-drops.example/', dest: 'relative' }, ruleMap));
  assert(web.validateWebJob({ name: 'w', url: 'https://demo-drops.example/', dest: 'D:\\Drops', backfill: 1.5 }, ruleMap));

  // ── warnings tier: a timestamp-set failure is a WARNING, not an error ──
  // A file that copies fine but whose mtime can't be set must NOT fail the run — it lands
  // in exec.warnings, exec.errors stays empty, and the server-side ok stays true.
  reset();
  write(SRC, 'w.txt', 'hello');
  const realUtimes = fsp.utimes;
  fsp.utimes = () => Promise.reject(new Error('simulated timestamp failure'));
  let warnRun;
  try { warnRun = await run(job()); } finally { fsp.utimes = realUtimes; }
  assert(exists(DST, 'w.txt'), 'file still copied despite the timestamp failure');
  assert.equal(warnRun.exec.errors.length, 0, 'a timestamp failure is not counted as an error');
  assert(warnRun.exec.warnings.length >= 1, 'the timestamp failure is recorded as a warning');
  assert(warnRun.exec.warnings.some(w => w.path === 'w.txt' && /timestamp/i.test(w.warn)),
    'the warning names the file and the reason');
  const okWithWarnings = !warnRun.exec.stopped && !warnRun.plan.errors.length && !warnRun.exec.errors.length;
  assert(okWithWarnings, 'a run with only warnings is still ok (server ok formula)');

  // ...and a read-only attribute that can't be applied is ALSO a warning (not silently dropped).
  reset();
  const roSrc = write(SRC, 'ro.txt', 'locked');
  fs.chmodSync(roSrc, 0o444);                 // read-only source -> plan sets a.readonly
  const realChmod = fsp.chmod;
  fsp.chmod = (p, m) => (m === 0o444 || m === 0o555)
    ? Promise.reject(new Error('simulated attribute failure')) // fail only the mirror set, not unlock()
    : realChmod(p, m);
  let roRun;
  try { roRun = await run(job({ mirrorMeta: true })); } finally { fsp.chmod = realChmod; fs.chmodSync(roSrc, 0o666); }
  assert(exists(DST, 'ro.txt'), 'read-only file still copied');
  assert.equal(roRun.exec.errors.length, 0, 'a read-only-attribute failure is not an error');
  assert(roRun.exec.warnings.some(w => w.path === 'ro.txt' && /read-only/i.test(w.warn)),
    'the read-only-attribute failure is recorded as a warning');

  // ── log-detail collection: unchanged/filtered lists are opt-in ──
  // The detailed log needs the list of up-to-date + excluded paths, but only when the user
  // turns those categories on — otherwise the plan must not pay the memory cost.
  reset();
  write(SRC, 'keep.txt', 'x');
  write(SRC, 'skip.tmp', 'y');
  await run(job({ exclude: '*.tmp' }));                 // first run copies keep.txt (mtime mirrored), excludes skip.tmp
  const collectOff = await sync.plan(job({ exclude: '*.tmp' }));
  assert(collectOff.unchanged >= 1, 'keep.txt is up-to-date on the second plan');
  assert.deepEqual(collectOff.unchangedList, [], 'unchanged paths NOT collected without the flag');
  assert.deepEqual(collectOff.filteredList, [], 'filtered paths NOT collected without the flag');
  const collectOn = await sync.plan(job({ exclude: '*.tmp' }), { collectUnchanged: true, collectFiltered: true });
  assert(collectOn.unchangedList.includes('keep.txt'), 'unchanged path collected when opted in');
  assert(collectOn.filteredList.includes('skip.tmp'), 'filtered path collected when opted in');

  // ── per-run pause parks the local engine between files, then resumes ──
  // waitIfPaused is awaited before each file; while it stays unresolved the loop is parked
  // (nothing copied), and it finishes every file once resumed — a true suspend, not a cancel.
  reset();
  write(SRC, 'pa.txt', 'a'); write(SRC, 'pb.txt', 'b');
  const pausePlan = await sync.plan(job());
  let releaseRun; const runGate = new Promise(r => releaseRun = r);
  let gateCalls = 0;
  const runP = sync.execute(job(), pausePlan.actions, { waitIfPaused: () => (gateCalls++ === 0 ? runGate : Promise.resolve()) });
  await new Promise(r => setTimeout(r, 25)); // let the loop reach the first park
  assert(!exists(DST, 'pa.txt') && !exists(DST, 'pb.txt'), 'the run parks before copying while paused');
  releaseRun();
  const pauseExec = await runP;
  assert(exists(DST, 'pa.txt') && exists(DST, 'pb.txt'), 'the run finishes every file after resume');
  assert.equal(pauseExec.copied, 2, 'nothing is skipped by the pause');

  // ── Drive name sanitization must match Google Drive for Desktop (Windows) ──
  // A "/" is legal in a Drive name but illegal on Windows; the desktop client renders it as a
  // SPACE. Mapping it to "_" here made FileBridge miss the mount-made copies and re-download whole
  // trees into duplicate "..._Weapons" folders. Slash/backslash -> space; other illegal -> "_".
  assert.equal(drive.sanitizeName('Star Wars Blasters/Weapons'), 'Star Wars Blasters Weapons', 'forward slash -> space');
  assert.equal(drive.sanitizeName('Halo/Bionicle Mashups'), 'Halo Bionicle Mashups', 'the other real slash dup case');
  assert.equal(drive.sanitizeName('1:6 Scale'), '1 6 Scale', 'colon -> space (the real dup case that motivated the full fix)');
  assert.equal(drive.sanitizeName('a\\b'), 'a b', 'backslash -> space');
  assert.equal(drive.sanitizeName('a:b?c*d'), 'a b c d', 'EVERY illegal char -> space, not "_" (matches Drive for Desktop)');
  assert.equal(drive.sanitizeName('trailing/'), 'trailing', 'a trailing slash-space is trimmed, not left dangling');
  assert.equal(drive.sanitizeName('  '), '_', 'an all-illegal/blank name falls back to _');

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log('file-bridge: all self-checks passed');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
