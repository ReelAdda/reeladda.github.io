// ============================================================================
// rollout.js — page changes switched on for a share of films at a time (Oct 2026).
//
// Why: on 18 Oct 2026 a redesign moved ~12,000 pages' sitemap dates in one build, and on 22 Oct
// a FAQ change rewrote ~17,800 pages in one build; Google impressions fell ~84% on 22 Oct. Not
// proven to be the cause, but a mass rewrite makes Google recrawl and re-judge the whole site at
// once. From now on, a change to many pages goes out in stages: 10% of films, then 25%, 50%, 100%,
// with Search Console checked between stages.
//
// How: rollout.json lists each change and its share, e.g.
//   { "features": { "not-announced-wording": { "percent": 25, "since": "2026-10-25" } } }
// inRollout(feature, slug) is true for that share of films, picked by a hash of the feature and
// the film's slug: every edition of a film changes together, a film that's in stays in as the
// share grows, and different changes pick different films. A missing file or feature is 0%.
// Setting a feature back to 0 undoes it on the next build.
// ============================================================================
"use strict";

const crypto = require("crypto");
const fs = require("fs");

const ROLLOUT_FILE = "rollout.json";

// Pure: where a film falls for a feature, 0–99.
function bucketOf(feature, slug) {
  return crypto.createHash("sha1").update(`${feature}:${slug}`).digest().readUInt32BE(0) % 100;
}

// Pure: the share a config gives a feature on a day, 0–100. A feature may carry a schedule —
// [{ "from": "2026-10-28", "percent": 50 }, …] — and then the latest stage that has started
// applies (the stages advance by themselves; editing "percent" or the schedule still overrides).
function percentOf(config, feature, nowMs = Date.now()) {
  const f = config && config.features && config.features[feature];
  if (!f) return 0;
  let p = Number(f.percent);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  for (const s of (Array.isArray(f.schedule) ? f.schedule : []).slice().sort((a, b) => String(a.from).localeCompare(String(b.from)))) {
    if (s && /^\d{4}-\d{2}-\d{2}$/.test(String(s.from)) && s.from <= today && Number.isFinite(Number(s.percent))) p = Number(s.percent);
  }
  return Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
}

let cached = null;
function loadRollout(file = ROLLOUT_FILE) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { features: {} }; }
}
function rolloutConfig() { return cached || (cached = loadRollout()); }
function resetRolloutCache() { cached = null; }
// Tests and previews: use this config instead of rollout.json (null goes back to the file).
function useRolloutConfig(config) { cached = config || null; }

// Is this film's page in the rollout of this feature? `config` for tests; the build reads the file.
function inRollout(feature, slug, config = rolloutConfig(), nowMs = Date.now()) {
  if (!slug) return false;
  return bucketOf(feature, String(slug)) < percentOf(config, feature, nowMs);
}

// For the build log: "not-announced-wording 25%, ..." or "none".
function rolloutSummary(config = rolloutConfig()) {
  const f = Object.entries((config && config.features) || {}).map(([k]) => `${k} ${percentOf(config, k)}%`);
  return f.length ? f.join(", ") : "none";
}

module.exports = { ROLLOUT_FILE, bucketOf, inRollout, loadRollout, percentOf, resetRolloutCache, rolloutConfig, rolloutSummary, useRolloutConfig };
