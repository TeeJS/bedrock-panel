'use strict';
// Interactive Fiction player: panel chrome + voice, running inside Parchment's own page.
//
// vendor-parchment.js builds index.html from an upstream Parchment single-file release, externalises
// its inline scripts (Bedrock Panel serves drop-in apps under `script-src 'self'`), extracts its cores to
// real files, and injects chrome.html + this file. Same document as the interpreter -- no iframe,
// which also sidesteps `frame-ancestors 'none'`.
//
// Stories are loaded as BYTES, never by URL: a story can live in any folder on the PC (the "Stories
// folder" option), which the local static server won't serve. server.js reads the file and returns
// base64; here we turn it into a File and hand it to Parchment via load_uploaded_file -- its own
// supported bytes path. boot.js launches Parchment idle so its Dialog/Glk layer is ready for that.
//
// Two interpreter integration points, verified against the real build:
//   read  -- new game text arrives as .BufferLine elements inside .BufferWindowInner
//   write -- GlkOte.send_event({type:'line', window:N, value}) submits a command.
//
// Voice: POST /app-api/speak (text -> base64 WAV) and /app-api/listen (Int16 PCM -> transcript),
// backed by the system Wyoming TTS/STT.
(function () {
  var q = new URLSearchParams(location.search);
  var DARK = q.get('_dark') !== '0';
  var ACCENT = /^#[0-9a-fA-F]{6}$/.test(q.get('_accent') || '') ? q.get('_accent') : '#7CFFB2';
  var FORCE_PICK = q.get('pick') === '1';                       // set by the Stories button's reload
  var OPT_STORY = FORCE_PICK ? '' : (q.get('story') || '').trim();
  var WANT_SPEAK = q.get('speak') !== '0' && q.get('speak') !== 'false';
  var WANT_VOICE_IN = q.get('voiceInput') !== '0' && q.get('voiceInput') !== 'false';
  var WANT_AUTOSAVE = q.get('autosave') === '1' || q.get('autosave') === 'true';
  var AUTOSAVE_MS = (function () {
    var n = parseInt(q.get('autosaveInterval'), 10);
    if (!isFinite(n) || n < 1) n = 5;                            // default + floor: 5 min, never below 1
    return n * 60 * 1000;
  })();

  var el = function (id) { return document.getElementById(id); };
  var picker = el('picker'), storylist = el('storylist');
  var statusdot = el('statusdot'), statustext = el('statustext'), storyname = el('storyname');
  var heard = el('heard'), railnote = el('railnote');
  var speakbtn = el('speakbtn'), listenbtn = el('listenbtn'), stopbtn = el('stopbtn'), librarybtn = el('librarybtn');
  var commandbtns = [].slice.call(document.querySelectorAll('[data-command]'));   // compass + quick + Save/Restore

  document.documentElement.style.setProperty('--if-accent', ACCENT);
  document.documentElement.setAttribute('data-theme', DARK ? 'dark' : 'light');
  document.body.classList.add(DARK ? 'if-dark' : 'if-light');
  if (!WANT_VOICE_IN) document.body.classList.add('novoicein');

  var caps = { tts: false, stt: false };
  var narrating = false, listening = false;
  var speakQueue = [], audio = null, speaking = false, prefetch = null;
  var vad = null, observer = null, gwin = 0, playing = false, gameOver = false;
  var autosaveTimer = null, suppressSave = false, restoreArtifactUntil = 0, resumeBar = null, lastAutosaveAt = 0;

  function setStatus(cls, text) { statusdot.className = 'dot ' + (cls || ''); statustext.textContent = text; }
  function note(msg) { railnote.textContent = msg || ''; }

  // ---- story picker -----------------------------------------------------
  function showPicker(stories, folder) {
    document.body.classList.add('picking');
    picker.hidden = false;
    setStatus('', 'Choose a story');
    storyname.textContent = '';
    el('pkfolder').textContent = folder ? 'Folder: ' + folder : '';
    storylist.innerHTML = '';
    if (!stories || !stories.length) {
      el('pickerhint').textContent = 'No stories found';
      var empty = document.createElement('div');
      empty.className = 'pk-empty';
      empty.textContent = 'Set this page’s "Stories folder" option to a folder on your PC that holds '
        + '.z5 / .z8 / .zblorb / .ulx / .gblorb files (or drop some into the app’s bundled stories folder).';
      storylist.appendChild(empty);
      return;
    }
    el('pickerhint').textContent = stories.length + (stories.length === 1 ? ' story' : ' stories');
    stories.forEach(function (name) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'story';
      var t = document.createElement('span'); t.className = 'story-name'; t.textContent = name.replace(/\.[^.]+$/, '');
      var e = document.createElement('span'); e.className = 'story-ext'; e.textContent = (name.split('.').pop() || '').toUpperCase();
      b.appendChild(t); b.appendChild(e);
      b.addEventListener('click', function () { loadStory(name); });
      storylist.appendChild(b);
    });
  }

  function b64ToBytes(b64) {
    var bin = atob(b64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  // Retry: Parchment's launch() (kicked off by boot.js) initialises its Dialog layer asynchronously,
  // and load_uploaded_file needs that ready. Attempts settle as soon as it is.
  function loadIntoParchment(file) {
    return new Promise(function (resolve, reject) {
      var tries = 0;
      (function attempt() {
        tries++;
        var p = window.parchment;
        if (p && typeof p.load_uploaded_file === 'function') {
          try {
            Promise.resolve(p.load_uploaded_file(file)).then(resolve, function (e) {
              if (tries > 40) reject(e); else setTimeout(attempt, 150);
            });
            return;
          } catch (e) { if (tries > 40) return reject(e); }
        }
        if (tries > 40) return reject(new Error('interpreter not ready'));
        setTimeout(attempt, 150);
      })();
    });
  }
  function loadStory(name) {
    document.body.classList.remove('picking');
    picker.hidden = true;
    storyname.textContent = name;
    setStatus('busy', 'Loading story…');
    fetch('/app-api/storyfile?name=' + encodeURIComponent(name))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !j.b64) throw new Error(j && j.error || 'could not read story');
        return loadIntoParchment(new File([b64ToBytes(j.b64)], name));
      })
      .then(function () { waitForGame(); })
      .catch(function (e) { setStatus('bad', 'Load failed'); note((e && e.message) || 'Could not load the story.'); });
  }

  // ---- the interpreter --------------------------------------------------
  function glkote() { try { return window.parchment.options.GlkOte; } catch (e) { return null; } }
  function waitForGame() {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var inner = document.querySelector('.BufferWindowInner');
      if (inner) { clearInterval(timer); attach(inner); }
      else if (tries > 200) { clearInterval(timer); setStatus('bad', 'Story failed to load'); note('That file may not be a Z-code or Glulx story.'); }
    }, 200);
  }
  function attach(inner) {
    var frameEl = document.querySelector('.BufferWindow');
    gwin = parseInt(String(frameEl && frameEl.id || '').replace(/\D+/g, ''), 10) || 0;
    playing = true;
    updateCommandButtons();
    setStatus('ok', 'Playing');
    // Detect the game ending (QUIT confirmed, death then QUIT, etc.): the interpreter calls
    // GlkOte.exit() on a disabling update, but that method is a stub -- so the finished game just
    // sits there. Wrap it to return to the story list.
    var G = glkote();
    if (G && !G.__ifExitWrapped) {
      G.__ifExitWrapped = true;
      var origExit = typeof G.exit === 'function' ? G.exit.bind(G) : function () {};
      G.exit = function () { try { origExit(); } catch (e) {} onGameOver(); };
    }
    if (observer) observer.disconnect();
    observer = new MutationObserver(function (muts) {
      var text = [];
      muts.forEach(function (m) {
        [].forEach.call(m.addedNodes, function (n) {
          if (n.nodeType !== 1 || !n.classList || !n.classList.contains('BufferLine')) return;
          if (suppressSave) { try { n.style.display = 'none'; } catch (e) {} return; }   // autosave turn: hide the whole "> save"/"Ok." turn, speak nothing
          var t = (n.innerText || '').replace(/\s+/g, ' ').trim();
          if (t && restoreArtifactUntil > Date.now() && /end of history playback|^ok\.?$/i.test(t)) { try { n.style.display = 'none'; } catch (e) {} return; }   // resume: drop asyncglk's replay artifact, keep the room text
          if (!t || t.charAt(0) === '>') return;               // blank, or the echoed player command
          text.push(t);
        });
      });
      if (text.length) enqueueSpeech(text.join(' '));
    });
    observer.observe(inner, { childList: true, subtree: true });
    // The observer only sees FUTURE lines. The opening banner + first room are already on screen when
    // we attach, so they'd never be spoken -- narrate what's here now, once. (Sentence-split below, so
    // it starts quickly even though the intro is long.)
    if (narrating) {
      var initial = [].slice.call(inner.querySelectorAll('.BufferLine'))
        .map(function (n) { return (n.innerText || '').replace(/\s+/g, ' ').trim(); })
        .filter(function (t) { return t && t.charAt(0) !== '>'; })
        .join(' ');
      if (initial) enqueueSpeech(initial);
    }
    focusGame();
    offerResume(0);
  }
  // True when the user is (or should be) typing into a real field: the game's command input, or an
  // interpreter dialog like SAVE/RESTORE's filename box (asyncglk_file_dialog #filename_input), or the
  // URL box. The keyboard helpers below must never pull focus away from any of these.
  function isTypingTarget() {
    var ae = document.activeElement;
    if (!ae) return false;
    var tag = ae.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable === true;
  }
  // The MAIN command box: the buffer window's line input. Targeting this specifically (not just the
  // first .Input, which in a status-line game can be a grid-window input) keeps recovered keystrokes
  // in the story's text box and nowhere else on screen.
  function gameInput() {
    return document.querySelector('.BufferWindow .LineInput')
        || document.querySelector('.BufferWindow .Input')
        || document.querySelector('.Input');
  }
  function focusGame() {
    try {
      if (isTypingTarget()) return;            // don't yank focus from a save/restore dialog or field
      var i = gameInput(); if (i) i.focus();
    } catch (e) {}
  }
  // The game ended -> hand the panel back to the story list, once. Give the closing text a moment to
  // be seen, and if narration is on, let it finish reading the final passage first (capped).
  function onGameOver() {
    if (gameOver) return;
    gameOver = true;
    if (autosaveTimer) { clearInterval(autosaveTimer); autosaveTimer = null; }
    setStatus('', 'Game over');
    note('Returning to your stories…');
    var ticks = 0;
    (function tick() {
      ticks++;
      var narrationDone = !speaking && !speakQueue.length;
      if ((ticks < 10 || !narrationDone) && ticks < 70) { setTimeout(tick, 300); return; }   // >=3s, let narration finish, cap ~21s
      var u = new URL(location.href); u.searchParams.set('pick', '1'); location.href = u.toString();
    })();
  }
  function sendCommand(text) {
    var G = glkote();
    if (!G || !text) return false;
    try {
      G.send_event({ type: 'line', window: gwin, value: text });
      setTimeout(focusGame, 60);               // after GlkOte re-renders the new prompt, put the keyboard back on it
      return true;
    } catch (e) { return false; }
  }

  // ---- narration (TTS) --------------------------------------------------
  // Split a passage into sentences so narration starts after the FIRST sentence synthesizes, not the
  // whole room -- the server renders a whole /app-api/speak call before returning, so a long room used
  // to sit silent for seconds. A short leading fragment (a room heading with no full stop) glues onto
  // the next chunk so it isn't spoken as a lonely blip.
  function splitSentences(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return [];
    // Partition the WHOLE passage at sentence ends -- a terminator plus any trailing closing quotes or
    // brackets (!" ." .) etc.) followed by a space -- by inserting a marker there and splitting on it.
    // This never drops text. (The previous match()-based version silently discarded any run it could
    // not tokenize, so a sentence ending in a quote/paren -- common in Zork -- vanished or got mangled.)
    var SEP = String.fromCharCode(1);
    var marked = t.replace(/([.!?]+["'”’)\]]*)\s+/g, '$1' + SEP);
    var out = [];
    marked.split(SEP).forEach(function (s) {
      s = s.trim(); if (!s) return;
      if (out.length && !/[.!?]["'”’)\]]*$/.test(out[out.length - 1])) out[out.length - 1] += ' ' + s;   // glue a heading fragment (no terminator) onto the next
      else out.push(s);
    });
    return out.length ? out : [t];
  }
  // Clean text for the VOICE only (not what's shown): drop quotes/brackets/markdownish markers the
  // TTS voice reads aloud, and turn '!' into a plain sentence end (the voice pronounces the exclamation
  // mark). '?' is kept for question intonation. Splitting already happened on the original text.
  function ttsSanitize(s) {
    return String(s || '')
      .replace(/[*_`~|#>]+/g, ' ')                          // markdown-ish markers
      .replace(/["'“”‘’()\[\]]+/g, ' ')                     // quotes and brackets (keep the words inside)
      .replace(/!+/g, '.')                                  // the voice speaks '!' -> plain sentence end
      .replace(/\s*([.?:;,])[.!?]*/g, '$1')                 // collapse punctuation runs
      .replace(/\s+/g, ' ')
      .trim();
  }
  function fetchSpeech(sentence) {
    var say = ttsSanitize(sentence);
    if (!say) return Promise.resolve({ skip: true });        // nothing speakable (e.g. a punctuation-only line)
    return fetch('/app-api/speak', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: say })
      .then(function (r) { return r.json(); })
      .then(function (j) { return (j && j.ok && j.wav) ? { wav: j.wav } : { error: (j && j.error) || 'Narration unavailable' }; })
      .catch(function () { return { error: 'Narration unavailable' }; });
  }
  function enqueueSpeech(text) {
    if (!narrating) return;
    var parts = splitSentences(text);
    if (!parts.length) return;
    parts.forEach(function (p) { speakQueue.push(p); });
    if (!speaking) drainSpeech();
  }
  function drainSpeech() {
    if (!speakQueue.length) { speaking = false; prefetch = null; updateButtons(); return; }
    speaking = true; updateButtons();
    var sentence = speakQueue.shift();
    var cur = (prefetch && prefetch.text === sentence) ? prefetch.p : fetchSpeech(sentence);
    prefetch = speakQueue.length ? { text: speakQueue[0], p: fetchSpeech(speakQueue[0]) } : null;   // warm the next while this plays
    cur.then(function (res) {
      if (!speaking) return;                      // hushed while this was synthesizing
      if (res && res.wav) { playWav(res.wav); return; }
      if (res && res.error) note(res.error);
      drainSpeech();                              // skipped (nothing speakable) or errored -> move on
    });
  }
  function playWav(b64) {
    stopAudio();
    audio = new Audio('data:audio/wav;base64,' + b64);
    audio.addEventListener('ended', function () { audio = null; drainSpeech(); });
    audio.addEventListener('error', function () { audio = null; drainSpeech(); });
    audio.play().catch(function () { audio = null; drainSpeech(); });
  }
  function stopAudio() { if (audio) { try { audio.pause(); } catch (e) {} audio = null; } }
  function hush() { speakQueue = []; prefetch = null; stopAudio(); speaking = false; updateButtons(); }

  // ---- voice commands (STT) ---------------------------------------------
  function startListening() {
    if (listening) return;
    if (!window.createClaudeVoiceVAD) { note('Voice capture unavailable'); return; }
    vad = window.createClaudeVoiceVAD({ hangoverMs: 700, minSpeechMs: 250 });
    vad.start(function () {}, function (pcm) { onUtterance(pcm); })
      .then(function () { listening = true; updateButtons(); note('Say a command, e.g. “go north”.'); })
      .catch(function (e) { listening = false; vad = null; updateButtons(); note('Microphone unavailable: ' + (e && e.message || 'permission denied')); });
  }
  function stopListening() { if (vad) { try { vad.stop(); } catch (e) {} } vad = null; listening = false; updateButtons(); }
  function onUtterance(pcm) {
    if (speaking || (audio && !audio.paused)) return;            // don't transcribe our own narration
    heard.textContent = '…';
    fetch('/app-api/listen', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { heard.textContent = ''; note(j && j.error || 'Could not transcribe'); return; }
        var text = cleanCommand(j.text);
        if (!text || isNoise(text)) { heard.textContent = ''; return; }   // ignore Whisper's noise/filler hallucinations
        heard.textContent = '“' + text + '”';
        sendCommand(text);
      })
      .catch(function () { heard.textContent = ''; });
  }
  function cleanCommand(raw) { return String(raw || '').replace(/[.!?,;:"']+$/g, '').replace(/^[\s.,!?]+/, '').trim().toLowerCase(); }
  // Whisper hallucinates filler/interjections on room noise and silence ("yeah", "uh", "thank you",
  // "you", subtitle credits...). None are IF commands, so drop them rather than firing them at the
  // parser. Real short commands (n/s/e/w/u/d, i, x, z, go, yes, no, wait...) are deliberately NOT here.
  var STT_NOISE = {};
  ('yeah yea ya yah yep mm mmm hmm hm hmmm mhm mmhmm uh uhh um umm uhhuh huh er erm ah ahh oh ohh eh ehh '
    + 'you thanks thankyou thanksforwatching thankyouverymuch pleasesubscribe amaraorg '
    + 'so okay ok well right hey hi hello youknow bye byebye').split(' ').forEach(function (w) { STT_NOISE[w] = 1; });
  function isNoise(cmd) {
    if (STT_NOISE[cmd]) return true;
    return !!STT_NOISE[cmd.replace(/[^a-z0-9]+/g, '')];   // "uh huh" -> "uhhuh", "thank you" -> "thankyou"
  }

  // ---- buttons ----------------------------------------------------------
  function updateCommandButtons() {
    commandbtns.forEach(function (btn) { btn.disabled = !playing; });
  }
  function updateButtons() {
    el('speaksub').textContent = !caps.tts ? 'No TTS' : (speaking ? 'Reading…' : (narrating ? 'On' : 'Off'));
    speakbtn.classList.toggle('on', narrating && caps.tts);
    speakbtn.disabled = !caps.tts;
    el('listensub').textContent = !caps.stt ? 'No STT' : (listening ? 'Listening' : 'Off');
    listenbtn.classList.toggle('on', listening);
    listenbtn.disabled = !caps.stt;
    stopbtn.disabled = !speaking && !speakQueue.length;
  }
  // pointerdown + preventDefault: tapping a control must never pull focus off the game.
  function wire(btn, fn) {
    if (!btn) return;
    btn.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function (e) { e.preventDefault(); fn(); });
  }
  commandbtns.forEach(function (btn) {
    wire(btn, function () {
      if (playing) sendCommand(btn.getAttribute('data-command'));
      focusGame();
    });
  });
  wire(speakbtn, function () { narrating = !narrating; if (!narrating) hush(); updateButtons(); note(narrating ? 'Reading new passages aloud.' : ''); focusGame(); });
  wire(listenbtn, function () { listening ? stopListening() : startListening(); focusGame(); });
  wire(stopbtn, function () { hush(); focusGame(); });
  // Stories: return to the picker. Reload with ?pick=1 so Parchment restarts clean (a story is already
  // running); the picker then always acts on a fresh, idle interpreter.
  wire(librarybtn, function () {
    hush();
    var u = new URL(location.href);
    u.searchParams.set('pick', '1');
    location.href = u.toString();
  });

  // ---- autosave to file (Tier 2: drive the game's own SAVE to a reserved slot, invisibly) ----
  // window.oqSaves comes from the interpreter's Bedrock Panel storage provider: begin(slot) is a one-shot
  // that makes the NEXT save/restore fileref resolve to a fixed on-disk slot with no file dialog; .game
  // is the exact key server.js stores under; .autoSlot is the reserved autosave filename. We arm it and
  // submit "save" as an ordinary command -- server.js then writes saves/<game>/<autoSlot>. SAVE is a
  // meta verb (no world turn), and we only fire while the story is idle at an empty prompt, so play is
  // untouched. If the provider isn't present (older build), everything here no-ops harmlessly.
  function oqSaves() { return window.oqSaves || null; }
  function flashNote(msg) { note(msg); setTimeout(function () { if (railnote.textContent === msg) note(''); }, 2500); }
  // Safe to inject a command only when the buffer window is waiting on an EMPTY line input: nothing
  // half-typed to clobber, no "[MORE]" pause (no line input shows during one), not a char/hyperlink
  // request (also no line input). So "LineInput present and empty" already screens all of those out.
  function idleForSave() {
    if (!playing || gameOver || suppressSave) return false;
    if (speaking || (audio && !audio.paused)) return false;     // don't inject mid-narration
    var i = document.querySelector('.BufferWindow .LineInput');
    return !!(i && !String(i.value || '').trim());
  }
  // Hide a still-visible ">save" input-echo line the live observer may have raced/missed. Exact-match
  // on OUR injected command only (never a fuzzy game-output match), so it can't eat real text.
  function hideCommandEcho(cmd) {
    var a = '>' + cmd, b = '> ' + cmd;
    [].forEach.call(document.querySelectorAll('.BufferWindow .BufferLine'), function (n) {
      if (n.style.display === 'none') return;
      var t = (n.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (t === a || t === b) { try { n.style.display = 'none'; } catch (e) {} }
    });
  }
  function doAutosave() {
    var s = oqSaves();
    if (!s || typeof s.begin !== 'function' || !s.autoSlot) return;
    if (Date.now() - lastAutosaveAt < AUTOSAVE_MS - 1500) return;   // at most once per interval, whatever the timer/poll does
    if (!idleForSave()) return;                                 // busy this tick -> catch the next interval
    suppressSave = true;
    try { s.begin(s.autoSlot); } catch (e) { suppressSave = false; return; }
    if (!sendCommand('save')) { suppressSave = false; return; }
    lastAutosaveAt = Date.now();
    // Un-suppress once the save turn has landed (echo + "Ok." hidden, prompt back). The timeout also
    // guarantees we never get stuck hiding output if a save somehow didn't complete.
    setTimeout(function () { suppressSave = false; hideCommandEcho('save'); flashNote('Autosaved.'); }, 900);
  }
  function startAutosave() {
    if (!WANT_AUTOSAVE || autosaveTimer) return;
    autosaveTimer = setInterval(doAutosave, AUTOSAVE_MS);
  }
  function doResume() {
    var s = oqSaves();
    if (!s || typeof s.begin !== 'function' || !s.autoSlot) return;
    restoreArtifactUntil = Date.now() + 1500;                   // hide only the replay artifact; keep the room description
    try { s.begin(s.autoSlot); } catch (e) { return; }
    sendCommand('restore');
  }
  // A small themed bar offering to resume the autosave, so a fresh start is still possible. Inline
  // styles only -- keeps this to app.js and off the shared style.css.
  function showResumeBar() {
    if (resumeBar) return;
    resumeBar = document.createElement('div');
    resumeBar.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:60;'
      + 'display:flex;gap:10px;align-items:center;padding:9px 14px;border-radius:11px;'
      + 'background:rgba(20,22,26,.94);color:#fff;font:14px/1.2 system-ui,-apple-system,sans-serif;'
      + 'box-shadow:0 6px 22px rgba(0,0,0,.45)';
    var label = document.createElement('span'); label.textContent = 'Resume where you left off?';
    var yes = document.createElement('button'); yes.type = 'button'; yes.textContent = 'Resume';
    var no = document.createElement('button'); no.type = 'button'; no.textContent = 'Start fresh';
    var bstyle = 'cursor:pointer;border:0;border-radius:7px;padding:6px 12px;font:600 13px system-ui,sans-serif';
    yes.style.cssText = bstyle + ';background:' + ACCENT + ';color:#0a0a0a';
    no.style.cssText = bstyle + ';background:rgba(255,255,255,.14);color:#fff';
    resumeBar.appendChild(label); resumeBar.appendChild(yes); resumeBar.appendChild(no);
    document.body.appendChild(resumeBar);
    var choose = function (resume) {
      if (!resumeBar) return;
      resumeBar.remove(); resumeBar = null;
      if (resume) doResume();
      startAutosave();
      focusGame();
    };
    yes.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    no.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    yes.addEventListener('click', function (e) { e.preventDefault(); choose(true); });
    no.addEventListener('click', function (e) { e.preventDefault(); choose(false); });
  }
  // On story load: if autosave is on and a saved slot already exists for this game, offer to resume;
  // otherwise just start the timer. Retries briefly while the provider's game/autoSlot settle post-load.
  function offerResume(tries) {
    if (!WANT_AUTOSAVE) return;                                 // feature off -> no autosave, no resume
    tries = tries || 0;
    var s = oqSaves();
    if (!s || !s.game || !s.autoSlot) {
      if (tries < 20) setTimeout(function () { offerResume(tries + 1); }, 150);
      return;                                                   // no provider -> autosave simply unavailable
    }
    fetch('/app-api/save-list?game=' + encodeURIComponent(s.game))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var has = j && j.ok && (j.slots || []).some(function (sl) { return sl.slot === s.autoSlot; });
        if (has) showResumeBar(); else startAutosave();
      })
      .catch(function () { startAutosave(); });
  }

  // ---- boot -------------------------------------------------------------
  fetch('/app-api/config').then(function (r) { return r.json(); }).then(function (j) {
    caps.tts = !!(j && j.tts); caps.stt = !!(j && j.stt);
    narrating = WANT_SPEAK && caps.tts;
    updateButtons();
    if (!caps.tts && WANT_SPEAK) note('Set a TTS server in Settings → TTS/STT to hear the story.');
    if (OPT_STORY) loadStory(OPT_STORY);
    else showPicker((j && j.stories) || [], j && j.folder);
  }).catch(function () {
    updateButtons();
    if (OPT_STORY) loadStory(OPT_STORY); else showPicker([], '');
  });

  window.addEventListener('focus', focusGame);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && playing) focusGame(); });

  // Physical-keyboard safety net: if focus is on our chrome rather than the game input, hand it back
  // and replay the character (deferred a tick -- GlkOte's focus setup can clear the field). Only fires
  // when focus is astray, so it never doubles native typing. See the earlier debugging notes.
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey || !playing) return;
    if (isTypingTarget()) return;              // a real field has focus (game input, SAVE dialog…) -> leave it
    var input = gameInput();
    if (!input) return;
    input.focus();
    if (e.key && e.key.length === 1) { e.preventDefault(); var ch = e.key; setTimeout(function () { try { input.value += ch; } catch (err) {} }, 0); }
  });
})();
