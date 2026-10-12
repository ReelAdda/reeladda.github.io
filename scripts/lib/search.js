// ============================================================================
// search.js (server side) — the site search (Oct 2026).
//
// Most visitors land on one film page from a search engine; until now the only way on to
// another title was browsing lists. Search runs entirely in the browser (/js/search.js) over
// one small file per edition, written here every run:
//
//     /search/<code>.json   { v, films: [[title, slug, year, tv, language, verdict]], people: [[name, slug]] }
//
// Only pages that exist on disk are listed, so a result never leads to a 404. About 20 KB
// gzipped per edition, and it is fetched only when a reader opens the search box.
//
// Every page gets one deferred script tag at the end of its body, added after the last page
// writer of the run (addSearchToPages), so frozen pages, rebuilt pages and hand-written pages
// all carry it. The script places its own button: in the purple top bar on most pages, under
// the header on the homepage, above the heading elsewhere. Pages whose security policy can't
// load a same-site script or fetch, and the embed widget (it renders inside other sites),
// are left alone.
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { COUNTRIES } = require("./core.js");

const SEARCH_DIR = "search";
const SEARCH_TAG = '<script src="/js/search.js" defer></script>';
const FORMAT = 1;

const filmDir = (code) => (code === "in" ? "movie" : `${code}/movie`);
const peopleDir = (code) => (code === "in" ? "people" : `${code}/people`);
const VERDICT = { "Must watch": "M", "Worth a watch": "W", "Skip": "S" };

// Pure: one edition's index from its manifest entries. `exists(slug)` answers whether the
// film page is on disk; `people` is [[name, slug]] for its person pages.
function editionIndex(entries, { exists = () => true, people = [] } = {}) {
  const films = [];
  for (const [slug, e] of Object.entries(entries || {})) {
    if (!e || !e.title || !exists(slug)) continue;
    const year = /^\d{4}/.test(e.released || "") ? Number(e.released.slice(0, 4)) : 0;
    films.push([String(e.title), slug, year, e.kind === "tv" ? 1 : 0, e.lang || "", VERDICT[e.fcs && e.fcs.v] || ""]);
  }
  films.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const ppl = people.filter((p) => p && p[0] && p[1]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { v: FORMAT, films, people: ppl };
}

const decode = (s) => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// An edition's person pages as [[name, slug]]: the name is the page heading up to its colon
// ("Rajinikanth: films streaming in India").
function peopleOf(code, root = ".") {
  const dir = path.join(root, peopleDir(code));
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const slug of names) {
    let html;
    try { html = fs.readFileSync(path.join(dir, slug, "index.html"), "utf8"); } catch { continue; }
    const h1 = /<h1>([^<]*)<\/h1>/.exec(html);
    const name = h1 ? decode(h1[1]).split(":")[0].trim() : "";
    if (name) out.push([name, slug]);
  }
  return out;
}

// Writes /search/<code>.json for every edition. A file is rewritten only when its content
// changed. Returns counts for the build log.
function writeSearchIndexes(manifest, { root = ".", countries = COUNTRIES } = {}) {
  const res = { editions: 0, films: 0, people: 0, written: 0 };
  fs.mkdirSync(path.join(root, SEARCH_DIR), { recursive: true });
  for (const c of countries) {
    let onDisk;
    try { onDisk = new Set(fs.readdirSync(path.join(root, filmDir(c.code))).filter((n) => n.endsWith(".html")).map((n) => n.slice(0, -5))); }
    catch { onDisk = new Set(); }
    const idx = editionIndex(manifest[c.code], { exists: (s) => onDisk.has(s), people: peopleOf(c.code, root) });
    const file = path.join(root, SEARCH_DIR, `${c.code}.json`);
    const json = JSON.stringify(idx);
    let prev = null;
    try { prev = fs.readFileSync(file, "utf8"); } catch { /* new */ }
    if (prev !== json) { fs.writeFileSync(file, json); res.written++; }
    res.editions++;
    res.films += idx.films.length;
    res.people += idx.people.length;
  }
  return res;
}

// Pure: whether a page's security policy lets it load /js/search.js and fetch the index.
// No policy at all allows both.
function policyAllowsSearch(html) {
  const m = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
  if (!m) return true;
  const dir = {};
  for (const part of m[1].split(";")) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) dir[name] = vals;
  }
  const allows = (name) => {
    const v = dir[name] || dir["default-src"];
    return !v || v.includes("'self'");
  };
  return allows("script-src") && allows("connect-src");
}

// Pure: the page with the search script at the end of its body. Pages without a </body>, or
// whose policy would block it, come back unchanged; so does a page that already has it.
function ensureSearchScript(html) {
  const s = String(html);
  if (s.includes(SEARCH_TAG) || !s.includes("</body>") || !policyAllowsSearch(s)) return s;
  const at = s.lastIndexOf("</body>");
  return `${s.slice(0, at)}${SEARCH_TAG}\n${s.slice(at)}`;
}

// The pass over every page, after the last page writer of the run. The embed widget renders
// inside other people's sites and post.html is a hand-kept draft: both are skipped.
function addSearchToPages(files, { root = "." } = {}) {
  const res = { pages: 0, added: 0 };
  for (const rel of files) {
    const r = String(rel).replace(/\\/g, "/");
    if (/(?:^|\/)embed\//.test(r) || r === "post.html") continue;
    const file = path.join(root, rel);
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    res.pages++;
    const next = ensureSearchScript(html);
    if (next !== html) { fs.writeFileSync(file, next); res.added++; }
  }
  return res;
}

module.exports = { addSearchToPages, editionIndex, ensureSearchScript, peopleOf, policyAllowsSearch, writeSearchIndexes, SEARCH_DIR, SEARCH_TAG };
