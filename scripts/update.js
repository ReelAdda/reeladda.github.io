// ReelAdda weekly updater v2 — runs automatically via GitHub Actions.
// Fetches theatre + OTT releases with full details (trailer, cast, runtime,
// certificate, all streaming platforms), upcoming releases, and marks
// what's new since last week's scan. Writes data.json for the website.

const fs = require("fs");
const zlib = require("zlib");
const API_KEY = process.env.TMDB_API_KEY;
const BASE = "https://api.themoviedb.org/3";

// ============================================================================
// RATINGS SOURCE — the one switch that decides where star ratings come from.
//   "imdb" : use IMDb's daily non-commercial dataset for ratings/votes (more
//            authoritative, MORE votes) — but the dataset is NON-COMMERCIAL.
//            Use only while this site earns NO revenue (no ads/affiliate/etc.).
//   "tmdb" : use TMDB's vote_average/vote_count — commercially licensed (free,
//            attribution only). Switch to this BEFORE you monetize.
// The footer attribution follows this automatically, so the credit always matches
// the data actually used. To flip: change this one line, commit, run the workflow.
const RATINGS_SOURCE = process.env.RATINGS_SOURCE || "tmdb"; // "imdb" | "tmdb"
const USE_IMDB = RATINGS_SOURCE === "imdb";

if (!API_KEY && !process.env.PAGES_ONLY && require.main === module) {
  console.error("Missing TMDB_API_KEY. Add it in GitHub repo Settings → Secrets.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TMDB fetch with retry + exponential backoff. Transient failures (429 rate-limit, 5xx,
// network errors) are retried up to MAX_RETRIES with growing delays, honoring the server's
// Retry-After header when present. A 4xx other than 429 fails fast (it won't fix on retry).
// This protects the daily build from a single network hiccup corrupting a country's output.
const TMDB_MAX_RETRIES = 4;
async function tmdb(path, params = {}) {
  const url = new URL(BASE + path);
  url.searchParams.set("api_key", API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let lastErr;
  for (let attempt = 0; attempt <= TMDB_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();

      // 429 / 5xx are transient -> retry. Other 4xx are permanent -> fail fast.
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === TMDB_MAX_RETRIES) {
        throw new Error(`TMDB ${path} failed: ${res.status}`);
      }
      // Honor Retry-After (seconds) if given, else exponential backoff (0.5s,1s,2s,4s) + jitter.
      const retryAfter = parseFloat(res.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      console.warn(`TMDB ${path} -> ${res.status}, retry ${attempt + 1}/${TMDB_MAX_RETRIES} in ${Math.round(backoff)}ms`);
      await sleep(backoff);
    } catch (e) {
      // Network-level error (fetch threw): retry with backoff unless out of attempts.
      lastErr = e;
      if (attempt === TMDB_MAX_RETRIES || /failed: \d/.test(e.message)) throw e;
      const backoff = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      console.warn(`TMDB ${path} network error: ${e.message}, retry ${attempt + 1}/${TMDB_MAX_RETRIES} in ${Math.round(backoff)}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr || new Error(`TMDB ${path} failed after retries`);
}

// Per-country configuration. Each country runs the SAME pipeline parameterised by region,
// watch_region, priority languages, and soft quotas. INDIA IS FIRST and reproduces the
// existing single-country behaviour EXACTLY — its regionalLangs order, targets, and soon
// quota match the previous hardcoded values, so its output stays byte-for-byte identical.
const COUNTRIES = [
  {
    code: "in", name: "India", region: "IN", watchRegion: "IN",
    priorityLangs: ["hi", "ta", "te"],
    regionalLangs: ["hi", "ta", "te", "ml", "kn", "pa", "mr", "bn"], // order = India's regionalOrder
    ottRegionalLangs: ["hi", "ta", "te", "ml", "kn", "pa", "mr", "bn"], // OTT regional pool langs
    theatreTargets: [["hi", 3], ["en", 2], ["ta", 1], ["te", 1]],
    soonTargets: [["en", 3], ["hi", 3], ["__regional__", 2]],
  },
  {
    code: "us", name: "United States", region: "US", watchRegion: "US",
    priorityLangs: ["en", "es"],
    regionalLangs: ["es"],
    ottRegionalLangs: ["es"],
    theatreTargets: [["en", 5], ["es", 1]],
    soonTargets: [["en", 5], ["es", 1], ["__regional__", 2]],
  },
  {
    code: "uk", name: "United Kingdom", region: "GB", watchRegion: "GB",
    priorityLangs: ["en"],
    regionalLangs: ["hi", "pa"],
    ottRegionalLangs: [], // English-only OTT: fill all slots from international (English) trending
    theatreTargets: [["en", 6]],
    soonTargets: [["en", 6], ["__regional__", 2]],
  },
  {
    code: "au", name: "Australia", region: "AU", watchRegion: "AU",
    priorityLangs: ["en"],
    regionalLangs: ["hi", "zh", "ko"],
    ottRegionalLangs: [], // English-only OTT: fill all slots from international (English) trending
    theatreTargets: [["en", 6]],
    soonTargets: [["en", 6], ["__regional__", 2]],
  },
  {
    code: "de", name: "Germany", region: "DE", watchRegion: "DE",
    priorityLangs: ["de", "en"],
    regionalLangs: ["de"],
    ottRegionalLangs: ["de"],
    theatreTargets: [["de", 5], ["en", 2]],
    soonTargets: [["de", 5], ["en", 2], ["__regional__", 1]],
  },
  // ---- Diaspora markets: countries where FilmyChill's India strength IS the edge. ----
  // UAE: ~3.5M Indian expats; Indian films routinely top the UAE box office, with
  // Malayalam cinema disproportionately huge (Kerala diaspora) alongside Hindi/Tamil.
  {
    code: "ae", name: "UAE", region: "AE", watchRegion: "AE",
    priorityLangs: ["hi", "en", "ml"],
    regionalLangs: ["hi", "ml", "ta", "te", "ar"],
    ottRegionalLangs: ["hi", "ml", "ta", "te"],
    theatreTargets: [["hi", 2], ["en", 2], ["ml", 1], ["ta", 1]],
    soonTargets: [["en", 2], ["hi", 2], ["__regional__", 2]],
  },
  // Canada: the Punjabi-cinema capital outside India (Brampton/Surrey) plus a large
  // Hindi audience; French included for Quebec theatrical coverage.
  {
    code: "ca", name: "Canada", region: "CA", watchRegion: "CA",
    priorityLangs: ["en", "pa", "hi"],
    regionalLangs: ["pa", "hi", "fr", "ta"],
    ottRegionalLangs: ["pa", "hi"],
    theatreTargets: [["en", 4], ["pa", 1], ["hi", 1]],
    soonTargets: [["en", 4], ["__regional__", 3]],
  },
  // Singapore: Tamil is an official language; strong Mandarin-language box office too.
  {
    code: "sg", name: "Singapore", region: "SG", watchRegion: "SG",
    priorityLangs: ["en", "ta", "zh"],
    regionalLangs: ["ta", "zh", "hi", "ms"],
    ottRegionalLangs: ["ta", "zh"],
    theatreTargets: [["en", 4], ["ta", 1], ["zh", 1]],
    soonTargets: [["en", 4], ["ta", 1], ["__regional__", 2]],
  },
];

// Manual exclusion list — films that should NEVER appear regardless of what TMDB returns
// (banned in India, pulled from release, festival-only, or otherwise mislisted as current
// theatrical). TMDB exposes no "banned"/"still in theatres" signal, so this is a human
// override. To block a film: find its TMDB ID (in data.json as tmdbId, or the TMDB URL,
// e.g. themoviedb.org/movie/1692948) and add it below with a short note.
const EXCLUDE_IDS = new Set([
  1692948, // Chardikala — banned in India / not in theatres
  1155818, // Satluj — banned in India
  1725370, // Satluj — DUPLICATE TMDB record of the banned film (new id, same movie)
]);
// TITLE-level exclusions: TMDB grows duplicate records for Indian releases (new id,
// same film), and an id blocklist can't see the next duplicate. Titles here are
// matched by slug, so casing/punctuation variants ("Satluj!", "SATLUJ") all die too.
// Keep entries lowercase-slug form. Removing a title re-admits every record of it.
const EXCLUDE_TITLES = new Set([
  "satluj",     // banned in India
  "chardikala", // banned in India
]);
// One predicate for every pool: blocked by id OR by slugified title (movies use
// `title`, TV uses `name`; enriched items use `title` — cover all three).
function isExcluded(c) {
  if (!c) return false;
  if (EXCLUDE_IDS.has(c.id) || EXCLUDE_IDS.has(c.tmdbId)) return true;
  const t = c.title || c.name;
  return t ? EXCLUDE_TITLES.has(slugify(t)) : false;
}

const LANG = { en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", ml: "Malayalam", kn: "Kannada", ko: "Korean", ja: "Japanese", es: "Spanish", fr: "French", mr: "Marathi", bn: "Bengali", pa: "Punjabi", gu: "Gujarati", de: "German", it: "Italian", pt: "Portuguese", zh: "Chinese" };

function verdict(rating, votes) {
  if (!votes || votes < 10) return "Not enough ratings yet";
  if (rating >= 7.5) return "Must watch";
  if (rating >= 6.5) return "Worth a watch";
  if (rating >= 5.5) return "Decent one-time watch";
  return "Skip unless curious";
}

function trim(text, n = 160) {
  if (!text) return "";
  if (text.length <= n) return text;
  // Prefer ending at a sentence boundary when one exists past 60% of the budget — a
  // complete sentence reads finished; a mid-thought "…" reads broken. Fall back to the
  // old word-boundary cut when the last sentence end is too early (or absent).
  const slice = text.slice(0, n);
  let cut = -1;
  for (const m of slice.matchAll(/[.!?](?:\s|$)/g)) cut = m.index;
  if (cut >= Math.floor(n * 0.6)) return slice.slice(0, cut + 1);
  return slice.replace(/\s+\S*$/, "") + "…";
}

// OTT freshness window: how recent a title's EFFECTIVE freshness date (release/season date
// OR first sighting on a platform — see first-seen tracking below) must be to count as a
// current OTT release. Tightened from 75 to 45 days: with first-seen tracking, a late OTT
// arrival stays fresh via its arrival date, so the wide release-date window is no longer
// needed to protect those — 45d keeps the list genuinely current. Revert knob: set 75.
const OTT_FRESH_DAYS = 45;

// Derive the freshness date for an OTT title from a TMDB detail object.
// MOVIE: its release_date. TV: the air date of the most recent NON-special season (season 0
// is specials) — NOT the series' original launch, which for a long-running show (Rick and
// Morty = 2013) is meaningless for "is it fresh now". Falls back to last_air_date /
// first_air_date when per-season data is absent. Pure function -> unit-testable.
function deriveFreshDate(kind, d) {
  if (!d) return null;
  if (kind === "movie") return d.release_date || null;
  const seasonDates = (d.seasons || [])
    .filter((s) => s.season_number > 0 && s.air_date)
    .map((s) => s.air_date);
  return seasonDates.length ? seasonDates.sort().pop() : (d.last_air_date || d.first_air_date || null);
}

// Is an OTT item fresh enough to list? A null freshDate means TMDB has no date yet (genuinely
// too new) -> kept, so we never punish brand-new titles. A future or within-window date passes;
// anything older than OTT_FRESH_DAYS is a rewatch/catalogue title and is dropped. `now` is
// injectable for deterministic tests. Pure function -> unit-testable.
function isOttFresh(freshDate, now = Date.now()) {
  if (!freshDate) return true;
  const age = (now - new Date(freshDate).getTime()) / 864e5;
  return age <= OTT_FRESH_DAYS;
}

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
                                    // (otherwise it's a release event, badged already)

function laterDate(a, b) { return !a ? b : !b ? a : (a >= b ? a : b); }
function earlierDate(a, b) { return !a ? b : !b ? a : (a <= b ? a : b); }

// Pure: effective OTT freshness + whether this is an "arrival event" worth a
// "New on <platform>" badge. Effective = the LATER of release-freshness and first
// sighting: a June release seen in June stays June; an April film first seen in
// July is fresh as of July; a 2024 title newly on the platform is fresh today.
function ottArrival(freshDate, firstSeen, now = Date.now()) {
  const effective = laterDate(freshDate, firstSeen) || null;
  const days = (d) => (now - new Date(d).getTime()) / 864e5;
  const isArrival = !!firstSeen && days(firstSeen) <= ARRIVAL_BADGE_DAYS
    && (!freshDate || days(freshDate) > ARRIVAL_MIN_RELEASE_AGE);
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

let OTT_SEEN = null; // loaded once per process, written once after all countries build
function loadOttSeen() {
  if (OTT_SEEN) return OTT_SEEN;
  try { OTT_SEEN = pruneOttSeen(JSON.parse(fs.readFileSync(OTT_SEEN_FILE, "utf8"))); }
  catch { OTT_SEEN = {}; } // first ever run -> cold start for every country
  return OTT_SEEN;
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

// Human-readable freshness line for a card's meta row, so recency is VISIBLE, not implied:
// "Released 12 Jun" for movies, "Latest season 21 Jun" for TV (whose `released` field is
// the series' original launch and would mislead). Year is appended only when it differs
// from the current year, so a Dec title shown in Jan still reads unambiguously. Must stay
// in sync with the client-side freshLabel()/fmtDate() in index.html. Pure -> unit-testable.
function fmtDateShort(dateStr, now = Date.now(), locale = "en-IN") {
  const dt = new Date(dateStr);
  const opts = { day: "numeric", month: "short" };
  if (dt.getFullYear() !== new Date(now).getFullYear()) opts.year = "numeric";
  return dt.toLocaleDateString(locale, opts);
}
function freshLabel(item, now = Date.now(), locale = "en-IN") {
  // TV needs freshDate (latest season, not the series launch). Movies prefer `released`
  // (the region-localized date the modal already shows) over freshDate (TMDB's global
  // primary date), so the card and modal never show two different dates for one film.
  const d = item.kind === "tv" ? (item.freshDate || item.released) : (item.released || item.freshDate);
  if (!d) return "";
  return (item.kind === "tv" ? "Latest season " : "Released ") + fmtDateShort(d, now, locale);
}

// ============================================================================
// BUZZ SIGNALS — two free, licence-clean sources that TMDB can't provide:
//   1. Wikipedia pageviews (keyless): how many people are READING about a title
//      this week -> "Trending" badge. Article resolved precisely via Wikidata's
//      IMDb-ID property (P345) — never by title search, so no wrong-article risk.
//   2. YouTube Data API (optional YT_API_KEY secret): trailer view counts ->
//      "▶ 52M trailer views" social proof. Skipped silently when the key is absent.
// Both attach BEFORE data files are written (client cards read data.json) and both
// degrade gracefully: any failure means a missing badge, never a failed build.
// ============================================================================
const YT_API_KEY = process.env.YT_API_KEY || "";
const WIKI_HEADERS = { "User-Agent": "FilmyChillBot/1.0 (https://filmychill.com; vikramksharma87@gmail.com)" };
const BUZZ_TREND_MIN_DAILY = 10000; // avg daily en-wiki views that always count as trending
const BUZZ_TREND_SPIKE = 1.5;       // ...or recent week >= 1.5x the prior week
const BUZZ_SPIKE_FLOOR = 3000;      //    (with a floor, so 20 -> 40 views never "trends")

// Pure: daily view counts (oldest -> newest, ideally 14 entries) -> buzz verdict.
// Trending = big in absolute terms OR clearly accelerating. < 7 days of data -> null
// (brand-new articles can't prove a trend yet).
function computeBuzz(daily) {
  if (!Array.isArray(daily) || daily.length < 7) return null;
  const recent = daily.slice(-7);
  const prior = daily.slice(0, -7);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const recentAvg = avg(recent);
  const priorAvg = prior.length ? avg(prior) : 0;
  const trending = recentAvg >= BUZZ_TREND_MIN_DAILY
    || (priorAvg > 0 && recentAvg >= BUZZ_SPIKE_FLOOR && recentAvg >= BUZZ_TREND_SPIKE * priorAvg);
  return { weeklyViews: Math.round(recent.reduce((x, y) => x + y, 0)), trending };
}

// Pure: social-proof number formatting ("52M", "3.4M", "850K"). Label only from 1M up —
// below that, a view count reads as ANTI-proof, so we show nothing.
function fmtViews(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n >= 1e9) return (n / 1e9 >= 10 ? Math.round(n / 1e9) : +(n / 1e9).toFixed(1)) + "B";
  if (n >= 1e6) return (n / 1e6 >= 10 ? Math.round(n / 1e6) : +(n / 1e6).toFixed(1)) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}
function trailerViewsLabel(n) {
  return Number.isFinite(n) && n >= 1e6 ? `▶ ${fmtViews(n)} trailer views` : null;
}

// Keyless JSON fetch with one retry — for Wikimedia + YouTube endpoints.
async function fetchJsonKeyless(url, headers = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return res.json();
      lastErr = new Error(`HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) break; // permanent -> don't retry
    } catch (e) { lastErr = e; }
    await sleep(600);
  }
  throw lastErr;
}

// IMDb ID -> English Wikipedia article title, via Wikidata's P345 (IMDb ID) property.
// Two keyless calls; returns null when the title has no Wikidata item or no enwiki article.
async function wikiArticleForImdb(imdbId) {
  const search = await fetchJsonKeyless(
    `https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`haswbstatement:"P345=${imdbId}"`)}&srlimit=1&format=json`,
    WIKI_HEADERS);
  const qid = search?.query?.search?.[0]?.title;
  if (!qid) return null;
  const ent = await fetchJsonKeyless(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json`,
    WIKI_HEADERS);
  return ent?.entities?.[qid]?.sitelinks?.enwiki?.title || null;
}

// Last 14 full days of pageviews for an article (ends yesterday — today is incomplete).
async function wikiDailyViews(article) {
  const day = (offset) => {
    const d = new Date(Date.now() - offset * 864e5);
    return d.toISOString().slice(0, 10).replace(/-/g, "") + "00";
  };
  const slug = encodeURIComponent(article.replace(/ /g, "_"));
  const j = await fetchJsonKeyless(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${slug}/daily/${day(14)}/${day(1)}`,
    WIKI_HEADERS);
  return (j?.items || []).map((x) => x.views);
}

// Attach Wikipedia buzz to every theatre + OTT item across all countries. Same film
// appears in several countries' lists and pageviews are en-wiki-global, so each unique
// IMDb ID is fetched ONCE and fanned out. No imdbId -> no badge (never guess articles).
async function attachBuzz(dataByCode) {
  const byImdb = new Map();
  for (const data of Object.values(dataByCode)) {
    for (const it of [...(data.theatres || []), ...(data.ott || [])]) {
      if (!it.imdbId) continue;
      if (!byImdb.has(it.imdbId)) byImdb.set(it.imdbId, []);
      byImdb.get(it.imdbId).push(it);
    }
  }
  let resolved = 0, trendingCount = 0;
  for (const [imdbId, items] of byImdb) {
    try {
      const article = await wikiArticleForImdb(imdbId);
      if (article) {
        const buzz = computeBuzz(await wikiDailyViews(article));
        if (buzz) {
          resolved++;
          if (buzz.trending) trendingCount++;
          for (const it of items) {
            it.wikiWeeklyViews = buzz.weeklyViews;
            if (buzz.trending) it.trending = true;
          }
        }
      }
    } catch (e) {
      console.warn(`  buzz: ${items[0].title} skipped (${e.message})`);
    }
    await sleep(120); // polite pace against Wikimedia (well under their guidance)
  }
  console.log(`Buzz: ${resolved}/${byImdb.size} titles resolved via Wikipedia, ${trendingCount} trending`);
  capTrending(dataByCode);
}

// A badge on 6 of 7 cards is decoration, not signal. Keep "Trending" only on the top
// TREND_CAP items per section per country, ranked by weekly Wikipedia views (the same
// number that earned the badge). Pure demotion — wikiWeeklyViews stays on every item
// for the detail pages, and the threshold logic above is untouched.
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

// ============================================================================
// CRITICS' TAKE — one opinionated line per film, sourced from people who have
// already done the research. Primary source: the "Reception" section of the
// film's English Wikipedia article (a human-written summary of real critic
// consensus), located precisely via the buzz module's Wikidata P345 lookup —
// never by title search. Fallback: TMDB user reviews (rating average only).
// The printed sentence is SYNTHESISED in our own words from extracted signals
// (overall tone + praised/criticised aspects) — never copied text — so it is
// licence-clean. Results are cached in takes.json (committed by the workflow):
//   { "<imdbId | kind:tmdbId>": { take, src, article, checked } }
// A title WITH a take is never re-fetched; a title WITHOUT one is re-checked
// each run (reception sections appear days after release) until it ages out of
// this week's lists. Everything degrades gracefully: no take -> no line shown,
// never a failed build.
// ============================================================================
const TAKES_FILE = "takes.json";
const TAKES_RETENTION_DAYS = 180; // prune cache entries not touched for this long
let TAKES = null;
function loadTakes() {
  if (TAKES) return TAKES;
  try { TAKES = JSON.parse(fs.readFileSync(TAKES_FILE, "utf8")); }
  catch { TAKES = {}; } // first ever run -> empty cache
  const cutoff = new Date(Date.now() - TAKES_RETENTION_DAYS * 864e5).toISOString().slice(0, 10);
  for (const k of Object.keys(TAKES)) if ((TAKES[k].checked || "") < cutoff) delete TAKES[k];
  return TAKES;
}

// Aspect vocabulary: pattern found in reception prose -> the plain noun we print.
// Order matters only for readability; matches are deduped by printed noun.
const TAKE_ASPECTS = [
  [/performances?|acting|\bcast\b|portrayals?|lead role/i, "performances"],
  [/screenplay|script\b|writing|dialogues?|\bwritten\b/i, "writing"],
  [/direction|filmmaking|direct(?:ed|orial)/i, "direction"],
  [/pacing|\bpace\b|slow(?:ly|-moving|-paced| burn)?|dragg?(?:ed|y|ing)|meander|plodding/i, "pacing"],
  [/humou?r|comedy|comedic|jokes|laughs?|funny/i, "humour"],
  [/action (?:sequences|scenes|set.?pieces)|stunts|\baction\b|fight (?:scenes|choreography)/i, "action"],
  [/soundtrack|\bmusic\b|\bscore\b|songs|background score|composer/i, "music"],
  [/visual effects|\bvfx\b|\bcgi\b|visuals|cinematography|camerawork|photography/i, "visuals"],
  [/animation|animated/i, "animation"],
  [/chemistry/i, "lead chemistry"],
  [/emotional (?:depth|core|weight|resonance|impact)|poignan|moving|heart(?:felt|warming|breaking)|tear/i, "emotional weight"],
  [/second half|climax|ending|final act|third act|\bfinale\b|last (?:act|half|hour)/i, "second half"],
  [/first half|opening|\bsetup\b|slow start|initial/i, "first half"],
  [/runtime|\blength\b|overlong|bloated|too long|tight(?:ly)?|lean\b/i, "runtime"],
  [/editing|edited|cuts?\b/i, "editing"],
  [/world.?building|production design|\bsets?\b|set (?:design|pieces)|art direction/i, "production design"],
  [/twists?|unpredictable|predictab/i, "twists"],
  [/original(?:ity)?|fresh(?:ness)?|inventive|derivative|formulaic|clich[eé]/i, "originality"],
  [/tension|suspense|thrill(?:ing|er)|gripping|edge.of.(?:your|the).seat/i, "tension"],
  [/tone\b|tonal/i, "tone"],
  [/character (?:development|arcs?|work)|characteri[sz]ation|well.drawn/i, "characters"],
  [/themes?|thematic|message|commentary|allegory/i, "themes"],
  [/ambitio(?:n|us)|scope|scale|epic|grand/i, "ambition"],
  [/costumes?|\bmakeup\b|prosthetic/i, "costumes"],
  [/atmosphere|mood| atmospheric|immersive/i, "atmosphere"],
  [/story|plot|narrative|storyline/i, "story"],
];
const TAKE_PRAISE_RE = /prais\w+|laud\w+|acclaim\w+|applaud\w+|compliment\w+|appreciat\w+|celebrated|singled out|won praise|drew praise|impressed|highlights?|stand.?out|well.?received|hail\w+|commend\w+|plaudits|admir\w+/i;
const TAKE_PAN_RE = /criticis\w+|criticiz\w+|panned|faulted|drew criticism|flak|bemoaned|lamented|complain\w+|weakest|disappoint\w+|letdown|drag(?:ged|s)?\b|uneven|flaws?|shortcomings?|derid\w+|dismiss\w+|lambast\w+|slam(?:med|s)\b|underwhelm\w+|lackluste?r\w*|reservations/i;
// Splits a sentence into single-polarity clauses. The extra alternation splits BEFORE
// praise/criticism noun groups — Wikipedia's single most common reception sentence is
// "mixed reviews, with praise for X and criticism of Y", which the old splitter kept as
// one clause; both polarity regexes fired on it and the whole thing was thrown away as
// ambiguous. That one skip is why so many films fell back to hollow tone-only lines.
const TAKE_CLAUSE_SPLIT_RE = /\bbut\b|\bhowever\b|\bwhile\b|\balthough\b|\bthough\b|;|,\s+(?=(?:and\s+)?(?:the|several|some|critics|reviewers|others|many)\b)|,?\s+(?:and|but|with)\s+(?=(?:some\s+|particular\s+|widespread\s+|general\s+)?(?:praise|criticism|acclaim|complaints?|reservations|plaudits)\b)/i;

// Pure: reception-section plain text -> { tone, praised[], panned[] } | null.
// Tone is decided by whichever verdict phrase appears EARLIEST (reception sections
// open with the overall consensus — usually the RT/Metacritic sentence). Aspects
// are assigned polarity per clause, so "praised X but criticised Y" splits right.
function analyzeReception(text) {
  if (!text || text.trim().length < 120) return null; // too thin to trust
  const t = text.slice(0, 6000);
  const tones = [
    ["acclaim", /universal acclaim|critical acclaim|widespread acclaim|rave reviews|overwhelmingly positive/i],
    ["positive", /generally (?:positive|favou?rable)|positive (?:reviews|response|reception)|mostly positive|favou?rable reviews|well received by critics/i],
    ["mixed", /mixed(?:[- ]to[- ](?:positive|negative))? (?:reviews|response|reception|critical)|mixed or average|polari[sz]ed|divided (?:critics|reviews|opinion)/i],
    ["negative", /generally (?:negative|unfavou?rable)|negative (?:reviews|response|reception)|critically panned|\bpanned\b|overwhelming dislike|unfavou?rable reviews/i],
  ];
  let tone = null, toneAt = Infinity;
  for (const [name, re] of tones) {
    const m = t.match(re);
    if (m && m.index < toneAt) { tone = name; toneAt = m.index; }
  }
  // Concrete anchor: a Rotten Tomatoes / Metacritic figure from the prose. A NUMBER
  // is the strongest substance a tone-only line can carry — "a 58% critics' score"
  // beats "all over the map". Captured as a fact, printed verbatim, never invented.
  let score = null;
  let sm = t.match(/(\d{1,3})%\s*(?:of critics|on (?:the )?review aggregator|approval)/i)
        || t.match(/approval rating of (\d{1,3})%/i)
        || t.match(/Rotten Tomatoes[^.]{0,40}?(\d{1,3})%/i)
        || t.match(/(\d{1,3})%[^.]{0,30}?Rotten Tomatoes/i);
  if (sm) { const n = +sm[1]; if (n >= 0 && n <= 100) score = { kind: "rt", value: n }; }
  if (!score) {
    const mc = t.match(/Metacritic[^.]{0,60}?(?:score of |weighted average (?:score )?of )?(\d{1,3})(?:\s*(?:out of|\/)\s*100)?/i);
    if (mc) { const n = +mc[1]; if (n >= 0 && n <= 100) score = { kind: "mc", value: n }; }
  }
  const praised = new Set(), panned = new Set();
  for (const sentence of t.split(/(?<=[.!?])\s+/)) {
    for (const clause of sentence.split(TAKE_CLAUSE_SPLIT_RE)) {
      const isPraise = TAKE_PRAISE_RE.test(clause);
      const isPan = TAKE_PAN_RE.test(clause);
      if (isPraise === isPan) continue; // neither, or ambiguous clause -> skip
      for (const [re, noun] of TAKE_ASPECTS) {
        if (re.test(clause)) (isPraise ? praised : panned).add(noun);
      }
    }
  }
  for (const n of praised) if (panned.has(n)) { praised.delete(n); panned.delete(n); } // contested -> drop
  if (!tone && !praised.size && !panned.size && !score) return null;
  return { tone, praised: [...praised].slice(0, 2), panned: [...panned].slice(0, 1), score };
}

// Pure: analysis -> one original opinionated sentence (never source text). null when
// there is genuinely nothing to say — an absent line beats a hollow one.
// Tone-only variant pools: when the extractor finds a verdict but no aspects, several
// cards can share the same sentence and the human-voice illusion cracks. Each pool's
// variant is picked DETERMINISTICALLY by seed (the title's tmdbId), so a film keeps the
// same line across runs — variety across the page, stability across days. Index 0 keeps
// the original phrasing so a missing seed degrades to prior behaviour.
const TAKE_VARIANTS = {
  acclaim: [
    `Critics loved this one; reception has been close to universal acclaim.`,
    `Reviewers were close to unanimous — this one landed.`,
    `Almost nobody had a bad word for it.`,
    `The critical verdict is rare-air positive.`,
    `Wall-to-wall praise from the critics on this one.`,
    `Critics came away raving.`,
  ],
  positive: [
    `Critics have been largely positive on this one.`,
    `The reviews lean clearly positive.`,
    `Most critics came away happy.`,
    `Word from reviewers is solidly good.`,
    `The critical consensus tilts firmly positive.`,
    `Reviewers found plenty to like here.`,
  ],
  mixed: [
    `Critics are genuinely split on this one.`,
    `Reviews are all over the map on this one.`,
    `Critics couldn't agree — expect a love-it-or-hate-it watch.`,
    `Opinions split right down the middle on this one.`,
    `One critic's favourite, the next one's skip — that kind of film.`,
    `The reviews refuse to agree on this one.`,
  ],
  negative: [
    `Critics were not impressed with this one.`,
    `The reviews were not kind.`,
    `Critics largely gave this one a pass.`,
    `Reviewers came away cold on this one.`,
    `Critics found little to love here.`,
    `A rough outing with the reviewers.`,
  ],
};
// If a take is one of the tone-only pool lines, re-pick the variant for THIS film's
// seed. Cached entries from before the variant system all sit at index 0, which put
// the identical sentence on three cards of one page. Aspect-bearing takes (unique by
// construction) pass through untouched. Pure, deterministic, zero network.
function reseedTake(take, seed = 0) {
  if (!take) return take;
  for (const pool of Object.values(TAKE_VARIANTS)) {
    if (pool.includes(take)) return pool[Math.abs(Number(seed) || 0) % pool.length];
  }
  return take;
}

// True when a take is a tone-only pool line — a verdict with zero substance. Used to
// invalidate stale cache entries: takes.json holds lines written by OLDER extractors
// ("Reviews are all over the map on this one" survives forever because refetch only
// fired on missing takes). Bumping TAKE_VERSION re-analyses every pooled title ONCE
// with the current, deeper extractor; aspect-bearing takes (unique by construction)
// are never touched. If re-analysis still finds nothing for a mixed verdict, the line
// is dropped entirely — absent beats hollow.
const TAKE_VERSION = 3; // v3: takes must be number-free (score text clashed with the rating pill)
function isPoolTake(take) {
  if (!take) return false;
  return Object.values(TAKE_VARIANTS).some((pool) => pool.includes(take));
}

function composeTake(a, seed = 0) {
  if (!a) return null;
  const list = (arr) => (arr.length === 2 ? `${arr[0]} and ${arr[1]}` : arr[0]);
  const p = a.praised.length ? list(a.praised) : null;
  const c = a.panned.length ? a.panned[0] : null;
  const vary = (pool) => pool[Math.abs(Number(seed) || 0) % pool.length];
  // A concrete aggregator figure, phrased for a human. This is the substance that
  // rescues a tone-only verdict from vagueness — "a 58% critics' score" is a fact
  // the reader can weigh, not a mood. NO NUMBERS in the take text — an RT% or
  // Metacritic figure next to the card's TMDB rating pill reads as the site
  // contradicting itself (96% vs 6.9/10 are different scales, but the reader
  // can't know that). The extracted score still informs WHICH sentence we pick
  // (it's hard evidence of division/acclaim); it just never gets printed.
  switch (a.tone) {
    case "acclaim":
      if (p) return `Critics loved it — special praise for the ${p}.`;
      return vary(TAKE_VARIANTS.acclaim);
    case "positive":
      if (p && c) return `Critics liked it: the ${p} won praise, though the ${c} drew some flak.`;
      if (p) return `Critics liked it, especially the ${p}.`;
      if (c) return `Critics were broadly positive, with reservations about the ${c}.`;
      return vary(TAKE_VARIANTS.positive);
    case "mixed":
      if (p && c) return `Critics are split — praise for the ${p}, pushback on the ${c}.`;
      if (p) return `Critics are split, though the ${p} found admirers.`;
      if (c) return `Critics are split, with the ${c} drawing most complaints.`;
      if (a.score) return `Genuinely divisive — critics can't settle this one.`; // aggregator-backed, so a firm claim is honest
      return null; // UPGRADE 3: no aspect, no evidence -> stay silent, don't say "all over the map"
    case "negative":
      if (c) return `Critics were rough on it, mostly over the ${c}.`;
      return vary(TAKE_VARIANTS.negative);
    default:
      if (p && c) return `Reviewers praised the ${p} but flagged the ${c}.`;
      if (p) return `Reviewers singled out the ${p} for praise.`;
      if (c) return `Reviewers' main gripe: the ${c}.`;
      return null;
  }
}

// English-Wikipedia reception section as plain text, or null if the article has none.
// Uses TextExtracts (keyless); sub-headings inside the section are stripped, their
// prose kept, so "=== Critical response ===" under "== Reception ==" still counts.
// One extract fetch now serves TWO editorial features: the article LEAD (framing facts —
// remake/sequel/adaptation/festival, extracted by extractHook) and the RECEPTION section
// (critic consensus, analysed by analyzeReception). Same single keyless call as before.
async function wikiExtract(article) {
  const j = await fetchJsonKeyless(
    `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(article)}`,
    WIKI_HEADERS);
  const page = Object.values(j?.query?.pages || {})[0];
  const text = page?.extract || "";
  const lead = text.split(/\n==[^=]/)[0].slice(0, 2500); // everything before the first section
  const m = text.match(/\n==+\s*(?:Critical (?:response|reception)|Reception|Reviews|Critical and audience response)\s*==+\n([\s\S]*?)(?=\n==[^=]|$)/i);
  const reception = m ? m[1].replace(/\n==+[^=\n]+==+\n/g, "\n") : null;
  return { lead, reception };
}

// ============================================================================
// THE HOOK — one framing fact per film, the line every human editor leads
// with: "A remake of the Malayalam film X" / "The follow-up to Y" / "Based on
// Hugh Howey's novels" / "Premiered at Cannes". Extracted from the Wikipedia
// lead paragraph (facts, composed in our own words — licence-clean), cached in
// takes.json next to the take. Pure -> unit-testable. One hook max, by
// priority: remake > sequel/spin-off > adaptation > festival > debut. Absent
// beats invented: no pattern, no hook.
// ============================================================================
function extractHook(lead, item = {}) {
  if (!lead || lead.length < 60) return null;
  const t = lead.replace(/\s+/g, " ");
  const clean = (x) => x.trim().replace(/["'\u2018\u2019\u201c\u201d]/g, "").replace(/\s+/g, " ").slice(0, 48);
  // Titles/names in lead prose end at a clause boundary: punctuation, a parenthetical
  // (usually the year), or " and/which/that " followed by a lowercase word — the
  // lowercase requirement keeps titles like "Rick and Morty" intact while stopping
  // "Gatta Kusthi and continues the story". Lazy captures + this lookahead.
  const B = String.raw`(?=,|\.|;|:|\(| and [a-z]| which | that |$)`;
  let m;
  if ((m = t.match(new RegExp(String.raw`remake of (?:the )?(?:\d{4} )?(?:([A-Z]\w+)(?:-language)? )?film ["'\u2018\u201c]?([A-Z][^.;,("'\u2019\u201d]{1,45}?)${B}`))))
    return `A remake of the ${m[1] ? m[1] + " " : ""}film \u2018${clean(m[2])}\u2019.`;
  if ((m = t.match(new RegExp(String.raw`(?:a |the )?sequel to (?:the \d{4} film |the film )?["'\u2018\u201c]?([A-Z][^.;,("'\u2019\u201d]{1,45}?)${B}`))))
    return `The follow-up to \u2018${clean(m[1])}\u2019.`;
  if ((m = t.match(new RegExp(String.raw`spin-?off (?:of|from) (?:the )?([A-Z][^.;,("]{1,45}?)${B}`))))
    return `A spin-off of ${clean(m[1])}.`;
  if (/based on (?:a )?true (?:events|story)|based on real events/i.test(t))
    return `Based on true events.`;
  if ((m = t.match(new RegExp(String.raw`based on the (novel|book|manga|play|short story|webtoon|comic book series|comics)(?: series)? ["'\u2018\u201c]?([A-Z][^.;,("'\u2019\u201d]{1,45}?)["'\u2019\u201d]? by ([A-Z][\w. -]{1,32}?)${B}`))))
    return `Based on ${clean(m[3])}'s ${m[1]} \u2018${clean(m[2])}\u2019.`;
  if ((m = t.match(new RegExp(String.raw`based on the (novel|book|manga|play|short story|webtoon|comics)(?: series)? (?:of the same name )?by ([A-Z][\w. -]{1,32}?)${B}`))))
    return `Based on the ${m[1]} by ${clean(m[2])}.`;
  if ((m = t.match(new RegExp(String.raw`premiered at the (?:\d{4} )?(?:\d+(?:st|nd|rd|th) )?([A-Z][^.;,(]{1,45}?(?:Film Festival|Festival de Cannes))`))))
    return `Premiered at the ${clean(m[1])}.`;
  if (/directorial debut/.test(t) && item.director)
    return `${item.director}'s directorial debut.`;
  return null;
}

// ============================================================================
// AUDIENCE COUNTERPOINT — the most interesting editorial fact is DISAGREEMENT.
// When the critics' take and the audience rating point opposite ways, say so.
// Computed fresh each run from data already on the item (ratings move; cached
// take text doesn't), so it stays current without any network. Pure.
// ============================================================================
function audienceCounterpoint(item) {
  if (!item || !item.take || item.rating == null) return null;
  const votes = item.imdbRating != null ? (item.imdbVotes || 0) : (item.votes || 0);
  if (votes < 50) return null; // too few voters to call it an audience
  const negTake = /rough on it|not impressed|not kind|gave this one a pass|came away cold/i.test(item.take);
  const splitTake = /split|all over the map|couldn't agree|down the middle|divisive|can't settle/i.test(item.take);
  const posTake = /loved|liked it|largely positive|lean clearly positive|came away happy|solidly good|rare-air/i.test(item.take);
  if ((negTake || splitTake) && item.rating >= 7.5)
    return `Audiences disagree \u2014 viewers rate it far higher.`;
  if (posTake && item.rating <= 5.5)
    return `Audiences are cooler on it than the critics were.`;
  return null;
}

// Fallback: TMDB user reviews. Only the rating AVERAGE is used (a fact, not text) and
// only when at least 2 rated reviews exist — one opinion is an anecdote, not a lean.
async function tmdbReviewTake(item) {
  if (!item.tmdbId) return null;
  const j = await tmdb(`/${item.kind === "tv" ? "tv" : "movie"}/${item.tmdbId}/reviews`, {});
  const ratings = (j?.results || []).map((r) => r?.author_details?.rating).filter((n) => Number.isFinite(n));
  if (ratings.length < 2) return null;
  const avg = ratings.reduce((x, y) => x + y, 0) / ratings.length;
  const lean = avg >= 7.5 ? "strongly positive" : avg >= 6 ? "positive" : avg >= 4.5 ? "mixed" : "negative";
  return `Early viewer reviews on TMDB ${lean === "mixed" ? "are mixed" : "lean " + lean}.`;
}

// Attach a critics' take to every theatre + OTT item across all countries. Same
// dedupe-and-fan-out shape as attachBuzz: each unique title is researched ONCE.
async function attachTakes(dataByCode) {
  const takes = loadTakes();
  const today = new Date().toISOString().slice(0, 10);
  const byKey = new Map();
  for (const data of Object.values(dataByCode)) {
    for (const it of [...(data.theatres || []), ...(data.ott || [])]) {
      const key = it.imdbId || (it.tmdbId ? `${it.kind}:${it.tmdbId}` : null);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(it);
    }
  }
  let found = 0;
  for (const [key, items] of byKey) {
    try {
      let entry = takes[key];
      // Refetch when: never seen; no take yet (reception sections appear late); a
      // LEGACY entry predating hooks (hook === undefined; found hooks are strings,
      // searched-but-absent is null) — those two wait for the daily gate; OR a stale
      // take from an older extractor version (tone-only pool line, or any take
      // containing a digit — v3 made takes number-free so they can't clash with the
      // rating pill). Version purges BYPASS the checked-today gate: they run exactly
      // once per entry (v gets stamped), so there's no re-fetch loop to protect
      // against, and waiting a day just leaves known-bad lines on the live site.
      const stalePool = !!entry && entry.v !== TAKE_VERSION && (isPoolTake(entry.take) || /\d/.test(entry.take || ""));
      const needsFetch = !entry || stalePool || ((!entry.take || entry.hook === undefined) && entry.checked !== today);
      if (needsFetch) {
        let take = entry?.take || null, src = entry?.src || null, hook = null;
        if (stalePool) { take = null; src = null; } // recompose from scratch with the current extractor
        let article = entry?.article || null;
        if (key.startsWith("tt")) { // real IMDb id -> precise Wikipedia route
          if (!article) article = await wikiArticleForImdb(key);
          if (article) {
            const { lead, reception } = await wikiExtract(article);
            hook = extractHook(lead, items[0]);
            if (!take) {
              const composed = composeTake(analyzeReception(reception), Number(items[0].tmdbId) || 0);
              if (composed) { take = composed; src = "wiki"; }
            }
          }
        }
        if (!take) {
          const t = await tmdbReviewTake(items[0]);
          if (t) { take = t; src = "tmdb"; }
        }
        entry = { take, src, hook, article: article || undefined, checked: today, v: TAKE_VERSION };
        takes[key] = entry;
        await sleep(150); // polite pace against Wikimedia
      } else {
        entry.checked = today; // touch so retention pruning keeps live titles
      }
      if (entry.take || entry.hook) {
        if (entry.take) found++;
        const seededTake = reseedTake(entry.take, Number(items[0].tmdbId) || 0);
        for (const it of items) {
          if (entry.take) {
            it.take = seededTake;
            it.takeSrc = entry.src;
            if (entry.src === "wiki" && entry.article) it.takeArticle = entry.article; // provenance -> JSON-LD citation
            // Disagreement is computed FRESH each run — ratings move, cached text doesn't.
            const counter = audienceCounterpoint(it);
            if (counter) it.takeCounter = counter;
          }
          if (entry.hook) it.hook = entry.hook;
        }
      }
    } catch (e) {
      console.warn(`  take: ${items[0].title} skipped (${e.message})`);
    }
  }
  fs.writeFileSync(TAKES_FILE, JSON.stringify(takes, null, 1));
  console.log(`Takes: ${found}/${byKey.size} titles have a critics' line`);
}

// Attach YouTube trailer view counts (theatres + OTT + coming soon — pre-release trailer
// hype is buzz too). One videos.list call per 50 unique trailers; ~2 calls/run total,
// costing ~2 of the 10,000 free daily quota units.
async function attachTrailerStats(dataByCode) {
  if (!YT_API_KEY) { console.log("Trailer stats: YT_API_KEY not set — skipping (optional feature)."); return; }
  const byYt = new Map();
  for (const data of Object.values(dataByCode)) {
    for (const it of [...(data.theatres || []), ...(data.ott || []), ...(data.comingSoon || [])]) {
      const id = ytIdOf(it.trailer);
      if (!id) continue; // search-URL fallback trailers have no video id
      if (!byYt.has(id)) byYt.set(id, []);
      byYt.get(id).push(it);
    }
  }
  const ids = [...byYt.keys()];
  let attached = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const j = await fetchJsonKeyless(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${chunk.join(",")}&key=${YT_API_KEY}`);
      for (const v of j?.items || []) {
        const n = Number(v?.statistics?.viewCount);
        if (!Number.isFinite(n)) continue;
        attached++;
        for (const it of byYt.get(v.id) || []) it.trailerViews = n;
      }
    } catch (e) { console.warn(`  trailer stats: chunk skipped (${e.message})`); }
  }
  console.log(`Trailer stats: views attached for ${attached}/${ids.length} trailers`);
}

// ---- Enriched film-page content (all DETERMINISTIC: derived from fields we already have,
// no LLM, no extra dependency). These produce ORIGINAL prose/structure so each /movie/*.html
// page is not just TMDB's synopsis reworded — which is what lifts it for SEO. Pure + tested.

// A multi-sentence verdict paragraph assembled from the item's own data. Distinct from the
// short `verdict` label ("Worth a watch"). Deterministic templating keyed on rating band,
// recency, runtime, and where-to-watch — no invented plot facts, so nothing can hallucinate.
function buildVerdictProse(item, countryName = "India", locale = "en-IN") {
  if (!item || !item.title) return "";
  const r = item.rating;
  const votes = item.imdbRating != null ? item.imdbVotes : item.votes;
  const isTv = item.kind === "tv";
  const noun = isTv ? "series" : "film";
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = item.released && item.released > today;

  // Opening clause keyed on rating band (or recency when unrated).
  let lead;
  if (r == null || !votes || votes < 10) {
    lead = upcoming
      ? `${item.title} is one of the more anticipated ${item.language || ""} releases on the calendar`.replace(/\s+/g, " ")
      : `${item.title} is a fresh ${item.language ? item.language + " " : ""}${noun} that's only just landed, so ratings are still settling`;
  } else if (r >= 7.5) {
    lead = `${item.title} lands among the stronger ${item.language || ""} ${noun}s on offer right now`.replace(/\s+/g, " ");
  } else if (r >= 6.5) {
    lead = `${item.title} is a solid, watchable ${item.language ? item.language + " " : ""}${noun} that mostly delivers on what it promises`;
  } else if (r >= 5.5) {
    lead = `${item.title} is a middling ${item.language ? item.language + " " : ""}${noun} — fine for a one-time watch but unlikely to stay with you`;
  } else {
    lead = `${item.title} struggles to land, and the ratings reflect a ${noun} that misfires more than it works`;
  }

  // Rating sentence (only when we actually have one with enough votes).
  let ratingBit = "";
  if (r != null && votes >= 10) {
    const src = item.imdbRating != null ? "IMDb" : "TMDB";
    ratingBit = ` It carries a ${Number(r).toFixed(1)}/10 on ${src} across ${Number(votes).toLocaleString(locale)} ratings, which puts it ${r >= 7 ? "comfortably above average" : r >= 6 ? "around the middle of the pack" : "below the bar for most viewers"}.`;
  }

  // Runtime / format note.
  let formatBit = "";
  if (item.runtime) {
    formatBit = isTv
      ? ` Episodes run about ${item.runtime} minutes.`
      : item.runtime >= 150
        ? ` At ${item.runtime} minutes it's a long sit, so save it for when you've got the evening.`
        : item.runtime <= 100
          ? ` It's a tight ${item.runtime}-minute watch — easy to fit into a busy night.`
          : ` It runs a manageable ${item.runtime} minutes.`;
  }

  // Where-to-watch close.
  let whereBit = "";
  const provs = Array.isArray(item.providers) ? item.providers : [];
  if (upcoming && item.released) {
    whereBit = ` It releases ${item.released}; mark your calendar if it's on your list.`;
  } else if (provs.length) {
    whereBit = ` In ${countryName} you can stream it on ${provs.slice(0, 3).join(", ")}.`;
  } else if (item.platform === "Theatres") {
    whereBit = ` It's in theatres in ${countryName} now — best caught on the big screen.`;
  }

  return (lead.replace(/\.$/, "") + "." + ratingBit + formatBit + whereBit).trim();
}

// "Good to know" quick-scan facts. Returns an array of {label, value} pairs, each derived
// deterministically. Skips any fact it can't fill so the table never shows blanks.
function buildGoodToKnow(item) {
  if (!item) return [];
  const rows = [];
  const isTv = item.kind === "tv";

  if (item.runtime) {
    const v = isTv ? `~${item.runtime} min per episode`
      : item.runtime >= 150 ? `${item.runtime} min — long`
      : item.runtime <= 100 ? `${item.runtime} min — short`
      : `${item.runtime} min`;
    rows.push({ label: "Runtime", value: v });
  }
  if (item.cert) {
    const c = String(item.cert).toUpperCase();
    // Order matters: check restrictive/age-gated patterns BEFORE bare "U", because "U/A 16+"
    // starts with "U" but is NOT a universal rating.
    const family =
      /^(A|R|NC-17|18)/.test(c) ? "Adults only"
      : /(U\/A|UA|12|13|14|15|16|PG-13)/.test(c) ? "Older kids & up"
      : /^(U|G|7|PG)/.test(c) ? "Yes — family friendly"
      : "Check rating";
    rows.push({ label: "Watch with family?", value: `${item.cert} · ${family}` });
  }
  if (item.genre) rows.push({ label: "Genre", value: item.genre });
  if (item.language) rows.push({ label: "Language", value: item.language });
  const provs = Array.isArray(item.providers) ? item.providers : [];
  if (provs.length) rows.push({ label: "Best screen", value: "Stream at home" });
  else if (item.platform === "Theatres") rows.push({ label: "Best screen", value: "Theatre / big screen" });

  return rows;
}

// FAQ entries (question + answer), deterministic, for both on-page display AND FAQPage
// schema. Only questions we can answer truthfully from data are emitted.
function buildFaqs(item, countryName = "India") {
  if (!item || !item.title) return [];
  const faqs = [];
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = item.released && item.released > today;
  const provs = Array.isArray(item.providers) ? item.providers : [];
  const verdictLabel = item.verdict || "";

  // Q1: worth watching
  if (verdictLabel && !/verdict soon|enough ratings/i.test(verdictLabel)) {
    faqs.push({
      q: `Is ${item.title} worth watching?`,
      a: `${verdictLabel}.${item.rating != null ? ` It rates ${Number(item.rating).toFixed(1)}/10.` : ""} See FilmyChill's full take above.`,
    });
  }
  // Q2: where to watch
  let whereA;
  if (upcoming) whereA = `${item.title} hasn't released yet${item.released ? ` — it's due ${item.released}` : ""}. We'll list where to watch once it's out.`;
  else if (provs.length) whereA = `You can stream ${item.title} in ${countryName} on ${provs.join(", ")}.`;
  else if (item.platform === "Theatres") whereA = `${item.title} is currently playing in theatres across ${countryName}. An OTT release hasn't been announced yet.`;
  else whereA = `Streaming availability for ${item.title} in ${countryName} isn't confirmed yet — check back as platforms update.`;
  faqs.push({ q: `Where can I watch ${item.title}?`, a: whereA });

  // Q2b: OTT release date — how India actually asks about films ("<title> ott release
  // date"). Answers are state-aware: streaming -> platform (+ arrival date when our
  // first-seen tracking has one); theatrical/upcoming -> honestly "not announced yet",
  // with the true promise that this page updates the day it lands.
  if (item.kind !== "tv") {
    let ottA;
    const arrival = item.ottFreshDate || null;
    if (provs.length) {
      ottA = `${item.title} is already streaming in ${countryName} on ${provs.join(", ")}${arrival ? ` — it arrived on ${arrival}` : ""}.`;
    } else {
      ottA = `An OTT release date for ${item.title} hasn't been officially announced yet. This page updates automatically the day it starts streaming.`;
    }
    faqs.push({ q: `When is ${item.title} releasing on OTT? (OTT release date)`, a: ottA });
  }

  // Q3: family friendly (only if we have a cert)
  if (item.cert) {
    const c = String(item.cert).toUpperCase();
    const a =
      /^(A|R|NC-17|18)/.test(c) ? `${item.title} is rated ${item.cert} — aimed at adult audiences.`
      : /(U\/A|UA|12|13|14|15|16|PG-13)/.test(c) ? `${item.title} is rated ${item.cert}. Fine for older kids with guidance.`
      : /^(U|G|7|PG)/.test(c) ? `${item.title} is rated ${item.cert}, suitable for family viewing.`
      : `${item.title} is rated ${item.cert}.`;
    faqs.push({ q: `Is ${item.title} family friendly?`, a });
  }
  // Q4: language (helps regional long-tail search)
  if (item.language) {
    faqs.push({ q: `What language is ${item.title} in?`, a: `${item.title} is a ${item.language} ${item.kind === "tv" ? "series" : "film"}${item.genre ? ` (${item.genre})` : ""}.` });
  }
  return faqs;
}

function img(path, size = "w342") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

// IMDb's official daily ratings dataset: tconst \t averageRating \t numVotes.
// Downloaded once per run and parsed into a Map for cheap per-film lookup.
// Any failure (network, parse) returns an empty Map so ratings simply fall back
// to TMDB — the dataset is an enhancement, never a hard dependency.
const IMDB_DATASET_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";
async function loadImdbRatings() {
  const map = new Map();
  if (!USE_IMDB) {
    console.log("RATINGS_SOURCE=tmdb — skipping IMDb dataset; using TMDB ratings only.");
    return map; // empty: no IMDb data flows anywhere downstream
  }
  try {
    const res = await fetch(IMDB_DATASET_URL);
    if (!res.ok) throw new Error(`dataset HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const tsv = zlib.gunzipSync(buf).toString("utf8");
    let n = 0;
    for (const line of tsv.split("\n")) {
      if (!line || line.startsWith("tconst\t")) continue; // skip header and blanks
      const tab1 = line.indexOf("\t");
      if (tab1 < 0) continue;
      const tab2 = line.indexOf("\t", tab1 + 1);
      if (tab2 < 0) continue;
      const id = line.slice(0, tab1);
      const rating = line.slice(tab1 + 1, tab2);
      const votes = line.slice(tab2 + 1);
      map.set(id, { rating, votes: parseInt(votes, 10) || 0 });
      n++;
    }
    console.log(`IMDb dataset loaded: ${n} rated titles.`);
  } catch (e) {
    console.warn(`IMDb dataset unavailable, falling back to TMDB ratings only: ${e.message}`);
  }
  return map;
}
let imdbRatings = new Map(); // populated at the start of main()

// Pure: the REGION'S OWN certification, or null. Never another country's rating —
// an absent cert beats a wrong one (India's "U/A 16+" on the Singapore page is a lie).
// This was hardcoded to "IN" for all countries before; a real leak, now regional.
// Pure: top-billed cast WITH photos from the credits already fetched by enrich() —
// zero extra API calls. Only members with a real TMDB headshot are included (no
// placeholder silhouettes); w185 keeps the strip light. Character names add the
// editorial layer ("as Kara Zor-El"). `cast` (plain names) is kept alongside for
// backwards compatibility with older data files and the FAQ/LD consumers.
function extractCastPics(credits) {
  return (credits?.cast || [])
    .filter((c) => c && c.profile_path && c.name)
    .slice(0, 6)
    .map((c) => ({ name: c.name, character: c.character || null, photo: img(c.profile_path, "w185") }));
}

function certFor(kind, d, region) {
  if (kind === "movie") {
    const rel = d.release_dates?.results?.find((r) => r.iso_3166_1 === region);
    return rel?.release_dates?.find((x) => x.certification)?.certification || null;
  }
  return d.content_ratings?.results?.find((r) => r.iso_3166_1 === region)?.rating || null;
}

// SECTION-scoped override: streaming originals TMDB has misfiled into theatrical pools.
// Unlike EXCLUDE_IDS this only bars the THEATRES list — the film still appears in
// Streaming Now / Coming Soon once its provider data populates, which is where it belongs.
const THEATRE_EXCLUDE_IDS = new Set([
  1484913, // Ikka — Netflix original, never had an Indian theatrical run
]);

// Pure: can this movie honestly sit in an "In Theatres" list for this region?
// TMDB release types: 1 premiere, 2 limited theatrical, 3 theatrical, 4 digital,
// 5 physical, 6 TV. Logic, in order of evidence strength:
//   - a type 2/3 entry for the region  -> proven theatrical run  -> eligible
//   - a type 4/6 entry and NO 2/3      -> digital/TV release only -> NOT eligible
//     (the Ikka class: streaming originals in now_playing/discover pools)
//   - no region entry at all           -> unknown; eligible only if it also has no
//     streaming providers (a brand-new film already on flatrate is an OTT original)
function theatreEligible(d, region, providers = []) {
  const rel = d.release_dates?.results?.find((r) => r.iso_3166_1 === region);
  const types = new Set((rel?.release_dates || []).map((x) => x.type));
  if (types.has(2) || types.has(3)) return true;
  if (types.has(4) || types.has(6)) return false;
  return !(providers && providers.length);
}

// Pure: the region's OWN theatrical date (TMDB types 1-3: premiere/limited/theatrical),
// earliest when several. null when TMDB has no dated entry for this region — the caller
// then keeps the global primary date. Indian films open in the UAE/Canada days apart
// from India; each country page should show (and gate freshness by) ITS OWN date.
function regionalTheatricalDate(d, region) {
  const rel = d.release_dates?.results?.find((r) => r.iso_3166_1 === region);
  const dates = (rel?.release_dates || [])
    .filter((x) => x.type >= 1 && x.type <= 3 && x.release_date)
    .map((x) => String(x.release_date).slice(0, 10))
    .sort();
  return dates[0] || null;
}

async function enrich(kind, id, region = "IN") {
  const extra = kind === "movie" ? "release_dates" : "content_ratings";
  const d = await tmdb(`/${kind}/${id}`, { append_to_response: `videos,credits,watch/providers,external_ids,recommendations,${extra}` });

  const cert = certFor(kind, d, region);

  // Trailer — fall back to a YouTube search link if TMDB has no video yet
  const vids = d.videos?.results || [];
  const t = vids.find((v) => v.site === "YouTube" && v.type === "Trailer") || vids.find((v) => v.site === "YouTube");
  const trailer = t
    ? `https://www.youtube.com/watch?v=${t.key}`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(`${d.title || d.name || ""} official trailer`)}`;

  // Streaming platforms in this country's region
  const inProv = d["watch/providers"]?.results?.[region];
  const providers = (inProv?.flatrate || []).slice(0, 4).map((p) => p.provider_name);

  // Cast & director
  const cast = (d.credits?.cast || []).slice(0, 4).map((c) => c.name);
  const castPics = extractCastPics(d.credits);
  let director = null;
  if (kind === "movie") director = (d.credits?.crew || []).find((c) => c.job === "Director")?.name || null;
  else director = d.created_by?.[0]?.name || null;

  const runtime = kind === "movie" ? d.runtime : (d.episode_run_time?.[0] || null);

  // Freshness signal for the OTT pool — see deriveFreshDate (handles movie vs TV-season logic).
  const freshDate = deriveFreshDate(kind, d);

  // Card badge from freshDate (see freshBadge, module scope). Season count distinguishes a
  // brand-new show from a returning one. This also OVERRIDES baseItem's isRecent, which was
  // computed from release_date/first_air_date and therefore could never flag a returning
  // show's new season. isRecent stays semantically "badge-worthy new" for downstream users
  // (Pick of the Week eligibility).
  const seasonCount = kind === "tv" ? (d.seasons || []).filter((s) => s.season_number > 0).length : null;
  const badge = freshBadge(kind, freshDate, Date.now(), seasonCount);

  // IMDb rating via OMDb (optional). IMDb's base has more Indian raters than TMDB,
  // IMDb rating from the daily dataset (loaded once into imdbRatings). IMDb's base
  // has more Indian raters than TMDB, so it's a useful second opinion. Cheap in-memory
  // lookup by IMDb ID — no per-film network call. Missing title -> no chip (fallback).
  let imdbScore = null, imdbVotes = null;
  const imdbId = d.external_ids?.imdb_id;
  if (imdbId && imdbRatings.has(imdbId)) {
    const r = imdbRatings.get(imdbId);
    if (r && r.rating) { imdbScore = `${r.rating}/10`; imdbVotes = r.votes || 0; }
  }

  // "If you liked this" — top recommendations from the SAME enrich call (appended above, so
  // no extra round trip). We keep title + slug + light meta; the page links to each film's own
  // page when it exists. slugify mirrors the client/page slug scheme so links resolve.
  const recs = (d.recommendations?.results || [])
    .filter((x) => (x.title || x.name) && x.poster_path)
    .slice(0, 6)
    .map((x) => ({
      title: x.title || x.name,
      slug: slugify(x.title || x.name),
      poster: img(x.poster_path),
      language: LANG[x.original_language] || x.original_language || null,
      kind: x.media_type === "tv" || x.first_air_date ? "tv" : "movie",
    }));

  // Region's own theatrical date overrides the global primary date when TMDB has one —
  // so each country page shows (and freshness-gates by) its own market's release day.
  const regionalRelease = kind === "movie" ? regionalTheatricalDate(d, region) : null;
  const theatrical = kind === "movie" ? theatreEligible(d, region, providers) : null;

  return {
    cert, trailer, providers, cast, director, runtime, imdbScore, imdbVotes,
    imdbId: imdbId || null, // handle for cross-source lookups (Wikipedia buzz via Wikidata P345)
    freshDate, badge, isRecent: badge != null, similar: recs,
    backdrop: img(d.backdrop_path, "w780"),
    fullReview: trim(d.overview, 600),
    ...(regionalRelease ? { released: regionalRelease } : {}),
    ...(castPics.length ? { castPics } : {}),
    ...(theatrical === false ? { theatrical: false } : {}), // only serialized when it matters
  };
}

async function main() {
  const [movieGenres, tvGenres] = await Promise.all([tmdb("/genre/movie/list"), tmdb("/genre/tv/list")]);

  // Load IMDb's daily ratings dataset once (used to attach a second-opinion rating).
  imdbRatings = await loadImdbRatings();
  const gmap = {};
  for (const g of [...movieGenres.genres, ...tvGenres.genres]) gmap[g.id] = g.name;
  const genres = (ids) => (ids || []).slice(0, 2).map((i) => gmap[i]).filter(Boolean).join(" / ");

  function baseItem(m, kind) {
    const relDate = m.release_date || m.first_air_date;
    const daysSince = relDate ? (Date.now() - new Date(relDate).getTime()) / 864e5 : 999;
    // isRecent: released within 7 days — drives the "New release" badge (what a user
    // means by new). isFresh: also requires thin votes — drives the rating placeholder
    // and "verdict soon", since a fresh film with few votes can't be rated honestly yet.
    const isRecent = daysSince <= 7;
    const tooNew = isRecent && m.vote_count < 20;
    const showRating = !tooNew && m.vote_count >= 10;
    return {
      title: m.title || m.name,
      genre: genres(m.genre_ids),
      language: LANG[m.original_language] || m.original_language,
      released: relDate,
      review: trim(m.overview),
      rating: showRating ? Number(m.vote_average.toFixed(1)) : null,
      scores: [{ source: "TMDB", score: showRating ? `${m.vote_average.toFixed(1)}/10` : "New release" }],
      votes: m.vote_count,
      verdict: tooNew ? "Just released — verdict soon" : verdict(m.vote_average, m.vote_count),
      poster: img(m.poster_path),
      isRecent,
      isFresh: tooNew,
      kind,
      tmdbId: m.id,
      popularity: m.popularity ?? null, // TMDB popularity = buzz/trending signal (for ranking)
    };
  }

  // After enrich, fold in the IMDb rating (from the dataset). Appends the IMDb chip,
  // IMDb-primary display: IMDb is the better, more comprehensive rating, so when it exists
  // it is the ONLY score shown — the TMDB chip is dropped. TMDB is kept solely as a labeled
  // fallback for films IMDb hasn't rated yet (too new / below IMDb's vote threshold), so the
  // freshest films still show a number instead of a blank. Also persists numeric imdbRating/
  // imdbVotes for ranking, and lets IMDb fill the verdict when TMDB had only a placeholder.
  function withImdb(item) {
    // In TMDB mode, IMDb never displaces the TMDB rating/verdict/score chip. (Redundant with
    // the empty IMDb map, but explicit so the display source is unmistakable.)
    if (!USE_IMDB) { item.imdbVotes = item.imdbVotes ?? null; delete item.imdbScore; return item; }
    if (item.imdbScore) {
      const num = parseFloat(item.imdbScore); // "7.4/10" -> 7.4
      // IMDb present -> show IMDb only (replace the scores array, dropping the TMDB chip).
      item.scores = [{ source: "IMDb", score: item.imdbScore }];
      if (!isNaN(num)) {
        item.imdbRating = num;       // persist numeric IMDb rating for ranking
        item.rating = num;           // IMDb is now the primary displayed rating
        item.verdict = verdict(num, 1000); // real verdict band from IMDb
        item.isFresh = false;        // has a real rating -> not a "no rating yet" placeholder
      }
    }
    // else: no IMDb rating — leave the existing TMDB-sourced scores array as-is. It already
    // reads "TMDB x.x/10" (labeled) when TMDB had a usable rating, or "New release" when the
    // film is too new for either source. This is the silent fallback for the freshest films.
    item.imdbVotes = item.imdbVotes ?? null;
    delete item.imdbScore;
    return item;
  }

  // Build all sections for one country from its config. Closes over shared helpers
  // (genres, baseItem, withImdb, verdict). Returns the data object for that country.
  async function buildCountry(cfg) {
  // ---------- IN THEATRES (quality-ranked within fresh pool + language representation, 4-7) ----------
  const INDIAN_LANGS = cfg.regionalLangs;
  const isRegional = (m) => INDIAN_LANGS.includes(m.original_language);

  // Base pool: TMDB's "now playing" for this country.
  const np1 = await tmdb("/movie/now_playing", { region: cfg.region, page: "1" });
  await sleep(150);
  const np2 = await tmdb("/movie/now_playing", { region: cfg.region, page: "2" });
  // Seed `seen` with the manual exclusion list so blocked films (banned/pulled/mislisted)
  // are skipped everywhere the pool is built below — both now_playing and discover.
  const seen = new Set(EXCLUDE_IDS);
  let pool = [...np1.results, ...(np2.results || [])].filter((m) => {
    if (seen.has(m.id) || isExcluded(m)) { return false; } seen.add(m.id); return true;
  });

  // Multi-source supplement: now_playing is incomplete for Indian regional theatrical
  // releases (distributors/contributors don't always report them), so we also pull recent
  // THEATRICAL releases per Indian language via discover. release_type 3|2 = theatrical/
  // limited theatrical (not direct-to-OTT), and a 3-week window keeps it current — wide
  // enough for films still running, tight enough to avoid resurfacing the back catalogue.
  // These merge into the pool on equal footing; the normal ranking decides what's picked.
  // (THEATRE_WINDOW_DAYS lives at module scope now — it gates the WHOLE pool, not just this query.)
  const theatreCutoff = new Date(Date.now() - THEATRE_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);
  // Priority languages for theatre representation: Hindi, Tamil, Telugu. Discover queries
  // target these so they reliably enter the pool; now_playing still brings in everything
  // else (English, other regional) so a standout outside these can still earn a slot.
  const PRIORITY_LANGS = cfg.priorityLangs;
  for (const lang of PRIORITY_LANGS) {
    try {
      const d = await tmdb("/discover/movie", {
        region: cfg.region,
        with_original_language: lang,
        "primary_release_date.gte": theatreCutoff,
        "primary_release_date.lte": todayStr,
        with_release_type: "3|2",
        sort_by: "popularity.desc",
        page: "1",
      });
      for (const m of (d.results || [])) {
        if (!seen.has(m.id) && !isExcluded(m)) { seen.add(m.id); pool.push(m); }
      }
    } catch (e) { console.warn(`theatre-discover ${lang}: ${e.message}`); }
    await sleep(150);
  }

  // Gate the WHOLE pool by the freshness window (filterTheatreFresh, module scope). This is
  // the fix for month-old now_playing films topping "Latest big-screen releases": discover
  // results were already date-gated by their query, but now_playing results were not. Runs
  // BEFORE IMDb enrichment so stale films never cost detail calls.
  const poolBeforeGate = pool.length;
  pool = filterTheatreFresh(pool);
  console.log(`  theatre pool: ${poolBeforeGate} -> ${pool.length} after freshness gate (${THEATRE_WINDOW_DAYS}d window)`);

  // Attach IMDb rating to each pool film BEFORE ranking, so IMDb (which has far more
  // Indian raters than TMDB) drives selection — not just display. One detail call per
  // film to resolve its IMDb ID, then a cheap lookup in the loaded dataset. Runs once
  // a day, so the extra calls are immaterial. Any failure leaves _imdbRating null and
  // the film falls back to its TMDB rating — never blocks ranking.
  // Resolve each pool film's IMDb ID -> dataset rating BEFORE ranking, so IMDb (which has far
  // more Indian raters than TMDB) drives selection, not just display. One detail call per film,
  // then a cheap in-memory lookup. SKIPPED ENTIRELY when RATINGS_SOURCE=tmdb — no IMDb data is
  // used, so these calls (and their pacing sleeps) would be pure waste. Any failure leaves
  // _imdbRating null and the film falls back to its TMDB rating — never blocks ranking.
  if (USE_IMDB) {
    for (const m of pool) {
      try {
        const d = await tmdb(`/movie/${m.id}`, { append_to_response: "external_ids" });
        const imdbId = d.external_ids?.imdb_id;
        if (imdbId && imdbRatings.has(imdbId)) {
          const r = imdbRatings.get(imdbId);
          if (r && r.rating) {
            m._imdbRating = parseFloat(r.rating);
            m._imdbVotes = r.votes || 0;
          }
        }
      } catch (e) { console.warn(`imdb-id ${m.id}: ${e.message}`); }
      await sleep(150);
    }
  }

  // Tunable: neutral prior C and smoothing constant M (how many votes before a
  // rating is trusted on its own). Per-country config can override these later.
  const PRIOR_C = 6.0, SMOOTH_M = 8;
  // Best available rating/votes: IMDb when present (more raters for Indian titles),
  // else TMDB. These drive both the quality floor and the ranking score.
  const bestRating = (m) => {
    if (USE_IMDB && m._imdbRating != null) return m._imdbRating;
    if ((m.vote_count || 0) >= 10) return m.vote_average || 0;
    return null; // no usable rating yet
  };
  const bestVotes = (m) => ((USE_IMDB && m._imdbRating != null) ? (m._imdbVotes || 0) : (m.vote_count || 0));
  // Freshness is enforced by the POOL, not the ranking. Within the fresh pool we rank on
  // quality with an ADDITIVE form: rating sets the baseline and vote volume gives a gentle
  // confidence nudge — score = rating + 0.5*log10(votes+10). This means an excellent film
  // (e.g. a new Indian release at 8.3) leads on merit and is NOT buried by a merely-good
  // Hollywood title with huge vote counts; among films of similar rating, the more
  // widely-confirmed one ranks higher. Popularity is not a factor. Unrated-but-fresh films
  // fall back to a neutral prior so they still place.
  // Freshness is BOTH a gate (the pool) and a ranking driver. Within the fresh pool, a
  // bounded recency bonus makes genuinely-newer films rank above comparable older ones —
  // this is a "latest releases" site, so among good films the newest should lead. The
  // bonus is CAPPED (+2.0 at release, linear decay to 0 by 14 days) so it reorders films
  // of similar quality but can't let a weak fresh film leapfrog a much stronger recent one
  // (e.g. a 6.0 from today at +2.0 = 8.0 still loses to an 8.5 from last week).
  const RECENCY_MAX = 2.0, RECENCY_DAYS = 21;
  const recencyBonus = (m) => {
    const d = m.release_date || m.first_air_date;
    if (!d) return 0;
    const age = (Date.now() - new Date(d).getTime()) / 864e5;
    if (age < 0 || age > RECENCY_DAYS) return 0;
    return RECENCY_MAX * (1 - age / RECENCY_DAYS); // full at age 0, 0 at RECENCY_DAYS
  };
  // (qualityScore retired — ranking now uses the 40/35/25 weighted402535 score everywhere)

  // Suspicious-entry guard: a real, currently-relevant film does not have an implausibly high
  // rating on tiny volume, or a high rating with essentially zero audience interest. These are
  // fake/erroneous records or vote-manipulated titles. Thresholds are mode-aware because IMDb
  // and TMDB have very different vote SCALES (IMDb counts are ~10-50x TMDB's). Conservative in
  // both modes so genuine films are never caught.
  const isSuspicious = (m) => {
    const p = m.popularity || 0;
    if (USE_IMDB) {
      const r = m._imdbRating, v = m._imdbVotes || 0;
      if (r == null) return false;
      if (r >= 9.5 && v < 5000) return true;            // implausibly high rating, thin votes
      if (r >= 8.5 && v < 3000 && p < 1.0) return true; // high rating but ~zero audience interest
    } else {
      const r = (m.vote_count || 0) >= 10 ? m.vote_average : null;
      const v = m.vote_count || 0;
      if (r == null) return false;
      if (r >= 9.5 && v < 200) return true;             // TMDB scale: implausibly high on thin votes
      if (r >= 9.0 && v < 100 && p < 2.0) return true;  // high rating, almost no votes, no buzz
    }
    return false;
  };
  // Stale / re-release guard. TMDB's now_playing for a region sometimes returns OLD films —
  // re-releases back in cinemas or stale regional listings — that wrongly appear "fresh". A
  // DATE check can't catch the honestly-old ones, so the reliable signal is BUZZ: a film truly
  // drawing audiences now has high current popularity; an old film coasting on lifetime votes
  // does not. We drop "famous but not buzzing now" via two patterns. Popularity is the SAME
  // field in both modes, but vote SCALE differs hugely (IMDb ~10-50x TMDB), so vote thresholds
  // are mode-aware. IMDb refs: Top Gun 879k/pop25, Shrek 812k/pop26, Chandu Champion 36k/pop1.5.
  // TMDB refs (much lower counts): Shrek ~18k, Top Gun Maverick ~11k; a days-old release rarely
  // exceeds ~1-2k TMDB votes, so a high count + low popularity reliably means "old, not fresh".
  const looksReRelease = (m) => {
    const p = m.popularity || 0;
    if (USE_IMDB) {
      const v = m._imdbVotes || 0;
      if (v > 50000 && p < 80) return true;  // famous catalogue title, not currently buzzing
      if (v > 20000 && p < 5) return true;   // older title with essentially no current interest
    } else {
      const v = m.vote_count || 0;           // TMDB vote scale
      if (v > 3000 && p < 80) return true;   // famous catalogue title (Shrek/Top Gun), cooled off
      if (v > 1000 && p < 5) return true;    // older title with essentially no current interest
    }
    return false;
  };
  const clearsBar = (m) => {
    if (isSuspicious(m)) return false;
    if (looksReRelease(m)) return false;
    const r = bestRating(m);
    return r == null || r >= 5.5;
  };

  // 40/35/25 quality weighting (your spec): IMDb rating 40%, IMDb vote volume 35%, current
  // buzz/popularity 25%. Votes and buzz are log-scaled then normalized 0..1 across the pool
  // (so the heavy tail of Hollywood vote counts doesn't dwarf everything), rating is /10.
  // A bounded freshness multiplier from recencyBonus keeps "feel fresh" in the mix. This
  // score orders films WITHIN the soft language quota — it decides which Hindi/English/etc.
  // film fills each slot and their order, while the quota still guarantees Hindi its slots.
  const poolForNorm = pool.filter((m) => !isSuspicious(m));
  const maxLogV = Math.max(1, ...poolForNorm.map((m) => Math.log10((m._imdbVotes || m.vote_count || 0) + 1)));
  const maxLogP = Math.max(0.01, ...poolForNorm.map((m) => Math.log10((m.popularity || 0) + 1)));
  const weighted402535 = (m) => {
    const rN = (bestRating(m) ?? PRIOR_C) / 10;
    const vN = Math.log10((bestVotes(m)) + 1) / maxLogV;
    const pN = Math.log10((m.popularity || 0) + 1) / maxLogP;
    const base = 0.40 * rN + 0.35 * vN + 0.25 * pN;
    // freshness nudge: scale recencyBonus (0..2) to a small 0..0.10 multiplier-add so the
    // newest films get a slight edge without overriding the quality+popularity signal.
    return base + 0.05 * recencyBonus(m);
  };

  const ranked = pool.filter(clearsBar).sort((a, b) => weighted402535(b) - weighted402535(a));
  const MIN_PICKS = 4, MAX_PICKS = 7;

  // Soft-priority composition: target mix is 3 Hindi, 2 English, 1 Tamil, 1 Telugu (= 7).
  // Slots are filled by the best film of that language under the 40/35/25 score (clearing
  // the 6.5 representation bar). It's SOFT: any target that can't be filled by its language
  // is left for the fallback pass, where the best remaining film of ANY language (clearing
  // the 5.5 floor + suspicious guard) takes the slot — so a standout outside the target set
  // can still make the list, and we never pad a slot with a weak film or leave it short.
  const TARGETS = cfg.theatreTargets;
  // Representation rating bar. IMDb mode: 6.5 (IMDb has plenty of Indian raters, so this is a
  // meaningful quality gate). TMDB mode: TMDB under-rates AND under-counts regional cinema
  // (Western-skewed audience), so a 6.5 bar wrongly empties the Hindi/Tamil/Telugu quotas. Use
  // a lower bar AND treat an absent rating as acceptable (a legit Hindi film with few TMDB votes
  // must still be eligible for Hindi representation; it already cleared the pool's quality floor).
  const REP_BAR = USE_IMDB ? 6.5 : 5.0;
  const repRating = (m) => bestRating(m) ?? (USE_IMDB ? 0 : REP_BAR); // null fails in IMDb, passes in TMDB
  let picks = [];
  for (const [lang, n] of TARGETS) {
    const langFilms = ranked.filter((m) => m.original_language === lang && repRating(m) >= REP_BAR && !picks.includes(m));
    for (let i = 0; i < n && i < langFilms.length; i++) picks.push(langFilms[i]);
  }
  // Soft fallback: fill any remaining slots (up to MAX_PICKS) with the best films of any
  // language not already picked — this is where exceptional non-target-language films land.
  for (const m of ranked) {
    if (picks.length >= MAX_PICKS) break;
    if (!picks.includes(m)) picks.push(m);
  }
  // Guarantee a minimum even in a thin week.
  for (const m of ranked) {
    if (picks.length >= MIN_PICKS) break;
    if (!picks.includes(m)) picks.push(m);
  }
  picks = picks.slice(0, MAX_PICKS).sort((a, b) => weighted402535(b) - weighted402535(a));

  // Soft top-3 reserve: the first three slots prefer English/Hindi (broad-audience lead),
  // but this is a preference, not a hard quota — if the best available English/Hindi film
  // is much weaker than a regional film (gap > TOP3_TOLERANCE in quality score), the
  // regional film keeps the slot rather than fronting a weak title.
  const TOP3_TOLERANCE = 0.15; // on the 0..1 weighted score: a regional film must beat the
                                // best English/Hindi film by this margin to keep a top-3 slot
  const isLead = (m) => m.original_language === "en" || m.original_language === "hi";
  const reordered = [];
  const remaining = [...picks]; // already quality-sorted
  for (let pos = 0; pos < 3 && remaining.length; pos++) {
    const topRegional = remaining.find((m) => !isLead(m));
    const topLead = remaining.find((m) => isLead(m));
    let choice;
    if (!topLead) choice = remaining[0];
    else if (!topRegional) choice = topLead;
    else {
      choice = (weighted402535(topRegional) - weighted402535(topLead) > TOP3_TOLERANCE) ? topRegional : topLead;
    }
    reordered.push(choice);
    remaining.splice(remaining.indexOf(choice), 1);
  }
  picks = [...reordered, ...remaining]; // top 3 settled, rest stay in quality order

  // Enrich picks with a THEATRICAL gate + bench refill: a pick that turns out to be a
  // digital-only release (the Ikka class) is dropped, and the next ranked film that
  // wasn't selected takes its slot — the list never silently shrinks below target.
  const targetCount = picks.length;
  const bench = ranked.filter((m) => !picks.includes(m));
  const theatres = [];
  for (const m of [...picks, ...bench]) {
    if (theatres.length >= targetCount) break;
    if (THEATRE_EXCLUDE_IDS.has(m.id)) continue;
    const item = { ...baseItem(m, "movie"), platform: "Theatres" };
    try { Object.assign(item, await enrich("movie", m.id, cfg.watchRegion)); withImdb(item); } catch (e) { console.warn(`enrich movie ${m.id}: ${e.message}`); }
    if (item.theatrical === false) {
      console.log(`  theatres: dropped ${item.title} — digital-only release, no theatrical run in ${cfg.region}`);
      continue;
    }
    theatres.push(item);
    await sleep(150);
  }

  // ---------- TOP 10 ON OTT (international + fresh regional, IMDb-ranked, max 10) ----------
  // International from global trending (inherently fresh); regional from per-language
  // discover gated to recent releases so we never resurface all-time classics. Both
  // ranked with the same IMDb-preferred quality term as theatres, for consistency.
  const OTT_MAX = 10;
  const OTT_REGIONAL_TARGET = (cfg.ottRegionalLangs && cfg.ottRegionalLangs.length) ? 4 : 0;
  const OTT_INTL_CAP = OTT_MAX - OTT_REGIONAL_TARGET;
  const FRESH_DAYS = 30;
  const freshCutoff = new Date(Date.now() - FRESH_DAYS * 864e5).toISOString().slice(0, 10);

  // OTT staleness gate. Trending-this-week is a freshness PROXY, but perennial catalogue
  // hits (Rick and Morty, The Boys) trend every week on rewatches, so the proxy leaks
  // all-time classics into a "latest releases" list. The fix is a real recency check on
  // the item's freshDate (movie release date, or a TV series' LATEST-season air date — not
  // its original launch). This keeps a returning hit's NEW season (recent freshDate) while
  // dropping an old show with no recent season. See isOttFresh/OTT_FRESH_DAYS (module scope).
  // Gate runs on the EFFECTIVE date (release/season OR first platform sighting), so a
  // theatrical film that just landed on OTT months after release is correctly kept.
  const ottIsFresh = (item) => item && isOttFresh(item.ottFreshDate || item.freshDate);

  // First-seen tracking state for THIS country (see module-scope docs at ott-seen.json).
  // coldStart is captured BEFORE any recording so seeding stays consistent for the run.
  const seenAll = loadOttSeen();
  const seenCountry = (seenAll[cfg.code] = seenAll[cfg.code] || {});
  const seenColdStart = Object.keys(seenCountry).length === 0;
  // (todayStr already declared earlier in buildCountry — reused for recording sightings.)

  // Resolve IMDb rating for a candidate (detail call -> dataset lookup). Sets _imdbRating
  // so weighted402535 uses IMDb as the rating/votes signal, exactly like theatres. No-op in
  // TMDB mode (IMDb data unused) — skipping it avoids a wasted detail call per candidate.
  const attachImdb = async (c) => {
    if (!USE_IMDB) return;
    try {
      const d = await tmdb(`/${c.kind}/${c.id}`, { append_to_response: "external_ids" });
      const imdbId = d.external_ids?.imdb_id;
      if (imdbId && imdbRatings.has(imdbId)) {
        const r = imdbRatings.get(imdbId);
        if (r && r.rating) { c._imdbRating = parseFloat(r.rating); c._imdbVotes = r.votes || 0; }
      }
    } catch (e) { /* leave _imdbRating null -> falls back to TMDB rating */ }
  };

  const buildOttItem = async (c) => {
    const item = baseItem(c, c.kind);
    const extra = await enrich(c.kind, c.id, cfg.watchRegion);
    if (!extra.providers || extra.providers.length === 0) return null; // not streaming in this region
    Object.assign(item, extra, { platform: extra.providers[0] });
    withImdb(item);
    item._w = weighted402535(c); // quality score kept for the recency re-rank below (stripped before write)

    // First-seen tracking: this title was observed WITH a provider today. ottSince is the
    // (approximate) platform-arrival date; ottFreshDate is what the gate + recency decay use.
    const firstSeen = recordOttSeen(seenCountry, `${item.kind}:${item.tmdbId}`, item.freshDate, todayStr, seenColdStart);
    const { effective, isArrival } = ottArrival(item.freshDate, firstSeen);
    item.ottSince = firstSeen;
    item.ottFreshDate = effective;
    // Arrival badge — only when no release-event badge already applies (one badge, clear
    // meaning): an older release newly sighted on the platform is news AS an arrival.
    if (!item.badge && isArrival && item.platform && item.platform !== "Theatres") {
      item.badge = `New on ${item.platform}`;
      item.isRecent = true;
    }
    // Integrity gate at the SOURCE: a pre-release provider listing (future-dated movie /
    // future TV season) is rejected here, before any pool counts it — so selection and
    // backfill naturally pick the next candidate and the final list arrives at OTT_MAX
    // already clean. (orderOttForDisplay's own filter remains as a belt-and-braces net,
    // but gating only there let dropped items shrink the list below 10 with no refill.)
    if (!ottRenderable(item)) return null;
    return item;
  };

  // --- International pool: global trending. Trending IS the freshness signal here — it
  //     captures what people are watching now, including returning seasons of hit shows
  //     that a release-date gate would wrongly exclude (TMDB dates the series' original
  //     launch, not the new season). Within this fresh set, rank purely by quality. ---
  const [trMovies, trTv] = await Promise.all([tmdb("/trending/movie/week"), tmdb("/trending/tv/week")]);
  let intlCands = [
    ...trMovies.results.map((m) => ({ ...m, kind: "movie" })),
    ...trTv.results.map((t) => ({ ...t, kind: "tv" })),
  ].filter((c) => !isRegional(c) && !isExcluded(c));
  for (const c of intlCands) { await attachImdb(c); await sleep(150); }
  // Drop fake/manipulated entries AND famous-but-not-currently-buzzing catalogue titles
  // (looksReRelease) — the same buzz guard theatres use, which the OTT intl pool previously
  // skipped. This is the cheap first cut; the authoritative recency check (ottIsFresh) runs
  // after build, once enrich() has resolved each title's real freshDate.
  intlCands = intlCands.filter((c) => !isSuspicious(c) && !looksReRelease(c));
  intlCands.sort((a, b) => weighted402535(b) - weighted402535(a));

  const intl = [], usedIds = new Set();
  for (const c of intlCands) {
    if (intl.length >= OTT_INTL_CAP) break;
    try {
      const it = await buildOttItem(c);
      // Recency gate: keep only genuinely-fresh titles. A trending old movie, or an old
      // series with no recent season, fails here and we move on to the next candidate —
      // so the slot goes to a genuinely new release instead of an all-time classic.
      if (it && ottIsFresh(it)) { intl.push(it); usedIds.add(c.id); }
      else if (it) console.log(`  ott-intl skip (stale): ${it.title} freshDate=${it.freshDate}`);
    }
    catch (e) { console.warn(`ott-intl ${c.id}: ${e.message}`); }
    await sleep(150);
  }

  // --- Regional pool: per-language discover, gated to recent releases (anti-staleness),
  //     Hindi first, IMDb-ranked. This is what surfaces fresh Hindi/regional OTT shows
  //     that never trend globally. ---
  const regionalOrder = cfg.ottRegionalLangs || [];
  const regional = [];
  for (const lang of regionalOrder) {
    if (regional.length >= OTT_REGIONAL_TARGET) break;
    let cands = [];
    for (const kind of ["tv", "movie"]) {
      const dateField = kind === "tv" ? "first_air_date.gte" : "primary_release_date.gte";
      try {
        const d = await tmdb(`/discover/${kind}`, {
          with_original_language: lang,
          watch_region: cfg.watchRegion,
          with_watch_monetization_types: "flatrate",
          sort_by: "popularity.desc",
          [dateField]: freshCutoff, // only recent releases — never all-time classics
          page: "1",
        });
        await sleep(150);
        cands.push(...(d.results || []).map((m) => ({ ...m, kind })));
      } catch (e) { console.warn(`ott-regional ${lang}/${kind}: ${e.message}`); }
    }
    cands = cands.filter((c) => !usedIds.has(c.id) && !isExcluded(c));
    for (const c of cands) { await attachImdb(c); await sleep(150); }
    // Quality floor on the best rating we have: IMDb if present, else TMDB. A film is
    // only allowed through unfloored when it has NO usable rating at all (genuinely too
    // new to judge) — then popularity decides. This stops mediocre thin-data films from
    // sneaking in while still giving truly-unrated fresh titles a chance.
    const ottRating = (c) => {
      if (c._imdbRating != null) return c._imdbRating;
      if ((c.vote_count || 0) >= 10) return c.vote_average || 0;
      return null; // no usable rating
    };
    cands = cands
      .filter((c) => !isSuspicious(c)) // drop fake/manipulated entries
      .filter((c) => { const r = ottRating(c); return r == null || r >= 5.5; })
      .sort((a, b) => weighted402535(b) - weighted402535(a));
    for (const c of cands) {
      if (regional.length >= OTT_REGIONAL_TARGET) break;
      if (usedIds.has(c.id)) continue;
      try { const it = await buildOttItem(c); if (it) { regional.push(it); usedIds.add(c.id); } }
      catch (e) { console.warn(`ott-regional-build ${c.id}: ${e.message}`); }
      await sleep(150);
    }
  }

  // --- Backfill with more international if regional fell short, so list reaches 10 ---
  if (regional.length < OTT_REGIONAL_TARGET) {
    for (const c of intlCands) {
      if (intl.length + regional.length >= OTT_MAX) break;
      if (usedIds.has(c.id)) continue;
      try {
        const it = await buildOttItem(c);
        if (it && ottIsFresh(it)) { intl.push(it); usedIds.add(c.id); } // same recency gate as the main pass
      }
      catch (e) { console.warn(`ott-backfill ${c.id}: ${e.message}`); }
      await sleep(150);
    }
  }

  // --- Recency-decay re-rank (see ottRecencyBonus, module scope). Selection above is
  //     quality-greedy; ORDER is quality + freshness, so this week's drops lead and a
  //     near-expiry season sinks toward the bottom instead of camping in the top 3.
  //     Pools are re-ranked separately so the regional-visibility interleave below keeps
  //     working on two internally-ordered lists. ---
  const ottOrder = (it) => (it._w || 0) + ottRecencyBonus(it.ottFreshDate || it.freshDate);
  intl.sort((a, b) => ottOrder(b) - ottOrder(a));
  regional.sort((a, b) => ottOrder(b) - ottOrder(a));

  // --- Interleave so regional stays visible instead of sinking below the international ---
  const ott = [];
  const step = regional.length ? Math.max(1, Math.floor(intl.length / regional.length)) : 0;
  let ri = 0;
  for (let i = 0; i < intl.length; i++) {
    ott.push(intl[i]);
    if (ri < regional.length && step && (i + 1) % step === 0) ott.push(regional[ri++]);
  }
  while (ri < regional.length) ott.push(regional[ri++]);
  // Integrity gate + honest split (module scope): drop pre-release provider listings,
  // sink threadbare cards, partition into "new this week" / "still worth it".
  const ottDisplay = orderOttForDisplay(ott);
  ott.length = 0;
  ott.push(...ottDisplay);
  ott.length = Math.min(ott.length, OTT_MAX);

  // ---------- COMING SOON (next releases in India, soft language quota) ----------
  // Pure date-sorting made this skew to whatever industry had the most films dated soon
  // (often Malayalam). Instead, apply a SOFT language quota — 3 English, 2 Hindi, 3 regional
  // (= 8) — so Hollywood and Hindi get prominence while regional is capped at 3 (not flooded).
  // Within each language we surface the MOST ANTICIPATED upcoming films (by TMDB popularity),
  // since unreleased films have no ratings to rank by and buzz is the useful signal. SOFT:
  // any quota a language can't fill yields its slots to the fallback (best remaining upcoming
  // film of any language), so we never leave gaps or pad with nothing.
  const today = new Date().toISOString().slice(0, 10);
  const soonHorizon = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10); // ~3 months out
  const [up1, up2] = await Promise.all([
    tmdb("/movie/upcoming", { region: cfg.region, page: "1" }),
    tmdb("/movie/upcoming", { region: cfg.region, page: "2" }),
  ]);
  // The /upcoming feed for India under-represents Hollywood and Hindi (it skews to whatever
  // regional industry has the most films dated soon). So — like the theatre pool — we
  // supplement it with discover queries for upcoming ENGLISH and HINDI films specifically,
  // giving the quota more of those to draw from. Without this, the quota stays starved of
  // English/Hindi candidates and falls back to regional. Future window only (next ~3 months).
  const upSeen = new Set([...EXCLUDE_IDS]);
  const upPoolRaw = [];
  for (const m of [...up1.results, ...(up2.results || [])]) {
    if (!upSeen.has(m.id) && !isExcluded(m)) { upSeen.add(m.id); upPoolRaw.push(m); }
  }
  for (const lang of cfg.priorityLangs) {
    try {
      const d = await tmdb("/discover/movie", {
        region: cfg.region,
        with_original_language: lang,
        "primary_release_date.gte": today,
        "primary_release_date.lte": soonHorizon,
        sort_by: "popularity.desc",
        page: "1",
      });
      for (const m of (d.results || [])) {
        if (!upSeen.has(m.id) && !isExcluded(m)) { upSeen.add(m.id); upPoolRaw.push(m); }
      }
    } catch (e) { console.warn(`soon-discover ${cfg.code}/${lang}: ${e.message}`); }
    await sleep(150);
  }
  // Upcoming films have no ratings, so popularity (anticipation) is the only quality signal —
  // BUT TMDB popularity skews to Hollywood, so legitimate Hindi/regional films sit low. We
  // therefore do NOT pre-filter the quota pool by popularity (that erased Indian films and made
  // the section Hollywood-only). Instead:
  //   • the QUOTA (named languages, e.g. India = 3 English / 3 Hindi / 2 regional) draws from
  //     ALL dated-future films, so the intended mix reliably fills regardless of buzz, and
  //   • the buzz FLOOR applies only to the FALLBACK filler, so once the quota is satisfied we
  //     don't pad the list with ghost entries (popularity ~1).
  const SOON_BUZZ_FLOOR = 4; // fallback filler must clear this; quota languages are exempt
  const datedFuture = upPoolRaw
    .filter((m) => m.release_date && m.release_date > today)
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0)); // most anticipated first

  const SOON_TARGETS = cfg.soonTargets;
  const SOON_MAX = 8;
  // "regional" for coming-soon = a regionalLangs language not already a named soon target.
  // For India (soon targets name en+hi) this excludes hi — identical to the prior behaviour.
  const soonNamed = new Set(SOON_TARGETS.map(([k]) => k));
  const isSoonRegional = (m) => INDIAN_LANGS.includes(m.original_language) && !soonNamed.has(m.original_language);
  const soonSeen = new Set();
  const soonBase = [];
  // QUOTA: fills the intended language mix from the full pool (most-anticipated first within
  // each language). Not floor-filtered, so Hindi/regional always get their guaranteed slots.
  for (const [key, n] of SOON_TARGETS) {
    const matches = datedFuture.filter((m) => {
      if (soonSeen.has(m.id)) return false;
      return key === "__regional__" ? isSoonRegional(m) : m.original_language === key;
    });
    for (let i = 0; i < n && i < matches.length; i++) { soonBase.push(matches[i]); soonSeen.add(matches[i].id); }
  }
  // FALLBACK: top up toward SOON_MAX with the most-anticipated remaining films of ANY language,
  // but only those clearing the buzz floor — so filler is real anticipation, not dead-weight.
  for (const m of datedFuture) {
    if (soonBase.length >= SOON_MAX) break;
    if (soonSeen.has(m.id)) continue;
    if ((m.popularity || 0) < SOON_BUZZ_FLOOR) continue; // skip ghosts in the filler
    soonBase.push(m); soonSeen.add(m.id);
  }
  // Present in release-date order (soonest first) — within the curated set, chronological
  // reads most naturally as a "what's coming" list.
  soonBase.sort((a, b) => a.release_date.localeCompare(b.release_date));

  const comingSoon = [];
  for (const m of soonBase) {
    const item = {
      title: m.title,
      released: m.release_date,
      genre: genres(m.genre_ids),
      language: LANG[m.original_language] || m.original_language,
      review: trim(m.overview, 120),
      poster: img(m.poster_path),
      kind: "movie",
      tmdbId: m.id,
      popularity: m.popularity ?? null, // buzz/anticipation signal (films are ranked by this)
    };
    // Full details so the modal can show trailer, backdrop, cast, runtime
    try { Object.assign(item, await enrich("movie", m.id, cfg.watchRegion)); } catch (e) { console.warn(`soon ${m.id}: ${e.message}`); }
    comingSoon.push(item);
    await sleep(150);
  }

  // ---------- CROSS-SECTION DEDUP (a film must appear in only ONE section) ----------
  // TMDB's now_playing for a region can include a film that is actually a STREAMING release
  // (e.g. a Netflix original given a theatrical date), so the same title can land in both the
  // theatres pool AND the OTT pool — showing twice, once wrongly under "In Theatres". OTT
  // membership REQUIRES a real subscription (flatrate) provider in the region (buildOttItem
  // returns null otherwise), so if a film is streamable, the streaming listing is the accurate
  // and actionable one. Remove any such film from theatres so it shows once, under Streaming Now.
  // (Theatrical-only films — and films merely available for digital rent/buy — have no flatrate
  // provider, so they are never pulled out of theatres by this.)
  const ottIds = new Set(ott.map((x) => x.tmdbId));
  for (let i = theatres.length - 1; i >= 0; i--) {
    if (ottIds.has(theatres[i].tmdbId)) {
      console.log(`[${cfg.code}] dedup: "${theatres[i].title}" is streaming -> removed from theatres, kept in OTT`);
      theatres.splice(i, 1);
    }
  }

  // ---------- PICK OF THE WEEK ----------
  // An endorsement must be earned: new films need >=6.5 to take the crown.
  // If no newcomer qualifies, a genuinely great holdover (>=7.0) can be re-featured.
  // If nothing clears either bar, there is no pick this week — honesty over decoration.
  const all = [...theatres, ...ott];
  const pickPool = all.filter((x) => x.rating != null && ((x.imdbRating != null ? (x.imdbVotes || 0) : (x.votes || 0)) >= 20));
  const pick = (pickPool.filter((x) => x.isRecent && x.rating >= 6.5).sort((a, b) => b.rating - a.rating)[0]) ||
               (pickPool.filter((x) => x.rating >= 7.0).sort((a, b) => b.rating - a.rating)[0]) || null;

  const data = { generatedAt: new Date().toISOString(), country: cfg.code, pick: pick ? pick.title : null, theatres, ott, comingSoon };
  // Strip internal-only fields (ranking helpers) so they never reach the data file.
  for (const list of [data.theatres, data.ott, data.comingSoon]) {
    for (const it of list) { delete it._pop; delete it._tmdbWeighted; delete it._imdbNum; delete it._imdbRating; delete it._imdbVotes; delete it._w; }
  }
  console.log(`[${cfg.code}] ${theatres.length} theatre, ${ott.length} OTT, ${comingSoon.length} upcoming. Pick: ${data.pick}`);
  return data;
  } // end buildCountry

  // Run the pipeline for every configured country, writing data-<code>.json for each.
  // India (first) ALSO writes the canonical data.json + per-film pages. Every country gets its
  // own indexable page: India at "/", others at "/<code>/". The pristine index.html template is
  // read ONCE here so per-country injections never stack (India's render writes back to
  // index.html, which would otherwise corrupt the template for later countries).
  let pageTemplate;
  try { pageTemplate = fs.readFileSync("index.html", "utf8"); }
  catch { pageTemplate = null; console.warn("index.html template not found — page render skipped"); }

  const builtCountries = [];
  const dataByCode = {};
  const allSlugSets = {};
  // Pass 1: build data for every country.
  for (const cfg of COUNTRIES) {
    const data = await buildCountry(cfg);
    assignSlugs(data);
    dataByCode[cfg.code] = data;
    const all = [...(data.theatres || []), ...(data.ott || []), ...(data.comingSoon || [])];
    allSlugSets[cfg.code] = new Set(all.map((x) => x.slug).filter(Boolean));
    builtCountries.push(cfg);
  }

  // Persist first-seen tracking (see ott-seen.json docs) — every country has now recorded
  // today's sightings; the workflow commits this file so tomorrow's run remembers them.
  fs.writeFileSync(OTT_SEEN_FILE, JSON.stringify(loadOttSeen(), null, 1));

  // Buzz signals attach BEFORE the data files are written, so client-rendered cards
  // (which read data.json) see the same badges the SSR cards do. Both are non-fatal.
  await attachBuzz(dataByCode);
  await attachTrailerStats(dataByCode);
  // Critics' takes attach last but still BEFORE data files are written, so
  // client-rendered cards (which read data.json) show the same line the SSR cards do.
  await attachTakes(dataByCode);

  // Product stats, BEFORE data files are written so the client can render the
  // confidence strip ("N picks · M+ films tracked") from data alone.
  const priorManifest = loadPagesManifest();
  for (const cfg of builtCountries) {
    dataByCode[cfg.code].trackedFilms = Object.keys(priorManifest[cfg.code] || {}).length;
  }

  // Now write every country's data file (India also writes the legacy data.json).
  for (const cfg of builtCountries) {
    fs.writeFileSync(`data-${cfg.code}.json`, JSON.stringify(dataByCode[cfg.code], null, 1));
    if (cfg.code === "in") fs.writeFileSync("data.json", JSON.stringify(dataByCode[cfg.code], null, 1));
  }
  // Pass 2: now that ALL slug sets are known, generate per-film pages for every country (so
  // hreflang alternates between countries are accurate) and render each country homepage.
  for (const cfg of COUNTRIES) {
    generatePages(dataByCode[cfg.code], cfg, allSlugSets);
    if (pageTemplate) renderCountryPage(pageTemplate, cfg, dataByCode[cfg.code]);
    writeOttWeekPage(dataByCode[cfg.code], cfg, builtCountries); // /new-on-ott/ per country
    writeRssFeed(dataByCode[cfg.code], cfg);                      // /feed.xml per country
  }
  // India-only surfaces: language landing pages (/tamil/, /hindi/, ...) and the
  // permanent weekly snapshot (/week/<year>-W<ww>/). Both are pure re-renders of
  // this run's India data — zero extra API calls.
  if (dataByCode.in) {
    writeLanguagePages(dataByCode.in);
    writeWeekPage(dataByCode.in);
  }
  writeIndexNowPayload(builtCountries); // fresh URL list for the workflow's IndexNow ping
  writeLlmsTxt(dataByCode); // AI-answer-engine site map with this week's actual picks

  // Archive pass: pages whose films left this week's lists get a one-time honesty patch,
  // and the manifest records real lastmod dates for the sitemap (see module-scope docs).
  const pagesManifest = loadPagesManifest();
  for (const cfg of builtCountries) archiveDepartedPages(pagesManifest, cfg, allSlugSets[cfg.code] || new Set());
  fs.writeFileSync(PAGES_MANIFEST_FILE, JSON.stringify(pagesManifest, null, 1));

  // Frozen archived pages are never rewritten, so pages generated before the x-default
  // fix carry a dead India URL in their hreflang forever unless repaired in place.
  repairXDefaults(builtCountries);

  // IndexNow: push this build's fresh URLs to Bing & partners (Bing's index feeds
  // Copilot and ChatGPT search). Fire-and-forget — a ping failure never fails a build.
  await submitIndexNow(builtCountries, dataByCode);

  // Rewrite the sitemap to include every country page (with hreflang) now that all are built.
  writeMultiCountrySitemap(builtCountries, pagesManifest);
  console.log(`Done. Built ${COUNTRIES.length} countries: ${COUNTRIES.map((c) => c.code).join(", ")}.`);
}

// Run the build only when executed directly (not when required by tests/tools).
if (!process.env.PAGES_ONLY && require.main === module) main().catch((e) => {
  // Never leak the API key into Action logs, even via network error messages
  const msg = String(e && e.stack || e).split(API_KEY).join('***');
  console.error(msg);
  process.exit(1);
});

// ============================================================
// PER-FILM STATIC PAGES — one SEO-indexable page per film,
// written to movie/<slug>.html. Pages are never deleted: the
// archive accrues search value after films leave the lists.
// ============================================================

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function slugify(t) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function assignSlugs(data) {
  const used = new Map(); // slug -> tmdbId
  for (const list of [data.theatres, data.ott, data.comingSoon]) {
    for (const item of list || []) {
      let slug = slugify(item.title) || `film-${item.tmdbId || ""}`;
      const year = (item.released || "").slice(0, 4);
      if (used.has(slug) && used.get(slug) !== item.tmdbId && year) slug = `${slug}-${year}`;
      used.set(slug, item.tmdbId);
      item.slug = slug;
    }
  }
}

function ytIdOf(url) {
  const m = /youtube\.com\/watch\?v=([\w-]{6,})/.exec(url || "");
  return m ? m[1] : null;
}

// Page path for a film in a given country. India keeps the legacy flat path /movie/<slug>.html
// (preserves already-indexed URLs + the existing archive); other countries are namespaced under
// /<code>/movie/<slug>.html so the same title in different markets never collides and each has
// its own region-correct "where to watch". Used everywhere a film page is linked or written.
// x-default for hreflang must point to a page that EXISTS. India is the canonical
// default only when India actually has the film; otherwise a foreign-market film
// (e.g. a US/UK/DE release never listed in India) would advertise a dead India URL
// as its default — Google follows hreflang alternates as discovery URLs and files
// the miss as a 404 in Search Console. Fallback: first available copy in COUNTRIES
// order (deterministic; stable across runs).
function xDefaultCode(codes) {
  if (!codes || !codes.length) return "in";
  if (codes.includes("in")) return "in";
  for (const c of COUNTRIES) if (codes.includes(c.code)) return c.code;
  return codes[0];
}

function filmPagePath(code, slug) {
  return code === "in" ? `/movie/${slug}.html` : `/${code}/movie/${slug}.html`;
}
function filmPageUrl(code, slug) {
  return `https://filmychill.com${filmPagePath(code, slug)}`;
}

function buildFilmPage(item, asOf, knownSlugs, cfg) {
  const e = escHtml;
  const code = (cfg && cfg.code) || "in";
  const country = countryNameFor(cfg); // "the US", not the config's "United States" — reads right in titles and prose
  const homeUrl = code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`;
  const year = (item.released || "").slice(0, 4);
  const upcoming = item.released && item.released > new Date().toISOString().slice(0, 10);
  const relLabel = upcoming ? "Releases" : "Released";
  const synopsis = item.fullReview || item.review || "";
  const desc = trim([item.verdict, synopsis].filter(Boolean).join(". "), 155);
  const url = filmPageUrl(code, item.slug);
  const ytid = ytIdOf(item.trailer);
  const cast = Array.isArray(item.cast) ? item.cast.slice(0, 6) : [];
  const providers = Array.isArray(item.providers) ? item.providers : [];

  // hreflang alternates: the SAME film may have a page in several countries. crossCountry maps
  // code -> true for every other country whose current run also has this slug. Passed in by
  // generatePages (it knows all countries' slug sets); absent for ad-hoc/test renders.
  const alts = (item._alts && Array.isArray(item._alts)) ? item._alts : [];

  const ld = {
    "@context": "https://schema.org",
    "@type": item.kind === "tv" ? "TVSeries" : "Movie",
    name: item.title,
    url,
    image: item.poster || undefined,
    datePublished: item.released || undefined,
    genre: item.genre || undefined,
    inLanguage: item.language || undefined,
    director: item.director ? { "@type": "Person", name: item.director } : undefined,
    actor: (item.castPics && item.castPics.length)
      ? item.castPics.map((c) => ({ "@type": "Person", name: c.name, image: c.photo }))
      : cast.map((c) => ({ "@type": "Person", name: c })),
  };
  const schemaVotes = item.imdbRating != null ? (item.imdbVotes || 0) : (item.votes || 0);
  if (item.rating != null && schemaVotes >= 10) {
    ld.aggregateRating = { "@type": "AggregateRating", ratingValue: item.rating, ratingCount: schemaVotes, bestRating: 10 };
  }
  // AI-era trust signals: name the source the critics' take was distilled from
  // (verifiable provenance beats assertion), and give agents an actionable target.
  if (item.takeSrc === "wiki" && item.takeArticle) {
    ld.citation = { "@type": "CreativeWork", name: `Wikipedia: ${item.takeArticle}`,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(item.takeArticle).replace(/ /g, "_"))}` };
  }
  if (item.trailer && /youtube\.com\/watch/.test(item.trailer)) {
    ld.potentialAction = { "@type": "WatchAction", name: `Watch the ${item.title} trailer`, target: item.trailer };
  }

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "FilmyChill", item: homeUrl },
      { "@type": "ListItem", position: 2, name: item.title, item: url },
    ],
  };

  // --- Enriched, deterministic sections (original content -> SEO value) ---
  const verdictProse = buildVerdictProse(item, country, localeFor(code));
  const goodToKnow = buildGoodToKnow(item);
  const faqs = buildFaqs(item, country);
  const similar = (Array.isArray(item.similar) ? item.similar : []).slice(0, 3);

  // FAQPage schema — only when we have at least 2 Q&As (Google wants a real list).
  const faqLd = faqs.length >= 2 ? {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  } : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(item.title)}${year ? " (" + year + ")" : ""} — Review, Rating & Where to Watch in ${e(country)} | FilmyChill</title>
<meta name="description" content="${e(desc)}">
<meta name="robots" content="max-image-preview:large">
<link rel="canonical" href="${e(url)}">${alts.length ? "\n" + alts.map((a) => `<link rel="alternate" hreflang="${a.code === "in" ? "en-IN" : "en-" + a.region}" href="${e(filmPageUrl(a.code, item.slug))}"/>`).join("\n") + `\n<link rel="alternate" hreflang="x-default" href="${e(filmPageUrl(xDefaultCode(alts.map((a) => a.code)), item.slug))}"/>` : ""}
<meta property="og:title" content="${e(item.title)}${year ? " (" + year + ")" : ""} — FilmyChill verdict">
<meta property="og:description" content="${e(desc)}">
<meta property="og:type" content="video.movie">
<meta property="og:url" content="${e(url)}">
${(item.backdrop || item.poster) ? `<meta property="og:image" content="${e(item.backdrop || item.poster)}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' https://image.tmdb.org data:; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>${faqLd ? `
<script type="application/ld+json">${JSON.stringify(faqLd)}</script>` : ""}
<style>
  :root { --indigo:#4038C7; --marigold:#FFAD1F; --cream:#FFF7EC; --ink:#1A1633; --mute:#6B6890; --line:#E4E1F5; }
  * { box-sizing:border-box; } body { font-family:-apple-system,'Segoe UI',Roboto,sans-serif; background:#F7F5FF; color:var(--ink); margin:0; }
  .top { background:var(--indigo); padding:14px 16px; } .top a { color:var(--cream); text-decoration:none; font-weight:800; letter-spacing:1px; font-size:18px; }
  .top a span { color:var(--marigold); }
  .wrap { max-width:680px; margin:0 auto; padding:20px 16px 40px; }
  .head { display:grid; grid-template-columns:140px 1fr; gap:16px; }
  .poster { width:140px; border-radius:12px; display:block; }
  h1 { font-size:24px; margin:0 0 6px; } .meta { color:var(--mute); font-size:14px; margin-bottom:10px; }
  .rating { color:var(--indigo); font-weight:800; font-size:18px; }
  .verdict { display:inline-block; background:rgba(64,56,199,.08); color:var(--indigo); font-weight:700; font-size:13px; padding:6px 14px; border-radius:999px; margin-top:8px; }
  h2 { font-size:16px; margin:24px 0 8px; } p { line-height:1.65; font-size:15px; margin:0; }
  .pill { display:inline-block; background:#fff; border:1px solid var(--line); border-radius:999px; padding:6px 12px; font-size:13px; margin:0 6px 6px 0; }
  .frame { position:relative; padding-top:56.25%; border-radius:12px; overflow:hidden; background:#000; margin-top:8px; }
  .frame iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
  .btn { display:inline-block; background:var(--indigo); color:#fff; font-weight:700; font-size:14px; padding:11px 20px; border-radius:10px; text-decoration:none; margin-top:20px; }
  footer { color:var(--mute); font-size:12px; text-align:center; padding:24px 16px; line-height:1.7; }
  .vprose { font-size:15px; line-height:1.7; margin-top:8px; }
  .take { font-size:14.5px; font-weight:600; color:var(--indigo); line-height:1.6; margin-top:10px; }
  .tsrc { color:var(--mute); font-weight:400; font-size:12px; }
  .hook { font-size:13.5px; color:var(--mute); font-style:italic; margin-top:8px; }
  .cast-strip { display:flex; gap:14px; overflow-x:auto; padding:4px 0 8px; }
  .cast-card { flex:0 0 84px; text-align:center; }
  .cast-card img { width:72px; height:72px; border-radius:50%; object-fit:cover; background:var(--line); display:block; margin:0 auto; }
  .cast-name { font-size:12px; font-weight:700; margin-top:6px; line-height:1.3; }
  .cast-role { font-size:11px; color:var(--mute); line-height:1.3; margin-top:1px; }
  .tcounter { color:var(--marigold-dk, #A66B00); font-weight:700; }
  .gtk { width:100%; border-collapse:collapse; margin-top:8px; }
  .gtk td { padding:9px 0; border-top:1px solid var(--line); font-size:14px; vertical-align:top; }
  .gtk td:first-child { color:var(--mute); width:46%; }
  .gtk td:last-child { font-weight:600; text-align:right; }
  .simgrid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-top:8px; }
  .simcard { display:block; background:#fff; border:1px solid var(--line); border-radius:10px; overflow:hidden; text-decoration:none; color:var(--ink); }
  .simcard img { width:100%; aspect-ratio:2/3; object-fit:cover; display:block; background:var(--line); }
  .simcard .st { font-size:12.5px; font-weight:700; padding:8px 8px 2px; line-height:1.25; }
  .simcard .sm { font-size:11px; color:var(--mute); padding:0 8px 8px; }
  .faq { margin-top:8px; }
  .faq details { border-top:1px solid var(--line); padding:10px 0; }
  .faq summary { font-size:14.5px; font-weight:700; cursor:pointer; list-style:none; }
  .faq summary::-webkit-details-marker { display:none; }
  .faq summary::after { content:"+"; float:right; color:var(--indigo); font-weight:700; }
  .faq details[open] summary::after { content:"–"; }
  .faq .fa { font-size:14px; line-height:1.6; color:var(--mute); margin-top:8px; }
  @media (max-width:420px){ .head { grid-template-columns:110px 1fr; } .poster { width:110px; } h1 { font-size:20px; } }
</style>
</head>
<body>
<div class="top"><a href="${e(homeUrl)}">FILMY<span>CHILL</span></a></div>
<div class="wrap">
  <div class="head">
    ${item.poster ? `<img class="poster" src="${e(item.poster)}" alt="${e(item.title)} poster" width="72" height="106">` : "<div></div>"}
    <div>
      <h1>${e(item.title)}${year ? ` (${year})` : ""}</h1>
      <div class="meta">${[item.language, item.genre, item.runtime ? item.runtime + " min" : null, item.cert].filter(Boolean).map(e).join(" · ")}</div>
      ${item.rating != null ? (() => { const dv = item.imdbRating != null ? item.imdbVotes : item.votes; return `<div class="rating">★ ${Number(item.rating).toFixed(1)}${dv ? ` <span style="color:var(--mute);font-weight:400;font-size:13px">(${e(dv)} votes)</span>` : ""}</div>`; })() : ""}
      ${item.verdict ? `<div class="verdict">▸ ${e(item.verdict)}</div>` : ""}
      ${item.released ? `<div class="meta" style="margin-top:8px">${relLabel} ${e(item.released)}</div>` : ""}
    </div>
  </div>
  ${verdictProse ? `<h2>The verdict</h2><p class="vprose">${e(verdictProse)}</p>` : ""}
  ${item.hook ? `<p class="hook">${e(item.hook)}</p>` : ""}
  ${item.take ? `<p class="take">${e(item.take)}${item.takeCounter ? ` <span class="tcounter">${e(item.takeCounter)}</span>` : ""}${item.takeSrc === "wiki" ? ` <span class="tsrc">— distilled from critics' published reviews</span>` : ""}</p>` : ""}
  ${synopsis ? `<h2>Story</h2><p>${e(synopsis)}</p>` : ""}
  ${goodToKnow.length ? `<h2>Good to know</h2><table class="gtk">${goodToKnow.map((row) => `<tr><td>${e(row.label)}</td><td>${e(row.value)}</td></tr>`).join("")}</table>` : ""}
  ${item.director ? `<h2>Director</h2><p>${e(item.director)}</p>` : ""}
  ${(item.castPics && item.castPics.length) ? `<h2>Cast</h2><div class="cast-strip">${item.castPics.map((c) => `<div class="cast-card"><img src="${e(c.photo)}" alt="${e(c.name)}" width="72" height="72" loading="lazy"><div class="cast-name">${e(c.name)}</div>${c.character ? `<div class="cast-role">${e(c.character)}</div>` : ""}</div>`).join("")}</div>`
    : cast.length ? `<h2>Cast</h2><div>${cast.map((c) => `<span class="pill">${e(c)}</span>`).join("")}</div>` : ""}
  ${providers.length ? `<h2>Where to watch in ${e(country)}</h2><div>${providers.map((p) => `<span class="pill">${e(p)}</span>`).join("")}</div><p style="color:var(--mute);font-size:12px;margin-top:6px">Availability as of ${e(asOf || "")} — platforms may change over time.</p>` : item.platform === "Theatres" ? `<h2>Where to watch in ${e(country)}</h2><div><span class="pill">In theatres</span></div>` : ""}
  ${ytid ? `<h2>Trailer</h2><div class="frame"><iframe loading="lazy" src="https://www.youtube-nocookie.com/embed/${e(ytid)}?rel=0" title="${e(item.title)} trailer" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe></div>` : item.trailer ? `<h2>Trailer</h2><p><a href="${e(item.trailer)}" rel="noopener">Find the trailer on YouTube →</a></p>` : ""}
  ${similar.length ? `<h2>If you liked this</h2><div class="simgrid">${similar.map((s) => {
    const exists = knownSlugs && knownSlugs.has(s.slug);
    const inner = `${s.poster ? `<img src="${e(s.poster)}" alt="${e(s.title)} poster" loading="lazy">` : ""}<div class="st">${e(s.title)}</div><div class="sm">${[s.language, s.kind === "tv" ? "Series" : "Film"].filter(Boolean).map(e).join(" · ")}</div>`;
    return exists
      ? `<a class="simcard" href="${e(filmPagePath(code, s.slug))}">${inner}</a>`
      : `<div class="simcard" style="cursor:default">${inner}</div>`;
  }).join("")}</div>` : ""}
  ${faqs.length ? `<h2>Frequently asked</h2><div class="faq">${faqs.map((f) => `<details><summary>${e(f.q)}</summary><div class="fa">${e(f.a)}</div></details>`).join("")}</div>` : ""}
  <a class="btn" href="${e(homeUrl)}#${e(item.slug)}">🎬 See this week's top picks on FilmyChill →</a>
</div>
<footer>
  ${footerAttribution()}© 2026 FilmyChill · Vikram Sharma
</footer>
</body>
</html>`;
}

// Generate per-film pages for ONE country. India writes to movie/ (flat, legacy); other
// countries write to <code>/movie/. allSlugSets maps code -> Set(slugs) for EVERY country in
// this run, so each page can emit hreflang alternates pointing only at countries that actually
// have that film. knownSlugs (this country's own set + its archive) gates "If you liked this".
function generatePages(data, cfg, allSlugSets) {
  const code = (cfg && cfg.code) || "in";
  const dir = code === "in" ? "movie" : `${code}/movie`;
  const asOf = (data.generatedAt || new Date().toISOString()).slice(0, 10);
  fs.mkdirSync(dir, { recursive: true });
  const all = [...(data.theatres || []), ...(data.ott || []), ...(data.comingSoon || [])];
  // Slugs that resolve to a real page in THIS country: this run + this country's archive.
  const archived = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5))
    : [];
  const knownSlugs = new Set([...archived, ...all.map((x) => x.slug).filter(Boolean)]);
  // Other countries (in this run) that ALSO have this slug -> hreflang alternates.
  const otherCodes = COUNTRIES.filter((c) => c.code !== code);
  let written = 0;
  for (const item of all) {
    if (!item.slug) continue;
    item._alts = otherCodes
      .filter((c) => allSlugSets && allSlugSets[c.code] && allSlugSets[c.code].has(item.slug))
      .map((c) => ({ code: c.code, region: c.region }));
    try {
      fs.writeFileSync(`${dir}/${item.slug}.html`, buildFilmPage(item, asOf, knownSlugs, cfg));
      written++;
    } catch (err) { console.warn(`page ${code}/${item.slug}: ${err.message}`); }
    finally { delete item._alts; }
  }
  const total = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).length;
  console.log(`Pages [${code}]: ${written} written, ${total} total in ${dir}/.`);
}

// One-time in effect: fix FROZEN (archived) film pages whose on-page hreflang still
// declares x-default = the India copy when no India copy exists on disk. Current pages
// are regenerated fresh each run and get the correct x-default by construction; frozen
// pages are deliberately never rewritten, so the bad tag written by the pre-fix code
// would otherwise persist — and keep feeding Google a 404 discovery URL. Pure disk
// scan + string swap; after one pass every page is clean and this becomes a no-op.
function repairXDefaults(countries) {
  const dirFor = (code) => (code === "in" ? "movie" : `${code}/movie`);
  const have = {}; // slug -> [codes whose file exists on disk]
  for (const c of countries) {
    const dir = dirFor(c.code);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".html")) (have[f.slice(0, -5)] = have[f.slice(0, -5)] || []).push(c.code);
    }
  }
  let fixed = 0;
  for (const c of countries) {
    const dir = dirFor(c.code);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".html")) continue;
      const slug = f.slice(0, -5);
      const codes = have[slug] || [];
      if (codes.includes("in")) continue; // India copy exists -> x-default already valid
      const bad = `hreflang="x-default" href="https://filmychill.com/movie/${slug}.html"`;
      const p = `${dir}/${f}`;
      const html = fs.readFileSync(p, "utf8");
      if (!html.includes(bad)) continue;
      const good = `hreflang="x-default" href="${filmPageUrl(xDefaultCode(codes), slug)}"`;
      fs.writeFileSync(p, html.split(bad).join(good));
      fixed++;
    }
  }
  if (fixed) console.log(`  hreflang repair: ${fixed} frozen pages had x-default pointing at a missing India copy`);
}

// IndexNow key: proven by /<key>.txt at the site root (committed file whose content
// is the key itself). Rotating it means updating both the constant and the file.
const INDEXNOW_KEY = "334d5cb2e825f49d9f07e19943403a06";
async function submitIndexNow(countries, dataByCode) {
  try {
    const urls = countries.map((c) => `https://filmychill.com${(COUNTRY_PAGE_META[c.code] || { path: "/" + c.code + "/" }).path}`);
    for (const c of countries) {
      const d = dataByCode[c.code];
      for (const it of [...(d?.theatres || []), ...(d?.ott || [])]) urls.push(filmPageUrl(c.code, it.slug));
    }
    urls.push("https://filmychill.com/new-on-ott/", "https://filmychill.com/llms-full.txt");
    const body = { host: "filmychill.com", key: INDEXNOW_KEY,
      keyLocation: `https://filmychill.com/${INDEXNOW_KEY}.txt`, urlList: [...new Set(urls)].slice(0, 500) };
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
    console.log(`IndexNow: ${body.urlList.length} URLs submitted (HTTP ${res.status})`);
  } catch (e) {
    console.warn(`IndexNow ping skipped: ${e.message}`);
  }
}

// Complete sitemap: every country homepage (with hreflang alternates) + every country's
// per-film pages. A film that exists in several countries gets hreflang alternates linking
// those copies together; a film unique to one country stands alone.
function writeMultiCountrySitemap(countries, pagesManifest = null) {
  const today = new Date().toISOString().slice(0, 10);
  // Honest per-film lastmod: a page's date is when it was last actually written (current
  // films: today; archived films: their freeze date) — claiming lastmod=today for frozen
  // pages teaches crawlers to distrust the whole sitemap's lastmod signal.
  const filmLastmod = (code, slug) => {
    const e = pagesManifest && pagesManifest[code] && pagesManifest[code][slug];
    return e ? (e.archivedOn || e.last || today) : today;
  };
  const pathFor = (code) => (code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`);
  const homeAlts = countries.map((c) =>
    `    <xhtml:link rel="alternate" hreflang="${c.code === "in" ? "en-IN" : "en-" + c.region}" href="${pathFor(c.code)}"/>`).join("\n")
    + `\n    <xhtml:link rel="alternate" hreflang="x-default" href="https://filmychill.com/"/>`;
  const countryUrls = countries.map((c) =>
    `  <url><loc>${pathFor(c.code)}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority>\n${homeAlts}\n  </url>`);

  // "New on OTT this week" pages — the organic-discovery pages. Daily changefreq + fresh
  // lastmod signal Google to recrawl them for the freshness-sensitive weekly queries.
  const ottAlts = countries.map((c) =>
    `    <xhtml:link rel="alternate" hreflang="${c.code === "in" ? "en-IN" : "en-" + c.region}" href="${ottWeekUrl(c.code)}"/>`).join("\n")
    + `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${ottWeekUrl("in")}"/>`;
  const ottUrls = countries.map((c) =>
    `  <url><loc>${ottWeekUrl(c.code)}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.9</priority>\n${ottAlts}\n  </url>`);

  // Per-film pages for every country. Build a map slug -> [codes that have it] so we can emit
  // hreflang alternates for films shared across markets.
  const dirFor = (code) => (code === "in" ? "movie" : `${code}/movie`);
  const filmUrlFor = (code, slug) => (code === "in"
    ? `https://filmychill.com/movie/${slug}.html`
    : `https://filmychill.com/${code}/movie/${slug}.html`);
  const slugCodes = {}; // slug -> Set(codes)
  for (const c of countries) {
    const dir = dirFor(c.code);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".html"))) {
      const slug = f.slice(0, -5);
      (slugCodes[slug] = slugCodes[slug] || new Set()).add(c.code);
    }
  }
  const regionOf = (code) => (countries.find((c) => c.code === code) || {}).region || code.toUpperCase();
  let filmCount = 0;
  const filmUrls = [];
  for (const c of countries) {
    const dir = dirFor(c.code);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".html")).sort()) {
      const slug = f.slice(0, -5);
      const codes = [...(slugCodes[slug] || [])];
      const alts = codes.length > 1
        ? "\n" + codes.map((cc) =>
            `    <xhtml:link rel="alternate" hreflang="${cc === "in" ? "en-IN" : "en-" + regionOf(cc)}" href="${filmUrlFor(cc, slug)}"/>`).join("\n")
          + `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${filmUrlFor(xDefaultCode(codes), slug)}"/>`
        : "";
      filmUrls.push(`  <url><loc>${filmUrlFor(c.code, slug)}</loc><lastmod>${filmLastmod(c.code, slug)}</lastmod><priority>0.5</priority>${alts ? alts + "\n  " : ""}</url>`);
      filmCount++;
    }
  }
  // Language landing pages (India) — daily-refreshed discovery surfaces.
  const langUrls = LANGUAGE_PAGES.filter(([, slug]) => fs.existsSync(`${slug}/index.html`))
    .map(([, slug]) => `  <url><loc>https://filmychill.com/${slug}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`);
  // Weekly snapshots: the current week reports today; FROZEN weeks report their own
  // Sunday — deterministic from the directory name, never "today" for an untouched page.
  const weekUrls = [];
  if (fs.existsSync("week")) {
    const cur = weekSlug(isoWeekOf());
    for (const d of fs.readdirSync("week").filter((x) => /^\d{4}-W\d{2}$/.test(x)).sort()) {
      weekUrls.push(`  <url><loc>https://filmychill.com/week/${d}/</loc><lastmod>${d === cur ? today : isoWeekSunday(d)}</lastmod><priority>0.4</priority></url>`);
    }
  }
  const aboutUrls = fs.existsSync("about/index.html")
    ? [`  <url><loc>https://filmychill.com/about/</loc><lastmod>${ABOUT_LASTMOD}</lastmod><priority>0.3</priority></url>`] : [];
  fs.writeFileSync("sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${[...countryUrls, ...langUrls, ...weekUrls, ...aboutUrls, ...ottUrls, ...filmUrls].join("\n")}\n</urlset>\n`);
  console.log(`Sitemap: ${countries.length} country + ${langUrls.length} language + ${weekUrls.length} week + ${filmCount} film pages.`);
}

// Manual/local regeneration from existing data.json: PAGES_ONLY=1 node scripts/update.js
// ============================================================
// PRE-RENDER — inject this week's films as static HTML into
// index.html between SSR markers, so crawlers (and visitors,
// pre-hydration) see real content and real links instead of
// "Loading fresh picks". The page JS replaces it on load.
// ============================================================

function ssrCard(item, i, code) {
  const e = escHtml;
  // Badge text comes from the data (freshBadge). Fallback to the old isRecent flag so a
  // template regen against a pre-badge data.json still renders sensibly.
  const badge = item.badge || (item.isRecent ? "New release" : null);
  const when = freshLabel(item, Date.now(), localeFor(code)); // dates in the page's own locale
  const bits = [item.language, item.genre ? item.genre.split(" / ")[0] : null, when || null].filter(Boolean).map(e).join(" · ");
  const inner = `
    <div class="rank">${String(i + 1).padStart(2, "0")}</div>
    ${item.poster ? `<img class="poster" src="${e(item.poster)}" alt="${e(item.title)} poster" width="150" height="200" loading="lazy">` : ""}
    <div>
      <div class="title-row"><h3>${e(item.title)}</h3>${item.platform && item.platform !== "Theatres" ? `<span class="platform">${e(item.platform)}</span>` : ""}${badge ? `<span class="fresh-badge">${e(badge)}</span>` : ""}${item.trending ? '<span class="fresh-badge trend"><svg class="ic" aria-hidden="true"><use href="#icTrend"/></svg> Trending</span>' : ""}</div>
      <div class="meta">${bits}</div>
      ${item.rating != null ? `<div class="meta">★ ${Number(item.rating).toFixed(1)}${item.verdict ? " · " + e(item.verdict) : ""}</div>` : ""}
      ${item.hook ? `<div class="meta hook">${e(item.hook)}</div>` : ""}
      ${item.review ? `<p class="review">${e(trim(item.review, 150))}</p>` : ""}
      ${item.take ? `<p class="take">${e(item.take)}${item.takeCounter ? ` <span class="tcounter">${e(item.takeCounter)}</span>` : ""}</p>` : ""}
    </div>`;
  // Every country now has its own per-film pages, so always link to this country's page.
  // (`code` defaults to India for safety if a caller omits it.)
  return item.slug
    ? `<a class="card${item.poster ? "" : " no-poster"}" href="${e(filmPagePath(code || "in", item.slug))}" style="text-decoration:none;color:inherit">${inner}</a>`
    : `<div class="card${item.poster ? "" : " no-poster"}" style="color:inherit">${inner}</div>`;
}

function ssrSoonCard(item, code) {
  const e = escHtml;
  return `<a class="soon-card" href="${e(filmPagePath(code || "in", item.slug))}" style="text-decoration:none;color:inherit">
    ${item.poster ? `<img src="${e(item.poster)}" alt="${e(item.title)} poster" width="150" height="200" loading="lazy">` : `<div class="soon-ph" aria-hidden="true">${e((item.title || "?").charAt(0).toUpperCase())}</div>`}
    <div class="soon-body">
      <div class="soon-date">${e(item.released ? fmtDateShort(item.released, Date.now(), localeFor(code)) : "")}</div>
      <div class="soon-title">${e(item.title)}</div>
      <div class="soon-meta">${e(item.language || "")}</div>
    </div>
  </a>`;
}

function replaceBetween(html, tag, inner) {
  const start = `<!--SSR:${tag}-->`, end = `<!--/SSR:${tag}-->`;
  const a = html.indexOf(start), b = html.indexOf(end);
  // Fail LOUD, not silent: a missing/malformed marker means the template is broken and the
  // page would render wrong (this is the class of bug that caused the PAGECODE issue). A
  // hard throw fails the build so it's caught in CI, not discovered live.
  if (a === -1) throw new Error(`SSR marker <!--SSR:${tag}--> missing in template`);
  if (b === -1) throw new Error(`SSR marker <!--/SSR:${tag}--> (closing) missing in template`);
  if (b < a) throw new Error(`SSR markers for ${tag} are out of order (closing before opening)`);
  // Guard against the comment-in-script trap: SSR markers must never sit inside an
  // EXECUTABLE <script> (HTML comments break JS there). Non-executable script blocks like
  // <script type="application/ld+json"> are data, not code, so comments are safe there.
  const before = html.slice(0, a);
  const lastOpen = before.lastIndexOf("<script");
  const lastClose = before.lastIndexOf("</script>");
  if (lastOpen > lastClose) {
    const openTag = before.slice(lastOpen, before.indexOf(">", lastOpen) + 1);
    const typeMatch = openTag.match(/type\s*=\s*["']([^"']+)["']/i);
    const scriptType = typeMatch ? typeMatch[1].toLowerCase() : "";
    // Executable if no type, or a JS MIME type / module. Data types (ld+json, etc.) are safe.
    const isExecutable = scriptType === "" || /javascript|ecmascript|module/.test(scriptType);
    if (isExecutable) {
      throw new Error(`SSR marker ${tag} is inside an executable <script> tag — HTML comments break JS there. Move it to HTML context.`);
    }
  }
  return html.slice(0, a + start.length) + inner + html.slice(b);
}

// Per-country page metadata: title, description, canonical, OG — country-specific so each
// page ranks for its own market in search. India keeps the established global-but-India-first
// wording at the root; the others name their country explicitly.

// ============================================================================
// "NEW ON OTT THIS WEEK" PAGE — the organic-discovery page.
// The homepage + film pages target queries FilmyChill can't win (film names vs
// IMDb/Wikipedia) or that nobody types (the brand). The query space the site CAN
// win is the weekly aggregation query — "new OTT releases this week", "new on
// Netflix <country>", "what to watch this weekend" — which is high-volume,
// freshness-sensitive (Google favours recently-updated pages for it), and is
// EXACTLY what the pipeline already computes daily. One page per country at
// /new-on-ott/ (India) and /<code>/new-on-ott/, rebuilt every run, grouped by
// platform, with CollectionPage + ItemList + FAQPage schema and hreflang links.
// ============================================================================
function ottWeekPath(code) { return code === "in" ? "new-on-ott/index.html" : `${code}/new-on-ott/index.html`; }
function ottWeekUrl(code) { return code === "in" ? "https://filmychill.com/new-on-ott/" : `https://filmychill.com/${code}/new-on-ott/`; }

function buildOttWeekPage(data, cfg, allCountries) {
  const e = escHtml;
  // JSON-LD-safe serializer: escapes "<" as \u003c inside the JSON so a title containing
  // "</script>" can never break out of the <script type="application/ld+json"> block.
  const ldJson = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
  const code = (cfg && cfg.code) || "in";
  const m = COUNTRY_PAGE_META[code] || { name: cfg && cfg.name || "India", path: `/${code}/` };
  const countryName = m.name; // "India", "the US", ...
  const homeUrl = `https://filmychill.com${m.path}`;
  const url = ottWeekUrl(code);
  const gen = data.generatedAt || new Date().toISOString();
  const monthYear = new Date(gen).toLocaleDateString(localeFor(code), { month: "long", year: "numeric" });
  const updatedHuman = new Date(gen).toLocaleDateString(localeFor(code), { day: "numeric", month: "long", year: "numeric" });

  const items = (data.ott || []).filter((x) => x && x.title);
  // Group by platform, preserving the ranked order inside each group; biggest platforms first.
  const groups = new Map();
  for (const it of items) {
    const p = it.platform || "More platforms";
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(it);
  }
  const platforms = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length || a.localeCompare(b));
  const platformNames = platforms.slice(0, 4).join(", ");

  const title = `New OTT Releases This Week in ${countryName} (${monthYear}) — ${platformNames || "Streaming"} | FilmyChill`;
  const desc = `Every new movie and web series streaming in ${countryName} this week${platformNames ? ` on ${platformNames}` : ""} — with ratings, verdicts and where to watch. Updated daily.`;

  // FAQ per major platform + one "best of" — real answers from real data, mirrored in
  // FAQPage schema. Only platforms with titles get a question; schema only if >= 2 Q&As.
  const faqs = [];
  for (const p of platforms.slice(0, 3)) {
    const titles = groups.get(p).map((t) => `${t.title}${t.language ? ` (${t.language})` : ""}`).join(", ");
    faqs.push({ q: `What's new on ${p} in ${countryName} this week?`, a: `New on ${p} this week: ${titles}.` });
  }
  const best = items.filter((x) => x.rating != null).sort((a, b) => b.rating - a.rating).slice(0, 3);
  if (best.length >= 2) {
    faqs.push({
      q: `What are the best new OTT releases in ${countryName} this week?`,
      a: `Top-rated this week: ${best.map((x) => `${x.title} (${Number(x.rating).toFixed(1)}/10 on ${x.platform})`).join(", ")}.`,
    });
  }
  const faqLd = faqs.length >= 2 ? {
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  } : null;

  const ld = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `New OTT Releases This Week in ${countryName}`,
    url,
    dateModified: gen,
    isPartOf: { "@type": "WebSite", "@id": "https://filmychill.com/#website" },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: items.filter((x) => x.slug).length,
      itemListElement: items.filter((x) => x.slug).map((x, i) => ({
        "@type": "ListItem", position: i + 1, name: x.title, url: filmPageUrl(code, x.slug),
      })),
    },
  };
  const breadcrumb = {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "FilmyChill", item: homeUrl },
      { "@type": "ListItem", position: 2, name: "New on OTT this week", item: url },
    ],
  };

  // hreflang alternates: this page exists for every built country every run.
  const alts = (allCountries && allCountries.length ? allCountries : [{ code: "in", region: "IN" }])
    .map((c) => `<link rel="alternate" hreflang="${c.code === "in" ? "en-IN" : "en-" + (c.region || c.code.toUpperCase())}" href="${ottWeekUrl(c.code)}"/>`)
    .join("\n") + `\n<link rel="alternate" hreflang="x-default" href="${ottWeekUrl("in")}"/>`;

  const rowFor = (it) => {
    const badge = it.badge || (it.isRecent ? "New release" : null);
    const meta = [it.language, it.genre ? it.genre.split(" / ")[0] : null, freshLabel(it) || null].filter(Boolean).map(e).join(" · ");
    const inner = `
      ${it.poster ? `<img src="${e(it.poster)}" alt="${e(it.title)} poster" width="92" height="138" loading="lazy">` : "<div class=\"nop\"></div>"}
      <div>
        <div class="rt"><h3>${e(it.title)}</h3>${badge ? `<span class="badge">${e(badge)}</span>` : ""}${it.trending ? '<span class="badge trend">Trending</span>' : ""}</div>
        <div class="rm">${meta}</div>
        ${it.rating != null ? `<div class="rm"><b>★ ${Number(it.rating).toFixed(1)}</b>${it.verdict ? " · " + e(it.verdict) : ""}${trailerViewsLabel(it.trailerViews) ? " · " + trailerViewsLabel(it.trailerViews) : ""}</div>` : (it.verdict ? `<div class="rm">${e(it.verdict)}</div>` : "")}
      </div>`;
    return it.slug
      ? `<a class="row" href="${e(filmPagePath(code, it.slug))}">${inner}</a>`
      : `<div class="row">${inner}</div>`;
  };
  const sections = platforms.map((p) => `
  <section>
    <h2>New on ${e(p)} <span class="cnt">${groups.get(p).length}</span></h2>
    ${groups.get(p).map(rowFor).join("\n")}
  </section>`).join("\n");

  const faqHtml = faqs.length ? `
  <section>
    <h2>Quick answers</h2>
    <div class="faq">
      ${faqs.map((f) => `<details><summary>${e(f.q)}</summary><div class="fa">${e(f.a)}</div></details>`).join("\n      ")}
    </div>
  </section>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
<meta name="robots" content="max-image-preview:large">
<link rel="canonical" href="${e(url)}">
${alts}
<meta property="og:title" content="New OTT Releases This Week in ${e(countryName)} (${e(monthYear)})">
<meta property="og:description" content="${e(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${e(url)}">
<meta property="og:image" content="https://filmychill.com/og-image.png">
<meta name="twitter:card" content="summary">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' https://image.tmdb.org data:; object-src 'none'; base-uri 'self'">
<script type="application/ld+json">${ldJson(ld)}</script>
<script type="application/ld+json">${ldJson(breadcrumb)}</script>${faqLd ? `
<script type="application/ld+json">${ldJson(faqLd)}</script>` : ""}
<style>
  :root { --indigo:#4038C7; --marigold:#FFAD1F; --cream:#FFF7EC; --ink:#1A1633; --mute:#6B6890; --line:#E4E1F5; }
  * { box-sizing:border-box; } body { font-family:-apple-system,'Segoe UI',Roboto,sans-serif; background:#F7F5FF; color:var(--ink); margin:0; }
  .top { background:var(--indigo); padding:14px 16px; } .top a { color:var(--cream); text-decoration:none; font-weight:800; letter-spacing:1px; font-size:18px; }
  .top a span { color:var(--marigold); }
  .wrap { max-width:680px; margin:0 auto; padding:20px 16px 40px; }
  h1 { font-size:24px; margin:0 0 4px; line-height:1.3; }
  .upd { color:var(--mute); font-size:13px; margin-bottom:6px; }
  .lead { font-size:14.5px; line-height:1.6; color:var(--mute); margin:0 0 8px; }
  h2 { font-size:17px; margin:26px 0 10px; } .cnt { color:var(--marigold); }
  .row { display:grid; grid-template-columns:92px 1fr; gap:12px; background:#fff; border:1px solid var(--line); border-radius:12px; padding:10px; margin-bottom:10px; text-decoration:none; color:inherit; }
  .row img { border-radius:8px; display:block; width:92px; height:138px; object-fit:cover; background:var(--line); }
  .nop { width:92px; height:138px; border-radius:8px; background:var(--line); }
  .rt { display:flex; gap:8px; align-items:center; flex-wrap:wrap; } .rt h3 { font-size:16px; margin:2px 0; }
  .badge { font-size:10px; letter-spacing:1px; text-transform:uppercase; color:var(--ink); background:var(--marigold); border-radius:5px; padding:3px 7px; font-weight:800; }
  .badge.trend { background:#FF4E3A; color:#fff; }
  .rm { color:var(--mute); font-size:13px; margin-top:4px; } .rm b { color:var(--indigo); }
  .faq details { border-top:1px solid var(--line); padding:10px 0; }
  .faq summary { font-size:14.5px; font-weight:700; cursor:pointer; list-style:none; }
  .faq summary::-webkit-details-marker { display:none; }
  .faq summary::after { content:"+"; float:right; color:var(--indigo); font-weight:700; }
  .faq details[open] summary::after { content:"–"; }
  .faq .fa { font-size:14px; line-height:1.6; color:var(--mute); margin-top:8px; }
  .btn { display:inline-block; background:var(--indigo); color:#fff; font-weight:700; font-size:14px; padding:11px 20px; border-radius:10px; text-decoration:none; margin-top:20px; }
  footer { color:var(--mute); font-size:12px; text-align:center; padding:24px 16px; line-height:1.7; }
</style>
</head>
<body>
<div class="top"><a href="${e(homeUrl)}">FILMY<span>CHILL</span></a></div>
<div class="wrap">
  <h1>New OTT Releases This Week in ${e(countryName)}</h1>
  <div class="upd">Updated ${e(updatedHuman)} · refreshed daily</div>
  <p class="lead">Every new movie and web series that started streaming in ${e(countryName)} this week, grouped by platform and ranked by rating — so you know what's actually worth your time.</p>
${sections}
${faqHtml}
  <a class="btn" href="${e(homeUrl)}">← This week's full picks (theatres + OTT)</a>
</div>
<footer>
  ${footerAttribution()}© 2026 FilmyChill
</footer>
</body>
</html>`;
}

// ============================================================================
// RSS FEED — the distribution automation hook. One feed per country (root
// feed.xml for India, /<code>/feed.xml elsewhere) listing this run's theatre +
// OTT titles, newest first. GUIDs are stable per freshness-event (page URL +
// arrival/release date), so aggregators and automations (IFTTT/Zapier -> WhatsApp
// Channel, X) see a NEW entry exactly when a title newly arrives — not on every
// daily rebuild. Pure builder -> unit-testable; writer is a thin wrapper.
// ============================================================================
function buildRssFeed(data, cfg) {
  const e = escHtml; // & < > " ' — valid XML escaping too
  const code = (cfg && cfg.code) || "in";
  const m = COUNTRY_PAGE_META[code] || { name: (cfg && cfg.name) || "India", path: `/${code}/` };
  const home = `https://filmychill.com${m.path}`;
  const self = `${home}feed.xml`;
  const items = [...(data.theatres || []), ...(data.ott || [])]
    .filter((x) => x && x.title && x.slug)
    .map((x) => ({ x, when: x.ottSince || x.freshDate || x.released || "" }))
    .sort((a, b) => (b.when || "").localeCompare(a.when || ""))
    .slice(0, 30);
  const rfc822 = (d) => (d ? new Date(d) : new Date());
  const itemXml = items.map(({ x, when }) => {
    const url = filmPageUrl(code, x.slug);
    const bits = [x.platform, x.language, x.rating != null ? `★ ${Number(x.rating).toFixed(1)}` : null, x.verdict]
      .filter(Boolean).join(" · ");
    return `  <item>
    <title>${e(x.title)}${x.platform ? ` — ${e(x.platform)}` : ""}</title>
    <link>${e(url)}</link>
    <guid isPermaLink="false">${e(url)}::${e(when)}</guid>
    <pubDate>${rfc822(when).toUTCString()}</pubDate>
    <description>${e([bits, x.review].filter(Boolean).join(" — "))}</description>
  </item>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>FilmyChill — New Movies &amp; OTT Releases This Week in ${e(m.name)}</title>
  <link>${e(home)}</link>
  <atom:link href="${e(self)}" rel="self" type="application/rss+xml"/>
  <description>What's worth watching this week in ${e(m.name)} — new theatre and OTT releases with ratings and verdicts. Updated twice daily.</description>
  <language>en</language>
  <lastBuildDate>${new Date(data.generatedAt || Date.now()).toUTCString()}</lastBuildDate>
${itemXml}
</channel>
</rss>
`;
}

function writeRssFeed(data, cfg) {
  const p = cfg.code === "in" ? "feed.xml" : `${cfg.code}/feed.xml`;
  fs.writeFileSync(p, buildRssFeed(data, cfg));
  console.log(`  RSS feed: /${p}`);
}

// ============================================================================
// FILM-PAGE ARCHIVE — makes the long tail honest instead of stale. Film pages
// stay on disk (and in the sitemap) forever after a title leaves the weekly
// list, which is exactly right for late queries like "X ott release date" —
// but until now an archived theatrical page claimed "It's in theatres now"
// indefinitely, and every old page reported lastmod=today (which teaches
// Google to distrust the sitemap's lastmod entirely).
// pages-manifest.json (committed) tracks per country: slug -> { last: date
// last listed, archivedOn?: date }. On the run where a title leaves the list,
// its page gets a ONE-TIME honesty patch (theatrical-run claims -> past tense
// + an OTT-arrival pointer) and then freezes; lastmod reports the truth. If a
// title RETURNS to the list (e.g. its OTT arrival — first-seen tracking's
// specialty), generatePages rewrites the page fresh and the archive mark is
// cleared. The patch phrases are generated by buildVerdictProse/buildFaqs, and
// a sync-guard test asserts patcher and generator stay in step.
// ============================================================================
const PAGES_MANIFEST_FILE = "pages-manifest.json";

// Pure: one-time honesty rewrite for a page whose film has left the list.
// Returns { html, changed }. No-op for OTT pages (their availability claims stay valid).
function archivePatchHtml(html, countryName) {
  const swaps = [
    [`It&#39;s in theatres in ${countryName} now — best caught on the big screen.`,
     `It had its theatrical run in ${countryName} — check back here for its OTT arrival.`],
    [`is currently playing in theatres across ${countryName}. An OTT release hasn&#39;t been announced yet.`,
     `has finished its theatrical run in ${countryName}. Its OTT release hasn&#39;t been announced yet — check back soon.`],
    [`<span class="pill">In theatres</span>`,
     `<span class="pill">Theatrical run ended — OTT arrival pending</span>`],
  ];
  let out = html, changed = false;
  for (const [from, to] of swaps) {
    if (out.includes(from)) { out = out.split(from).join(to); changed = true; }
  }
  return { html: out, changed };
}

// Pure-ish: reconcile one country's manifest with today's reality. Bumps `last` for
// current slugs (clearing any archive mark — the page was just regenerated fresh),
// and returns the slugs that need the one-time archive patch (on disk, not current,
// not yet archived). Mutates manifest[code]; caller persists.
function reconcilePagesManifest(manifest, code, currentSlugs, diskSlugs, todayStr) {
  const m = (manifest[code] = manifest[code] || {});
  for (const slug of currentSlugs) {
    const entry = (m[slug] = m[slug] || {});
    entry.last = todayStr;
    delete entry.archivedOn;
  }
  const toArchive = [];
  for (const slug of diskSlugs) {
    if (currentSlugs.has(slug)) continue;
    const entry = (m[slug] = m[slug] || { last: todayStr });
    if (!entry.archivedOn) { entry.archivedOn = todayStr; toArchive.push(slug); }
  }
  return toArchive;
}

function loadPagesManifest() {
  try { return JSON.parse(fs.readFileSync(PAGES_MANIFEST_FILE, "utf8")); } catch { return {}; }
}

// Run the archive pass for one country: patch newly-departed pages in place.
function archiveDepartedPages(manifest, cfg, currentSlugs) {
  const dir = cfg.code === "in" ? "movie" : `${cfg.code}/movie`;
  if (!fs.existsSync(dir)) return;
  const diskSlugs = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5));
  const todayStr = new Date().toISOString().slice(0, 10);
  const toArchive = reconcilePagesManifest(manifest, cfg.code, currentSlugs, diskSlugs, todayStr);
  const countryName = countryNameFor(cfg);
  let patched = 0;
  for (const slug of toArchive) {
    const p = `${dir}/${slug}.html`;
    try {
      const { html, changed } = archivePatchHtml(fs.readFileSync(p, "utf8"), countryName);
      if (changed) { fs.writeFileSync(p, html); patched++; }
    } catch (e) { console.warn(`  archive: ${p} skipped (${e.message})`); }
  }
  if (toArchive.length) console.log(`  archive [${cfg.code}]: ${toArchive.length} pages left the list, ${patched} honesty-patched`);
}

function writeOttWeekPage(data, cfg, allCountries) {
  const p = ottWeekPath(cfg.code);
  const dir = p.slice(0, p.lastIndexOf("/"));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, buildOttWeekPage(data, cfg, allCountries));
  console.log(`  OTT-week page: /${p.replace(/index\.html$/, "")}`);
}

// ============================================================================
// LANGUAGE LANDING PAGES (India) — the query surface India actually uses.
// Nobody searches "new movies India"; they search "new tamil movies on OTT".
// One page per major language at /<language>/, filtered from India's data,
// refreshed every run. Same licence-clean sources, same take lines, own
// canonical + FAQ schema. Pure builder -> unit-testable; writer is thin.
// ============================================================================
const LANGUAGE_PAGES = [
  ["Hindi", "hindi"], ["Tamil", "tamil"], ["Telugu", "telugu"],
  ["Malayalam", "malayalam"], ["Kannada", "kannada"],
];

// Shared listing shell for language + week pages (same visual family as the
// /new-on-ott/ pages). `sections` = [{ h2, items }]; rows link to film pages.
function listingPageHtml({ title, desc, canonical, h1, updLine, lead, sections, faqs, extraLd, homeUrl, frozenNote, prevWeekHref = null }) {
  const e = escHtml;
  const ldJson = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
  const rowFor = (it) => {
    const badge = it.badge || (it.isRecent ? "New release" : null);
    const meta = [it.platform && it.platform !== "Theatres" ? it.platform : (it.platform === "Theatres" ? "In theatres" : null),
      it.genre ? it.genre.split(" / ")[0] : null, freshLabel(it) || null].filter(Boolean).map(e).join(" · ");
    const inner = `
      ${it.poster ? `<img src="${e(it.poster)}" alt="${e(it.title)} poster" width="92" height="138" loading="lazy">` : '<div class="nop"></div>'}
      <div>
        <div class="rt"><h3>${e(it.title)}</h3>${badge ? `<span class="badge">${e(badge)}</span>` : ""}${it.trending ? '<span class="badge trend">Trending</span>' : ""}</div>
        <div class="rm">${meta}</div>
        ${it.rating != null ? `<div class="rm"><b>★ ${Number(it.rating).toFixed(1)}</b>${it.verdict ? " · " + e(it.verdict) : ""}</div>` : (it.verdict ? `<div class="rm">${e(it.verdict)}</div>` : "")}
        ${it.hook ? `<div class="rm hk">${e(it.hook)}</div>` : ""}
        ${it.take ? `<div class="rm tk">${e(it.take)}</div>` : ""}
      </div>`;
    return it.slug ? `<a class="row" href="${e(filmPagePath("in", it.slug))}">${inner}</a>` : `<div class="row">${inner}</div>`;
  };
  const sectionHtml = sections.filter((sec) => sec.items.length).map((sec) => `
  <section>
    <h2>${e(sec.h2)} <span class="cnt">${sec.items.length}</span></h2>
    ${sec.items.map(rowFor).join("\n")}
  </section>`).join("\n");
  const faqHtml = faqs && faqs.length ? `
  <section>
    <h2>Quick answers</h2>
    <div class="faq">
      ${faqs.map((f) => `<details><summary>${e(f.q)}</summary><div class="fa">${e(f.a)}</div></details>`).join("\n      ")}
    </div>
  </section>` : "";
  const faqLd = faqs && faqs.length >= 2 ? {
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  } : null;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
<meta name="robots" content="max-image-preview:large">
<link rel="canonical" href="${e(canonical)}">
<meta property="og:title" content="${e(h1)}">
<meta property="og:description" content="${e(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${e(canonical)}">
<meta property="og:image" content="https://filmychill.com/og-image.png">
<meta name="twitter:card" content="summary">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' https://image.tmdb.org data:; object-src 'none'; base-uri 'self'">
${(extraLd || []).map((o) => `<script type="application/ld+json">${ldJson(o)}</script>`).join("\n")}${faqLd ? `
<script type="application/ld+json">${ldJson(faqLd)}</script>` : ""}
<style>
  :root { --indigo:#4038C7; --marigold:#FFAD1F; --cream:#FFF7EC; --ink:#1A1633; --mute:#6B6890; --line:#E4E1F5; }
  * { box-sizing:border-box; } body { font-family:-apple-system,'Segoe UI',Roboto,sans-serif; background:#F7F5FF; color:var(--ink); margin:0; }
  .top { background:var(--indigo); padding:14px 16px; } .top a { color:var(--cream); text-decoration:none; font-weight:800; letter-spacing:1px; font-size:18px; }
  .top a span { color:var(--marigold); }
  .wrap { max-width:680px; margin:0 auto; padding:20px 16px 40px; }
  h1 { font-size:24px; margin:0 0 4px; line-height:1.3; }
  .upd { color:var(--mute); font-size:13px; margin-bottom:6px; }
  .lead { font-size:14.5px; line-height:1.6; color:var(--mute); margin:0 0 8px; }
  .frozen { background:rgba(64,56,199,.07); border:1px solid var(--line); border-radius:10px; padding:10px 14px; font-size:13px; color:var(--mute); margin:10px 0 0; }
  h2 { font-size:17px; margin:26px 0 10px; } .cnt { color:var(--marigold); }
  .row { display:grid; grid-template-columns:92px 1fr; gap:12px; background:#fff; border:1px solid var(--line); border-radius:12px; padding:10px; margin-bottom:10px; text-decoration:none; color:inherit; }
  .row img { border-radius:8px; display:block; width:92px; height:138px; object-fit:cover; background:var(--line); }
  .nop { width:92px; height:138px; border-radius:8px; background:var(--line); }
  .rt { display:flex; gap:8px; align-items:center; flex-wrap:wrap; } .rt h3 { font-size:16px; margin:2px 0; }
  .badge { font-size:10px; letter-spacing:1px; text-transform:uppercase; color:var(--ink); background:var(--marigold); border-radius:5px; padding:3px 7px; font-weight:800; }
  .badge.trend { background:#FF4E3A; color:#fff; }
  .rm { color:var(--mute); font-size:13px; margin-top:4px; } .rm b { color:var(--indigo); }
  .rm.tk { color:var(--indigo); font-weight:600; }
  .rm.hk { font-style:italic; }
  .faq details { border-top:1px solid var(--line); padding:10px 0; }
  .faq summary { font-size:14.5px; font-weight:700; cursor:pointer; list-style:none; }
  .faq summary::-webkit-details-marker { display:none; }
  .faq summary::after { content:"+"; float:right; color:var(--indigo); font-weight:700; }
  .faq details[open] summary::after { content:"–"; }
  .faq .fa { font-size:14px; line-height:1.6; color:var(--mute); margin-top:8px; }
  .btn { display:inline-block; background:var(--indigo); color:#fff; font-weight:700; font-size:14px; padding:11px 20px; border-radius:10px; text-decoration:none; margin-top:20px; }
  footer { color:var(--mute); font-size:12px; text-align:center; padding:24px 16px; line-height:1.7; }
</style>
</head>
<body>
<div class="top"><a href="${e(homeUrl)}">FILMY<span>CHILL</span></a></div>
<div class="wrap">
  <h1>${e(h1)}</h1>
  <div class="upd">${e(updLine)}</div>
  <p class="lead">${e(lead)}</p>${frozenNote ? `
  <div class="frozen">${e(frozenNote)}</div>` : ""}
${sectionHtml}
${faqHtml}
  <a class="btn" href="${e(homeUrl)}">← This week's full picks (theatres + OTT)</a>${prevWeekHref ? `
  <a class="btn" style="background:transparent;color:var(--indigo);border:1.5px solid var(--indigo)" href="${e(prevWeekHref)}">← Previous week</a>` : ""}
</div>
<footer>
  ${footerAttribution()}© 2026 FilmyChill · Vikram Sharma
</footer>
</body>
</html>`;
}

// Pure: India data + language name -> full language landing page HTML.
function buildLanguagePage(data, langName, slug) {
  const url = `https://filmychill.com/${slug}/`;
  const gen = data.generatedAt || new Date().toISOString();
  const monthYear = new Date(gen).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const updatedHuman = new Date(gen).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const of = (k) => (data[k] || []).filter((x) => x && x.language === langName);
  const theatres = of("theatres"), ott = of("ott"), soon = of("comingSoon");
  const faqs = [];
  if (ott.length) faqs.push({
    q: `What's new in ${langName} on OTT this week?`,
    a: `New ${langName} titles streaming this week: ${ott.map((t) => `${t.title}${t.platform ? ` (${t.platform})` : ""}`).join(", ")}.`,
  });
  const best = [...theatres, ...ott].filter((x) => x.rating != null).sort((a, b) => b.rating - a.rating).slice(0, 3);
  if (best.length >= 2) faqs.push({
    q: `What are the best new ${langName} movies and shows this week?`,
    a: `Top-rated ${langName} picks: ${best.map((x) => `${x.title} (${Number(x.rating).toFixed(1)}/10)`).join(", ")}.`,
  });
  if (soon.length) faqs.push({
    q: `Which ${langName} movies are releasing soon?`,
    a: `Coming up: ${soon.map((x) => `${x.title}${x.released ? ` (${x.released})` : ""}`).join(", ")}.`,
  });
  const all = [...theatres, ...ott].filter((x) => x.slug);
  const extraLd = [{
    "@context": "https://schema.org", "@type": "CollectionPage",
    name: `New ${langName} Movies & OTT Releases This Week`, url, dateModified: gen,
    isPartOf: { "@type": "WebSite", "@id": "https://filmychill.com/#website" },
    mainEntity: { "@type": "ItemList", numberOfItems: all.length,
      itemListElement: all.map((x, i) => ({ "@type": "ListItem", position: i + 1, name: x.title, url: filmPageUrl("in", x.slug) })) },
  }, {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "FilmyChill", item: "https://filmychill.com/" },
      { "@type": "ListItem", position: 2, name: `${langName} this week`, item: url },
    ],
  }];
  return listingPageHtml({
    title: `New ${langName} Movies & OTT Releases This Week (${monthYear}) | FilmyChill`,
    desc: `Every new ${langName} movie in theatres and on OTT this week — ratings, critics' verdicts and where to watch. Updated daily.`,
    canonical: url,
    h1: `New ${langName} Movies & OTT This Week`,
    updLine: `Updated ${updatedHuman} · refreshed daily`,
    lead: `Every ${langName} title that hit theatres or started streaming this week, ranked and rated — plus what's coming next.`,
    sections: [
      { h2: "In theatres", items: theatres },
      { h2: "Streaming now", items: ott },
      { h2: "Coming soon", items: soon },
    ],
    faqs, extraLd, homeUrl: "https://filmychill.com/",
  });
}

function writeLanguagePages(data) {
  for (const [langName, slug] of LANGUAGE_PAGES) {
    if (!fs.existsSync(slug)) fs.mkdirSync(slug, { recursive: true });
    fs.writeFileSync(`${slug}/index.html`, buildLanguagePage(data, langName, slug));
  }
  console.log(`Language pages: ${LANGUAGE_PAGES.map(([, sl]) => "/" + sl + "/").join(" ")}`);
}

// ============================================================================
// WEEKLY SNAPSHOTS — /week/<year>-W<ww>/ permalinks (India). Overwritten on
// every run DURING its week, frozen forever when the ISO week rolls over. Every
// WhatsApp share and RSS item gets a durable URL; Google gets dated, genuinely
// fresh pages weekly. Zero marginal content cost — it's this run's data.
// ============================================================================
function isoWeekOf(d = new Date()) { // ISO-8601 week number + week-year (UTC)
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return { year: date.getUTCFullYear(), week: Math.ceil((((date - yearStart) / 864e5) + 1) / 7) };
}
function weekSlug(w) { return `${w.year}-W${String(w.week).padStart(2, "0")}`; }
function isoWeekMonday(slug) { // "2026-W28" -> Date of that ISO week's Monday (UTC)
  const [y, w] = slug.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (w - 1) * 7);
  return monday;
}
// Previous ISO week's slug — same week math, so year boundaries just work.
function prevWeekSlug(slug) {
  const monday = isoWeekMonday(slug);
  monday.setUTCDate(monday.getUTCDate() - 7);
  return weekSlug(isoWeekOf(monday));
}

// Deterministic lastmod for FROZEN week pages: the week's own Sunday. Never
// "today" for a page we didn't touch — the same honesty rule as the film archive.
function isoWeekSunday(slug) {
  const sun = isoWeekMonday(slug);
  sun.setUTCDate(sun.getUTCDate() + 6);
  return sun.toISOString().slice(0, 10);
}

// Pure: India data + week slug -> frozen-snapshot page HTML.
function buildWeekPage(data, slug, prevExists = false) {
  const url = `https://filmychill.com/week/${slug}/`;
  const monday = isoWeekMonday(slug);
  const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = (d) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  const range = `${fmt(monday)} – ${fmt(sunday)} ${sunday.getUTCFullYear()}`;
  const weekNo = Number(slug.split("-W")[1]);
  const theatres = (data.theatres || []).filter((x) => x && x.title);
  const ott = (data.ott || []).filter((x) => x && x.title);
  const all = [...theatres, ...ott].filter((x) => x.slug);
  const extraLd = [{
    "@context": "https://schema.org", "@type": "CollectionPage",
    name: `FilmyChill — Week ${weekNo}, ${slug.slice(0, 4)}`, url,
    dateModified: data.generatedAt || undefined,
    isPartOf: { "@type": "WebSite", "@id": "https://filmychill.com/#website" },
    mainEntity: { "@type": "ItemList", numberOfItems: all.length,
      itemListElement: all.map((x, i) => ({ "@type": "ListItem", position: i + 1, name: x.title, url: filmPageUrl("in", x.slug) })) },
  }];
  return listingPageHtml({
    title: `Movies & OTT: Week ${weekNo}, ${slug.slice(0, 4)} (${range}) in India | FilmyChill`,
    desc: `What was worth watching in India in week ${weekNo} (${range}) — theatre releases and new OTT titles with ratings and verdicts. A permanent weekly snapshot.`,
    canonical: url,
    h1: `Week ${weekNo}: ${range}`,
    updLine: `India · theatres + OTT`,
    lead: `A permanent snapshot of what was worth watching this week — every share link stays alive forever.`,
    frozenNote: `This page captures week ${weekNo} of ${slug.slice(0, 4)} and stays frozen once the week ends. For the current list, head to the homepage.`,
    sections: [
      { h2: "In theatres", items: theatres },
      { h2: "Streaming", items: ott },
    ],
    faqs: [], extraLd, homeUrl: "https://filmychill.com/",
    // Chain to the previous snapshot so frozen weeks never orphan — a crawlable
    // (and human-browsable) path backwards through the whole archive.
    prevWeekHref: prevExists ? `https://filmychill.com/week/${prevWeekSlug(slug)}/` : null,
  });
}

function writeWeekPage(data) {
  const slug = weekSlug(isoWeekOf());
  const dir = `week/${slug}`;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const prevExists = fs.existsSync(`week/${prevWeekSlug(slug)}/index.html`);
  fs.writeFileSync(`${dir}/index.html`, buildWeekPage(data, slug, prevExists));
  console.log(`Week snapshot: /week/${slug}/${prevExists ? " → chained to previous week" : ""}`);
}

// IndexNow payload, regenerated each run so DYNAMIC urls (the current week snapshot)
// and every configured country/language page get pinged without ever editing the
// workflow again. The key is public by design — IndexNow proves ownership via the
// matching KEY.txt served from the repo root, not by keeping the key secret.
function writeIndexNowPayload(builtCountries) {
  const urls = ["https://filmychill.com/", "https://filmychill.com/new-on-ott/"];
  for (const cfg of builtCountries) {
    if (cfg.code === "in") continue;
    urls.push(`https://filmychill.com/${cfg.code}/`, `https://filmychill.com/${cfg.code}/new-on-ott/`);
  }
  for (const [, slug] of LANGUAGE_PAGES) urls.push(`https://filmychill.com/${slug}/`);
  urls.push(`https://filmychill.com/week/${weekSlug(isoWeekOf())}/`);
  fs.writeFileSync("indexnow-payload.json", JSON.stringify({
    host: "filmychill.com",
    key: "a95eba27e6b3f0e85e89e609241d6699",
    urlList: urls,
  }, null, 1));
  console.log(`IndexNow payload: ${urls.length} URLs`);
}

// ============================================================================
// llms.txt — a curated markdown map of the site for AI answer engines
// (llmstxt.org convention). Regenerated every run so ChatGPT/Perplexity/Claude
// crawlers that fetch it see THIS WEEK'S actual picks with dates, not a stale
// brochure. Pure builder -> unit-testable; writer is thin.
// ============================================================================
function buildLlmsTxt(dataByCode) {
  const ind = dataByCode.in || {};
  const gen = ind.generatedAt || new Date().toISOString();
  const day = gen.slice(0, 10);
  const line = (it) => `- ${it.title}${it.language && it.language !== "English" ? ` (${it.language})` : ""}${it.platform && it.platform !== "Theatres" ? ` — on ${it.platform}` : ""}${it.rating != null ? ` — rated ${Number(it.rating).toFixed(1)}/10` : ""}${it.slug ? ` — https://filmychill.com${filmPagePath("in", it.slug)}` : ""}`;
  const theatres = (ind.theatres || []).slice(0, 7).map(line).join("\n");
  const ott = (ind.ott || []).filter((x) => !x.stillGood).slice(0, 6).map(line).join("\n");
  const langs = LANGUAGE_PAGES.map(([name, slug]) => `- [New ${name} movies & OTT this week](https://filmychill.com/${slug}/)`).join("\n");
  const countries = COUNTRIES.filter((c) => c.code !== "in").map((c) => `- [${c.name}](https://filmychill.com/${c.code}/) · [New on OTT](https://filmychill.com/${c.code}/new-on-ott/)`).join("\n");
  return `# FilmyChill

> FilmyChill is a daily-updated guide to what is worth watching this week — new theatrical releases and OTT/streaming arrivals — for India and seven other countries, with audience ratings, honest verdicts, and critics' takes synthesised from published review coverage. Lists are rebuilt twice daily from TMDB (streaming availability via JustWatch), Wikipedia critical-reception coverage, and YouTube trailer statistics. No pay-for-placement: no studio or platform can buy a position on any list. Last build: ${gen}.

## This week in India (${day})

In theatres:
${theatres}

New on OTT / streaming:
${ott}

## Key pages

- [This week's full picks — India](https://filmychill.com/): theatres + OTT, ranked, updated twice daily
- [New OTT releases this week](https://filmychill.com/new-on-ott/): grouped by platform (Netflix, Prime Video, JioHotstar, ...)
- [Weekly snapshot archive](https://filmychill.com/week/${weekSlug(isoWeekOf())}/): permanent record of each week's list
- [About & methodology](https://filmychill.com/about/): how picks are chosen, data sources, editorial rules

## Language pages (India)

${langs}

## Other countries

${countries}

## Film pages

Every listed film has a page at https://filmychill.com/movie/<slug>.html (or /<country>/movie/<slug>.html) with its rating, verdict, where-to-watch, OTT release date status, cast, and critics' take.
`;
}

// llms-full.txt — the emerging companion convention to llms.txt: the index file
// stays short, the -full file carries the complete current knowledge base so an
// AI system can answer "what should I watch this week in <country>?" from one
// fetch, with per-film facts, verdicts, and provenance. Regenerated every build.
function buildLlmsFullTxt(dataByCode) {
  const lines = [
    "# FilmyChill — full current picks (machine-readable companion to /llms.txt)",
    "",
    `Generated: ${new Date().toISOString()}. Rebuilt twice daily. No pay-for-placement.`,
    "Sources: TMDB (film data, ratings; streaming availability via JustWatch), Wikipedia (critical reception), YouTube (trailer statistics).",
    "Fields: rating is the TMDB audience average out of 10; verdict is FilmyChill's editorial call; the critics' line is distilled from published review coverage, never quoted.",
    "",
  ];
  for (const cfg of COUNTRIES) {
    const data = dataByCode[cfg.code];
    if (!data) continue;
    const m = COUNTRY_PAGE_META[cfg.code] || { name: cfg.name };
    lines.push(`## ${m.name} — week of ${data.generatedAt ? String(data.generatedAt).slice(0, 10) : ""}`);
    for (const [label, list] of [["In theatres", data.theatres], ["New on OTT / streaming", data.ott]]) {
      if (!list || !list.length) continue;
      lines.push("", `### ${label}`, "");
      list.forEach((it, i) => {
        const facts = [
          it.kind === "tv" ? "Series" : "Film", it.language, it.genre,
          it.runtime ? `${it.runtime} min` : null, it.cert || null,
          it.released ? `released ${it.released}` : null,
          it.platform && it.platform !== "Theatres" ? `on ${it.platform}` : null,
          it.rating != null ? `rated ${Number(it.rating).toFixed(1)}/10 (${it.votes || 0} votes)` : null,
          it.verdict || null,
        ].filter(Boolean).join(" · ");
        lines.push(`${i + 1}. ${it.title} — ${facts}`);
        if (it.take) lines.push(`   Critics: ${it.take}${it.takeArticle ? ` [source: en.wikipedia.org/wiki/${String(it.takeArticle).replace(/ /g, "_")}]` : ""}`);
        if (it.hook) lines.push(`   Context: ${it.hook}`);
        if (it.director) lines.push(`   Director: ${it.director}`);
        lines.push(`   URL: ${filmPageUrl(cfg.code, it.slug)}`);
      });
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

// Machine-readable appendix for llms.txt itself: tell agents what else is fetchable.
function llmsMachineSection() {
  const dataFiles = COUNTRIES.map((c) => `- https://filmychill.com/data${c.code === "in" ? "" : "-" + c.code}.json — current picks for ${(COUNTRY_PAGE_META[c.code] || {}).name || c.name} (JSON)`).join("\n");
  return `\n## Machine-readable data (for AI systems and agents)\n\n` +
    `- [Full current knowledge base](https://filmychill.com/llms-full.txt): every current pick across all 8 countries with facts, verdicts, critics' lines, and source attribution — answerable from one fetch\n` +
    `- [RSS feed](https://filmychill.com/feed.xml): newest arrivals as they enter the lists\n` +
    `${dataFiles}\n` +
    `\nJSON fields per item: title, kind (movie|tv), language, genre, runtime, cert, released (ISO date), platform, providers, rating (TMDB /10), votes, verdict, take (critics' line), hook, director, cast, slug (page: /movie/<slug>.html), trailer.\n` +
    `All files are static, CORS-open, and rebuilt twice daily. Attribution when citing: "FilmyChill (filmychill.com)".\n`;
}

function writeLlmsTxt(dataByCode) {
  fs.writeFileSync("llms.txt", buildLlmsTxt(dataByCode) + llmsMachineSection());
  fs.writeFileSync("llms-full.txt", buildLlmsFullTxt(dataByCode));
  console.log("llms.txt + llms-full.txt written");
}

// About page lastmod for the sitemap — bump manually when about/index.html changes.
const ABOUT_LASTMOD = "2026-07-06";

const COUNTRY_PAGE_META = {
  in: { name: "India", path: "/" },
  us: { name: "the US", path: "/us/" },
  uk: { name: "the UK", path: "/uk/" },
  au: { name: "Australia", path: "/au/" },
  de: { name: "Germany", path: "/de/" },
  ae: { name: "the UAE", path: "/ae/" },
  ca: { name: "Canada", path: "/ca/" },
  sg: { name: "Singapore", path: "/sg/" },
};

// English locale conventions per country — grouping ("12,34,567" lakh-style is correct ONLY
// for India; the US expects "1,234,567") and long-date order ("July 1, 2026" in the US vs
// "1 July 2026" elsewhere). Germany gets en-GB: the site's language is English, and en-GB's
// day-first order matches German convention for an English-language page.
const COUNTRY_LOCALE = { in: "en-IN", us: "en-US", uk: "en-GB", au: "en-AU", de: "en-GB", ae: "en-AE", ca: "en-CA", sg: "en-SG" };
const localeFor = (code) => COUNTRY_LOCALE[code] || "en-IN";
// Prose-ready country name ("the US", not the config's "United States") for any cfg.
const countryNameFor = (cfg) => (COUNTRY_PAGE_META[(cfg && cfg.code) || "in"] || {}).name || (cfg && cfg.name) || "India";
// "India, US, UK, Australia, Germany, UAE, Canada &amp; Singapore" — generated from the
// config so a new country can never be missing from the fallback copy again.
function countryListForProse() {
  const short = { "United States": "US", "United Kingdom": "UK" };
  const names = COUNTRIES.map((c) => short[c.name] || c.name);
  return names.slice(0, -1).join(", ") + " &amp; " + names[names.length - 1];
}

function buildHeadTags(cfg, useImdb = USE_IMDB, data = null) {
  const m = COUNTRY_PAGE_META[cfg.code] || { name: cfg.name, path: `/${cfg.code}/` };
  const url = `https://filmychill.com${m.path}`;

  // SERP click-through: when this run's data is passed, the title carries the live month
  // (freshness a searcher can SEE in the results page) and the description leads with real
  // film names — a searcher choosing between ten generic "latest OTT releases" links clicks
  // the one showing titles they recognise. Without data (tests/legacy calls), the static
  // wording below is used unchanged.
  let dynTitle = null, dynDesc = null;
  if (data) {
    const monthYear = new Date(data.generatedAt || Date.now())
      .toLocaleDateString(localeFor(cfg.code), { month: "long", year: "numeric" });
    dynTitle = `New Movies & OTT Releases This Week in ${m.name} (${monthYear}) | FilmyChill`;
    const all = [...(data.theatres || []), ...(data.ott || [])];
    // Two marquee names: the top theatre title and the top OTT title (fall back down the list).
    const names = [(data.theatres || [])[0], (data.ott || [])[0]].filter(Boolean).map((x) => x.title);
    if (names.length && all.length > names.length) {
      dynDesc = `This week: ${names.join(", ")} + ${all.length - names.length} more — ratings, verdicts & where to watch in ${m.name}. Updated twice daily.`;
      if (dynDesc.length > 158) dynDesc = `This week: ${names[0]} + ${all.length - 1} more — ratings, verdicts & where to watch in ${m.name}. Updated twice daily.`;
    }
  }
  // Ratings wording follows the active source (same principle as footerAttribution): IMDb's
  // name may only appear when IMDb data is actually used — its terms forbid using the name
  // without a current license, and in TMDB mode the claim would simply be false. TMDB mode
  // says just "ratings": accurate, and the TMDB brand adds nothing to a search snippet.
  const ratingsWord = useImdb ? "IMDb ratings" : "ratings";
  // max-image-preview:large is REQUIRED for Google Discover eligibility — Discover is the
  // channel where daily entertainment content actually goes viral in India. One tag,
  // emitted on every page type (homepages here; film + ott-week pages set it themselves).
  const discover = `<meta name="robots" content="max-image-preview:large">`
    + `\n<link rel="alternate" type="application/rss+xml" title="FilmyChill — New Movies & OTT" href="https://filmychill.com${m.path}feed.xml">`;

  // On-page hreflang for the five homepages. Film + new-on-ott pages already emit these;
  // the homepages only declared alternates in the sitemap, which is the weaker signal —
  // without on-page tags Google can serve the Indian page to US searchers or treat five
  // near-identical homepages as competing duplicates. x-default -> India (the canonical root).
  const homeAlts = COUNTRIES.map((cc) => {
    const alt = COUNTRY_PAGE_META[cc.code] || { path: `/${cc.code}/` };
    return `<link rel="alternate" hreflang="${cc.code === "in" ? "en-IN" : "en-" + cc.region}" href="https://filmychill.com${alt.path}"/>`;
  }).join("\n") + `\n<link rel="alternate" hreflang="x-default" href="https://filmychill.com/"/>`;

  // Share/social tags: og mirrors the DYNAMIC title/description (a WhatsApp/X share should
  // show this week's real films, not a generic pitch), og:url anchors shares to the right
  // country page, og:locale marks the market, twitter:card upgrades bare links to cards.
  const ogLocale = cfg.code === "in" ? "en_IN" : "en_" + ((cfg && cfg.region) || (COUNTRIES.find((cc) => cc.code === cfg.code) || {}).region || cfg.code.toUpperCase());
  const shareTags = `<meta property="og:url" content="${url}">\n`
    + `<meta property="og:locale" content="${ogLocale}">\n`
    + `<meta name="twitter:card" content="summary_large_image">`;
  if (cfg.code === "in") {
    // Root keeps the multi-country, India-first wording as the no-data fallback.
    return `<title>${escHtml(dynTitle || "FilmyChill — Latest Movie & OTT Releases, with Reviews, Updated Daily")}</title>\n`
      + `<meta name="description" content="${escHtml(dynDesc) || `Latest theatre and OTT releases across ${countryListForProse()} — trailers, ${ratingsWord}, verdicts, auto-updated daily.`}">\n`
      + discover + "\n"
      + `<link rel="canonical" href="${url}">\n`
      + homeAlts + "\n"
      + `<meta property="og:title" content="${escHtml(dynTitle) || "FilmyChill — What's worth watching this week"}">\n`
      + `<meta property="og:description" content="${escHtml(dynDesc) || `Latest theatre and OTT releases across ${countryListForProse()} — trailers, ${ratingsWord}, verdicts. Auto-updated daily.`}">\n`
      + shareTags;
  }
  return `<title>${escHtml(dynTitle) || `FilmyChill — Latest Movie &amp; OTT Releases in ${m.name}, with Reviews, Updated Daily`}</title>\n`
    + `<meta name="description" content="${escHtml(dynDesc) || `Latest theatre and OTT releases in ${m.name} on Netflix, Prime Video, Disney+ and more — trailers, ${ratingsWord}, verdicts, auto-updated daily.`}">\n`
    + discover + "\n"
    + `<link rel="canonical" href="${url}">\n`
    + homeAlts + "\n"
    + `<meta property="og:title" content="${escHtml(dynTitle) || `FilmyChill — What's worth watching this week in ${m.name}`}">\n`
    + `<meta property="og:description" content="${escHtml(dynDesc) || `Top theatre releases + OTT picks in ${m.name} with trailers, ${ratingsWord} and verdicts. Auto-updated daily.`}">\n`
    + shareTags;
}

// Homepage structured data: WebSite + dateModified + an ItemList of this
// week's films, so crawlers see a fresh, ranked collection without running JS.
function buildHomeJsonLd(data, cfg) {
  const m = COUNTRY_PAGE_META[(cfg && cfg.code) || "in"] || { name: "", path: "/" };
  const pageUrl = `https://filmychill.com${m.path}`;
  const date = (data.generatedAt || new Date().toISOString()).slice(0, 10);
  const code = (cfg && cfg.code) || "in";
  const isIndia = code === "in";
  // Every country now has its own per-film pages, so each list item links to its real page.
  const listItems = [...(data.theatres || []), ...(data.ott || [])]
    .filter((x) => x.slug)
    .map((x, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: filmPageUrl(code, x.slug),
      name: x.title,
    }));
  const listName = isIndia ? "What's worth watching this week" : `What's worth watching this week in ${m.name}`;
  const graph = [
    {
      // Brand entity: feeds logo/knowledge-panel treatment for "filmychill" queries —
      // which (per Search Console) is most of the site's current impressions.
      "@type": "Organization",
      "@id": "https://filmychill.com/#org",
      name: "FilmyChill",
      url: "https://filmychill.com/",
      logo: { "@type": "ImageObject", url: "https://filmychill.com/icon-192.png", width: 192, height: 192 },
      sameAs: ["https://whatsapp.com/channel/0029Vb81Fe8C6ZvdMR2oxH3j"],
    },
    {
      "@type": "WebSite",
      "@id": "https://filmychill.com/#website",
      name: "FilmyChill",
      url: "https://filmychill.com/",
      publisher: { "@id": "https://filmychill.com/#org" },
      author: { "@type": "Person", name: "Vikram Sharma" },
      datePublished: "2026-01-01",
      dateModified: data.generatedAt || `${date}T00:00:00.000Z`,
    },
    {
      "@type": "ItemList",
      name: listName,
      url: pageUrl,
      dateModified: data.generatedAt || `${date}T00:00:00.000Z`,
      numberOfItems: listItems.length,
      itemListElement: listItems,
    },
  ];
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph });
}

// Footer attribution text, matched to the active ratings source so the credit always reflects
// the data actually used. Takes useImdb (defaults to the global USE_IMDB) so both modes can be
// unit-tested directly, without spawning a subprocess. IMDb mode: TMDB credited for film data +
// IMDb credited for ratings using IMDb's REQUIRED verbatim wording. TMDB mode: TMDB credited for
// both (no IMDb name anywhere, since IMDb data isn't used and its terms forbid using its name
// without a current license).
function footerAttribution(useImdb = USE_IMDB) {
  const tmdb = `<a href="https://www.themoviedb.org" rel="noopener" target="_blank">TMDB</a>`;
  if (useImdb) {
    return `Film data from ${tmdb}. This product uses the TMDB API but is not endorsed or certified by TMDB.<br>\n  ` +
           `Ratings information courtesy of <a href="https://www.imdb.com" rel="noopener" target="_blank">IMDb</a> (https://www.imdb.com). Used with permission.<br>\n  ` +
           `Where-to-watch data provided by <a href="https://www.justwatch.com" rel="noopener" target="_blank">JustWatch</a>.<br>\n  `;
  }
  return `Film data and ratings from ${tmdb}. This product uses the TMDB API but is not endorsed or certified by TMDB.<br>\n  ` +
         `Where-to-watch data provided by <a href="https://www.justwatch.com" rel="noopener" target="_blank">JustWatch</a>.<br>\n  `;
}

// Render one country's page from the pristine template string and write it to its path
// (root index.html for India, <code>/index.html for others). The template is read ONCE by
// the caller and passed in, so per-country injections never stack on each other.
// SSR OTT section with the honest divider: cards in order, one "Still worth it"
// separator before the first stillGood card (only when a fresh group precedes it,
// so an all-older list never renders a heading with nothing above it).
function ssrOttSection(items, code) {
  let out = "", divided = false;
  items.forEach((x, i) => {
    if (!divided && x.stillGood && i > 0) {
      out += `<div class="ott-divider">Still worth it — standouts from earlier weeks</div>`;
      divided = true;
    }
    out += ssrCard(x, i, code);
  });
  return out;
}

// Footer cross-links, injected per country: India links its language pages and the
// current week's snapshot; every country links About. New indexable surfaces get
// crawl paths from every page on the site.
function buildMoreLinks(code) {
  const about = `<a href="/about/">About FilmyChill</a>`;
  if (code !== "in") return about;
  const langs = LANGUAGE_PAGES.map(([name, slug]) => `<a href="/${slug}/">${name}</a>`).join(" · ");
  return `${langs} · <a href="/week/${weekSlug(isoWeekOf())}/">This week's snapshot</a> · ${about}`;
}

function renderCountryPage(templateHtml, cfg, data) {
  const isIndia = cfg.code === "in";
  let html = templateHtml;
  html = replaceBetween(html, "HEAD", buildHeadTags(cfg, USE_IMDB, data));
  html = replaceBetween(html, "PAGECODE", `<meta name="fc-page" content="${cfg.code}">`);
  html = replaceBetween(html, "MORELINKS", buildMoreLinks(cfg.code));
  html = replaceBetween(html, "THEATRES", (data.theatres || []).map((x, i) => ssrCard(x, i, cfg.code)).join(""));
  html = replaceBetween(html, "OTT", ssrOttSection(data.ott || [], cfg.code));
  html = replaceBetween(html, "SOON", (data.comingSoon || []).map((x) => ssrSoonCard(x, cfg.code)).join(""));
  // The SSR markers wrap the ENTIRE <script> element (never sit inside it): HTML
  // comments are NOT stripped inside <script>, so markers inside the tag made the
  // JSON-LD start with "<!--" — a syntax error to Google's structured-data parser.
  // Same lesson as the fc-page meta tag, now applied to the block that predated it.
  html = replaceBetween(html, "JSONLD",
    `<script type="application/ld+json">${buildHomeJsonLd(data, cfg)}</script>`);
  html = replaceBetween(html, "ATTRIBUTION", footerAttribution());
  if (isIndia) {
    fs.writeFileSync("index.html", html);
  } else {
    if (!fs.existsSync(cfg.code)) fs.mkdirSync(cfg.code, { recursive: true });
    fs.writeFileSync(`${cfg.code}/index.html`, html);
  }
  console.log(`  page rendered: ${isIndia ? "/ (index.html)" : "/" + cfg.code + "/"}`);
}

// PAGES_ONLY local regeneration: India only (the canonical page from data.json).
function prerenderIndex(data) {
  let html;
  try { html = fs.readFileSync("index.html", "utf8"); }
  catch { console.warn("index.html not found — prerender skipped"); return; }
  renderCountryPage(html, { code: "in", name: "India" }, data);
  console.log("index.html pre-rendered with this week's films.");
}

// Local regeneration from existing data.json (no API calls): PAGES_ONLY=1 node scripts/update.js
// Placed at end of file so all const declarations (COUNTRY_PAGE_META etc.) are initialized.
if (process.env.PAGES_ONLY && require.main === module) {
  const d = JSON.parse(fs.readFileSync("data.json", "utf8"));
  assignSlugs(d);
  const inCfg = COUNTRIES.find((c) => c.code === "in") || { code: "in", name: "India", region: "IN" };
  const all = [...(d.theatres || []), ...(d.ott || []), ...(d.comingSoon || [])];
  const slugSets = { in: new Set(all.map((x) => x.slug).filter(Boolean)) };
  generatePages(d, inCfg, slugSets); // India only in local regen
  prerenderIndex(d);
  writeOttWeekPage(d, inCfg, [inCfg]);
  writeRssFeed(d, inCfg);
  fs.writeFileSync("data.json", JSON.stringify(d, null, 1));
  process.exit(0);
}

// Export pure/helper functions for unit testing (only meaningful when required, not run).
module.exports = {
  verdict, trim, img, slugify, escHtml, ytIdOf, replaceBetween,
  assignSlugs, buildHeadTags, buildHomeJsonLd, ssrCard, ssrSoonCard,
  footerAttribution, RATINGS_SOURCE, USE_IMDB,
  deriveFreshDate, isOttFresh, OTT_FRESH_DAYS,
  filterTheatreFresh, THEATRE_WINDOW_DAYS, THEATRE_WINDOW_FALLBACK_DAYS, THEATRE_MIN_POOL,
  ottRecencyBonus, OTT_RECENCY_MAX, freshBadge, freshLabel, fmtDateShort,
  buildOttWeekPage, ottWeekUrl, ottWeekPath,
  computeBuzz, fmtViews, trailerViewsLabel, localeFor, countryNameFor,
  ottArrival, recordOttSeen, pruneOttSeen, laterDate, earlierDate,
  buildRssFeed, archivePatchHtml, reconcilePagesManifest,
  ARRIVAL_BADGE_DAYS, ARRIVAL_MIN_RELEASE_AGE, SEEN_RETENTION_DAYS,
  buildVerdictProse, buildGoodToKnow, buildFaqs, buildFilmPage,
  filmPagePath, filmPageUrl,
  analyzeReception, composeTake, TAKES_RETENTION_DAYS,
  ottRenderable, hasCardSubstance, isStillWorthIt, orderOttForDisplay, STILL_WORTH_DAYS,
  buildLanguagePage, LANGUAGE_PAGES, listingPageHtml,
  isoWeekOf, weekSlug, isoWeekMonday, isoWeekSunday, buildWeekPage,
  ssrOttSection, buildMoreLinks, ABOUT_LASTMOD,
  isExcluded, EXCLUDE_TITLES,
  extractHook, audienceCounterpoint,
  certFor, regionalTheatricalDate, countryListForProse,
  extractCastPics,
  prevWeekSlug, writeIndexNowPayload, buildLlmsTxt,
  theatreEligible, THEATRE_EXCLUDE_IDS,
  reseedTake, isPoolTake, TAKE_VERSION,
  xDefaultCode, repairXDefaults, capTrending, ssrCard, ssrSoonCard,
  buildLlmsFullTxt, llmsMachineSection, INDEXNOW_KEY, submitIndexNow,
};
