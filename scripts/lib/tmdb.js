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

// ============================================================================
// METERING AND RECORD/REPLAY (Oct 2026). Every TMDB call in the build goes through tmdb(), so
// this is the one place to count them and to capture them:
//   setStage(name)        calls and time are counted against the build stage now running;
//                         meterReport() returns them for the run summary.
//   startRecording()      every answer from now on is kept (JSON text, by path + params);
//   stopRecording()       returns that Map and stops keeping.
//   withReplay(map, fn)   runs fn with tmdb() answering from the map instead of the network
//                         (a missing entry throws, like a failed call would) and sleep() not
//                         waiting. The build uses it to prove a refactor changed nothing, on
//                         the run's own real answers; tests use it with fixtures.
// Modules take tmdb and sleep when they load, so the hooks live inside them, not around them.
// ============================================================================
const METER = { stage: "start", calls: {}, ms: {}, errors: {} };
let RECORD = null, REPLAY = null;
const keyOf = (path, params) => path + "?" + JSON.stringify(Object.keys(params || {}).sort().map((k) => [k, String(params[k])]));
function setStage(name) { METER.stage = name || "start"; }
function meterReport() {
  return Object.keys(METER.calls).map((stage) => ({ stage, calls: METER.calls[stage], ms: METER.ms[stage] || 0, errors: METER.errors[stage] || 0 }));
}
function startRecording() { RECORD = new Map(); }
function stopRecording() { const r = RECORD; RECORD = null; return r || new Map(); }
async function withReplay(map, fn) {
  const prev = REPLAY; REPLAY = map;
  try { return await fn(); } finally { REPLAY = prev; }
}

const sleep = (ms) => (REPLAY ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

// TMDB fetch with retry + exponential backoff. Transient failures (429 rate-limit, 5xx,
// network errors) are retried up to MAX_RETRIES with growing delays, honoring the server's
// Retry-After header when present. A 4xx other than 429 fails fast (it won't fix on retry).
// This protects the daily build from a single network hiccup corrupting a country's output.
const TMDB_MAX_RETRIES = 4;
async function tmdb(path, params = {}) {
  if (REPLAY) {
    // A function answers like TMDB would (tests' fake TMDB); a Map answers from a recording.
    if (typeof REPLAY === "function") return REPLAY(path, params);
    const hit = REPLAY.get(keyOf(path, params));
    if (hit === undefined) throw new Error(`TMDB ${path} failed: not in the recording`);
    if (hit.error) throw new Error(hit.error);
    return JSON.parse(hit.body);
  }
  const st = METER.stage, t0 = Date.now();
  METER.calls[st] = (METER.calls[st] || 0) + 1;
  try {
    const body = await fetchTmdb(path, params);
    if (RECORD) RECORD.set(keyOf(path, params), { body: JSON.stringify(body) });
    return body;
  } catch (e) {
    METER.errors[st] = (METER.errors[st] || 0) + 1;
    if (RECORD) RECORD.set(keyOf(path, params), { error: e.message });
    throw e;
  } finally { METER.ms[st] = (METER.ms[st] || 0) + (Date.now() - t0); }
}

async function fetchTmdb(path, params = {}) {
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
  keyOf,
  RATINGS_SOURCE,
  meterReport,
  setStage,
  sleep,
  startRecording,
  stopRecording,
  tmdb,
  USE_IMDB,
  withReplay,
};
