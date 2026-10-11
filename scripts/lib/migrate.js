// ============================================================================
// migrate.js — frozen pages move, a batch at a time, from "patched HTML" to "facts rendered by
// the live template" (Oct 2026).
//
// Why: every template change used to need a regex migration over ~13,000 frozen pages, and the
// copy drifted anyway (six trust defects on 10 Oct). A page rendered from its facts can't
// drift: each build renders it with today's template, and lib/writeif.js saves it only when
// its content really changed.
//
// How a page moves (migrateBatch):
//   1. its facts are read out of its HTML (lib/facts.js);
//   2. it is rendered from those facts, the way the back catalogue renders a frozen page:
//      buildFilmPage, then the archive chain (past tense, run state, titles, descriptions);
//   3. the reader-facing facts of the old and new page are compared (keyFacts). Identical:
//      the page switches to "rendered" (manifest .rendered, facts in facts/<code>.jsonl).
//      Anything else: it stays as it is and is listed for review. Wording may change; facts
//      may not.
// After that (renderMigrated, every build): the page's facts are read back from it first, so
// whatever the arrival, departure or score sweeps changed during the run carries through;
// the facts store is updated when they moved; the page is rendered from them.
//
// The batch size comes from MIGRATE_BATCH (default 0: nothing moves until it is set).
// ============================================================================
"use strict";

const fs = require("fs");
const { COUNTRIES } = require("./core.js");
const { archivePatchHtml } = require("./archive.js");
const { buildFilmPage } = require("./filmpage.js");
const { filmPageExists } = require("./graph.js");
const { countryNameFor } = require("./rules.js");
const { availabilityText, extractFacts, factsDiff, keyFacts, readFacts, writeFacts } = require("./facts.js");
const { writeIfChanged } = require("./writeif.js");

const dirFor = (code) => (code === "in" ? "movie" : `${code}/movie`);

// Pure-ish (reads which editions have the film): a frozen page from its facts.
function renderFrozen(item, cfg, { asOf, knownSlugs, availability = "" }) {
  const code = cfg.code;
  const cluster = COUNTRIES.filter((c) => c.code === code || filmPageExists(c.code, item.slug)).map((c) => ({ code: c.code, region: c.region }));
  const it = { ...item, _alts: cluster.length > 1 ? cluster : [] };
  const html = buildFilmPage(it, asOf, knownSlugs, cfg, null);
  const out = archivePatchHtml(html, countryNameFor(cfg), cfg).html;
  // The date the platforms were last confirmed stays the page's own, never the render date.
  return availability ? out.replace(/Availability as of [^<—]+? — /, `Availability as of ${availability} — `) : out;
}

function knownSlugsFor(code) {
  const dir = dirFor(code);
  try { return new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5))); } catch { return new Set(); }
}
const asOfOf = (html, fallback) => (/"dateModified":"(\d{4}-\d{2}-\d{2})/.exec(html) || [])[1] || fallback;

// One page through the check. Returns { ok, item, html, diff } without writing anything.
function tryMigrate(file, slug, cfg, entry, ctx) {
  let old;
  try { old = fs.readFileSync(file, "utf8"); } catch { return { ok: false, diff: ["unreadable"] }; }
  const item = extractFacts(old, slug, { tmdbId: entry && entry.tmdbId });
  if (!item) return { ok: false, diff: ["no structured data"] };
  const asOf = asOfOf(old, ctx.today);
  let html;
  try { html = renderFrozen(item, cfg, { asOf, knownSlugs: ctx.knownSlugs, availability: availabilityText(old) }); } catch (e) { return { ok: false, diff: [`render: ${e.message}`] }; }
  const diff = factsDiff(keyFacts(old), keyFacts(html));
  return { ok: diff.length === 0, item, html, diff, asOf };
}

// The next legacy pages of one edition, migrated if they pass. Mutates the manifest.
function migrateBatch(manifest, cfg, { limit = 0, today }) {
  const res = { tried: 0, migrated: 0, held: [] };
  if (!limit) return res;
  const code = cfg.code;
  const m = manifest[code] || {};
  const facts = readFacts(code);
  const ctx = { today, knownSlugs: knownSlugsFor(code) };
  const queue = Object.keys(m).filter((s) => m[s] && !m[s].rendered && !m[s].held && fs.existsSync(`${dirFor(code)}/${s}.html`)).sort();
  for (const slug of queue.slice(0, limit)) {
    res.tried++;
    const r = tryMigrate(`${dirFor(code)}/${slug}.html`, slug, cfg, m[slug], ctx);
    if (!r.ok) {
      m[slug].held = { on: today, why: r.diff.join(",") };
      res.held.push(`${code}/${slug} (${r.diff.join(", ")})`);
      continue;
    }
    facts.set(slug, { slug, updated: r.asOf, item: r.item });
    writeIfChanged(`${dirFor(code)}/${slug}.html`, r.html);
    m[slug].rendered = today;
    res.migrated++;
  }
  if (res.migrated) writeFacts(code, facts);
  return res;
}

// Every migrated page of one edition: facts read back (sweeps may have changed the page this
// run), stored when they moved, page rendered from them.
function renderMigrated(manifest, cfg, { today }) {
  const res = { pages: 0, factsChanged: 0, written: 0, lost: [] };
  const code = cfg.code;
  const m = manifest[code] || {};
  const facts = readFacts(code);
  const knownSlugs = knownSlugsFor(code);
  let dirty = false;
  for (const [slug, rec] of facts) {
    const e = m[slug];
    const file = `${dirFor(code)}/${slug}.html`;
    if (!e || !e.rendered || !fs.existsSync(file)) { facts.delete(slug); dirty = true; continue; }
    res.pages++;
    const html = fs.readFileSync(file, "utf8");
    const now = extractFacts(html, slug, { tmdbId: e.tmdbId });
    if (!now) { res.lost.push(`${code}/${slug}`); continue; }   // left as is; reported
    let r = rec;
    if (JSON.stringify(now) !== JSON.stringify(rec.item)) {
      r = { slug, updated: today, item: now };
      facts.set(slug, r);
      res.factsChanged++;
      dirty = true;
    }
    const out = renderFrozen(r.item, cfg, { asOf: r.updated, knownSlugs, availability: availabilityText(html) });
    if (writeIfChanged(file, out)) res.written++;
  }
  if (dirty) writeFacts(code, facts);
  return res;
}

function migrateLimit() {
  const n = Number(process.env.MIGRATE_BATCH || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

module.exports = { migrateBatch, migrateLimit, renderFrozen, renderMigrated, tryMigrate };
