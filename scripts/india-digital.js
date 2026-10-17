#!/usr/bin/env node
// ============================================================================
// india-digital.js — the one-off catch-up for the Indian digital-release backfill
// (lib/indiadata.js), and its coverage report.
//
// The daily build reads a few hundred films a run; this reads the whole 2023-to-today backlog
// in one go (DIGITAL_BUDGET calls, default 8,000) and then reports what the data is worth:
// coverage by language, the figures /data/ would publish, and the best-known Hindi films with
// their dates, so a person can check them against what they know before anything is pitched.
// Writes the report to the run's Summary tab (GITHUB_STEP_SUMMARY) and to the log.
//
//   node scripts/india-digital.js            read the backlog, then report
//   node scripts/india-digital.js --report   report only (no API calls)
// ============================================================================
"use strict";

const fs = require("fs");
const { tmdb, sleep } = require("./lib/tmdb.js");
const { DIGITAL_FILE, PUBLISH_MIN, digitalStats, digitalWindow, runDigitalBackfill } = require("./lib/indiadata.js");

const today = new Date().toISOString().slice(0, 10);

function report(store) {
  const s = digitalStats(store, { today });
  const films = Object.values(store.films || {}).filter((f) => f.th && f.th <= today);
  const lines = [];
  lines.push(`# India: cinema to streaming, from TMDB digital release dates`, "");
  lines.push(`${s.films} Indian-language films that opened in Indian cinemas, ${s.from || "?"} to ${s.to || "?"}.`);
  lines.push(`Usable window for ${s.measured} (${s.films ? Math.round((100 * s.measured) / s.films) : 0}%). Among films with 20+ TMDB ratings: ${s.notable.measured} of ${s.notable.films} (${s.notable.films ? Math.round((100 * s.notable.measured) / s.notable.films) : 0}%).`);
  lines.push(`Median ${s.overall == null ? "n/a" : s.overall + " days"}. Left out: ${Object.entries(s.excluded).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}.`, "");
  lines.push("## By language", "", "| Language | Median days | Films with a window | Films released | Coverage |", "|---|---:|---:|---:|---:|");
  for (const r of s.byLanguage) lines.push(`| ${r.key}${r.small ? " *" : ""} | ${r.median} | ${r.n} | ${r.of} | ${Math.round((100 * r.n) / r.of)}% |`);
  lines.push("", "## By cinema release year", "", "| Year | Median days | Films |", "|---|---:|---:|");
  for (const r of s.byYear) lines.push(`| ${r.key} | ${r.median} | ${r.n} |`);
  lines.push("", `\\* fewer than ${PUBLISH_MIN} films.`, "");
  // Spot check: the films a reader would know. Wrong dates show up here first.
  const hindi = films.filter((f) => f.lang === "Hindi").sort((a, b) => (b.votes || 0) - (a.votes || 0)).slice(0, 30);
  lines.push("## Spot check: the 30 best-known Hindi films", "", "Compare with what you know. A wrong date here means the source can't be trusted as is.", "",
    "| Film | Cinema (IN) | Digital (IN) | Platform note | Window |", "|---|---|---|---|---:|");
  for (const f of hindi) {
    const w = digitalWindow(f);
    lines.push(`| ${f.t} | ${f.th || "—"} | ${f.dig || "—"} | ${f.note || ""} | ${w.days != null ? w.days + " days" : w.why} |`);
  }
  const text = lines.join("\n") + "\n";
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

async function main() {
  if (!process.argv.includes("--report")) {
    if (!process.env.TMDB_API_KEY) { console.error("TMDB_API_KEY is not set"); process.exit(1); }
    const budget = Number(process.env.DIGITAL_BUDGET || 8000);
    const r = await runDigitalBackfill({ api: { tmdb, pause: sleep }, today, budget });
    console.log(`digital release dates: ${r.discovered} discovered, ${r.read} read (${r.dated} dated), ${r.left} left, ${r.calls} calls, ${r.errors} errors`);
  }
  let store;
  try { store = JSON.parse(fs.readFileSync(DIGITAL_FILE, "utf8")); } catch { console.log("no data yet"); return; }
  report(store);
}

main().catch((e) => { console.error(e); process.exit(1); });
