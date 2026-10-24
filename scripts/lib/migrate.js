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
const { archivePatchHtml, retitleFrozen, rewriteMetaDescription } = require("./archive.js");
const { applyDeparturePatch, duePassPage } = require("./lifecycle.js");
const { applyPatch, modeOf, queuedFacts } = require("./factsq.js");
const { buildFilmPage } = require("./filmpage.js");
const { sameFilmPageExists } = require("./graph.js");
const { countryNameFor } = require("./rules.js");
const { availabilityText, extractFacts, factsDiff, isoFromShown, keyFacts, readFacts, writeFacts } = require("./facts.js");
const { writeIfChanged } = require("./writeif.js");
const { fcScore } = require("./fcscore.js");
const { applyTruth } = require("./truth.js");
const { langName } = require("./rules.js");
const { inRollout } = require("./rollout.js");

const dirFor = (code) => (code === "in" ? "movie" : `${code}/movie`);

// Pure-ish (reads which editions have the film): a frozen page from its facts.
function renderFrozen(item, cfg, { asOf, knownSlugs, availability = "", untracked = false }) {
  const code = cfg.code;
  const key = item.tmdbId ? `${item.kind || "movie"}:${item.tmdbId}` : null; // only editions of the same film (lib/graph.js)
  const cluster = COUNTRIES.filter((c) => c.code === code || sameFilmPageExists(c.code, item.slug, key)).map((c) => ({ code: c.code, region: c.region }));
  const it = { ...item, _alts: cluster.length > 1 ? cluster : [], ...(untracked ? { untracked: true } : {}) };
  const html = buildFilmPage(it, asOf, knownSlugs, cfg, null);
  const countryName = countryNameFor(cfg);
  let out = archivePatchHtml(html, countryName, cfg, item).html;
  // What the calendar alone changes (lib/lifecycle.js duePassPage): the same pass the build
  // runs over pages on disk, so a page drawn from facts says what a patched page says.
  out = duePassPage(out, { title: item.title, countryName, cfg, item }).html;
  // A departure is part of the facts (lib/factsq.js): drawn on every render, so it can't be
  // erased by the next one (it was: no departure notice survived, Oct 2026 audit).
  if (item.state === "gone") {
    const r = applyDeparturePatch(out, { title: item.title, was: item.wasOn || [], rentBuy: item.rentBuy || [],
      countryName, cfg, asOf: item.goneAt || item.checkedAt || "", unconfirmed: !!item.goneUnconfirmed });
    if (r.changed) out = retitleFrozen(rewriteMetaDescription(r.html, cfg, item).html, cfg, item).html;
  }
  // The date the platforms were last confirmed stays the page's own, never the render date.
  return availability ? out.replace(/Availability as of [^<—]+? — /, `Availability as of ${availability} — `) : out;
}

// The "Availability as of" text for an item: its own check date, in the edition's format.
const availabilityFor = (item, code) => (item && item.checkedAt ? fmtDateFull(item.checkedAt, localeFor(code)) : "");
// Fields that record checks, not content: a change to them alone isn't "Page updated".
const BOOKKEEPING = ["checkedAt"];
const visible = (item) => JSON.stringify(item, (k, v) => (BOOKKEEPING.includes(k) ? undefined : v));
// keyFacts with the availability date compared as a date, whatever format the page wrote it in.
function comparable(html) {
  const k = keyFacts(html);
  return { ...k, availability: isoFromShown(k.availability) || k.availability };
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

// ONE SCORE PER FILM (Oct 2026). TMDB's rating and count are the same worldwide, but each
// edition captured them on a different day, so 4% of films shown in 2+ editions carried
// different ratings and 2% different verdicts (Moana: "Must watch" in the UAE at 919 ratings,
// "Worth a watch" elsewhere at 961; Primetime: no rating in the UK, 6.9 elsewhere). A frozen
// page now takes the freshest count any edition holds for the same film (most ratings), and its
// FilmyChill Score is worked out again from that count with the critics' reading it already
// had. Pages in this week's lists were just rebuilt from TMDB and already hold the newest.
const ONE_SCORE = "one-score";
const TIER_TONE = { positive: "positive", mixed: "mixed", negative: "negative" };
let bestAudience = null;
function bestAudienceFor(key) {
  if (!bestAudience) {
    bestAudience = new Map();
    let man = {};
    try { man = JSON.parse(fs.readFileSync("pages-manifest.json", "utf8")); } catch { /* none */ }
    for (const c of COUNTRIES) {
      let facts;
      try { facts = readFacts(c.code); } catch { continue; }
      for (const [slug, rec] of facts) {
        const e = (man[c.code] || {})[slug];
        const it = rec && rec.item;
        if (!e || !e.tmdbId || !it || it.rating == null || !(Number(it.votes) > 0)) continue;
        const k = `${e.kind || it.kind || "movie"}:${e.tmdbId}`;
        const cur = bestAudience.get(k);
        if (!cur || Number(it.votes) > cur.votes) bestAudience.set(k, { rating: Number(it.rating), votes: Number(it.votes) });
      }
    }
  }
  return bestAudience.get(key) || null;
}
function resetBestAudience() { bestAudience = null; }
// Pure: the item with the fresher rating and count, its score worked out again; the same item
// when there's nothing fresher or no score comes out of it.
function shareScore(item, best) {
  if (!item || !best || !(best.votes > (Number(item.votes) || 0))) return item;
  const tone = TIER_TONE[item.fcScore && item.fcScore.critics] || null;
  const next = { ...item, rating: best.rating, votes: best.votes };
  const s = fcScore({ ...next, criticsTone: tone });
  if (!s) return item;
  next.fcScore = s;
  return next;
}

// Every migrated page of one edition, rendered from facts (lib/factsq.js has the full story).
//   shadow mode (the default): the facts are read back from the page, so whatever the sweeps
//     patched this run carries through, exactly as before. Each page is ALSO drawn the
//     facts-only way, from its stored record plus this run's queued updates, and the two are
//     compared; res.shadow counts the pages that differ.
//   facts mode: the stored record plus this run's queued updates is the page. The page on disk
//     is never read.
function renderMigrated(manifest, cfg, { today, mode = null, modes = null, listed = null } = {}) {
  const res = { pages: 0, factsChanged: 0, written: 0, lost: [], corrected: 0, fields: {}, shadow: { pages: 0, diffs: 0, examples: [] } };
  const code = cfg.code;
  const m = manifest[code] || {};
  const facts = readFacts(code);
  const knownSlugs = knownSlugsFor(code);
  const queued = queuedFacts(code);
  const factsOnly = (mode || (modes ? modeOf(modes, code) : "shadow")) === "facts";
  res.mode = factsOnly ? "facts" : "shadow";
  let dirty = false;
  // What TMDB said at the last check of a frozen page (lib/truth.js): platforms that changed,
  // rent/buy, a moved release date, a new title, language, credits. Pages in this week's lists
  // are rebuilt from fresh data anyway. A changed platform list is dated by the check that saw it.
  const withTruth = (item, e, count) => {
    let out = item;
    if (/^[a-z]{2,3}$/.test(out.language || "") && langName(out.language) !== out.language) {
      out = { ...out, language: langName(out.language) };     // a bare code from a build that couldn't name it
      if (count) res.fields.language = (res.fields.language || 0) + 1;
    }
    if (e.archivedOn && e.truth) {
      const t = applyTruth(out, e.truth);
      if (t.changed.length) {
        out = t.item;
        if (t.changed.includes("providers") && e.truth.at) out = { ...out, checkedAt: e.truth.at };
        if (count) {
          res.corrected = (res.corrected || 0) + 1;
          for (const f of t.changed) res.fields[f] = (res.fields[f] || 0) + 1;
          // The manifest follows the page, or the self-audit reads them as two different films.
          if (t.changed.includes("language")) e.lang = out.language;
          if (t.changed.includes("released") && out.released) e.released = out.released;
        }
      }
    }
    if (e.tmdbId && out.tmdbId !== e.tmdbId) out = { ...out, tmdbId: e.tmdbId };
    return out;
  };
  const render = (item, rec, e) => {
    // "Page updated" and dateModified: the later of the facts' date and the date the page last
    // visibly changed (`last`, the sitemap's lastmod, moved by syncFilmLastmods). Neither date
    // is in the content fingerprint, so this can't loop.
    const asOf = e.last && e.last > rec.updated && e.last <= today ? e.last : rec.updated;
    // No TMDB id, or one TMDB no longer has (lib/lifecycle.js): no sweep can recheck it.
    const untracked = !e.tmdbId || !!e.tmdbGone;
    return renderFrozen(item, cfg, { asOf, knownSlugs, availability: availabilityFor(item, code), untracked });
  };
  for (const [slug, rec] of facts) {
    const e = m[slug];
    const file = `${dirFor(code)}/${slug}.html`;
    if (!e || !e.rendered || !fs.existsSync(file)) { facts.delete(slug); dirty = true; continue; }
    res.pages++;
    // The stored record plus this run's queued updates: the facts-only page.
    const fromStore = withTruth(applyPatch(rec.item, queued.get(slug)), e, factsOnly);
    // A film in this run's lists was just rebuilt from fresh TMDB data: that page is the newest
    // source, in either mode, and there is nothing to compare it with.
    const onLists = !!(listed && listed.has(slug));
    let now;
    if (factsOnly && !onLists) now = fromStore;
    else {
      const html = fs.readFileSync(file, "utf8");
      const read = extractFacts(html, slug, { tmdbId: e.tmdbId });
      if (!read) { res.lost.push(`${code}/${slug}`); continue; }   // left as is; reported
      now = withTruth(read, e, true);
    }
    // One score per film (rollout ONE_SCORE): the freshest TMDB count any edition holds for it.
    if (e.tmdbId && inRollout(ONE_SCORE, slug)) {
      const shared = shareScore(now, bestAudienceFor(`${e.kind || now.kind || "movie"}:${e.tmdbId}`));
      if (shared !== now) { now = shared; res.fields.sharedScore = (res.fields.sharedScore || 0) + 1; }
    }
    let r = rec;
    if (JSON.stringify(now) !== JSON.stringify(rec.item)) {
      // Only a visible change moves "Page updated"; a new check date alone doesn't.
      r = { slug, updated: visible(now) !== visible(rec.item) ? today : rec.updated, item: now };
      facts.set(slug, r);
      if (r.updated === today) res.factsChanged++;
      dirty = true;
    }
    let out;
    try { out = render(r.item, r, e); } catch (err) { res.lost.push(`${code}/${slug} (${err.message})`); continue; }
    if (!factsOnly && !onLists) {
      // Shadow: the same page drawn from the stored record and this run's updates only.
      res.shadow.pages++;
      try {
        const alt = render(fromStore, r, e);
        const a = comparable(out), b = comparable(alt);
        const diff = factsDiff(a, b);
        if (diff.length) {
          res.shadow.diffs++;
          if (res.shadow.examples.length < 5) res.shadow.examples.push(`${code}/${slug} (${diff.map((k) => `${k}: "${String(a[k]).slice(0, 40)}" vs "${String(b[k]).slice(0, 40)}"`).join("; ")})`);
        }
      } catch (err) {
        res.shadow.diffs++;
        if (res.shadow.examples.length < 5) res.shadow.examples.push(`${code}/${slug} (facts-only render failed: ${err.message})`);
      }
    }
    if (writeIfChanged(file, out)) res.written++;
  }
  // A page marked rendered whose record is missing (an unreadable line, a lost write) is
  // captured again from its page by migrateBatch, later this run, instead of sitting frozen.
  res.unreadable = facts.skipped || 0;
  res.recaptured = 0;
  for (const [slug, e] of Object.entries(m)) {
    if (e && e.rendered && !facts.has(slug)) { delete e.rendered; res.recaptured++; }
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

module.exports = { migrateBatch, migrateLimit, renderFrozen, renderMigrated, resetBestAudience, shareScore, tryMigrate };
