// ============================================================================
// audit.js — the build checks its own output for the mistakes a visitor would notice.
//
// Every one of these reached the live site before (Sept–Oct 2026) and was spotted by a
// person, not the system: a film in cinemas listed under Streaming Now (Drishyam), "Too
// early" on a July release (Ikka), a Spanish film recommending Tamil films, a header rating
// disagreeing with its own score box. The fixes are in; this makes sure the NEXT one shows
// up in the run summary first. It only reads and reports — it never changes a page.
//
// Runs at the end of the build, over this run's data and every film page on disk.
// ============================================================================
"use strict";

const fs = require("fs");
const { filmPagePath } = require("./core.js");
const { filmIndexFor, isClose, relatedFilms } = require("./graph.js");

const DAY = 864e5;
const daysSince = (iso, now) => (iso ? (now - Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`)) / DAY : null);

// Pure checks over one market's data. Each finding: { check, url, detail }.
function auditData(code, data, now = Date.now()) {
  const out = [];
  if (!data) return out;
  const all = [...(data.theatres || []), ...(data.ott || [])];
  // Pick of the Week should be genuinely new (choosePick falls back to an older title only
  // when nothing new is scored — worth knowing when that happens).
  if (data.pick) {
    const p = all.find((x) => x.title === data.pick);
    const age = p ? daysSince(p.freshDate || p.released, now) : null;
    if (p && age != null && age > 21) out.push({ check: "pick-not-new", url: code, detail: `${p.title} (${Math.round(age)} days old)` });
  }
  // A cinema release listed as streaming within two weeks of opening: possibly a platform's
  // placeholder page that slipped past isPreListed.
  for (const x of data.ott || []) {
    if (x.kind !== "movie" || !x.theatricalHere || !(x.providers || []).length) continue;
    const age = daysSince(x.released, now);
    if (age != null && age >= 0 && age < 14) out.push({ check: "streaming-right-after-cinema", url: code, detail: `${x.title}: in cinemas ${x.released}, listed on ${x.providers[0]}` });
  }
  return out;
}

// Pure checks over one rendered film page. `released` from the manifest when known.
function auditPage(html, { released = null, now = Date.now() } = {}) {
  const out = [];
  if (!/id="filmychill-score"/.test(html)) return out; // pages not yet swept are counted elsewhere
  const rel = released || (/"datePublished":"(\d{4}-\d{2}-\d{2})/.exec(html) || [])[1] || null;
  const age = daysSince(rel, now);
  // Series are dated by their LATEST season (a 2026 season of Scrubs is new), but the page's
  // release date is the show's first air date — so age-based wording can't be judged here.
  const isSeries = /"@type":"TVSeries"/.test(html);
  if (!isSeries && age != null && age > 28) {
    if (/class="fcsb-(?:stamp[^"]*|mini-v)">Too early</.test(html)) out.push({ check: "too-early-on-old-film", detail: `released ${rel}` });
    const head = html.slice(html.indexOf('<div class="head"'), html.indexOf('id="filmychill-score"'));
    if (/Early — still settling|Rating still forming/.test(head)) out.push({ check: "time-words-on-old-film", detail: `released ${rel}` });
  }
  const head = html.slice(html.indexOf('<div class="head"'), html.indexOf('id="filmychill-score"'));
  const h = /★ ([\d.]+)/.exec(head);
  const b = /<b>Audience<\/b><small>★ ([\d.]+) from/.exec(html);
  if (h && b && Number(h[1]).toFixed(1) !== Number(b[1]).toFixed(1)) out.push({ check: "header-vs-score-rating", detail: `header ${h[1]} vs score ${b[1]}` });
  const stamp = /class="fcsb-stamp[^"]*">(Must watch|Worth a watch|Skip)</.exec(html);
  const faq = /worth watching\?<\/summary><div class="fa">FilmyChill Score: (Must watch|Worth a watch|Skip)/.exec(html);
  if (stamp && faq && stamp[1] !== faq[1]) out.push({ check: "faq-vs-score-verdict", detail: `score ${stamp[1]}, FAQ ${faq[1]}` });
  return out;
}

function runAudit({ dataByCode = {}, pagesManifest = {}, countries = [], now = Date.now(), note = () => {} } = {}) {
  const findings = [];
  for (const cfg of countries) {
    findings.push(...auditData(cfg.code, dataByCode[cfg.code], now));
    const m = pagesManifest[cfg.code] || {};
    let index = null, bySlug = null;
    for (const [slug, e] of Object.entries(m)) {
      const url = filmPagePath(cfg.code, slug);
      let html;
      try { html = fs.readFileSync(url.replace(/^\//, ""), "utf8"); } catch { continue; }
      for (const f of auditPage(html, { released: e && e.released, now })) findings.push({ ...f, url });
      // Recommendations: a distant-language pick is only a fault when better ones exist.
      const sec = /<h2>If you liked this<\/h2><div class="simgrid">([\s\S]*?)<\/div>(?=\s*(?:<h2>|<a class="btn"))/.exec(html);
      if (!sec) continue;
      const linked = [...sec[1].matchAll(/href="[^"]*\/movie\/([^"]+)\.html"/g)].map((x) => x[1]);
      if (!linked.length) continue;
      if (!index) { index = filmIndexFor(cfg); bySlug = new Map(index.map((f) => [f.slug, f])); }
      const seed = bySlug.get(slug);
      if (!seed) continue;
      const far = linked.map((s) => bySlug.get(s)).filter((c) => c && !isClose(seed, c));
      if (!far.length) continue;
      const closeAvailable = relatedFilms(seed, index, 6).filter((c) => isClose(seed, c)).length;
      if (closeAvailable >= 3) findings.push({ check: "distant-recommendations", url, detail: `${far[0].title} (${far[0].language}) on a ${seed.language} film` });
    }
  }
  const LABEL = {
    "pick-not-new": "Pick of the Week isn't a new release",
    "streaming-right-after-cinema": "listed as streaming within 2 weeks of a cinema release — check it's not a placeholder",
    "too-early-on-old-film": "film page(s) say \"Too early\" for a film out over 4 weeks",
    "time-words-on-old-film": "film page header(s) use \"early / still forming\" for an older film",
    "header-vs-score-rating": "film page(s) where the header rating and the score box disagree",
    "faq-vs-score-verdict": "film page(s) where the FAQ verdict and the score box disagree",
    "distant-recommendations": "film page(s) recommending a distant language while closer matches exist",
  };
  const byCheck = {};
  for (const f of findings) (byCheck[f.check] = byCheck[f.check] || []).push(f);
  for (const [check, list] of Object.entries(byCheck)) {
    const eg = list.slice(0, 3).map((f) => `${f.url}${f.detail ? ` (${f.detail})` : ""}`).join("; ");
    note(`audit: ${list.length} ${LABEL[check] || check} — e.g. ${eg}`);
  }
  if (!findings.length) note("audit: no contradictions found");
  return { findings, byCheck };
}

module.exports = { auditData, auditPage, runAudit };
