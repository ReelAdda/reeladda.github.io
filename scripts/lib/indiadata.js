// ============================================================================
// indiadata.js — theatre-to-streaming windows for Indian cinema, complete enough to publish
// (Oct 2026).
//
// /data/ showed no Hindi row: the archive only followed films that made the site's own lists
// (about seven cinema releases at a time across every language), so most Indian releases were
// never watched at all. Two sources fix that, kept apart on purpose:
//
//   1. CENSUS (measured). Every film TMDB lists as opening in Indian cinemas in an Indian
//      language joins the probe's watchlist, not only the listed ones. A film already
//      streaming when it joins is set aside: we never saw it arrive, so its window would be
//      the day we started looking, not the day it dropped.
//
//   2. DIGITAL RELEASE DATES (historical). TMDB records a per-country "digital" release
//      (type 4), which for Indian films is normally the streaming premiere. That reaches back
//      years, which our own archive never can. It is volunteer-entered, so it is published
//      as its own table, with its coverage, and never mixed with what we measured.
//
// State: ott-census.json (who joined, and whether it was already streaming) and
// ott-digital.json (the films and their dates). Both are committed by the workflow and never
// published on the site.
// ============================================================================
"use strict";

const fs = require("fs");
const { langName } = require("./rules.js");
const { regionalTheatricalDate, digitalReleaseFor } = require("./enrich.js");
const { median } = require("./history.js");

const CENSUS_FILE = "ott-census.json";
const DIGITAL_FILE = "ott-digital.json";
const INDIAN_LANGS = ["hi", "ta", "te", "ml", "kn", "pa", "mr", "bn"];
const CENSUS_DAYS = 180;          // films that opened this recently and may still be on their way
const CENSUS_PAGES = 5;           // per language: the 100 most popular, which is all but the tiniest
const DIGITAL_SINCE = "2023-01-01";
const DIGITAL_RECHECK_DAYS = 14;  // a film with no digital date yet is asked again this often
const DIGITAL_RECHECK_AGE = 400;  // ...until its cinema release is this old
const DIGITAL_MAX_WINDOW = 365;   // longer than this: a late catalogue listing, not a release window
const PUBLISH_MIN = 20;           // films before a group gets a row of its own

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => iso(Date.parse(`${d}T00:00:00Z`) + n * 864e5);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }

// One /discover query's results, page by page. Films opening in Indian cinemas (release types
// 2 and 3 in region IN) in one language and date range.
async function discoverIndian(api, lang, from, to, { pages = 20, sort = "popularity.desc" } = {}) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const r = await api.tmdb("/discover/movie", {
      region: "IN", with_release_type: "2|3", with_original_language: lang,
      "release_date.gte": from, "release_date.lte": to, sort_by: sort, include_adult: "false", page: String(page),
    });
    await api.pause(120);
    out.push(...(r.results || []));
    if (!r.total_pages || page >= r.total_pages) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. CENSUS
// ---------------------------------------------------------------------------
// Returns watchlist entries (same shape the build writes) for every recent Indian cinema
// release that wasn't already streaming when it joined. `known` = country:movie:id keys
// already archived or watched. No `th` on purpose: the build looks up the exact Indian cinema
// date once the film arrives (fillCinemaDates), instead of trusting TMDB's primary date.
async function indiaCinemaCensus({ api, today, known = new Set(), state = readJson(CENSUS_FILE, { films: {} }),
  save = (s) => fs.writeFileSync(CENSUS_FILE, JSON.stringify(s, null, 1)), joinBudget = 400 } = {}) {
  const res = { found: 0, joined: 0, alreadyStreaming: 0, watching: 0, errors: 0 };
  const from = addDays(today, -CENSUS_DAYS);
  const films = new Map();
  for (const lang of INDIAN_LANGS) {
    try {
      for (const m of await discoverIndian(api, lang, from, today, { pages: CENSUS_PAGES })) {
        if (m && m.id && !films.has(m.id)) films.set(m.id, { m, lang });
      }
    } catch { res.errors++; }
  }
  res.found = films.size;
  let joins = 0;
  const watch = [];
  for (const [id, { m, lang }] of films) {
    let s = state.films[id];
    if (!s) {
      if (known.has(`in:movie:${id}`)) { state.films[id] = { s: "watch", at: today, rel: m.release_date || null }; s = state.films[id]; }
      else {
        if (joins >= joinBudget) continue;              // the rest join next run
        joins++;
        let provs = null;
        try {
          const d = await api.tmdb(`/movie/${id}/watch/providers`);
          await api.pause(120);
          const wp = (d && d.results && d.results.IN) || {};
          provs = [...(wp.flatrate || []), ...(wp.free || [])];
        } catch { res.errors++; continue; }
        s = state.films[id] = { s: provs.length ? "already" : "watch", at: today, rel: m.release_date || null };
        res.joined++;
      }
    }
    if (s.s === "already") { res.alreadyStreaming++; continue; }
    res.watching++;
    if (known.has(`in:movie:${id}`)) continue;
    watch.push({ code: "in", kind: "movie", tmdbId: id, title: m.title || m.original_title,
      released: m.release_date || null, language: langName(lang) || null, genre: null, census: true });
  }
  // Forget films that have aged out of the census window.
  for (const [id, s] of Object.entries(state.films)) if (s.rel && s.rel < addDays(today, -CENSUS_DAYS - 30)) delete state.films[id];
  save(state);
  return { res, watch };
}

// ---------------------------------------------------------------------------
// 2. DIGITAL RELEASE DATES
// ---------------------------------------------------------------------------
// Pure: the quarter-sized discovery windows from DIGITAL_SINCE to today.
function digitalWindows(today, since = DIGITAL_SINCE) {
  const out = [];
  let [y, q] = [Number(since.slice(0, 4)), Math.floor((Number(since.slice(5, 7)) - 1) / 3)];
  for (;;) {
    const from = `${y}-${String(q * 3 + 1).padStart(2, "0")}-01`;
    if (from > today) break;
    const end = iso(Date.UTC(y, q * 3 + 3, 0));
    out.push({ from, to: end < today ? end : today });
    q++; if (q === 4) { q = 0; y++; }
  }
  return out;
}

// Pure: one film's window, or why it has none.
function digitalWindow(f) {
  if (!f || !f.th) return { why: "noCinemaDate" };
  if (!f.dig) return { why: "noDigitalDate" };
  const d = daysBetween(f.th, f.dig);
  if (d < 0) return { why: "digitalFirst" };            // listed digital before cinema: not a window
  if (d > DIGITAL_MAX_WINDOW) return { why: "tooLong" };
  return { days: d };
}

// Pure: the published figures. Groups under PUBLISH_MIN films are kept but flagged.
function digitalStats(store, { today = iso(Date.now()) } = {}) {
  const films = Object.values((store && store.films) || {}).filter((f) => f && f.th && f.th <= today);
  const rows = films.map((f) => ({ f, w: digitalWindow(f) }));
  const ok = rows.filter((x) => x.w.days != null);
  const why = {};
  for (const x of rows) if (x.w.why) why[x.w.why] = (why[x.w.why] || 0) + 1;
  const group = (keyFn) => {
    const m = new Map();
    for (const { f, w } of ok) { const k = keyFn(f); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(w.days); }
    const all = new Map();
    for (const { f } of rows) { const k = keyFn(f); if (k) all.set(k, (all.get(k) || 0) + 1); }
    return [...m.entries()].map(([key, ds]) => ({ key, n: ds.length, of: all.get(key) || ds.length, median: median(ds), small: ds.length < PUBLISH_MIN }))
      .filter((x) => x.n >= 5).sort((a, b) => b.n - a.n);
  };
  const ths = ok.map((x) => x.f.th).sort();
  return {
    films: films.length, measured: ok.length, overall: median(ok.map((x) => x.w.days)),
    // Coverage among films people actually watch (20+ TMDB votes), and overall.
    notable: { films: rows.filter((x) => (x.f.votes || 0) >= 20).length, measured: ok.filter((x) => (x.f.votes || 0) >= 20).length },
    from: ths[0] || null, to: ths[ths.length - 1] || null,
    byLanguage: group((f) => f.lang),
    byYear: group((f) => String(f.th).slice(0, 4)).sort((a, b) => a.key.localeCompare(b.key)),
    excluded: why,
  };
}

// Discovers new films (each historical quarter once; the last two quarters again every week)
// and reads their release dates, within `budget` TMDB calls. Resumable: a later run picks up
// where this one stopped.
async function runDigitalBackfill({ api, today, budget = 300, store = readJson(DIGITAL_FILE, { windows: {}, films: {} }),
  save = (s) => fs.writeFileSync(DIGITAL_FILE, JSON.stringify(s, null, 1)) } = {}) {
  store.windows = store.windows || {}; store.films = store.films || {};
  const res = { calls: 0, discovered: 0, read: 0, dated: 0, errors: 0, left: 0 };
  const spend = () => res.calls < budget;
  const counting = { tmdb: async (p, q) => { res.calls++; return api.tmdb(p, q); }, pause: api.pause };
  const wins = digitalWindows(today);
  const recent = new Set(wins.slice(-2).map((w) => w.from));
  outer:
  for (const w of wins) {
    for (const lang of INDIAN_LANGS) {
      const key = `${lang}:${w.from}`;
      const done = store.windows[key];
      if (done && (!recent.has(w.from) || daysBetween(done, today) < 7)) continue;
      if (!spend()) break outer;
      try {
        for (const m of await discoverIndian(counting, lang, w.from, w.to)) {
          if (!m || !m.id) continue;
          const f = store.films[m.id];
          if (!f) { store.films[m.id] = { t: m.title || m.original_title, lang: langName(lang), votes: m.vote_count || 0 }; res.discovered++; }
          else f.votes = m.vote_count || f.votes || 0;
        }
        store.windows[key] = today;
      } catch { res.errors++; if (res.errors >= 5) break outer; }
    }
  }
  // Read release dates: never-read films first (most-voted first), then due rechecks.
  const due = Object.entries(store.films).filter(([, f]) => {
    if (!f.at) return true;
    if (f.dig) return false;
    if (f.th && daysBetween(f.th, today) > DIGITAL_RECHECK_AGE) return false;
    return daysBetween(f.at, today) >= DIGITAL_RECHECK_DAYS;
  }).sort(([, a], [, b]) => (!!a.at - !!b.at) || (b.votes || 0) - (a.votes || 0));
  for (const [id, f] of due) {
    if (!spend() || res.errors >= 5) break;
    try {
      const d = await counting.tmdb(`/movie/${id}/release_dates`);
      await api.pause(120);
      const body = { release_dates: d };
      f.th = regionalTheatricalDate(body, "IN") || null;
      const dig = digitalReleaseFor(body, "IN");
      if (dig) { f.dig = dig.date; if (dig.note) f.note = dig.note; res.dated++; }
      f.at = today;
      res.read++;
    } catch { res.errors++; }
  }
  res.left = Object.values(store.films).filter((f) => !f.at).length;
  save(store);
  return res;
}

module.exports = {
  CENSUS_FILE, DIGITAL_FILE, INDIAN_LANGS, PUBLISH_MIN,
  digitalStats, digitalWindow, digitalWindows, indiaCinemaCensus, runDigitalBackfill,
};
