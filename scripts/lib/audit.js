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
const { isoFromShown } = require("./facts.js");
const { NOT_YET_TITLE } = require("./archive.js");
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

// Oct 2026 data-integrity audit: every finding there is checked here on every build, so a
// regression shows in the run summary instead of waiting for the next audit. Pure.
// One date parser and one not-yet title pattern for the whole build (lib/facts.js, lib/archive.js).
const shownDate = isoFromShown;
function auditIntegrity(html, { entry = null, now = Date.now() } = {}) {
  const out = [];
  const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1] || "";
  const desc = (/<meta name="description" content="([^"]*)"/.exec(html) || [])[1] || "";
  const answer = ((/<p class="answer">([\s\S]*?)<\/p>/.exec(html) || [])[1] || "").replace(/<[^>]+>/g, "");
  const streaming = /<!--SW:stream-->/.test(html) || / is streaming in /.test(answer);
  const notYet = NOT_YET_TITLE.test(title);
  if (notYet && streaming) out.push({ check: "title-not-streaming-page-streaming", detail: title.slice(0, 70) });
  if (notYet && !streaming && /where to watch(?: it)? in /.test(desc) && !/ is streaming in /.test(desc)) out.push({ check: "title-vs-description", detail: title.slice(0, 70) });
  if (/ is streaming in /.test(desc) && !streaming) out.push({ check: "description-streaming-page-not", detail: desc.slice(0, 70) });
  const ld = /"@type":"(Movie|TVSeries)"[\s\S]*?"inLanguage":"([^"]*)"/.exec(html);
  if (ld && /^[a-z]{2,3}$/.test(ld[2])) out.push({ check: "raw-language-code", detail: `"${ld[2]}"` });
  if (entry && ld) {
    const kind = ld[1] === "TVSeries" ? "tv" : "movie";
    if ((entry.kind === "tv" ? "tv" : "movie") !== kind || (entry.lang && !/^[a-z]{2,3}$/.test(ld[2]) && entry.lang !== ld[2] && !/^[a-z]{2,3}$/.test(entry.lang)))
      out.push({ check: "page-is-another-film", detail: `page ${kind} ${ld[2]}, manifest ${entry.kind || "movie"} ${entry.lang} (id ${entry.tmdbId})` });
  }
  const head = html.slice(Math.max(0, html.indexOf('<div class="head"')), Math.max(0, html.indexOf('id="filmychill-score"')));
  if (/Few ratings/.test(head) && /class="fcsb-stamp[^"]*">(?:Must watch|Worth a watch|Skip)</.test(html) && !/class="fcsb-conf"/.test(html))
    out.push({ check: "few-ratings-beside-full-verdict", detail: ((/([\d,]+) ratings/.exec(head) || [])[0]) || "" });
  const mod = (/"dateModified":"(\d{4}-\d{2}-\d{2})/.exec(html) || [])[1];
  if (entry && entry.last && mod && daysSince(mod, Date.parse(`${entry.last}T00:00:00Z`)) > 1)
    out.push({ check: "page-updated-behind-lastmod", detail: `page ${mod}, sitemap ${entry.last}` });
  if (/<!--SW:pending-->/.test(html) && !/the last time we could check/.test(html)) {
    const rel = (/"datePublished":"(\d{4}-\d{2}-\d{2})/.exec(html) || [])[1];
    const av = shownDate((/Availability as of ([^<]+)/.exec(html) || [])[1]);
    const age = daysSince(rel, now);
    if (av && age != null && age >= 0 && age <= 120 && daysSince(av, now) > 14) out.push({ check: "waiting-not-rechecked", detail: `as of ${av}, released ${rel}` });
  }
  return out;
}

// Pure, over the whole manifest: identity problems no single page shows.
function auditManifest(pagesManifest) {
  const out = [];
  const byFilm = new Map();
  for (const [code, m] of Object.entries(pagesManifest || {})) {
    const perEdition = new Map();
    for (const [slug, e] of Object.entries(m || {})) {
      if (!e || !e.tmdbId) continue;
      const k = `${e.kind === "tv" ? "tv" : "movie"}:${e.tmdbId}`;
      if (perEdition.has(k)) out.push({ check: "two-pages-one-film", url: `${code}/${slug}`, detail: `also ${code}/${perEdition.get(k)}` });
      perEdition.set(k, slug);
      if (e.kind !== "tv" && /^\d{4}/.test(String(e.released || ""))) {
        if (!byFilm.has(e.tmdbId)) byFilm.set(e.tmdbId, []);
        byFilm.get(e.tmdbId).push({ code, slug, y: Number(String(e.released).slice(0, 4)) });
      }
    }
  }
  for (const list of byFilm.values()) {
    if (list.length < 2) continue;
    const min = Math.min(...list.map((x) => x.y));
    for (const x of list) if (x.y - min >= 2) out.push({ check: "year-later-than-other-editions", url: `${x.code}/${x.slug}`, detail: `${x.y}, elsewhere ${min}` });
  }
  // One film, two languages across editions: at least one is wrong (The Weight: "Portuguese"
  // on five editions, English on one, Oct 2026). A page agreeing with its own manifest can
  // still be wrong, so only the comparison across editions shows it.
  const langs = new Map();
  for (const [code, m] of Object.entries(pagesManifest || {})) {
    for (const [slug, e] of Object.entries(m || {})) {
      if (!e || !e.tmdbId || !e.lang || /^[a-z]{2,3}$/.test(e.lang)) continue;
      const k = `${e.kind === "tv" ? "tv" : "movie"}:${e.tmdbId}`;
      if (!langs.has(k)) langs.set(k, []);
      langs.get(k).push({ code, slug, lang: e.lang });
    }
  }
  for (const list of langs.values()) {
    const set = [...new Set(list.map((x) => x.lang))];
    if (set.length > 1) out.push({ check: "language-differs-across-editions", url: `${list[0].code}/${list[0].slug}`, detail: set.join(" / ") });
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

// Findings that put something false in front of a visitor: these turn the run red (and email),
// the rest are notes in the run summary.
const FALSE_CLAIMS = new Set(["title-not-streaming-page-streaming", "description-streaming-page-not", "raw-language-code",
  "page-is-another-film", "two-pages-one-film"]);

function runAudit({ dataByCode = {}, pagesManifest = {}, countries = [], now = Date.now(), note = () => {}, issue = null } = {}) {
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
      for (const f of auditIntegrity(html, { entry: e, now })) findings.push({ ...f, url });
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
  findings.push(...auditManifest(pagesManifest));
  const LABEL = {
    "title-not-streaming-page-streaming": "film page(s) titled not streaming / not announced while the page says it streams",
    "title-vs-description": "film page(s) titled not announced whose description promises where to watch",
    "description-streaming-page-not": "film page(s) whose description says streaming while the page says not",
    "raw-language-code": "film page(s) showing a language code instead of its name",
    "page-is-another-film": "film page(s) whose manifest entry is a different film (kind or language disagree)",
    "few-ratings-beside-full-verdict": "film page(s) saying \"Few ratings\" beside a full FilmyChill verdict",
    "page-updated-behind-lastmod": "film page(s) whose \"Page updated\" date is behind the sitemap's",
    "waiting-not-rechecked": "waiting film page(s) not rechecked for 14+ days",
    "two-pages-one-film": "edition(s) with two pages for one film",
    "year-later-than-other-editions": "film page(s) dated 2+ years after the same film elsewhere (re-release date?)",
    "language-differs-across-editions": "film(s) with a different language on different editions",
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
    (FALSE_CLAIMS.has(check) && issue ? issue : note)(`audit: ${list.length} ${LABEL[check] || check} — e.g. ${eg}`);
  }
  if (!findings.length) note("audit: no contradictions found");
  return { findings, byCheck };
}

module.exports = { FALSE_CLAIMS, auditData, auditIntegrity, auditManifest, auditPage, runAudit, shownDate };
