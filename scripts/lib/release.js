// ============================================================================
// release.js — release-state machine: what is out, what is today, what is coming
// ============================================================================
"use strict";

const { fmtDateShort } = require("./core.js");

// ============================================================================
// RELEASE STATE — one source of truth for every date-dependent word on the site.
//
// The failure this prevents: a page that says "Coming soon" next to a date that has
// already passed. It happens two ways — bad data (a premiere date overriding the real
// one) and TIME (a card built on Monday for a Tuesday release is still on disk, and in
// the visitor's browser cache, on Wednesday). Data fixes only solve the first, so every
// render path re-derives state from the date instead of trusting the bucket it's in.
//
//   date  < today  ->  "released"   never "Coming soon"
//   date == today  ->  "today"      "Releases today"
//   date  > today  ->  "upcoming"   "Coming soon"
//
// Compared as YYYY-MM-DD strings against the calendar day, not as timestamps: a film
// releasing today is not "released" at 6am and must not read "Released" until tomorrow.
// ============================================================================
function todayStr(now = Date.now()) { return new Date(now).toISOString().slice(0, 10); }

function releaseState(dateStr, now = Date.now()) {
  if (!dateStr) return "unknown";
  const d = String(dateStr).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "unknown";
  const t = todayStr(now);
  return d > t ? "upcoming" : d === t ? "today" : "released";
}

function releaseState(dateStr, now = Date.now()) {
  if (!dateStr) return "unknown";
  const d = String(dateStr).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "unknown";
  const t = todayStr(now);
  return d > t ? "upcoming" : d === t ? "today" : "released";
}

// Tense-correct date line for cards and pages: "Releases today" / "Releases 9 Oct" /
// "Released 31 Jan". TV keeps its own "Latest season" wording (see freshLabel).
function releaseLabel(dateStr, now = Date.now(), locale = "en-IN") {
  const st = releaseState(dateStr, now);
  if (st === "unknown") return "";
  if (st === "today") return "Releases today";
  return (st === "upcoming" ? "Releases " : "Released ") + fmtDateShort(dateStr, now, locale);
}

// Data hygiene for the upcoming bucket, applied at BUILD time and again at RENDER time.
//   - `released` in the past but a known future date elsewhere (freshDate) -> the regional
//     override lied; show the future date. This is the Bokshi case.
//   - every known date in the past -> the film is out; it is not "coming soon" any more and
//     is dropped. It still appears in theatres/streaming if it earned a slot there.
// Pure, so the same rule is testable and cannot drift between the two call sites.
function normalizeUpcoming(list, now = Date.now()) {
  const out = [];
  for (const item of list || []) {
    if (!item) continue;
    // `released` is the region's own date and is the RIGHT one whenever it is usable —
    // Ramayana is 8 Nov in India and 6 Nov globally, and the India page must say 8 Nov.
    // Only reach for the fallback when the regional date is unusable.
    if (releaseState(item.released, now) !== "released" && item.released) { out.push(item); continue; }
    const fallback = [item.freshDate].filter(Boolean).map((d) => String(d).slice(0, 10))
      .find((d) => releaseState(d, now) !== "released");
    if (!fallback) continue;                           // every known date has passed -> not upcoming
    out.push({ ...item, released: fallback });
  }
  return out;
}

module.exports = {
  normalizeUpcoming,
  releaseLabel,
  releaseState,
  todayStr,
};
