// ============================================================================
// enrich.js — turning a TMDB id into a full item: IMDb ratings dataset, cast photos, age
// certificates, theatrical eligibility and dates, and enrich() itself.
// ============================================================================
"use strict";

const zlib = require("zlib");
const { slugify, trim } = require("./core.js");
const { freshBadge } = require("./freshness.js");
const { img } = require("./pagekit.js");
const {
  dedupeProviders,
  deriveFreshDate,
  langCode,
  langName,
  rankSimilar,
} = require("./rules.js");
const { tmdb, USE_IMDB } = require("./tmdb.js");

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
const imdbRatings = new Map(); // populated at the start of main()

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

// ============================================================================
// AGE CERTIFICATES — one reading of a rating label, for 14 different rating boards.
//
// The old rule was three regexes tuned to India, the US and the UK, and it broke the moment
// the site added Asia-Pacific markets:
//   Korea's "ALL" (the universal rating) starts with "A" and was read as adults-only.
//   The Philippines' "R-13" and New Zealand's "R13" start with "R" and were read the same way.
//   Indonesia's "17+" and "21+" matched nothing and fell through to "Check rating".
// Telling a parent that a universal-rating film is adults-only is a worse failure than saying
// nothing, so the rule now reads the AGE out of the label — which is what every board encodes
// — and only falls back to letters when there is no number.
//
// Returns { bucket, label } where bucket is "adults" | "teens" | "family" | "unknown".
// Boards covered by the live markets: IN (U, U/A 7+/13+/16+, A), US (G, PG, PG-13, R, NC-17,
// TV-MA), GB (U, PG, 12A, 15, 18), AU/NZ (G, PG, M, MA15+, R13, R16, R18), DE (0, 6, 12, 16,
// 18), AE (G, PG13, 15+, 18TC), CA, SG (G, PG13, NC16, M18, R21), MY (U, P13, 18), PH (G, PG,
// R-13, R-16, R-18), JP (G, PG12, R15+, R18+), KR (ALL, 12, 15, 19), ID (SU, 13+, 17+, 21+).
function certAudience(cert) {
  const c = String(cert || "").toUpperCase().trim();
  if (!c) return { bucket: "unknown", label: "Check rating" };
  // NC-17 carries a number that would otherwise read as "teens".
  if (/^NC-?17/.test(c) || /^(TV-MA|X|A|R|R21|AO)$/.test(c)) return { bucket: "adults", label: "Adults only" };
  const n = (c.match(/\d{1,2}/) || [])[0];
  if (n !== undefined) {
    const age = Number(n);
    if (age >= 18) return { bucket: "adults", label: "Adults only" };
    if (age >= 12) return { bucket: "teens", label: "Older kids & up" };
    return { bucket: "family", label: "Yes — family friendly" };   // U/A 7+, DE 0/6, TV-Y7
  }
  // No age in the label: universal and guidance ratings first, then the adult letters.
  if (/^(ALL|SU|U|G|E|P|AL|TV-G|TV-Y|K-A|PG|TV-PG|GP)$/.test(c)) {
    return { bucket: "family", label: "Yes — family friendly" };
  }
  if (/^(M|MA|TV-14)$/.test(c)) return { bucket: "teens", label: "Older kids & up" };  // AU/NZ "M" is advisory
  if (/^(NC|AO|18|ADULT)/.test(c)) return { bucket: "adults", label: "Adults only" };
  return { bucket: "unknown", label: "Check rating" };
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
  // TYPE 2 (limited) and 3 (theatrical) only — deliberately NOT type 1 (premiere).
  // A premiere is a festival/industry screening the public cannot buy a ticket to, and it
  // can predate the real release by months: Bokshi premiered 31 Jan 2026 and releases
  // 9 Oct 2026, so taking the earliest of types 1-3 stamped a PAST date on an UPCOMING
  // film and printed "Released 31 Jan" under "Coming soon". Types 2/3 are also exactly what
  // theatreEligible() already treats as a proven theatrical run, so the two now agree.
  // No 2/3 entry -> null -> caller keeps TMDB's primary release_date, which is the better
  // public date anyway.
  const dates = (rel?.release_dates || [])
    .filter((x) => (x.type === 2 || x.type === 3) && x.release_date)
    .map((x) => String(x.release_date).slice(0, 10))
    .sort();
  return dates[0] || null;
}

// Pure: the region's ANNOUNCED digital (streaming) release — TMDB release_dates type 4.
// Platforms publish these ahead of arrival and TMDB carries them, often with the platform in
// the note ("ZEE5", "Netflix"). Sept 2026: a TMDB-based competitor listed Hi! on ZEE5 for
// 25 Sept days ahead while FilmyChill said "not announced" — the data was in the same API
// response FilmyChill already fetches. Earliest type-4 date wins; the note is kept only when
// it names something (TMDB sometimes stores "" or a region code).
function digitalReleaseFor(d, region) {
  const rel = d && d.release_dates && d.release_dates.results
    ? d.release_dates.results.find((r) => r.iso_3166_1 === region) : null;
  const dig = ((rel && rel.release_dates) || [])
    .filter((x) => x.type === 4 && x.release_date)
    .map((x) => ({ date: String(x.release_date).slice(0, 10), note: String(x.note || "").trim() }))
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!dig) return null;
  const note = /^[A-Za-z0-9+ .&'-]{2,30}$/.test(dig.note) && !/^[A-Z]{2}$/.test(dig.note) ? dig.note : "";
  return { date: dig.date, note };
}

async function enrich(kind, id, region = "IN") {
  const extra = kind === "movie" ? "release_dates" : "content_ratings";
  const d = await tmdb(`/${kind}/${id}`, { append_to_response: `videos,credits,watch/providers,external_ids,recommendations,${extra}` });

  const digital = kind === "movie" ? digitalReleaseFor(d, region) : null;
  const cert = certFor(kind, d, region);

  // Trailer — fall back to a YouTube search link if TMDB has no video yet
  const vids = d.videos?.results || [];
  const t = vids.find((v) => v.site === "YouTube" && v.type === "Trailer") || vids.find((v) => v.site === "YouTube");
  const trailer = t
    ? `https://www.youtube.com/watch?v=${t.key}`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(`${d.title || d.name || ""} official trailer`)}`;

  // Streaming platforms in this country's region
  const inProv = d["watch/providers"]?.results?.[region];
  const providers = dedupeProviders((inProv?.flatrate || []).map((p) => p.provider_name)).slice(0, 4);

  // Rent/buy platforms from the SAME response — zero extra API calls. "Streaming on X"
  // never said whether it costs extra; and for theatrical releases, "can I rent it at
  // home yet?" is the single most-asked follow-up. Rent and buy are one shelf to a
  // viewer, so they're merged; platforms already offering it on subscription are
  // dropped (the included copy is the better answer).
  const rentBuy = dedupeProviders([...(inProv?.rent || []), ...(inProv?.buy || [])].map((p) => p.provider_name))
    .filter((p) => !providers.includes(p)).slice(0, 4);

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
  const recs = rankSimilar(d.recommendations?.results, kind, d.original_language)
    .slice(0, 12) // page builder promotes on-site titles from this pool, then shows 6
    .map((x) => ({
      title: x.title || x.name,
      slug: slugify(x.title || x.name),
      poster: img(x.poster_path),
      language: langName(langCode(x)) || null,
      kind: x.media_type === "tv" || x.first_air_date ? "tv" : "movie",
    }));

  // Region's own theatrical date overrides the global primary date when TMDB has one —
  // so each country page shows (and freshness-gates by) its own market's release day.
  const regionalRelease = kind === "movie" ? regionalTheatricalDate(d, region) : null;
  const theatrical = kind === "movie" ? theatreEligible(d, region, providers) : null;

  return {
    cert, trailer, providers, cast, director, runtime, imdbScore, imdbVotes,
    ...(rentBuy.length ? { rentBuy } : {}),
    imdbId: imdbId || null, // handle for cross-source lookups (Wikipedia buzz via Wikidata P345)
    seasons: kind === "tv" ? d.number_of_seasons || null : null,
    freshDate, badge, isRecent: badge != null, similar: recs,
    backdrop: img(d.backdrop_path, "w780"),
    // Raw TMDB paths kept so the social/Discover og:image can request a LARGE size
    // (>=1200px) independently of the w780 inline backdrop above, which stays small for
    // page weight. Google Discover ignores images under ~1200px wide; w780 would forfeit
    // eligibility. Not serialized when absent.
    ...(d.backdrop_path ? { backdropPath: d.backdrop_path } : {}),
    ...(d.poster_path ? { posterPath: d.poster_path } : {}),
    fullReview: trim(d.overview, 600),
    ...(regionalRelease ? { released: regionalRelease } : {}),
    ...(castPics.length ? { castPics } : {}),
    ...(theatrical === false ? { theatrical: false } : {}), // only serialized when it matters
    // Announced streaming date (see digitalReleaseFor). Only while nothing is streaming yet:
    // once a provider exists, "where to watch" is the answer and the date is history.
    ...((kind === "movie" && !providers.length && digital) ? { digitalDate: digital.date, ...(digital.note ? { digitalNote: digital.note } : {}) } : {}),
  };
}

module.exports = {
  certAudience,
  certFor,
  digitalReleaseFor,
  enrich,
  extractCastPics,
  imdbRatings,
  loadImdbRatings,
  regionalTheatricalDate,
  THEATRE_EXCLUDE_IDS,
  theatreEligible,
};
