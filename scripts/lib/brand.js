// ============================================================================
// brand.js — the FilmyChill mark (ring + play) beside the wordmark in every page's header.
//
// The mark is the site's rating ring around a play button: an amber arc over a faint track (the
// same colours as the ring on every card), with the play triangle inside. It is drawn inline (no
// extra request) and sized by attributes and inline style, so it needs no stylesheet change —
// archived pages, whose stylesheets are shared and frozen, show it the same as rebuilt ones.
//
// Applied in one pass after the last page writer (addBrandToPages), like Grow and analytics:
//   - the indigo top bar on film, list and hand-written pages: <div class="top"><a …>FILMY<span>CHILL</span></a>
//   - the homepage's large wordmark: <div class="logo">FILMY<span>CHILL</span></div>
// The same files as the app icons and favicon (icon-192.png, icon-512.png, favicon.ico).
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");

const shape = (track, play) =>
  `<circle cx="50" cy="50" r="37" fill="none" stroke="${track}" stroke-width="13"/>`
  + `<circle cx="50" cy="50" r="37" fill="none" stroke="#FFAD1F" stroke-width="13" stroke-linecap="round" stroke-dasharray="176 300" transform="rotate(38 50 50)"/>`
  + `<path d="M42 33 Q40 32 40 35 L40 65 Q40 68 42 67 L66 52.5 Q68 50 66 47.5 Z" fill="${play}"/>`;
// On the indigo top bar: white play, faint white track.
const MARK_TOP = `<svg class="brand-mark" viewBox="0 0 100 100" width="24" height="24" aria-hidden="true" style="flex:none;margin-right:8px">${shape("rgba(255,255,255,.2)", "#FFFFFF")}</svg>`;
// On the homepage's cream: indigo play, the cards' track colour.
const MARK_HOME = `<svg class="brand-mark" viewBox="0 0 100 100" aria-hidden="true" style="width:.92em;height:.92em;flex:none;margin-right:.16em">${shape("#EFE6D6", "#4038C7")}</svg>`;

const TOP_RE = /<div class="top"><a href="([^"]*)">FILMY<span>CHILL<\/span><\/a>/g;
const HOME_RE = /<div class="logo">FILMY<span>CHILL<\/span><\/div>/g;

// Pure: one page with the mark beside its header wordmark. Idempotent; a page without either
// header shape is returned unchanged.
function ensureBrandMark(html) {
  const s = String(html);
  if (s.includes('class="brand-mark"')) return s;
  return s
    .replace(TOP_RE, (m, href) => `<div class="top"><a href="${href}" style="display:inline-flex;align-items:center">${MARK_TOP}FILMY<span>CHILL</span></a>`)
    .replace(HOME_RE, `<div class="logo" style="display:inline-flex;align-items:center">${MARK_HOME}FILMY<span>CHILL</span></div>`);
}

// The pass over every page, after the last page writer. The embed widget renders inside other
// people's sites and post.html is a hand-kept draft: both are skipped.
function addBrandToPages(files, { root = "." } = {}) {
  const res = { pages: 0, changed: 0 };
  for (const rel of files) {
    const r = String(rel).replace(/\\/g, "/");
    if (/(?:^|\/)embed\//.test(r) || r === "post.html") continue;
    const file = path.join(root, rel);
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    res.pages++;
    const next = ensureBrandMark(html);
    if (next !== html) { fs.writeFileSync(file, next); res.changed++; }
  }
  return res;
}

module.exports = { MARK_HOME, MARK_TOP, addBrandToPages, ensureBrandMark };
