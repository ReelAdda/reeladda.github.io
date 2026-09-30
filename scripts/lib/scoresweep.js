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

// 1,500 a run clears the ~8,000-page backlog in about three runs; after that each run only has
// the 30-day re-checks (~300 a day), so the cap rarely binds.
const SCORE_SWEEP_BATCH = Math.max(0, Number(process.env.SCORE_SWEEP_BATCH || 1500));
const RESCORE_DAYS = 30;
// Bumped when the no-score wording changes: pages swept under an older wording with no score
// are redone at once rather than waiting 30 days. 2 = "Too early" only for recent releases.
// 3 = early reads; 4 = header rating shown with one decimal like the score box, and every
// page swept under an older version is redone (not only the unscored ones).
const SWEEP_WORDING = 4;

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
    // (Some carry a vote count in brackets, the very first ones only the number.)
    head = head.replace(/(<div class="rating">★ )[\d.]+/, (m, a) => `${a}${Number(item.rating).toFixed(1)}`);
    head = head.replace(/(<div class="rating">★ [\d.]+\s*<span[^>]*>\()[\d,]+( votes\))/,
      (m, a, c) => `${a}${Number(item.votes).toLocaleString("en-IN")}${c}`);
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
      if (!e || !(e.catalog || e.archivedOn)) continue; // weekly pages rebuild themselves
      if (!e.tmdbId && e.idLookup === "none") continue;  // tried before: no provable match
      const at = e.fcs && e.fcs.at;
      const outdated = e.fcs && (e.fcs.w || 1) < SWEEP_WORDING;
      if (at && at > stale && !outdated) continue;
      all.push({ code, slug, e, at: outdated ? "" : at || "" });
    }
  }
  all.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1)); // never-scored ("") first
  return all.slice(0, limit);
}

// Pure-ish: identify a page's film on TMDB from its own HTML. Returns { id, kind } or null.
async function resolveTmdbId(html, e, api) {
  const kind = e.kind === "tv" || /"@type":"TVSeries"/.test(html) ? "tv" : "movie";
  const poster = (html.match(/image\.tmdb\.org\/t\/p\/w\d+(\/[A-Za-z0-9_-]+\.(?:jpg|png))/) || [])[1] || null;
  const h1 = (html.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1] || "";
  const title = (e.title || h1.replace(/\s*\((\d{4})\)\s*$/, "")).replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim();
  const year = (h1.match(/\((\d{4})\)\s*$/) || [])[1] || String(e.released || "").slice(0, 4);
  if (!poster || !title) return null;
  const q = { query: title, include_adult: "false" };
  if (/^\d{4}$/.test(year)) q[kind === "tv" ? "first_air_date_year" : "year"] = year;
  const r = await api.tmdb(`/search/${kind}`, q);
  await api.pause(120);
  const hit = (r.results || []).find((x) => x.poster_path === poster);
  return hit ? { id: hit.id, kind } : null;
}

async function sweepScores(pagesManifest, { today, batch = SCORE_SWEEP_BATCH, api = { tmdb, pause: sleep } } = {}) {
  const res = { checked: 0, updated: 0, errors: 0 };
  for (const { code, slug, e } of sweepCandidates(pagesManifest, today, batch)) {
    const file = filmPagePath(code, slug).replace(/^\//, "");
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    // A few old pages were saved without their TMDB id. Find it the way the legacy repair does:
    // title (+ year) search, accepted only when the poster on the page matches exactly.
    if (!e.tmdbId) {
      const found = await resolveTmdbId(html, e, api).catch(() => null);
      if (!found) { e.idLookup = "none"; continue; }
      e.tmdbId = found.id;
      if (!e.kind) e.kind = found.kind;
    }
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
  resolveTmdbId,
  sweepCandidates,
  sweepScores,
};
