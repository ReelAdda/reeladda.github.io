// ============================================================================
// tmdbmock.js — a deterministic stand-in for TMDB, for tests (lib/tmdb.js withReplay).
//
// Answers every endpoint the build uses with plausible data. Each film's attributes come from
// its id alone (title, language, dates, platforms, ratings), so the same film is the same in
// every list it appears in, and ids are drawn from small overlapping pools, so lists share films
// and the de-duplication and quota logic runs as it does on real data. Same inputs, same
// answers, every time: two builds over it must produce identical output.
// ============================================================================
"use strict";

const { COUNTRIES } = require("../lib/core.js");

const LANGS = ["en", "hi", "ta", "te", "ml", "kn", "ko", "ja", "es", "fr", "pa", "mr", "bn", "id", "pt", "de"];
const PLATFORMS = ["Netflix", "Amazon Prime Video", "JioHotstar", "Zee5", "SonyLIV", "Apple TV+", "Max", "Disney+"];
const DAY = 864e5;

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function makeMock({ now = Date.now() } = {}) {
  const today = Date.parse(`${iso(now)}T00:00:00Z`);
  // Bands within each language block: 0-99 in cinemas now, 100-199 streaming (older), 200-299 upcoming.
  const film = (id) => {
    const tv = id >= 50000;
    const n = tv ? id - 50000 : id;
    const lang = LANGS[Math.floor(n / 1000) % LANGS.length];
    const off = n % 1000, band = Math.floor(off / 100), h = hash(String(id));
    const rel = band === 0 ? today - (2 + (h % 24)) * DAY : band === 1 ? today - (60 + (h % 340)) * DAY : today + (5 + (h % 85)) * DAY;
    // About a third of the films in cinemas are already streaming somewhere, so the OTT ranking,
    // the freshness gate and the cross-list de-duplication all have real work to do.
    const streaming = band === 1 || (band === 0 && h % 3 === 0);
    return {
      id, tv, lang, band, rel: iso(rel), h,
      title: `${tv ? "Series" : "Film"} ${lang.toUpperCase()} ${off}`,
      votes: band === 2 ? 0 : band === 0 ? 5 + (h % 400) : 50 + (h % 5000),
      rating: band === 2 ? 0 : Math.round((5.2 + (h % 34) / 10) * 10) / 10,
      popularity: Math.round(((h % 2000) / 10 + 1) * 10) / 10,
      platforms: streaming ? [PLATFORMS[h % PLATFORMS.length], ...(h % 3 === 0 ? [PLATFORMS[(h >> 3) % PLATFORMS.length]] : [])] : [],
      runtime: tv ? 45 : 90 + (h % 80),
      genres: [[18, "Drama"], [28, "Action"], [35, "Comedy"], [53, "Thriller"], [10749, "Romance"]][h % 5],
    };
  };
  const listItem = (f) => f.tv
    ? { id: f.id, name: f.title, original_name: f.title, original_language: f.lang, first_air_date: f.rel, vote_average: f.rating, vote_count: f.votes, popularity: f.popularity, genre_ids: [f.genres[0]], poster_path: `/p${f.id}.jpg`, overview: `About ${f.title}.`, media_type: "tv" }
    : { id: f.id, title: f.title, original_title: f.title, original_language: f.lang, release_date: f.rel, vote_average: f.rating, vote_count: f.votes, popularity: f.popularity, genre_ids: [f.genres[0]], poster_path: `/p${f.id}.jpg`, overview: `About ${f.title}.`, media_type: "movie" };

  function list(path, params) {
    const tv = /\/tv\b/.test(path);
    const p = params || {};
    const gte = p["primary_release_date.gte"] || p["release_date.gte"] || p["first_air_date.gte"];
    const lte = p["primary_release_date.lte"] || p["release_date.lte"] || p["first_air_date.lte"];
    const t = iso(today);
    let band;
    if (/now_playing/.test(path)) band = 0;
    else if (/upcoming/.test(path)) band = 2;
    else if (p.with_watch_monetization_types || p.watch_region) band = 1;
    else if (gte && gte > t) band = 2;
    else if (lte && lte <= t) band = 0;
    else band = null;                                         // trending: a mix
    const langIdx = p.with_original_language ? LANGS.indexOf(p.with_original_language) : -1;
    const seed = hash(path + JSON.stringify(p));
    const results = [];
    for (let i = 0; i < 20; i++) {
      const h = hash(`${seed}:${i}`);
      const li = langIdx >= 0 ? langIdx : (h % 4 === 0 ? 0 : h % LANGS.length);
      const b = band == null ? [0, 1, 1][h % 3] : band;
      const id = (tv ? 50000 : 0) + li * 1000 + b * 100 + (h % 40);   // 40 per band: lists overlap
      if (results.some((r) => r.id === id)) continue;
      results.push(listItem(film(id)));
    }
    return { page: Number(p.page || 1), results, total_pages: 1, total_results: results.length };
  }

  function detail(kind, id) {
    const f = film(id);
    const providers = {};
    for (const c of COUNTRIES) {
      const region = c.watchRegion || c.region;
      const flat = f.platforms.filter((_, i) => (hash(region + id) + i) % 5 !== 0);
      providers[region] = { link: "", ...(flat.length ? { flatrate: flat.map((n) => ({ provider_name: n })) } : {}),
        ...(f.band !== 2 && f.h % 4 === 1 ? { rent: [{ provider_name: "Apple TV Store" }], buy: [{ provider_name: "Amazon Video" }] } : {}) };
    }
    const base = {
      id, original_language: f.lang, popularity: f.popularity, vote_average: f.rating, vote_count: f.votes,
      genres: [{ id: f.genres[0], name: f.genres[1] }], overview: `About ${f.title}. A story told in ${f.lang}.`,
      poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`,
      videos: { results: [{ site: "YouTube", type: "Trailer", key: `k${id}xyz`, published_at: `${f.rel}T00:00:00.000Z` }] },
      credits: { cast: Array.from({ length: 6 }, (_, i) => ({ name: `Actor ${id}-${i}`, character: `Role ${i}`, profile_path: `/a${id}${i}.jpg` })),
        crew: [{ job: "Director", name: `Director ${id}` }] },
      external_ids: { imdb_id: `tt${String(id).padStart(7, "0")}` },
      recommendations: { results: [1, 2, 3].map((k) => listItem(film(Math.floor(id / 1000) * 1000 + 100 + ((id + k * 7) % 40)))) },
      "watch/providers": { results: providers },
    };
    if (kind === "tv") return { ...base, name: f.title, original_name: f.title, first_air_date: f.rel, episode_run_time: [f.runtime], number_of_seasons: 1 + (f.h % 3),
      content_ratings: { results: COUNTRIES.map((c) => ({ iso_3166_1: c.region, rating: "16" })) } };
    return { ...base, title: f.title, original_title: f.title, release_date: f.rel, runtime: f.runtime,
      release_dates: { results: COUNTRIES.map((c) => ({ iso_3166_1: c.region, release_dates: [{ type: 3, release_date: `${f.rel}T00:00:00.000Z`, certification: "UA" }] })) } };
  }

  return async function mockTmdb(path, params = {}) {
    const m = /^\/(movie|tv)\/(\d+)$/.exec(path);
    if (m) return JSON.parse(JSON.stringify(detail(m[1], Number(m[2]))));
    const sub = /^\/(movie|tv)\/(\d+)\/(release_dates|watch\/providers|external_ids)$/.exec(path);
    if (sub) { const d = detail(sub[1], Number(sub[2])); return JSON.parse(JSON.stringify(sub[3] === "external_ids" ? d.external_ids : sub[3] === "release_dates" ? d.release_dates : d["watch/providers"])); }
    if (/^\/genre\//.test(path)) return { genres: [[18, "Drama"], [28, "Action"], [35, "Comedy"], [53, "Thriller"], [10749, "Romance"]].map(([id, name]) => ({ id, name })) };
    return list(path, params);
  };
}

module.exports = { makeMock };
