// ============================================================================
// scoresweep.js — puts the FilmyChill Score on film pages that are never rebuilt.
//
// Only pages on this week's lists are regenerated each run. Frozen pages (films that left the
// lists) and back-catalogue pages are written once and then only patched, so the score — added
// in Sept 2026 — was missing from ~8,500 of them (and read "Too early" on catalogue pages built
// before the fix, even for films with thousands of ratings).
//
// Each run takes a small budget of those pages (never-scored first, then the stalest), asks
// TMDB for the current rating (one call each), adds the critics tone from the takes cache, and
// writes the same score section the weekly pages use (lib/filmpage.js fcScoreSection) into the
// existing HTML. Nothing else on the page changes. Every page is re-checked every
// RESCORE_DAYS so its score keeps up as ratings arrive.
// ============================================================================
"use strict";

const fs = require("fs");
const { filmPagePath, fmtDateFull, localeFor } = require("./core.js");
const { fcScore } = require("./fcscore.js");
const { FCSB_CSS, fcScoreSection, headRatingHtml } = require("./filmpage.js");
const { cachedCriticsTone } = require("./editorial.js");
const { sleep, tmdb } = require("./tmdb.js");

const SCORE_SWEEP_BATCH = Math.max(0, Number(process.env.SCORE_SWEEP_BATCH || 300)); // ~9,000 pages ≈ 15 days
const RESCORE_DAYS = 30;
// Bumped when the no-score wording changes: pages swept under an older wording with no score
// are redone at once rather than waiting 30 days. 2 = "Too early" only for recent releases.
const SWEEP_WORDING = 3; // 3 = early reads: older films with 15–49 ratings now get a score

// Pure: put (or replace) the score section in an existing film page. Returns the new HTML.
function injectScoreSection(html, section) {
  let out = html;
  // Replace an existing section (and its note) wholesale.
  const re = /<section class="fcsb" id="filmychill-score">[\s\S]*?<\/section>\s*<p class="fcsb-note">[\s\S]*?<\/p>/;
  if (re.test(out)) out = out.replace(re, section.trim());
  else {
    // New: same place as on weekly pages — right before the lead answer line; older pages that
    // predate the answer line get it before their first section heading.
    const a = out.indexOf('<p class="answer"');
    const h = out.indexOf("<h2", out.indexOf('<div class="head"') >= 0 ? out.indexOf('<div class="head"') : 0);
    const at = a >= 0 ? a : h;
    if (at < 0) return html; // no safe anchor: leave the page alone
    out = out.slice(0, at) + section.trim() + "\n  " + out.slice(at);
  }
  // Styles: add them, or bring an earlier copy up to date (new rules, e.g. the early-read label).
  const cssRe = /  \/\* FilmyChill Score \(lib\/fcscore\.js\) \*\/[\s\S]*?\.fcsb-note \{[^\n]*\}(\n  \.fcsb-conf \{[^\n]*\})?/;
  if (cssRe.test(out)) out = out.replace(cssRe, FCSB_CSS);
  else if (!out.includes(".fcsb {")) {
    const st = out.indexOf("</style>");
    if (st < 0) return html;
    out = out.slice(0, st) + FCSB_CSS + "\n" + out.slice(st);
  }
  return out;
}

// Pure: bring the page header in line with the score — today's audience rating in the same
// confidence-tiered format weekly pages use, and no separate audience "▸ verdict" pill (the
// score is the page's one verdict). Only the header is touched; pages without a rating line
// in the header (very early formats) keep their header as it is.
function refreshHead(html, item) {
  const h0 = html.indexOf('<div class="head"');
  if (h0 < 0) return html;
  let h1 = html.indexOf('id="filmychill-score"', h0);
  if (h1 < 0) h1 = html.indexOf("<h2", h0);
  if (h1 < 0) return html;
  let head = html.slice(h0, h1);
  if (html.includes(".cbar")) {
    head = head.replace(/<div class="rating[^"]*">[\s\S]*?<\/div>/, headRatingHtml(item));
  } else if (item.rating != null && item.votes) {
    // The oldest pages ("★ 7.4 (535 votes)") have no styles for the tiered format: update the
    // numbers in place instead.
    head = head.replace(/(<div class="rating">★ )[\d.]+(\s*<span[^>]*>\()[\d,]+( votes\))/,
      (m, a, b, c) => `${a}${Number(item.rating).toFixed(1)}${b}${Number(item.votes).toLocaleString("en-IN")}${c}`);
  }
  head = head.replace(/\s*<div class="verdict">[^<]*<\/div>/, "");
  return html.slice(0, h0) + head + html.slice(h1);
}

// Pure: which manifest entries to (re)score this run.
function sweepCandidates(pagesManifest, today, limit) {
  const stale = new Date(Date.parse(today) - RESCORE_DAYS * 864e5).toISOString().slice(0, 10);
  const all = [];
  for (const [code, m] of Object.entries(pagesManifest || {})) {
    for (const [slug, e] of Object.entries(m || {})) {
      if (!e || !e.tmdbId || !(e.catalog || e.archivedOn)) continue; // weekly pages rebuild themselves
      const at = e.fcs && e.fcs.at;
      const outdated = e.fcs && e.fcs.v === "early" && (e.fcs.w || 1) < SWEEP_WORDING;
      if (at && at > stale && !outdated) continue;
      all.push({ code, slug, e, at: outdated ? "" : at || "" });
    }
  }
  all.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1)); // never-scored ("") first
  return all.slice(0, limit);
}

async function sweepScores(pagesManifest, { today, batch = SCORE_SWEEP_BATCH, api = { tmdb, pause: sleep } } = {}) {
  const res = { checked: 0, updated: 0, errors: 0 };
  for (const { code, slug, e } of sweepCandidates(pagesManifest, today, batch)) {
    const file = filmPagePath(code, slug).replace(/^\//, "");
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    let d;
    try {
      const kind = e.kind === "tv" ? "tv" : "movie";
      d = await api.tmdb(`/${kind}/${e.tmdbId}`, { append_to_response: "external_ids" });
      await api.pause(120);
    } catch (err) {
      res.errors++;
      if (res.errors >= 5) break; // TMDB trouble: stop, retry next run
      continue;
    }
    res.checked++;
    const votes = d.vote_count || 0;
    const item = {
      rating: d.vote_average > 0 ? Number(Number(d.vote_average).toFixed(1)) : null,
      votes,
      // For the no-score wording: "Too early" only if it's actually just out.
      released: e.released || d.release_date || d.first_air_date || null,
      criticsTone: cachedCriticsTone((d.external_ids && d.external_ids.imdb_id) || d.imdb_id || null),
    };
    const s = fcScore(item);
    if (s) item.fcScore = s;
    let next = refreshHead(injectScoreSection(html, fcScoreSection(item)), item);
    // The page changed, so its "Page updated" line should say so.
    if (next !== html) next = next.replace(/(>Page updated )[^<]+/, (m, a) => `${a}${fmtDateFull(today, localeFor(code))}`);
    e.fcs = { v: s ? s.verdict : "early", at: today, w: SWEEP_WORDING };
    if (next !== html) {
      fs.writeFileSync(file, next);
      e.last = today; // the page changed: let the sitemap say so
      res.updated++;
    }
  }
  return res;
}

module.exports = {
  RESCORE_DAYS,
  SCORE_SWEEP_BATCH,
  injectScoreSection,
  refreshHead,
  sweepCandidates,
  sweepScores,
};
