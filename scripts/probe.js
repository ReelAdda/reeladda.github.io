#!/usr/bin/env node
// ============================================================================
// probe.js — high-frequency arrival watcher.
//
// The site build runs twice a day, so a first-seen date built from it has 12-hour
// resolution and "exact drop time" is not a claim we can honestly make. This runs every 30
// minutes, asks only "did any pending title gain a provider yet", and appends to the
// archive. It regenerates NOTHING — no pages, no data files, no sitemap — so the observation
// loop and the build loop stay independent and the repo doesn't churn.
//
// Budgeted: a fixed number of TMDB calls per run, oldest-pending first. Fails soft — a
// missing key, a rate limit or a network blip exits 0 so a watcher can never break CI.
// ============================================================================
"use strict";

const fs = require("fs");
const { appendHistory, historyRecord, readHistory } = require("./lib/history.js");

const API_KEY = process.env.TMDB_API_KEY;
const MAX_CALLS = Number(process.env.PROBE_BUDGET || 40);
const WATCH_FILE = "ott-watch.json";           // titles we are waiting on
const COUNTRIES = { in: "IN", us: "US", uk: "GB", au: "AU", de: "DE", ae: "AE", ca: "CA", sg: "SG" };

async function tmdb(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

// The watchlist is written by the main build: films released in theatres but not yet seen
// streaming anywhere. Falls back to an empty list so this never assumes the build ran.
function loadWatch() {
  try { return JSON.parse(fs.readFileSync(WATCH_FILE, "utf8")); } catch { return []; }
}

async function main() {
  if (!API_KEY) { console.log("probe: no TMDB_API_KEY — nothing to do"); return; }
  const watch = loadWatch();
  if (!watch.length) { console.log("probe: watchlist empty"); return; }

  const seen = new Set(readHistory().map((r) => `${r.c}:${r.k}:${r.id}`));
  const pending = watch.filter((w) => !COUNTRIES[w.code] ? false
    : !seen.has(`${w.code}:${w.kind === "tv" ? "tv" : "movie"}:${w.tmdbId}`));
  // Oldest theatrical release first: those are the ones closest to a streaming drop.
  pending.sort((a, b) => String(a.released || "").localeCompare(String(b.released || "")));

  let calls = 0, found = 0;
  for (const w of pending) {
    if (calls >= MAX_CALLS) break;
    calls++;
    let providers;
    try {
      const d = await tmdb(`/${w.kind === "tv" ? "tv" : "movie"}/${w.tmdbId}/watch/providers`);
      const region = d.results?.[COUNTRIES[w.code]];
      providers = [...(region?.flatrate || []), ...(region?.free || [])].map((p) => p.provider_name);
    } catch (e) { console.warn(`  probe ${w.tmdbId} [${w.code}]: ${e.message}`); continue; }
    if (!providers || !providers.length) continue;
    // First sighting. The timestamp is the value this script exists for: resolution of
    // ~30 minutes instead of ~12 hours.
    const wrote = appendHistory(historyRecord({
      code: w.code, kind: w.kind, tmdbId: w.tmdbId, title: w.title,
      platform: providers[0], providers, first: new Date().toISOString().slice(0, 10),
      theatrical: w.released, language: w.language, genre: w.genre,
    }));
    if (wrote) { found++; console.log(`  arrival: ${w.title} → ${providers[0]} [${w.code}]`); }
  }
  console.log(`probe: ${calls} checks, ${found} new arrival(s), ${pending.length - calls} still pending`);
}

main().catch((e) => { console.warn("probe failed soft:", e.message); process.exit(0); });
