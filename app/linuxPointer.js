'use strict';
/*
 * linuxPointer.js — the pure half of the Linux pointer backend: desktop pixels in, virtual-device
 * numbers out. No device, no process, so it tests on any platform.
 *
 * The virtual pointer reports an absolute position on a fixed 0..ABS_MAX scale, and the compositor
 * stretches that scale across the whole desktop — the bounding box of every display, not one screen.
 * So a screen pixel only means something here once it is expressed as a fraction of that box, which
 * is what toAbsolute does. Monitor mode already works in global screen coordinates, so the box is
 * the only extra thing the backend needs to know.
 */

// BTN_LEFT / BTN_RIGHT / BTN_MIDDLE from linux/input-event-codes.h. The helper accepts these three
// and nothing else, so a bad name here cannot become an undeclared event code there.
const BUTTON = { left: 0x110, right: 0x111, middle: 0x112 };
const ABS_MAX = 65535;

// One wheel notch, in the units main.js passes to scroll(). It is Windows' WHEEL_DELTA, which is
// what the robotjs backend has always been given; evdev counts whole notches instead.
const WHEEL_DELTA = 120;

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** The bounding box of every display, which is the area the absolute scale is stretched across. */
function unionBounds(displays) {
  const rects = (displays || []).map(d => (d && d.bounds) || d).filter(b => b && b.width > 0 && b.height > 0);
  if (!rects.length) return null;
  const left = Math.min(...rects.map(b => b.x));
  const top = Math.min(...rects.map(b => b.y));
  const right = Math.max(...rects.map(b => b.x + b.width));
  const bottom = Math.max(...rects.map(b => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * A global screen pixel as the absolute pair the device reports. Null when the bounds are unusable,
 * so the caller can decline rather than send a meaningless position.
 *
 * Plain proportional rounding, which was worth checking rather than assuming: a half-pixel offset
 * would be right if the compositor truncated when mapping the value back, and it does not. Measured
 * against KWin's own cursor position, both formulas over a spread of pixels on both displays — this
 * one lands on the intended pixel every time and the offset one overshoots by one.
 */
function toAbsolute(x, y, bounds) {
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const scale = (v, origin, size) => clamp(Math.round((v - origin) * ABS_MAX / size), 0, ABS_MAX);
  return { ax: scale(x, bounds.x, bounds.width), ay: scale(y, bounds.y, bounds.height) };
}

/** The wheel movement as whole notches. A small non-zero scroll still moves one, never nothing. */
function toNotches(dy) {
  if (!Number.isFinite(dy) || dy === 0) return 0;
  const n = Math.round(dy / WHEEL_DELTA);
  return n === 0 ? (dy > 0 ? 1 : -1) : n;
}

/** The event code for a button name, defaulting to left the way the robotjs backend does. */
function buttonCode(name) {
  return BUTTON[String(name || 'left').toLowerCase()] || null;
}

module.exports = { BUTTON, ABS_MAX, WHEEL_DELTA, unionBounds, toAbsolute, toNotches, buttonCode };
