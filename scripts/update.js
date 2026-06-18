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
];

// Manual exclusion list — films that should NEVER appear regardless of what TMDB returns
// (banned in India, pulled from release, festival-only, or otherwise mislisted as current
// theatrical). TMDB exposes no "banned"/"still in theatres" signal, so this is a human
// override. To block a film: find its TMDB ID (in data.json as tmdbId, or the TMDB URL,
// e.g. themoviedb.org/movie/1692948) and add it below with a short note.
const EXCLUDE_IDS = new Set([
  1692948, // Chardikala — banned in India / not in theatres
]);

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
  return text.length <= n ? text : text.slice(0, n).replace(/\s+\S*$/, "") + "…";
}

// OTT freshness window: how recent a title's freshDate must be to count as a current OTT
// release. Wider than theatres' 21d because "new this month/two months" is the relevant
// sense of fresh for streaming. Exported + used by the OTT intl gate and the test suite.
const OTT_FRESH_DAYS = 75;

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

async function enrich(kind, id, region = "IN") {
  const extra = kind === "movie" ? "release_dates" : "content_ratings";
  const d = await tmdb(`/${kind}/${id}`, { append_to_response: `videos,credits,watch/providers,external_ids,${extra}` });

  // Certificate (India)
  let cert = null;
  if (kind === "movie") {
    const inRel = d.release_dates?.results?.find((r) => r.iso_3166_1 === "IN");
    cert = inRel?.release_dates?.find((x) => x.certification)?.certification || null;
  } else {
    cert = d.content_ratings?.results?.find((r) => r.iso_3166_1 === "IN")?.rating || null;
  }

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
  let director = null;
  if (kind === "movie") director = (d.credits?.crew || []).find((c) => c.job === "Director")?.name || null;
  else director = d.created_by?.[0]?.name || null;

  const runtime = kind === "movie" ? d.runtime : (d.episode_run_time?.[0] || null);

  // Freshness signal for the OTT pool — see deriveFreshDate (handles movie vs TV-season logic).
  const freshDate = deriveFreshDate(kind, d);

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

  return {
    cert, trailer, providers, cast, director, runtime, imdbScore, imdbVotes,
    freshDate,
    backdrop: img(d.backdrop_path, "w780"),
    fullReview: trim(d.overview, 600),
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
  const pool = [...np1.results, ...(np2.results || [])].filter((m) => {
    if (seen.has(m.id)) { return false; } seen.add(m.id); return true;
  });

  // Multi-source supplement: now_playing is incomplete for Indian regional theatrical
  // releases (distributors/contributors don't always report them), so we also pull recent
  // THEATRICAL releases per Indian language via discover. release_type 3|2 = theatrical/
  // limited theatrical (not direct-to-OTT), and a 3-week window keeps it current — wide
  // enough for films still running, tight enough to avoid resurfacing the back catalogue.
  // These merge into the pool on equal footing; the normal ranking decides what's picked.
  const THEATRE_WINDOW_DAYS = 21; // 3-week freshness filter
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
        if (!seen.has(m.id)) { seen.add(m.id); pool.push(m); }
      }
    } catch (e) { console.warn(`theatre-discover ${lang}: ${e.message}`); }
    await sleep(150);
  }

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

  const theatres = [];
  for (const m of picks) {
    const item = { ...baseItem(m, "movie"), platform: "Theatres" };
    try { Object.assign(item, await enrich("movie", m.id, cfg.watchRegion)); withImdb(item); } catch (e) { console.warn(`enrich movie ${m.id}: ${e.message}`); }
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
  const ottIsFresh = (item) => item && isOttFresh(item.freshDate);

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
    if (!extra.providers || extra.providers.length === 0) return null; // not streaming in India
    Object.assign(item, extra, { platform: extra.providers[0] });
    withImdb(item);
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
  ].filter((c) => !isRegional(c) && !EXCLUDE_IDS.has(c.id));
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
    cands = cands.filter((c) => !usedIds.has(c.id) && !EXCLUDE_IDS.has(c.id));
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

  // --- Interleave so regional stays visible instead of sinking below the international ---
  const ott = [];
  const step = regional.length ? Math.max(1, Math.floor(intl.length / regional.length)) : 0;
  let ri = 0;
  for (let i = 0; i < intl.length; i++) {
    ott.push(intl[i]);
    if (ri < regional.length && step && (i + 1) % step === 0) ott.push(regional[ri++]);
  }
  while (ri < regional.length) ott.push(regional[ri++]);
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
    if (!upSeen.has(m.id)) { upSeen.add(m.id); upPoolRaw.push(m); }
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
        if (!upSeen.has(m.id)) { upSeen.add(m.id); upPoolRaw.push(m); }
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
    for (const it of list) { delete it._pop; delete it._tmdbWeighted; delete it._imdbNum; delete it._imdbRating; delete it._imdbVotes; }
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
  for (const cfg of COUNTRIES) {
    const data = await buildCountry(cfg);
    assignSlugs(data);
    fs.writeFileSync(`data-${cfg.code}.json`, JSON.stringify(data, null, 1));
    builtCountries.push(cfg);
    if (cfg.code === "in") {
      generatePages(data); // per-film pages + sitemap (India only)
      fs.writeFileSync("data.json", JSON.stringify(data, null, 1));
    }
    if (pageTemplate) renderCountryPage(pageTemplate, cfg, data);
  }
  // Rewrite the sitemap to include every country page (with hreflang) now that all are built.
  writeMultiCountrySitemap(builtCountries);
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

function buildFilmPage(item, asOf) {
  const e = escHtml;
  const year = (item.released || "").slice(0, 4);
  const upcoming = item.released && item.released > new Date().toISOString().slice(0, 10);
  const relLabel = upcoming ? "Releases" : "Released";
  const synopsis = item.fullReview || item.review || "";
  const desc = trim([item.verdict, synopsis].filter(Boolean).join(". "), 155);
  const url = `https://filmychill.com/movie/${item.slug}.html`;
  const ytid = ytIdOf(item.trailer);
  const cast = Array.isArray(item.cast) ? item.cast.slice(0, 6) : [];
  const providers = Array.isArray(item.providers) ? item.providers : [];

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
    actor: cast.map((c) => ({ "@type": "Person", name: c })),
  };
  const schemaVotes = item.imdbRating != null ? (item.imdbVotes || 0) : (item.votes || 0);
  if (item.rating != null && schemaVotes >= 10) {
    ld.aggregateRating = { "@type": "AggregateRating", ratingValue: item.rating, ratingCount: schemaVotes, bestRating: 10 };
  }

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "FilmyChill", item: "https://filmychill.com/" },
      { "@type": "ListItem", position: 2, name: item.title, item: url },
    ],
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(item.title)}${year ? " (" + year + ")" : ""} — Review, Rating & Where to Watch in India | FilmyChill</title>
<meta name="description" content="${e(desc)}">
<link rel="canonical" href="${e(url)}">
<meta property="og:title" content="${e(item.title)}${year ? " (" + year + ")" : ""} — FilmyChill verdict">
<meta property="og:description" content="${e(desc)}">
<meta property="og:type" content="video.movie">
<meta property="og:url" content="${e(url)}">
${item.poster ? `<meta property="og:image" content="${e(item.poster)}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' https://image.tmdb.org data:; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>
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
  @media (max-width:420px){ .head { grid-template-columns:110px 1fr; } .poster { width:110px; } h1 { font-size:20px; } }
</style>
</head>
<body>
<div class="top"><a href="https://filmychill.com/">FILMY<span>CHILL</span></a></div>
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
  ${synopsis ? `<h2>Story</h2><p>${e(synopsis)}</p>` : ""}
  ${item.director ? `<h2>Director</h2><p>${e(item.director)}</p>` : ""}
  ${cast.length ? `<h2>Cast</h2><div>${cast.map((c) => `<span class="pill">${e(c)}</span>`).join("")}</div>` : ""}
  ${providers.length ? `<h2>Where to watch in India</h2><div>${providers.map((p) => `<span class="pill">${e(p)}</span>`).join("")}</div><p style="color:var(--mute);font-size:12px;margin-top:6px">Availability as of ${e(asOf || "")} — platforms may change over time.</p>` : item.platform === "Theatres" ? `<h2>Where to watch in India</h2><div><span class="pill">In theatres</span></div>` : ""}
  ${ytid ? `<h2>Trailer</h2><div class="frame"><iframe loading="lazy" src="https://www.youtube-nocookie.com/embed/${e(ytid)}?rel=0" title="${e(item.title)} trailer" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe></div>` : item.trailer ? `<h2>Trailer</h2><p><a href="${e(item.trailer)}" rel="noopener">Find the trailer on YouTube →</a></p>` : ""}
  <a class="btn" href="https://filmychill.com/#${e(item.slug)}">🎬 See this week's top picks on FilmyChill →</a>
</div>
<footer>
  ${footerAttribution()}© 2026 FilmyChill · Vikram Sharma
</footer>
</body>
</html>`;
}

function generatePages(data) {
  const asOf = (data.generatedAt || new Date().toISOString()).slice(0, 10);
  if (!fs.existsSync("movie")) fs.mkdirSync("movie");
  const all = [...(data.theatres || []), ...(data.ott || []), ...(data.comingSoon || [])];
  let written = 0;
  for (const item of all) {
    if (!item.slug) continue;
    try {
      fs.writeFileSync(`movie/${item.slug}.html`, buildFilmPage(item, asOf));
      written++;
    } catch (err) { console.warn(`page ${item.slug}: ${err.message}`); }
  }
  const pages = fs.readdirSync("movie").filter((f) => f.endsWith(".html"));
  console.log(`Pages: ${written} written, ${pages.length} total in archive (India per-film pages).`);
}

// Complete sitemap: every country page (with hreflang alternates linking them as the same
// site for different regions) + India's per-film pages. Built after all countries render.
function writeMultiCountrySitemap(countries) {
  const today = new Date().toISOString().slice(0, 10);
  const pathFor = (code) => (code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`);
  // hreflang alternates: list every country version + x-default (India).
  const alternates = countries.map((c) =>
    `    <xhtml:link rel="alternate" hreflang="${c.code === "in" ? "en-IN" : "en-" + c.region}" href="${pathFor(c.code)}"/>`).join("\n")
    + `\n    <xhtml:link rel="alternate" hreflang="x-default" href="https://filmychill.com/"/>`;
  const countryUrls = countries.map((c) =>
    `  <url><loc>${pathFor(c.code)}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority>\n${alternates}\n  </url>`);
  // India per-film pages (archive). Fresh ones get higher priority.
  let filmUrls = [];
  try {
    const pages = fs.readdirSync("movie").filter((f) => f.endsWith(".html")).sort();
    filmUrls = pages.map((f) =>
      `  <url><loc>https://filmychill.com/movie/${f}</loc><lastmod>${today}</lastmod><priority>0.5</priority></url>`);
  } catch (e) {}
  fs.writeFileSync("sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${countryUrls.join("\n")}\n${filmUrls.join("\n")}\n</urlset>\n`);
  console.log(`Sitemap: ${countries.length} country pages + ${filmUrls.length} film pages.`);
}

// Manual/local regeneration from existing data.json: PAGES_ONLY=1 node scripts/update.js
// ============================================================
// PRE-RENDER — inject this week's films as static HTML into
// index.html between SSR markers, so crawlers (and visitors,
// pre-hydration) see real content and real links instead of
// "Loading fresh picks". The page JS replaces it on load.
// ============================================================

function ssrCard(item, i, isIndia) {
  const e = escHtml;
  const bits = [item.language, item.genre ? item.genre.split(" / ")[0] : null].filter(Boolean).map(e).join(" · ");
  const inner = `
    <div class="rank">${String(i + 1).padStart(2, "0")}</div>
    ${item.poster ? `<img class="poster" src="${e(item.poster)}" alt="${e(item.title)} poster" width="150" height="200" loading="lazy">` : ""}
    <div>
      <div class="title-row"><h3>${e(item.title)}</h3><span class="platform">${e(item.platform || "")}</span>${item.isRecent ? '<span class="fresh-badge">New release</span>' : ""}</div>
      <div class="meta">${bits}</div>
      ${item.rating != null ? `<div class="meta">★ ${Number(item.rating).toFixed(1)}${item.verdict ? " · " + e(item.verdict) : ""}</div>` : ""}
      ${item.review ? `<p class="review">${e(trim(item.review, 110))}</p>` : ""}
    </div>`;
  // Per-film pages exist only for India -> link there. Other countries render a non-link card
  // (the page JS makes it interactive via the detail modal on load), avoiding broken links.
  return isIndia
    ? `<a class="card${item.poster ? "" : " no-poster"}" href="/movie/${e(item.slug)}.html" style="text-decoration:none;color:inherit">${inner}</a>`
    : `<div class="card${item.poster ? "" : " no-poster"}" style="color:inherit">${inner}</div>`;
}

function ssrSoonCard(item) {
  const e = escHtml;
  return `<a class="soon-card" href="/movie/${e(item.slug)}.html" style="text-decoration:none;color:inherit">
    ${item.poster ? `<img src="${e(item.poster)}" alt="${e(item.title)} poster" width="150" height="200" loading="lazy">` : ""}
    <div class="soon-body">
      <div class="soon-date">${e(item.released || "")}</div>
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
const COUNTRY_PAGE_META = {
  in: { name: "India", path: "/" },
  us: { name: "the US", path: "/us/" },
  uk: { name: "the UK", path: "/uk/" },
  au: { name: "Australia", path: "/au/" },
  de: { name: "Germany", path: "/de/" },
};
function buildHeadTags(cfg) {
  const m = COUNTRY_PAGE_META[cfg.code] || { name: cfg.name, path: `/${cfg.code}/` };
  const url = `https://filmychill.com${m.path}`;
  if (cfg.code === "in") {
    // Root keeps the multi-country, India-first wording already chosen.
    return `<title>FilmyChill — Latest Movie & OTT Releases, with Reviews, Updated Daily</title>\n`
      + `<meta name="description" content="Latest theatre and OTT releases across India, US, UK, Australia &amp; Germany — trailers, IMDb ratings, verdicts, auto-updated daily.">\n`
      + `<link rel="canonical" href="${url}">\n`
      + `<meta property="og:title" content="FilmyChill — What's worth watching this week">\n`
      + `<meta property="og:description" content="Latest theatre and OTT releases across India, US, UK, Australia &amp; Germany — trailers, IMDb ratings, verdicts. Auto-updated daily.">`;
  }
  return `<title>FilmyChill — Latest Movie &amp; OTT Releases in ${m.name}, with Reviews, Updated Daily</title>\n`
    + `<meta name="description" content="Latest theatre and OTT releases in ${m.name} on Netflix, Prime Video, Disney+ and more — trailers, IMDb ratings, verdicts, auto-updated daily.">\n`
    + `<link rel="canonical" href="${url}">\n`
    + `<meta property="og:title" content="FilmyChill — What's worth watching this week in ${m.name}">\n`
    + `<meta property="og:description" content="Top theatre releases + OTT picks in ${m.name} with trailers, IMDb ratings and verdicts. Auto-updated daily.">`;
}

// Homepage structured data: WebSite + dateModified + an ItemList of this
// week's films, so crawlers see a fresh, ranked collection without running JS.
function buildHomeJsonLd(data, cfg) {
  const m = COUNTRY_PAGE_META[(cfg && cfg.code) || "in"] || { name: "", path: "/" };
  const pageUrl = `https://filmychill.com${m.path}`;
  const date = (data.generatedAt || new Date().toISOString()).slice(0, 10);
  // Per-film pages exist only for India; other countries' list items point to the country page.
  const isIndia = !cfg || cfg.code === "in";
  const listItems = [...(data.theatres || []), ...(data.ott || [])]
    .filter((x) => x.slug)
    .map((x, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: isIndia ? `https://filmychill.com/movie/${x.slug}.html` : pageUrl,
      name: x.title,
    }));
  const listName = isIndia ? "What's worth watching this week" : `What's worth watching this week in ${m.name}`;
  const graph = [
    {
      "@type": "WebSite",
      "@id": "https://filmychill.com/#website",
      name: "FilmyChill",
      url: "https://filmychill.com/",
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
           `Ratings information courtesy of <a href="https://www.imdb.com" rel="noopener" target="_blank">IMDb</a> (https://www.imdb.com). Used with permission.<br>\n  `;
  }
  return `Film data and ratings from ${tmdb}. This product uses the TMDB API but is not endorsed or certified by TMDB.<br>\n  `;
}

// Render one country's page from the pristine template string and write it to its path
// (root index.html for India, <code>/index.html for others). The template is read ONCE by
// the caller and passed in, so per-country injections never stack on each other.
function renderCountryPage(templateHtml, cfg, data) {
  const isIndia = cfg.code === "in";
  let html = templateHtml;
  html = replaceBetween(html, "HEAD", buildHeadTags(cfg));
  html = replaceBetween(html, "PAGECODE", `<meta name="fc-page" content="${cfg.code}">`);
  html = replaceBetween(html, "THEATRES", (data.theatres || []).map((x, i) => ssrCard(x, i, isIndia)).join(""));
  html = replaceBetween(html, "OTT", (data.ott || []).map((x, i) => ssrCard(x, i, isIndia)).join(""));
  html = replaceBetween(html, "SOON", (data.comingSoon || []).map(ssrSoonCard).join(""));
  html = replaceBetween(html, "JSONLD", buildHomeJsonLd(data, cfg));
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
  generatePages(d);
  prerenderIndex(d);
  fs.writeFileSync("data.json", JSON.stringify(d, null, 1));
  process.exit(0);
}

// Export pure/helper functions for unit testing (only meaningful when required, not run).
module.exports = {
  verdict, trim, img, slugify, escHtml, ytIdOf, replaceBetween,
  assignSlugs, buildHeadTags, buildHomeJsonLd, ssrCard, ssrSoonCard,
  footerAttribution, RATINGS_SOURCE, USE_IMDB,
  deriveFreshDate, isOttFresh, OTT_FRESH_DAYS,
};
