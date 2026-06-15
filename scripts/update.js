// ReelAdda weekly updater v2 — runs automatically via GitHub Actions.
// Fetches theatre + OTT releases with full details (trailer, cast, runtime,
// certificate, all streaming platforms), upcoming releases, and marks
// what's new since last week's scan. Writes data.json for the website.

const fs = require("fs");
const zlib = require("zlib");
const API_KEY = process.env.TMDB_API_KEY;
const BASE = "https://api.themoviedb.org/3";

if (!API_KEY && !process.env.PAGES_ONLY) {
  console.error("Missing TMDB_API_KEY. Add it in GitHub repo Settings → Secrets.");
  process.exit(1);
}

async function tmdb(path, params = {}) {
  const url = new URL(BASE + path);
  url.searchParams.set("api_key", API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${path} failed: ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LANG = { en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", ml: "Malayalam", kn: "Kannada", ko: "Korean", ja: "Japanese", es: "Spanish", fr: "French", mr: "Marathi", bn: "Bengali", pa: "Punjabi", gu: "Gujarati" };

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

async function enrich(kind, id) {
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

  // Streaming platforms in India
  const inProv = d["watch/providers"]?.results?.IN;
  const providers = (inProv?.flatrate || []).slice(0, 4).map((p) => p.provider_name);

  // Cast & director
  const cast = (d.credits?.cast || []).slice(0, 4).map((c) => c.name);
  let director = null;
  if (kind === "movie") director = (d.credits?.crew || []).find((c) => c.job === "Director")?.name || null;
  else director = d.created_by?.[0]?.name || null;

  const runtime = kind === "movie" ? d.runtime : (d.episode_run_time?.[0] || null);

  // IMDb rating via OMDb (optional). IMDb's base has more Indian raters than TMDB,
  // IMDb rating from the daily dataset (loaded once into imdbRatings). IMDb's base
  // has more Indian raters than TMDB, so it's a useful second opinion. Cheap in-memory
  // lookup by IMDb ID — no per-film network call. Missing title -> no chip (fallback).
  let imdbScore = null;
  const imdbId = d.external_ids?.imdb_id;
  if (imdbId && imdbRatings.has(imdbId)) {
    const r = imdbRatings.get(imdbId);
    if (r && r.rating) imdbScore = `${r.rating}/10`;
  }

  return {
    cert, trailer, providers, cast, director, runtime, imdbScore,
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
    };
  }

  // After enrich, fold in the IMDb rating (from the dataset). Appends the IMDb chip,
  // and — crucially — if IMDb has a rating but TMDB's votes were too thin to show one,
  // surfaces a real rating/verdict instead of the "New release" placeholder.
  function withImdb(item) {
    if (item.imdbScore) {
      item.scores = [...(item.scores || []), { source: "IMDb", score: item.imdbScore }];
      const num = parseFloat(item.imdbScore); // "7.4/10" -> 7.4
      if (!isNaN(num) && item.rating == null) {
        // TMDB couldn't give a rating (placeholder) — let IMDb stand in for display.
        item.rating = num;
        item.verdict = verdict(num, 1000); // enough-votes path: real verdict band
        item.isFresh = false; // no longer a "no rating yet" placeholder
      }
    }
    delete item.imdbScore;
    return item;
  }

  // ---------- IN THEATRES (blended score + language representation, flexible 4-7) ----------
  // Score = log10(popularity) x rating weight. Popularity still matters, but quality gets a vote.
  // Films with <20 votes get a neutral 6.0 so brand-new releases aren't punished or boosted.
  const np1 = await tmdb("/movie/now_playing", { region: "IN", page: "1" });
  await sleep(150);
  const np2 = await tmdb("/movie/now_playing", { region: "IN", page: "2" });
  const seen = new Set();
  const pool = [...np1.results, ...(np2.results || [])].filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  // Attach IMDb rating to each pool film BEFORE ranking, so IMDb (which has far more
  // Indian raters than TMDB) drives selection — not just display. One detail call per
  // film to resolve its IMDb ID, then a cheap lookup in the loaded dataset. Runs once
  // a day, so the extra calls are immaterial. Any failure leaves _imdbRating null and
  // the film falls back to its TMDB rating — never blocks ranking.
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

  const INDIAN_LANGS = ["hi", "ta", "te", "ml", "kn", "pa", "mr", "bn"];
  const isRegional = (m) => INDIAN_LANGS.includes(m.original_language);
  // Tunable: neutral prior C and smoothing constant M (how many votes before a
  // rating is trusted on its own). Per-country config can override these later.
  const PRIOR_C = 6.0, SMOOTH_M = 8;
  // Quality term for the blended score. Prefer IMDb's rating when we have it (better
  // signal for Indian titles, and present even when TMDB votes are thin); otherwise
  // fall back to the TMDB Bayesian-weighted rating. Popularity stays the freshness term.
  const weightedRating = (m) => {
    if (m._imdbRating != null) return m._imdbRating;
    const R = m.vote_average || 0, v = m.vote_count || 0;
    if (!isRegional(m)) return v >= 20 ? R : PRIOR_C;
    return (v / (v + SMOOTH_M)) * R + (SMOOTH_M / (v + SMOOTH_M)) * PRIOR_C;
  };
  const blended = (m) => Math.log10((m.popularity || 0) + 1) * (weightedRating(m) / 10);
  // Quality bar: a film with a real rating below 5.5 never makes the list. Uses IMDb
  // rating if present (with enough votes), else TMDB. Thin-data films aren't floored out.
  const clearsBar = (m) => {
    if (m._imdbRating != null && m._imdbVotes >= 100) return m._imdbRating >= 5.5;
    return !(m.vote_count >= 20 && m.vote_average < 5.5);
  };

  const ranked = pool.filter(clearsBar).sort((a, b) => blended(b) - blended(a));
  const MIN_PICKS = 4, MAX_PICKS = 7, BASE_PICKS = 5;
  let picks = ranked.slice(0, Math.min(BASE_PICKS, ranked.length));

  // Language representation: best film of each major Indian language earns a slot
  // if its weighted rating clears 6.5 and it isn't already in. No raw vote gate —
  // the Bayesian shrink already neutralises fluke ratings from tiny samples, so a
  // well-received regional film surfaces even on thin votes. If the list is full it
  // may displace the weakest pick whose language already holds 2+ slots.
  for (const lang of INDIAN_LANGS) {
    if (picks.some((m) => m.original_language === lang)) continue;
    const best = ranked.find((m) => m.original_language === lang && weightedRating(m) >= 6.5);
    if (!best) continue;
    if (picks.length < MAX_PICKS) { picks.push(best); continue; }
    const redundant = picks
      .filter((m) => picks.filter((x) => x.original_language === m.original_language).length >= 2)
      .sort((a, b) => blended(a) - blended(b))[0];
    if (redundant) picks[picks.indexOf(redundant)] = best;
  }
  // Never show an emaciated list: pad back toward MIN_PICKS from the ranked pool.
  for (const m of ranked) {
    if (picks.length >= MIN_PICKS) break;
    if (!picks.includes(m)) picks.push(m);
  }
  picks = picks.slice(0, MAX_PICKS).sort((a, b) => blended(b) - blended(a));

  const theatres = [];
  for (const m of picks) {
    const item = { ...baseItem(m, "movie"), platform: "Theatres" };
    try { Object.assign(item, await enrich("movie", m.id)); withImdb(item); } catch (e) { console.warn(`enrich movie ${m.id}: ${e.message}`); }
    theatres.push(item);
    await sleep(150);
  }

  // ---------- TOP 10 ON OTT (international + fresh regional, IMDb-ranked, max 10) ----------
  // International from global trending (inherently fresh); regional from per-language
  // discover gated to recent releases so we never resurface all-time classics. Both
  // ranked with the same IMDb-preferred quality term as theatres, for consistency.
  const OTT_MAX = 10, OTT_REGIONAL_TARGET = 4, OTT_INTL_CAP = OTT_MAX - OTT_REGIONAL_TARGET;
  const FRESH_DAYS = 30;
  const freshCutoff = new Date(Date.now() - FRESH_DAYS * 864e5).toISOString().slice(0, 10);

  // Resolve IMDb rating for a candidate (detail call -> dataset lookup). Sets _imdbRating
  // so weightedRating/blended use IMDb as the quality term, exactly like theatres.
  const attachImdb = async (c) => {
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
    const extra = await enrich(c.kind, c.id);
    if (!extra.providers || extra.providers.length === 0) return null; // not streaming in India
    Object.assign(item, extra, { platform: extra.providers[0] });
    withImdb(item);
    return item;
  };

  // --- International pool: global trending (fresh), non-regional, IMDb-ranked ---
  const [trMovies, trTv] = await Promise.all([tmdb("/trending/movie/week"), tmdb("/trending/tv/week")]);
  let intlCands = [
    ...trMovies.results.map((m) => ({ ...m, kind: "movie" })),
    ...trTv.results.map((t) => ({ ...t, kind: "tv" })),
  ].filter((c) => !isRegional(c));
  for (const c of intlCands) { await attachImdb(c); await sleep(150); }
  intlCands.sort((a, b) => blended(b) - blended(a));

  const intl = [], usedIds = new Set();
  for (const c of intlCands) {
    if (intl.length >= OTT_INTL_CAP) break;
    try { const it = await buildOttItem(c); if (it) { intl.push(it); usedIds.add(c.id); } }
    catch (e) { console.warn(`ott-intl ${c.id}: ${e.message}`); }
    await sleep(150);
  }

  // --- Regional pool: per-language discover, gated to recent releases (anti-staleness),
  //     Hindi first, IMDb-ranked. This is what surfaces fresh Hindi/regional OTT shows
  //     that never trend globally. ---
  const regionalOrder = ["hi", ...INDIAN_LANGS.filter((l) => l !== "hi")];
  const regional = [];
  for (const lang of regionalOrder) {
    if (regional.length >= OTT_REGIONAL_TARGET) break;
    let cands = [];
    for (const kind of ["tv", "movie"]) {
      const dateField = kind === "tv" ? "first_air_date.gte" : "primary_release_date.gte";
      try {
        const d = await tmdb(`/discover/${kind}`, {
          with_original_language: lang,
          watch_region: "IN",
          with_watch_monetization_types: "flatrate",
          sort_by: "popularity.desc",
          [dateField]: freshCutoff, // only recent releases — never all-time classics
          page: "1",
        });
        await sleep(150);
        cands.push(...(d.results || []).map((m) => ({ ...m, kind })));
      } catch (e) { console.warn(`ott-regional ${lang}/${kind}: ${e.message}`); }
    }
    cands = cands.filter((c) => !usedIds.has(c.id));
    for (const c of cands) { await attachImdb(c); await sleep(150); }
    // Rank by IMDb-preferred quality; drop sub-5.5 where we have a confident rating.
    cands = cands
      .filter((c) => !(c._imdbRating != null && c._imdbVotes >= 100 && c._imdbRating < 5.5))
      .sort((a, b) => blended(b) - blended(a));
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
      try { const it = await buildOttItem(c); if (it) { intl.push(it); usedIds.add(c.id); } }
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

  // ---------- COMING SOON (next releases in India) ----------
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = await tmdb("/movie/upcoming", { region: "IN", page: "1" });
  const soonBase = upcoming.results
    .filter((m) => m.release_date && m.release_date > today)
    .sort((a, b) => a.release_date.localeCompare(b.release_date))
    .slice(0, 8);

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
    };
    // Full details so the modal can show trailer, backdrop, cast, runtime
    try { Object.assign(item, await enrich("movie", m.id)); } catch (e) { console.warn(`soon ${m.id}: ${e.message}`); }
    comingSoon.push(item);
    await sleep(150);
  }

  // ---------- PICK OF THE WEEK ----------
  // An endorsement must be earned: new films need >=6.5 to take the crown.
  // If no newcomer qualifies, a genuinely great holdover (>=7.0) can be re-featured.
  // If nothing clears either bar, there is no pick this week — honesty over decoration.
  const all = [...theatres, ...ott];
  const pickPool = all.filter((x) => x.rating != null && x.votes >= 20);
  const pick = (pickPool.filter((x) => x.isRecent && x.rating >= 6.5).sort((a, b) => b.rating - a.rating)[0]) ||
               (pickPool.filter((x) => x.rating >= 7.0).sort((a, b) => b.rating - a.rating)[0]) || null;

  const data = { generatedAt: new Date().toISOString(), pick: pick ? pick.title : null, theatres, ott, comingSoon };
  // Strip internal-only fields (ranking helpers) so they never reach data.json.
  for (const list of [data.theatres, data.ott, data.comingSoon]) {
    for (const it of list) { delete it._pop; delete it._tmdbWeighted; delete it._imdbNum; delete it._imdbRating; delete it._imdbVotes; }
  }
  // ---------- PER-FILM PAGES + SITEMAP ----------
  assignSlugs(data);
  generatePages(data);
  prerenderIndex(data);

  fs.writeFileSync("data.json", JSON.stringify(data, null, 1));
  console.log(`Done. ${theatres.length} theatre, ${ott.length} OTT, ${comingSoon.length} upcoming. Pick: ${data.pick}`);
}

if (!process.env.PAGES_ONLY) main().catch((e) => {
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
  if (item.rating != null && item.votes >= 10) {
    ld.aggregateRating = { "@type": "AggregateRating", ratingValue: item.rating, ratingCount: item.votes, bestRating: 10 };
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
    ${item.poster ? `<img class="poster" src="${e(item.poster)}" alt="${e(item.title)} poster">` : "<div></div>"}
    <div>
      <h1>${e(item.title)}${year ? ` (${year})` : ""}</h1>
      <div class="meta">${[item.language, item.genre, item.runtime ? item.runtime + " min" : null, item.cert].filter(Boolean).map(e).join(" · ")}</div>
      ${item.rating != null ? `<div class="rating">★ ${Number(item.rating).toFixed(1)}${item.votes ? ` <span style="color:var(--mute);font-weight:400;font-size:13px">(${e(item.votes)} votes)</span>` : ""}</div>` : ""}
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
  Film data and ratings from <a href="https://www.themoviedb.org" rel="noopener">TMDB</a>. This product uses the TMDB API but is not endorsed or certified by TMDB.<br>
  © 2026 FilmyChill · Made with ❤️ by Vikram Sharma
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

  // Sitemap: homepage + every page in movie/ (the archive included)
  const today = new Date().toISOString().slice(0, 10);
  const pages = fs.readdirSync("movie").filter((f) => f.endsWith(".html")).sort();
  const fresh = new Set(all.map((x) => x.slug + ".html"));
  const urls = [
    `  <url><loc>https://filmychill.com/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    ...pages.map((f) =>
      `  <url><loc>https://filmychill.com/movie/${f}</loc>${fresh.has(f) ? `<lastmod>${today}</lastmod><priority>0.7</priority>` : "<priority>0.3</priority>"}</url>`),
  ];
  fs.writeFileSync("sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`);
  console.log(`Pages: ${written} written, ${pages.length} total in archive. Sitemap regenerated.`);
}

// Manual/local regeneration from existing data.json: PAGES_ONLY=1 node scripts/update.js
if (process.env.PAGES_ONLY) {
  const d = JSON.parse(fs.readFileSync("data.json", "utf8"));
  assignSlugs(d);
  generatePages(d);
  prerenderIndex(d);
  fs.writeFileSync("data.json", JSON.stringify(d, null, 1));
  process.exit(0);
}

// ============================================================
// PRE-RENDER — inject this week's films as static HTML into
// index.html between SSR markers, so crawlers (and visitors,
// pre-hydration) see real content and real links instead of
// "Loading fresh picks". The page JS replaces it on load.
// ============================================================

function ssrCard(item, i) {
  const e = escHtml;
  const bits = [item.language, item.genre ? item.genre.split(" / ")[0] : null].filter(Boolean).map(e).join(" · ");
  return `<a class="card${item.poster ? "" : " no-poster"}" href="/movie/${e(item.slug)}.html" style="text-decoration:none;color:inherit">
    <div class="rank">${String(i + 1).padStart(2, "0")}</div>
    ${item.poster ? `<img class="poster" src="${e(item.poster)}" alt="${e(item.title)} poster" loading="lazy">` : ""}
    <div>
      <div class="title-row"><h3>${e(item.title)}</h3><span class="platform">${e(item.platform || "")}</span>${item.isRecent ? '<span class="fresh-badge">New release</span>' : ""}</div>
      <div class="meta">${bits}</div>
      ${item.rating != null ? `<div class="meta">★ ${Number(item.rating).toFixed(1)}${item.verdict ? " · " + e(item.verdict) : ""}</div>` : ""}
      ${item.review ? `<p class="review">${e(trim(item.review, 110))}</p>` : ""}
    </div>
  </a>`;
}

function ssrSoonCard(item) {
  const e = escHtml;
  return `<a class="soon-card" href="/movie/${e(item.slug)}.html" style="text-decoration:none;color:inherit">
    ${item.poster ? `<img src="${e(item.poster)}" alt="${e(item.title)} poster" loading="lazy">` : ""}
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
  if (a === -1 || b === -1 || b < a) { console.warn(`SSR markers for ${tag} not found — skipped`); return html; }
  return html.slice(0, a + start.length) + inner + html.slice(b);
}

// Homepage structured data: WebSite + dateModified + an ItemList of this
// week's films, so crawlers see a fresh, ranked collection without running JS.
function buildHomeJsonLd(data) {
  const date = (data.generatedAt || new Date().toISOString()).slice(0, 10);
  const listItems = [...(data.theatres || []), ...(data.ott || [])]
    .filter((x) => x.slug)
    .map((x, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `https://filmychill.com/movie/${x.slug}.html`,
      name: x.title,
    }));
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
      name: "What's worth watching this week in India",
      url: "https://filmychill.com/",
      dateModified: data.generatedAt || `${date}T00:00:00.000Z`,
      numberOfItems: listItems.length,
      itemListElement: listItems,
    },
  ];
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph });
}

function prerenderIndex(data) {
  let html;
  try { html = fs.readFileSync("index.html", "utf8"); }
  catch { console.warn("index.html not found — prerender skipped"); return; }
  html = replaceBetween(html, "THEATRES", (data.theatres || []).map((x, i) => ssrCard(x, i)).join(""));
  html = replaceBetween(html, "OTT", (data.ott || []).map((x, i) => ssrCard(x, i)).join(""));
  html = replaceBetween(html, "SOON", (data.comingSoon || []).map(ssrSoonCard).join(""));
  html = replaceBetween(html, "JSONLD", buildHomeJsonLd(data));
  fs.writeFileSync("index.html", html);
  console.log("index.html pre-rendered with this week's films.");
}
