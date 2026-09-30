// ============================================================================
// relrefresh.js — brings "If you liked this" on pages that are never rebuilt up to the
// current recommendation rules (lib/graph.js relatedFilms).
//
// Weekly pages pick up new rules on every run. Frozen and back-catalogue pages keep whatever
// was chosen when they were written — which is how a Spanish crime film's page came to
// recommend six Tamil and Hindi action films (Sept 2026). This rewrites that one section,
// once per REL_VERSION, from each page's own JSON-LD (genre, language, year, cast,
// director). No API calls. Nothing else on the page changes.
// ============================================================================
"use strict";

const fs = require("fs");
const { filmPagePath } = require("./core.js");
const { filmIndexFor, relatedFilms } = require("./graph.js");
const { simGridHtml } = require("./filmpage.js");

// Bump when relatedFilms' rules change, so every old page is redone once.
// 2 = language affinity, shared cast/director, lead genre (Sept 2026).
const REL_VERSION = 2;

const SECTION_RE = /<h2>If you liked this<\/h2><div class="simgrid">[\s\S]*?<\/div>(?=\s*(?:<h2>|<a class="btn"|<\/div>\s*<footer))/;

// Pure: replace the section, or add it where the page builder puts it. Returns new HTML.
function replaceRelated(html, section) {
  if (!section) return html;
  if (SECTION_RE.test(html)) return html.replace(SECTION_RE, section);
  for (const anchor of ["<h2>Frequently asked</h2>", '<a class="btn"']) {
    const at = html.indexOf(anchor);
    if (at >= 0) return html.slice(0, at) + section + "\n  " + html.slice(at);
  }
  return html;
}

function refreshRelated(pagesManifest, countries) {
  const res = { checked: 0, updated: 0 };
  for (const cfg of countries || []) {
    const m = (pagesManifest || {})[cfg.code] || {};
    const due = Object.entries(m).filter(([, e]) => e && (e.catalog || e.archivedOn) && (e.rel || 1) < REL_VERSION);
    if (!due.length) continue;
    const index = filmIndexFor(cfg);
    const bySlug = new Map(index.map((f) => [f.slug, f]));
    for (const [slug, e] of due) {
      const seed = bySlug.get(slug);
      const file = filmPagePath(cfg.code, slug).replace(/^\//, "");
      e.rel = REL_VERSION; // settled either way: redone below, or nothing to judge it by
      if (!seed) continue;
      let html;
      try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
      res.checked++;
      const picks = relatedFilms(seed, index, 6);
      // Whatever the rules allow, even one or two — never the old picks they'd now reject.
      // Nothing that qualifies at all: the section goes rather than stay wrong.
      const next = picks.length ? replaceRelated(html, simGridHtml(picks, cfg.code)) : html.replace(SECTION_RE, "");
      if (next !== html) { fs.writeFileSync(file, next); res.updated++; }
    }
  }
  return res;
}

module.exports = { REL_VERSION, refreshRelated, replaceRelated };
