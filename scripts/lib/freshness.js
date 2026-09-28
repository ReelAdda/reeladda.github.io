// ============================================================================
// freshness.js — how fresh is a title, and what may be listed: first-seen tracking
// (ott-seen.json), theatre and OTT freshness gates, list integrity, badges, trending cap.
// ============================================================================
"use strict";

const { fmtDateShort } = require("./core.js");
const { OTT_FRESH_DAYS } = require("./rules.js");

// ============================================================================
// FIRST-SEEN TRACKING (ott-seen.json) — upgrades OTT freshness from a proxy to
// the real thing. TMDB only exposes RELEASE dates, not when a title arrived on a
// platform, so release-date freshness has two blind spots: a theatrical film that
// lands on Netflix months later (genuinely new on OTT, but "old" by release date),
// and catalog additions. The fix every serious streaming tracker uses: remember
// when THIS pipeline first observed each title WITH a streaming provider, per
// country (catalogs differ). ott-seen.json maps
//   { "<country>": { "<kind>:<tmdbId>": { first, last } } }
// and is committed by the bot alongside the data files.
//   - COLD START (country absent from the file): every current title is seeded
//     with the EARLIER of its release-freshness date and today, so nothing
//     falsely floods in as "just added" on day one.
//   - INCREMENTAL: an unseen key is a new arrival -> first = today.
//   - `last` is bumped every observation; entries unseen for SEEN_RETENTION_DAYS
//     are pruned, which both bounds the file AND prevents a title that briefly
//     left the candidate pool from re-entering as fake-new (retention >> window).
// Honest-epistemics note: "first seen" approximates "added to platform" — the
// pipeline can only observe titles that enter its candidate pool. That is the
// user-relevant definition (new to THIS list), and the arrival badge below is
// additionally guarded so a merely re-trending old title needs a genuinely
// recent first-sighting to earn it.
// ============================================================================
const OTT_SEEN_FILE = "ott-seen.json";
const SEEN_RETENTION_DAYS = 180;   // prune entries not observed for this long
const ARRIVAL_BADGE_DAYS = 14;     // first-seen within this window can badge as an arrival
const ARRIVAL_MIN_RELEASE_AGE = 21; // ...but only if the RELEASE is older than this
// ...AND the release is younger than this. A first-seen date only means "arrived on the
// platform" when the underlying release is plausibly recent. A catalog title that fell out
// of ott-seen.json (unseen > SEEN_RETENTION_DAYS) and re-entered via the trending pool gets
// first = today again — without this ceiling, ottArrival would stamp an 8-month-old season
// (e.g. a returning hit still trending) as "New on <platform>" every run, forever. The
// ceiling sits comfortably above SEEN_RETENTION_DAYS so a genuine new arrival can never be
// excluded, while a re-pruned rewatch title can never masquerade as new.
const ARRIVAL_MAX_RELEASE_AGE = 200;
                                    // (otherwise it's a release event, badged already)

function laterDate(a, b) { return !a ? b : !b ? a : (a >= b ? a : b); }
function earlierDate(a, b) { return !a ? b : !b ? a : (a <= b ? a : b); }

// Pure: effective OTT freshness + whether this is an "arrival event" worth a
// "New on <platform>" badge. Effective = the LATER of release-freshness and first
// sighting: a June release seen in June stays June; an April film first seen in
// July is fresh as of July; a 2024 title newly on the platform is fresh today.
function ottArrival(freshDate, firstSeen, now = Date.now()) {
  const days = (d) => (now - new Date(d).getTime()) / 864e5;
  const releaseAge = freshDate ? days(freshDate) : null;
  // A real arrival: first-seen recently, and the release is neither too new (pre-release
  // provider listing) nor too old (a catalog title the ledger forgot and re-seeded today).
  const isArrival = !!firstSeen && days(firstSeen) <= ARRIVAL_BADGE_DAYS
    && (releaseAge == null || (releaseAge > ARRIVAL_MIN_RELEASE_AGE && releaseAge <= ARRIVAL_MAX_RELEASE_AGE));
  // Only promote ottFreshDate to the first-seen date for a genuine arrival. Otherwise keep
  // the true release date, so a stale catalog title stays correctly stale and the freshness
  // gate drops it instead of a today-stamped first-seen sneaking it back onto the site.
  const effective = isArrival ? (laterDate(freshDate, firstSeen) || null) : (freshDate || firstSeen || null);
  return { effective, isArrival };
}

// Pure: record one observation in a country's seen-map. Returns the firstSeen date.
// Mutates seenCountry (the caller owns persistence).
function recordOttSeen(seenCountry, key, freshDate, todayStr, coldStart) {
  const prior = seenCountry[key];
  if (prior) { prior.last = todayStr; return prior.first; }
  const first = coldStart ? (earlierDate(freshDate, todayStr) || todayStr) : todayStr;
  seenCountry[key] = { first, last: todayStr };
  return first;
}

// Pure: drop entries not observed within the retention window (bounds file size).
function pruneOttSeen(seenAll, now = Date.now()) {
  for (const code of Object.keys(seenAll || {})) {
    const m = seenAll[code];
    for (const k of Object.keys(m)) {
      const last = new Date(m[k].last || m[k].first || 0).getTime();
      if ((now - last) / 864e5 > SEEN_RETENTION_DAYS) delete m[k];
    }
  }
  return seenAll || {};
}

// Theatre freshness gate. THEATRE_WINDOW_DAYS previously only date-gated the per-language
// discover SUPPLEMENT — the now_playing pool passed through ungated, and TMDB keeps films
// in now_playing for many weeks, so month-old titles could top "Latest big-screen releases".
// filterTheatreFresh gates the WHOLE merged pool by release_date. SOFT: if the strict
// 21-day window leaves too few films to fill the section well (a quiet release week), it
// widens ONCE to the fallback window rather than shipping a thin list — freshness first,
// but never an empty section. A film with NO release_date can't prove freshness and is
// dropped (unlike OTT's null-keeps rule: theatrical releases always carry a date, so a
// missing one signals a junk record, not a too-new title). Future-dated films are kept
// (release-day timezone edge: TMDB dates are region-primary and can sit a few hours ahead).
// `now` is injectable for deterministic tests. Pure function -> unit-testable.
const THEATRE_WINDOW_DAYS = 21;          // strict 3-week window
const THEATRE_WINDOW_FALLBACK_DAYS = 35; // widened once when the strict pool runs thin
const THEATRE_MIN_POOL = 8;              // enough candidates to fill 7 slots with choice

// The visible "how fresh is this" line. Asserting a fixed window does not work: the gate
// is 21 days but widens to 35 whenever the strict pool runs thin, so a hardcoded "last 3
// weeks" is false on exactly the weeks the fallback fires. Measure the films actually
// rendered instead — then the line is true by construction, and on a good week it says
// something STRONGER than any fixed claim ("last 9 days" beats "last 3 weeks").
// Returns null rather than guessing when the dates aren't there.
function freshnessWindowLabel(items, now = Date.now(), bound = THEATRE_WINDOW_FALLBACK_DAYS, opts = {}) {
  // verb/dateOf differ per section because the two lists promise different things.
  // Theatres promise a RELEASE date. Streaming promises an ARRIVAL date - a 2019 film
  // that landed on Netflix yesterday belongs on the list, and saying "Released in the
  // last N days" about it would be false.
  //
  // Buckets, not raw day counts: "in the last 33 days" reads like a system log. Every
  // bucket ROUNDS UP, so the phrase is always true of the oldest item on the page while
  // staying readable. The top bucket is the one that matters - on a good week the line
  // says "this week", which agrees with the page heading instead of undercutting it.
  // verb + past are separate so each section reads as a NOUN PHRASE next to the count
  // badge ("TOP 7 \u00b7 Releases from the past three weeks"), not as a verb fragment.
  const verb = opts.verb || "Releases from";
  const past = opts.past || "the past";
  const dateOf = opts.dateOf || ((x) => x && x.released);
  const ages = (items || [])
    .map(dateOf)
    .filter(Boolean)
    .map((d) => (now - new Date(d).getTime()) / 864e5)
    .filter((a) => Number.isFinite(a) && a >= 0);
  if (!ages.length) return null;
  const oldest = Math.ceil(Math.max(...ages));
  // An out-of-window outlier (a re-release, a bad TMDB date) must not produce an absurd
  // label. Past the gate we stop naming a window rather than print a wrong one.
  if (oldest > bound) return null;
  if (oldest <= 7) return `${verb} this week`;
  const weeks = Math.ceil(oldest / 7);
  const WORD = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven" };
  return `${verb} ${past} ${WORD[weeks] || weeks} weeks`;
}
function filterTheatreFresh(pool, now = Date.now()) {
  const within = (m, days) => {
    if (!m.release_date) return false;
    const age = (now - new Date(m.release_date).getTime()) / 864e5;
    return age <= days;
  };
  const strict = pool.filter((m) => within(m, THEATRE_WINDOW_DAYS));
  if (strict.length >= THEATRE_MIN_POOL) return strict;
  return pool.filter((m) => within(m, THEATRE_WINDOW_FALLBACK_DAYS));
}

// OTT recency-decay ranking bonus. The 75-day gate (isOttFresh) decides WHO may be on the
// list; this decides WHERE within it. Without it, ranking inside the window was pure
// quality, so a high-rated near-expiry season could camp at #3 above week-old drops for
// weeks (the FROM-at-74-days case). Linear decay from OTT_RECENCY_MAX at freshDate=today
// to 0 at OTT_FRESH_DAYS, on the same 0..1 scale as the weighted402535 score (whose base
// spans roughly 0.4..1.0) — enough that among comparable titles the newest leads, but a
// clearly stronger title still holds its slot. Null or future freshDate -> 0 (recency
// can't be proven for ranking; the gate already decided admission). Pure -> unit-testable.
const OTT_RECENCY_MAX = 0.15;
function ottRecencyBonus(freshDate, now = Date.now()) {
  if (!freshDate) return 0;
  const age = (now - new Date(freshDate).getTime()) / 864e5;
  if (age < 0 || age > OTT_FRESH_DAYS) return 0;
  return OTT_RECENCY_MAX * (1 - age / OTT_FRESH_DAYS);
}

// ============================================================================
// LIST INTEGRITY + HONEST SPLIT — nothing visibly wrong may ever render.
// 1. ottRenderable: a movie whose release date is in the FUTURE cannot be
//    "Streaming Now" — a TMDB provider entry for it is a pre-order/pre-add
//    listing (the Drishyam 3 class of bug). Same for a future TV season date.
//    Coming Soon is built separately, so dropped items aren't lost to users.
// 2. hasCardSubstance: a card with neither a rating nor a synopsis is a
//    threadbare trust leak; it sinks below complete cards (and usually off
//    the list at the OTT_MAX cut).
// 3. isStillWorthIt: the "Streaming Now" heading promises this week. Titles
//    whose effective freshness is older than STILL_WORTH_DAYS are partitioned
//    below a visible "Still worth it" divider instead of impersonating news.
// All pure -> unit-testable. Order inside each partition is preserved.
// ============================================================================
const STILL_WORTH_DAYS = 10;
function ottRenderable(item, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  if (item.kind === "movie" && item.released && item.released > today) return false;
  if (item.kind === "tv" && item.freshDate && item.freshDate > today) return false;
  return true;
}
function hasCardSubstance(item) { return item.rating != null || !!item.review; }
function isStillWorthIt(item, now = Date.now()) {
  const d = item.ottFreshDate || item.freshDate || item.released;
  if (!d) return true; // can't prove it's new -> never claim it is
  return (now - new Date(d).getTime()) / 864e5 > STILL_WORTH_DAYS;
}
function orderOttForDisplay(list, now = Date.now()) {
  const gated = list.filter((it) => ottRenderable(it, now));
  const part = (arr, pred) => [arr.filter(pred), arr.filter((x) => !pred(x))];
  const [fresh, older] = part(gated, (it) => !isStillWorthIt(it, now));
  for (const it of older) it.stillGood = true; // serialized -> client renders the divider too
  const sink = (arr) => { const [a, b] = part(arr, hasCardSubstance); return [...a, ...b]; };
  return [...sink(fresh), ...sink(older)];
}

// Freshness badge for a card, derived from freshDate — the REAL recency signal (a movie's
// release date, or a TV series' LATEST-season air date). The old badge keyed off
// release_date/first_air_date, so a returning show's new season could never earn one
// (first_air_date is the series' original launch — 2022 for House of the Dragon). Movies:
// "New release" within 7 days. TV: 14 days (streaming seasons roll out weekly — a season
// is still news in week two), labelled "New show" for a first season and "New season" for
// a returning one. Small negative-age tolerance covers release-day timezone skew; anything
// further in the future gets no badge (it isn't out). Pure -> unit-testable.
const BADGE_MOVIE_DAYS = 7, BADGE_TV_DAYS = 14;
function freshBadge(kind, freshDate, now = Date.now(), seasonCount = null) {
  if (!freshDate) return null;
  const age = (now - new Date(freshDate).getTime()) / 864e5;
  if (age < -1) return null; // not released yet
  if (kind === "tv") {
    if (age > BADGE_TV_DAYS) return null;
    return seasonCount === 1 ? "New show" : "New season";
  }
  return age <= BADGE_MOVIE_DAYS ? "New release" : null;
}




function freshLabel(item, now = Date.now(), locale = "en-IN") {
  // TV needs freshDate (latest season, not the series launch). Movies prefer `released`
  // (the region-localized date the modal already shows) over freshDate (TMDB's global
  // primary date), so the card and modal never show two different dates for one film.
  const d = item.kind === "tv" ? (item.freshDate || item.released) : (item.released || item.freshDate);
  if (!d) return "";
  if (item.kind === "tv" && (now - new Date(d)) > 400 * 864e5) return ""; // a years-old season date reads as a bug next to a "New on ..." badge
  // "Latest season 7 Aug" on a one-season show reads like a mistake — and TMDB classifies
  // some Indian films as series, so this fires more often than you'd think. Only claim a
  // "latest season" when there is more than one.
  const tvMulti = item.kind === "tv" && (item.seasons || 0) > 1;
  return (tvMulti ? "Latest season " : "Released ") + fmtDateShort(d, now, locale);
}

// A badge on 6 of 7 cards is decoration, not signal. Keep "Trending" only on the top
// TREND_CAP items per section per country, ranked by weekly Wikipedia views (the same
// number that earned the badge). Pure demotion — wikiWeeklyViews stays on every item for
// the detail pages, and the threshold logic is untouched.
const TREND_CAP = 2;
function capTrending(dataByCode) {
  for (const data of Object.values(dataByCode)) {
    for (const list of [data.theatres, data.ott]) {
      if (!Array.isArray(list)) continue;
      const ranked = list.filter((it) => it.trending)
        .sort((a, b) => (b.wikiWeeklyViews || 0) - (a.wikiWeeklyViews || 0));
      for (const it of ranked.slice(TREND_CAP)) delete it.trending;
    }
  }
}

module.exports = {
  ARRIVAL_BADGE_DAYS,
  ARRIVAL_MAX_RELEASE_AGE,
  ARRIVAL_MIN_RELEASE_AGE,
  capTrending,
  earlierDate,
  filterTheatreFresh,
  freshBadge,
  freshLabel,
  freshnessWindowLabel,
  hasCardSubstance,
  isStillWorthIt,
  laterDate,
  orderOttForDisplay,
  OTT_RECENCY_MAX,
  OTT_SEEN_FILE,
  ottArrival,
  ottRecencyBonus,
  ottRenderable,
  pruneOttSeen,
  recordOttSeen,
  SEEN_RETENTION_DAYS,
  STILL_WORTH_DAYS,
  THEATRE_MIN_POOL,
  THEATRE_WINDOW_DAYS,
  THEATRE_WINDOW_FALLBACK_DAYS,
};
