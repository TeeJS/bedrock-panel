'use strict';

// Linux: there is no single registry. An app can arrive as a .deb, an .rpm, a Flatpak
// or a Snap, and each format keeps its own inventory — so all four are queried in
// parallel, exactly as the three uninstall hives are on Windows, and the ones that
// aren't installed simply return nothing.
//
// AppImages are deliberately absent: they register nowhere by design. Those are
// tracked as portable apps, where the engine's own install manifest is the record.

const path = require('path');
const { run } = require('./exec');

// --- version cleaning --------------------------------------------------------

// Debian versions carry packaging metadata a GitHub tag never has. Per the Debian
// policy format `[epoch:]upstream_version[-debian_revision]`:
//   "2:1.2.3-1ubuntu2" -> "1.2.3"     epoch and revision are packaging, not upstream
//   "1.2.3~rc1-1"      -> "1.2.3-rc1"  "~" is Debian's prerelease marker, "-" is ours
//   "1.2.3"            -> "1.2.3"      a native package has no revision at all
// Pure; exported for tests.
function cleanDebVersion(v) {
  return String(v || '')
    .replace(/^\d+:/, '') // epoch
    .replace(/-[^-]*$/, '') // debian revision: everything after the LAST hyphen
    .replace(/~/g, '-') // Debian sorts "~" below everything, same role as semver "-"
    .trim();
}

// --- dpkg --------------------------------------------------------------------

// Parse `dpkg-query -W -f=${db:Status-Abbrev}\t${Package}\t${Version}\n`.
// Only fully installed packages count. dpkg also lists ones that were removed with their
// configuration retained, and offering to "update" something the user uninstalled is
// worse than not listing it at all. Status "ii" is installed; everything else is skipped.
function parseDpkg(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [status, name, version] = line.split('\t');
    if (!status || !name || !version) continue;
    if (status.trim() !== 'ii') continue;
    const v = cleanDebVersion(version);
    if (v) out.push({ name: name.trim(), version: v, flavor: 'deb' });
  }
  return out;
}

// --- rpm ---------------------------------------------------------------------

// Parse `rpm -qa --qf %{NAME}\t%{VERSION}\n`. RPM keeps the release in a separate
// field, so %{VERSION} is already the upstream version.
function parseRpm(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [name, version] = line.split('\t');
    if (!name || !version || version === '(none)') continue;
    out.push({ name: name.trim(), version: version.trim(), flavor: 'rpm' });
  }
  return out;
}

// --- flatpak -----------------------------------------------------------------

// Parse `flatpak list --app --columns=name,version` (tab separated). Flatpaks with no
// declared version are skipped — there is nothing to compare a release tag against.
function parseFlatpak(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [name, version] = line.split('\t');
    if (!name || !version) continue;
    out.push({ name: name.trim(), version: version.trim(), flavor: 'flatpak' });
  }
  return out;
}

// --- snap --------------------------------------------------------------------

// Parse `snap list`: a header row, then whitespace-aligned columns
// (Name Version Rev Tracking Publisher Notes).
function parseSnap(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    if (cols[0] === 'Name') continue; // header
    // Any prose line splits into columns too, and would otherwise become a package:
    // "No snaps are installed yet." yields one named "No" at version "snaps". A version
    // column has to contain a digit.
    if (!/\d/.test(cols[1])) continue;
    out.push({ name: cols[0], version: cols[1], flavor: 'snap' });
  }
  return out;
}

// --- inventory ---------------------------------------------------------------

// All four package managers at once. Any that isn't installed exits nonzero or not at
// all, which run() turns into '' — so an Ubuntu box simply contributes dpkg + snap and
// a Fedora box rpm + flatpak, with no per-distro branching anywhere.
async function installedApps() {
  const [deb, rpm, flatpak, snap] = await Promise.all([
    run('dpkg-query', ['-W', '-f=${db:Status-Abbrev}\\t${Package}\\t${Version}\\n']),
    run('rpm', ['-qa', '--qf', '%{NAME}\\t%{VERSION}\\n']),
    run('flatpak', ['list', '--app', '--columns=name,version']),
    run('snap', ['list']),
  ]);
  return [...parseDpkg(deb), ...parseRpm(rpm), ...parseFlatpak(flatpak), ...parseSnap(snap)];
}

// --- processes ---------------------------------------------------------------

// Parse `ps -eo pid=,comm=` into [{ name, pid }]. comm is the executable name, already
// truncated to 15 characters by the kernel on Linux — fine for the loose alphanumeric
// match the caller does, and it is what pgrep matches against too.
function parsePs(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    out.push({ name: path.posix.basename(m[2]), pid: m[1] });
  }
  return out;
}

async function runningProcesses() {
  return parsePs(await run('ps', ['-eo', 'pid=,comm=']));
}

function killProcess(pid, force) {
  try {
    process.kill(Number(pid), force ? 'SIGKILL' : 'SIGTERM');
  } catch {}
}

module.exports = {
  installedApps,
  runningProcesses,
  killProcess,
  // exported for tests
  cleanDebVersion,
  parseDpkg,
  parseRpm,
  parseFlatpak,
  parseSnap,
  parsePs,
};
