'use strict';
/*
 * build-mac-helpers.js — compile the bundled macOS helpers (native/mac/*.swift) into
 * app/native/mac/ with the Swift compiler from the Xcode Command Line Tools. [build tooling, MIT]
 *
 * The macOS counterpart of build-smtc.js: dev/build machine only, idempotent (a helper is rebuilt
 * when its source, the shared native/mac/lib sources, or this script are newer), non-fatal (no
 * toolchain -> the dependent features log themselves unavailable at runtime), and wired into
 * `npm start` and `npm run dist:mac`. Outputs are gitignored and land in app/native/mac, which
 * electron-builder unpacks from the asar and signs like any other nested Mach-O.
 *
 *   node build-mac-helpers.js          host architecture (fast, for `npm start`)
 *   node build-mac-helpers.js --dist   arm64 + x86_64 slices merged with lipo (for a universal build)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'native', 'mac');
const LIB_DIR = path.join(SRC_DIR, 'lib');
const OUT_DIR = path.join(ROOT, 'app', 'native', 'mac');
const MIN_MACOS = '14.0';   // CoreAudio process objects (mic monitor) need 14.2 at runtime; the binaries load on 14.0
const log = m => console.log('[build:mac] ' + m);
const bail = m => { console.warn('[build:mac] ' + m + ' — skipping macOS helper compilation.'); process.exit(0); };

if (process.platform !== 'darwin') process.exit(0);

// Helpers to (re)compile. `plist` embeds an Info.plist section (usage strings TCC reads for a helper
// that talks to other apps).
const TARGETS = [
  { name: 'sysvolume' },
  { name: 'foreground-watch' },
  { name: 'mic-session-monitor' },
  { name: 'nowplaying-monitor' },
  { name: 'nowplaying-control', plist: 'nowplaying-control.plist' },
].map(t => Object.assign(t, { src: path.join(SRC_DIR, t.name + '.swift'), out: path.join(OUT_DIR, t.name) }));

const dist = process.argv.includes('--dist') || process.env.BEDROCK_MAC_ARCH === 'universal';
const hostArch = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
const arches = dist ? ['arm64', 'x86_64'] : [hostArch];

let libs = [];
try { libs = fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.swift')).map(f => path.join(LIB_DIR, f)); } catch (e) {}

function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; } }
const newestInput = t => Math.max(mtime(t.src), mtime(__filename), ...libs.map(mtime), t.plist ? mtime(path.join(SRC_DIR, t.plist)) : 0);
const stale = TARGETS.filter(t => fs.existsSync(t.src) && !(fs.existsSync(t.out) && mtime(t.out) >= newestInput(t)));
if (!stale.length) { log('up to date'); process.exit(0); }

// Run the tools through xcrun so the Command Line Tools' SDK is found (a bare swiftc has no SDKROOT
// and fails with 'unable to load standard library').
const XCRUN = '/usr/bin/xcrun';
try { execFileSync(XCRUN, ['-f', 'swiftc'], { stdio: 'ignore' }); } catch (e) { bail('swiftc not found — install the Xcode Command Line Tools (xcode-select --install)'); }

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const t of stale) {
  const slices = [];
  for (const arch of arches) {
    const slice = arches.length > 1 ? t.out + '.' + arch : t.out;
    const args = ['-O', '-parse-as-library', '-target', arch + '-apple-macos' + MIN_MACOS, '-o', slice, t.src, ...libs];
    if (t.plist) args.push('-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', path.join(SRC_DIR, t.plist));
    log('compiling ' + t.name + ' (' + arch + ')');
    try { execFileSync(XCRUN, ['swiftc', ...args], { stdio: 'inherit' }); } catch (e) { bail('compile failed: ' + t.name); }
    slices.push(slice);
  }
  if (slices.length > 1) {
    try { execFileSync(XCRUN, ['lipo', '-create', ...slices, '-output', t.out], { stdio: 'inherit' }); } catch (e) { bail('lipo failed: ' + t.name); }
    for (const s of slices) { try { fs.unlinkSync(s); } catch (e) {} }
  }
  // Apple Silicon refuses to run an unsigned executable, and a lipo output may not carry the linker's
  // ad-hoc signature; electron-builder re-signs it again inside the packaged app.
  try { execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', t.out], { stdio: 'ignore' }); } catch (e) { log('warning: ad-hoc codesign failed for ' + t.name); }
  log('built ' + t.name + ' (' + fs.statSync(t.out).size + ' bytes)');
}
