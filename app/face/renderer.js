(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OqxFace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PRESETS = {
    neutral: [34, 34, 12, 0, 0, 0], happy: [36, 36, 12, 0, 16, 0],
    sad: [32, 26, 10, -9, 0, 4], angry: [34, 24, 8, 10, 0, 0],
    surprised: [38, 44, 19, 0, 0, 0], sleepy: [34, 26, 10, 0, 0, 14],
    thinking: [30, 30, 11, 0, 0, 5],
  };
  const KEYS = ['eyeW', 'eyeH', 'radius', 'browSlant', 'lowerLid', 'upperLid'];
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const number = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;

  function create(canvas, options) {
    if (!canvas || !canvas.getContext) throw new TypeError('A face needs a canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas rendering is unavailable');
    options = options || {};
    const env = options.environment || (typeof window !== 'undefined' ? window : globalThis);
    const clock = () => env.performance ? env.performance.now() : Date.now();
    const raf = cb => env.requestAnimationFrame(cb);
    const caf = id => env.cancelAnimationFrame(id);
    let persona = options.persona || null;
    let accent = options.accent || '#7cffb2';
    let background = options.background || '#05080d';
    let reduced = !!options.reducedMotion;
    let state = 'idle', emotion = 'neutral', level = 0, smoothLevel = 0;
    let active = false, disposed = false, handle = null, asleep = false;
    let lastActivity = clock(), lastFrame = -Infinity, lastTick = clock();
    let nextBlink = clock() + 2800, blinkStart = -Infinity;
    let nextGaze = clock() + 2400, gazeX = 0, gazeY = 0, targetX = 0, targetY = 0;
    let current = PRESETS.neutral.slice();
    let width = 1, height = 1, dpr = 1;

    function face() { return (persona && persona.face) || {}; }
    function preset(name) {
      const base = PRESETS[name] || PRESETS.neutral;
      const custom = (face().emotions || {})[name] || {};
      return KEYS.map((key, i) => number(custom[key], base[i]));
    }
    function request() { if (active && !disposed && handle === null) handle = raf(frame); }
    function wake() {
      if (disposed) return;
      lastActivity = clock(); asleep = false; request();
    }
    function round(x, y, w, h, radius) {
      if (w <= 0 || h <= 0) return;
      const r = Math.max(0, Math.min(radius, w / 2, h / 2));
      ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
    }
    function line(x1, y1, x2, y2, size) {
      ctx.lineWidth = size; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    function dot(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }

    function draw(time, blink) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
      const scale = Math.min(width / 164, height / 102);
      ctx.translate(width / 2, height / 2); ctx.scale(scale, scale);
      const f = face(), style = f.style || 'oled';
      const ink = f.color || accent;
      ctx.fillStyle = ink; ctx.strokeStyle = ink;
      if (style === 'cartoon') {
        // Norm's friendly, human-looking face follows the supplied character reference.
        ctx.fillStyle = '#f5c49f'; round(-63, -45, 126, 87, 23);
        ctx.fillStyle = '#653f28';
        ctx.beginPath(); ctx.moveTo(-62, -12); ctx.lineTo(-63, -34);
        ctx.quadraticCurveTo(-63, -49, -40, -49); ctx.lineTo(43, -49);
        ctx.quadraticCurveTo(64, -47, 63, -30); ctx.lineTo(62, -11);
        ctx.lineTo(55, -15); ctx.lineTo(53, -34); ctx.lineTo(28, -39);
        ctx.quadraticCurveTo(-5, -23, -49, -29); ctx.lineTo(-53, -13); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#d99676';
        ctx.beginPath(); ctx.ellipse(0, 7, 7, 4.5, 0, 0, Math.PI * 2); ctx.fill();
        for (const side of [-1, 1]) for (const point of [[43, 9], [48, 5], [51, 12]]) dot(side * point[0], point[1], 1.05);
        ctx.fillStyle = '#543828'; ctx.strokeStyle = '#543828';
      }
      const gap = clamp(number(f.eyeGap, 16), 0, 60);
      const [ew, eh, radius, slant, lower, upper] = current;
      const separation = (ew + gap) / 2;
      const speaking = state === 'speaking' && !asleep;
      const eyeY = -10 + gazeY;
      const squash = asleep ? 0.08 : Math.max(0.08, 1 - blink);
      const eyeHeight = Math.max(2, (eh - upper - lower * 0.35) * squash);
      for (const side of [-1, 1]) {
        const cx = side * separation + gazeX;
        ctx.save(); ctx.translate(cx, eyeY);
        if (style === 'cartoon') {
          const w = Math.min(29, ew * 0.82), h = Math.max(2, Math.min(29, eyeHeight));
          ctx.fillStyle = '#fffaf1'; round(-w / 2, -h / 2, w, h, w / 2);
          ctx.fillStyle = '#355479';
          if (h > 6) dot(gazeX * 0.35, (state === 'thinking' ? -3 : 0), Math.min(4.3, h / 3));
          ctx.fillStyle = '#543828';
          if (h > 6) dot(gazeX * 0.35, (state === 'thinking' ? -3 : 0), Math.min(2.2, h / 5));
          ctx.save(); ctx.translate(0, -17);
          ctx.rotate(side * (slant / 90)); round(-13, -1.3, 26, 2.6, 1.3); ctx.restore();
          ctx.fillStyle = ink;
        } else {
          ctx.rotate(side * slant / 120);
          round(-ew / 2, -eyeHeight / 2, ew, eyeHeight, style === 'kawaii' ? ew / 2 : radius);
          if (style === 'kawaii') {
            ctx.save(); ctx.strokeStyle = '#a23b67'; ctx.lineWidth = 0.65;
            ctx.beginPath(); ctx.roundRect(-ew / 2, -eyeHeight / 2, ew, eyeHeight, ew / 2); ctx.stroke(); ctx.restore();
          }
          if (eyeHeight > 10 && !asleep) {
            ctx.fillStyle = style === 'kawaii' ? '#fffaf6' : background;
            if (style === 'kawaii') {
              dot(-ew * 0.15, -eyeHeight * 0.18, ew * 0.13);
              dot(ew * 0.19, eyeHeight * 0.18, ew * 0.065);
            } else round(-ew * 0.24, -eyeHeight * 0.27, ew * 0.2, 3, 1.5);
            ctx.fillStyle = ink;
          }
          if (emotion === 'happy' && !asleep && blink < 0.3) {
            ctx.fillStyle = background;
            ctx.beginPath(); ctx.ellipse(0, eyeHeight * 0.7, ew * 0.62, eyeHeight * 0.5, 0, Math.PI, Math.PI * 2); ctx.fill();
            ctx.fillStyle = ink;
          }
        }
        ctx.restore();
      }
      if (style === 'kawaii' && !asleep) {
        ctx.save(); ctx.globalAlpha = 0.82; ctx.fillStyle = f.cheekColor || '#f49ab9';
        for (const side of [-1, 1]) { ctx.beginPath(); ctx.ellipse(side * (separation + ew * 0.47), 8, 7, 3.5, -side * 0.15, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
      }
      const mouthY = 22;
      const mouthEmotion = state === 'error' ? 'sad' : state === 'approval' ? 'surprised' : emotion;
      if (speaking && smoothLevel > 0.015) {
        const h = 3 + Math.min(20, smoothLevel * 27), w = style === 'cartoon' ? 45 : style === 'kawaii' ? 13 : 23;
        if (style === 'cartoon') ctx.fillStyle = '#613b34';
        round(-w / 2, mouthY - h / 2, w, h, style === 'cartoon' ? 5 : h / 2);
        if (style === 'cartoon' && h > 8) {
          ctx.fillStyle = '#fffaf1'; round(-20, mouthY - h / 2 + 1, 40, 4, 2);
        }
        ctx.fillStyle = ink;
      } else if (style === 'cartoon') {
        if (asleep || mouthEmotion === 'sad' || mouthEmotion === 'angry') {
          ctx.strokeStyle = '#995b46'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-17, 26);
          ctx.quadraticCurveTo(0, mouthEmotion === 'sad' ? 15 : 24, 17, 26); ctx.stroke();
        } else if (mouthEmotion === 'surprised') {
          ctx.fillStyle = '#613b34'; ctx.beginPath(); ctx.ellipse(0, mouthY, 8, 10, 0, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillStyle = '#fffaf1';
          ctx.beginPath(); ctx.moveTo(-26, 17); ctx.quadraticCurveTo(0, 22, 26, 17);
          ctx.quadraticCurveTo(21, 34, 0, 34); ctx.quadraticCurveTo(-21, 34, -26, 17); ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = ink;
        ctx.strokeStyle = ink;
      } else if (style === 'kawaii') {
        ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.beginPath();
        if (mouthEmotion === 'sad' || mouthEmotion === 'angry') {
          ctx.moveTo(-7, mouthY + 3); ctx.quadraticCurveTo(0, mouthY - 3, 7, mouthY + 3);
        } else {
          ctx.moveTo(-8, mouthY); ctx.quadraticCurveTo(-4, mouthY + 7, 0, mouthY + 2);
          ctx.quadraticCurveTo(4, mouthY + 7, 8, mouthY);
        }
        ctx.stroke();
      } else if (emotion === 'surprised' && !asleep) {
        ctx.beginPath(); ctx.ellipse(0, mouthY, 5, 7, 0, 0, Math.PI * 2); ctx.fill();
      } else round(-8, mouthY, 16, 2.5, 1.25);

      if (state === 'thinking' && !asleep) {
        for (let i = 0; i < 3; i++) {
          ctx.globalAlpha = reduced ? 0.65 : 0.25 + 0.75 * ((Math.sin(time / 230 - i * 0.9) + 1) / 2);
          dot(-7 + i * 7, 42, 1.8);
        }
        ctx.globalAlpha = 1;
      }
      if (state === 'listening' && !asleep) {
        ctx.globalAlpha = 0.6; round(-14, 40, 28, 1.5, 0.75); ctx.globalAlpha = 1;
      }
      if (asleep) {
        ctx.save(); ctx.globalAlpha = 0.65; ctx.font = '600 8px Segoe UI, sans-serif';
        ctx.fillText('z', 48, -24); ctx.font = '600 11px Segoe UI, sans-serif'; ctx.fillText('z', 56, -32); ctx.restore();
      }
      if (state === 'error') {
        ctx.save(); ctx.strokeStyle = ink; line(56, -29, 56, -20, 2.5); dot(56, -15, 1.4); ctx.restore();
      }
      if (state === 'approval') {
        ctx.save(); ctx.font = '600 16px Segoe UI, sans-serif'; ctx.fillText('?', 51, -17); ctx.restore();
      }
    }

    function frame(time) {
      handle = null;
      if (!active || disposed) return;
      if (time - lastFrame < 32) { request(); return; }
      const dt = Math.min(100, Math.max(1, time - lastTick)); lastTick = time; lastFrame = time;
      const doze = number(face().dozeAfterSeconds, 60);
      asleep = state === 'sleepy' || (state === 'idle' && doze > 0 && time - lastActivity >= doze * 1000);
      const targetName = asleep ? 'sleepy' : state === 'thinking' ? 'thinking' : state === 'error' ? 'sad' : state === 'approval' ? 'surprised' : emotion;
      const target = preset(targetName);
      const ease = reduced ? 1 : 1 - Math.exp(-dt / 105);
      current = current.map((value, i) => value + (target[i] - value) * ease);
      const volume = state === 'speaking' ? level : 0;
      smoothLevel += (volume - smoothLevel) * (volume > smoothLevel ? 0.65 : 0.3);
      if (!reduced && !asleep) {
        if (time >= nextBlink && state !== 'error' && state !== 'approval') {
          blinkStart = time;
          const min = Math.max(300, number(face().blinkMinMs, 2200));
          nextBlink = time + min + Math.random() * Math.max(0, number(face().blinkMaxMs, 6000) - min);
        }
        if (time >= nextGaze) {
          targetX = state === 'listening' ? 0 : (Math.random() - 0.5) * 7;
          targetY = state === 'listening' ? 0 : (Math.random() - 0.5) * 3;
          nextGaze = time + 2400 + Math.random() * 3600;
        }
      } else { targetX = 0; targetY = 0; }
      gazeX += (targetX - gazeX) * 0.09; gazeY += (targetY - gazeY) * 0.09;
      const blinkAge = time - blinkStart;
      const blink = reduced || blinkAge > 180 ? 0 : Math.sin(clamp(blinkAge / 180, 0, 1) * Math.PI);
      if (asleep || reduced) current = target.slice();
      draw(time, blink);
      // A dozing face is static: no frame loop remains until real activity wakes it.
      if (!asleep) request();
    }

    function resize() {
      if (disposed) return;
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width || canvas.clientWidth || 1);
      height = Math.max(1, rect.height || canvas.clientHeight || 1);
      dpr = clamp(number(env.devicePixelRatio, 1), 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      draw(clock(), 0);
    }
    resize();
    return {
      setPersona(value) { persona = value || null; current = preset(emotion); wake(); resize(); },
      setState(value) {
        if (disposed) return;
        const next = typeof value === 'string' ? value : (value && value.status) || 'idle';
        if (next !== state) { state = next; if (next !== 'speaking') { level = 0; smoothLevel = 0; } wake(); }
      },
      setEmotion(value) { const next = PRESETS[value] ? value : 'neutral'; if (next !== emotion) { emotion = next; wake(); } },
      setLevel(value) { level = clamp(number(value, 0), 0, 1); if (state === 'speaking') request(); },
      setTheme(value) { if (value) { accent = value.accent || accent; background = value.background || background; } resize(); },
      setReducedMotion(value) { reduced = !!value; request(); },
      wake, resize,
      start() { if (disposed) return; active = true; lastTick = clock(); request(); },
      stop() { active = false; if (handle !== null) caf(handle); handle = null; level = 0; smoothLevel = 0; },
      destroy() { active = false; disposed = true; if (handle !== null) caf(handle); handle = null; ctx.clearRect(0, 0, canvas.width, canvas.height); },
    };
  }
  return { create };
});
