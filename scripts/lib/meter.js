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

const { escHtml } = require("./core.js");
const { FEW_VOTES } = require("./score.js");
const { noScoreText } = require("./fcscore.js");

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

// ---- Verdict pills and audience-rating dials (Oct 2026 redesign) ----
// The verdict as a coloured pill, one colour set on every surface (homepage cards, the language
// hubs, /new-on-ott/). The homepage's client twin is verdictPill() in js/app.js.
// The pill shape of the 28 Oct 2026 redesign (round, outlined "Skip"), the same on the homepage,
// the hubs and the weekly page.
const VPILL_CSS = ".vpill { display:inline-block; padding:4px 9px; border-radius:999px; font-size:12px; font-weight:800; line-height:1.3; white-space:nowrap; }"
  + " .vp-must { background:#1E7A4C; color:#FFFFFF; } .vp-worth { background:#FFAD1F; color:#1A1633; }"
  + " .vp-skip { background:transparent; color:#A52617; box-shadow:inset 0 0 0 1.5px #A52617; } .vp-early { background:#FFF1D6; color:#5E5878; }"
  + " .rev { color:var(--mute); font-size:12.5px; font-weight:600; margin-left:4px; }";
function verdictPill(label, level = meterLevel(label)) {
  return `<span class="vpill vp-${level}">${escHtml(label)}</span>`;
}
// THE RING AND ITS EVIDENCE (Oct 2026). Two jobs, never mixed:
//   - the pill says the verdict, or why there isn't one ("Critics split", "Too early" for a new
//     film, "Not enough ratings" for an older one — lib/fcscore.js noScoreText);
//   - the slot beside it shows what that rests on. The RING is the audience rating and nothing
//     else, drawn only when that rating actually counts toward the verdict (fcScore.audience): a
//     6.3 from 10 votes the score ignores gets no ring. Without a ring the slot is plain text —
//     never a circle — stating the evidence: "12 critic reviews" when critics decided the
//     verdict, otherwise the audience's status ("Few ratings", "Not rated yet").
// The pill and the slot can't contradict each other: a critics-based verdict is never shown
// beside "Few ratings", and "Too early" is never shown for an old film.
// Client twins in js/app.js: dialRating, evidenceLabel, ratingDial, heroDialInner.
function dialRating(item) {
  const s = item && item.fcScore;
  if (!s || !s.audience || item.rating == null || !item.votes) return null;
  const r = Number(item.rating);
  return Number.isFinite(r) ? r : null;
}
function evidenceLabel(item) {
  const s = item && item.fcScore;
  if (s && s.basis === "critics") {
    const n = Number(item.criticsCount) || 0;
    return n > 0 ? `${n} critic review${n === 1 ? "" : "s"}` : "Critics' verdict";
  }
  if (s) return ""; // scored from the audience but no rating to draw: say nothing rather than contradict
  if (noScoreText(item).label === "Not out yet") return ""; // ratings before release aren't evidence of anything
  const votes = Number((item && item.votes) || 0);
  if (votes >= FEW_VOTES && item.rating == null) return "No rating yet"; // a count but no usable average
  return votes > 0 ? "Few ratings" : "Not rated yet";
}
// A card's slot: the ring (a CSS conic-gradient filled to the rating, coloured by the verdict),
// or the evidence as text.
function ratingDial(item) {
  const r = dialRating(item);
  if (r == null) { const t = evidenceLabel(item); return t ? `<div class="dial-note">${escHtml(t)}</div>` : ""; }
  const v = r.toFixed(1);
  return `<div class="dial dial-${meterLevel(item.fcScore.verdict)}" style="--p:${Math.round(r * 10)}%" role="img" aria-label="Audience rating ${v} out of 10"><span>${v}</span></div>`;
}
// The hero's larger dial, labelled; the evidence as text without one; empty when there's nothing.
function heroDialInner(item) {
  const r = dialRating(item);
  if (r == null) { const t = evidenceLabel(item); return t ? `<div class="hero-note">${escHtml(t)}</div>` : ""; }
  const v = r.toFixed(1);
  return `<div class="dial dial-hero" style="--p:${Math.round(r * 10)}%" role="img" aria-label="Audience rating ${v} out of 10"><span>${v}</span></div><div class="hero-dial-label">Audience</div>`;
}
// The list pages' version (language and platform hubs, /new-on-ott/): the same two jobs on one
// line — "★ 7.5 [Worth a watch]" when the rating counts, "[Worth a watch] 12 critic reviews" or
// "[Critics split] Few ratings" when it doesn't. `extra` is appended (e.g. trailer views).
function rowScoreLine(item, extra = "") {
  const r = dialRating(item);
  const pill = item.fcScore ? verdictPill(item.fcScore.verdict) : verdictPill(noScoreText(item).label, "early");
  const note = r == null ? evidenceLabel(item) : "";
  return `<div class="rm">${r != null ? `<b>★ ${r.toFixed(1)}</b> ` : ""}${pill}${note ? ` <span class="rev">${escHtml(note)}</span>` : ""}${extra}</div>`;
}

module.exports = { METER_ZONES, VPILL_CSS, dialRating, evidenceLabel, heroDialInner, meterInner, meterLevel, meterSvg, meterSymbols, ratingDial, rowScoreLine, verdictPill };
