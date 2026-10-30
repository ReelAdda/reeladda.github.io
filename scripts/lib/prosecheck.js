"use strict";

// ============================================================================
// prosecheck.js: the plain-wording check (lib/humanprose.js) in one place (30 Oct 2026).
//
// Used by the tests (scripts/test.js), the commit check (scripts/prose-check.js, run by
// .githooks/pre-commit) and the Claude Code hook (~/.claude/skills/human-prose/hook.js). It draws
// every page state with every live rollout on, sends each page through the build's own last
// passes (honest wording, lean trim, plain wording), and scans what a reader would read, plus the
// hand-written pages in the repo. Any hit is a sentence a template or page would publish.
// ============================================================================
const fs = require("fs");
const path = require("path");
const R = require("./rollout.js");
const HP = require("./humanprose.js");
const H = require("./honest.js");

const ALL_ON = { features: Object.fromEntries(["lean-page", "redesign-v2", "page-v3", "wiki-reception", "google-hide", "tidy-names",
  "page-fixes-30oct", "visible-similar", "one-score", "intent-titles", "honest-not-announced", HP.HUMAN_PROSE].map((f) => [f, { percent: 100 }])) };
const day = (o) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);

// One film in each state a page can be in. Neutral titles and synopses: the check is about the
// site's own sentences, and third-party text is left out of the scan anyway.
function films() {
  const base = { language: "Tamil", genre: "Drama/Thriller", runtime: 133, tmdbId: 501, cast: ["A", "B"], fullReview: "A family keeps a secret.", trailer: "https://www.youtube.com/watch?v=abcdefghijk" };
  return {
    streaming: { ...base, title: "Kaathal", slug: "hp-stream", kind: "movie", released: day(-200), providers: ["Netflix"], rentBuy: [], rating: 8.1, votes: 6200, cert: "A",
      arrived: day(-150), arrivedOn: "Netflix", take: "Critics liked it, especially the performances.",
      fcScore: { verdict: "Must watch", reason: "Audiences and critics agree.", audience: "Loved", critics: "positive", basis: "both" },
      reception: { rt: { pct: 91, n: 87 }, ratings: { n: 6, median: 4 }, asOf: day(-1), article: "Kaathal" } },
    series: { ...base, title: "Show", slug: "hp-series", kind: "tv", runtime: null, released: day(-30), providers: ["JioHotstar"], rentBuy: [], rating: 8.6, votes: 220, cert: "U", seasons: 3,
      episodes: { count: 4, seasons: 1, limited: true, list: [{ e: 1, name: "One", date: day(-30), runtime: 50 }, { e: 2, name: "Two", date: day(-23), runtime: 52 }, { e: 3, name: "Three", date: day(4) }, { e: 4, name: "Four", date: day(11) }], next: { e: 3, s: 1, date: day(4), name: "Three" } },
      fcScore: { verdict: "Worth a watch", reason: "Audiences like it.", audience: "Liked", critics: null, basis: "audience" } },
    rent: { ...base, title: "Rented", slug: "hp-rent", kind: "movie", released: day(-400), providers: [], rentBuy: ["Apple TV"], rating: 6.4, votes: 900, cert: "UA 13+",
      fcScore: { verdict: "Worth a watch", reason: "Audiences like it.", audience: "Liked", critics: null, basis: "audience" } },
    unrated: { ...base, title: "Fresh", slug: "hp-fresh", kind: "movie", released: day(-3), providers: ["ZEE5"], rentBuy: [], rating: null, votes: 3 },
    upcoming: { ...base, title: "Soon", slug: "hp-soon", kind: "movie", released: day(9), providers: [], rentBuy: [], platform: "Theatres", votes: 0 },
    theatres: { ...base, title: "Running", slug: "hp-running", kind: "movie", released: day(-12), providers: [], rentBuy: [], platform: "Theatres", rating: 7.2, votes: 140 },
    theatresEnded: { ...base, title: "Ended", slug: "hp-ended", kind: "movie", released: day(-50), providers: [], rentBuy: [], platform: "Theatres", rating: 7.0, votes: 160 },
    lapsed: { ...base, title: "Old One", slug: "hp-lapsed", kind: "movie", released: day(-300), providers: [], rentBuy: [], platform: "Theatres", rating: 6.0, votes: 80 },
    noEstimate: { ...base, language: "Klingon", title: "Rare", slug: "hp-rare", kind: "movie", released: day(-20), providers: [], rentBuy: [], platform: null, rating: 6.5, votes: 40 },
    generic: { ...base, title: "Unknown", slug: "hp-generic", kind: "movie", released: day(-900), providers: [], rentBuy: [], platform: null, rating: 7.0, votes: 300 },
    gone: { ...base, title: "Gone Film", slug: "hp-gone", kind: "movie", released: day(-500), providers: [], rentBuy: [], state: "gone", wasOn: ["Netflix"], goneAt: day(-2), rating: 7.4, votes: 2000,
      fcScore: { verdict: "Worth a watch", reason: "Audiences like it.", audience: "Liked", critics: null, basis: "audience" } },
  };
}

// What a page goes through after its writers, in the build's order (scripts/update.js).
const finish = (html) => HP.humanWording(H.leanTrim(H.honestWording(html)));

// Every page shape the site draws, rendered with every rollout on. [name, html] pairs.
function renderedPages() {
  const IN = require("./core.js").COUNTRIES[0];
  const Fp = require("./filmpage.js"), M = require("./migrate.js");
  const out = [];
  for (const [name, it] of Object.entries(films())) {
    if (it.state !== "gone") out.push([`film page, ${name} (this week's lists)`, finish(Fp.buildFilmPage(it, day(0), new Set(), IN))]);
    out.push([`film page, ${name} (drawn from its facts)`, finish(M.renderFrozen(it, IN, { asOf: day(0), knownSlugs: new Set() }))]);
  }
  const A_IN = { code: "in", name: "India", region: "IN", watchRegion: "IN" };
  const EG = require("./evergreen.js"), HB = require("./hubs.js"), D = require("./dated.js"), W = require("./weekly.js");
  const items = Array.from({ length: 6 }, (_, i) => ({ slug: "s" + i, title: "Title " + i, language: "Tamil", kind: i % 2 ? "tv" : "movie", rating: 6 + i / 2, votes: 100 + i, providers: ["Netflix"] }));
  out.push(["platform list", EG.buildStreamingPage(items, A_IN, { platform: "Netflix", pslug: "netflix" })]);
  const hub = { name: "JioHotstar", slug: "jiohotstar", items: Array.from({ length: 4 }, (_, i) => ({ title: "T" + i, slug: "t" + i, platform: "JioHotstar", kind: "movie" })) };
  out.push(["platform hub", HB.buildPlatformHubPage({ generatedAt: new Date().toISOString() }, A_IN, hub)]);
  const ago = (o) => new Date(Date.now() - o * 864e5).toISOString().slice(0, 10);
  const recs = [{ c: "in", k: "movie", t: "Today Film", p: "ZEE5", first: ago(0), rel: "2026-08-01", lang: "Tamil" }, { c: "in", k: "movie", t: "Yesterday Film", p: "Netflix", first: ago(1), rel: "2026-08-01", lang: "Hindi" }];
  out.push(["today", D.buildTodayPage(recs, A_IN)]);
  out.push(["today, quiet", D.buildTodayPage(recs.slice(1), A_IN)]);
  out.push(["coming to OTT", D.buildComingPage([{ slug: "a", title: "A", date: day(5), platform: "Netflix", kind: "movie" }, { slug: "b", title: "B", date: day(9), kind: "movie" }], A_IN)]);
  const lang = { generatedAt: new Date().toISOString(),
    theatres: [{ title: "Tamil Hit", slug: "tamil-hit", language: "Tamil", platform: "Theatres", rating: 7.8, kind: "movie", released: day(-3) }],
    ott: [{ title: "Tamil Stream", slug: "tamil-stream", language: "Tamil", platform: "Netflix", rating: 8.0, kind: "movie", take: "Critics liked it, especially the performances." }],
    comingSoon: [{ title: "Tamil Soon", slug: "tamil-soon", language: "Tamil", released: day(30), kind: "movie" }] };
  out.push(["language page", D.buildLanguagePage(lang, "Tamil", "tamil")]);
  const week = { generatedAt: new Date().toISOString(), ott: [
    { title: "Alliance", slug: "alliance", platform: "Amazon Prime Video", language: "English", genre: "Reality", rating: 7.2, verdict: "Worth a watch", kind: "tv", freshDate: day(-4), badge: "New show" },
    { title: "Raakh", slug: "raakh", platform: "Netflix", language: "Hindi", genre: "Thriller", rating: 7.5, verdict: "Worth a watch", kind: "movie", freshDate: day(-2) },
    { title: "Older", slug: "older", platform: "Netflix", language: "Hindi", genre: "Drama", rating: 8.0, verdict: "Must watch", kind: "movie", freshDate: day(-30), stillGood: true }] };
  out.push(["weekly page", W.buildOttWeekPage(week, { code: "in", name: "India" }, [{ code: "in", region: "IN" }])]);
  return out;
}

// The hand-written pages in the repo, as files on disk.
const STATIC_PAGES = ["index.html", "about/index.html", "privacy/index.html", "dmca/index.html", "404.html", "offline/index.html", "embed/index.html"];

// Pure-ish: every sign on every page. `root` is the repo; `extra` adds files or folders of built
// pages to scan as they are (a downloaded site, say).
function runCheck({ root = path.join(__dirname, "..", ".."), extra = [] } = {}) {
  const prev = R.rolloutConfig();
  const hits = [];
  let pages = 0;
  const scan = (name, html) => { pages++; for (const h of HP.scanProse(HP.siteProse(html))) hits.push({ page: name, ...h }); };
  try {
    R.useRolloutConfig(ALL_ON);
    for (const [name, html] of renderedPages()) scan(name, html);
  } finally { R.useRolloutConfig(prev); }
  for (const rel of STATIC_PAGES) {
    let html; try { html = fs.readFileSync(path.join(root, rel), "utf8"); } catch { continue; }
    scan(rel, html);
  }
  const walk = (p) => {
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const e of fs.readdirSync(p)) walk(path.join(p, e)); }
    else if (p.endsWith(".html")) scan(path.relative(process.cwd(), p), fs.readFileSync(p, "utf8"));
  };
  extra.forEach(walk);
  return { pages, hits };
}

module.exports = { ALL_ON, STATIC_PAGES, films, finish, renderedPages, runCheck };
