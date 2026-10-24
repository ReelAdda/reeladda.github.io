// ============================================================================
// honest.js — say what we know about a streaming date, not what we can't know (Oct 2026).
//
// Pages of films that aren't streaming yet said "Its OTT release date hasn't been announced",
// "No platform has announced…", "Not Announced Yet". FilmyChill can't know that: it knows what
// its sources (TMDB, JustWatch) say. Meesaya Murukku 2's SonyLIV date was in the news on 17 Oct
// 2026; the page kept saying "hasn't been announced" for a week, past the day it started
// streaming. Each claim becomes one about our sources ("No OTT release date in our sources
// yet"), and titles say "Awaiting Date".
//
// How: the page writers and the archive/sweep chain keep producing and matching the original
// wording (they rewrite it over a page's life — "in theatres" -> "finished its theatrical run"
// — and must keep working). This pass runs after the last writer, like analytics and the logo,
// on film pages in the rollout (lib/rollout.js, feature HONEST_FEATURE): honestWording() on
// films in the share, plainWording() — its exact inverse — on the rest, so the share can grow
// or go back to 0 and every page follows. lib/writeif.js compares pages through honestWording,
// so a fresh render in the original wording isn't mistaken for a change.
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { inRollout } = require("./rollout.js");

const HONEST_FEATURE = "honest-not-announced";
const A = "(?:'|&#39;)";
const ap = (m) => (m.includes("&#39;") ? "&#39;" : "'");
const art = (kind) => (/^OTT/.test(kind) ? "An" : "A");

// [original -> honest] rules, each with its exact inverse. Order matters only within a direction.
const RULES = [
  // FAQ "When is X releasing on OTT?"
  { fwd: [new RegExp(`\\bAn? (OTT|streaming|Streaming) release date for ([^<"]*?) hasn${A}t been officially announced yet\\.`, "g"),
    (m, k, t) => `We haven${ap(m)}t found an announced ${k === "Streaming" ? "streaming" : k} release date for ${t} yet.`],
    rev: [new RegExp(`\\bWe haven${A}t found an announced (OTT|streaming) release date for ([^<"]*?) yet\\.`, "g"),
      (m, k, t) => `${art(k)} ${k} release date for ${t} hasn${ap(m)}t been officially announced yet.`] },
  // Top answer box: "Its OTT release date hasn't been announced — this page updates…"
  { fwd: [new RegExp(`\\bIts (OTT|streaming) release date hasn${A}t been announced —`, "g"), (m, k) => `No ${k} release date in our sources yet —`],
    rev: [/\bNo (OTT|streaming) release date in our sources yet —/g, (m, k) => `Its ${k} release date hasn't been announced —`] },
  // Archive/cinema-run line: "Its OTT release hasn't been announced yet — check back soon."
  { fwd: [new RegExp(`\\bIts (OTT|streaming) release hasn${A}t been announced yet —`, "g"), (m, k) => `We haven${ap(m)}t seen an announced ${k} release date yet —`],
    rev: [new RegExp(`\\bWe haven${A}t seen an announced (OTT|streaming) release date yet —`, "g"), (m, k) => `Its ${k} release hasn${ap(m)}t been announced yet —`] },
  // FAQ "Where can I watch X?" while in cinemas: "An OTT release hasn't been announced yet."
  { fwd: [new RegExp(`\\bAn? (OTT|streaming) release hasn${A}t been announced yet\\.`, "g"), (m, k) => `We haven${ap(m)}t seen an announced ${k} release date yet.`],
    rev: [new RegExp(`\\bWe haven${A}t seen an announced (OTT|streaming) release date yet\\.`, "g"), (m, k) => `${art(k)} ${k} release hasn${ap(m)}t been announced yet.`] },
  // Cinema-run notice: "An OTT release date hasn't been announced yet."
  { fwd: [new RegExp(`\\bAn? (OTT|streaming) release date hasn${A}t been announced yet\\.`, "g"), (m, k) => `No ${k} release date in our sources yet.`],
    rev: [/\bNo (OTT|streaming) release date in our sources yet\./g, (m, k) => `${art(k)} ${k} release date hasn't been announced yet.`] },
  // Waiting box: "No platform has announced an OTT release date."
  { fwd: [/\bNo platform has announced an? (OTT|streaming) release date\./g, (m, k) => `We haven't seen an announced ${k} release date from any platform.`],
    rev: [new RegExp(`\\bWe haven${A}t seen an announced (OTT|streaming) release date from any platform\\.`, "g"), (m, k) => `No platform has announced ${art(k).toLowerCase()} ${k} release date.`] },
  { fwd: [/\bno platform has announced one\./g, () => "we haven't seen one announced."],
    rev: [new RegExp(`\\bwe haven${A}t seen one announced\\.`, "g"), () => "no platform has announced one."] },
  // Descriptions: "Not announced yet." / "X: not announced yet;" / "Not announced yet —"
  { fwd: [/\b([Nn])ot announced yet(?=[ .;])/g, (m, n) => `${n === "N" ? "No" : "no"} date in our sources yet`],
    rev: [/\b([Nn])o date in our sources yet(?=[ .;])/g, (m, n) => `${n}ot announced yet`] },
  // Descriptions past the usual window
  { fwd: [/\bno date has been announced\./g, () => "no date has appeared in our sources."],
    rev: [/\bno date has appeared in our sources\./g, () => "no date has been announced."] },
  { fwd: [/— no date announced\./g, () => "— no date in our sources."],
    rev: [/— no date in our sources\./g, () => "— no date announced."] },
  // Titles (<title>, og:title, twitter:title)
  { fwd: [/(OTT Release Date|Streaming Date): Not Announced Yet\b/g, (m, k) => `${k}: Awaiting Date`],
    rev: [/(OTT Release Date|Streaming Date): Awaiting Date\b(?! in)/g, (m, k) => `${k}: Not Announced Yet`] },
  { fwd: [/(Streaming Date in [^<"]+?): Not Announced\b(?! Yet)/g, (m, k) => `${k}: Awaiting Date`],
    rev: [/(Streaming Date in [^<"]+?): Awaiting Date\b/g, (m, k) => `${k}: Not Announced`] },
];

// Pure: the honest wording. Idempotent.
function honestWording(html) {
  let s = String(html);
  for (const r of RULES) s = s.replace(r.fwd[0], r.fwd[1]);
  return s;
}
// Pure: back to the original wording (for films outside the rollout). Idempotent.
function plainWording(html) {
  let s = String(html);
  for (const r of [...RULES].reverse()) s = s.replace(r.rev[0], r.rev[1]);
  return s;
}

// The pass over film pages, after the last page writer.
function applyHonestWording(files, { root = ".", included = (slug) => inRollout(HONEST_FEATURE, slug) } = {}) {
  const res = { pages: 0, honest: 0, changed: 0 };
  for (const rel of files) {
    const r = String(rel).replace(/\\/g, "/");
    const m = /(?:^|\/)movie\/([^/]+)\.html$/.exec(r);
    if (!m) continue;
    const file = path.join(root, rel);
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    res.pages++;
    const on = included(m[1]);
    const next = on ? honestWording(html) : plainWording(html);
    if (on && next !== plainWording(next)) res.honest++;
    if (next !== html) { fs.writeFileSync(file, next); res.changed++; }
  }
  return res;
}

module.exports = { HONEST_FEATURE, applyHonestWording, honestWording, plainWording };
