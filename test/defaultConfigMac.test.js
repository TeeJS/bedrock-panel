'use strict';
// The macOS first-run config (app/config.default.mac.json) must (a) mirror the Windows one page for
// page, so docs and screenshots hold on both, and (b) only carry tiles that work on a Mac: stock apps
// by their real names, `open`/osascript commands, https urls, and the system actions main.js handles.
// On a Mac the app names are checked against the apps really installed under /System/Applications,
// /System/Applications/Utilities, and /Applications; elsewhere that check is skipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { MAC_APP_ALIASES } = require('../app/actionRunner');

const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8'));
const mac = read('config.default.mac.json');
const win = read('config.default.json');
const tilePages = cfg => cfg.grids.filter(g => Array.isArray(g.tiles));
const realTiles = g => g.tiles.filter(t => t && t.type);

// Third-party apps a starter tile may name even though a stock Mac does not have them.
const OPTIONAL_APPS = new Set(['Visual Studio Code', 'OBS', 'Discord', 'Google Chrome', 'Spotify']);
const SYSTEM_ACTIONS = new Set(['lock', 'config', 'mic', 'monitor']);   // main.js runStep 'system'

test('the macOS defaults mirror the Windows defaults page for page', () => {
  assert.deepEqual(mac.grids.map(g => [g.id, g.name, g.kind || 'grid', g.cols, g.rows]), win.grids.map(g => [g.id, g.name, g.kind || 'grid', g.cols, g.rows]));
  assert.deepEqual(mac.settings, win.settings);
  assert.equal(mac.activeGridId, win.activeGridId);
  for (const g of tilePages(mac)) {
    const w = win.grids.find(x => x.id === g.id);
    assert.equal(g.tiles.length, w.tiles.length, g.id + ': same tile count');
    assert.deepEqual(g.tiles.map(t => t.cover ?? null), w.tiles.map(t => t.cover ?? null), g.id + ': same cover layout');
    assert.deepEqual(g.tiles.map(t => [t.w || 1, t.h || 1]), w.tiles.map(t => [t.w || 1, t.h || 1]), g.id + ': same tile sizes');
  }
});

test('every tile page ends with the Edit Grids tile and every tile is a type main.js runs', () => {
  for (const g of tilePages(mac)) {
    const last = realTiles(g).slice(-1)[0];
    assert.deepEqual([last.type, last.value], ['system', 'config'], g.id + ': last tile opens the editor');
    for (const t of realTiles(g)) {
      assert.ok(['app', 'url', 'cmd', 'system', 'page'].includes(t.type), g.id + ': tile type ' + t.type);
      assert.ok(t.label && t.icon, g.id + ': ' + JSON.stringify(t) + ' needs a label and an icon');
      if (t.type === 'url') assert.match(t.value, /^https?:\/\//, g.id + ': ' + t.label);
      if (t.type === 'system') assert.ok(SYSTEM_ACTIONS.has(t.value), g.id + ': system ' + t.value);
      if (t.type === 'cmd') {
        assert.doesNotMatch(t.value, /^start\b|\.exe\b|rundll32|powershell|cmd\.exe|%[A-Z]+%/i, g.id + ': ' + t.label + ' is a Windows command');
        assert.match(t.value, /^(open|osascript)\b/, g.id + ': ' + t.label + ' must be an open/osascript one-liner (no permissions needed)');
      }
      if (t.type === 'app') {
        assert.doesNotMatch(t.value, /\.exe$/i);
        assert.ok(!Object.prototype.hasOwnProperty.call(MAC_APP_ALIASES, t.value.toLowerCase()) || MAC_APP_ALIASES[t.value.toLowerCase()] === t.value,
          g.id + ': ' + t.label + ' uses a Windows program name (' + t.value + ') instead of the Mac app name');
      }
    }
  }
});

test('the app tiles name apps a Mac really has (checked against this Mac when running on macOS)', { skip: process.platform !== 'darwin' ? 'macOS only' : false }, () => {
  const roots = ['/System/Applications', '/System/Applications/Utilities', '/System/Library/CoreServices', '/Applications'];   // CoreServices: Finder
  const installed = new Set();
  for (const r of roots) { try { for (const f of fs.readdirSync(r)) if (f.endsWith('.app')) installed.add(f.slice(0, -4)); } catch (e) {} }
  const missing = [];
  for (const g of tilePages(mac)) for (const t of realTiles(g)) if (t.type === 'app' && !installed.has(t.value) && !OPTIONAL_APPS.has(t.value)) missing.push(g.id + ': ' + t.value);
  assert.deepEqual(missing, [], 'stock apps that do not exist on this Mac');
});

test('the volume and sound tiles are the permission-free osascript / System Settings forms', () => {
  const media = mac.grids.find(g => g.id === 'media');
  const by = label => realTiles(media).find(t => t.label === label);
  assert.match(by('Vol +').value, /^osascript -e 'set volume output volume \(\(output volume of \(get volume settings\)\) \+ 10\)'$/);
  assert.match(by('Vol −').value, /^osascript -e 'set volume output volume \(\(output volume of \(get volume settings\)\) - 10\)'$/);
  assert.match(by('Mute').value, /^osascript -e 'set volume output muted \(not \(output muted of \(get volume settings\)\)\)'$/);
  assert.equal(by('Sound').value, 'open "x-apple.systempreferences:com.apple.Sound-Settings.extension"');
});
