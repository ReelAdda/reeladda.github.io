// ============================================================================
// rowsync.js — a list row says what its film page says at the END of the build (20 Nov 2026).
//
// A row takes its verdict from the film page as the page stands when the list is written
// (lib/pagekit.js withShownScore). The language pages and the weekly lists are written early in
// the build; the score sweep runs later and can change a page's verdict in the same run. The row
// then stayed one build behind, and the list-row audit turned that build red with the site
// already published. Twice on Titanic (Tamil, 13 Nov): on 17 Nov, and on 20 Nov when the sweep
// gave its page the critics' verdict on day seven while the Tamil page, written an hour before,
// still said "Too early". A red build also skips that run's arrival alerts.
//
// So after the last page writer and before the audit, every row whose verdict pill differs from
// its page is redrawn from the page: the pill and the evidence label beside it, nothing else in
// the row. The audit (lib/audit.js) still runs after it and stays read-only; it now reports only
// a mismatch this pass could not settle.
// ============================================================================
"use strict";

const fs = require("fs");
const { pageScore } = require("./graph.js");
const { rowScoreLine } = require("./meter.js");
const { listingPages } = require("./audit.js");

const VERDICTS = /^(Must watch|Worth a watch|Skip)$/;
const ROW = /<a class="row" href="(\/(?:[a-z]{2}\/)?movie\/([^"\/]+)\.html)">([\s\S]*?)<\/a>/g;
// The pill and the evidence label after it, as lib/meter.js rowScoreLine writes them. Whatever
// follows inside the same line (trailer views) is kept.
const SCORE = /<span class="vpill[^"]*">(?:<svg[\s\S]*?<\/svg>)?([^<]+)<\/span>(?: <span class="rev">[^<]*<\/span>)?/;

// Pure apart from `read`: one listing page with its rows brought in line. `entryOf(slug)` gives
// the page's manifest entry (for the release date behind "Too early" / "Not enough ratings").
function syncRows(listHtml, { read = (p) => fs.readFileSync(p, "utf8"), entryOf = () => null, cache = new Map() } = {}) {
  let changed = 0;
  const html = String(listHtml).replace(ROW, (whole, href, slug, inner) => {
    const m = SCORE.exec(inner);
    if (!m) return whole;
    if (!cache.has(href)) {
      let page = null;
      try { page = pageScore(read(href.replace(/^\//, ""))); } catch { /* page missing: another check's job */ }
      cache.set(href, page);
    }
    const page = cache.get(href);
    if (!page) return whole;
    const shown = m[1].trim();
    const rowVerdict = VERDICTS.test(shown) ? shown : null;
    const pageVerdict = (page.fcScore && page.fcScore.verdict) || null;
    if (rowVerdict === pageVerdict) return whole;
    const e = entryOf(slug) || {};
    const item = { slug, kind: e.kind || "movie", released: e.released || null, rating: page.rating ?? null, votes: page.votes || 0, ...(page.fcScore ? { fcScore: page.fcScore } : {}) };
    const line = rowScoreLine(item);                                  // <div class="rm">pill[ label]</div>
    const fresh = line.replace(/^<div class="rm">/, "").replace(/<\/div>$/, "");
    changed++;
    return whole.replace(m[0], () => fresh);
  });
  return { html, changed };
}

// Every edition's listing pages (the same set the audit reads). Returns { pages, rows }.
function syncListingRows(countries, manifest = {}) {
  const res = { pages: 0, rows: 0, examples: [] };
  for (const cfg of countries) {
    const cache = new Map(), m = manifest[cfg.code] || {};
    for (const p of listingPages(cfg.code)) {
      let html;
      try { html = fs.readFileSync(p, "utf8"); } catch { continue; }
      if (!html.includes('<a class="row"')) continue;
      const r = syncRows(html, { entryOf: (slug) => m[slug], cache });
      if (!r.changed) continue;
      fs.writeFileSync(p, r.html);
      res.pages++; res.rows += r.changed;
      if (res.examples.length < 3) res.examples.push(`/${p.replace(/index\.html$/, "")}`);
    }
  }
  return res;
}

module.exports = { syncRows, syncListingRows };
