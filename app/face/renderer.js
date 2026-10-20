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

  const CARTOON_POSES = { neutral: [0, 0, 0, 0, 4.3], happy: [-5, 0, 0, -3, 4.3], sad: [1, 0.32, 0, 5, 4.3], angry: [3, -0.4, 0, 2, 3.8], surprised: [-6, 0, 0, -3, 5.5], sleepy: [3, 0, 0, 5, 4.3], thinking: [-5, 0.08, 5, -5, 4.3] };
  const KEYS = ['eyeW', 'eyeH', 'radius', 'browSlant', 'lowerLid', 'upperLid'];
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const number = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  function readableInk(color, background) {
    const rgb = value => /^#[\da-f]{6}$/i.test(value) ? [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) : null;
    const fg = rgb(color), bg = rgb(background);
    if (!fg || !bg) return color;
    const luminance = c => c.map(n => n / 255).map(n => n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4)).reduce((s, n, i) => s + n * [0.2126, 0.7152, 0.0722][i], 0);
    const b = luminance(bg), contrast = c => { const f = luminance(c); return (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05); };
    if (contrast(fg) >= 3) return color;
    let adjusted = fg.slice();
    for (let i = 0; i < 30 && contrast(adjusted) < 3; i++) adjusted = adjusted.map(n => b > 0.5 ? n * 0.9 : n + (255 - n) * 0.1);
    return '#' + adjusted.map(n => Math.round(n).toString(16).padStart(2, '0')).join('');
  }

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
      const cartoon = face().style === 'cartoon';
      const scale = cartoon ? Math.min(width / 136, height / 148) : Math.min(width / 164, height / 102);
      ctx.translate(width / 2, height / 2); ctx.scale(scale, scale);
      const f = face(), style = f.style || 'oled';
      const baseInk = f.color || accent;
      const ink = style === 'sprite' ? '#fffaf2' : style === 'oled' ? readableInk(baseInk, background) : baseInk;
      const cutout = style === 'crt' ? '#111c16' : background;
      ctx.fillStyle = ink; ctx.strokeStyle = ink;
      if (style === 'crt') {
        ctx.fillStyle = '#736f60'; round(-75, -45, 150, 91, 9);
        ctx.fillStyle = '#c8c0a7'; round(-73, -44, 146, 87, 8);
        ctx.fillStyle = '#4a4b3e'; round(-67, -38, 134, 73, 7);
        ctx.fillStyle = cutout; round(-64, -35, 128, 66, 6);
        ctx.fillStyle = '#75715e';
        for (let x = -50; x < -20; x += 4) round(x, 37, 2, 2, 0.5);
        ctx.fillStyle = ink; dot(59, 38, 1.3);
        ctx.fillStyle = '#827e6d'; round(-24, 45, 48, 3, 1);
        ctx.fillStyle = ink;
      }
      if (style === 'sprite') {
        ctx.fillStyle = f.color || '#272833'; ctx.strokeStyle = '#737684'; ctx.lineWidth = 0.8;
        ctx.beginPath();
        for (let i = 0; i < 80; i++) {
          const angle = i / 80 * Math.PI * 2;
          const radius = (i % 2 ? 43 : 47) + Math.sin(angle * 7) * 0.8;
          const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius * 0.92;
          if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        for (const side of [-1, 1]) {
          dot(side * 54, -14, 1.6); dot(side * 57, 7, 1.1); dot(side * 49, 29, 0.8);
        }
        ctx.fillStyle = ink; ctx.strokeStyle = ink;
      }
      if (style === 'cartoon') {
        // Flat cel shapes with a rigid shell; expression belongs to the brows and pupils.
        ctx.strokeStyle = '#593524'; ctx.lineWidth = 0.8; ctx.lineJoin = 'round';
        ctx.fillStyle = '#f2bd96';
        for (const side of [-1, 1]) {
          ctx.beginPath(); ctx.ellipse(side * 49, -8, 7, 12, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(side * 51, -13); ctx.quadraticCurveTo(side * 46, -15, side * 49, -3); ctx.stroke();
        }
        ctx.fillStyle = '#f5c49f';
        ctx.beginPath(); ctx.moveTo(-49, -49); ctx.quadraticCurveTo(-50, -59, -37, -59);
        ctx.lineTo(37, -59); ctx.quadraticCurveTo(50, -59, 49, -49); ctx.lineTo(46, 29);
        ctx.quadraticCurveTo(45, 51, 32, 53); ctx.quadraticCurveTo(0, 58, -32, 53);
        ctx.quadraticCurveTo(-45, 51, -46, 29); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#8c472d';
        ctx.beginPath(); ctx.moveTo(-49, -27); ctx.lineTo(-50, -49);
        ctx.quadraticCurveTo(-50, -64, -32, -64); ctx.lineTo(34, -64);
        ctx.quadraticCurveTo(51, -62, 50, -46); ctx.lineTo(49, -27);
        ctx.lineTo(43, -30); ctx.lineTo(42, -48); ctx.lineTo(23, -59);
        ctx.quadraticCurveTo(-4, -43, -39, -49); ctx.lineTo(-43, -29); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#b16a43';
        ctx.beginPath(); ctx.moveTo(-43, -53); ctx.quadraticCurveTo(-14, -44, 23, -57);
        ctx.lineTo(37, -53); ctx.quadraticCurveTo(0, -39, -43, -48); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#e2a17b';
        ctx.beginPath(); ctx.moveTo(-4, 4); ctx.quadraticCurveTo(7, 1, 7, 10);
        ctx.quadraticCurveTo(3, 16, -5, 11); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#b77b5a';
        for (const side of [-1, 1]) for (const point of [[33, 12], [38, 8], [41, 15]]) dot(side * point[0], point[1], 1.05);
        ctx.fillStyle = '#543828'; ctx.strokeStyle = '#543828';
      }
      const gap = clamp(number(f.eyeGap, 16), 0, 60);
      const [ew, eh, radius, slant, lower, upper] = current;
      const separation = cartoon ? 23 : (ew + gap) / 2;
      const speaking = state === 'speaking' && !asleep;
      const eyeY = cartoon ? -17 : -10 + gazeY;
      const pose = asleep ? 'sleepy' : state === 'thinking' ? 'thinking' : state === 'error' ? 'sad' : state === 'approval' ? 'surprised' : emotion;

      const [browY, browAngle, pupilX, pupilY, pupilRadius] = CARTOON_POSES[pose];
      const squash = asleep ? 0.08 : Math.max(0.08, 1 - blink);
      const eyeHeight = Math.max(2, (eh - upper - lower * 0.35) * squash);
      for (const side of [-1, 1]) {
        const cx = side * separation + (cartoon ? 0 : gazeX);
        ctx.save(); ctx.translate(cx, eyeY);
        if (style === 'sprite') {
          const w = Math.min(32, ew * 0.82), h = Math.max(2, eyeHeight * 0.9);
          ctx.fillStyle = '#fffaf2'; round(-w / 2, -h / 2, w, h, w / 2);
          if (h > 7) {
            ctx.fillStyle = '#161a23'; dot(gazeX * 0.3, state === 'thinking' ? -3 : 0, Math.min(5, h / 3));
            ctx.fillStyle = '#fffaf2'; dot(gazeX * 0.3 - 1, (state === 'thinking' ? -3 : 0) - 1.3, 1);
          }
          ctx.fillStyle = ink;
        } else if (style === 'cartoon') {
          ctx.fillStyle = '#fffaf1'; dot(0, 0, 14.5);
          ctx.strokeStyle = '#593524'; ctx.lineWidth = 0.8; ctx.stroke();
          const px = clamp(pupilX + gazeX * 0.65, -6, 6), py = clamp(pupilY + gazeY * 0.65, -6, 6);
          ctx.fillStyle = '#355479'; dot(px, py, pupilRadius);
          ctx.fillStyle = '#172b43'; dot(px, py, pupilRadius * 0.51);
          ctx.fillStyle = '#fffaf1'; dot(px - 1.2, py - 1.4, 1);
          ctx.fillStyle = '#543828';
          ctx.save(); ctx.translate(0, Math.max(-25, -21 + browY + (pose === 'thinking' && side === 1 ? 8 : 0)));
          ctx.rotate(side * browAngle); ctx.strokeStyle = '#422719'; ctx.lineWidth = 3.1; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(-11, 0); ctx.quadraticCurveTo(0, pose === 'happy' || pose === 'surprised' ? -5 : -1.5, 11, 0); ctx.stroke(); ctx.restore();
          ctx.fillStyle = ink;
        } else {
          ctx.rotate(side * slant / 120);
          round(-ew / 2, -eyeHeight / 2, ew, eyeHeight, style === 'kawaii' ? ew / 2 : radius);
          if (style === 'kawaii') {
            ctx.save(); ctx.strokeStyle = '#a23b67'; ctx.lineWidth = 0.65;
            ctx.beginPath(); ctx.roundRect(-ew / 2, -eyeHeight / 2, ew, eyeHeight, ew / 2); ctx.stroke(); ctx.restore();
          }
          if (eyeHeight > 10 && !asleep) {
            ctx.fillStyle = style === 'kawaii' ? '#fffaf6' : cutout;
            if (style === 'kawaii') {
              dot(-ew * 0.15, -eyeHeight * 0.18, ew * 0.13);
              dot(ew * 0.19, eyeHeight * 0.18, ew * 0.065);
            } else round(-ew * 0.24, -eyeHeight * 0.27, ew * 0.2, 3, 1.5);
            ctx.fillStyle = ink;
          }
          if (emotion === 'happy' && !asleep && blink < 0.3) {
            ctx.fillStyle = cutout;
            ctx.beginPath(); ctx.ellipse(0, eyeHeight * 0.7, ew * 0.62, eyeHeight * 0.5, 0, Math.PI, Math.PI * 2); ctx.fill();
            ctx.fillStyle = ink;
          }
        }
        ctx.restore();
      }
      if (style === 'kawaii' && emotion === 'angry' && !asleep) {
        for (const side of [-1, 1]) {
          const x = side * separation + gazeX, y = eyeY - eyeHeight / 2 - 6;
          line(x - 12, y + side * 4, x + 12, y - side * 4, 2.8);
        }
      }
      if (!cartoon && (emotion === 'sad' || state === 'error') && !asleep) {
        const x = separation + ew * 0.37 + gazeX, y = eyeY + eyeHeight * 0.35;
        ctx.save(); ctx.fillStyle = style === 'cartoon' ? '#7aaacc' : ink;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x - 6, y + 8, x, y + 9);
        ctx.quadraticCurveTo(x + 6, y + 8, x, y); ctx.fill(); ctx.restore();
      }
      if (style === 'kawaii' && !asleep) {
        ctx.save(); ctx.globalAlpha = 0.82; ctx.fillStyle = f.cheekColor || '#f49ab9';
        for (const side of [-1, 1]) { ctx.beginPath(); ctx.ellipse(side * (separation + ew * 0.47), 8, 7, 3.5, -side * 0.15, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
      }
      const mouthY = 22;
      const mouthEmotion = state === 'error' ? 'sad' : state === 'approval' ? 'surprised' : emotion;
      if (cartoon) {
        ctx.save();
        // Keep the entire tooth grille fixed, including in silence, sleep and surprise.
        const lit = speaking && smoothLevel > 0.015;
        ctx.fillStyle = lit ? '#7cfc3a' : '#fffaf1';
        ctx.beginPath(); ctx.moveTo(-31, 25); ctx.quadraticCurveTo(0, 28, 31, 25);
        ctx.quadraticCurveTo(34, 25, 32, 29); ctx.lineTo(28, 40); ctx.quadraticCurveTo(27, 43, 23, 43);
        ctx.lineTo(-23, 43); ctx.quadraticCurveTo(-27, 43, -28, 40); ctx.lineTo(-32, 29);
        ctx.quadraticCurveTo(-34, 25, -31, 25); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#593524'; ctx.lineWidth = 0.8; ctx.stroke();
        if (lit) {
          ctx.fillStyle = '#c2ff85'; ctx.beginPath(); ctx.moveTo(-27, 25.5); ctx.quadraticCurveTo(0, 30, 27, 25.5);
          ctx.lineTo(25.8, 29); ctx.quadraticCurveTo(0, 33, -25.8, 29); ctx.closePath(); ctx.fill();
        }
        ctx.strokeStyle = '#995b46';
        for (const x of [-18, -6, 6, 18]) line(x, 29, x * 0.88, 40, 0.65);
        ctx.restore();
      } else if (speaking && smoothLevel > 0.015) {
        const h = 3 + Math.min(style === 'sprite' ? 12 : 20, smoothLevel * 27), w = style === 'sprite' ? 10 : style === 'kawaii' ? 13 : 23;
        round(-w / 2, mouthY - h / 2, w, h, h / 2);
      } else if (style === 'sprite') {
        if (mouthEmotion === 'surprised') dot(0, mouthY, 3);
        else if (mouthEmotion === 'happy') {
          ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, mouthY - 1, 4, 0, Math.PI); ctx.stroke();
        } else round(-3, mouthY, 6, 1.5, 0.75);
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
        ctx.save(); if (style === 'cartoon') ctx.fillStyle = readableInk('#b8c8d8', background);
        for (let i = 0; i < 3; i++) {
          ctx.globalAlpha = reduced ? 0.65 : 0.25 + 0.75 * ((Math.sin(time / 230 - i * 0.9) + 1) / 2);
          dot(-7 + i * 7, style === 'cartoon' ? 62 : style === 'crt' ? 28 : 42, 1.8);
        }
        ctx.restore();
      }
      if (state === 'listening' && !asleep) {
        ctx.globalAlpha = 0.6; round(-14, cartoon ? 65 : style === 'crt' ? 28 : 40, 28, 1.5, 0.75); ctx.globalAlpha = 1;
      }
      if (asleep) {
        ctx.save(); ctx.globalAlpha = 0.65; ctx.font = '600 8px Segoe UI, sans-serif';
        if (style === 'cartoon') ctx.fillStyle = readableInk('#b8c8d8', background);
        ctx.fillText('z', 48, -24); ctx.font = '600 11px Segoe UI, sans-serif'; ctx.fillText('z', 56, -32); ctx.restore();
      }
      if (state === 'error') {
        ctx.save(); ctx.strokeStyle = ink; line(56, -29, 56, -20, 2.5); dot(56, -15, 1.4); ctx.restore();
      }
      if (state === 'approval') {
        ctx.save(); ctx.font = '600 16px Segoe UI, sans-serif'; ctx.fillText('?', 51, -17); ctx.restore();
      }
      if (style === 'crt') {
        ctx.save(); ctx.strokeStyle = cutout; ctx.globalAlpha = 0.18; ctx.lineWidth = 0.5;
        for (let y = -33; y < 31; y += 3) line(-62, y, 62, y, 0.5);
        ctx.restore();
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
