'use strict';

// Stage roots must be disjoint before any source set is copied or deleted. Settings
// pass resolved defaults here; this module never creates a folder or moves a file.
const path = require('path');

function foldersError(folders, options = {}) {
  const fsMod = options.fs || require('fs');
  const platform = options.platform || process.platform;
  const labels = [['unprocessed', 'Unprocessed'], ['transcribed', 'Transcribed'], ['processed', 'Completed']];
  const roots = [];
  for (const [key, label] of labels) {
    const value = folders && folders[key];
    if (typeof value !== 'string' || !value.trim()) return label + ' folder is not configured';
    roots.push({ label, path: path.resolve(value.trim()) });
  }
  const fold = value => platform === 'win32' ? value.toLowerCase() : value;
  const overlaps = entries => {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i], b = entries[j];
        const pa = fold(a.path), pb = fold(b.path);
        if (pa === pb) return a.label + ' and ' + b.label + ' folders are the same path';
        const inside = (parent, child) => {
          const rel = path.relative(parent, child);
          return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
        };
        if (inside(pa, pb)) return b.label + ' folder is inside the ' + a.label + ' folder';
        if (inside(pb, pa)) return a.label + ' folder is inside the ' + b.label + ' folder';
      }
    }
    return '';
  };
  const lexical = overlaps(roots);
  if (lexical) return lexical;

  const physical = [];
  for (const root of roots) {
    let ancestor = root.path;
    const tail = [];
    try {
      // realpath cannot resolve a folder that has not been created yet. Resolve its
      // deepest existing parent, then append the missing tail to catch aliases there.
      while (!fsMod.existsSync(ancestor)) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return 'Cannot resolve the ' + root.label + ' folder';
        tail.unshift(path.basename(ancestor));
        ancestor = parent;
      }
      const actual = fsMod.realpathSync(ancestor);
      if (!fsMod.statSync(ancestor).isDirectory()) return root.label + ' folder path is not a directory';
      physical.push({ label: root.label, path: path.resolve(actual, ...tail) });
    } catch (e) { return 'Cannot resolve the ' + root.label + ' folder'; }
  }
  return overlaps(physical);
}

module.exports = { foldersError };
