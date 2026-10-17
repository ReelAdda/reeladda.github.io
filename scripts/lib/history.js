// ============================================================================
// history.js — the append-only streaming-arrival archive.
//
// WHY THIS EXISTS SEPARATELY FROM ott-seen.json
// ott-seen.json is OPERATIONAL state: it feeds the freshness gate, and it prunes entries
// unseen for SEEN_RETENTION_DAYS so a title that leaves and re-enters a catalogue can't
// masquerade as new. That pruning is correct for its job and fatal for a historical record —
// it means observations silently delete themselves every six months.
//
// This file is the record. Append-only, never pruned, one JSON object per line (one
// exception: fillCinemaDates adds a missing field to existing lines; nothing is removed). It is the
// only asset here that cannot be reconstructed later: TMDB stores no history of provider
// changes and JustWatch publishes none, so a competitor starting in 2027 can never obtain
// 2026. Every day this doesn't run is a day permanently missing.
//
// JSONL rather than JSON on purpose: appending a line costs nothing, needs no parse of the
// whole file, and a truncated write loses one observation instead of the archive.
// ============================================================================
"use strict";

const fs = require("fs");
const { canonProvider } = require("./rules.js");

const HISTORY_FILE = "ott-history.jsonl";

// One observation. `first` is the date we first saw this title carrying a provider in this
// country; `theatrical` is its release date. `cinema` is the film's own cinema release IN THIS
// COUNTRY (TMDB release types 2/3), stored as `th`: a date when it opened in cinemas here, null
// when it did not (straight to streaming here), absent when not yet known (fillCinemaDates
// looks it up later). `rel` alone could not tell the two apart: for a streaming original it
// is the premiere date, which read as a one-day "theatrical window" on /data/.
function historyRecord({ code, kind, tmdbId, title, platform, providers, first, theatrical, cinema, language, genre }) {
  const tv = kind === "tv";
  return {
    c: code, k: tv ? "tv" : "movie", id: tmdbId, t: title || null,
    p: platform || null,
    ps: Array.isArray(providers) && providers.length ? providers.slice(0, 6) : undefined,
    first, rel: theatrical || null,
    ...(tv || cinema === undefined ? {} : { th: cinema || null }),
    lang: language || null, g: genre || null,
    seen: new Date().toISOString(),
  };
}

// In-process index of what the archive already holds, so a title observed on every run for
// six months produces ONE line, not 360. Keyed country:kind:id.
let _index = null;
function loadHistoryIndex() {
  if (_index) return _index;
  _index = new Set();
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      // A retracted sighting (verifyEarlyArrivals) doesn't block the title: when it really
      // arrives, that observation is recorded as a new line.
      try { const o = JSON.parse(line); if (!o.x) _index.add(`${o.c}:${o.k}:${o.id}`); } catch { /* skip malformed */ }
    }
  } catch { /* first ever run */ }
  return _index;
}

// Returns true when a NEW line was written. Idempotent per (country, title).
function appendHistory(rec) {
  if (!rec || !rec.id || !rec.c) return false;
  const idx = loadHistoryIndex();
  const key = `${rec.c}:${rec.k}:${rec.id}`;
  if (idx.has(key)) return false;
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(rec) + "\n");
  idx.add(key);
  return true;
}

// Readers see one name per service (canonProvider in rules.js). Records written before Oct
// 2026 carry TMDB's raw strings ("Disney Plus", "Paramount Plus Apple TV channel"), newer ones
// the canonical names; the month pages, the /data/ figures and the film pages' "on Disney+"
// line group and print them as one service. The file itself keeps what was recorded.
function canonRecord(r) {
  if (r.p) r.p = canonProvider(r.p);
  if (Array.isArray(r.ps)) r.ps = [...new Set(r.ps.map(canonProvider))];
  return r;
}
// Retracted sightings (`x`, see verifyEarlyArrivals) are left out: no month page, data figure
// or film page counts an arrival a later check disproved. `all` includes them, for the one
// reader that has to remove what a page already says.
function readHistory({ all = false } = {}) {
  try {
    return fs.readFileSync(HISTORY_FILE, "utf8").split("\n")
      .filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && (all || !r.x)).map(canonRecord);
  } catch { return []; }
}

// Whole days from one ISO date to another, or null when either is missing, the gap is
// negative (streaming before the start date: a bad date) or longer than two years (a
// catalogue re-listing, not a release window).
function windowBetween(from, to) {
  if (!from || !to) return null;
  const a = Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(to).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = Math.round((b - a) / 864e5);
  return d < 0 || d > 730 ? null : d;
}

// Days from release date to first streaming sighting, whatever the title. Kept for the raw
// arithmetic; nothing published uses it any more — see cinemaWindowDays.
function streamingWindowDays(rec) {
  return rec ? windowBetween(rec.rel, rec.first) : null;
}

// The day the archive began watching each country: its earliest `seen` stamp. A title already
// streaming that day got a reconstructed `first`, not an observed one — on a country's first
// build recordOttSeen stamps the RELEASE date as the sighting — so only sightings made after
// this day measure a real arrival. Those cold-start rows were most of the "1 day" windows.
function observationStarts(records) {
  const out = {};
  for (const r of records || []) {
    const s = String((r && r.seen) || "").slice(0, 10);
    if (!r || !r.c || !/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;
    if (!out[r.c] || s < out[r.c]) out[r.c] = s;
  }
  return out;
}

// ---------------------------------------------------------------------------
// EARLY-ARRIVAL CHECK (Oct 2026). TMDB's provider data (from JustWatch) sometimes lists a film
// on a platform before it is really there: Prime Video's placeholder for Drishyam: The
// Conclusion showed in India and the UAE three months before its 2 October cinema release, and
// for a single day in the US, Indonesia, the Philippines and Korea around its release. The
// archive recorded those as arrivals; the US page said the film "reached streaming 4 days after
// its theatrical release", and /data/ counted 0- and 4-day windows. TMDB listed no offers for
// it in either country on 17 October.
//
//   - A sighting BEFORE the film's cinema release in that country is a placeholder: retracted.
//   - A sighting within EARLY_WINDOW_DAYS of the release (or premiere) is rechecked once it is
//     VERIFY_AFTER_DAYS old. Still listed: confirmed (`ok`). Missing on two checks on separate
//     days: retracted (`x`). One empty answer is often a feed blip, so it only marks `xq`.
// A retracted line stays in the file (nothing is deleted) and readers skip it.
// ---------------------------------------------------------------------------
const EARLY_WINDOW_DAYS = 14;
const VERIFY_AFTER_DAYS = 7;
const PRELIST_MAX_DAYS = 180;    // further back than this: an old film's re-release, not a placeholder

function daysBetween(a, b) {
  const x = Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`), y = Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 864e5) : null;
}
// Pure: seen on a platform before the film opened in cinemas here (a placeholder listing).
function prelisted(rec) {
  if (!rec || rec.k !== "movie" || !rec.th || !rec.first) return false;
  const d = daysBetween(rec.first, rec.th);
  return d != null && d > 0 && d <= PRELIST_MAX_DAYS;
}
// Pure: a film sighting close enough to its release that it needs a confirming check.
function awaitingCheck(rec) {
  if (!rec || rec.x || rec.ok || rec.k !== "movie" || !rec.first) return false;
  const base = rec.th || rec.rel;
  const d = base ? daysBetween(base, rec.first) : null;
  return d != null && d <= EARLY_WINDOW_DAYS;
}

// Marks lines in place (dirty) and returns what it did. `check(rec)` resolves to the
// subscription platforms TMDB lists for the film in that country today (an array) or throws.
// `keys` lists the country:kind:id of each withdrawn sighting, so the caller can forget its
// first-seen date and record the real arrival when it comes.
async function verifyEarlyArrivals(lines, { check, today, budget = 80, pause = async () => {} } = {}) {
  const res = { prelisted: 0, checked: 0, confirmed: 0, retracted: 0, pending: 0, outage: false, keys: [] };
  const retract = (l, why) => {
    l.rec.x = today; l.rec.xr = why; delete l.rec.xq; l.dirty = true;
    res.retracted++; res.keys.push(`${l.rec.c}:${l.rec.k}:${l.rec.id}`);
  };
  // Only sightings made while we were watching. A row dated at or before the country's first
  // build is a reconstruction (Project Hail Mary: "first seen" 15 March in 14 countries), not a
  // listing anyone saw, and withdrawing it would re-date the film as a brand-new arrival.
  const starts = observationStarts((lines || []).map((l) => l && l.rec).filter(Boolean));
  const due = [];
  for (const l of lines || []) {
    const r = l && l.rec;
    if (!r || r.x || r.ok) continue;
    const start = starts[r.c];
    const cold = !start || String(r.first || "").slice(0, 10) <= start;
    // ...except a film that hadn't opened in cinemas yet when we began watching: whatever
    // listing it had then was a placeholder (Drishyam: The Conclusion on the July 2026 page).
    if (cold && !(start && prelisted(r) && r.th > start)) continue;
    if (prelisted(r)) { retract(l, "listed before its cinema release"); res.prelisted++; continue; }
    if (!awaitingCheck(r)) continue;
    const age = daysBetween(r.first, today);
    if (age == null || age < VERIFY_AFTER_DAYS) continue;
    if (r.xq && r.xq >= today) continue;                  // the second check is on a later day
    due.push(l);
  }
  const results = [];
  for (const l of due.slice(0, budget)) {
    try { results.push({ l, provs: await check(l.rec) }); res.checked++; }
    catch { /* not evidence either way: retry next run */ }
    await pause();
  }
  // Most of a sizeable batch empty at once is the provider feed failing, not films vanishing.
  const empty = results.filter((x) => !(x.provs && x.provs.length)).length;
  if (results.length >= 10 && empty / results.length >= 0.6) { res.outage = true; return res; }
  for (const { l, provs } of results) {
    const r = l.rec;
    if (provs && provs.length) { r.ok = today; delete r.xq; l.dirty = true; res.confirmed++; }
    else if (r.xq) retract(l, "not found on two later checks");
    else { r.xq = today; l.dirty = true; res.pending++; }
  }
  return res;
}

// The theatrical window /data/ publishes and film pages state: days from the film's cinema
// release in THIS country (`th`) to the day we first saw it streaming there. Null unless all
// of it is true — a film (not TV), that opened in cinemas here, first seen streaming after we
// began watching this country, within 0..730 days. `starts` = observationStarts(records).
function cinemaWindowDays(rec, starts) {
  if (!rec || rec.x || rec.k !== "movie" || !rec.th || !rec.first) return null;
  const start = starts && starts[rec.c];
  if (!start || String(rec.first).slice(0, 10) <= start) return null;
  const d = windowBetween(rec.th, rec.first);
  // A very short window is published only once a later check has confirmed it (`ok`).
  return d != null && d <= EARLY_WINDOW_DAYS && !rec.ok ? null : d;
}

// What a film page that already states a window should do with it: "keep" (still true, and
// `days` is the number to show), "drop" (TV, straight to streaming here, or a cold-start
// sighting) or "unknown" (cinema date not looked up yet: leave the page as it is for now).
function cinemaClaim(rec, starts) {
  if (!rec) return { action: "unknown", days: null };
  if (rec.x) return { action: "drop", days: null };                  // the sighting was disproved
  if (rec.k === "tv") return { action: "drop", days: null };
  if (rec.th === undefined) return { action: "unknown", days: null };
  // A short window opened in cinemas here, not yet confirmed: the recheck decides.
  if (rec.th && awaitingCheck(rec)) return { action: "unknown", days: null };
  const days = cinemaWindowDays(rec, starts);
  return days == null ? { action: "drop", days: null } : { action: "keep", days };
}

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

// Aggregate the archive into the numbers the /data/ page publishes. Films with a cinema
// release in that country only (`th`), measured by cinemaWindowDays. Until Oct 2026 every
// archived "movie" counted — streaming originals and cold-start rows among them — and the page
// said Hindi films reach streaming 1 day after release while film pages said 6–8 weeks.
function windowStats(records, { code = null } = {}) {
  const starts = observationStarts(records);
  const inScope = (records || []).filter((r) => r && (!code || r.c === code));
  const films = inScope.filter((r) => r.k === "movie");
  const rows = films.filter((r) => r.th);
  const withWindow = rows.map((r) => ({ r, d: cinemaWindowDays(r, starts) })).filter((x) => x.d != null);
  const by = (keyFn) => {
    const m = new Map();
    for (const { r, d } of withWindow) {
      const k = keyFn(r);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(d);
    }
    return [...m.entries()]
      .map(([k, ds]) => ({ key: k, n: ds.length, median: median(ds) }))
      .filter((x) => x.n >= 3)                 // never publish a "median" of one film
      .sort((a, b) => a.median - b.median);
  };
  return {
    total: rows.length,                       // films that opened in cinemas, tracked
    measured: withWindow.length,              // ...whose arrival we actually observed
    overall: median(withWindow.map((x) => x.d)),
    byLanguage: by((r) => r.lang),
    byPlatform: by((r) => r.p),
    excluded: {
      tv: inScope.filter((r) => r.k === "tv").length,
      streamingFirst: films.filter((r) => r.th === null).length,   // no cinema release here
      unchecked: films.filter((r) => r.th === undefined).length,   // cinema date not looked up yet
    },
  };
}

// ---------------------------------------------------------------------------
// CINEMA-DATE BACKFILL. Films archived before `th` existed (and probe sightings whose
// watchlist entry predates it) have no cinema date, so /data/ can't count them yet. One TMDB
// release_dates call per film covers every country at once, so the backlog costs one call per
// title, once. `lookup(id)` returns TMDB's /movie/{id}/release_dates body; `cinemaDateFor(body,
// code)` returns that country's cinema date or null. Fills `th` in place and marks the line.
// ---------------------------------------------------------------------------
async function fillCinemaDates(lines, { lookup, cinemaDateFor, budget = 150, pause = async () => {} } = {}) {
  const need = new Map();
  for (const l of lines || []) {
    const r = l && l.rec;
    if (!r || r.k !== "movie" || r.th !== undefined || !r.id) continue;
    if (!need.has(r.id)) need.set(r.id, []);
    need.get(r.id).push(l);
  }
  const res = { films: need.size, calls: 0, filled: 0, errors: 0, pending: 0 };
  for (const [id, group] of need) {
    if (res.calls >= budget) break;
    res.calls++;
    let body;
    try { body = await lookup(id); }
    catch (e) {
      // A film TMDB no longer has can never be checked: settle it as "no cinema date" so it
      // can't block the queue on every run. Anything else (rate limit, outage): retry later.
      if (/failed: 404\b/.test(String(e && e.message))) body = null;
      else { res.errors++; if (res.errors >= 5) break; continue; }
    }
    for (const l of group) { l.rec.th = (body && cinemaDateFor(body, l.rec.c)) || null; l.dirty = true; res.filled++; }
    await pause();
  }
  res.pending = [...need.values()].filter((g) => g[0].rec.th === undefined).length;
  return res;
}

// The archive as raw lines, each with its parsed record (null when a line won't parse).
function readHistoryLines(file = HISTORY_FILE) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim())
      .map((raw) => { try { return { raw, rec: JSON.parse(raw) }; } catch { return { raw, rec: null }; } });
  } catch { return []; }
}

// The one exception to append-only: fillCinemaDates adds a field to existing observations.
// Untouched lines are written back byte for byte (unparseable ones included), nothing is
// removed or reordered, and the write goes to a temp file first, so an interrupted run can
// never truncate the record.
function writeHistoryLines(lines, file = HISTORY_FILE) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, lines.map((l) => (l.dirty && l.rec ? JSON.stringify(l.rec) : l.raw)).join("\n") + (lines.length ? "\n" : ""));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// MONTHLY VIEWS — what the archive is FOR, besides the /data/ medians.
// The weekly hubs answer "what landed this week" and are stale in eight days. The same
// observations grouped by month give a page per month that stays true forever: "everything
// that started streaming in India in September 2026" is a question with a permanent answer,
// and this file is the only place that answer exists.
// ---------------------------------------------------------------------------
function monthKey(dateISO) {
  const d = String(dateISO || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(d) ? d : null;
}

function monthLabel(month, locale = "en-IN") {
  if (!monthKey(month)) return "";
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
}

// Months that actually have arrivals for this country, newest first: [{ month, n }].
function historyMonths(records, code = null) {
  const counts = new Map();
  for (const r of records || []) {
    if (code && r.c !== code) continue;
    const k = monthKey(r.first);
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].map(([month, n]) => ({ month, n })).sort((a, b) => b.month.localeCompare(a.month));
}

// One month's arrivals for one country, newest sighting first then alphabetical — a stable
// order, so a rebuilt page is byte-identical unless the data actually changed.
function historyForMonth(records, code, month) {
  if (!monthKey(month)) return [];
  return (records || [])
    .filter((r) => r && r.c === code && monthKey(r.first) === month)
    .sort((a, b) => String(b.first).localeCompare(String(a.first)) || String(a.t || "").localeCompare(String(b.t || "")));
}

module.exports = {
  HISTORY_FILE, appendHistory, readHistory, loadHistoryIndex,
  historyRecord, streamingWindowDays, windowStats, median,
  observationStarts, cinemaWindowDays, cinemaClaim,
  EARLY_WINDOW_DAYS, VERIFY_AFTER_DAYS, awaitingCheck, prelisted, verifyEarlyArrivals,
  fillCinemaDates, readHistoryLines, writeHistoryLines,
  monthKey, monthLabel, historyMonths, historyForMonth,
};
