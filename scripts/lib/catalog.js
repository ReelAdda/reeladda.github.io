// ============================================================================
// catalog.js — the BACK-CATALOGUE backfill queue.
//
// WHY THIS EXISTS
// The weekly pipeline only ever builds pages for films that are in a current list: this
// week's theatre pool, this week's OTT arrivals, the coming-soon strip. That is the right
// shape for a "what's new" site and the wrong shape for search. Sept 2026 GSC: 798 pages
// earned an impression, 624 of them earned zero clicks, and the pages that DID convert were
// the ones answering "where can I watch X" for a title someone had already heard of.
// A new release answers that question for about three weeks. A catalogue title answers it
// forever, which is why "is X on Netflix" traffic compounds while release-week traffic decays.
//
// WHAT THIS DOES
// Nothing network-facing and nothing that writes: this module is the pure bookkeeping for a
// backfill that runs a few dozen titles per country per run. It decides WHICH slice of the
// catalogue to ask TMDB for next (round-robin across language x kind queues, one discover
// page at a time, cursor persisted in catalog-manifest.json) and WHICH results deserve a
// page. update.js owns the fetching, the enrichment and the writing.
//
// THE ELIGIBILITY BAR IS THE WHOLE PRODUCT DECISION
// A page is worth building only if it can answer something. Every rule below exists to keep
// the archive from filling with pages that say nothing:
//   - the title must actually be streaming in THIS country (the discover query is already
//     gated to flatrate in-region, and the enrich step re-checks before the page is written)
//   - it must have real audience numbers, or the verdict is a placeholder forever
//   - it must be old enough that the weekly pipeline was never going to cover it — otherwise
//     the two systems race each other for the same slug
//   - it must have a poster and a synopsis, or the page is a shell
// ============================================================================
"use strict";

const CATALOG_MIN_VOTES = 80;        // below this there is no honest verdict to give
const CATALOG_MIN_AGE_DAYS = 120;    // younger than this belongs to the weekly pipeline
const CATALOG_MAX_PAGE = 20;         // discover past ~20 pages is long-tail noise, not catalogue
const CATALOG_BATCH_DEFAULT = 25;    // pages built per country per run (each costs one enrich call)

// Language x kind queues for one country, best-first. ottRegionalLangs is the market's own
// streaming-relevant language set (Malayalam matters in the UAE, Punjabi in Canada); English
// is appended everywhere because every catalogue has it.
function catalogQueues(cfg) {
  const langs = [];
  for (const l of [...((cfg && cfg.ottRegionalLangs) || []), ...((cfg && cfg.priorityLangs) || []), "en"]) {
    if (l && !langs.includes(l)) langs.push(l);
  }
  const out = [];
  for (const lang of langs) for (const kind of ["movie", "tv"]) out.push({ key: `${lang}:${kind}`, lang, kind });
  return out;
}

// State shape (catalog-manifest.json):
//   { "<code>": { cursor: <int>, built: <int>, q: { "<lang>:<kind>": { page, done, empty } } } }
function countryState(state, code) {
  const s = (state[code] = state[code] || {});
  s.q = s.q || {};
  s.cursor = s.cursor || 0;
  s.built = s.built || 0;
  return s;
}

function queueState(state, code, key) {
  const s = countryState(state, code);
  return (s.q[key] = s.q[key] || { page: 1, done: false, empty: 0 });
}

// Round-robin: hand back the next queue that still has pages left, starting where the last
// run stopped. Returns null once every queue for this country is exhausted — the signal that
// the country's catalogue is as covered as this source can make it.
function nextQueue(state, code, queues) {
  const s = countryState(state, code);
  for (let i = 0; i < queues.length; i++) {
    const q = queues[(s.cursor + i) % queues.length];
    const qs = queueState(state, code, q.key);
    if (qs.done || qs.page > CATALOG_MAX_PAGE) continue;
    s.cursor = (s.cursor + i + 1) % queues.length;
    return { ...q, page: qs.page };
  }
  return null;
}

// Record what a discover page yielded. `usable` is how many results cleared eligibility, so a
// queue that keeps coming back empty retires instead of burning a call every run forever.
function markQueue(state, code, key, { usable = 0, results = 0 } = {}) {
  const qs = queueState(state, code, key);
  qs.page += 1;
  if (!results) { qs.done = true; return qs; }       // TMDB has no more pages here
  qs.empty = usable ? 0 : (qs.empty || 0) + 1;
  if (qs.empty >= 3) qs.done = true;                  // three barren pages running -> retire
  if (qs.page > CATALOG_MAX_PAGE) qs.done = true;
  return qs;
}

function noteBuilt(state, code, n = 1) {
  const s = countryState(state, code);
  s.built += n;
  return s.built;
}

// Pure eligibility. `have` is the set of slugs this country already has a page for, so the
// backfill never fights the weekly pipeline for a slug it already owns.
function catalogEligible(m, {
  kind = "movie",
  have = new Set(),
  slugOf = (t) => t,
  excludeIds = new Set(),
  minVotes = CATALOG_MIN_VOTES,
  minAgeDays = CATALOG_MIN_AGE_DAYS,
  now = Date.now(),
} = {}) {
  if (!m || !m.id || excludeIds.has(m.id)) return false;
  if (m.adult) return false;
  const title = m.title || m.name || "";
  if (!title.trim()) return false;
  if (!m.poster_path) return false;                       // a posterless card is a shell
  if (!String(m.overview || "").trim()) return false;     // no synopsis -> nothing to say
  if ((m.vote_count || 0) < minVotes) return false;       // no honest verdict available
  if (!(m.vote_average > 0)) return false;
  const rel = String(m.release_date || m.first_air_date || "").slice(0, 10);
  if (!rel) return false;
  const age = (now - Date.parse(`${rel}T00:00:00Z`)) / 864e5;
  if (!Number.isFinite(age) || age < minAgeDays) return false; // the weekly pipeline's territory
  const slug = slugOf(title);
  if (!slug || have.has(slug)) return false;
  void kind;
  return true;
}

// Slug for a catalogue title, disambiguated by year exactly the way assignSlugs does it for
// the weekly lists — so the two systems can never write different slugs for the same film.
function catalogSlug(m, { slugOf, have = new Set() }) {
  const base = slugOf(m.title || m.name || "") || `film-${m.id}`;
  if (!have.has(base)) return base;
  const year = String(m.release_date || m.first_air_date || "").slice(0, 4);
  return year ? `${base}-${year}` : null;   // no year to disambiguate with -> skip the title
}

function catalogProgress(state, code) {
  const s = countryState(state, code);
  const queues = Object.values(s.q);
  return { built: s.built, queues: queues.length, done: queues.filter((q) => q.done).length };
}

module.exports = {
  CATALOG_MIN_VOTES, CATALOG_MIN_AGE_DAYS, CATALOG_MAX_PAGE, CATALOG_BATCH_DEFAULT,
  catalogQueues, nextQueue, markQueue, noteBuilt, catalogEligible, catalogSlug,
  catalogProgress, queueState, countryState,
};
