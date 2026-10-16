// ============================================================================
// merges.js — duplicate film pages folded into one, without breaking a URL (Oct 2026).
//
// A film can end up with two pages in one edition when TMDB renames it after its page was
// built ("Drishyam 3" became "Drishyam: The Conclusion"). The two then rank against each other,
// and can disagree: the old page claimed Prime Video since 15 Aug for a film that opened in
// cinemas on 2 Oct. merges.json (on main, reviewed by hand) names each duplicate and the page
// it folds into: { "<edition>": { "<duplicate slug>": "<surviving slug>" } }.
//
// GitHub Pages has no server-side redirects, and deleting the old URL would turn every link to
// it into a 404. So the build does three things:
//   1. removeMergedPages, first thing: the duplicate leaves the disk (and the manifest), so
//      every step that discovers film pages by listing files (sweeps, facts, sitemap, search,
//      hreflang, links) sees one page per film without knowing merges exist;
//   2. retargetMergedLinks, before the dead-link repair: links to the duplicate point at the
//      surviving page instead of being stripped;
//   3. writeMergeStubs, last, after the sitemap: the old URL becomes a small page with a
//      0-second refresh, a canonical tag to the surviving page and a visible link. It is in no
//      sitemap and no cluster, and the next build removes it again in step 1.
// A merge whose surviving page is missing is skipped entirely: the duplicate stays as it is.
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { COUNTRIES, escHtml } = require("./core.js");
const { countryNameFor } = require("./rules.js");

const MERGES_FILE = "merges.json";
const SITE = "https://filmychill.com";
const filmRel = (code, slug) => `${code === "in" ? "movie" : `${code}/movie`}/${slug}.html`;
const filmUrlPath = (code, slug) => `/${filmRel(code, slug)}`;

function loadMerges(root = ".") {
  try { return JSON.parse(fs.readFileSync(path.join(root, MERGES_FILE), "utf8")) || {}; } catch { return {}; }
}

// Pure-ish: the merges that can apply now, as [{ code, dup, to }]. Skips a merge into itself,
// a chain (a survivor that is itself merged away) and one whose surviving page is not on disk.
function activeMerges(merges, { root = "." } = {}) {
  const out = [];
  for (const [code, m] of Object.entries(merges || {})) {
    for (const [dup, to] of Object.entries(m || {})) {
      if (!dup || !to || dup === to || (m[to] && m[to] !== to)) continue;
      if (!fs.existsSync(path.join(root, filmRel(code, to)))) continue;
      out.push({ code, dup, to });
    }
  }
  return out;
}

// Step 1. Returns how many duplicate files were removed.
function removeMergedPages(active, { root = "." } = {}) {
  let n = 0;
  for (const { code, dup } of active) {
    const p = path.join(root, filmRel(code, dup));
    if (fs.existsSync(p)) { fs.rmSync(p); n++; }
  }
  return n;
}
function dropMergedEntries(manifest, active) {
  let n = 0;
  for (const { code, dup } of active) if (manifest && manifest[code] && manifest[code][dup]) { delete manifest[code][dup]; n++; }
  return n;
}

// Step 2. Every href/src (site-relative or absolute) to a duplicate now names its survivor.
// hreflang lines are left to the cluster sync, which rebuilds them from the pages on disk.
function retargetMergedLinks(files, active, { root = "." } = {}) {
  if (!active.length) return { pages: 0, links: 0 };
  const map = new Map();
  for (const { code, dup, to } of active) {
    map.set(filmUrlPath(code, dup), filmUrlPath(code, to));
    map.set(`${SITE}${filmUrlPath(code, dup)}`, `${SITE}${filmUrlPath(code, to)}`);
  }
  // Attributes, and the "url" of a structured-data list item (people, month and hub pages list
  // films as ItemList entries: 65 of them named a merged page, Oct 2026).
  const re = new RegExp(`(href|src)="(${[...map.keys()].map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})"`, "g");
  const reLd = new RegExp(`"url":"(${[...map.keys()].filter((k) => k.startsWith(SITE)).map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})"`, "g");
  const res = { pages: 0, links: 0 };
  for (const rel of files) {
    const file = path.join(root, rel);
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    let n = 0;
    const out = html.split("\n").map((line) => (/<link rel="alternate" hreflang=/.test(line) ? line
      : line.replace(re, (m, attr, url) => { n++; return `${attr}="${map.get(url)}"`; })
        .replace(reLd, (m, url) => { n++; return `"url":"${map.get(url)}"`; }))).join("\n");
    if (n) { fs.writeFileSync(file, out); res.pages++; res.links += n; }
  }
  return res;
}

// Pure: the page left at a duplicate's URL.
function mergeStubHtml({ code, to, title }) {
  const e = escHtml;
  const cfg = COUNTRIES.find((c) => c.code === code) || { code };
  const country = countryNameFor(cfg);
  const url = `${SITE}${filmUrlPath(code, to)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} has moved | FilmyChill</title>
<link rel="canonical" href="${e(url)}">
<meta http-equiv="refresh" content="0; url=${e(filmUrlPath(code, to))}">
<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:560px;margin:48px auto;padding:0 18px;color:#1A1633;background:#FFF7EC}a{color:#4038C7;font-weight:700}small{color:#6B6890}</style>
</head>
<body>
<!--FC:merged-->
<h1>${e(title)} has moved</h1>
<p>${e(title)} now has a single page on FilmyChill, with its verdict, cast, runtime and where to watch it in ${e(country)}. This address was an older copy of it.</p>
<p><a href="${e(filmUrlPath(code, to))}">Go to ${e(title)} — where to watch and review →</a></p>
<p><small>If you are not taken there automatically, use the link above. Bookmarks to this address keep working.</small></p>
</body>
</html>
`;
}

// Step 3. Writes the stub at every duplicate's URL whose survivor is still on disk at the end.
function writeMergeStubs(active, { root = "." } = {}) {
  let n = 0;
  for (const { code, dup, to } of active) {
    const survivor = path.join(root, filmRel(code, to));
    let h;
    try { h = fs.readFileSync(survivor, "utf8"); } catch { continue; }
    const ld = /"@type":"(?:Movie|TVSeries)","name":"([^"]+)"/.exec(h) || /"name":"([^"]+)","@type":"(?:Movie|TVSeries)"/.exec(h);
    const h1 = /<h1[^>]*>([^<]+)<\/h1>/.exec(h);
    const title = (ld ? ld[1] : h1 ? h1[1].replace(/\s*\(\d{4}\)\s*$/, "") : to).replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim();
    fs.writeFileSync(path.join(root, filmRel(code, dup)), mergeStubHtml({ code, to, title }));
    n++;
  }
  return n;
}

module.exports = { MERGES_FILE, activeMerges, dropMergedEntries, loadMerges, mergeStubHtml, removeMergedPages, retargetMergedLinks, writeMergeStubs };
