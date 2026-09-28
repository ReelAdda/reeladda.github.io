// ============================================================================
// tmdb.js — the one TMDB client: API key, retry/backoff policy, sleep(), and the
// RATINGS_SOURCE switch (TMDB vs IMDb ratings). Every module that talks to TMDB uses this.
// ============================================================================
"use strict";



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

module.exports = {
  API_KEY,
  RATINGS_SOURCE,
  sleep,
  tmdb,
  USE_IMDB,
};
