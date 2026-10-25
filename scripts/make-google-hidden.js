#!/usr/bin/env node
// ============================================================================
// make-google-hidden.js — writes google-hidden.json, the frozen list of catalogue pages hidden
// from Google (lib/googlehide.js). Run by hand, once; the build only reads the list.
//
//   node scripts/make-google-hidden.js <service-account-key.json> [--days 90] [--to YYYY-MM-DD]
//
// A page is listed when it is a back-catalogue page (pages-manifest.json `catalog`), its film was
// released more than a year ago, and Search Console shows NO impressions for its address over the
// window. Everything else stays visible: every page Google has shown at least once is kept.
// The list is frozen on purpose: a page doesn't flip in and out as daily data moves.
// ============================================================================
"use strict";

const fs = require("fs");
const { accessToken } = require("./lib/searchtop.js");
const { HIDE_FILE } = require("./lib/googlehide.js");

const SITE = "https://filmychill.com/";
const RECENT_DAYS = 365;

async function pagesWithImpressions(token, from, to) {
  const seen = new Set();
  for (let startRow = 0; ; startRow += 25000) {
    const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ startDate: from, endDate: to, dimensions: ["page"], rowLimit: 25000, startRow, dataState: "all" }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    const rows = j.rows || [];
    for (const x of rows) if (x.impressions > 0) seen.add(x.keys[0]);
    if (rows.length < 25000) return seen;
  }
}

// Pure: the listed pages, per edition.
function hiddenList(manifest, shown, { nowMs = Date.now() } = {}) {
  const out = {};
  for (const [code, pages] of Object.entries(manifest || {})) {
    if (!pages || typeof pages !== "object") continue;
    for (const [slug, e] of Object.entries(pages)) {
      if (!e || typeof e !== "object" || !e.catalog) continue;
      const rel = Date.parse(`${String(e.released || "").slice(0, 10)}T00:00:00Z`);
      if (!Number.isFinite(rel) || (nowMs - rel) / 864e5 <= RECENT_DAYS) continue;
      const url = `${SITE}${code === "in" ? "" : `${code}/`}movie/${slug}.html`;
      if (shown.has(url)) continue;
      (out[code] = out[code] || []).push(slug);
    }
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

// Pure: people pages (by address, "people/x/", "uk/people/x/") with no impressions.
function hiddenPeople(sitemapUrls, shown) {
  return [...new Set(sitemapUrls)]
    .filter((u) => /^https:\/\/filmychill\.com\/(?:[a-z]{2}\/)?people\/(?:[^/]+\/)?$/.test(u) && !shown.has(u))
    .map((u) => u.slice(SITE.length)).sort();
}

// --people: add the people pages to the existing list, leaving the film list as it was frozen.
async function addPeople(token, from, to) {
  const shown = await pagesWithImpressions(token, from, to);
  const idx = await (await fetch(`${SITE}sitemap.xml`)).text();
  const urls = [];
  for (const m of idx.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const x = await (await fetch(m[1])).text();
    for (const n of x.matchAll(/<url><loc>([^<]+)<\/loc>/g)) urls.push(n[1]);
  }
  const file = JSON.parse(fs.readFileSync(HIDE_FILE, "utf8"));
  file.paths = hiddenPeople(urls, shown);
  file.pathsFrom = from; file.pathsTo = to;
  fs.writeFileSync(HIDE_FILE, JSON.stringify(file, null, 1) + "\n");
  console.log(`${HIDE_FILE}: ${file.paths.length} people page(s) added; film list unchanged (${file.total})`);
}

async function main() {
  const args = process.argv.slice(2);
  const keyFile = args.find((a) => a.endsWith(".json"));
  if (!keyFile) { console.error("usage: node scripts/make-google-hidden.js <service-account-key.json> [--days 90] [--to YYYY-MM-DD]"); process.exit(2); }
  const days = Number((args[args.indexOf("--days") + 1]) || 90) || 90;
  const to = args.includes("--to") ? args[args.indexOf("--to") + 1] : new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 864e5).toISOString().slice(0, 10);
  const token = await accessToken(JSON.parse(fs.readFileSync(keyFile, "utf8")));
  if (args.includes("--people")) return addPeople(token, from, to);
  const shown = await pagesWithImpressions(token, from, to);
  const manifest = JSON.parse(fs.readFileSync("pages-manifest.json", "utf8"));
  const pages = hiddenList(manifest, shown);
  const total = Object.values(pages).reduce((n, xs) => n + xs.length, 0);
  fs.writeFileSync(HIDE_FILE, JSON.stringify({
    _about: "Catalogue pages hidden from Google only (googlebot noindex, out of the sitemaps), frozen: back-catalogue, released over a year ago, no Search Console impressions in the window. Bing and visitors still see them. Share switched by rollout.json 'google-hide' (lib/googlehide.js).",
    from, to, pagesWithImpressions: shown.size, total, pages,
  }, null, 1) + "\n");
  console.log(`${HIDE_FILE}: ${total} page(s) listed; ${shown.size} address(es) had impressions ${from}..${to}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { hiddenList, hiddenPeople };
