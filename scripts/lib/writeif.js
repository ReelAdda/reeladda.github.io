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
const { ensureGrow } = require("./grow.js");
const { ensureGa } = require("./ga.js");
const { ensureBrandMark } = require("./brand.js");
const { honestWording, leanTrim } = require("./honest.js");
const { removeGooglebotNoindex } = require("./googlehide.js");

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
  // The search script (lib/search.js), added after every page writer: a fresh render has none yet.
  /<script src="\/js\/search\.js" defer><\/script>\n?/g,
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
  // Grow's loader and origins (lib/grow.js) are added after every page writer: a fresh render
  // has neither yet, and is still the same page. Both sides are compared WITH Grow (adding it is
  // exact and idempotent; taking it out can't tell a directive Grow created from the page's own).
  s = ensureGa(ensureGrow(s, true), true); // and Google Analytics (lib/ga.js), the same way
  s = ensureBrandMark(s); // and the header mark (lib/brand.js)
  s = honestWording(s); // and the streaming-date wording (lib/honest.js): either wording is the same page
  s = leanTrim(s);      // and the lean page's trimmed "not streaming yet" lead (lib/honest.js)
  s = require("./humanprose.js").humanWording(s); // and the plain wording of the sweeps' sentences (lib/humanprose.js)
  s = removeGooglebotNoindex(s); // and the Google-only noindex (lib/googlehide.js), added after the writers
  for (const re of STAMPS) s = s.replace(re, "");
  return s;
}

// Running totals for the build log: how many writes each run saved, and any page refused.
const STATS = { written: 0, kept: 0, refused: [] };

// Pure: what is wrong with a page about to be published, or null (Power-of-Ten audit, Oct
// 2026: the writer used to save whatever it was handed). A page must have content, a title and
// structured data that parses, and must not show a value that leaked from a missing field. When
// enabled, all 17,808 pages on the site passed.
const LEAK_TEXT = /\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/;
const LEAK_ATTR = /="(?:undefined|NaN|\[object Object\])"/;
function pageProblems(html) {
  const s = String(html == null ? "" : html);
  if (s.length < 300) return "nearly empty";
  if (!/<title>[^<]*\S[^<]*<\/title>/.test(s)) return "no title";
  for (const m of s.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(m[1]); } catch { return "structured data that doesn't parse"; }
  }
  const text = s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ");
  const leak = LEAK_TEXT.exec(text) || LEAK_ATTR.exec(s);
  return leak ? `the text "${leak[0]}"` : null;
}

// Writes `html` to `file` unless the file already holds the same page apart from its stamps.
// An HTML page that fails pageProblems is NOT written: the published version stays, and the
// refusal is reported (update.js turns the run red). Returns true when it wrote.
function writeIfChanged(file, html, { root = "." } = {}) {
  if (/\.html$/.test(file)) {
    const why = pageProblems(html);
    if (why) { STATS.refused.push(`${file}: ${why}`); return false; }
  }
  let prev = null;
  try { prev = fs.readFileSync(file, "utf8"); } catch { /* new page */ }
  if (prev != null && comparable(prev, root) === comparable(html, root)) { STATS.kept++; return false; }
  fs.writeFileSync(file, html);
  STATS.written++;
  return true;
}

module.exports = { comparable, pageProblems, writeIfChanged, WRITE_STATS: STATS };
