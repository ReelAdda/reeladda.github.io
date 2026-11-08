"use strict";

// ============================================================================
// lastweek.js — "Movies released last week" (4 Nov 2026).
//
// Bing showed the site for "movies released last week", "new movies released last week",
// "movies released last month" and their variants (~240 impressions in a short window, at
// position 14–19, no clicks) with no page built for them: the homepage and /new-on-ott/ answer
// "this week", and the weekly snapshots were retired on 26 Oct because one page per week piled
// up as near-duplicates. This is ONE page per edition at a fixed URL, always the previous
// Monday–Sunday: films released in that market's cinemas or straight to streaming, ranked by
// the FilmyChill verdict, which by then has the ratings to say something. Rebuilt every run
// (verdicts settle through the week); the week moves on each Monday. No archive.
//
// Sources: the edition's data file (current lists, with scores and posters) first, then the
// facts store for films the lists no longer carry, with the poster from the page index and the
// verdict from the manifest. Pages Google is told to skip are left out, like every other list.
// Below LAST_WEEK_MIN films the page is removed rather than published thin.
// ============================================================================
const fs = require("fs");
const { writeIfChanged } = require("./writeif.js");
const { fmtDateShort, localeFor } = require("./core.js");
const { fitFirst, listingPageHtml, weekRangeFor } = require("./pagekit.js");
const { countryNameFor, streamVocab } = require("./rules.js");

const LAST_WEEK_MIN = 5;
const lastWeekPath = (code) => (code === "in" ? "released-last-week/index.html" : `${code}/released-last-week/index.html`);
const lastWeekUrl = (code) => (code === "in" ? "https://filmychill.com/released-last-week/" : `https://filmychill.com/${code}/released-last-week/`);

// The previous ISO week, Monday and Sunday, as YYYY-MM-DD.
function lastWeekBounds(now = Date.now()) {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = new Date(today).getUTCDay() || 7;
  const thisMonday = today - (dow - 1) * 864e5;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(thisMonday - 7 * 864e5), to: iso(thisMonday - 864e5) };
}

const LEVEL = { "Must watch": 3, "Worth a watch": 2, Skip: 0 };
const level = (it) => { const v = it.fcScore && it.fcScore.verdict; return v in LEVEL ? LEVEL[v] : 1; };
const weight = (it) => (Number(it.rating) || 0) * Math.log10(10 + (Number(it.votes) || 0));

// Pure: the films released in [from, to] in this edition, ranked. `data` is the edition's data
// file; `facts` the facts store (Map slug → { item }); `manifest` the edition's manifest entries;
// `index` the film-page index (posters). `hidden(slug)` says a page is held back from Google.
function lastWeekItems({ data = {}, facts = new Map(), manifest = {}, index = [], from, to, hidden = () => false }) {
  const inRange = (it) => { const r = String((it && it.released) || "").slice(0, 10); return r >= from && r <= to; };
  const film = (it) => it && it.title && it.slug && (it.kind || "movie") !== "tv";
  const pool = [...(data.theatres || []), ...(data.ott || []), ...(data.ottExtra || []), ...(data.comingSoon || []),
    ...Object.values(data.langPools || {}).flatMap((p) => (Array.isArray(p) ? p : [...(p.theatres || []), ...(p.ott || [])]))];
  const out = new Map();
  for (const it of pool) if (film(it) && inRange(it) && !hidden(it.slug) && !out.has(it.slug)) out.set(it.slug, it);
  const posterOf = new Map((index || []).map((x) => [x.slug, x.poster]));
  for (const [slug, rec] of facts) {
    const it = rec && rec.item;
    if (out.has(slug) || !it || !film({ ...it, slug }) || !inRange(it) || hidden(slug)) continue;
    const v = manifest[slug] && manifest[slug].fcs && manifest[slug].fcs.v;
    out.set(slug, { ...it, slug, poster: posterOf.get(slug) || it.poster || "",
      ...(v in LEVEL ? { fcScore: { verdict: v, reason: "", audience: null, critics: null } } : {}) });
  }
  return [...out.values()].sort((a, b) => level(b) - level(a) || weight(b) - weight(a) || a.title.localeCompare(b.title));
}

function buildLastWeekPage(items, cfg, { from, to, now = Date.now() }) {
  const code = (cfg && cfg.code) || "in";
  const country = countryNameFor(cfg);
  const V = streamVocab(cfg);
  const loc = localeFor(code);
  const range = weekRangeFor(`${from}T12:00:00Z`, code);
  const streaming = (it) => (it.providers || []).length > 0 || (it.platform && it.platform !== "Theatres");
  const cinema = items.filter((it) => !streaming(it)), straight = items.filter(streaming);
  const sections = [];
  if (cinema.length) sections.push({ h2: "Released in cinemas", items: cinema });
  if (straight.length) sections.push({ h2: `Released on ${V.word}`, items: straight });
  const good = items.filter((it) => level(it) >= 2);
  const names = (list, n) => list.slice(0, n).map((x) => x.title);
  const andList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const top = names(good.length >= 3 ? good : items, 3);
  const more = items.length - top.length;
  // "A, B, C and 21 more"; "A, B and C" when they are all there is.
  const listed = more > 0 ? `${top.join(", ")} and ${more} more` : andList(top);
  // Only say the verdicts are in when most of the list has one.
  const verdicts = good.length + items.filter((it) => level(it) === 0).length >= items.length / 2;
  const faqs = [{ q: `Which movies were released last week in ${country}?`, a: `${items.length} films were released in ${country} in the week of ${range}: ${andList(names(items, 8))}${items.length > 8 ? `, and ${items.length - 8} more` : ""}.` }];
  if (good.length) faqs.push({ q: "Which of last week's movies are worth watching?", a: `By the FilmyChill Verdict: ${andList(good.slice(0, 4).map((x) => `${x.title} (${x.fcScore.verdict})`))}.` });
  return listingPageHtml({
    title: fitFirst([
      `${items.length} Movies Released Last Week in ${country} (${range})`,
      `Movies Released Last Week in ${country} (${range})`,
      `Movies Released Last Week (${range})`,
    ], 60),
    desc: fitFirst([
      verdicts ? `${items.length} films released in ${country} last week (${range}): ${listed}, with verdicts now the ratings are in.` : null,
      `${items.length} films released in ${country} last week (${range}): ${listed}, with ratings and where to watch.`,
      `${items.length} films released in ${country} last week (${range}): ${listed}.`,
      `Every film released in ${country} last week (${range}), with ratings, verdicts and where to watch.`,
    ], 160),
    canonical: lastWeekUrl(code),
    h1: `Movies released last week in ${country}`,
    updLine: `${range} · updated ${new Date(now).toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" })}`,
    lead: `Every film that opened in ${country} from ${fmtDateShort(from, now, loc)} to ${fmtDateShort(to, now, loc)}, in cinemas or straight to ${V.word}, with the best-rated first. Films without enough ratings yet say so. The list moves to the new week every Monday.`,
    sections, faqs, code, extraLd: [],
    navLinks: [{ href: code === "in" ? "https://filmychill.com/new-on-ott/" : `https://filmychill.com/${code}/new-on-ott/`, label: `This week's ${V.word} releases` }],
    homeUrl: code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`,
  });
}

// The build step, per edition: written when there are enough films, removed when not.
function writeLastWeekPage(data, cfg, manifest = {}, index = [], { now = Date.now(), root = "." } = {}) {
  const code = cfg.code;
  const { from, to } = lastWeekBounds(now);
  const hidden = (slug) => require("./googlehide.js").listedHidden(code, slug);
  const facts = require("./facts.js").readFacts(code, root);
  const items = lastWeekItems({ data, facts, manifest: (manifest || {})[code] || {}, index, from, to, hidden });
  const p = lastWeekPath(code);
  if (items.length >= LAST_WEEK_MIN) {
    fs.mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    writeIfChanged(p, buildLastWeekPage(items, cfg, { from, to, now }));
  } else if (fs.existsSync(p)) {
    fs.rmSync(p.slice(0, p.lastIndexOf("/")), { recursive: true, force: true });
  }
  return { films: items.length, written: items.length >= LAST_WEEK_MIN, from, to };
}

module.exports = { LAST_WEEK_MIN, buildLastWeekPage, lastWeekBounds, lastWeekItems, lastWeekPath, lastWeekUrl, writeLastWeekPage };
