// ============================================================================
// hubs.js — archive and hub pages: monthly OTT archives, scoped month archives, and the
// per-platform 'New on Netflix' style hubs.
// ============================================================================
"use strict";

const fs = require("fs");
const {
  COUNTRIES,
  COUNTRY_PAGE_META,
  LANGUAGE_PAGES,
  filmPageUrl,
  fmtDateShort,
  slugify,
  localeFor,
} = require("./core.js");
const {
  readHistory,
  historyForMonth,
  historyMonths,
  monthKey,
  monthLabel,
} = require("./history.js");
const { filmIndexFor } = require("./graph.js");
const { streamPageUrl } = require("./evergreen.js");
const {
  canonProvider,
  fitFirst,
  hubUrl,
  listingPageHtml,
  ottMonthPath,
  platformSlug,
  streamPagePath,
  weekRangeFor,
} = require("./pagekit.js");
const { countryNameFor, streamVocab } = require("./rules.js");
const { buildOttWeekPage, ottWeekPath, ottWeekUrl } = require("./weekly.js");

// ============================================================================
// MONTHLY OTT ARCHIVE — /new-on-ott/<YYYY-MM>/ per country.
//
// The weekly hub answers "what landed this week" and is worthless eight days later; it has
// one URL, so every week's work overwrites the last. Sept 2026 GSC: the 59 hub pages drew
// 2,345 impressions for 27 clicks at positions 27-59, because one thin, constantly-rewritten
// page cannot outrank sites with a page per month going back years.
//
// This builds that page per month, from ott-history.jsonl — the append-only record of the day
// each title was first seen carrying a provider in each country. That record is the one asset
// here nobody else has: TMDB keeps no provider history and JustWatch publishes none, so
// "everything that started streaming in India in September 2026, and where" is a question
// only this site can answer. Grouped by platform, because "new on netflix september 2026" is
// how people ask it.
//
// Past months are frozen the moment they are complete: written once, never rewritten (their
// data cannot change — `first` is a first-sighting date and never moves backwards).
// ============================================================================
const MONTH_PAGE_MIN = 6;
function ottMonthUrl(code, month) {
  return code === "in" ? `https://filmychill.com/new-on-ott/${month}/` : `https://filmychill.com/${code}/new-on-ott/${month}/`;
}

// Pure: archive records for ONE country+month -> the page. `index` is this country's film
// index (see filmIndexFor) so rows link to the film page when one exists and stay plain text
// when it doesn't — a listing that links to 404s is worse than one that doesn't link.
// One archive record -> one listing row. Shared by every month page (site-wide, per platform,
// per language) so a title renders identically wherever it is listed. Links only when the film
// page actually exists on disk: a listing that links to 404s is worse than one that doesn't link.
function monthRow(r, { bySlug, code = "in", now = Date.now() }) {
  const slug = slugify(r.t || "");
  const page = bySlug.get(slug);
  return {
    title: r.t,
    slug: page ? slug : null,
    platform: r.p || null,
    genre: r.g || "",
    language: r.lang || "",
    released: r.rel || null,
    freshDate: r.first || null,
    poster: page ? page.poster || "" : "",
    kind: r.k === "tv" ? "tv" : "movie",
    // The arrival date is the whole point of these pages and exists nowhere else — but the row
    // meta already shows it for series (freshLabel uses freshDate for TV) and for anything that
    // went straight to streaming on release day. Only add the line when it adds something.
    hook: (r.k !== "tv" && r.first && String(r.first).slice(0, 10) !== String(r.rel || "").slice(0, 10))
      ? `Started streaming ${fmtDateShort(r.first, now, localeFor(code))}` : null,
  };
}

function buildOttMonthPage(recs, cfg, { month, months = [], index = [], now = Date.now() }) {
  const code = (cfg && cfg.code) || "in";
  const country = countryNameFor(cfg);
  const V = streamVocab(cfg);
  const label = monthLabel(month, localeFor(code));
  const url = ottMonthUrl(code, month);
  const bySlug = new Map((index || []).map((x) => [x.slug, x]));
  const rowOf = (r) => monthRow(r, { bySlug, code, now });
  // One section per platform, biggest first: "new on netflix september 2026" is a query, and
  // a page that groups by platform answers it on the page instead of burying it in a list.
  const byPlatform = new Map();
  for (const r of recs) {
    const key = r.p || "Other platforms";
    if (!byPlatform.has(key)) byPlatform.set(key, []);
    byPlatform.get(key).push(rowOf(r));
  }
  const sections = [...byPlatform.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([name, items]) => ({ h2: `${name} — ${label}`, items }));
  const total = recs.length;
  const platformList = [...byPlatform.entries()].sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4).map(([n, xs]) => `${n} (${xs.length})`).join(", ");
  const faqs = [];
  if (total) faqs.push({
    q: `How many titles started streaming in ${country} in ${label}?`,
    a: `${total} — ${platformList}. FilmyChill records each title on the day it first appears on a subscription service in ${country}.`,
  });
  const films = recs.filter((r) => r.k !== "tv").length;
  if (films && total - films) faqs.push({
    q: `Were they films or series?`,
    a: `${films} film${films === 1 ? "" : "s"} and ${total - films} series arrived on ${V.word} in ${country} during ${label}.`,
  });
  const langs = [...new Set(recs.map((r) => r.lang).filter(Boolean))].slice(0, 6);
  if (langs.length > 1) faqs.push({
    q: `Which languages were covered in ${label}?`,
    a: `${langs.join(", ")} — every ${V.word} arrival FilmyChill tracked in ${country} that month.`,
  });
  // Month nav: the previous and next months that actually have a page, plus the weekly hub.
  const have = months.map((m) => m.month).sort();
  const i = have.indexOf(month);
  const navLinks = [];
  if (i > 0) navLinks.push({ href: ottMonthUrl(code, have[i - 1]), label: `← ${monthLabel(have[i - 1], localeFor(code))}` });
  if (i >= 0 && i < have.length - 1) navLinks.push({ href: ottMonthUrl(code, have[i + 1]), label: `${monthLabel(have[i + 1], localeFor(code))} →` });
  navLinks.push({ href: ottWeekUrl(code), label: `This week's ${V.word} releases` });
  // Down into the per-platform cut of the SAME month, where one exists. The platform pages
  // link back up (see buildScopedMonthPage), so the two axes stay reachable from each other.
  for (const [name, items] of [...byPlatform.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (items.length < SCOPED_MONTH_MIN || name === "Other platforms") continue;
    const slug = platformSlug(canonProvider(name));
    if (!slug || !fs.existsSync(platformMonthPath(code, slug, month))) continue;
    navLinks.push({ href: platformMonthUrl(code, slug, month), label: `${name} only` });
  }
  const isCurrent = month === monthKey(new Date(now).toISOString());
  const linkable = sections.flatMap((sec) => sec.items).filter((x) => x.slug);
  const extraLd = [{
    "@context": "https://schema.org", "@type": "CollectionPage",
    name: `New on ${V.word} in ${country} — ${label}`, url,
    isPartOf: { "@type": "WebSite", "@id": "https://filmychill.com/#website" },
    mainEntity: { "@type": "ItemList", numberOfItems: linkable.length,
      itemListElement: linkable.map((x, n) => ({ "@type": "ListItem", position: n + 1, name: x.title, url: filmPageUrl(code, x.slug) })) },
  }, {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "FilmyChill", item: code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/` },
      { "@type": "ListItem", position: 2, name: `New on ${V.word}`, item: ottWeekUrl(code) },
      { "@type": "ListItem", position: 3, name: label, item: url },
    ],
  }];
  return listingPageHtml({
    title: `Everything New on ${V.word} in ${country} — ${label} | FilmyChill`,
    desc: `Every film and series that started streaming in ${country} during ${label} — ${total} titles across ${byPlatform.size} platform${byPlatform.size === 1 ? "" : "s"}, with ratings and verdicts.`,
    canonical: url,
    h1: `New on ${V.word} in ${country} — ${label}`,
    updLine: isCurrent ? `Updated ${new Date(now).toLocaleDateString(localeFor(code), { day: "numeric", month: "long", year: "numeric" })} · this month is still filling up`
      : `A complete record of ${label}`,
    lead: `Every title FilmyChill saw arrive on a subscription service in ${country} during ${label}, grouped by platform and dated the day it appeared.`,
    frozenNote: isCurrent ? null
      : `${label} is closed. This page is the record of what arrived that month and no longer changes — new arrivals appear on the current month's page.`,
    sections, faqs, extraLd, navLinks, code,
    homeUrl: code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`,
  });
}

// Writes the current month every run (it is still filling up) and back-fills any past month
// that has enough arrivals and no page yet. Past months already on disk are left alone.
// ============================================================================
// SCOPED MONTH ARCHIVES — /new-on-netflix/2026-09/ and /telugu/2026-09/.
//
// Same record, two more axes. The site-wide month page answers "what arrived in September";
// these answer "what arrived on Netflix in September" and "what Telugu arrived in September",
// which is how the questions are actually typed. Both are regroups of ott-history.jsonl — no
// new content, no new data source, and nothing that exists only because a query exists: every
// page is a factual record of one month on one platform or in one language.
//
// Gated on SCOPED_MONTH_MIN. A platform-month with two titles is a thin page, and forty of
// them a month is the pattern search engines rightly punish. Below the gate, no page.
// ============================================================================
const SCOPED_MONTH_MIN = 4;

function platformMonthPath(code, slug, month) {
  return code === "in" ? `new-on-${slug}/${month}/index.html` : `${code}/new-on-${slug}/${month}/index.html`;
}
function platformMonthUrl(code, slug, month) {
  return code === "in" ? `https://filmychill.com/new-on-${slug}/${month}/` : `https://filmychill.com/${code}/new-on-${slug}/${month}/`;
}
function languageMonthPath(langSlug, month) { return `${langSlug}/${month}/index.html`; }
function languageMonthUrl(langSlug, month) { return `https://filmychill.com/${langSlug}/${month}/`; }

// Pure: one month of arrivals, narrowed to a platform or a language, as a page.
// `scope` = { kind: "platform" | "language", name, slug }. The grouping flips with the scope:
// a platform page groups by language, a language page groups by platform — each answers the
// question the other axis leaves open.
function buildScopedMonthPage(recs, cfg, { scope, month, months = [], index = [], now = Date.now() }) {
  const code = (cfg && cfg.code) || "in";
  const country = countryNameFor(cfg);
  const V = streamVocab(cfg);
  const label = monthLabel(month, localeFor(code));
  const isPlatform = scope.kind === "platform";
  const url = isPlatform ? platformMonthUrl(code, scope.slug, month) : languageMonthUrl(scope.slug, month);
  const bySlug = new Map((index || []).map((x) => [x.slug, x]));
  const rows = recs.map((r) => monthRow(r, { bySlug, code, now }));
  const groupKey = (r) => (isPlatform ? (r.lang || "Other languages") : (r.p || "Other platforms"));
  const groups = new Map();
  for (const r of recs) {
    const k = groupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(monthRow(r, { bySlug, code, now }));
  }
  const sections = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([name, items]) => ({ h2: `${name} — ${label}`, items }));
  const total = rows.length;
  const films = recs.filter((r) => r.k !== "tv").length;
  const headline = isPlatform
    ? `New on ${scope.name} in ${country} — ${label}`
    : `New ${scope.name} on ${V.word} in ${country} — ${label}`;
  const breakdown = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4).map(([n, xs]) => `${n} (${xs.length})`).join(", ");
  const faqs = [];
  faqs.push({
    q: isPlatform
      ? `How many titles were added to ${scope.name} in ${country} in ${label}?`
      : `How many ${scope.name} titles reached ${V.word} in ${country} in ${label}?`,
    a: `${total} — ${breakdown}. FilmyChill records each title on the day it first appears on a subscription service in ${country}.`,
  });
  if (films && total - films) faqs.push({
    q: `Were they films or series?`,
    a: `${films} film${films === 1 ? "" : "s"} and ${total - films} series.`,
  });
  // Month nav within the SAME scope, plus the two pages one level up: the whole month, and
  // this scope's current week.
  const have = months.slice().sort();
  const i = have.indexOf(month);
  const navLinks = [];
  const urlFor = (m) => (isPlatform ? platformMonthUrl(code, scope.slug, m) : languageMonthUrl(scope.slug, m));
  if (i > 0) navLinks.push({ href: urlFor(have[i - 1]), label: `← ${monthLabel(have[i - 1], localeFor(code))}` });
  if (i >= 0 && i < have.length - 1) navLinks.push({ href: urlFor(have[i + 1]), label: `${monthLabel(have[i + 1], localeFor(code))} →` });
  navLinks.push({ href: ottMonthUrl(code, month), label: `Everything new in ${label}` });
  navLinks.push({ href: isPlatform ? hubUrl(code, scope.slug) : `https://filmychill.com/${scope.slug}/`, label: `${scope.name} this week` });
  const linkable = rows.filter((x) => x.slug);
  const isCurrent = month === monthKey(new Date(now).toISOString());
  const extraLd = [{
    "@context": "https://schema.org", "@type": "CollectionPage",
    name: headline, url,
    isPartOf: { "@type": "WebSite", "@id": "https://filmychill.com/#website" },
    mainEntity: { "@type": "ItemList", numberOfItems: linkable.length,
      itemListElement: linkable.map((x, n) => ({ "@type": "ListItem", position: n + 1, name: x.title, url: filmPageUrl(code, x.slug) })) },
  }, {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "FilmyChill", item: code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/` },
      { "@type": "ListItem", position: 2, name: isPlatform ? `New on ${scope.name}` : scope.name,
        item: isPlatform ? hubUrl(code, scope.slug) : `https://filmychill.com/${scope.slug}/` },
      { "@type": "ListItem", position: 3, name: label, item: url },
    ],
  }];
  return listingPageHtml({
    title: `${headline} | FilmyChill`.length <= 65 ? `${headline} | FilmyChill` : headline,
    desc: isPlatform
      ? `Every film and series added to ${scope.name} in ${country} during ${label} — ${total} titles, dated, rated and reviewed.`
      : `Every ${scope.name} film and series that started streaming in ${country} during ${label} — ${total} titles with platforms, ratings and verdicts.`,
    canonical: url,
    h1: headline,
    updLine: isCurrent
      ? `Updated ${new Date(now).toLocaleDateString(localeFor(code), { day: "numeric", month: "long", year: "numeric" })} · this month is still filling up`
      : `A complete record of ${label}`,
    lead: isPlatform
      ? `Everything FilmyChill saw arrive on ${scope.name} in ${country} during ${label}, dated the day it appeared.`
      : `Every ${scope.name} title FilmyChill saw reach a subscription service in ${country} during ${label}, grouped by platform.`,
    frozenNote: isCurrent ? null
      : `${label} is closed. This page is the record of that month and no longer changes.`,
    sections, faqs, extraLd, navLinks, code,
    homeUrl: code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`,
  });
}

// Platform x month for one country. Current month rewritten every run; a closed month is
// written once and then left alone (its data cannot change).
function writePlatformMonthPages(cfg, records = null, index = null) {
  const code = (cfg && cfg.code) || "in";
  const recs = (records || readHistory()).filter((r) => r && r.c === code && r.p && monthKey(r.first));
  if (!recs.length) return 0;
  const idx = index || filmIndexFor(cfg);
  const current = monthKey(new Date().toISOString());
  // (platform slug, month) -> records
  const buckets = new Map();
  for (const r of recs) {
    const name = canonProvider(r.p);
    const key = `${platformSlug(name)}|${monthKey(r.first)}`;
    if (!buckets.has(key)) buckets.set(key, { name, slug: platformSlug(name), month: monthKey(r.first), rows: [] });
    buckets.get(key).rows.push(r);
  }
  const monthsBySlug = new Map();
  for (const b of buckets.values()) {
    if (b.rows.length < SCOPED_MONTH_MIN) continue;
    if (!monthsBySlug.has(b.slug)) monthsBySlug.set(b.slug, []);
    monthsBySlug.get(b.slug).push(b.month);
  }
  let written = 0;
  for (const b of buckets.values()) {
    if (b.rows.length < SCOPED_MONTH_MIN) continue;
    const path = platformMonthPath(code, b.slug, b.month);
    if (b.month !== current && fs.existsSync(path)) continue;
    fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(path, buildScopedMonthPage(
      b.rows.slice().sort((x, y) => String(y.first).localeCompare(String(x.first))),
      cfg, { scope: { kind: "platform", name: b.name, slug: b.slug }, month: b.month,
             months: monthsBySlug.get(b.slug) || [], index: idx }));
    written++;
  }
  if (written) console.log(`  platform months [${code}]: ${written} page(s)`);
  return written;
}

// Language x month — India only, for the five languages that already have a landing page.
function writeLanguageMonthPages(records = null, index = null) {
  const cfg = COUNTRIES.find((c) => c.code === "in") || { code: "in", name: "India", region: "IN" };
  const recs = (records || readHistory()).filter((r) => r && r.c === "in" && r.lang && monthKey(r.first));
  if (!recs.length) return 0;
  const idx = index || filmIndexFor(cfg);
  const current = monthKey(new Date().toISOString());
  let written = 0;
  for (const [langName, langSlug] of LANGUAGE_PAGES) {
    const mine = recs.filter((r) => r.lang === langName);
    const byMonth = new Map();
    for (const r of mine) {
      const m = monthKey(r.first);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(r);
    }
    const months = [...byMonth.entries()].filter(([, rows]) => rows.length >= SCOPED_MONTH_MIN).map(([m]) => m);
    for (const m of months) {
      const path = languageMonthPath(langSlug, m);
      if (m !== current && fs.existsSync(path)) continue;
      fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(path, buildScopedMonthPage(
        byMonth.get(m).slice().sort((x, y) => String(y.first).localeCompare(String(x.first))),
        cfg, { scope: { kind: "language", name: langName, slug: langSlug }, month: m, months, index: idx }));
      written++;
    }
  }
  if (written) console.log(`  language months: ${written} page(s)`);
  return written;
}

function writeOttMonthPages(cfg, records = null, index = null) {
  const code = (cfg && cfg.code) || "in";
  const recs = records || readHistory();
  const months = historyMonths(recs, code).filter((m) => m.n >= MONTH_PAGE_MIN);
  if (!months.length) return 0;
  const idx = index || filmIndexFor(cfg);
  const current = monthKey(new Date().toISOString());
  let written = 0;
  for (const { month } of months) {
    const path = ottMonthPath(code, month);
    if (month !== current && fs.existsSync(path)) continue;   // frozen: complete and unchanging
    const dir = path.slice(0, path.lastIndexOf("/"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path, buildOttMonthPage(historyForMonth(recs, code, month), cfg, { month, months, index: idx }));
    written++;
  }
  if (written) console.log(`  month archive [${code}]: ${written} page(s) written of ${months.length} month(s) on record`);
  return written;
}

function writeOttWeekPage(data, cfg, allCountries) {
  const p = ottWeekPath(cfg.code);
  const dir = p.slice(0, p.lastIndexOf("/"));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, buildOttWeekPage(data, cfg, allCountries));
  console.log(`  OTT-week page: /${p.replace(/index\.html$/, "")}`);
}


// Shared listing shell for language + week pages (same visual family as the
// /new-on-ott/ pages). `sections` = [{ h2, items }]; rows link to film pages.

// ============================================================================
// PLATFORM HUB PAGES — /new-on-netflix/, /new-on-jiohotstar/, ... per country. The
// highest-intent streaming queries are platform-shaped ("new on netflix india this week");
// nobody types "new OTT releases". Each hub is a filtered re-render of data the run already
// has — zero extra API calls — grouped from every provider an item is on. Eligibility keeps
// hubs dense and honest: a provider needs >= HUB_MIN_TITLES current titles, and only the top
// HUB_MAX_PER_COUNTRY providers get pages. Same licence-clean sources, CollectionPage +
// ItemList + FAQ schema.
// ============================================================================
// Two thresholds, not one. A hub needs HUB_MIN_NEW titles to be CREATED but only
// HUB_MIN_KEEP to SURVIVE. Without that hysteresis a provider sitting on the boundary
// gets its page minted and pruned on alternate runs, which is a worse signal to a crawler
// than never having had the page. The create bar is the higher one because a three-title
// hub is thin content and this pipeline mints hubs automatically.
const HUB_MIN_NEW = 4;
const HUB_MIN_KEEP = 3;
const HUB_MAX_PER_COUNTRY = 5;

// `existingSlugs` is the set of hub pages already on disk for this country. Pass it and a
// provider that has slipped from HUB_MIN_NEW to HUB_MIN_KEEP keeps its page instead of
// flapping. Omit it (tests, callers that only want the current shape) and only the create
// bar applies.
function hubsFor(data, existingSlugs) {
  const groups = new Map();
  // Read the FULL pool, not the ten that fit the homepage. Grouping ten titles across six
  // providers meant a provider almost never reached the threshold, so the footer showed two
  // links that changed identity week to week depending on which service happened to land a
  // third title. ottExtra is the same pool /new-on-ott/ uses.
  const source = [...((data && data.ott) || []), ...((data && data.ottExtra) || [])];
  const seen = new Set();
  for (const it of source) {
    if (!it || !it.title) continue;
    if (it.tmdbId != null) { if (seen.has(it.tmdbId)) continue; seen.add(it.tmdbId); }
    const provs = new Set([...(Array.isArray(it.providers) ? it.providers : []), ...(it.platform && it.platform !== "Theatres" ? [it.platform] : [])]
      .map(canonProvider).filter(Boolean));
    for (const p of provs) {
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(it);
    }
  }
  const have = existingSlugs instanceof Set ? existingSlugs : new Set();
  return [...groups.entries()]
    .filter(([name, items]) => items.length >= (have.has(platformSlug(name)) ? HUB_MIN_KEEP : HUB_MIN_NEW))
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, HUB_MAX_PER_COUNTRY)
    .map(([name, items]) => ({ name, slug: platformSlug(name), items }));
}

// Hub directories currently on disk for a country, by slug.
function existingHubSlugs(code) {
  const base = code === "in" ? "." : code;
  if (!fs.existsSync(base)) return new Set();
  return new Set(fs.readdirSync(base)
    .filter((d) => d.startsWith("new-on-") && d !== "new-on-ott" && fs.existsSync(`${base}/${d}/index.html`))
    .map((d) => d.slice("new-on-".length)));
}

function buildPlatformHubPage(data, cfg, hub) {
  const code = (cfg && cfg.code) || "in";
  const m = COUNTRY_PAGE_META[code] || { name: (cfg && cfg.name) || "India", path: `/${code}/` };
  const countryName = m.name;
  const url = hubUrl(code, hub.slug);
  const gen = data.generatedAt || new Date().toISOString();
  const monthYear = new Date(gen).toLocaleDateString(localeFor(code), { month: "long", year: "numeric" });
  const updatedHuman = new Date(gen).toLocaleDateString(localeFor(code), { day: "numeric", month: "long", year: "numeric" });
  // FRESH vs CARRIED-OVER. The homepage OTT list deliberately carries a tail of older
  // standouts (flagged stillGood) and labels them under "Still worth it — standouts from
  // earlier weeks". Hub pages inherited the items but NOT the label, so a page whose H1,
  // description, FAQ answer and lead all say "this week" was listing titles from three to
  // five weeks ago — Reacher (2022 series), Lioness (2023), Ted Lasso (2020) — flat, as
  // new arrivals. Every currency claim on this page is now computed from `fresh` only;
  // carried-over titles still appear, under their own labelled section, because they are
  // genuinely worth watching and dropping them would thin the page for no gain.
  const fresh = hub.items.filter((x) => !x.stillGood);
  const carried = hub.items.filter((x) => x.stillGood);
  const claimSet = fresh.length ? fresh : hub.items;   // never leave the page claim-less
  const films = fresh.filter((x) => x.kind !== "tv"), series = fresh.filter((x) => x.kind === "tv");

  // The FAQ answer is the single most quotable sentence on the page — it is what answer
  // engines lift verbatim. It must name only titles that actually arrived this week.
  const faqs = [{ q: `What's new on ${hub.name} in ${countryName} this week?`, a: `New on ${hub.name} this week: ${claimSet.map((t) => t.title).join(", ")}.` }];
  const best = claimSet.filter((x) => x.rating != null).sort((a, b) => b.rating - a.rating)[0];
  if (best) faqs.push({ q: `What's the best new title on ${hub.name} right now?`,
    a: `${best.title} is the top-rated new arrival on ${hub.name} at ${Number(best.rating).toFixed(1)}/10${best.verdict ? ` — ${best.verdict}` : ""}.` });
  if (carried.length) faqs.push({ q: `What else is worth watching on ${hub.name} right now?`,
    a: `Still worth your time from earlier weeks: ${carried.map((t) => t.title).join(", ")}.` });

  const linked = hub.items.filter((x) => x.slug);
  const extraLd = [{
    "@context": "https://schema.org", "@type": "CollectionPage",
    name: `New on ${hub.name} in ${countryName} This Week`, url, dateModified: gen,
    isPartOf: { "@type": "WebSite", "@id": "https://filmychill.com/#website" },
    mainEntity: { "@type": "ItemList", numberOfItems: linked.length,
      itemListElement: linked.map((x, i) => ({ "@type": "ListItem", position: i + 1, name: x.title, url: filmPageUrl(code, x.slug) })) },
  }, {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "FilmyChill", item: `https://filmychill.com${m.path}` },
      { "@type": "ListItem", position: 2, name: `New on ${hub.name}`, item: url },
    ],
  }];
  // A Netflix hub exists in most markets and they read alike; without hreflang they compete
  // as duplicates. Membership comes from disk, same rule as film pages.
  const hubDirName = `new-on-${hub.slug}`;
  const altPaths = {};
  for (const c of COUNTRIES) {
    const base = c.code === "in" ? hubDirName : `${c.code}/${hubDirName}`;
    if (fs.existsSync(`${base}/index.html`) || c.code === code) {
      altPaths[c.code] = c.code === "in" ? `/${hubDirName}/` : `/${c.code}/${hubDirName}/`;
    }
  }
  return listingPageHtml({
    // "9 New on JioHotstar This Week (21–27 Sept)": a count and the week's dates are the two
    // things a searcher scanning results can check at a glance (and the count is exact: it is
    // the number of new arrivals listed on the page). Falls back to the month when nothing new.
    title: fitFirst(fresh.length ? [
      `${fresh.length} New on ${hub.name} in ${countryName} This Week (${weekRangeFor(gen, code)})`,
      `${fresh.length} New on ${hub.name} This Week (${weekRangeFor(gen, code)}) — ${countryName}`,
      `${fresh.length} New on ${hub.name} This Week (${weekRangeFor(gen, code)})`,
      `New on ${hub.name} ${countryName} This Week (${monthYear})`,
    ] : [`New on ${hub.name} ${countryName} This Week (${monthYear}) | FilmyChill`, `New on ${hub.name} ${countryName} This Week (${monthYear})`], 60),
    desc: `${fresh.length ? "Every movie and series newly streaming" : "What's streaming"} on ${hub.name} in ${countryName} this week — ratings, critics' verdicts, what to skip. Updated twice daily.`,
    canonical: url,
    h1: `New on ${hub.name} in ${countryName} this week`,
    updLine: `Updated ${updatedHuman} · refreshed twice daily`,
    // The count in the lead must be the count of NEW titles, not the page's total rows —
    // saying "10 new titles" above a list where four landed a month ago is the same false
    // claim in smaller type.
    lead: fresh.length
      ? `${fresh.length} new ${fresh.length === 1 ? "title" : "titles"} on ${hub.name} this week, ranked and rated — with an honest word on which are worth your evening.${carried.length ? ` Plus ${carried.length} still worth catching from earlier weeks.` : ""}`
      : `Nothing new landed on ${hub.name} this week. Here's what's still worth watching from recent weeks, ranked and rated.`,
    sections: [
      ...((films.length && series.length)
        ? [{ h2: "Movies", items: films }, { h2: "Series", items: series }]
        : (fresh.length ? [{ h2: `Added this week`, items: fresh }] : [])),
      ...(carried.length ? [{ h2: "Still worth it — from earlier weeks", items: carried }] : []),
    ],
    faqs, extraLd, homeUrl: `https://filmychill.com${m.path}`, code, altPaths,
    // Up from "new this week" to "everything on it", when that page exists (see writeStreamingPages).
    navLinks: fs.existsSync(streamPagePath(code, hub.slug)) ? [{ href: streamPageUrl(code, hub.slug), label: `Everything on ${hub.name} in ${countryNameFor({ code })}` }] : null,
  });
}

// Hub pages written on the most recent run, per country code. The sitemap reads this instead
// of scanning directories: a directory on disk proves a page was written ONCE, not that it is
// current, and the scan was stamping lastmod=today on every hub it found — including one last
// rewritten five weeks earlier. Telling a crawler a stale page changed today is worse than
// omitting it.
const LIVE_HUBS = new Map();

module.exports = {
  buildOttMonthPage,
  buildPlatformHubPage,
  buildScopedMonthPage,
  existingHubSlugs,
  hubsFor,
  languageMonthPath,
  languageMonthUrl,
  LIVE_HUBS,
  monthRow,
  ottMonthUrl,
  platformMonthPath,
  platformMonthUrl,
  SCOPED_MONTH_MIN,
  writeLanguageMonthPages,
  writeOttMonthPages,
  writeOttWeekPage,
  writePlatformMonthPages,
};
