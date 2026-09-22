'use strict';
/*
 * build-smtc.js — compile the bundled C# helpers into app/native with the .NET-Framework C#
 * compiler, referencing the Windows union metadata + the GAC facade contracts. [build tooling, MIT]
 *
 * Build/dev machine only (needs the Windows SDK winmd + .NET Framework, both already present for signing).
 * End users just run the prebuilt, bundled, signed exe — .NET Framework ships in Windows. Idempotent:
 * skips when the exe is already newer than the source. Wired into `npm start` and `npm run dist`.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const NATIVE = path.join(ROOT, 'native');
const OUT_DIR = path.join(ROOT, 'app', 'native');
// Helpers to (re)compile. They share the same compiler and framework references.
const TARGETS = [
  { src: path.join(NATIVE, 'smtc-art.cs'), out: path.join(OUT_DIR, 'smtc-art.exe') },
  { src: path.join(NATIVE, 'smtc-control.cs'), out: path.join(OUT_DIR, 'smtc-control.exe') },
  { src: path.join(NATIVE, 'reserved-display.cs'), out: path.join(OUT_DIR, 'reserved-display.exe') },
  { src: path.join(NATIVE, 'mic-session-monitor.cs'), out: path.join(OUT_DIR, 'mic-session-monitor.exe') },
  { src: path.join(NATIVE, 'sysvolume.cs'), out: path.join(OUT_DIR, 'sysvolume.exe') },
  { src: path.join(NATIVE, 'outlook-meeting.cs'), out: path.join(OUT_DIR, 'outlook-meeting.exe') },
  { src: path.join(NATIVE, 'foreground-watch.cs'), out: path.join(OUT_DIR, 'foreground-watch.exe') },
  { src: path.join(NATIVE, 'smtc-monitor.cs'), out: path.join(OUT_DIR, 'smtc-monitor.exe') },
];
const log = m => console.log('[build:smtc] ' + m);
// During `npm run dist` the signed package MUST contain freshly built helpers, so anything that would
// prevent that is a hard failure there. Detected from the npm script name.
const RELEASE = /^dist(:|$)/.test(process.env.npm_lifecycle_event || '');
// A missing toolchain is non-fatal for development: JS/Electron still starts and each feature logs
// that its helper is unavailable. In a release build it is fatal — we will not ship without the helpers.
const skip = m => {
  if (RELEASE) { console.error('[build:smtc] ' + m + ' — cannot produce a release build without the native helpers.'); process.exit(1); }
  console.warn('[build:smtc] ' + m + ' — skipping native helper compilation.'); process.exit(0);
};
// A compile failure is ALWAYS fatal. Exiting 0 here once let a stale, signed helper ride into a release
// (a locked .exe returned CS0016 while `npm run dist` reported success). Never let that happen silently.
const fail = m => { console.error('[build:smtc] ' + m); process.exit(1); };
// The helpers are Windows-only (WinRT / WASAPI / COM). Elsewhere exit quietly instead of probing for
// csc.exe — the same contract as build-dpapi.js, so `npm start` on macOS/Linux logs nothing misleading.
if (process.platform !== 'win32') { log('Windows-only C# helpers — skipped on ' + process.platform); process.exit(0); }

// Only (re)build the targets whose source is newer than its exe (or whose exe is missing).
const stale = TARGETS.filter(t => {
  if (!fs.existsSync(t.src)) return false;   // no source -> nothing to build for this target
  try { return !(fs.existsSync(t.out) && fs.statSync(t.out).mtimeMs >= fs.statSync(t.src).mtimeMs); } catch (e) { return true; }
});
if (!stale.length) { log('up to date'); process.exit(0); }

const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
if (!fs.existsSync(csc)) skip('.NET-Framework csc not found: ' + csc);

function newestWinmd() {
  const base = 'C:\\Program Files (x86)\\Windows Kits\\10\\UnionMetadata';
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter(d => /^\d+\./.test(d)).sort().reverse(); } catch (e) {}
  for (const d of dirs) { const p = path.join(base, d, 'Windows.winmd'); if (fs.existsSync(p)) return p; }
  return null;
}
function gacDll(name) {            // GAC_MSIL\<name>\<ver>__<token>\<name>.dll
  const base = path.join('C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL', name);
  let subs = [];
  try { subs = fs.readdirSync(base); } catch (e) {}
  for (const s of subs) { const p = path.join(base, s, name + '.dll'); if (fs.existsSync(p)) return p; }
  return null;
}

const winmd = newestWinmd();
if (!winmd) skip('Windows.winmd not found — install the Windows 10/11 SDK.');
const refs = [winmd];
for (const c of ['System.Runtime.WindowsRuntime', 'System.Runtime', 'System.Runtime.InteropServices.WindowsRuntime', 'System.ObjectModel', 'System.Threading.Tasks']) {
  const p = gacDll(c);
  if (!p) skip('GAC facade not found: ' + c);
  refs.push(p);
}
const webExtensions = path.join('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319', 'System.Web.Extensions.dll');
if (!fs.existsSync(webExtensions)) skip('.NET Framework System.Web.Extensions.dll not found.');
refs.push(webExtensions);
// System.dll: mic-session-monitor.cs uses System.Diagnostics.Process (not auto-referenced by csc).
// Harmless for the WinRT helpers, which simply don't use it.
const systemDll = path.join('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319', 'System.dll');
if (fs.existsSync(systemDll)) refs.push(systemDll);

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const t of stale) {
  const args = ['/nologo', '/target:exe', '/platform:anycpu', '/out:' + t.out];
  for (const r of refs) args.push('/reference:' + r);
  args.push(t.src);
  log('compiling -> ' + t.out);
  try { execFileSync(csc, args, { stdio: 'inherit' }); } catch (e) { fail('compile failed: ' + path.basename(t.src)); }
  if (!fs.existsSync(t.out)) fail('compiler reported success but produced no exe: ' + path.basename(t.out));
  log('built ' + path.basename(t.out) + ' (' + fs.statSync(t.out).size + ' bytes)');
}
