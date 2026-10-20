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
async function go() { await js("document.getElementById('sPersonaImportGo').click()"); await sleep(450); }
const answer = v => js('window.__confirmCalls = 0; window.confirm = function (m) { window.__confirmCalls++; window.__confirmMsg = m; return ' + (v ? 'true' : 'false') + '; }; true');
const pickFile = (name, body) => js('(function () { var dt = new DataTransfer(); dt.items.add(new File([' + body + '], ' + JSON.stringify(name) + ', { type: "application/json" })); var f = document.getElementById("sPersonaFile"); f.files = dt.files; f.dispatchEvent(new Event("change", { bubbles: true })); })()');

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1180, height: 900, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload-stub.js'), contextIsolation: false, nodeIntegration: true, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, _l, message, line, sourceId) => { if (/error|Uncaught|TypeError/i.test(message)) console.log('[H] pageError ' + message.slice(0, 200) + ' @ ' + path.basename(String(sourceId || '')) + ':' + line); });
  // never shown: the harness must not appear on the user's desktop (capturePage works on a hidden window)
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
    check('personas tab renders the 5 built-ins (Mimi, Jarvis, CRT Terminal, Startup Intern, Dust Sprite)', base >= 5 && seededNames.slice(0, 5).join(',') === 'Mimi,Jarvis,CRT Terminal,Startup Intern,Dust Sprite', { rows: base, names: seededNames });
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
    const i2 = (await names()).indexOf('Mimi');
    await js("document.querySelectorAll('#sPersonaRows .psExportFile')[" + i2 + '].click()'); await sleep(250);
    const calls = await js('window.__exportFileCalls');
    check('Export file calls the save API with <id>.persona.json', calls.length === 1 && calls[0].file === 'kawaii.persona.json', calls);
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
    check('every row has a Voice field with a page-default placeholder; the built-ins name a stock Piper voice',
      (await js("document.querySelectorAll('#sPersonaRows .psVoice').length")) === nRows
      && /page default/i.test(await js("document.querySelector('#sPersonaRows .psVoice').placeholder"))
      && (await voiceVals()).slice(0, 5).every(v => /^[a-z]{2}_[A-Z]{2}-/.test(v)), (await voiceVals()).slice(0, 7));
    const rockyIdx = (await names()).indexOf('Mimi');   // any built-in works; Mimi is the first
    await js("(function () { var i = document.querySelectorAll('#sPersonaRows .psVoice')[" + rockyIdx + "]; i.value = 'en_US-ryan-high'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await js("document.querySelectorAll('#sPersonaRows .psExport')[" + rockyIdx + '].click()'); await sleep(200);
    let ex2 = null; try { ex2 = JSON.parse(await js("document.getElementById('sPersonaExport').textContent")); } catch (e) {}
    check('a typed voice is in the exported JSON', !!ex2 && ex2.voice === 'en_US-ryan-high', ex2 && ex2.voice);
    await js("document.getElementById('saveBtn').click()"); await sleep(300);
    const savedVoice = await js("(window.__lastSaved.settings.personas.find(function (p) { return p.id === 'kawaii'; }) || {}).voice");
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
      'https://example.com/clash.json': JSON.stringify({ id: 'jarvis', name: 'Jarvis (shared)', prompt: 'Different.' }),
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
    check('a fetched persona with an existing id asks before replacing; Cancel keeps Jarvis', (await js('window.__confirmCalls')) === 1 && (await names()).indexOf('Jarvis') !== -1 && (await names()).indexOf('Jarvis (shared)') === -1, await js('window.__confirmMsg'));
    await js("document.getElementById('sPersonaImportCancel').click()");

    // ---- phase 3: persona repositories (Browse / Install / Update / Check for updates) ----
    const P = (id, name, version, state, extra) => Object.assign({ id, name, version, description: name + ' persona', source: 'https://github.com/acme/packs/tree/main', state }, extra || {});
    const SRC_A = 'https://github.com/acme/packs/tree/main';
    const SRC_B = 'https://github.com/secret/private-packs/tree/main';
    const catText = () => js("document.getElementById('sPersonaCatalog').innerText");
    const catBtns = () => js("Array.from(document.querySelectorAll('#sPersonaCatalog .prInstall')).map(function (b) { return b.getAttribute('data-id') + ':' + b.textContent.trim() + (b.disabled ? ':disabled' : ''); })");
    const rmsg = () => js("document.getElementById('sPersonaRepoMsg').textContent");
    const browseClick = async () => { await js("document.getElementById('sPersonaBrowse').click()"); await sleep(500); };
    await js('window.__installCalls = []; window.__listResult = ' + JSON.stringify({ ok: true, sources: [
      { source: SRC_A, personas: [P('ava', 'Ava', '1.2.0', 'available'), P('ben', 'Ben', '2.0.0', 'update', { installedVersion: '1.0.0' }), P('cy', 'Cy', '1.0.0', 'installed'), P('dot', 'Dot', '1.0.0', 'edited')] },
      { source: SRC_B, authed: true, personas: [P('eve', 'Eve', '0.9.0', 'available', { source: SRC_B })] },
      { source: 'https://github.com/acme/apps/tree/main', implicit: true, missing: true, personas: [] },
      { source: 'https://github.com/acme/empty/tree/main', personas: [] },
    ] }));
    await browseClick();
    const t1 = await catText();
    check('Browse lists every source with its heading, name, version and description',
      t1.includes(SRC_A) && t1.includes(SRC_B) && /Ava/.test(t1) && /v1\.2\.0/.test(t1) && /Ava persona/.test(t1) && /Eve/.test(t1), t1.slice(0, 200));
    check('state buttons: Install / Update / Installed (disabled) / Replace…', (await catBtns()).join(',') === 'ava:Install,ben:Update,cy:Installed:disabled,dot:Replace…,eve:Install', await catBtns());
    check('an update row shows the version you have', /v2\.0\.0 \(have 1\.0\.0\)/.test(t1.replace(/\s+/g, ' ')), t1.replace(/\s+/g, ' ').slice(0, 200));
    check('private, app-repository, missing-folder and empty-source notes are shown', /private, via your GitHub connection/.test(t1) && /\(app repository\)/.test(t1) && /No personas folder in this app repository/.test(t1) && /No personas in this source/.test(t1));
    await shot('04-catalog');

    // Install: calls the API with replace=false and reports what was installed
    await js('window.__installResult = function (s, id) { return { ok: true, name: id.toUpperCase(), version: "1.2.0", replaced: false }; }; true');
    await js("document.querySelector('#sPersonaCatalog .prInstall[data-id=\"ava\"]').click()"); await sleep(2800);   // the UI waits up to ~2 s for a settings re-render that only the real app performs
    const calls1 = await js('window.__installCalls');
    check('Install sends (source, id, replace=false)', calls1.length === 1 && calls1[0].id === 'ava' && calls1[0].src === SRC_A && calls1[0].replace === false, calls1);
    check('the result line says what was installed', /Installed "AVA" v1\.2\.0/.test(await rmsg()), await rmsg());

    // Replace… (a library entry that did not come from this source): asks; Cancel installs nothing
    await js('window.__installCalls = []');
    await browseClick();
    await answer(false);
    await js("document.querySelector('#sPersonaCatalog .prInstall[data-id=\"dot\"]').click()"); await sleep(300);
    check('Replace… asks first; Cancel sends no install request', (await js('window.__confirmCalls')) === 1 && (await js('window.__installCalls')).length === 0, await js('window.__confirmMsg'));
    await answer(true);
    await js("document.querySelector('#sPersonaCatalog .prInstall[data-id=\"dot\"]').click()"); await sleep(700);
    const calls2 = await js('window.__installCalls');
    check('Replace… accepted sends replace=true', calls2.length === 1 && calls2[0].id === 'dot' && calls2[0].replace === true, calls2);

    // Update over a persona that came from the same source. Since Fable's content hash, the catalog reports a
    // persona edited after install as 'edited' (Replace…, asked above); only an UNTOUCHED copy shows 'Update'
    // and it installs without a prompt (replace=false; the main process re-checks the hash and would answer
    // needsConfirm if it changed meanwhile).
    await js('window.__installCalls = []');
    await browseClick();
    await answer(false);
    await js("document.querySelector('#sPersonaCatalog .prInstall[data-id=\"ben\"]').click()"); await sleep(600);
    const sent = await js('window.__installCalls');
    check('an untouched copy updates without a prompt (replace=false)', (await js('window.__confirmCalls')) === 0 && sent.length === 1 && sent[0].id === 'ben' && sent[0].replace === false, { confirmAsked: await js('window.__confirmCalls'), installRequests: sent });
    // the main process can still refuse a replace it is not sure about (needsConfirm): the editor must ask then
    await js('window.__installCalls = []; window.__installResult = function (s, id, replace) { return replace ? { ok: true, name: "Ben", version: "2.0.0", replaced: true } : { ok: false, needsConfirm: true, existingName: "Ben", error: "Ben was edited since it was installed." }; }; true');
    await browseClick();
    await answer(false);
    await js("document.querySelector('#sPersonaCatalog .prInstall[data-id=\"ben\"]').click()"); await sleep(600);
    const sent2 = await js('window.__installCalls');
    check('needsConfirm from the main process is shown to the user; Cancel does not retry with replace', (await js('window.__confirmCalls')) === 1 && sent2.length === 1 && sent2[0].replace === false && /edited since/.test(await js('window.__confirmMsg')), { sent2, msg: await js('window.__confirmMsg') });
    await answer(true);
    await js('window.__installCalls = []');
    await browseClick();
    await js("document.querySelector('#sPersonaCatalog .prInstall[data-id=\"ben\"]').click()"); await sleep(700);
    const sent3 = await js('window.__installCalls');
    check('accepting that prompt retries once with replace=true', sent3.length === 2 && sent3[0].replace === false && sent3[1].replace === true, sent3);
    await js('window.__installResult = function (s, id) { return { ok: true, name: id.toUpperCase(), version: "1.2.0", replaced: false }; }; true');

    // Partial failure: a good source and a failing private source in one listing
    await js('window.__listResult = ' + JSON.stringify({ ok: true, sources: [
      { source: SRC_A, personas: [P('ava', 'Ava', '1.2.0', 'available')] },
      { source: SRC_B, authed: true, error: 'GitHub is not connected. Connect it under Settings > Auth, then press Browse again.', personas: [] },
    ] }));
    await browseClick();
    const t2 = await catText();
    check('one failing source keeps the good source visible and shows an actionable reason', /Ava/.test(t2) && t2.includes(SRC_B) && /not connected/i.test(t2) && /Settings > Auth/.test(t2), t2.slice(0, 220));
    win.setSize(900, 900); await sleep(400);
    const L2 = await js("(function () { var over = []; document.querySelectorAll('#sPersonaCatalog *, #sPersonaRepoRows *').forEach(function (e) { var b = e.getBoundingClientRect(); if (b.width && (b.right > window.innerWidth + 1 || b.left < -1)) over.push(e.className || e.tagName); }); return { docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1, offscreen: over.slice(0, 5) }; })()");
    check('the catalog does not overflow at 900 px', !L2.docOverflow && L2.offscreen.length === 0, L2);
    await shot('05-catalog-900');
    win.setSize(1180, 900); await sleep(300);

    // Real classification (Codex #219): five library situations through the real annotate()/contentHash().
    // Expected: untouched same-source copy -> Update; edited since install -> Replace…; pre-hash install (unknown) ->
    // Replace…; hand-made (no source) -> Replace…; untouched at the same version -> Installed.
    await js(`(function () {
      var H = window.__repoHelpers, SRC = '${SRC_A}';
      function mk(id, prompt) { return H.normalize({ id: id, name: id.toUpperCase(), prompt: prompt }); }
      function fromSrc(id, hashOf, prompt, version, noHash) { var p = mk(id, prompt); var h = H.contentHash(hashOf || p); p.source = { url: SRC, version: version }; if (!noHash) p.source.hash = h; return p; }
      var pristine = fromSrc('p1', null, 'Original.', '1.0.0');
      var edited = fromSrc('p2', mk('p2', 'Original.'), 'I changed this.', '1.0.0');   // hash recorded for 'Original.', content differs now
      var legacy = fromSrc('p3', null, 'Whatever.', '1.0.0', true);
      var hand = mk('p4', 'Mine.');
      var same = fromSrc('p5', null, 'Same.', '2.0.0');
      window.__library = [pristine, edited, legacy, hand, same];
      var e = function (id, v) { return { id: id, name: id.toUpperCase(), version: v, description: 'd', file: id + '.persona.json' }; };
      window.__catalogEntries = {}; window.__catalogEntries[SRC] = [e('p1', '2.0.0'), e('p2', '2.0.0'), e('p3', '2.0.0'), e('p4', '2.0.0'), e('p5', '2.0.0'), e('p6', '1.0.0')];
      return true;
    })()`);
    await browseClick();
    check('classification through the real annotate/contentHash: Update / Replace… x3 / Installed / Install',
      (await catBtns()).join(',') === 'p1:Update,p2:Replace…,p3:Replace…,p4:Replace…,p5:Installed:disabled,p6:Install', await catBtns());
    await js('window.__catalogEntries = null; window.__library = null; true');

    // Screenshots for UI review (Codex #210): every kind of source group plus one error, at 1180 and 900
    await js('window.__listResult = ' + JSON.stringify({ ok: true, sources: [
      { source: SRC_A, personas: [P('ava', 'Ava', '1.2.0', 'available'), P('ben', 'Ben', '2.0.0', 'update', { installedVersion: '1.0.0' }), P('cy', 'Cy', '1.0.0', 'installed'), P('dot', 'Dot', '1.0.0', 'edited')] },
      { source: SRC_B, authed: true, error: 'GitHub is not connected. Connect it under Settings > Auth, then press Browse again.', personas: [] },
      { source: 'https://github.com/acme/more/tree/main/personas', personas: [P('flo', 'Flo', '0.3.0', 'available', { description: 'A deliberately long description that has to be cut off by the row instead of wrapping onto several lines and pushing the Install button out of reach' })] },
      { source: 'https://github.com/acme/apps/tree/main', implicit: true, missing: true, personas: [] },
      { source: 'https://github.com/acme/empty/tree/main', personas: [] },
    ] }));
    await browseClick();
    for (const w of [1180, 900]) {
      win.setSize(w, 900); await sleep(400);
      await js("document.getElementById('sPersonaCatalog').scrollIntoView({ block: 'start' })"); await sleep(250);
      const Lc = await js("(function () { var over = []; document.querySelectorAll('#sPersonaCatalog button, #sPersonaCatalog span').forEach(function (e) { var b = e.getBoundingClientRect(); if (b.width && (b.right > window.innerWidth + 1 || b.left < -1)) over.push(e.className || e.tagName); }); var btn = document.querySelector('#sPersonaCatalog .prInstall[data-id=\"flo\"]'); var bb = btn && btn.getBoundingClientRect(); return { docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1, offscreen: over.slice(0, 5), longRowButtonVisible: !!bb && bb.right <= window.innerWidth && bb.width >= 60 }; })()");
      check('catalog with every group kind and one error fits at ' + w + ' px; the Install button of a long-description row stays reachable', !Lc.docOverflow && Lc.offscreen.length === 0 && Lc.longRowButtonVisible, Lc);
      await shot('06-catalog-' + w);
    }
    win.setSize(1180, 900); await sleep(300);

    // Codex #209: an install re-renders the whole editor; with unsaved drafts it would drop them.
    // Spec: Install/Update must not run while the editor has unsaved changes (ask to Save & apply first).
    await js('window.__installCalls = []');
    await js("(function () { var i = document.querySelector('#sPersonaRows .psName'); i.value = 'Draft rename'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await answer(false);
    await js("document.querySelector('#sPersonaCatalog .prInstall[data-id=\"ava\"]').click()"); await sleep(600);
    const dirtySent = await js('window.__installCalls');
    const dirtyMsg = await rmsg();
    check('Install with unsaved editor changes does not run (the re-render would drop the drafts); the user is told to Save & apply first', dirtySent.length === 0 && /Save & apply/i.test(dirtyMsg), { installRequests: dirtySent.length, msg: dirtyMsg });
    await sleep(3000);   // an install that did run schedules a delayed re-browse; let it settle so later checks read their own messages

    // Whole-list failure: the reason is shown and a typed repository URL is kept
    await js("document.getElementById('sPersonaRepoAdd').click()"); await sleep(150);
    await js("(function () { var i = document.querySelector('#sPersonaRepoRows .prUrl'); i.value = 'https://github.com/me/my-personas/tree/main'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await js('window.__listResult = { ok: false, error: "Could not reach GitHub (timeout)." }');
    await browseClick();
    check('a failed listing explains itself and keeps the typed repository URL',
      /timeout/i.test(await rmsg()) && (await js("document.querySelector('#sPersonaRepoRows .prUrl').value")) === 'https://github.com/me/my-personas/tree/main', await rmsg());
    await js("document.querySelector('#sPersonaRepoRows .prRemove').click()"); await sleep(100);
    check('a repository row can be removed', (await js("document.querySelectorAll('#sPersonaRepoRows .prUrl').length")) === 0);

    // Check for updates
    await js('window.__updatesResult = ' + JSON.stringify({ ok: true, updates: [{ name: 'Ben', installedVersion: '1.0.0', remoteVersion: '2.0.0' }, { name: 'Dot', installedVersion: '1.0.0', remoteVersion: '1.1.0' }], errors: [] }));
    await js("document.getElementById('sPersonaUpdates').click()"); await sleep(400);
    check('Check for updates lists the pending updates and points at Browse', /2 updates available: Ben 1\.0\.0 → 2\.0\.0, Dot 1\.0\.0 → 1\.1\.0/.test(await rmsg()) && /Browse repositories/.test(await rmsg()), await rmsg());
    await js('window.__updatesResult = ' + JSON.stringify({ ok: true, updates: [], errors: [{ source: SRC_B, error: 'x' }] }));
    await js("document.getElementById('sPersonaUpdates').click()"); await sleep(400);
    check('up to date, with an unreadable source mentioned', /up to date/i.test(await rmsg()) && /1 source could not be read/.test(await rmsg()), await rmsg());
    await js('window.__updatesResult = { ok: false, error: "No repositories to check." }');
    await js("document.getElementById('sPersonaUpdates').click()"); await sleep(300);
    check('a failed update check shows its reason', /No repositories to check/.test(await rmsg()), await rmsg());

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
