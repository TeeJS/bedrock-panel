'use strict';
// Hidden LucidType capture renderer. On a 'start' command it runs the shared energy VAD
// (window.createClaudeVoiceVAD) over the selected mic and streams each trimmed utterance's Int16 PCM
// to main via the preload bridge; on 'stop' it tears the VAD down. Also plays the start/stop beep.
// It reports what it opened and whether it hears anything, so a dictation that produces no text
// says why (main shows it on the LucidType page) instead of failing silently.
(function () {
  var api = window.lucidDictate;
  var log = function (m) { try { api.log('[dictate] ' + m); } catch (e) {} };
  var status = function (st) { try { api.status(st); } catch (e) {} };
  var HEARING_CHECK_MS = 8000;   // how long to listen before saying "nothing heard yet"
  var vad = null;
  var running = false;
  var stats = null;              // this session: { frames, peak, sent } -- level callbacks, loudest RMS, clips shipped
  var hearingTimer = null;

  // Map a saved mic *label* (LucidType stores labels, like the Meeting picker) to a deviceId. Labels
  // are only populated after a getUserMedia grant, so unlock once, enumerate, then match.
  function resolveDeviceId(label) {
    if (!label) return Promise.resolve('');
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (tmp) {
      tmp.getTracks().forEach(function (t) { t.stop(); });
      return navigator.mediaDevices.enumerateDevices().then(function (list) {
        var m = list.find(function (d) { return d.kind === 'audioinput' && d.label === label; });
        return m ? m.deviceId : '';
      });
    }).catch(function () { return ''; });
  }

  function beep(freq) {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = freq; osc.type = 'sine';
      gain.gain.value = 0.08;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      setTimeout(function () { try { osc.stop(); ctx.close(); } catch (e) {} }, 120);
    } catch (e) {}
  }

  // No level callbacks at all = the audio graph isn't running; callbacks but nothing ever reaching the
  // speech threshold = the mic is muted, too quiet, or not the one being spoken into.
  function checkHearing() {
    if (!running || !vad || !stats || stats.sent) return;
    var info = vad.info();
    if (!stats.frames) status({ type: 'no-audio', mic: info.label, context: info.state });
    else if (stats.peak < info.threshold) status({ type: 'silent', mic: info.label, peak: stats.peak });
  }

  function startCapture(msg) {
    if (running) return;
    running = true;
    if (msg.beep) beep(800);
    stats = { frames: 0, peak: 0, sent: 0 };
    var wanted = msg.micDevice || '';
    var mine = vad = window.createClaudeVoiceVAD({ hangoverMs: msg.silenceMs || 400 });
    resolveDeviceId(wanted).then(function (id) {
      if (!running || vad !== mine) return;   // a stop raced in during device resolution
      mine.setInputDevice(id);
      return mine.start(
        function () {},                                  // onSpeechStart — nothing to do here
        function (int16) {                               // onSpeechEnd — ship the utterance to main
          stats.sent++;
          try { api.sendPcm(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)); }
          catch (e) { log('sendPcm failed: ' + e.message); }
        },
        function (level) { stats.frames++; if (level > stats.peak) stats.peak = level; }
      ).then(function () {
        if (!running || vad !== mine) return;
        var info = mine.info();
        status({ type: 'started', mic: info.label, wanted: wanted, matched: !wanted || !!id, context: info.state, rate: info.sampleRate });
        clearTimeout(hearingTimer);
        hearingTimer = setTimeout(checkHearing, HEARING_CHECK_MS);
      });
    }).catch(function (e) {
      if (vad !== mine) return;
      running = false;
      try { mine.stop(); } catch (er) {}   // release anything start() opened before it failed
      var message = (e && (e.message || e.name)) || String(e);
      log('vad.start failed: ' + message);
      status({ type: 'error', message: message });
    });
  }

  function stopCapture(msg) {
    if (!running) return;
    running = false;
    clearTimeout(hearingTimer);
    var info = vad ? vad.info() : null;
    if (stats && info) {
      log('stopped: ' + stats.sent + ' clip(s) sent, ' + stats.frames + ' audio buffers, loudest level ' +
        stats.peak.toFixed(3) + ' (speech starts at ' + info.threshold + ')');
    }
    try { if (vad) vad.stop(); } catch (e) {}
    vad = null;
    if (msg && msg.beep) beep(400);
  }

  api.onCommand(function (msg) {
    if (!msg) return;
    if (msg.type === 'start') startCapture(msg);
    else if (msg.type === 'stop') stopCapture(msg);
  });
  log('ready');
})();
