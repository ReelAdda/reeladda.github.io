// ============================================================================
// history.js — the append-only streaming-arrival archive.
//
// WHY THIS EXISTS SEPARATELY FROM ott-seen.json
// ott-seen.json is OPERATIONAL state: it feeds the freshness gate, and it prunes entries
// unseen for SEEN_RETENTION_DAYS so a title that leaves and re-enters a catalogue can't
// masquerade as new. That pruning is correct for its job and fatal for a historical record —
// it means observations silently delete themselves every six months.
//
// This file is the record. Append-only, never pruned, one JSON object per line. It is the
// only asset here that cannot be reconstructed later: TMDB stores no history of provider
// changes and JustWatch publishes none, so a competitor starting in 2027 can never obtain
// 2026. Every day this doesn't run is a day permanently missing.
//
// JSONL rather than JSON on purpose: appending a line costs nothing, needs no parse of the
// whole file, and a truncated write loses one observation instead of the archive.
// ============================================================================
"use strict";

const fs = require("fs");

const HISTORY_FILE = "ott-history.jsonl";

// One observation. `first` is the date we first saw this title carrying a provider in this
// country; `theatrical` is its release date, so the pair yields the theatrical→streaming
// window without a second lookup later.
function historyRecord({ code, kind, tmdbId, title, platform, providers, first, theatrical, language, genre }) {
  return {
    c: code, k: kind === "tv" ? "tv" : "movie", id: tmdbId, t: title || null,
    p: platform || null,
    ps: Array.isArray(providers) && providers.length ? providers.slice(0, 6) : undefined,
    first, rel: theatrical || null,
    lang: language || null, g: genre || null,
    seen: new Date().toISOString(),
  };
}

// In-process index of what the archive already holds, so a title observed on every run for
// six months produces ONE line, not 360. Keyed country:kind:id.
let _index = null;
function loadHistoryIndex() {
  if (_index) return _index;
  _index = new Set();
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); _index.add(`${o.c}:${o.k}:${o.id}`); } catch { /* skip malformed */ }
    }
  } catch { /* first ever run */ }
  return _index;
}

// Returns true when a NEW line was written. Idempotent per (country, title).
function appendHistory(rec) {
  if (!rec || !rec.id || !rec.c) return false;
  const idx = loadHistoryIndex();
  const key = `${rec.c}:${rec.k}:${rec.id}`;
  if (idx.has(key)) return false;
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(rec) + "\n");
  idx.add(key);
  return true;
}

function readHistory() {
  try {
    return fs.readFileSync(HISTORY_FILE, "utf8").split("\n")
      .filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// Days from theatrical release to first streaming sighting. Null when either date is
// missing, or when the film reached streaming BEFORE its theatrical date (a straight-to-
// streaming title, or a bad date) — those would poison a median.
function streamingWindowDays(rec) {
  if (!rec || !rec.rel || !rec.first) return null;
  const rel = Date.parse(`${String(rec.rel).slice(0, 10)}T00:00:00Z`);
  const first = Date.parse(`${String(rec.first).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(rel) || !Number.isFinite(first)) return null;
  const d = Math.round((first - rel) / 864e5);
  return d < 0 || d > 730 ? null : d;   // negatives and multi-year gaps are not windows
}

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

// Aggregate the archive into the numbers the /data/ page publishes.
function windowStats(records, { code = null } = {}) {
  const rows = (records || []).filter((r) => r.k === "movie" && (!code || r.c === code));
  const withWindow = rows.map((r) => ({ r, d: streamingWindowDays(r) })).filter((x) => x.d != null);
  const by = (keyFn) => {
    const m = new Map();
    for (const { r, d } of withWindow) {
      const k = keyFn(r);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(d);
    }
    return [...m.entries()]
      .map(([k, ds]) => ({ key: k, n: ds.length, median: median(ds) }))
      .filter((x) => x.n >= 3)                 // never publish a "median" of one film
      .sort((a, b) => a.median - b.median);
  };
  return {
    total: rows.length,
    measured: withWindow.length,
    overall: median(withWindow.map((x) => x.d)),
    byLanguage: by((r) => r.lang),
    byPlatform: by((r) => r.p),
  };
}

module.exports = {
  HISTORY_FILE, appendHistory, readHistory, loadHistoryIndex,
  historyRecord, streamingWindowDays, windowStats, median,
};
