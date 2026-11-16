// ============================================================================
// ottslots.js — which regional titles may enter an edition's OTT lists, and which of them take
// the homepage's regional slots (16 Nov 2026).
//
// Two faults, found on Jailer 2 (Tamil; cinemas 15 Oct 2026, Prime Video 12 Nov):
//
// 1. The regional pool asked TMDB only for titles RELEASED in the last 30 days. A film that
//    reaches streaming four to eight weeks after cinemas, which is most theatrical films,
//    aged out the day after it arrived: Jailer 2 was on the Tamil page for three builds and
//    then on no list at all. In India 17 of 47 regional arrivals in 30 days had opened more
//    than 30 days before and were never eligible. The pool was left to direct-to-streaming titles.
//    Now a title also qualifies when it STARTED STREAMING here in the last ARRIVAL_DAYS. The date
//    is the one its film page already states (the manifest's live.since), so the list and the
//    page can't disagree.
//
// 2. The homepage's four regional slots were filled in language order: the first language took
//    every slot whenever it had four titles, so Hindi titles with one or two ratings held all
//    four while an 8.0 Tamil arrival had none. Now (owner's rule) one slot is kept for the
//    edition's first regional language and the other three go to the best scores, any language.
//
// Pure functions; scripts/update.js does the TMDB calls.
// ============================================================================
"use strict";

const { ARRIVAL_MAX_RELEASE_AGE } = require("./freshness.js");

const ARRIVAL_DAYS = 30;       // a title counts as newly streaming for this long after it arrived
const ARRIVAL_CAND_CAP = 8;    // arrivals looked up per language per run (one TMDB call each)

const DAY = 864e5;
const isDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d);
const daysBetween = (a, b) => (Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / DAY;

// Pure: the edition's film pages that started streaming in the last `days`, newest arrival first.
// `edition` is one edition of the pages manifest (slug -> entry). An entry counts when:
//   - it is streaming now (live.providers) and live.since is a date from the last `days`;
//   - it arrived AFTER its release (a title out on a service from day one is already found by
//     its release date);
//   - its release is no older than ARRIVAL_MAX_RELEASE_AGE, the ceiling the arrival badge uses,
//     so an old film a service has just picked up is not presented as new;
//   - for a back-catalogue page, the arrival was seen after the page was archived. A catalogue
//     page records the day it was BUILT as live.since (it was already streaming), which is not
//     an arrival (the same test lib/sitemap.js isNewReleaseEntry applies).
function arrivalEntries(edition, { today, days = ARRIVAL_DAYS, maxReleaseAge = ARRIVAL_MAX_RELEASE_AGE } = {}) {
  if (!edition || !isDate(today)) return [];
  const out = [];
  for (const [slug, e] of Object.entries(edition)) {
    if (!e || !e.tmdbId || (e.kind !== "movie" && e.kind !== "tv")) continue;
    const live = e.live;
    if (!live || !isDate(live.since) || !Array.isArray(live.providers) || !live.providers.length) continue;
    const since = live.since.slice(0, 10);
    const age = daysBetween(since, today);
    if (age < 0 || age > days) continue;
    if (!isDate(e.released)) continue;
    const released = e.released.slice(0, 10);
    if (since <= released) continue;
    if (daysBetween(released, today) > maxReleaseAge) continue;
    if (e.catalog && !(isDate(e.archivedOn) && since > e.archivedOn.slice(0, 10))) continue;
    out.push({ slug, kind: e.kind, tmdbId: e.tmdbId, lang: e.lang || "", since, released });
  }
  return out.sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : a.tmdbId - b.tmdbId));
}

// Pure: a TMDB detail answer in the shape the list builder takes from /discover and /trending
// (genre_ids, not genres; the kind alongside).
function candidateFromDetail(d, kind) {
  if (!d || d.id == null) return null;
  return {
    id: d.id, kind,
    title: d.title, name: d.name,
    original_language: d.original_language,
    overview: d.overview,
    release_date: d.release_date, first_air_date: d.first_air_date,
    vote_average: d.vote_average || 0, vote_count: d.vote_count || 0, popularity: d.popularity || 0,
    genre_ids: Array.isArray(d.genre_ids) ? d.genre_ids : (d.genres || []).map((g) => g.id),
    poster_path: d.poster_path, backdrop_path: d.backdrop_path,
    adult: d.adult, origin_country: d.origin_country,
  };
}

// Pure: the titles for the homepage's regional slots. `byLang` maps a language code to its built
// items, best first; `order` is the edition's regional languages, first one guaranteed a slot.
// One slot goes to the first language's best title when it has one; every other slot goes to
// the best score among all the languages, the first included. Equal scores keep the edition's
// language order, then each language's own order. Titles in `usedIds` are passed over; the
// caller marks the ones returned.
function pickRegionalSlots(byLang, order, target, usedIds = new Set(), scoreOf = (it) => (it && it._w) || 0) {
  if (!target || target <= 0) return [];
  const pool = [];
  (order || []).forEach((lang, li) => {
    ((byLang && byLang.get(lang)) || []).forEach((it, pi) => {
      if (it && !usedIds.has(it.tmdbId)) pool.push({ it, li, pi, s: scoreOf(it) });
    });
  });
  const seen = new Set();
  const uniq = pool.filter((p) => (seen.has(p.it.tmdbId) ? false : (seen.add(p.it.tmdbId), true)));
  const picks = [];
  const lead = uniq.find((p) => p.li === 0);
  if (lead) picks.push(lead);
  const rest = uniq.filter((p) => p !== lead).sort((a, b) => b.s - a.s || a.li - b.li || a.pi - b.pi);
  for (const p of rest) { if (picks.length >= target) break; picks.push(p); }
  return picks.map((p) => p.it);
}

module.exports = { ARRIVAL_CAND_CAP, ARRIVAL_DAYS, arrivalEntries, candidateFromDetail, pickRegionalSlots };
