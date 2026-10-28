// ============================================================================
// pagetypes.js — every kind of page FilmyChill may publish, and why it is allowed to exist
// (27 Oct 2026).
//
// The Oct 2026 cleanup removed or hid page types that had grown with no rule asking whether they
// earned their place (A–Z pages, month and week archives, actor pages, thin platform lists). From
// now on a page type exists only if it is listed here with: what it takes to be created (gate),
// which pages link to it (links), whether Google is offered it (google), and when it is hidden or
// removed (exit). The build classifies every page on disk; a page that matches no type turns the
// run red (update.js), and the tests check every type is fully described. Adding a page type means
// adding it here first.
// ============================================================================
"use strict";

const ED = "(?:(?:ae|au|br|ca|de|es|fr|id|jp|kr|mx|my|nz|ph|sg|uk|us)/)?";
const LANGS = "(?:hindi|tamil|telugu|malayalam|kannada)";
const re = (s) => new RegExp(`^${s}$`);

const PAGE_TYPES = [
  { id: "homepage", match: re(`${ED}index\\.html`),
    gate: "one per edition (18)", links: "logo and footer of every page", google: "yes",
    exit: "never" },
  { id: "film", match: re(`${ED}movie/[^/]+\\.html`),
    gate: "the title was on a current weekly list (cinema, streaming, trending, coming soon); catalogue backfill is off",
    links: "weekly page, release calendar, hubs, platform lists, related films; new titles get 3+ (lib/relrefresh.js)",
    google: "yes, unless hidden",
    exit: "Google-hidden when it earns no impression in 90 days (catalogue, or weekly over 120 days old), or is a near-copy edition; empty overseas pages noindexed (lib/keeplean.js, lib/googlehide.js)" },
  { id: "weekly page", match: re(`${ED}new-on-ott/index\\.html`),
    gate: "one per edition", links: "homepage, footer", google: "yes", exit: "never" },
  { id: "today page", match: re(`${ED}new-on-ott/today/index\\.html`),
    gate: "one per edition", links: "footer", google: "yes", exit: "never" },
  { id: "platform hub", match: re(`${ED}new-on-[a-z0-9-]+/index\\.html`),
    gate: "6 current titles to create, 5 to keep (lib/hubs.js HUB_MIN_NEW/HUB_MIN_KEEP)",
    links: "homepage, weekly page, film pages", google: "yes", exit: "removed below 5 titles; links swept" },
  { id: "coming to OTT", match: re(`${ED}coming-to-ott/index\\.html`),
    gate: "one per edition with dated arrivals", links: "footer", google: "yes", exit: "removed when empty" },
  { id: "platform list", match: re(`${ED}streaming/[^/]+/index\\.html`),
    gate: "12 titles Google can see, confirmed in 45 days, to create; 10 to keep (lib/evergreen.js STREAM_PAGE_MIN/KEEP)",
    links: "weekly page's Browse by platform, footer, film pages", google: "yes", exit: "removed below 10 titles" },
  { id: "platform language list", match: re(`${ED}streaming/[^/]+/[^/]+/index\\.html`),
    gate: "6 titles Google can see in one language to create; 5 to keep (STREAM_LANG_MIN/KEEP)", links: "its platform list", google: "yes",
    exit: "removed below 5 titles" },
  { id: "language page", match: re(`${LANGS}/index\\.html`),
    gate: "India, one per language", links: "homepage, footer, film pages", google: "yes", exit: "never" },
  { id: "people page", match: re(`${ED}people/(?:[^/]+/)?index\\.html`),
    gate: "none created since 25 Oct 2026; existing ones kept current", links: "none from pages Google sees",
    google: "no (googlebot noindex)", exit: "removed below 5 films" },
  { id: "embed widget", match: re(`(?:${ED}embed/week|embed)/index\\.html`),
    gate: "one per edition, plus the instructions page", links: "footer (instructions)", google: "no",
    exit: "never" },
  { id: "trust page", match: re(`(?:about|privacy|dmca|data)/index\\.html`),
    gate: "fixed set", links: "footer of every page", google: "yes", exit: "never" },
  { id: "utility", match: re(`(?:404|post|google[0-9a-f]+)\\.html|offline/index\\.html`),
    gate: "fixed set: not-found page, channel post kit, Search Console verification", links: "none",
    google: "no", exit: "never" },
];

// Retired types: their builders are kept but must not run (lib/hubs.js pruneRetiredListings,
// lib/dated.js pruneWeekPages). A page of these kinds on disk is a regression.
const RETIRED = [
  { id: "films A–Z", match: re(`${ED}films/(?:\\d+/)?index\\.html`) },
  { id: "month archive", match: re(`${ED}(?:new-on-[a-z0-9-]+|${LANGS})/\\d{4}-\\d{2}/index\\.html`) },
  { id: "week snapshot", match: re(`week/[^/]+/index\\.html`) },
];

// Pure: the type of a page, by its path from the site root ("uk/movie/x.html").
function pageTypeOf(rel) {
  const p = String(rel).replace(/\\/g, "/").replace(/^\//, "");
  for (const r of RETIRED) if (r.match.test(p)) return { id: r.id, retired: true };
  for (const t of PAGE_TYPES) if (t.match.test(p)) return { id: t.id, retired: false };
  return null;
}

// The pages on disk that match no allowed type, or a retired one.
function unlistedPages(files) {
  const unknown = [], retired = [];
  for (const rel of files || []) {
    const t = pageTypeOf(rel);
    if (!t) unknown.push(rel); else if (t.retired) retired.push(rel);
  }
  return { unknown, retired };
}

module.exports = { PAGE_TYPES, RETIRED, pageTypeOf, unlistedPages };
