// ============================================================================
// meter.js — the Chill-o-meter: the FilmyChill Score's visual mark.
//
// A five-zone dial in the "Indigo sunset" palette (brand indigo warming through to brand
// marigold) with an ink needle: far right = Must watch, upper right = Worth a watch,
// far left = Skip. "Too early" is the same dial greyed out with no needle.
//
// One source for every surface: the homepage sprite (index.html <symbol id="fcm-…">, kept
// identical to meterSymbols() by a test), film pages and share cards (inline, via
// meterInner()). All geometry sits in a 32×32 viewBox; plain strokes only, so it renders
// the same in browsers and in resvg (share cards).
// ============================================================================
"use strict";

const METER_ZONES = ["#4038C7", "#7B4FC4", "#C4589E", "#F2855A", "#FFAD1F"]; // cool → hot
const METER_EARLY = "#E6E0D2";
const METER_INK = "#241D52";
const NEEDLE_DEG = { must: 165, worth: 112, skip: 18 };

const r2 = (n) => Math.round(n * 100) / 100;

function arcs(colors) {
  return colors.map((c, i) => {
    const a0 = Math.PI + (i / 5) * Math.PI + 0.05;
    const a1 = Math.PI + ((i + 1) / 5) * Math.PI - 0.05;
    return `<path d="M${r2(16 + Math.cos(a0) * 11)} ${r2(21 + Math.sin(a0) * 11)} A11 11 0 0 1 ${r2(16 + Math.cos(a1) * 11)} ${r2(21 + Math.sin(a1) * 11)}" fill="none" stroke="${c}" stroke-width="5"/>`;
  }).join("");
}

// Level from a FilmyChill Score verdict (or null / "early" for no score).
function meterLevel(verdict) {
  if (!verdict) return "early";
  if (/^must/i.test(verdict)) return "must";
  if (/^skip/i.test(verdict)) return "skip";
  if (/^worth/i.test(verdict)) return "worth";
  return "early";
}

// The drawing, without the outer <svg>: for a 32×32 viewBox. `ink` is the needle colour:
// brand ink on light surfaces, cream on the dark share cards (ink would vanish there).
function meterInner(level, { ink = METER_INK } = {}) {
  if (!NEEDLE_DEG[level]) {
    return arcs(Array(5).fill(METER_EARLY)) + `<circle cx="16" cy="21" r="2.6" fill="#B8B2C8"/>`;
  }
  const a = ((180 + NEEDLE_DEG[level]) * Math.PI) / 180;
  return arcs(METER_ZONES) +
    `<line x1="16" y1="21" x2="${r2(16 + Math.cos(a) * 9.5)}" y2="${r2(21 + Math.sin(a) * 9.5)}" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/>` +
    `<circle cx="16" cy="21" r="2.6" fill="${ink}"/>`;
}

// A standalone inline SVG (film pages). The dial occupies y≈7.5–23.6 of the viewBox, so
// the viewBox is cropped to that band: the icon then aligns to text by its real edges.
function meterSvg(level, { size = 24, cls = "fcm" } = {}) {
  const h = Math.round((size * 17) / 27);
  return `<svg class="${cls}" width="${size}" height="${h}" viewBox="2.5 7 27 17" aria-hidden="true">${meterInner(level)}</svg>`;
}

// The homepage sprite entries (index.html), same cropped viewBox.
function meterSymbols() {
  return ["must", "worth", "skip", "early"]
    .map((l) => `<symbol id="fcm-${l}" viewBox="2.5 7 27 17">${meterInner(l)}</symbol>`).join("");
}

module.exports = { METER_ZONES, meterInner, meterLevel, meterSvg, meterSymbols };
