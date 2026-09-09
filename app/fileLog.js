'use strict';
/*
 * fileLog — tee the main process's console output to a log file, so a packaged app launched from
 * the Finder or the Dock (no terminal, so no stdout) can still be diagnosed. Pure Node; the caller
 * hands in the directory (Electron's app.getPath('logs'): ~/Library/Logs/bedrock-panel on macOS,
 * %APPDATA%\bedrock-panel\logs on Windows).
 *
 * One file, `main.log`, rotated to `main.log.1` when it passes `maxBytes`. Lines are timestamped;
 * console.* keep printing to the terminal as before. Writes are synchronous and best-effort: a log
 * that cannot be written must never take the app down.
 */
const fs = require('fs');
const path = require('path');
const util = require('util');

function install({ dir, maxBytes = 2 * 1024 * 1024, console: con = console, now = () => new Date() } = {}) {
  if (!dir) return null;
  let file, stream;
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'main.log');
    try { if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file + '.1'); } catch (e) {}
    stream = fs.openSync(file, 'a');
  } catch (e) { return null; }
  let written = 0;
  try { written = fs.fstatSync(stream).size; } catch (e) {}
  const write = (level, args) => {
    let line;
    try { line = now().toISOString() + ' ' + level + ' ' + util.format(...args) + '\n'; } catch (e) { return; }
    try {
      fs.writeSync(stream, line);
      written += Buffer.byteLength(line);
      if (written > maxBytes) {           // rotate mid-run too: a chatty session must not grow without bound
        fs.closeSync(stream);
        try { fs.renameSync(file, file + '.1'); } catch (e) {}
        stream = fs.openSync(file, 'a');
        written = 0;
      }
    } catch (e) {}
  };
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = con[level].bind(con);
    con[level] = (...args) => { orig(...args); write(level === 'log' ? 'info' : level, args); };
  }
  return { file, write: (level, ...args) => write(level, args) };
}

module.exports = { install };
