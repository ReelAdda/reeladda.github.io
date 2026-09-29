// ============================================================================
// backfill.js — the back-catalogue backfill run (queue bookkeeping lives in catalog.js).
// ============================================================================
"use strict";

const fs = require("fs");
const { filmPageUrl, slugify, xDefaultCode } = require("./core.js");
const {
  CATALOG_BATCH_DEFAULT,
  CATALOG_MIN_VOTES,
  catalogEligible,
  catalogProgress,
  catalogQueues,
  catalogSlug,
  markQueue,
  nextQueue,
  noteBuilt,
  isSkipped,
  noteReject,
  queueState,
  CATALOG_MAX_PAGE,
} = require("./catalog.js");
const { filmIndexFor } = require("./graph.js");
const { todayStr } = require("./release.js");
const { ARCHIVE_PATCH_VERSION, archivePatchHtml } = require("./archive.js");
const { enrich } = require("./enrich.js");
const { cachedCriticsTone } = require("./editorial.js");
const { fcScore } = require("./fcscore.js");
const { buildFilmPage } = require("./filmpage.js");
const { countryNameFor, EXCLUDE_IDS, verdict } = require("./rules.js");
const { loadStateFile } = require("./runhealth.js");
const { sleep, tmdb } = require("./tmdb.js");

// ============================================================================
// BACK-CATALOGUE BACKFILL — the long tail, built a batch at a time.
//
// The weekly pipeline covers what is NEW. This covers what is ALREADY STREAMING: the
// catalogue titles people search for by name ("is <film> on Netflix", "where to watch
// <film>") long after any release week. That query shape is the one this site converts on
// today — the pages that earn clicks are the ones that can answer it — and unlike release
// traffic it doesn't decay, because the film stays on the platform for years.
//
// Cost control is the whole design. Each built page costs one discover call amortised across
// ~20 results plus one enrich call, so a batch of CATALOG_BATCH per country per run is a
// known, flat budget. The queue cursor lives in catalog-manifest.json, so consecutive runs
// walk the catalogue instead of re-reading page 1 forever.
//
// Off by default: set CATALOG=1 (optionally CATALOG_BATCH=n) in the workflow to enable.
// ============================================================================
const CATALOG_MANIFEST_FILE = "catalog-manifest.json";
// The site's own "an audience, not a handful" line (see the counterpoint gate: < 50 voters is
// too few to call it an audience). Catalogue pages below it show no rating or verdict.
const CATALOG_RATING_MIN_VOTES = 50;
const CATALOG_ENABLED = process.env.CATALOG === "1";
const CATALOG_BATCH = Math.max(1, Number(process.env.CATALOG_BATCH || CATALOG_BATCH_DEFAULT));

// Pure: is this country's backfill stalled? Two consecutive runs with zero new pages while
// queues are still open is the signature of the 27 Sept failure — never a normal state.
function catalogStall(state, code) {
  const s = (state && state[code]) || {};
  const recent = Array.isArray(s.recent) ? s.recent : [];
  const qs = Object.values(s.q || {});
  const live = qs.filter((q) => !q.done).length;
  const last = recent.length ? recent[recent.length - 1] : null;
  const stalled = recent.length >= 2 && recent.slice(-2).every((n) => n === 0) && live > 0;
  return { stalled, exhausted: qs.length > 0 && live === 0, live, last };
}

function loadCatalogManifest() {
  return loadStateFile(CATALOG_MANIFEST_FILE, {});
}

// `api` is injectable for tests (same pattern as repairLegacyPages).
//
// HOW A RUN CHOOSES WHICH TITLES GET PAGES
//   - Within a language queue: strictly most popular first. TMDB discover is sorted by
//     popularity, and a page is HELD until every eligible title on it is built or ruled out,
//     so a run that stops mid-page never skips the rest of that page.
//   - Across queues: one title per queue per turn, rotating (the cursor persists between runs),
//     in the market's own best-first language order. TMDB popularity is worldwide activity, so
//     ranking across languages by it would hand India's slots to Hollywood; rotation keeps the
//     regional titles that are this site's niche in every batch.
//   - A failed TMDB call never retires a queue. Only a real empty page or three barren pages do.
async function backfillCatalog(cfg, pagesManifest, { state, baseItem, withImdb, batch = CATALOG_BATCH,
  api = { tmdb, enrich, pause: sleep } }) {
  const code = cfg.code;
  const dir = code === "in" ? "movie" : `${code}/movie`;
  fs.mkdirSync(dir, { recursive: true });
  const queues = catalogQueues(cfg);
  // Slugs this country already has a page for. The backfill must never overwrite a page the
  // weekly pipeline owns: that page carries this week's live claims and gets regenerated.
  const have = new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5)));
  const filmIndex = filmIndexFor(cfg);
  const today = todayStr();
  const ageCutoff = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const DISCOVER_BUDGET = Math.min(40, queues.length * 3 + 4);
  const ENRICH_BUDGET = batch * 3 + 5;
  const MAX_HOPS = 3;          // drained pages a queue may walk past in one visit
  let built = 0, discoverCalls = 0, enrichCalls = 0, errors = 0;
  const picks = [];
  const pages = new Map();     // queue key -> { page, results, known, fresh[] } fetched this run
  const handled = new Set();   // tmdb ids built or ruled out this run

  const eligibleNow = (m) => !handled.has(skipId(m)) && !isSkipped(state, code, m) &&
    catalogEligible(m, { kind: m.kind, have, slugOf: slugify, excludeIds: EXCLUDE_IDS });
  function skipId(m) { return `${m.kind}:${m.id}`; }

  // The current page of a queue, walking past pages that have nothing left to build.
  // Returns null when the queue has nothing to offer this run (retired, drained, or erroring).
  async function headPage(q) {
    const qs = queueState(state, code, q.key);
    const cached = pages.get(q.key);
    if (cached && cached.page === qs.page) {
      cached.fresh = cached.fresh.filter(eligibleNow);
      if (cached.fresh.length) return cached;
      markQueue(state, code, q.key, { usable: cached.usable, results: cached.results, known: cached.known });
      pages.delete(q.key);
    }
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      if (qs.done || qs.page > CATALOG_MAX_PAGE || discoverCalls >= DISCOVER_BUDGET || errors >= 3) return null;
      const dateField = q.kind === "tv" ? "first_air_date.lte" : "primary_release_date.lte";
      let d;
      try {
        discoverCalls++;
        d = await api.tmdb(`/discover/${q.kind}`, {
          watch_region: cfg.watchRegion,
          with_watch_monetization_types: "flatrate",   // in-region subscription only: the page must be actionable
          with_original_language: q.lang,
          sort_by: "popularity.desc",                  // the catalogue people actually search for, first
          "vote_count.gte": String(CATALOG_MIN_VOTES),
          [dateField]: ageCutoff,
          include_adult: "false",
          page: String(qs.page),
        });
        await api.pause(150);
      } catch (e) {
        // Transient by assumption: the queue keeps its place and is tried again next run.
        errors++;
        console.warn(`  catalog discover ${code}/${q.key} p${qs.page}: ${e.message} (queue kept, retried next run)`);
        return null;
      }
      const results = ((d && d.results) || []).map((m) => ({ ...m, kind: q.kind }));
      if (!results.length) { markQueue(state, code, q.key, { results: 0 }); return null; }   // TMDB is out of pages
      const eligible = results.filter((m) => catalogEligible(m, { kind: q.kind, have, slugOf: slugify, excludeIds: EXCLUDE_IDS }));
      // "Known" = already has a page, or already ruled out: handled, so not a sign of a barren queue.
      const known = results.filter((m) => have.has(slugify(m.title || m.name || "")) || isSkipped(state, code, m)).length;
      const fresh = eligible.filter(eligibleNow);
      const entry = { page: qs.page, results: results.length, usable: eligible.length, known, fresh };
      if (fresh.length) { pages.set(q.key, entry); return entry; }
      markQueue(state, code, q.key, { usable: eligible.length, results: results.length, known });
    }
    return null;
  }

  // Build one title from the head of a queue's page. Tries the next title on the same page
  // when one is ruled out, so a provider-less title never costs the queue its turn.
  async function buildFrom(q, entry) {
    while (entry.fresh.length && enrichCalls < ENRICH_BUDGET) {
      const m = entry.fresh.shift();
      if (!eligibleNow(m)) continue;
      const slug = catalogSlug(m, { slugOf: slugify, have });
      if (!slug) { handled.add(skipId(m)); noteReject(state, code, m, { permanent: true }); continue; }
      let item;
      try {
        enrichCalls++;
        item = { ...baseItem(m, q.kind) };
        Object.assign(item, await api.enrich(q.kind, m.id, cfg.watchRegion));
        withImdb(item);
        await api.pause(150);
      } catch (e) {
        handled.add(skipId(m));
        noteReject(state, code, m);   // a strike, not a verdict
        console.warn(`  catalog enrich ${code}/${m.id}: ${e.message}`);
        continue;
      }
      handled.add(skipId(m));
      // Discover said flatrate; the detail call is the truth. No provider -> no answer -> no page.
      const providers = Array.isArray(item.providers) ? item.providers : [];
      if (!providers.length) { noteReject(state, code, m, { permanent: true }); continue; }
      // The bar is low so that "where to watch" pages exist for regional films TMDB barely
      // rates — not so that 20 votes can earn "Must watch". Under CATALOG_RATING_MIN_VOTES the
      // page withholds the number and the verdict ("Rating still forming") and keeps every
      // other answer: platform, cast, runtime, certificate, synopsis.
      // FilmyChill Score first, on the real rating: catalogue items never pass through the
      // weekly scoring step (without this every catalogue page read "Too early", even with
      // thousands of ratings), and an older title with 15–49 ratings earns an early read.
      item.criticsTone = cachedCriticsTone(item.imdbId);
      const score = fcScore(item);
      if (score) item.fcScore = score;
      // Thin data: the page's audience wording must not outrun the early read (an 8.9 from
      // 20 votes would otherwise still say "Must watch" in the audience prose).
      if (score && score.early) item.verdict = score.verdict;
      // An early read keeps its number visible (the page says why it's tentative); otherwise
      // the thin-vote rule still withholds it.
      if ((item.votes || 0) < CATALOG_RATING_MIN_VOTES && !(score && score.early)) {
        item.rating = null;
        item.scores = [];
        item.verdict = verdict(null, 0);
      }
      item.slug = slug;
      item.platform = providers[0];
      have.add(slug);
      try {
        // Born frozen, so it's written the way every frozen page reads: through the archive
        // chain. Written raw, catalogue pages said "on offer right now" forever — the chain
        // never ran on them because they were stamped with the current patch version at birth.
        const page = archivePatchHtml(buildFilmPage(item, today, have, cfg, filmIndex), countryNameFor(cfg), cfg).html;
        fs.writeFileSync(`${dir}/${slug}.html`, page);
      } catch (e) { console.warn(`  catalog page ${code}/${slug}: ${e.message}`); continue; }
      // Feed the neighbour graph so later titles in this same batch can link to it.
      filmIndex.push({ slug, title: item.title, genre: item.genre || "", language: item.language || "",
        released: item.released || "", poster: item.poster || "", kind: item.kind || "movie" });
      // It still joins the manifest so the streaming-departure sweep re-checks its claims and
      // the sitemap gets a truthful lastmod.
      const mf = (pagesManifest[code] = pagesManifest[code] || {});
      mf[slug] = { last: today, archivedOn: today, pv: ARCHIVE_PATCH_VERSION, catalog: true,
        tmdbId: item.tmdbId, released: item.released || null, lang: item.language || null,
        kind: item.kind || "movie", title: item.title,
        // Born with a dated claim, so the departure sweep rechecks it like any other.
        live: { since: today, providers: providers.slice(0, 4), lastCheck: today, misses: 0 } };
      built++;
      noteBuilt(state, code, 1);
      picks.push(`${item.title} (${q.lang})`);
      return true;
    }
    return false;
  }

  // Rotate: one title per queue per turn until the batch is full. Stop after a full turn
  // that built nothing (every queue drained, retired or erroring for this run).
  let idle = 0;
  while (built < batch && enrichCalls < ENRICH_BUDGET && errors < 3) {
    const q = nextQueue(state, code, queues);
    if (!q) { console.log(`  catalog [${code}]: every queue exhausted — catalogue covered for this source`); break; }
    const entry = await headPage(q);
    const ok = entry ? await buildFrom(q, entry) : false;
    // A page is only left behind once nothing on it remains to build.
    if (entry && !entry.fresh.filter(eligibleNow).length) {
      markQueue(state, code, q.key, { usable: entry.usable, results: entry.results, known: entry.known });
      pages.delete(q.key);
    }
    idle = ok ? 0 : idle + 1;
    if (idle >= queues.length) break;
  }
  if (errors >= 3) console.warn(`  catalog [${code}]: TMDB kept failing — stopped early; every queue kept its place`);
  // The last few runs' output, so the health check can tell "one quiet run" from "stalled".
  const cs = state[code];
  cs.recent = [...(Array.isArray(cs.recent) ? cs.recent : []), built].slice(-4);
  const prog = catalogProgress(state, code);
  console.log(`  catalog [${code}]: +${built} pages this run (${discoverCalls} discover + ${enrichCalls} enrich calls, ` +
    `${prog.built} total, ${prog.done}/${prog.queues} queues retired)${picks.length ? " — " + picks.join(", ") : ""}`);
  return built;
}

// One-time in effect: fix FROZEN (archived) film pages whose on-page hreflang still
// declares x-default = the India copy when no India copy exists on disk. Current pages are
// regenerated fresh each run and get the correct x-default by construction; frozen pages are
// deliberately never rewritten, so the bad tag written by pre-fix code would otherwise
// persist — and keep feeding Google a 404 discovery URL. Pure disk scan + string swap.
function repairXDefaults(countries) {
  const dirFor = (code) => (code === "in" ? "movie" : `${code}/movie`);
  const have = {}; // slug -> [codes whose file exists]
  for (const c of countries) {
    const dir = dirFor(c.code);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".html")) (have[f.slice(0, -5)] = have[f.slice(0, -5)] || []).push(c.code);
    }
  }
  let fixed = 0;
  for (const c of countries) {
    const dir = dirFor(c.code);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".html")) continue;
      const slug = f.slice(0, -5);
      const codes = have[slug] || [];
      if (codes.includes("in")) continue; // India copy exists -> x-default already valid
      const bad = `hreflang="x-default" href="https://filmychill.com/movie/${slug}.html"`;
      const p = `${dir}/${f}`;
      const html = fs.readFileSync(p, "utf8");
      if (!html.includes(bad)) continue;
      const good = `hreflang="x-default" href="${filmPageUrl(xDefaultCode(codes), slug)}"`;
      fs.writeFileSync(p, html.split(bad).join(good));
      fixed++;
    }
  }
  if (fixed) console.log(`  hreflang repair: ${fixed} frozen pages had x-default pointing at a missing India copy`);
}

module.exports = {
  backfillCatalog,
  CATALOG_BATCH,
  CATALOG_ENABLED,
  CATALOG_MANIFEST_FILE,
  catalogStall,
  loadCatalogManifest,
  repairXDefaults,
};
