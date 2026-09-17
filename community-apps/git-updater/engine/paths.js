'use strict';

// Where git-updater keeps its own files, per platform convention.
//
//   configDir()  config.json, state.json, logs — small, roaming, backed up
//   dataDir()    downloads, staging, self-update payloads — large, local, disposable
//
// Windows keeps EXACTLY the paths it always used (%APPDATA% and %LOCALAPPDATA%), so
// an existing install keeps its config and history across this change. macOS puts both
// under Application Support, which is the only user-writable convention there. Linux
// follows the XDG base directory spec.

const fs = require('fs');
const path = require('path');
const os = require('os');

const APP = 'git-updater';

function configRoot() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function dataRoot() {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

// Under the test runner these NEVER resolve to the user's real directories.
//
// A test that forgets to redirect would otherwise write into the config, the state, or
// the log a user opens when something has gone wrong. That is not hypothetical: before
// this existed, the runner tests appended 189 lines to a real machine's log claiming
// installs that never happened — "OK acme/widget#portable: installed 2.0.0" — in the one
// file someone reads to find out what actually happened.
//
// Redirecting rather than throwing, because the goal is that no test CAN reach real data
// by omission, not that every test must remember an incantation. An explicit
// GITUPDATER_*_DIR still wins, so a test can still point somewhere deliberately.
// One sandbox per process, so paths stay stable across a run: state written early in a
// test must be readable later in the same one.
let sandbox = null;
function sandboxRoot() {
  if (!sandbox) sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'git-updater-testenv-'));
  return sandbox;
}
const underTest = () => !!process.env.NODE_TEST_CONTEXT;

// GITUPDATER_CONFIG_DIR / GITUPDATER_DATA_DIR override both outright, the same way
// GITUPDATER_CONFIG already overrides the config file. They also give a
// portable-everything setup an escape hatch.
const configDir = () =>
  process.env.GITUPDATER_CONFIG_DIR || (underTest() ? path.join(sandboxRoot(), 'config') : path.join(configRoot(), APP));
const dataDir = () =>
  process.env.GITUPDATER_DATA_DIR || (underTest() ? path.join(sandboxRoot(), 'data') : path.join(dataRoot(), APP));

module.exports = { configDir, dataDir, configRoot, dataRoot, underTest, APP };
