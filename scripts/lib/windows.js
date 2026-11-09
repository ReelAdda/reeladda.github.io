// ============================================================================
// windows.js — how long films take to reach streaming, measured (8 Nov 2026).
//
// The "X releases typically reach streaming about N–M weeks after opening" sentence used a
// hand-typed table (lib/rules.js STREAM_WINDOW_WEEKS). Checked against what actually happened it
// was right 47% of the time on TMDB's 734 India digital dates and 30% on our own 137 sightings
// (English: 5–9 weeks typed, 14 weeks measured, 9% right). This module derives each language's
// range from the record instead:
//   - our own sightings first (lib/history.js: cinema date -> first seen streaming), every edition;
//   - for an Indian language with too few of ours, TMDB's India digital dates (lib/indiadata.js);
//   - under MIN_FILMS films, no range of its own: the pooled default, and the copy doesn't name it.
// The range runs from the 20th to the 80th percentile in whole weeks (at least two weeks wide),
// and carries the exact count of films inside it, so a page can say "31 of the last 37 did".
// Refreshed once a month (WINDOWS_FILE), not every build: a range that moved twice a day would
// rewrite hundreds of pages each time for no change a reader could use.
// ============================================================================
"use strict";

const fs = require("fs");

const WINDOWS_FILE = "stream-windows.json";
const MIN_FILMS = 10;
const INDIAN = new Set(["Hindi", "Tamil", "Telugu", "Malayalam", "Kannada", "Punjabi", "Marathi", "Bengali"]);

function quantile(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]; }

// Pure: one range from a list of windows in days.
function rangeFor(days) {
  const s = days.filter((d) => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const lo = Math.max(1, Math.floor(quantile(s, 0.2) / 7));
  let hi = Math.ceil(quantile(s, 0.8) / 7);
  if (hi - lo < 2) hi = lo + 2;
  const hit = s.filter((d) => d >= lo * 7 && d <= hi * 7).length;
  return { lo, hi, n: s.length, hit };
}

// Pure: the month's ranges. `records` from lib/history.js readHistory(); `digitalStore` the
// parsed ott-digital.json (or null).
function computeWindows(records, digitalStore, month) {
  const H = require("./history.js");
  const starts = H.observationStarts(records || []);
  const ours = new Map(), tmdb = new Map(), all = [];
  for (const r of records || []) {
    const d = H.cinemaWindowDays(r, starts);
    if (d == null || !r.lang) continue;
    if (!ours.has(r.lang)) ours.set(r.lang, []);
    ours.get(r.lang).push(d); all.push(d);
  }
  if (digitalStore && digitalStore.films) {
    const { digitalWindow } = require("./indiadata.js");
    for (const f of Object.values(digitalStore.films)) {
      if (!f || !INDIAN.has(f.lang)) continue;
      const w = digitalWindow(f);
      if (w.days == null) continue;
      if (!tmdb.has(f.lang)) tmdb.set(f.lang, []);
      tmdb.get(f.lang).push(w.days);
    }
  }
  const languages = {};
  for (const lang of new Set([...ours.keys(), ...tmdb.keys()])) {
    const a = ours.get(lang) || [], b = tmdb.get(lang) || [];
    if (a.length >= MIN_FILMS) languages[lang] = { ...rangeFor(a), src: "ours" };
    else if (b.length >= MIN_FILMS) languages[lang] = { ...rangeFor(b), src: "tmdb" };
  }
  const def = all.length >= MIN_FILMS ? { ...rangeFor(all), src: "ours" } : null;
  return { month, languages, default: def };
}

// The build's call: this month's ranges, computed on the month's first build and kept after.
function refreshWindows({ today = new Date().toISOString().slice(0, 10), file = WINDOWS_FILE, records = null, digitalStore } = {}) {
  const month = today.slice(0, 7);
  try {
    const have = JSON.parse(fs.readFileSync(file, "utf8"));
    if (have && have.month === month && have.languages) return { windows: have, computed: false };
  } catch { /* first run, or unreadable: compute */ }
  const recs = records || require("./history.js").readHistory();
  let store = digitalStore;
  if (store === undefined) { try { store = JSON.parse(fs.readFileSync(require("./indiadata.js").DIGITAL_FILE || "ott-digital.json", "utf8")); } catch { store = null; } }
  const windows = computeWindows(recs, store, month);
  fs.writeFileSync(file, JSON.stringify(windows, null, 1) + "\n");
  return { windows, computed: true };
}

// THE WINDOW CLOCK (step 5): a film's own measured window, for the line under its platform pill
// ("Reached Netflix 56 days after cinemas."). Only films whose arrival we saw ourselves after
// their cinema release in that country (lib/history.js cinemaWindowDays: no straight-to-
// streaming, nothing already streaming when we started watching). Loaded once per build.
let CLOCKS = null;
function useClocks(records) {
  CLOCKS = new Map();
  if (!records) return CLOCKS;
  const H = require("./history.js");
  const starts = H.observationStarts(records);
  for (const r of records) {
    const days = H.cinemaWindowDays(r, starts);
    if (days == null || r.k !== "movie" || !r.p) continue;
    CLOCKS.set(`${r.c}:${r.id}`, { days, platform: r.p, first: r.first, cinema: r.th });
  }
  return CLOCKS;
}
function clockFor(code, item) {
  if (!CLOCKS || !item || item.kind === "tv" || !item.tmdbId) return null;
  return CLOCKS.get(`${code}:${item.tmdbId}`) || null;
}
// Pure: the line. `info` is lib/rules.js windowInfo(language) or null.
function clockHtml(clock, language, info) {
  if (!clock) return "";
  const e = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const usual = info && language
    ? ` ${e(language)} films usually take ${info.lo}–${info.hi} weeks (${info.hit} of ${info.n} ${info.src === "ours" ? "we measured" : "in TMDB's records"}).`
    : "";
  return `<p class="wclock" style="font-size:13.5px;color:var(--mute);margin:8px 0 0;line-height:1.5"><b style="color:var(--ink)">Reached ${e(clock.platform)} ${clock.days} day${clock.days === 1 ? "" : "s"} after cinemas.</b>${usual}</p>`;
}

// Pure: the arrival line (rollout "arrival-record", 9 Nov 2026): the clock and the sighting in
// one sentence, so the fact is said once. `sighting` is lib/dated.js sightingFor ({ day, part,
// platform }); `fmt(day)` the edition's date. "Spotted", never "released": we know when one of
// the day's checks saw it, not when the platform made it live; the part of day, never a time.
// Either half alone still draws; neither draws nothing.
// Days from the cinema date to a sighting's LOCAL day. The clock counts to the record's UTC run
// date, so a check at 01:37 IST on 7 Nov (20:07 UTC on the 6th) read "28 days" beside "spotted
// Friday 7 Nov": 29 by the reader's own sum (All Pass, 9 Nov 2026). Shown beside a day, the count
// runs to that day.
function daysToSighting(clock, sighting) {
  if (!clock || !sighting || !/^\d{4}-\d{2}-\d{2}/.test(clock.cinema || "")) return clock ? clock.days : null;
  const d = Math.round((Date.parse(`${sighting.day}T00:00:00Z`) - Date.parse(`${String(clock.cinema).slice(0, 10)}T00:00:00Z`)) / 864e5);
  return d >= 0 ? d : clock.days;
}
function arrivalHtml(clock, sighting, language, info, fmt = (d) => d) {
  if (!sighting) return clockHtml(clock, language, info);
  if (clock && String(clock.platform).toLowerCase() === String(sighting.platform).toLowerCase()) clock = { ...clock, days: daysToSighting(clock, sighting) };
  const e = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const when = `${WEEKDAY[new Date(`${sighting.day}T00:00:00Z`).getUTCDay()]} ${e(fmt(sighting.day))}, ${e(sighting.part)}`;
  const same = clock && clock.platform && sighting.platform && String(clock.platform).toLowerCase() === String(sighting.platform).toLowerCase();
  const usual = clock && info && language
    ? ` ${e(language)} films usually take ${info.lo}–${info.hi} weeks (${info.hit} of ${info.n} ${info.src === "ours" ? "we measured" : "in TMDB's records"}).`
    : "";
  const lead = clock
    ? `<b style="color:var(--ink)">Reached ${e(clock.platform)} ${clock.days} day${clock.days === 1 ? "" : "s"} after cinemas.</b> ${same ? "We spotted it there" : `We spotted it on ${e(sighting.platform)}`} on ${when}.`
    : `<b style="color:var(--ink)">Spotted on ${e(sighting.platform)} on ${when}.</b>`;
  return `<p class="wclock" style="font-size:13.5px;color:var(--mute);margin:8px 0 0;line-height:1.5">${lead}${usual}</p>`;
}

module.exports = { INDIAN, MIN_FILMS, WINDOWS_FILE, arrivalHtml, clockFor, clockHtml, daysToSighting, computeWindows, rangeFor, refreshWindows, useClocks };
