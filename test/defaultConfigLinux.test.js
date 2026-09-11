'use strict';
// The Linux first-run config (app/config.default.linux.json) must (a) mirror the Windows one page for
// page, so docs and screenshots hold on every platform, and (b) only carry tiles that work on Linux.
//
// The Linux rule differs from the macOS one in kind. A Mac tile can name a real app ("Calculator")
// because every Mac has it; Linux has no single calculator, file manager, or terminal, so an app tile
// names the JOB and app/actionRunner.js resolves it against PATH at launch time. That means the check
// here is that every app tile is either a known alias key or a plain binary name — never a Windows
// program name, which would resolve to nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { LINUX_APP_ALIASES, linuxAppCandidates, linuxShellCommand } = require('../app/actionRunner');

const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8'));
const linux = read('config.default.linux.json');
const win = read('config.default.json');
const tilePages = cfg => cfg.grids.filter(g => Array.isArray(g.tiles));
const realTiles = g => g.tiles.filter(t => t && t.type);

const SYSTEM_ACTIONS = new Set(['lock', 'config', 'mic', 'monitor']);   // main.js runStep 'system'
// Program names that exist only on Windows, listed rather than derived. The macOS alias table looks
// like the obvious source, but it also carries names that are perfectly real Linux binaries —
// firefox, discord, slack, spotify, steam, vlc, code — so deriving from it flags valid tiles.
const WINDOWS_ONLY = new Set([
  'msedge', 'iexplore', 'calc', 'taskmgr', 'notepad', 'wordpad', 'explorer', 'mspaint', 'snippingtool',
  'ms-settings', 'control', 'cmd', 'powershell', 'pwsh', 'wt', 'outlook', 'olk', 'winword', 'excel',
  'powerpnt', 'onenote', 'obs64', 'ms-teams',
]);

test('the Linux defaults mirror the Windows defaults page for page', () => {
  assert.deepEqual(
    linux.grids.map(g => [g.id, g.name, g.kind || 'grid', g.cols, g.rows]),
    win.grids.map(g => [g.id, g.name, g.kind || 'grid', g.cols, g.rows]));
  assert.deepEqual(linux.settings, win.settings);
  assert.equal(linux.activeGridId, win.activeGridId);
  for (const g of tilePages(linux)) {
    const w = win.grids.find(x => x.id === g.id);
    assert.equal(g.tiles.length, w.tiles.length, g.id + ': same tile count');
    assert.deepEqual(g.tiles.map(t => t.cover ?? null), w.tiles.map(t => t.cover ?? null), g.id + ': same cover layout');
    assert.deepEqual(g.tiles.map(t => [t.w || 1, t.h || 1]), w.tiles.map(t => [t.w || 1, t.h || 1]), g.id + ': same tile sizes');
  }
});

test('every tile page ends with the Edit Grids tile and every tile is a type main.js runs', () => {
  for (const g of tilePages(linux)) {
    const last = realTiles(g).slice(-1)[0];
    assert.deepEqual([last.type, last.value], ['system', 'config'], g.id + ': last tile opens the editor');
    for (const t of realTiles(g)) {
      assert.ok(['app', 'url', 'cmd', 'system', 'page'].includes(t.type), g.id + ': tile type ' + t.type);
      assert.ok(t.label && t.icon, g.id + ': ' + JSON.stringify(t) + ' needs a label and an icon');
      if (t.type === 'url') assert.match(t.value, /^https?:\/\//, g.id + ': ' + t.label);
      if (t.type === 'system') assert.ok(SYSTEM_ACTIONS.has(t.value), g.id + ': system ' + t.value);
    }
  }
});

test('no tile carries a Windows command or a Windows program name', () => {
  for (const g of tilePages(linux)) {
    for (const t of realTiles(g)) {
      if (t.type === 'cmd') {
        assert.doesNotMatch(t.value, /^start\b|\.exe\b|rundll32|powershell|cmd\.exe|%[A-Z]+%/i, g.id + ': ' + t.label + ' is a Windows command');
        assert.equal(linuxShellCommand(t.value), t.value, g.id + ': ' + t.label + ' should already be a Linux command, not something the alias table has to rewrite');
        assert.doesNotMatch(t.value, /^\s*(sudo|pkexec)\b/, g.id + ': ' + t.label + ' must not need elevation');
      }
      if (t.type === 'app') {
        assert.doesNotMatch(t.value, /\.exe$/i, g.id + ': ' + t.label);
        assert.ok(!WINDOWS_ONLY.has(t.value.toLowerCase()) || Object.prototype.hasOwnProperty.call(LINUX_APP_ALIASES, t.value.toLowerCase()),
          g.id + ': ' + t.label + ' uses the Windows program name "' + t.value + '" with no Linux alias behind it');
      }
    }
  }
});

test('every app tile resolves to at least one real candidate binary', () => {
  for (const g of tilePages(linux)) {
    for (const t of realTiles(g).filter(t => t.type === 'app')) {
      const candidates = linuxAppCandidates(t.value);
      assert.ok(candidates.length >= 1, g.id + ': ' + t.label + ' has no candidates');
      for (const c of candidates) {
        assert.match(c, /^[a-z0-9][a-z0-9._+-]*$/i, g.id + ': ' + t.label + ' candidate "' + c + '" is not a plain binary name');
      }
    }
  }
});

// The generic tiles are the whole point of the Linux grid: they must be alias keys, or they would be
// taken literally and launch nothing on a machine with no program called "files".
test('the generic starter tiles are backed by candidate lists, not taken literally', () => {
  for (const name of ['browser', 'files', 'editor', 'calculator', 'monitor', 'terminal', 'settings',
                      'screenshot', 'paint', 'images', 'documents', 'video', 'music', 'software',
                      'disks', 'sysinfo', 'archive']) {
    const candidates = linuxAppCandidates(name);
    assert.ok(candidates.length > 1, name + ' must expand to a candidate list, got ' + JSON.stringify(candidates));
    assert.ok(!candidates.includes(name) || candidates.length > 1, name + ' resolves to itself only');
  }
});

test('the app tiles name programs this machine really has (checked when running on Linux)', { skip: process.platform !== 'linux' ? 'Linux only' : false }, () => {
  const { execFileSync } = require('child_process');
  const has = bin => { try { execFileSync('/usr/bin/which', [bin], { stdio: 'ignore' }); return true; } catch (e) { return false; } };
  const missing = [];
  for (const g of tilePages(linux)) {
    for (const t of realTiles(g).filter(t => t.type === 'app')) {
      if (!linuxAppCandidates(t.value).some(has)) missing.push(g.id + '/' + t.label + ' (' + linuxAppCandidates(t.value).join(', ') + ')');
    }
  }
  // No exceptions any more. The shipped grid used to name third-party software (Firefox, VS Code,
  // OBS, Discord, a paint program) that a stock desktop does not have, so those tiles did nothing on
  // a fresh install. Every tile now names a category with a broad candidate list. A failure here
  // means a desktop spells one of these differently — extend the list in app/actionRunner.js rather
  // than adding an exception.
  assert.deepEqual(missing, [], 'starter tiles with no installed candidate on this machine');
});
