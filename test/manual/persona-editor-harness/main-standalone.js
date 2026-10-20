'use strict';
// Standalone, side-effect-free harness for the Settings -> AI Profiles -> Personas editor: loads the
// REAL app/config.html + app/config.js in one offscreen Electron window over async stubs of the
// persona IPC (see preload-stub.js), then drives import (valid / credential / bad JSON / oversize /
// collision cancel+replace), export, export-file, remove+reimport, a too-large file pick and Save.
// Prints one [H] JSON line per check and a PASS/FAIL summary; screenshots + result.json go to a temp
// dir (never the repo). Run from the repo root: npx electron test/manual/persona-editor-harness/main-standalone.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(os.tmpdir(), 'persona-editor-harness');
const SHOTS = path.join(OUT, 'shots');
app.setPath('userData', path.join(OUT, 'userData'));
try { app.setPath('sessionData', path.join(OUT, 'sessionData')); } catch (e) {}
fs.rmSync(SHOTS, { recursive: true, force: true }); fs.mkdirSync(SHOTS, { recursive: true });

const results = { checks: [], shots: [], out: OUT };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let win, failed = 0;
const js = code => win.webContents.executeJavaScript(code, true);
function check(name, ok, detail) {
  if (!ok) failed++;
  const o = { check: name, ok: !!ok }; if (detail !== undefined) o.detail = detail;
  results.checks.push(o); console.log('[H] ' + JSON.stringify(o));
}
async function shot(name) {
  await sleep(150);
  try { const img = await win.webContents.capturePage(); const p = path.join(SHOTS, name + '.png'); fs.writeFileSync(p, img.toPNG()); results.shots.push(p); }
  catch (e) { console.log('[H] shot failed ' + name + ' ' + e); }
}
function finish(code) {
  results.failed = failed;
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(results, null, 2));
  console.log('[H] ' + (failed ? 'FAIL' : 'PASS') + ' failed=' + failed + ' result + shots in ' + OUT);
  setTimeout(() => { try { app.exit(code); } catch (e) { process.exit(code); } }, 150);
}
setTimeout(() => { console.log('[H] hard cap hit'); finish(42); }, 60000);

// Helpers that run inside the page.
const rows = () => js("document.querySelectorAll('#sPersonaRows [data-idx]').length");
const names = () => js("Array.from(document.querySelectorAll('#sPersonaRows .psName')).map(function (i) { return i.value; })");
const msg = () => js("(document.getElementById('sPersonaImportMsg') || {}).textContent || ''");
const boxOpen = () => js("document.getElementById('sPersonaImportBox').style.display !== 'none'");
const textVal = () => js("document.getElementById('sPersonaImportText').value");
async function openBox() {
  await js("(function () { var b = document.getElementById('sPersonaImportBox'); if (b.style.display === 'none') document.getElementById('sPersonaImportBtn').click(); })()");
}
async function paste(text) {
  await openBox();
  await js('document.getElementById("sPersonaImportText").value = ' + JSON.stringify(text));
}
async function go() { await js("document.getElementById('sPersonaImportGo').click()"); await sleep(120); }
const answer = v => js('window.__confirmCalls = 0; window.confirm = function (m) { window.__confirmCalls++; window.__confirmMsg = m; return ' + (v ? 'true' : 'false') + '; }; true');
const pickFile = (name, body) => js('(function () { var dt = new DataTransfer(); dt.items.add(new File([' + body + '], ' + JSON.stringify(name) + ', { type: "application/json" })); var f = document.getElementById("sPersonaFile"); f.files = dt.files; f.dispatchEvent(new Event("change", { bubbles: true })); })()');

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1180, height: 900, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload-stub.js'), contextIsolation: false, nodeIntegration: true, sandbox: false },
  });
  win.webContents.on('console-message', (_e, _l, message, line, sourceId) => { if (/error|Uncaught|TypeError/i.test(message)) console.log('[H] pageError ' + message.slice(0, 200) + ' @ ' + path.basename(String(sourceId || '')) + ':' + line); });
  win.showInactive();
  await win.loadFile(path.join(REPO, 'app', 'config.html'));
  try {
    for (let i = 0; i < 50 && !(await js("!!document.getElementById('settingsBtn') && !!document.getElementById('saveBtn')")); i++) await sleep(200);
    await sleep(500);
    await js("document.getElementById('settingsBtn').click()");
    await sleep(400);
    await js("(function () { var b = document.querySelector('.setitem[data-tab=\"aiprofiles\"]'); if (b) b.click(); })()");
    await sleep(400);
    const base = await rows();
    const seededNames = await names();
    check('personas tab renders with Rocky, Norm and Mimi first', base >= 3 && seededNames.slice(0, 3).join(',') === 'Rocky,Norm,Mimi', { rows: base, names: seededNames });
    await shot('01-personas-tab');

    // 1. valid import
    await paste(JSON.stringify({ id: 'sprocket', name: 'Sprocket', prompt: 'Be brief.', face: { style: 'kawaii', color: '#7ad0ff' } }));
    await go();
    check('valid paste is added to the library', (await rows()) === base + 1 && (await names()).indexOf('Sprocket') !== -1, { rows: await rows(), msg: await msg() });
    check('box closes and clears after a successful import', !(await boxOpen()) && (await textVal()) === '');

    // 2. credential key
    const credText = JSON.stringify({ id: 'leaky', name: 'Leaky', access_token: 'abc' });
    await paste(credText); await go();
    check('credential-looking key is refused with a reason, list unchanged, text kept', (await rows()) === base + 1 && /credential/i.test(await msg()) && (await textVal()) === credText, { msg: await msg() });

    // 3. malformed JSON
    await paste('{nope'); await go();
    check('invalid JSON is refused with a reason', /not valid JSON/i.test(await msg()) && (await rows()) === base + 1, { msg: await msg() });

    // 4. oversize text
    await paste(JSON.stringify({ id: 'huge', name: 'Huge', prompt: 'a'.repeat(70 * 1024) })); await go();
    check('70 KB paste is refused before validation', /64 KB/.test(await msg()) && (await rows()) === base + 1, { msg: await msg() });

    // 5. no usable id
    await paste(JSON.stringify({ name: 'No id' })); await go();
    check('persona without an id is refused with a reason', /id/i.test(await msg()) && (await rows()) === base + 1, { msg: await msg() });

    // 6. collision: Cancel keeps the existing one, Replace swaps it
    await answer(false);
    await paste(JSON.stringify({ id: 'sprocket', name: 'Sprocket v2', prompt: 'Be very brief.' })); await go();
    check('collision asks first; Cancel keeps the existing persona and the pasted text', (await js('window.__confirmCalls')) === 1 && (await names()).indexOf('Sprocket v2') === -1 && (await textVal()) !== '', { confirm: await js('window.__confirmMsg') });
    await answer(true);
    await go();
    check('collision Replace swaps it in place (no duplicate row)', (await rows()) === base + 1 && (await names()).indexOf('Sprocket v2') !== -1 && (await names()).indexOf('Sprocket') === -1, { names: await names() });

    // 7. export JSON, remove, re-import the exported text
    const idx = (await names()).indexOf('Sprocket v2');
    await js("document.querySelectorAll('#sPersonaRows .psExport')[" + idx + '].click()');
    await sleep(200);
    const exported = await js("document.getElementById('sPersonaExport').textContent");
    let parsed = null; try { parsed = JSON.parse(exported); } catch (e) {}
    check('Export shows normalized JSON for the row', !!parsed && parsed.id === 'sprocket' && parsed.face && parsed.face.emotions && parsed.face.blinkMinMs > 0, { len: exported.length });
    await js("document.querySelectorAll('#sPersonaRows .psRemove')[" + idx + '].click()'); await sleep(150);
    check('Remove deletes the row', (await rows()) === base);
    await paste(exported); await go();
    check('exported JSON re-imports to an equivalent persona', (await rows()) === base + 1 && (await names()).indexOf('Sprocket v2') !== -1, { names: await names() });

    // 8. export file
    const i2 = (await names()).indexOf('Rocky');
    await js("document.querySelectorAll('#sPersonaRows .psExportFile')[" + i2 + '].click()'); await sleep(250);
    const calls = await js('window.__exportFileCalls');
    check('Export file calls the save API with <id>.persona.json', calls.length === 1 && calls[0].file === 'rocky.persona.json', calls);
    check('Export file button confirms with "Saved"', (await js("document.querySelectorAll('#sPersonaRows .psExportFile')[" + i2 + '].textContent')) === 'Saved');

    // 9. file picks
    await pickFile('big.persona.json', "'a'.repeat(70 * 1024)");
    await sleep(150);
    check('a >64 KB file is refused before it is read', /larger than 64 KB/i.test(await msg()), { msg: await msg() });
    await pickFile('filed.persona.json', 'JSON.stringify({ id: "filed", name: "Filed", prompt: "Hi." })');
    await sleep(250);
    check('a small .json file fills the box', (await textVal()).indexOf('"filed"') !== -1, { msg: await msg() });
    await go();
    check('...and Add to library adds it', (await names()).indexOf('Filed') !== -1);

    // 10. add a blank persona, edit it, then Save
    await js("document.getElementById('sPersonaAdd').click()"); await sleep(150);
    await js("(function () { var l = document.querySelectorAll('#sPersonaRows .psName'); var i = l[l.length - 1]; i.value = 'Blank One'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await shot('02-after-imports');
    await js("document.getElementById('saveBtn').click()"); await sleep(400);
    const saved = await js("(window.__lastSaved && window.__lastSaved.settings && window.__lastSaved.settings.personas || []).map(function (p) { return p.id + ':' + p.name; })");
    check('Save persists the edited persona library', saved.length > 0 && saved.some(s => /:Blank One$/.test(s)) && saved.some(s => /^sprocket:/.test(s)) && saved.some(s => /^filed:/.test(s)), saved);

    // ---- phase 2: per-persona Voice field, shared "Load available voices", import from a URL ----
    const voiceVals = () => js("Array.from(document.querySelectorAll('#sPersonaRows .psVoice')).map(function (i) { return i.value; })");
    const nRows = await rows();
    check('every row has a Voice field, blank by default, placeholder says page default',
      (await js("document.querySelectorAll('#sPersonaRows .psVoice').length")) === nRows
      && (await voiceVals()).slice(0, 3).every(v => v === '')
      && /page default/i.test(await js("document.querySelector('#sPersonaRows .psVoice').placeholder")));
    const rockyIdx = (await names()).indexOf('Rocky');
    await js("(function () { var i = document.querySelectorAll('#sPersonaRows .psVoice')[" + rockyIdx + "]; i.value = 'en_US-ryan-high'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await js("document.querySelectorAll('#sPersonaRows .psExport')[" + rockyIdx + '].click()'); await sleep(200);
    let ex2 = null; try { ex2 = JSON.parse(await js("document.getElementById('sPersonaExport').textContent")); } catch (e) {}
    check('a typed voice is in the exported JSON', !!ex2 && ex2.voice === 'en_US-ryan-high', ex2 && ex2.voice);
    await js("document.getElementById('saveBtn').click()"); await sleep(300);
    const savedVoice = await js("(window.__lastSaved.settings.personas.find(function (p) { return p.id === 'rocky'; }) || {}).voice");
    check('the voice is saved with the library', savedVoice === 'en_US-ryan-high', savedVoice);

    // Load available voices: fills the datalist, never overwrites or auto-selects
    const voicesBefore = await voiceVals();
    await js("document.getElementById('sPersonaVoices').click()"); await sleep(250);
    const opts = await js("Array.from(document.querySelectorAll('#psVoiceList option')).map(function (o) { return o.value; })");
    const vmsg = await js("document.getElementById('sPersonaVoicesMsg').textContent");
    const after = await voiceVals();
    check('Load available voices fills the suggestions without touching any field',
      opts.join(',') === 'en_US-lessac-medium,en_US-ryan-high' && JSON.stringify(after) === JSON.stringify(voicesBefore) && after[rockyIdx] === 'en_US-ryan-high',
      { opts, msg: vmsg.slice(0, 80) });
    check('the voice message names the server and says blank = page default', /2 voices/.test(vmsg) && /page's default/i.test(vmsg), vmsg.slice(0, 120));
    await js("window.__voicesMode = 'fail'"); await js("document.getElementById('sPersonaVoices').click()"); await sleep(250);
    const fmsg = await js("document.getElementById('sPersonaVoicesMsg').textContent");
    check('a failed lookup shows the reason, keeps typed values and leaves the field editable',
      /Could not list voices/.test(fmsg) && /still type a name/.test(fmsg)
      && (await voiceVals())[rockyIdx] === 'en_US-ryan-high'
      && !(await js("document.querySelector('#sPersonaRows .psVoice').disabled")) && !(await js("document.getElementById('sPersonaVoices').disabled")), fmsg.slice(0, 120));
    await js("window.__voicesMode = 'ok'");

    // Import from a URL: Fetch fills the box and previews; Add is a separate explicit step
    const U = 'https://example.com/packs/urlbot.persona.json';
    await js('window.__urlFixtures = ' + JSON.stringify({
      [U]: JSON.stringify({ id: 'urlbot', name: 'URL Bot', prompt: 'Hi.', voice: 'en_GB-alba-medium' }),
      'https://example.com/secret.json': JSON.stringify({ id: 'leak', name: 'Leak', password: 'x' }),
      'https://example.com/huge.json': JSON.stringify({ id: 'huge', prompt: 'a'.repeat(70 * 1024) }),
      'https://example.com/clash.json': JSON.stringify({ id: 'norm', name: 'Norm (shared)', prompt: 'Different.' }),
      'https://example.com/blocked.json': { error: 'local and private addresses cannot be imported from a URL; paste the JSON or choose the file instead' },
    }));
    const before = await rows();
    await openBox();
    await js("document.getElementById('sPersonaImportUrl').value = " + JSON.stringify(U));
    await js("document.getElementById('sPersonaImportFetch').click()"); await sleep(250);
    check('URL fetch previews the persona (name + id) and adds nothing yet',
      (await rows()) === before && /URL Bot/.test(await msg()) && /urlbot/.test(await msg()) && (await textVal()).indexOf('"urlbot"') !== -1, await msg());
    await go();
    check('...Add to library then adds it, voice included', (await rows()) === before + 1 && (await names()).indexOf('URL Bot') !== -1 && (await voiceVals())[(await names()).indexOf('URL Bot')] === 'en_GB-alba-medium');

    // failures keep what was already in the box and say why
    const mine = JSON.stringify({ id: 'mine', name: 'Mine', prompt: 'Keep me.' });
    for (const [u, re, label] of [
      ['https://example.com/missing.json', /HTTP 404/, '404'],
      ['https://example.com/secret.json', /credential/i, 'credential key in the pack'],
      ['https://example.com/huge.json', /64 KB/, 'oversize pack'],
      ['https://example.com/blocked.json', /local and private/, 'a refused address'],
    ]) {
      await paste(mine);
      await js("document.getElementById('sPersonaImportUrl').value = " + JSON.stringify(u));
      await js("document.getElementById('sPersonaImportFetch').click()"); await sleep(250);
      check('URL fetch failure (' + label + ') is explained and the pasted text is kept', re.test(await msg()) && (await textVal()) === mine && (await rows()) === before + 1, await msg());
    }
    await paste(mine);
    await js("document.getElementById('sPersonaImportUrl').value = ''");
    await js("document.getElementById('sPersonaImportFetch').click()"); await sleep(100);
    check('Fetch with an empty URL asks for one', /Enter a URL/i.test(await msg()) && (await textVal()) === mine);

    // a fetched persona whose id exists asks before replacing
    await answer(false);
    await js("document.getElementById('sPersonaImportUrl').value = 'https://example.com/clash.json'");
    await js("document.getElementById('sPersonaImportFetch').click()"); await sleep(250);
    await go();
    check('a fetched persona with an existing id asks before replacing; Cancel keeps Norm', (await js('window.__confirmCalls')) === 1 && (await names()).indexOf('Norm') !== -1 && (await names()).indexOf('Norm (shared)') === -1, await js('window.__confirmMsg'));
    await js("document.getElementById('sPersonaImportCancel').click()");

    // 11. layout at two widths: no horizontal overflow inside the personas area
    for (const w of [1180, 900]) {
      win.setSize(w, 900); await sleep(400);
      const L = await js("(function () { var h = document.getElementById('sPersonaRows'); var r = h.getBoundingClientRect(); var over = []; h.querySelectorAll('input,select,button,textarea').forEach(function (e) { var b = e.getBoundingClientRect(); if (b.right > window.innerWidth + 1 || b.left < -1) over.push(e.className || e.tagName); }); return { docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1, offscreen: over.slice(0, 5), width: Math.round(r.width) }; })()");
      check('no horizontal overflow at width ' + w, !L.docOverflow && L.offscreen.length === 0, L);
      await shot('03-width-' + w);
    }
  } catch (e) {
    check('harness ran without throwing', false, String((e && e.stack) || e));
  }
  finish(failed ? 1 : 0);
});
