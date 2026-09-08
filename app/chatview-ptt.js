    // ---- push-to-talk: panel relays the knob HOLD here (window.pttStart / window.pttStop).
    // Record the mic while held -> POST to OWUI's local-Whisper transcription -> fill the input + send.
    (function () {
      var cfg = window.bedrockChatRuntimeConfig || {};
      var key = cfg.apiKey || '';
      var sttUrl = '';
      try { sttUrl = new URL(cfg.endpoint).origin + '/api/v1/audio/transcriptions'; } catch (e) {}
      var rec = null, chunks = [], stream = null, recording = false, cue = null;

      function showCue(on) {
        if (!cue) {
          cue = document.createElement('div'); cue.textContent = '🎤 listening…';
          cue.style.cssText = 'position:absolute;top:14px;right:18px;background:#16202e;color:#7CFFB2;padding:7px 16px;border-radius:20px;font:700 17px "Segoe UI";z-index:40;display:none';
          document.body.appendChild(cue);
        }
        cue.textContent = (on === 'work') ? '… transcribing' : '🎤 listening…';
        cue.style.display = on ? 'block' : 'none';
      }

      async function getMic() {
        if (stream) return stream;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });   // unlocks device labels
        try {
          var devs = await navigator.mediaDevices.enumerateDevices();
          var pnp = devs.find(function (d) { return d.kind === 'audioinput' && /pnp|usb pnp|usb audio/i.test(d.label); });
          if (pnp && stream.getAudioTracks()[0].getSettings().deviceId !== pnp.deviceId) {
            stream.getTracks().forEach(function (t) { t.stop(); });
            stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: pnp.deviceId } } });
          }
        } catch (e) {}
        return stream;
      }

      window.pttStart = async function () {
        if (recording || !sttUrl || !key) return;
        try {
          var s = await getMic();
          chunks = []; rec = new MediaRecorder(s);
          rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
          rec.onstop = function () { showCue('work'); transcribe(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })); };
          rec.start(); recording = true; showCue(true);
        } catch (e) { console.log('ptt start:', e.message); }
      };
      window.pttStop = function () {
        if (!recording) return; recording = false;
        try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) {}
      };

      async function transcribe(blob) {
        if (!blob || blob.size < 1200) { showCue(false); return; }   // ignore accidental taps
        try {
          var fd = new FormData(); fd.append('file', blob, 'speech.webm');
          var r = await fetch(sttUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd });
          var data = await r.json();
          var text = (data && (data.text || data.transcript || '')) || '';
          if (text.trim()) fillAndSend(text.trim());
        } catch (e) { console.log('stt:', e.message); }
        finally { showCue(false); }
      }

      function fillAndSend(text) {
        var ta = document.querySelector('textarea'); if (!ta) return;
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, text);                                   // set value + fire input so Svelte's bind picks it up
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
        setTimeout(function () { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, 70);
      }
    })();
