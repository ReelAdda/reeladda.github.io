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
const { queueFacts } = require("./factsq.js");
const { simGridHtml } = require("./filmpage.js");

// Bump when relatedFilms' rules change, so every old page is redone once.
// 2 = language affinity, shared cast/director, lead genre (Sept 2026).
// 3 = pages Google can see first (27 Oct 2026), in stages: only films in the "visible-similar"
//     rollout share are redone, and the rest follow as the share grows.
const REL_VERSION = 3;

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
    const { inRollout } = require("./rollout.js");
    const { VISIBLE_SIMILAR } = require("./filmpage.js");
    const { listedHidden } = require("./googlehide.js");
    const due = Object.entries(m).filter(([slug, e]) => e && (e.catalog || e.archivedOn) && (e.rel || 1) < REL_VERSION
      && ((e.rel || 1) < 2 || inRollout(VISIBLE_SIMILAR, slug)));
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
      const picks = relatedFilms(seed, index, 6, inRollout(VISIBLE_SIMILAR, slug) ? { visible: (c) => !listedHidden(cfg.code, c.slug) } : {});
      // The same picks as facts (lib/factsq.js), in the shape the page's facts carry them.
      queueFacts(cfg.code, slug, { similar: picks.map((f) => ({ title: f.title, slug: f.slug, poster: f.poster || "", language: f.language || "", kind: f.kind || "movie" })) });
      // Whatever the rules allow, even one or two — never the old picks they'd now reject.
      // Nothing that qualifies at all: the section goes rather than stay wrong.
      const next = picks.length ? replaceRelated(html, simGridHtml(picks, cfg.code)) : html.replace(SECTION_RE, "");
      if (next !== html) { fs.writeFileSync(file, next); res.updated++; }
    }
  }
  return res;
}

// ============================================================================
// EVERY NEW TITLE GETS LINKS (26 Oct 2026, the owner: "genuine new titles must have proper links
// so Google can crawl them and they build authority"). A link audit of the pages Google sees found
// 2,249 titles released in the last FRESH_DAYS days or still to come: 79% had 3+ links in from
// pages Google can see, but 208 had one (the weekly page's release calendar) and one had none —
// mostly regional films in smaller editions, off the capped homepage and hub lists within days.
//
// Each build, a new title with fewer than FRESH_MIN_LINKS links in (counted from the pages on disk
// that Google can see) is added to the "If you liked this" section of its closest older film
// pages in the same edition: same rules as the section itself (lib/graph.js relatedScore, close
// neighbours only — a related language or shared people), visible pages only, frozen pages only
// (live pages recompute the section every build), at most one new title per host page per build,
// and recorded in the host's facts so the render keeps it. Very old titles are left as they are.
// ============================================================================
const FRESH_DAYS = 60;
const FRESH_MIN_LINKS = 3;

function ensureFreshLinks(pagesManifest, countries, { root = ".", now = Date.now(), hidden = null, files = null } = {}) {
  const path = require("path");
  const { relatedScore, isClose } = require("./graph.js");
  const { filmPageFiles, sitePageFiles } = require("./stylesheets.js");
  const G = require("./googlehide.js");
  const isHidden = hidden || ((code, slug, entry) => G.googleHidden(code, slug, entry));
  const B = "https://filmychill.com/";
  const res = { fresh: 0, weak: 0, added: 0, stillWeak: 0 };
  // Links in, from every page on disk Google can see.
  const inbound = new Map();
  const all = files || [...filmPageFiles(root), ...sitePageFiles(root)];
  for (const rel of all) {
    let h; try { h = fs.readFileSync(path.join(root, rel), "utf8"); } catch { continue; }
    if (G.NOINDEX_META.test(h.slice(0, 4096))) continue;
    const self = "/" + String(rel).replace(/\\/g, "/").replace(/index\.html$/, "");
    const seen = new Set();
    for (const m of h.matchAll(/<a\b[^>]*href="([^"#?]+)/g)) {
      let l = m[1]; if (l.startsWith(B)) l = "/" + l.slice(B.length);
      if (!l.startsWith("/") || l === self || seen.has(l)) continue;
      seen.add(l); inbound.set(l, (inbound.get(l) || 0) + 1);
    }
  }
  const day = (d) => Date.parse(`${String(d || "").slice(0, 10)}T00:00:00Z`);
  for (const cfg of countries || []) {
    const code = cfg.code;
    const m = (pagesManifest || {})[code] || {};
    const index = filmIndexFor(cfg);
    const visible = index.filter((f) => !isHidden(code, f.slug, m[f.slug]));
    const fresh = visible.filter((f) => { const t = day(f.released); return Number.isFinite(t) && (now - t) / 864e5 <= FRESH_DAYS; });
    const hosts = visible.filter((f) => { const e = m[f.slug]; return e && (e.archivedOn || e.catalog); });
    const used = new Set();
    for (const t of fresh) {
      res.fresh++;
      const href = filmPagePath(code, t.slug);
      let have = inbound.get(href) || 0;
      if (have >= FRESH_MIN_LINKS) continue;
      res.weak++;
      const picks = hosts
        .filter((h) => h.slug !== t.slug && !used.has(h.slug) && isClose(h, t))
        .map((h) => ({ h, s: relatedScore(h, t) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || (a.h.slug < b.h.slug ? -1 : 1));
      for (const { h } of picks) {
        if (have >= FRESH_MIN_LINKS) break;
        const file = path.join(root, filmPagePath(code, h.slug).replace(/^\//, ""));
        let html; try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
        const sec = SECTION_RE.exec(html);
        const current = sec ? [...sec[0].matchAll(/href="\/(?:[a-z]{2}\/)?movie\/([^"/]+)\.html"/g)].map((x) => x[1]) : [];
        if (current.includes(t.slug)) continue;
        const bySlug = new Map(index.map((f) => [f.slug, f]));
        const items = [t, ...current.map((s) => bySlug.get(s)).filter(Boolean)];
        if (items.length > 6) {
          // Make room by dropping an OLDER title's card, never another new title's (which would
          // take a link from one new title to give it to another).
          let drop = -1;
          for (let i = items.length - 1; i > 0; i--) { const tt = day(items[i].released); if (!(Number.isFinite(tt) && (now - tt) / 864e5 <= FRESH_DAYS)) { drop = i; break; } }
          if (drop < 0) continue;
          items.splice(drop, 1);
        }
        const list = items.slice(0, 6)
          .map((f) => ({ title: f.title, slug: f.slug, poster: f.poster || "", language: f.language || "", kind: f.kind || "movie" }));
        queueFacts(code, h.slug, { similar: list });   // the render keeps it (lib/factsq.js)
        const next = replaceRelated(html, simGridHtml(list, code));
        if (next !== html) fs.writeFileSync(file, next);
        used.add(h.slug); have++; res.added++;
        inbound.set(href, have);
      }
      if (have < FRESH_MIN_LINKS) res.stillWeak++;
    }
  }
  return res;
}

module.exports = { FRESH_DAYS, FRESH_MIN_LINKS, REL_VERSION, ensureFreshLinks, refreshRelated, replaceRelated };
