// ============================================================================
// writeif.js — save a regenerated page only when its content changed (Oct 2026).
//
// Pages still in the weekly lists are rebuilt on every run, twice a day. Most of them differ
// from yesterday only in their date stamps ("Page updated", "Availability as of", the JSON-LD
// dateModified), yet each rewrite was committed: scheduled builds added about 5 MB to the
// repository apiece, ~16 MB a day. Comparing without the stamps keeps unchanged pages
// byte-for-byte as they are, so git stores nothing new for them, and "Page updated" now means
// the page really changed.
//
// The file on disk has been through the end-of-build pass (lib/stylesheets.js): its styles
// live in a shared /css/ file and its security policy allows that file. A fresh render has the
// styles inline. Both are brought to the same form before comparing, so a genuine style change
// still counts as a change.
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");

const STAMPS = [
  /<div class="meta" style="margin-top:2px;font-size:12\.5px">Page updated [^<]*<\/div>/g,
  /Availability as of [^<—]*— /g,
  /"dateModified":"[^"]*"/g,
  // The date a streaming claim was last written: moves with every rebuild of a streaming page.
  /<!--SW:live=\d{4}-\d{2}-\d{2}-->/g,
  // The last recheck that confirmed it (lib/lifecycle.js restampAvailability); a fresh render has none.
  /<!--SW:checked=\d{4}-\d{2}-\d{2}-->/g,
  // Listing pages' "Updated 11 October 2026 · …" line, in either date order.
  /Updated \d{1,2} [A-Za-z]+\.? \d{4}/g,
  /Updated [A-Za-z]+\.? \d{1,2},? \d{4}/g,
];
const LINK_RE = /<link rel="stylesheet" href="\/css\/(fp-[0-9a-f]{10})\.css">/;

// Pure-ish: the page as it would be compared (styles inline, policy and stamps normalised).
function comparable(html, root = ".") {
  let s = String(html);
  const m = LINK_RE.exec(s);
  if (m) {
    try { s = s.replace(m[0], `<style>${fs.readFileSync(path.join(root, "css", `${m[1]}.css`), "utf8")}</style>`); } catch { /* compare as is */ }
  }
  s = s.replace(/style-src 'self' 'unsafe-inline'/g, "style-src 'unsafe-inline'");
  for (const re of STAMPS) s = s.replace(re, "");
  return s;
}

// Running totals for the build log: how many writes each run saved.
const STATS = { written: 0, kept: 0 };

// Writes `html` to `file` unless the file already holds the same page apart from its stamps.
// Returns true when it wrote.
function writeIfChanged(file, html, { root = "." } = {}) {
  let prev = null;
  try { prev = fs.readFileSync(file, "utf8"); } catch { /* new page */ }
  if (prev != null && comparable(prev, root) === comparable(html, root)) { STATS.kept++; return false; }
  fs.writeFileSync(file, html);
  STATS.written++;
  return true;
}

module.exports = { comparable, writeIfChanged, WRITE_STATS: STATS };
