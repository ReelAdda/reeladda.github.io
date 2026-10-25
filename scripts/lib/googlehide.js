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
// The head tag any noindex check must honour (robots for every crawler, googlebot for Google).
const NOINDEX_META = /<meta name="(?:robots|googlebot)" content="[^"]*noindex/;

let cached = null;
function loadHidden(file = HIDE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { pages: {} }; }
}
function hiddenConfig() { return cached || (cached = loadHidden()); }
// Tests: use this list instead of the file (null goes back to the file).
function useHiddenList(list) { cached = list || null; }

// Would this page be hidden at 100%? (Listed, still a catalogue page, not a fresh arrival.)
const setCache = new WeakMap();
function googleEligible(code, slug, entry, { list = hiddenConfig(), today = new Date().toISOString().slice(0, 10) } = {}) {
  const xs = list && list.pages && list.pages[code];
  if (!Array.isArray(xs)) return false;
  if (!setCache.has(xs)) setCache.set(xs, new Set(xs));
  if (!setCache.get(xs).has(slug)) return false;
  if (!entry || !entry.catalog) return false;
  const { isNewReleaseEntry } = require("./sitemap.js");
  return !isNewReleaseEntry(entry, today);
}
// Is this page hidden from Google on this build? (Eligible, and in the rollout share.)
function googleHidden(code, slug, entry, opts = {}) {
  return googleEligible(code, slug, entry, opts) && inRollout(HIDE_FEATURE, slug);
}

// Pure: the page with the tag (after the robots tag, else the description). Idempotent.
function addGooglebotNoindex(html) {
  const s = String(html);
  if (s.includes(GOOGLEBOT_TAG)) return s;
  const m = /<meta name="robots" content="[^"]*">/.exec(s) || /<meta name="description" content="[^"]*">/.exec(s);
  return m ? s.slice(0, m.index + m[0].length) + "\n" + GOOGLEBOT_TAG + s.slice(m.index + m[0].length) : s;
}
// Pure: the page without it — the exact inverse.
function removeGooglebotNoindex(html) {
  return String(html).split("\n" + GOOGLEBOT_TAG).join("").split(GOOGLEBOT_TAG).join("");
}

// The pass over film pages, after the last page writer and before the hreflang and sitemap
// passes (both read the tag).
function applyGoogleHide(files, manifest, { root = ".", hidden = googleHidden, eligible = googleEligible } = {}) {
  const res = { pages: 0, eligible: 0, hidden: 0, changed: 0 };
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
    const on = hidden(code, slug, entry);
    if (on) res.hidden++;
    const next = on ? addGooglebotNoindex(html) : removeGooglebotNoindex(html);
    if (next !== html) { fs.writeFileSync(file, next); res.changed++; }
  }
  return res;
}

module.exports = { GOOGLEBOT_TAG, HIDE_FEATURE, HIDE_FILE, NOINDEX_META, addGooglebotNoindex, applyGoogleHide, googleEligible, googleHidden, loadHidden, removeGooglebotNoindex, useHiddenList };
