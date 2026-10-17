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
// Every build: new pages move to facts the run they are written; held pages are retried.
// ============================================================================
"use strict";

const fs = require("fs");
const { COUNTRIES, fmtDateFull, localeFor } = require("./core.js");
const { archivePatchHtml } = require("./archive.js");
const { buildFilmPage } = require("./filmpage.js");
const { filmPageExists } = require("./graph.js");
const { countryNameFor } = require("./rules.js");
const { availabilityText, extractFacts, factsDiff, keyFacts, readFacts, writeFacts } = require("./facts.js");
const { writeIfChanged } = require("./writeif.js");
const { fcScore } = require("./fcscore.js");
const { applyTruth } = require("./truth.js");
const { langName } = require("./rules.js");

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

// The older layout (no FilmyChill Score card, no markers, no dates in its data) differs from a
// render in ways that are not fact changes. Each rule is narrow, and every other difference
// still holds the page (Oct 2026: 495 pages held, all for these reasons):
//   availability  it never printed the line; the render adds the page's real last-checked date
//   verdict       its verdict came from the old rating bands ("▸ Worth a watch" from a few
//                 votes); the render applies today's rule to the same rating and vote count
//   state         "upcoming" when its own release date is still ahead (the old page was wrong)
function acceptedDiff(diff, old, item, today) {
  const oldLayout = !/class="fcsb/.test(old);
  const a = keyFacts(old);
  return diff.filter((k) => !(
    (k === "availability" && a.availability === "")
    || (k === "verdict" && oldLayout)
    || (k === "state" && item.released > today)
  ));
}

// One page through the check. Returns { ok, item, html, diff } without writing anything.
function tryMigrate(file, slug, cfg, entry, ctx) {
  let old;
  try { old = fs.readFileSync(file, "utf8"); } catch { return { ok: false, diff: ["unreadable"] }; }
  const item = extractFacts(old, slug, { tmdbId: entry && entry.tmdbId });
  if (!item) return { ok: false, diff: ["no structured data"] };
  // No score card to read on the older layout: today's rule, from the same rating and count,
  // exactly as the live build scores a film (Toy Story 5: 535 ratings, "Worth a watch").
  if (!item.fcScore && !/class="fcsb/.test(old)) { const s = fcScore(item); if (s) item.fcScore = s; }
  // A page with no date in its data: the manifest knows when it last changed and was checked.
  const lastTouched = [entry && entry.last, entry && entry.swept].filter(Boolean).sort().pop() || ctx.today;
  const asOf = asOfOf(old, (entry && entry.last) || ctx.today);
  const availability = availabilityText(old) || fmtDateFull(lastTouched, localeFor(cfg.code));
  let html;
  try { html = renderFrozen(item, cfg, { asOf, knownSlugs: ctx.knownSlugs, availability }); } catch (e) { return { ok: false, diff: [`render: ${e.message}`] }; }
  const diff = acceptedDiff(factsDiff(keyFacts(old), keyFacts(html)), old, item, ctx.today);
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
  // New pages first, then held ones again: a reader fix releases them without a manual step.
  const waiting = Object.keys(m).filter((s) => m[s] && !m[s].rendered && fs.existsSync(`${dirFor(code)}/${s}.html`)).sort();
  const queue = [...waiting.filter((s) => !m[s].held), ...waiting.filter((s) => m[s].held)];
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
    delete m[slug].held;
    res.migrated++;
  }
  if (res.migrated) writeFacts(code, facts);
  return res;
}

// Every migrated page of one edition: facts read back (sweeps may have changed the page this
// run), stored when they moved, page rendered from them.
function renderMigrated(manifest, cfg, { today }) {
  const res = { pages: 0, factsChanged: 0, written: 0, lost: [], corrected: 0, fields: {} };
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
    let now = extractFacts(html, slug, { tmdbId: e.tmdbId });
    if (!now) { res.lost.push(`${code}/${slug}`); continue; }   // left as is; reported
    let availability = availabilityText(html);
    // A bare language code ("2h 3m of ar action") from a build that couldn't name it.
    if (/^[a-z]{2,3}$/.test(now.language || "") && langName(now.language) !== now.language) {
      now = { ...now, language: langName(now.language) };
      res.fields.language = (res.fields.language || 0) + 1;
    }
    // What TMDB said at the last check of a frozen page (lib/truth.js): platforms that changed,
    // rent/buy, a moved release date, a new title. Pages in this week's lists are rebuilt from
    // fresh data anyway. A changed platform list is dated by the check that saw it.
    if (e.archivedOn && e.truth) {
      const t = applyTruth(now, e.truth);
      if (t.changed.length) {
        now = t.item;
        res.corrected = (res.corrected || 0) + 1;
        for (const f of t.changed) res.fields[f] = (res.fields[f] || 0) + 1;
        if (t.changed.includes("providers") && e.truth.at) availability = fmtDateFull(e.truth.at, localeFor(code));
      }
    }
    let r = rec;
    if (JSON.stringify(now) !== JSON.stringify(rec.item)) {
      r = { slug, updated: today, item: now };
      facts.set(slug, r);
      res.factsChanged++;
      dirty = true;
    }
    const out = renderFrozen(r.item, cfg, { asOf: r.updated, knownSlugs, availability });
    if (writeIfChanged(file, out)) res.written++;
  }
  if (dirty) writeFacts(code, facts);
  return res;
}

// Always on since the queue emptied (14 Oct 2026): a page written this run moves to facts in
// the same run. MIGRATE_BATCH, when set, overrides the per-edition cap (0 stops it).
const MIGRATE_DEFAULT = 500;
function migrateLimit() {
  const raw = process.env.MIGRATE_BATCH;
  if (raw == null || raw === "") return MIGRATE_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

module.exports = { migrateBatch, migrateLimit, renderFrozen, renderMigrated, tryMigrate };
