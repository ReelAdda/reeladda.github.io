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
const { escHtml } = require("./core.js");
const { buildVerdictProse } = require("./filmcopy.js");
const { isRecent } = require("./fcscore.js");
const { COUNT_REASONS } = require("./skipif.js");
const { sleep, tmdb } = require("./tmdb.js");

// 1,500 a run clears the ~8,000-page backlog in about three runs; after that each run only has
// the 30-day re-checks (~300 a day), so the cap rarely binds.
const SCORE_SWEEP_BATCH = Math.max(0, Number(process.env.SCORE_SWEEP_BATCH || 1500));
const RESCORE_DAYS = 30;
// Bumped when the no-score wording changes: pages swept under an older wording with no score
// are redone at once rather than waiting 30 days. 2 = "Too early" only for recent releases.
// 3 = early reads; 4 = header rating shown with one decimal like the score box, and every
// page swept under an older version is redone (not only the unscored ones).
// 5 = one wording rule everywhere (time words only for new films; header tier, prose and the
// "worth watching?" answer all rewritten to match the score).
const SWEEP_WORDING = 5;

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
  } else if (item.rating == null || Number(item.votes || 0) < 10) {
    // Too few ratings for the site to show a number at all (MIN_VOTES): the header says so,
    // in the same words weekly pages use — never a bare "★ 6.4 (4 votes)".
    const n = Number(item.votes || 0);
    const text = isRecent(item) ? "Rating still forming — too few ratings yet"
      : n > 0 ? `Too few ratings to rate — only ${n.toLocaleString("en-IN")}` : "Not rated on TMDB";
    head = head.replace(/<div class="rating">[\s\S]*?<\/div>/, `<div class="rating">${escHtml(text)}</div>`);
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

// Pure: bring the page's words in line with the score, for a film that ISN'T new (a new film's
// time words — "just landed", "too early" — are true, so its copy is left alone):
//   - the "What the audience says" paragraph is rewritten from today's rating and count;
//   - the "Is it worth watching?" answer (visible and in the FAQ schema) opens with today's
//     FilmyChill Score — or, with no score, says plainly there aren't enough ratings.
// Only openings this site itself wrote are replaced; anything unrecognised is left as it is.
const FAQ_LEADS = [
  /^It's too early for a verdict — .+? doesn't have enough ratings yet\./,
  /^There aren't enough ratings for a verdict on .+?\./,
  /^FilmyChill Score: [^.]*\.(?: It rates \d+(?:\.\d)?\/10 on audience ratings\.)?/,
  /^(?:Must watch|Worth a watch|Decent one-time watch|Skip unless curious)\.(?: It rates \d+(?:\.\d)?\/10 on audience ratings\.)?/,
];
function faqLead(item, s) {
  if (!s) return isRecent(item) ? null : `There aren't enough ratings for a verdict on ${item.title}.`; // new + unscored: "too early" is true
  const reason = s.reason.replace(/\.$/, "");
  const few = s.early ? ` (based on only ${Number(s.votes).toLocaleString("en-IN")} ratings)` : "";
  const rates = item.rating != null ? ` It rates ${Number(item.rating).toFixed(1)}/10 on audience ratings.` : "";
  return `FilmyChill Score: ${s.verdict} — ${reason}${few}.${rates}`;
}
function relead(text, lead) {
  if (lead == null) return null;
  for (const re of FAQ_LEADS) if (re.test(text)) return text.replace(re, lead);
  return null;
}
const unesc = (t) => t.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// The four time-worded "Don't watch this if…" lines (lib/skipif.js), as they appear on a page.
const SKIP_TIME_LINES = [
  /you want a safe bet — that rating is resting on [\d,]+ votes so far/,
  /you&#39;d rather wait for a consensus\. Only [\d,]+ ratings in so far/,
  /you take the score at face value — it&#39;s early, and [\d,]+ votes can still move it/,
  /you want a number you can lean on\. This one is still settling/,
];
function refreshCopy(html, item, s) {
  if (!item.title) return html;
  const recent = isRecent(item);
  let out = html;
  if (!recent) {
    // "Don't watch this if…": swap a time-worded thin-rating line for its count-worded twin —
    // or drop it once the film has 100+ ratings, when the worry no longer applies.
    const votes = Number(item.votes || 0);
    SKIP_TIME_LINES.forEach((re, i) => {
      out = out.replace(new RegExp(`<li>${re.source}</li>`), votes >= 100 || !votes ? "" : `<li>${escHtml(COUNT_REASONS(votes)[i])}</li>`);
    });
    // Fewer than two reasons left: the block no longer earns its place (skipif.js MIN_REASONS).
    out = out.replace(/<div class="skipif"><h3>[^<]*<\/h3><ul>((?:<li>[^<]*<\/li>)?)<\/ul><\/div>/, "");
  }
  const prose = buildVerdictProse({ title: item.title, tmdbId: item.tmdbId, kind: item.kind, language: item.language,
    rating: item.rating, votes: item.votes, released: item.released });
  if (prose) {
    out = out.replace(/<h2>(?:The verdict|What the audience says)<\/h2><p class="vprose">[\s\S]*?<\/p>/,
      `<h2>What the audience says</h2><p class="vprose">${escHtml(prose)}</p>`);
  }
  const lead = faqLead(item, s);
  // Visible FAQ
  out = out.replace(/(<summary>Is [^<]*? worth watching\?<\/summary><div class="fa">)([^<]*)(<\/div>)/, (m, a, t, b) => {
    const next = relead(unesc(t), lead);
    return next == null ? m : a + escHtml(next) + b;
  });
  // FAQ schema (JSON-LD)
  out = out.replace(/("name":"Is (?:[^"\\]|\\.)*? worth watching\?","acceptedAnswer":\{"@type":"Answer","text":")((?:[^"\\]|\\.)*)(")/, (m, a, t, b) => {
    let plain; try { plain = JSON.parse(`"${t}"`); } catch { return m; }
    const next = relead(plain, lead);
    return next == null ? m : a + JSON.stringify(next).slice(1, -1) + b;
  });
  return out;
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
    Object.assign(item, { title: e.title || d.title || d.name, tmdbId: e.tmdbId, kind: e.kind === "tv" ? "tv" : "movie", language: e.lang || null });
    let next = refreshCopy(refreshHead(injectScoreSection(html, fcScoreSection(item)), item), item, s);
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
  refreshCopy,
  refreshHead,
  resolveTmdbId,
  sweepCandidates,
  sweepScores,
};
