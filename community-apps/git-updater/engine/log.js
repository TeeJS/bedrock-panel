'use strict';

// Tiny append-only file log, in git-updater's own config dir (see src/paths.js).
// One 2 MB file, rotated once to .1. Never throws (logging must not break a run).

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const LOG_DIR = path.join(paths.configDir(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'git-updater.log');
const MAX = 2 * 1024 * 1024;

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > MAX) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch {}
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

module.exports = { log, LOG_FILE, LOG_DIR };
