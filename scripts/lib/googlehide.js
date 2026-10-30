// ============================================================================
// googlehide.js — back-catalogue pages Google has never shown, hidden from Google only (Oct 2026).
//
// Why: 14,654 of the site's 18,500 film pages are back-catalogue pages built in Sept–Oct 2026.
// In the 30 days before the 22 Oct drop they earned 1.1 impressions a page against 16.5 for
// recent releases, and 76% of even the September ones had no impression in 90 days. Google
// judges a site as a whole; thousands of pages it never shows weigh on the rest. So the ones
// with no impressions leave Google's index and the sitemaps, and Google sees a smaller site
// where every page has earned its place.
//
// What: a frozen list (google-hidden.json, written once by scripts/make-google-hidden.js) and a
// rollout share (rollout.json "google-hide"). A listed page in the share gets
// <meta name="googlebot" content="noindex"> — Google only: Bing's traffic was steady through the
// drop, so Bing keeps the page — and, because lib/graph.js and lib/sitemap.js read that tag, it
// leaves the hreflang clusters and the sitemaps in the same build. The page stays on the site,
// linked as before, for visitors and Bing.
//
// Never hidden, whatever the list says: a page that's no longer a catalogue page, or one whose
// film just arrived on a platform (lib/sitemap.js isNewReleaseEntry — that is news).
// Reversible: a page outside the share (or the share set back to 0) loses the tag next build.
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { inRollout } = require("./rollout.js");

const HIDE_FEATURE = "google-hide";
const HIDE_FILE = "google-hidden.json";
const GOOGLEBOT_TAG = '<meta name="googlebot" content="noindex">';
// SAME RULES FOR BING (27 Oct 2026, the owner: "I want Bing to follow the same quality parameters
// I set for Google"). A hidden page carries Bing's own tag too, so Bing and the engines built on
// its index (Yahoo, DuckDuckGo, Ecosia) drop it as Google does. Kept as crawler-named tags rather
// than one robots noindex: "robots noindex" means an empty page to the rest of the build (people
// counts, merges, audits), and these pages aren't empty.
const BINGBOT_TAG = '<meta name="bingbot" content="noindex">';
const HIDE_TAG = `${GOOGLEBOT_TAG}\n${BINGBOT_TAG}`;
// The head tag any noindex check must honour (robots for every crawler, googlebot for Google).
const NOINDEX_META = /<meta name="(?:robots|googlebot)" content="[^"]*noindex/;

let cached = null;
function loadHidden(file = HIDE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { pages: {} }; }
}
function hiddenConfig() { return cached || (cached = loadHidden()); }
// Tests: use this list instead of the file (null goes back to the file).
function useHiddenList(list) { cached = list || null; }

// Would this page be hidden at 100%? Listed, and not a fresh arrival; a weekly-list page (not a
// catalogue page) only once its film is WEEKLY_HIDE_DAYS old — the monthly roll (lib/keeplean.js)
// lists those, and this re-checks the age so a stale list can't hide a recent release.
const WEEKLY_HIDE_DAYS = 120;
const setCache = new WeakMap();
function googleEligible(code, slug, entry, { list = hiddenConfig(), today = new Date().toISOString().slice(0, 10) } = {}) {
  const xs = list && list.pages && list.pages[code];
  if (!Array.isArray(xs)) return false;
  if (!setCache.has(xs)) setCache.set(xs, new Set(xs));
  if (!setCache.get(xs).has(slug)) return false;
  if (!entry) return false;
  if (!entry.catalog) {
    const rel = Date.parse(`${String(entry.released || "").slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(rel) || (Date.parse(`${today}T00:00:00Z`) - rel) / 864e5 <= WEEKLY_HIDE_DAYS) return false;
  }
  const { isNewReleaseEntry } = require("./sitemap.js");
  return !isNewReleaseEntry(entry, today);
}
// Is this film page on the hide list and in the share? For page builders that have no manifest entry
// at hand (lib/graph.js related films, lib/evergreen.js platform lists): links from pages Google
// sees go to pages Google sees (27 Oct 2026: 42% of internal links pointed at hidden pages).
function listedHidden(code, slug, { list = hiddenConfig() } = {}) {
  const xs = list && list.pages && list.pages[code];
  if (!Array.isArray(xs)) return false;
  if (!setCache.has(xs)) setCache.set(xs, new Set(xs));
  return setCache.get(xs).has(slug) && inRollout(HIDE_FEATURE, slug);
}
// Is this page hidden from Google on this build? (Eligible, and in the rollout share.)
function googleHidden(code, slug, entry, opts = {}) {
  return googleEligible(code, slug, entry, opts) && inRollout(HIDE_FEATURE, slug);
}

// Pure: the page with the hide tags (Google's and Bing's, after the robots tag, else the
// description). Idempotent; a page carrying only Google's tag (hidden before 27 Oct) gains Bing's.
function addGooglebotNoindex(html) {
  const s = String(html);
  if (s.includes(HIDE_TAG)) return s;
  const clean = removeGooglebotNoindex(s);
  const m = /<meta name="robots" content="[^"]*">/.exec(clean) || /<meta name="description" content="[^"]*">/.exec(clean);
  return m ? clean.slice(0, m.index + m[0].length) + "\n" + HIDE_TAG + clean.slice(m.index + m[0].length) : s;
}
// Pure: the page without them — the exact inverse (either form).
function removeGooglebotNoindex(html) {
  let s = String(html);
  for (const t of [BINGBOT_TAG, GOOGLEBOT_TAG]) s = s.split("\n" + t).join("").split(t).join("");
  return s;
}

// The pass over film pages, after the last page writer and before the hreflang and sitemap
// passes (both read the tag).
function applyGoogleHide(files, manifest, { root = ".", hidden = googleHidden, eligible = googleEligible, extra = new Set() } = {}) {
  const res = { pages: 0, eligible: 0, hidden: 0, nearCopies: 0, changed: 0 };
  for (const rel of files) {
    const m = /^(?:([a-z]{2})\/)?movie\/([^/]+)\.html$/.exec(String(rel).replace(/\\/g, "/"));
    if (!m) continue;
    const code = m[1] || "in", slug = m[2];
    const file = path.join(root, rel);
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    res.pages++;
    const entry = ((manifest || {})[code] || {})[slug];
    if (eligible(code, slug, entry)) res.eligible++;   // the dry run: what 100% would hide
    const listed = hidden(code, slug, entry);
    const copy = !listed && extra.has(`${code}/${slug}`);   // a near-copy of a sister edition (nearCopyEditions)
    const on = listed || copy;
    if (on) res.hidden++;
    if (copy) res.nearCopies++;
    const next = on ? addGooglebotNoindex(html) : removeGooglebotNoindex(html);
    if (next !== html) { fs.writeFileSync(file, next); res.changed++; }
  }
  return res;
}

// PEOPLE PAGES (25 Oct 2026). The same Google-only tag on actor pages with no impressions in the
// window: google-hidden.json "paths" lists them by address ("people/abhay-deol/",
// "uk/people/x/"). lib/sitemap.js leaves a tagged people page out, as it does a film page.
function peoplePageFiles(root = ".") {
  const out = [];
  const add = (base) => {
    let names;
    try { names = fs.readdirSync(path.join(root, base)); } catch { return; }
    if (fs.existsSync(path.join(root, base, "index.html"))) out.push(`${base}/index.html`);
    for (const n of names) if (fs.existsSync(path.join(root, base, n, "index.html"))) out.push(`${base}/${n}/index.html`);
  };
  add("people");
  let tops = [];
  try { tops = fs.readdirSync(root); } catch { /* none */ }
  for (const t of tops) if (/^[a-z]{2}$/.test(t)) add(`${t}/people`);
  if (fs.existsSync(path.join(root, "embed", "index.html"))) out.push("embed/index.html");   // see ALWAYS_HIDDEN
  return out;
}
// Hidden whatever the list says (25 Oct 2026, the owner): every people page (none are created any
// more, and the 190 that had impressions were thin: median 236 words) and the embed instructions,
// a tool page for site owners (91 words).
const ALWAYS_HIDDEN = [/^(?:[a-z]{2}\/)?people\//, /^embed\/$/];
function pathHidden(rel, { list = hiddenConfig() } = {}) {
  const key = String(rel).replace(/\\/g, "/").replace(/index\.html$/, "");
  const xs = (list && list.paths) || [];
  if (!setCache.has(xs)) setCache.set(xs, new Set(xs));
  return (ALWAYS_HIDDEN.some((re) => re.test(key)) || setCache.get(xs).has(key)) && inRollout(HIDE_FEATURE, key);
}
function applyGoogleHidePaths(files, { root = ".", hidden = pathHidden } = {}) {
  const res = { pages: 0, hidden: 0, changed: 0 };
  for (const rel of files) {
    const file = path.join(root, rel);
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    res.pages++;
    const on = hidden(rel);
    if (on) res.hidden++;
    const next = on ? addGooglebotNoindex(html) : removeGooglebotNoindex(html);
    if (next !== html) { fs.writeFileSync(file, next); res.changed++; }
  }
  return res;
}

// ============================================================================
// NEAR-COPY EDITIONS (25 Oct 2026, the owner's call: "option B"). One film's editions differ by
// platform, dates, certificate and prices, but in neighbouring markets with the same platform and
// date they don't: a scan found 702 edition pairs over 80% alike and 29 over 90% (Udta Teer in
// Malaysia and Singapore, 95%). Every edition stays on the site for its visitors; Google sees one.
//
// Each build: the visible editions of each film (same TMDB id) are compared on their main text
// (5-word shingles, Jaccard). Editions at NEAR_COPY or more form a group; the one with the most
// Search Console clicks, then impressions (search-top.json), then the earliest market in
// COUNTRIES, stays visible and the rest get the Google-only tag. Recomputed every build, so an
// edition that gains a local difference (its own platform, date or price) is visible again.
// ============================================================================
const NEAR_COPY = 0.9;
function mainText(html) {
  let s = String(html).replace(/[\s\S]*?<body[^>]*>/, "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<footer[\s\S]*?<\/footer>/g, " ").replace(/<nav[\s\S]*?<\/nav>/g, " ").replace(/<div class="top(?: [^"]*)?">[\s\S]*?<\/div>/, " ");   // "top v3" too (30 Oct 2026): the v3 header was compared as text
  return s.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}
function shingleSet(text) {
  const w = text.split(" "); const out = new Set();
  for (let i = 0; i + 5 <= w.length; i++) out.add(w.slice(i, i + 5).join(" "));
  return out;
}
function similarity(a, b) { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); }

// Returns Set("code/slug") of editions to hide. `skip(code, slug, entry)` marks pages already
// hidden or noindexed (never compared, never chosen as the visible one).
function nearCopyEditions(files, manifest, { root = ".", threshold = NEAR_COPY, skip = () => false, top = null, order = null } = {}) {
  const { COUNTRIES } = require("./core.js");
  const rank = order || COUNTRIES.map((c) => c.code);
  let searchTop = top;
  if (!searchTop) { try { searchTop = JSON.parse(fs.readFileSync(path.join(root, "search-top.json"), "utf8")); } catch { searchTop = { pages: {} }; } }
  const perf = (code, slug) => { const r = ((searchTop.pages || {})[code] || []).find((x) => x[0] === slug); return r ? r[1] * 1e6 + r[2] : 0; };
  const byFilm = new Map();
  for (const rel of files) {
    const m = /^(?:([a-z]{2})\/)?movie\/([^/]+)\.html$/.exec(String(rel).replace(/\\/g, "/"));
    if (!m) continue;
    const code = m[1] || "in", slug = m[2];
    const entry = ((manifest || {})[code] || {})[slug];
    if (!entry || !entry.tmdbId || skip(code, slug, entry)) continue;
    const key = `${entry.kind === "tv" ? "tv" : "movie"}:${entry.tmdbId}`;
    if (!byFilm.has(key)) byFilm.set(key, []);
    byFilm.get(key).push({ code, slug, rel });
  }
  const hide = new Set();
  for (const eds of byFilm.values()) {
    if (eds.length < 2) continue;
    const pages = [];
    for (const x of eds) {
      let html; try { html = fs.readFileSync(path.join(root, x.rel), "utf8"); } catch { continue; }
      if (NOINDEX_META.test(html.slice(0, 4096).replace(GOOGLEBOT_TAG, ""))) continue;   // noindexed for every crawler
      pages.push({ ...x, sh: shingleSet(mainText(html)) });
    }
    // Groups of editions joined by near-copy pairs (union-find).
    const parent = pages.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < pages.length; i++) for (let j = i + 1; j < pages.length; j++) {
      if (similarity(pages[i].sh, pages[j].sh) >= threshold) parent[find(i)] = find(j);
    }
    const groups = new Map();
    pages.forEach((p, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); });
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => perf(b.code, b.slug) - perf(a.code, a.slug) || rank.indexOf(a.code) - rank.indexOf(b.code));
      for (const p of g.slice(1)) if (inRollout(HIDE_FEATURE, p.slug)) hide.add(`${p.code}/${p.slug}`);
    }
  }
  return hide;
}

module.exports = {
  NEAR_COPY, WEEKLY_HIDE_DAYS, listedHidden, mainText, nearCopyEditions, similarity, shingleSet,
  applyGoogleHidePaths, pathHidden, peoplePageFiles, BINGBOT_TAG, HIDE_TAG, GOOGLEBOT_TAG, HIDE_FEATURE, HIDE_FILE, NOINDEX_META, addGooglebotNoindex, applyGoogleHide, googleEligible, googleHidden, loadHidden, removeGooglebotNoindex, useHiddenList };
