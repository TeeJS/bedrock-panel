'use strict';
// Standalone, side-effect-free renderer harness: loads the REAL app/config.html editor in one
// offscreen Electron window with a stubbed window.bedrockConfig (see preload-stub.js). It does NOT
// require app/main.js, so no panel, servers, devices, MQTT or HA are ever touched. It drives the
// shared editor's number-option validation (MD-05) and the separate-device preview placeholder
// (MD-06 Option B) on the real config.js and prints a JSON result per step. Screenshots + result.json
// go to a temp dir (never the repo). See README.md for the invocation.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CONFIG_HTML = path.join(REPO, 'app', 'config.html');
const OUT = path.join(os.tmpdir(), 'md-editor-harness');
const SHOTS = path.join(OUT, 'shots');
const PRELOAD = path.join(__dirname, 'preload-stub.js');

fs.rmSync(SHOTS, { recursive: true, force: true }); fs.mkdirSync(SHOTS, { recursive: true });
const results = { steps: [], shots: [], out: OUT };
const log = o => { results.steps.push(o); console.log('[H] ' + JSON.stringify(o)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let win;
const js = code => win.webContents.executeJavaScript(code, true);
async function shot(name) {
  await sleep(120);
  try { const img = await win.webContents.capturePage(); const p = path.join(SHOTS, name + '.png'); fs.writeFileSync(p, img.toPNG()); results.shots.push(p); log({ shot: name }); }
  catch (e) { log({ shot: name, error: String(e) }); }
}
function finish(code) {
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(results, null, 2));
  console.log('[H] result + shots in ' + OUT);
  setTimeout(() => { try { app.exit(code); } catch (e) { process.exit(code); } }, 150);
}
setTimeout(() => finish(42), 45000);   // hard cap

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1180, height: 900, show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: false, nodeIntegration: true, sandbox: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (/error|Uncaught|TypeError/i.test(message)) log({ pageError: message.slice(0, 200) }); });
  win.showInactive();
  await win.loadFile(CONFIG_HTML);
  try {
    const end = Date.now() + 20000; let ok = false;
    while (Date.now() < end) { if (await js(`!!document.getElementById('mdopt-aopt-longPressMs')`)) { ok = true; break; } await sleep(200); }
    log({ inputRendered: ok });
    if (!ok) { await shot('00-no-input'); return finish(3); }

    // (P) MD-06 Option B: the macro-deck-surface page shows an honest PLACEHOLDER — no preview iframe
    // (no editor host connection), no Connect/Expand, no over-claims.
    await sleep(600);
    const P = await js(`(function(){
      var frame=document.querySelector('.apprevFrame');
      var note=document.querySelector('.apprevNote');
      var t=(note&&note.textContent)||'';
      return { hasIframe:!!frame, hasPlaceholder:!!note, noteText:t, overclaims:/disturb|exactly what the panel/i.test(t) };
    })()`);
    log({ P_previewPlaceholderB: P });

    await js(`(function(){var i=document.getElementById('mdopt-aopt-longPressMs');var d=i&&i.closest('details');if(d)d.open=true;})()`);
    await sleep(150);

    // (A) On load: seeded '50' invalid -> inline error + live Reset, no auto-correction; help associated.
    const A = await js(`(function(){
      var i=document.getElementById('mdopt-aopt-longPressMs');
      var err=document.getElementById('mdopt-aopt-longPressMs-err');
      return { value:i.value, ariaInvalid:i.getAttribute('aria-invalid'), describedby:i.getAttribute('aria-describedby'),
        errText:(err&&err.textContent)||'', errShown:!!(err&&err.style.display!=='none'&&err.textContent), resetBtn:!!(err&&err.querySelector('.optreset')) };
    })()`);
    log({ A_onLoad: A });
    await shot('A-onload-invalid');

    // (B) doSave gate: edit dirties the form, blur + close disclosure, then Save -> gate blocks,
    // re-opens the disclosure and focuses the field.
    await js(`(function(){var i=document.getElementById('mdopt-aopt-longPressMs');i.value='5';i.dispatchEvent(new Event('input',{bubbles:true}));i.blur();var d=i.closest('details');if(d)d.open=false;document.getElementById('saveBtn').focus();})()`);
    await sleep(150);
    await js(`document.getElementById('saveBtn').click()`);
    await sleep(300);
    const B = await js(`(function(){var i=document.getElementById('mdopt-aopt-longPressMs');return { state:document.getElementById('state').textContent, focusedAfter:document.activeElement===i, detailsOpenAfter:!!(i&&i.closest('details')&&i.closest('details').open) };})()`);
    log({ B_saveGateBlocked: B });
    await shot('B-save-blocked');

    // (C) input-time draft: type another invalid value, dispatch 'input' only, Save -> still blocked.
    await js(`(function(){var i=document.getElementById('mdopt-aopt-longPressMs');i.value='99999';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await sleep(120);
    await js(`document.getElementById('saveBtn').click()`);
    await sleep(200);
    const C = await js(`(function(){var e=document.getElementById('mdopt-aopt-longPressMs-err');return { state:document.getElementById('state').textContent, errText:(e&&e.textContent)||'' };})()`);
    log({ C_inputTimeStillBlocked: C });

    // (D) Reset button (re-created by showNumberError) -> default 1000, error clears.
    await js(`(function(){var e=document.getElementById('mdopt-aopt-longPressMs-err');var b=e&&e.querySelector('.optreset');if(b)b.click();})()`);
    await sleep(250);
    const D = await js(`(function(){var i=document.getElementById('mdopt-aopt-longPressMs');var e=document.getElementById('mdopt-aopt-longPressMs-err');return { value:i.value, errShown:!!(e&&e.style.display!=='none'&&e.textContent) };})()`);
    log({ D_resetToDefault: D });
    await shot('D-after-reset');

    // (E) A valid value saves cleanly.
    await js(`(function(){var i=document.getElementById('mdopt-aopt-longPressMs');i.value='1500';i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await sleep(150);
    await js(`document.getElementById('saveBtn').click()`);
    await sleep(500);
    const E = await js(`(function(){return { state:document.getElementById('state').textContent, savedLongPress:(window.__lastSaved&&window.__lastSaved.grids&&window.__lastSaved.grids[0].options.longPressMs)||null };})()`);
    log({ E_validSaves: E });
    await shot('E-valid-saved');

    // (G) disclosure open-state persists across a renderAppOpts re-render (toggle Key shape).
    await js(`(function(){var i=document.getElementById('mdopt-aopt-longPressMs');var d=i.closest('details');if(d)d.open=true;})()`);
    await sleep(120);
    await js(`(function(){var s=document.getElementById('mdopt-aopt-layoutMode');if(s){s.value='wide';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
    await sleep(180);
    const G = await js(`(function(){var i=document.getElementById('mdopt-aopt-longPressMs');var d=i&&i.closest('details');var s=document.getElementById('mdopt-aopt-layoutMode');return { layoutValue:s?s.value:null, detailsOpenAfterRerender:!!(d&&d.open) };})()`);
    log({ G_disclosurePersistsAcrossRerender: G });

    // (F) cross-page gate: make page A invalid, navigate to page B, Save -> reveal switches back to A.
    await js(`(function(){var i=document.getElementById('mdopt-aopt-longPressMs');i.value='50';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await sleep(120);
    await js(`(function(){var r=document.querySelector('[aria-label="Macro Deck B"]');if(r)r.click();})()`);
    await sleep(250);
    const Fnav = await js(`(function(){var i=document.getElementById('mdopt-aopt-longPressMs');return { valueOnPageB:i?i.value:null };})()`);
    await js(`document.getElementById('saveBtn').click()`);
    await sleep(350);
    const F = await js(`(function(){var i=document.getElementById('mdopt-aopt-longPressMs');return { state:document.getElementById('state').textContent, revealedValue:i?i.value:null, focused:document.activeElement===i };})()`);
    log({ F_crossPageReveal: { afterNavToB: Fnav, afterSaveFromB: F } });
    await shot('F-crosspage-reveal');

    // (H) SETTINGS-scope (.aset) generic number path via the synthetic app.
    await js(`(function(){var r=document.querySelector('[aria-label="Macro Deck A"]');if(r)r.click();})()`);
    await sleep(150);
    await js(`(function(){var i=document.getElementById('mdopt-aopt-longPressMs');if(i){i.value='1000';i.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    await sleep(100);
    await js(`(function(){var r=document.querySelector('[aria-label="Synth Settings"]');if(r)r.click();})()`);
    await sleep(250);
    await js(`(function(){var i=document.getElementById('mdopt-aset-delay');var d=i&&i.closest('details');if(d)d.open=true;})()`);
    await sleep(150);
    await js(`(function(){var i=document.getElementById('mdopt-aset-delay');i.value='40';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await sleep(150);
    const Hload = await js(`(function(){var i=document.getElementById('mdopt-aset-delay');var e=document.getElementById('mdopt-aset-delay-err');return { value:i?i.value:null, describedby:i?i.getAttribute('aria-describedby'):null, ariaInvalid:i?i.getAttribute('aria-invalid'):null, errShown:!!(e&&e.style.display!=='none'&&e.textContent), resetBtn:!!(e&&e.querySelector('.optreset')) };})()`);
    await js(`(function(){var i=document.getElementById('mdopt-aset-delay');i.blur();var d=i.closest('details');if(d)d.open=false;document.getElementById('saveBtn').focus();})()`);
    await sleep(120);
    await js(`document.getElementById('saveBtn').click()`);
    await sleep(300);
    const Hgate = await js(`(function(){var i=document.getElementById('mdopt-aset-delay');return { state:document.getElementById('state').textContent, focused:document.activeElement===i, detailsOpen:!!(i&&i.closest('details')&&i.closest('details').open) };})()`);
    await js(`(function(){var e=document.getElementById('mdopt-aset-delay-err');var b=e&&e.querySelector('.optreset');if(b)b.click();})()`);
    await sleep(200);
    const Hreset = await js(`(function(){var i=document.getElementById('mdopt-aset-delay');var e=document.getElementById('mdopt-aset-delay-err');return { value:i?i.value:null, errShown:!!(e&&e.style.display!=='none'&&e.textContent) };})()`);
    await js(`document.getElementById('saveBtn').click()`);
    await sleep(400);
    const Hsave = await js(`(function(){return { state:document.getElementById('state').textContent, savedDelay:(window.__lastSaved&&window.__lastSaved.settings&&window.__lastSaved.settings.synthnum&&window.__lastSaved.settings.synthnum.delay)||null };})()`);
    log({ H_settingsScope: { onLoad: Hload, saveGate: Hgate, reset: Hreset, validSave: Hsave } });
    await shot('H-settings-scope');

    return finish(0);
  } catch (err) { log({ fatal: String(err && err.stack || err) }); await shot('ZZ-fatal'); return finish(9); }
});
