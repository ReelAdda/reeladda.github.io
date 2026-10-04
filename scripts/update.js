// ReelAdda weekly updater v2 — runs automatically via GitHub Actions.
// Fetches theatre + OTT releases with full details (trailer, cast, runtime,
// certificate, all streaming platforms), upcoming releases, and marks
// what's new since last week's scan. Writes data.json for the website.
//
// This file is the ORCHESTRATOR: main() runs the stages in order. Each stage lives in its
// own module in scripts/lib/ (Sept 2026 split; the code was moved verbatim). Low -> high:
//   tmdb       TMDB client, retries, ratings-source switch
//   rules      streaming vocabulary, windows, exclusions, languages, verdicts
//   freshness  first-seen tracking, freshness gates, list integrity, badges
//   runhealth  run-health report + strict state-file loader
//   pagekit    URL/path helpers, page chrome, week helpers, status pills
//   editorial  buzz, critics' takes, hooks, audience counterpoint
//   enrich     TMDB id -> full item (IMDb ratings, certificates, providers)
//   filmcopy   film-page prose: verdict, good-to-know, FAQs
//   filmpage   the per-film page and generatePages()
//   archive    frozen-page rewrites, pages manifest, legacy repair
//   lifecycle  arrival/departure/due sweeps, id recovery, the archive pass
//   backfill   back-catalogue run (queue bookkeeping: catalog.js)
//   weekly     cards, "New on OTT this week", editor's note, RSS
//   evergreen  "Streaming on <platform>" and people pages
//   hubs       monthly archives and platform hubs
//   dated      coming-to-OTT, new-today, language pages, week snapshots, IndexNow
//   surfaces   homepage, head tags, hero, /data/, About, writeCountrySurfaces()
//   sitemap    dead hub links, multi-country sitemap, honest film lastmod (content fingerprints)
//   llms       llms.txt / llms-full.txt
//   fcscore    the FilmyChill Score: audiences + critics, one automated verdict
//   scoresweep adds/refreshes the score on frozen and back-catalogue pages, a batch per run
//   relrefresh re-picks "If you liked this" on those pages when the rules change
//   vote       the "Watched it? Was it worth it?" button (browser half: /js/vote.js)
//   votes      reads visitors' votes from Firestore into votes-agg.json (build half)
//   audit      the build checks its own pages for contradictions a visitor would notice
//   stylesheets film pages load shared, cached CSS files; every footer links /privacy/; the
//              end-of-build finish: icons on every page, country in non-India titles, window lines
// A lib module may only require modules above it in this list (tests enforce no cycles).

const fs = require("fs");
const {
  COUNTRIES,
  LANGUAGE_PAGES,
  escHtml,
  filmPagePath,
  filmPageUrl,
  fmtDateShort,
  fmtRuntime,
  slugify,
  trim,
  xDefaultCode,
  localeFor,
} = require("./lib/core.js");
const {
  appendHistory,
  readHistory,
  historyRecord,
  streamingWindowDays,
  windowStats,
  observationStarts,
  cinemaWindowDays,
  cinemaClaim,
  fillCinemaDates,
  readHistoryLines,
  writeHistoryLines,
} = require("./lib/history.js");
const { writeEmbed, buildEmbedPage, buildEmbedInstructions, embedItems } = require("./lib/embed.js");
const { reopenForBar } = require("./lib/catalog.js");
const { filmScore, confidenceTier, rankValue, rankFilms } = require("./lib/score.js");
const {
  cardFontFiles,
  cardPaths,
  cardStatus,
  shareCardSvg,
  voteCountLabel,
  wrapForCard,
  writeShareCards,
} = require("./lib/cards.js");
const {
  browsePath,
  buildBrowsePage,
  filmIndexFor,
  filmPageExists,
  hreflangBlockFor,
  patchHreflang,
  relatedFilms,
  relatedScore,
  syncHreflangClusters,
  writeBrowseIndex,
  BROWSE_PER_PAGE,
} = require("./lib/graph.js");
const { certClause, runtimePhrase, whyWatch } = require("./lib/whywatch.js");
const { normalizeUpcoming, releaseLabel, releaseState, todayStr } = require("./lib/release.js");
const {
  ARCHIVE_PATCH_VERSION,
  archivePatchHtml,
  countryNameForms,
  crossCountryLeak,
  ensureAnalytics,
  freshenFrozenCopy,
  frozenFilmFacts,
  neutralizeCrossCountry,
  PAGES_MANIFEST_FILE,
  reconcilePagesManifest,
  repairLegacyPages,
  retitleFrozen,
  rewriteMetaDescription,
  shortenTitleTag,
  stripAggregateRating,
  visibleText,
} = require("./lib/archive.js");
const {
  backfillCatalog,
  CATALOG_BATCH,
  CATALOG_ENABLED,
  CATALOG_MANIFEST_FILE,
  catalogStall,
  loadCatalogManifest,
  repairXDefaults,
} = require("./lib/backfill.js");
const {
  announcedDates,
  buildComingPage,
  buildLanguagePage,
  buildTodayPage,
  buildWeekPage,
  indexNowUrls,
  isoWeekSunday,
  prevWeekSlug,
  writeDatedOttPages,
  writeIndexNowPayload,
  writeLanguagePages,
  writeWeekPage,
} = require("./lib/dated.js");
const {
  analyzeReception,
  attachBuzz,
  attachTakes,
  attachTrailerStats,
  audienceCounterpoint,
  composeTake,
  composeTmdbTake,
  computeBuzz,
  extractHook,
  fmtViews,
  isLegacyTake,
  isPoolTake,
  mineViewerAspects,
  reseedTake,
  TAKE_VERSION,
  TAKES_RETENTION_DAYS,
  trailerViewsLabel,
} = require("./lib/editorial.js");
const {
  certAudience,
  certFor,
  digitalReleaseFor,
  enrich,
  extractCastPics,
  imdbRatings,
  isPreListed,
  loadImdbRatings,
  regionalTheatricalDate,
  THEATRE_EXCLUDE_IDS,
  theatreEligible,
} = require("./lib/enrich.js");
const {
  buildPersonPage,
  buildStreamingPage,
  PEOPLE_MIN,
  peopleIndexFor,
  personPageUrl,
  STREAM_LANG_MIN,
  STREAM_PAGE_MIN,
  streamPageUrl,
  verifiedAvailability,
  writePeoplePages,
  writeStreamingPages,
} = require("./lib/evergreen.js");
const { buildFaqs, buildGoodToKnow, buildVerdictProse } = require("./lib/filmcopy.js");
const {
  assignSlugs,
  buildFilmPage,
  filmHubLinks,
  filmMetaDescription,
  filmTitleTag,
  generatePages,
  poolItems,
} = require("./lib/filmpage.js");
const {
  ARRIVAL_BADGE_DAYS,
  ARRIVAL_MAX_RELEASE_AGE,
  ARRIVAL_MIN_RELEASE_AGE,
  capTrending,
  earlierDate,
  filterTheatreFresh,
  freshBadge,
  freshLabel,
  freshnessWindowLabel,
  hasCardSubstance,
  isStillWorthIt,
  laterDate,
  orderOttForDisplay,
  OTT_RECENCY_MAX,
  OTT_SEEN_FILE,
  ottArrival,
  ottRecencyBonus,
  ottRenderable,
  pruneOttSeen,
  recordOttSeen,
  SEEN_RETENTION_DAYS,
  STILL_WORTH_DAYS,
  THEATRE_MIN_POOL,
  THEATRE_WINDOW_DAYS,
  THEATRE_WINDOW_FALLBACK_DAYS,
} = require("./lib/freshness.js");
const {
  buildOttMonthPage,
  buildPlatformHubPage,
  buildScopedMonthPage,
  hubsFor,
  languageMonthPath,
  languageMonthUrl,
  monthRow,
  ottMonthUrl,
  platformMonthPath,
  platformMonthUrl,
  SCOPED_MONTH_MIN,
  writeLanguageMonthPages,
  writeOttMonthPages,
  writeOttWeekPage,
  writePlatformMonthPages,
} = require("./lib/hubs.js");
const {
  applyArrivalPatch,
  applyDeparturePatch,
  applyDigitalDatePatch,
  archiveDepartedPages,
  backfillLiveClaims,
  backfillStreamClaims,
  departureCandidates,
  departureOutage,
  loadPagesManifest,
  patchDueIfPassed,
  recoverTmdbIds,
  refreshDuePages,
  settleDepartedCopy,
  sweepCandidates,
  sweepStreamingArrivals,
  sweepStreamingDepartures,
} = require("./lib/lifecycle.js");
const {
  buildLlmsFullTxt,
  buildLlmsTxt,
  LLMS_EARLY_DAYS,
  LLMS_EARLY_MIN_VOTES,
  LLMS_MIN_VOTES,
  llmsMachineSection,
  llmsRatingConfident,
  writeLlmsTxt,
} = require("./lib/llms.js");
const {
  analyticsTag,
  cspWith,
  digitalUpcoming,
  fitFirst,
  fitSiteTitle,
  footerAttribution,
  GC_SITE,
  hubOgImage,
  hubPath,
  hubUrl,
  img,
  isoWeekMonday,
  isoWeekOf,
  listingPageHtml,
  ogImageTag,
  ottMonthPath,
  platformSlug,
  settleReleasedCopy,
  socialImage,
  streamPagePath,
  theatreRunState,
  weekRangeFor,
  weekSlug,
  ytIdOf,
} = require("./lib/pagekit.js");
const {
  countryListForProse,
  countryNameFor,
  dedupeProviders,
  deriveFreshDate,
  EXCLUDE_IDS,
  EXCLUDE_TITLES,
  isExcluded,
  isOttFresh,
  LANG_CODE_OVERRIDES,
  langCode,
  langName,
  OTT_FRESH_DAYS,
  rankSimilar,
  replaceBetween,
  streamVocab,
  streamWindowEstimate,
  streamWindowShort,
  takeConfident,
  verdict,
} = require("./lib/rules.js");
const {
  healthIssue,
  healthNote,
  loadOttSeen,
  loadStateFile,
  RUN_HEALTH,
  RUN_HEALTH_FILE,
  stageFailed,
} = require("./lib/runhealth.js");
const { attachFcScores } = require("./lib/fcscore.js");
const { cachedCriticsTone } = require("./lib/editorial.js");
const { sweepScores } = require("./lib/scoresweep.js");
const { refreshRelated } = require("./lib/relrefresh.js");
const { syncVotes } = require("./lib/votes.js");
const { runAudit } = require("./lib/audit.js");
const { filmPageFiles, finishFilmPages, finishSitePages, sitePageFiles } = require("./lib/stylesheets.js");
const { contentFingerprint, pruneDeadHubLinks, sweepDeadHubLinks, syncFilmLastmods, writeMultiCountrySitemap } = require("./lib/sitemap.js");

// TMDB release_dates lookups per run for archived films with no cinema date yet (see the
// cinema-date backfill in main()). One call per film; the backlog clears in a run or two.
const CINEMA_DATE_BUDGET = Number(process.env.CINEMA_DATE_BUDGET || 150);
const {
  ABOUT_LASTMOD,
  buildDataPage,
  buildHeadTags,
  buildHomeJsonLd,
  buildMoreLinks,
  buildWindowsCsv,
  choosePick,
  heroPreload,
  marqueePick,
  marqueeScore,
  patchAboutPage,
  prerenderIndex,
  sectionCounts,
  ssrHero,
  ssrLastScan,
  ssrOttSection,
  writeCountrySurfaces,
  writeDataPage,
} = require("./lib/surfaces.js");
const {
  API_KEY,
  RATINGS_SOURCE,
  sleep,
  tmdb,
  USE_IMDB,
} = require("./lib/tmdb.js");
const {
  buildEditorNote,
  buildOttWeekPage,
  buildRssFeed,
  ottWeekPath,
  ottWeekUrl,
  ssrCard,
  ssrEditorNote,
  ssrSoonCard,
  writeRssFeed,
} = require("./lib/weekly.js");


if (!API_KEY && !process.env.PAGES_ONLY && require.main === module) {
  console.error("Missing TMDB_API_KEY. Add it in GitHub repo Settings → Secrets.");
  process.exit(1);
}

async function main() {
  const [movieGenres, tvGenres] = await Promise.all([tmdb("/genre/movie/list"), tmdb("/genre/tv/list")]);

  // Load IMDb's daily ratings dataset once (used to attach a second-opinion rating).
  // Filled in place (not reassigned): the Map is shared with lib/enrich.js, which reads it.
  { const loaded = await loadImdbRatings(); imdbRatings.clear(); for (const [k, v] of loaded) imdbRatings.set(k, v); }
  const gmap = {};
  for (const g of [...movieGenres.genres, ...tvGenres.genres]) gmap[g.id] = g.name;
  const genres = (ids) => (ids || []).slice(0, 2).map((i) => gmap[i]).filter(Boolean).join(" / ");

  function baseItem(m, kind) {
    const relDate = m.release_date || m.first_air_date;
    const daysSince = relDate ? (Date.now() - new Date(relDate).getTime()) / 864e5 : 999;
    // isRecent: released within 7 days — drives the "New release" badge (what a user
    // means by new). isFresh: also requires thin votes — drives the rating placeholder
    // and "verdict soon", since a fresh film with few votes can't be rated honestly yet.
    const isRecent = daysSince <= 7;
    const tooNew = isRecent && m.vote_count < 20;
    const showRating = !tooNew && m.vote_count >= 10;
    return {
      title: m.title || m.name,
      genre: genres(m.genre_ids),
      language: langName(langCode(m)),
      released: relDate,
      review: trim(m.overview),
      rating: showRating ? Number(m.vote_average.toFixed(1)) : null,
      scores: [{ source: "TMDB", score: showRating ? `${m.vote_average.toFixed(1)}/10` : "New release" }],
      votes: m.vote_count,
      verdict: tooNew ? "Just released — verdict soon" : verdict(m.vote_average, m.vote_count),
      poster: img(m.poster_path),
      isRecent,
      isFresh: tooNew,
      kind,
      tmdbId: m.id,
      popularity: m.popularity ?? null, // TMDB popularity = buzz/trending signal (for ranking)
    };
  }

  // After enrich, fold in the IMDb rating (from the dataset). Appends the IMDb chip,
  // IMDb-primary display: IMDb is the better, more comprehensive rating, so when it exists
  // it is the ONLY score shown — the TMDB chip is dropped. TMDB is kept solely as a labeled
  // fallback for films IMDb hasn't rated yet (too new / below IMDb's vote threshold), so the
  // freshest films still show a number instead of a blank. Also persists numeric imdbRating/
  // imdbVotes for ranking, and lets IMDb fill the verdict when TMDB had only a placeholder.
  function withImdb(item) {
    // In TMDB mode, IMDb never displaces the TMDB rating/verdict/score chip. (Redundant with
    // the empty IMDb map, but explicit so the display source is unmistakable.)
    if (!USE_IMDB) { item.imdbVotes = item.imdbVotes ?? null; delete item.imdbScore; return item; }
    if (item.imdbScore) {
      const num = parseFloat(item.imdbScore); // "7.4/10" -> 7.4
      // IMDb present -> show IMDb only (replace the scores array, dropping the TMDB chip).
      item.scores = [{ source: "IMDb", score: item.imdbScore }];
      if (!isNaN(num)) {
        item.imdbRating = num;       // persist numeric IMDb rating for ranking
        item.rating = num;           // IMDb is now the primary displayed rating
        item.verdict = verdict(num, 1000); // real verdict band from IMDb
        item.isFresh = false;        // has a real rating -> not a "no rating yet" placeholder
      }
    }
    // else: no IMDb rating — leave the existing TMDB-sourced scores array as-is. It already
    // reads "TMDB x.x/10" (labeled) when TMDB had a usable rating, or "New release" when the
    // film is too new for either source. This is the silent fallback for the freshest films.
    item.imdbVotes = item.imdbVotes ?? null;
    delete item.imdbScore;
    return item;
  }

  // Build all sections for one country from its config. Closes over shared helpers
  // (genres, baseItem, withImdb, verdict). Returns the data object for that country.
  async function buildCountry(cfg) {
  // ---------- IN THEATRES (quality-ranked within fresh pool + language representation, 4-7) ----------
  const INDIAN_LANGS = cfg.regionalLangs;
  const isRegional = (m) => INDIAN_LANGS.includes(langCode(m));

  // Base pool: TMDB's "now playing" for this country.
  const np1 = await tmdb("/movie/now_playing", { region: cfg.region, page: "1" });
  await sleep(150);
  const np2 = await tmdb("/movie/now_playing", { region: cfg.region, page: "2" });
  // Seed `seen` with the manual exclusion list so blocked films (banned/pulled/mislisted)
  // are skipped everywhere the pool is built below — both now_playing and discover.
  const seen = new Set(EXCLUDE_IDS);
  let pool = [...np1.results, ...(np2.results || [])].filter((m) => {
    if (seen.has(m.id) || isExcluded(m)) { return false; } seen.add(m.id); return true;
  });

  // Multi-source supplement: now_playing is incomplete for Indian regional theatrical
  // releases (distributors/contributors don't always report them), so we also pull recent
  // THEATRICAL releases per Indian language via discover. release_type 3|2 = theatrical/
  // limited theatrical (not direct-to-OTT), and a 3-week window keeps it current — wide
  // enough for films still running, tight enough to avoid resurfacing the back catalogue.
  // These merge into the pool on equal footing; the normal ranking decides what's picked.
  // (THEATRE_WINDOW_DAYS lives at module scope now — it gates the WHOLE pool, not just this query.)
  const theatreCutoff = new Date(Date.now() - THEATRE_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);
  // Priority languages for theatre representation: Hindi, Tamil, Telugu. Discover queries
  // target these so they reliably enter the pool; now_playing still brings in everything
  // else (English, other regional) so a standout outside these can still earn a slot.
  const PRIORITY_LANGS = cfg.priorityLangs;
  for (const lang of PRIORITY_LANGS) {
    try {
      const d = await tmdb("/discover/movie", {
        region: cfg.region,
        with_original_language: lang,
        "primary_release_date.gte": theatreCutoff,
        "primary_release_date.lte": todayStr,
        with_release_type: "3|2",
        sort_by: "popularity.desc",
        page: "1",
      });
      for (const m of (d.results || [])) {
        if (!seen.has(m.id) && !isExcluded(m)) { seen.add(m.id); pool.push(m); }
      }
    } catch (e) { console.warn(`theatre-discover ${lang}: ${e.message}`); }
    await sleep(150);
  }

  // Gate the WHOLE pool by the freshness window (filterTheatreFresh, module scope). This is
  // the fix for month-old now_playing films topping "Latest big-screen releases": discover
  // results were already date-gated by their query, but now_playing results were not. Runs
  // BEFORE IMDb enrichment so stale films never cost detail calls.
  const poolBeforeGate = pool.length;
  pool = filterTheatreFresh(pool);
  console.log(`  theatre pool: ${poolBeforeGate} -> ${pool.length} after freshness gate (${THEATRE_WINDOW_DAYS}d window)`);

  // Attach IMDb rating to each pool film BEFORE ranking, so IMDb (which has far more
  // Indian raters than TMDB) drives selection — not just display. One detail call per
  // film to resolve its IMDb ID, then a cheap lookup in the loaded dataset. Runs once
  // a day, so the extra calls are immaterial. Any failure leaves _imdbRating null and
  // the film falls back to its TMDB rating — never blocks ranking.
  // Resolve each pool film's IMDb ID -> dataset rating BEFORE ranking, so IMDb (which has far
  // more Indian raters than TMDB) drives selection, not just display. One detail call per film,
  // then a cheap in-memory lookup. SKIPPED ENTIRELY when RATINGS_SOURCE=tmdb — no IMDb data is
  // used, so these calls (and their pacing sleeps) would be pure waste. Any failure leaves
  // _imdbRating null and the film falls back to its TMDB rating — never blocks ranking.
  if (USE_IMDB) {
    for (const m of pool) {
      try {
        const d = await tmdb(`/movie/${m.id}`, { append_to_response: "external_ids" });
        const imdbId = d.external_ids?.imdb_id;
        if (imdbId && imdbRatings.has(imdbId)) {
          const r = imdbRatings.get(imdbId);
          if (r && r.rating) {
            m._imdbRating = parseFloat(r.rating);
            m._imdbVotes = r.votes || 0;
          }
        }
      } catch (e) { console.warn(`imdb-id ${m.id}: ${e.message}`); }
      await sleep(150);
    }
  }

  // Tunable: neutral prior C and smoothing constant M (how many votes before a
  // rating is trusted on its own). Per-country config can override these later.
  const PRIOR_C = 6.0, SMOOTH_M = 8;
  // Best available rating/votes: IMDb when present (more raters for Indian titles),
  // else TMDB. These drive both the quality floor and the ranking score.
  const bestRating = (m) => {
    if (USE_IMDB && m._imdbRating != null) return m._imdbRating;
    if ((m.vote_count || 0) >= 10) return m.vote_average || 0;
    return null; // no usable rating yet
  };
  const bestVotes = (m) => ((USE_IMDB && m._imdbRating != null) ? (m._imdbVotes || 0) : (m.vote_count || 0));
  // Freshness is enforced by the POOL, not the ranking. Within the fresh pool we rank on
  // quality with an ADDITIVE form: rating sets the baseline and vote volume gives a gentle
  // confidence nudge — score = rating + 0.5*log10(votes+10). This means an excellent film
  // (e.g. a new Indian release at 8.3) leads on merit and is NOT buried by a merely-good
  // Hollywood title with huge vote counts; among films of similar rating, the more
  // widely-confirmed one ranks higher. Popularity is not a factor. Unrated-but-fresh films
  // fall back to a neutral prior so they still place.
  // Freshness is BOTH a gate (the pool) and a ranking driver. Within the fresh pool, a
  // bounded recency bonus makes genuinely-newer films rank above comparable older ones —
  // this is a "latest releases" site, so among good films the newest should lead. The
  // bonus is CAPPED (+2.0 at release, linear decay to 0 by 14 days) so it reorders films
  // of similar quality but can't let a weak fresh film leapfrog a much stronger recent one
  // (e.g. a 6.0 from today at +2.0 = 8.0 still loses to an 8.5 from last week).
  const RECENCY_MAX = 2.0, RECENCY_DAYS = 21;
  const recencyBonus = (m) => {
    const d = m.release_date || m.first_air_date;
    if (!d) return 0;
    const age = (Date.now() - new Date(d).getTime()) / 864e5;
    if (age < 0 || age > RECENCY_DAYS) return 0;
    return RECENCY_MAX * (1 - age / RECENCY_DAYS); // full at age 0, 0 at RECENCY_DAYS
  };
  // (qualityScore retired — ranking now uses the 40/35/25 weighted402535 score everywhere)

  // Suspicious-entry guard: a real, currently-relevant film does not have an implausibly high
  // rating on tiny volume, or a high rating with essentially zero audience interest. These are
  // fake/erroneous records or vote-manipulated titles. Thresholds are mode-aware because IMDb
  // and TMDB have very different vote SCALES (IMDb counts are ~10-50x TMDB's). Conservative in
  // both modes so genuine films are never caught.
  const isSuspicious = (m) => {
    const p = m.popularity || 0;
    if (USE_IMDB) {
      const r = m._imdbRating, v = m._imdbVotes || 0;
      if (r == null) return false;
      if (r >= 9.5 && v < 5000) return true;            // implausibly high rating, thin votes
      if (r >= 8.5 && v < 3000 && p < 1.0) return true; // high rating but ~zero audience interest
    } else {
      const r = (m.vote_count || 0) >= 10 ? m.vote_average : null;
      const v = m.vote_count || 0;
      if (r == null) return false;
      if (r >= 9.5 && v < 200) return true;             // TMDB scale: implausibly high on thin votes
      if (r >= 9.0 && v < 100 && p < 2.0) return true;  // high rating, almost no votes, no buzz
    }
    return false;
  };
  // Stale / re-release guard. TMDB's now_playing for a region sometimes returns OLD films —
  // re-releases back in cinemas or stale regional listings — that wrongly appear "fresh". A
  // DATE check can't catch the honestly-old ones, so the reliable signal is BUZZ: a film truly
  // drawing audiences now has high current popularity; an old film coasting on lifetime votes
  // does not. We drop "famous but not buzzing now" via two patterns. Popularity is the SAME
  // field in both modes, but vote SCALE differs hugely (IMDb ~10-50x TMDB), so vote thresholds
  // are mode-aware. IMDb refs: Top Gun 879k/pop25, Shrek 812k/pop26, Chandu Champion 36k/pop1.5.
  // TMDB refs (much lower counts): Shrek ~18k, Top Gun Maverick ~11k; a days-old release rarely
  // exceeds ~1-2k TMDB votes, so a high count + low popularity reliably means "old, not fresh".
  const looksReRelease = (m) => {
    const p = m.popularity || 0;
    if (USE_IMDB) {
      const v = m._imdbVotes || 0;
      if (v > 50000 && p < 80) return true;  // famous catalogue title, not currently buzzing
      if (v > 20000 && p < 5) return true;   // older title with essentially no current interest
    } else {
      const v = m.vote_count || 0;           // TMDB vote scale
      if (v > 3000 && p < 80) return true;   // famous catalogue title (Shrek/Top Gun), cooled off
      if (v > 1000 && p < 5) return true;    // older title with essentially no current interest
    }
    return false;
  };
  const clearsBar = (m) => {
    if (isSuspicious(m)) return false;
    if (looksReRelease(m)) return false;
    const r = bestRating(m);
    return r == null || r >= 5.5;
  };

  // 40/35/25 quality weighting (your spec): IMDb rating 40%, IMDb vote volume 35%, current
  // buzz/popularity 25%. Votes and buzz are log-scaled then normalized 0..1 across the pool
  // (so the heavy tail of Hollywood vote counts doesn't dwarf everything), rating is /10.
  // A bounded freshness multiplier from recencyBonus keeps "feel fresh" in the mix. This
  // score orders films WITHIN the soft language quota — it decides which Hindi/English/etc.
  // film fills each slot and their order, while the quota still guarantees Hindi its slots.
  const poolForNorm = pool.filter((m) => !isSuspicious(m));
  const maxLogV = Math.max(1, ...poolForNorm.map((m) => Math.log10((m._imdbVotes || m.vote_count || 0) + 1)));
  const maxLogP = Math.max(0.01, ...poolForNorm.map((m) => Math.log10((m.popularity || 0) + 1)));

  // LANGUAGE-COHORT NORMALIZATION. The 35% vote-volume and 25% buzz terms measure how many
  // people worldwide have logged a film — and TMDB's userbase is heavily Western. Normalizing
  // those two terms across the whole mixed-language pool therefore compares a Kannada film's
  // vote count against Hollywood's, which it structurally cannot win: the biggest Kannada
  // release of the year carries a fraction of the votes of a forgettable English action title.
  // The result is 60% of the score quietly measuring "is this English?" on a page for India.
  //
  // score.js already flags this bias in its header, and REP_BAR above already compensates for
  // it in the representation gate — this closes the same gap in the ranking itself. Volume and
  // buzz are now scaled against the film's OWN language cohort, so the term reads "how big is
  // this film for its language" rather than "how big is this film in America". Rating (40%) is
  // untouched: it was never the biased part.
  //
  // Two guards keep a thin cohort from inflating a weak film to a perfect 1.0:
  //   - a cohort needs MIN_COHORT films before it gets its own scale, else it uses the global one
  //   - a cohort scale can't fall below COHORT_FLOOR of the global scale, so a language whose
  //     films are all tiny doesn't get its biggest tiny film scored like a blockbuster
  // COHORT_BLEND is partial on purpose. At 1.0 the volume term stops discriminating between
  // languages entirely — every language's biggest film scores a flat 1.0 — and the page loses
  // any signal that something is a genuine mass phenomenon rather than merely the largest film
  // in a small pool. At 0.65 a regional standout can lead the page on merit while a real
  // blockbuster still carries weight. This is the one number to turn if the balance drifts.
  const COHORT_BLEND = 0.65;
  const MIN_COHORT = 3;      // below this the cohort max is noise, not a scale
  const COHORT_FLOOR = 0.55; // a cohort's scale is at least 55% of the global scale
  const cohortStats = new Map();
  for (const m of poolForNorm) {
    const L = langCode(m) || "??";
    const s = cohortStats.get(L) || { n: 0, v: 0, p: 0 };
    s.n += 1;
    s.v = Math.max(s.v, Math.log10((m._imdbVotes || m.vote_count || 0) + 1));
    s.p = Math.max(s.p, Math.log10((m.popularity || 0) + 1));
    cohortStats.set(L, s);
  }
  // Median scale across the language cohorts — what a TYPICAL language looks like in this
  // pool, as opposed to what the biggest one looks like.
  const medianCohort = (key) => {
    const xs = [...cohortStats.values()].filter((s) => s.n >= MIN_COHORT).map((s) => s[key]).sort((a, b) => a - b);
    if (!xs.length) return null;
    return xs[Math.floor(xs.length / 2)];
  };
  const medV = medianCohort("v"), medP = medianCohort("p");

  const scaleFor = (m, key, globalMax) => {
    const s = cohortStats.get(langCode(m) || "??");
    // A cohort too thin to have a meaningful max of its own does NOT fall back to the global
    // max — that is the Western-skewed quantity this whole mechanism exists to neutralise, so
    // falling back to it silently disabled the fix for exactly the languages that needed it.
    // Observed in production on 8 Sept 2026: Kannada had ONE film in the pool, so the highest-
    // rated film of the week (8.0) was scored against Hollywood's vote counts and stayed at
    // position 5 while a 6.4 English title led the page. Fall back to the median cohort scale
    // instead: harsher than the language's own max (which would hand a lone film a free 1.0),
    // far fairer than the global max.
    const med = key === "v" ? medV : medP;
    let cohort;
    if (s && s.n >= MIN_COHORT) cohort = Math.max(s[key], COHORT_FLOOR * globalMax);
    else if (med != null) cohort = Math.max(med, COHORT_FLOOR * globalMax);
    else return globalMax;
    return COHORT_BLEND * cohort + (1 - COHORT_BLEND) * globalMax;
  };

  const weighted402535 = (m) => {
    const rN = (bestRating(m) ?? PRIOR_C) / 10;
    const vN = Math.min(1, Math.log10((bestVotes(m)) + 1) / scaleFor(m, "v", maxLogV));
    const pN = Math.min(1, Math.log10((m.popularity || 0) + 1) / scaleFor(m, "p", maxLogP));
    const base = 0.40 * rN + 0.35 * vN + 0.25 * pN;
    // freshness nudge: scale recencyBonus (0..2) to a small 0..0.10 multiplier-add so the
    // newest films get a slight edge without overriding the quality+popularity signal.
    return base + 0.05 * recencyBonus(m);
  };

  const ranked = pool.filter(clearsBar).sort((a, b) => weighted402535(b) - weighted402535(a));
  const MIN_PICKS = 4, MAX_PICKS = 7;

  // Soft-priority composition: target mix is 3 Hindi, 2 English, 1 Tamil, 1 Telugu (= 7).
  // Slots are filled by the best film of that language under the 40/35/25 score (clearing
  // the 6.5 representation bar). It's SOFT: any target that can't be filled by its language
  // is left for the fallback pass, where the best remaining film of ANY language (clearing
  // the 5.5 floor + suspicious guard) takes the slot — so a standout outside the target set
  // can still make the list, and we never pad a slot with a weak film or leave it short.
  const TARGETS = cfg.theatreTargets;
  // Representation rating bar. IMDb mode: 6.5 (IMDb has plenty of Indian raters, so this is a
  // meaningful quality gate). TMDB mode: TMDB under-rates AND under-counts regional cinema
  // (Western-skewed audience), so a 6.5 bar wrongly empties the Hindi/Tamil/Telugu quotas. Use
  // a lower bar AND treat an absent rating as acceptable (a legit Hindi film with few TMDB votes
  // must still be eligible for Hindi representation; it already cleared the pool's quality floor).
  const REP_BAR = USE_IMDB ? 6.5 : 5.0;
  const repRating = (m) => bestRating(m) ?? (USE_IMDB ? 0 : REP_BAR); // null fails in IMDb, passes in TMDB
  let picks = [];
  for (const [lang, n] of TARGETS) {
    const langFilms = ranked.filter((m) => langCode(m) === lang && repRating(m) >= REP_BAR && !picks.includes(m));
    for (let i = 0; i < n && i < langFilms.length; i++) picks.push(langFilms[i]);
  }
  // Soft fallback: fill any remaining slots (up to MAX_PICKS) with the best films of any
  // language not already picked — this is where exceptional non-target-language films land.
  for (const m of ranked) {
    if (picks.length >= MAX_PICKS) break;
    if (!picks.includes(m)) picks.push(m);
  }
  // Guarantee a minimum even in a thin week.
  for (const m of ranked) {
    if (picks.length >= MIN_PICKS) break;
    if (!picks.includes(m)) picks.push(m);
  }
  picks = picks.slice(0, MAX_PICKS).sort((a, b) => weighted402535(b) - weighted402535(a));

  // SCORE TRACE. The language-cohort normalization above has now been tuned twice against
  // reconstructed pools and twice failed to change the live ordering, because the real pool
  // is larger than anything reconstructable from the published data files and its cohort
  // statistics are therefore unknown. Rather than guess a third time, print the actual
  // inputs. Each line shows the three weighted components, the scale each film was measured
  // against, and whether that scale came from its own cohort or the median fallback — which
  // is exactly the information needed to tell WHY a 6.4 outranks a 7.9. Cheap, log-only,
  // and it makes the next run answer the question definitively.
  if (process.env.SCORE_TRACE !== "0") {
    console.log(`  [score trace ${cfg.code}] pool=${pool.length} normPool=${poolForNorm.length} maxLogV=${maxLogV.toFixed(3)} maxLogP=${maxLogP.toFixed(3)} medV=${medV == null ? "—" : medV.toFixed(3)} medP=${medP == null ? "—" : medP.toFixed(3)}`);
    const cohortLine = [...cohortStats.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([L, st]) => `${L}:n=${st.n},v=${st.v.toFixed(2)}`).join("  ");
    console.log(`  [score trace ${cfg.code}] cohorts  ${cohortLine}`);
    for (const m of picks) {
      const L = langCode(m) || "??";
      const st = cohortStats.get(L);
      const own = !!(st && st.n >= MIN_COHORT);
      const sv = scaleFor(m, "v", maxLogV);
      const rN = (bestRating(m) ?? PRIOR_C) / 10;
      const vN = Math.min(1, Math.log10(bestVotes(m) + 1) / sv);
      const pN = Math.min(1, Math.log10((m.popularity || 0) + 1) / scaleFor(m, "p", maxLogP));
      console.log(
        `  [score trace ${cfg.code}] ${String(weighted402535(m).toFixed(3)).padStart(5)}` +
        ` = r${(0.40 * rN).toFixed(3)} + v${(0.35 * vN).toFixed(3)} + p${(0.25 * pN).toFixed(3)}` +
        ` | ${L} ${own ? "own-cohort" : "MEDIAN-FALLBACK"} scaleV=${sv.toFixed(3)}` +
        ` | rating=${bestRating(m) ?? "—"} votes=${bestVotes(m)} pop=${(m.popularity || 0).toFixed(0)}` +
        ` | ${String(m.title || "").slice(0, 34)}`);
    }
  }

  // The soft top-3 language reserve that used to sit here has been REMOVED.
  //
  // It reserved the first three slots for English/Hindi films unless a regional film beat the
  // best of them by 0.15 on the weighted score. That rule existed to compensate for a score
  // that under-rated regional cinema — but the compensation happened at the wrong layer, and
  // now that the score itself is de-biased by language-cohort normalization above, keeping it
  // would double-count the preference and re-introduce exactly the bug it was masking.
  //
  // Concretely, on this week's India set it put Mutiny (weighted 0.866) at position 1 above
  // Toxic (0.897): a list that was visibly not sorted by its own score, and that contradicted
  // the editor's note recommending Toxic. Language REPRESENTATION is still guaranteed — that is
  // what the TARGETS quota above does, and it is untouched. This block only ever controlled the
  // ORDER within an already-representative set, and quality order is the honest answer there.

  // Enrich picks with a THEATRICAL gate + bench refill: a pick that turns out to be a
  // digital-only release (the Ikka class) is dropped, and the next ranked film that
  // wasn't selected takes its slot — the list never silently shrinks below target.
  const targetCount = picks.length;
  const bench = ranked.filter((m) => !picks.includes(m));
  const theatres = [];
  for (const m of [...picks, ...bench]) {
    if (theatres.length >= targetCount) break;
    if (THEATRE_EXCLUDE_IDS.has(m.id)) continue;
    const item = { ...baseItem(m, "movie"), platform: "Theatres" };
    try { Object.assign(item, await enrich("movie", m.id, cfg.watchRegion)); withImdb(item); } catch (e) { console.warn(`enrich movie ${m.id}: ${e.message}`); }
    if (item.theatrical === false) {
      console.log(`  theatres: dropped ${item.title} — digital-only release, no theatrical run in ${cfg.region}`);
      continue;
    }
    // A platform page that went up before the film opened is a placeholder: it's in cinemas,
    // so its page must not say "streaming" (see isPreListed in lib/enrich.js).
    if ((item.providers || []).length) {
      const seen = (loadOttSeen()[cfg.code] || {})[`movie:${item.tmdbId}`];
      if (isPreListed({ kind: "movie", hasProviders: true, theatricalDate: item.theatricalHere ? item.released : null,
        theatrical: item.theatrical, language: item.language, digitalDate: item.digitalDate, firstSeen: seen && seen.first })) {
        console.log(`  theatres: ${item.title} — ${item.providers.join(", ")} listing predates the cinema release; treated as not streaming yet`);
        item.providers = []; delete item.rentBuy;
      }
    }
    theatres.push(item);
    await sleep(150);
  }

  // Theatre pool for the language pages. The homepage keeps its 7 slots; the bench is the
  // set of films that cleared the same quality bar and simply lost a slot to the quota, so
  // a Malayalam film that was never going to beat three Hindi films for a homepage place
  // still belongs on /malayalam/. Capped per language and enriched only for languages that
  // have a page, so this costs nothing on countries without one.
  const langTheatres = {};
  {
    const PAGE_LANGS_T = new Set(LANGUAGE_PAGES.map(([name]) => name));
    const THEATRE_POOL_MAX = 6;
    const onPage = new Set(theatres.map((t) => t.tmdbId));
    for (const m of bench) {
      if (THEATRE_EXCLUDE_IDS.has(m.id)) continue;
      const name = langName(langCode(m));
      if (!PAGE_LANGS_T.has(name)) continue;
      const already = (langTheatres[name] || []).length + theatres.filter((t) => t.language === name).length;
      if (already >= THEATRE_POOL_MAX) continue;
      const item = { ...baseItem(m, "movie"), platform: "Theatres" };
      try { Object.assign(item, await enrich("movie", m.id, cfg.watchRegion)); withImdb(item); }
      catch (e) { console.warn(`enrich bench movie ${m.id}: ${e.message}`); continue; }
      if (item.theatrical === false) continue;      // same digital-only gate as the homepage
      if (onPage.has(item.tmdbId)) continue;        // already shown, don't duplicate
      (langTheatres[name] = langTheatres[name] || []).push(item);
      await sleep(150);
    }
    for (const [name, list] of Object.entries(langTheatres))
      console.log(`  theatre-pool ${name}: +${list.length} beyond the homepage`);
  }

  // ---------- TOP 10 ON OTT (international + fresh regional, IMDb-ranked, max 10) ----------
  // International from global trending (inherently fresh); regional from per-language
  // discover gated to recent releases so we never resurface all-time classics. Both
  // ranked with the same IMDb-preferred quality term as theatres, for consistency.
  const OTT_MAX = 10;
  const OTT_REGIONAL_TARGET = (cfg.ottRegionalLangs && cfg.ottRegionalLangs.length) ? 4 : 0;
  const OTT_INTL_CAP = OTT_MAX - OTT_REGIONAL_TARGET;
  const FRESH_DAYS = 30;
  const freshCutoff = new Date(Date.now() - FRESH_DAYS * 864e5).toISOString().slice(0, 10);

  // OTT staleness gate. Trending-this-week is a freshness PROXY, but perennial catalogue
  // hits (Rick and Morty, The Boys) trend every week on rewatches, so the proxy leaks
  // all-time classics into a "latest releases" list. The fix is a real recency check on
  // the item's freshDate (movie release date, or a TV series' LATEST-season air date — not
  // its original launch). This keeps a returning hit's NEW season (recent freshDate) while
  // dropping an old show with no recent season. See isOttFresh/OTT_FRESH_DAYS (module scope).
  // Gate runs on the EFFECTIVE date (release/season OR first platform sighting), so a
  // theatrical film that just landed on OTT months after release is correctly kept.
  const ottIsFresh = (item) => item && isOttFresh(item.ottFreshDate || item.freshDate);

  // First-seen tracking state for THIS country (see module-scope docs at ott-seen.json).
  // coldStart is captured BEFORE any recording so seeding stays consistent for the run.
  const seenAll = loadOttSeen();
  const seenCountry = (seenAll[cfg.code] = seenAll[cfg.code] || {});
  const seenColdStart = Object.keys(seenCountry).length === 0;
  // (todayStr already declared earlier in buildCountry — reused for recording sightings.)

  // Resolve IMDb rating for a candidate (detail call -> dataset lookup). Sets _imdbRating
  // so weighted402535 uses IMDb as the rating/votes signal, exactly like theatres. No-op in
  // TMDB mode (IMDb data unused) — skipping it avoids a wasted detail call per candidate.
  const attachImdb = async (c) => {
    if (!USE_IMDB) return;
    try {
      const d = await tmdb(`/${c.kind}/${c.id}`, { append_to_response: "external_ids" });
      const imdbId = d.external_ids?.imdb_id;
      if (imdbId && imdbRatings.has(imdbId)) {
        const r = imdbRatings.get(imdbId);
        if (r && r.rating) { c._imdbRating = parseFloat(r.rating); c._imdbVotes = r.votes || 0; }
      }
    } catch (e) { /* leave _imdbRating null -> falls back to TMDB rating */ }
  };

  const buildOttItem = async (c) => {
    const item = baseItem(c, c.kind);
    const extra = await enrich(c.kind, c.id, cfg.watchRegion);
    if (!extra.providers || extra.providers.length === 0) return null; // not streaming in this region
    Object.assign(item, extra, { platform: extra.providers[0] });
    withImdb(item);
    item._w = weighted402535(c); // quality score kept for the recency re-rank below (stripped before write)

    // First-seen tracking: this title was observed WITH a provider today. ottSince is the
    // (approximate) platform-arrival date; ottFreshDate is what the gate + recency decay use.
    const firstSeen = recordOttSeen(seenCountry, `${item.kind}:${item.tmdbId}`, item.freshDate, todayStr, seenColdStart);
    // Mirror the sighting into the append-only archive (see lib/history.js). ott-seen.json
    // prunes after 180 days because it is a freshness signal; this never prunes, because it
    // is the record. Written for EVERY candidate observed with a provider — not only the ones
    // that win a slot on the page — which is the difference between a sample and a census.
    try {
      appendHistory(historyRecord({
        code: cfg.code, kind: item.kind, tmdbId: item.tmdbId, title: item.title,
        platform: extra.providers && extra.providers[0], providers: extra.providers,
        first: firstSeen, theatrical: item.released, language: item.language, genre: item.genre,
        // This country's own cinema date, or null for a film that never opened here — the
        // difference /data/ needs (enrich sets theatricalHere only for a TMDB type 2/3 date).
        cinema: item.kind === "tv" ? undefined : (item.theatricalHere ? item.released : null),
      }));
    } catch (e) { /* archive is additive; never let it break a build */ }
    // Placeholder listing (platform page up before the cinema release, still inside the usual
    // window): not streaming yet — the film belongs under In Theatres (lib/enrich.js isPreListed).
    if (isPreListed({ kind: item.kind, hasProviders: true, theatricalDate: item.theatricalHere ? item.released : null,
      theatrical: item.theatrical, language: item.language, digitalDate: item.digitalDate, firstSeen })) {
      console.log(`  ott [${cfg.code}]: skipped ${item.title} — ${item.platform} listing first seen ${firstSeen}, before its ${item.released} cinema release`);
      return null;
    }
    const { effective, isArrival } = ottArrival(item.freshDate, firstSeen);
    item.ottSince = firstSeen;
    item.ottFreshDate = effective;
    // Arrival badge — only when no release-event badge already applies (one badge, clear
    // meaning): an older release newly sighted on the platform is news AS an arrival.
    if (!item.badge && isArrival && item.platform && item.platform !== "Theatres") {
      item.badge = `New on ${item.platform}`;
      item.isRecent = true;
    }
    // Integrity gate at the SOURCE: a pre-release provider listing (future-dated movie /
    // future TV season) is rejected here, before any pool counts it — so selection and
    // backfill naturally pick the next candidate and the final list arrives at OTT_MAX
    // already clean. (orderOttForDisplay's own filter remains as a belt-and-braces net,
    // but gating only there let dropped items shrink the list below 10 with no refill.)
    if (!ottRenderable(item)) return null;
    return item;
  };

  // --- International pool: global trending. Trending IS the freshness signal here — it
  //     captures what people are watching now, including returning seasons of hit shows
  //     that a release-date gate would wrongly exclude (TMDB dates the series' original
  //     launch, not the new season). Within this fresh set, rank purely by quality. ---
  const [trMovies, trTv] = await Promise.all([tmdb("/trending/movie/week"), tmdb("/trending/tv/week")]);
  let intlCands = [
    ...trMovies.results.map((m) => ({ ...m, kind: "movie" })),
    ...trTv.results.map((t) => ({ ...t, kind: "tv" })),
  ].filter((c) => !isRegional(c) && !isExcluded(c));
  for (const c of intlCands) { await attachImdb(c); await sleep(150); }
  // Drop fake/manipulated entries AND famous-but-not-currently-buzzing catalogue titles
  // (looksReRelease) — the same buzz guard theatres use, which the OTT intl pool previously
  // skipped. This is the cheap first cut; the authoritative recency check (ottIsFresh) runs
  // after build, once enrich() has resolved each title's real freshDate.
  intlCands = intlCands.filter((c) => !isSuspicious(c) && !looksReRelease(c));
  intlCands.sort((a, b) => weighted402535(b) - weighted402535(a));

  const intl = [], usedIds = new Set();
  for (const c of intlCands) {
    if (intl.length >= OTT_INTL_CAP) break;
    try {
      const it = await buildOttItem(c);
      // Recency gate: keep only genuinely-fresh titles. A trending old movie, or an old
      // series with no recent season, fails here and we move on to the next candidate —
      // so the slot goes to a genuinely new release instead of an all-time classic.
      if (it && ottIsFresh(it)) { intl.push(it); usedIds.add(c.id); }
      else if (it) console.log(`  ott-intl skip (stale): ${it.title} freshDate=${it.freshDate}`);
    }
    catch (e) { console.warn(`ott-intl ${c.id}: ${e.message}`); }
    await sleep(150);
  }

  // --- Regional pool: per-language discover, gated to recent releases (anti-staleness),
  //     Hindi first, IMDb-ranked. This is what surfaces fresh Hindi/regional OTT shows
  //     that never trend globally.
  //
  //     FETCHING IS NOW DECOUPLED FROM SLOTTING. The loop used to break the moment the
  //     homepage's 4 regional slots were full, which meant Hindi and Tamil consumed the
  //     budget and the discover call for Malayalam, Kannada, Telugu, Punjabi, Marathi and
  //     Bengali was NEVER MADE. /malayalam/ and /kannada/ rendered one film each not
  //     because those languages had a quiet week but because nothing ever asked TMDB about
  //     them. Every language in ottRegionalLangs is now queried on every run; the homepage
  //     cap is unchanged and applied afterwards, and the full per-language pool is carried
  //     out on langPool for the language pages to draw on. ---
  const regionalOrder = cfg.ottRegionalLangs || [];
  // Languages that have their own landing page need a pool deep enough to fill one; the
  // rest only need enough candidates to compete for a homepage slot. Depth is bounded
  // either way — each built item costs an enrich call, so this is the cost dial.
  const PAGE_LANGS = new Set(LANGUAGE_PAGES.map(([name]) => name));
  const CAND_CAP = 12;       // candidates per language that get a rating lookup
  const POOL_DEEP = 8;       // built items kept for a language that has a landing page
  const POOL_SHALLOW = 3;    // built items kept for a language that does not
  const langPool = {};       // langName -> built OTT items, best-first (page data, not homepage)
  const regionalByLang = new Map();
  for (const lang of regionalOrder) {
    let cands = [];
    for (const kind of ["tv", "movie"]) {
      const dateField = kind === "tv" ? "first_air_date.gte" : "primary_release_date.gte";
      try {
        const d = await tmdb(`/discover/${kind}`, {
          with_original_language: lang,
          watch_region: cfg.watchRegion,
          with_watch_monetization_types: "flatrate",
          sort_by: "popularity.desc",
          [dateField]: freshCutoff, // only recent releases — never all-time classics
          page: "1",
        });
        await sleep(150);
        cands.push(...(d.results || []).map((m) => ({ ...m, kind })));
      } catch (e) { console.warn(`ott-regional ${lang}/${kind}: ${e.message}`); }
    }
    cands = cands.filter((c) => !usedIds.has(c.id) && !isExcluded(c));
    // Trim by raw popularity BEFORE the rating lookups. Running every language now means
    // ~8x the candidates, and attachImdb costs a detail call each; the titles below the
    // popularity cap were never going to win a slot or a pool place. No-op in TMDB mode
    // beyond the trim itself, where attachImdb returns immediately.
    cands.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    cands = cands.slice(0, CAND_CAP);
    for (const c of cands) { await attachImdb(c); if (USE_IMDB) await sleep(150); }
    // Quality floor on the best rating we have: IMDb if present, else TMDB. A film is
    // only allowed through unfloored when it has NO usable rating at all (genuinely too
    // new to judge) — then popularity decides. This stops mediocre thin-data films from
    // sneaking in while still giving truly-unrated fresh titles a chance.
    const ottRating = (c) => {
      if (c._imdbRating != null) return c._imdbRating;
      if ((c.vote_count || 0) >= 10) return c.vote_average || 0;
      return null; // no usable rating
    };
    cands = cands
      .filter((c) => !isSuspicious(c)) // drop fake/manipulated entries
      .filter((c) => { const r = ottRating(c); return r == null || r >= 5.5; })
      .sort((a, b) => weighted402535(b) - weighted402535(a));
    const name = langName(lang);
    const depth = PAGE_LANGS.has(name) ? POOL_DEEP : POOL_SHALLOW;
    const built = [];
    for (const c of cands) {
      if (built.length >= depth) break;
      if (usedIds.has(c.id)) continue;
      try { const it = await buildOttItem(c); if (it) built.push(it); }
      catch (e) { console.warn(`ott-regional-build ${c.id}: ${e.message}`); }
      await sleep(150);
    }
    if (built.length) {
      langPool[name] = built;
      regionalByLang.set(lang, built);
      console.log(`  ott-pool ${lang} (${name}): ${built.length} title(s)`);
    }
  }

  // Homepage regional slots: unchanged cap, filled in the config's language priority order
  // so Hindi still leads. Everything not selected stays in langPool for the language pages,
  // which is the whole point of fetching it. usedIds is only marked for the titles that
  // actually take a homepage slot, so a pool title can still appear on its language page.
  const regional = [];
  for (const lang of regionalOrder) {
    if (regional.length >= OTT_REGIONAL_TARGET) break;
    for (const it of regionalByLang.get(lang) || []) {
      if (regional.length >= OTT_REGIONAL_TARGET) break;
      if (usedIds.has(it.tmdbId)) continue;
      regional.push(it);
      usedIds.add(it.tmdbId);
    }
  }

  // --- Backfill with more international if regional fell short, so list reaches 10 ---
  if (regional.length < OTT_REGIONAL_TARGET) {
    for (const c of intlCands) {
      if (intl.length + regional.length >= OTT_MAX) break;
      if (usedIds.has(c.id)) continue;
      try {
        const it = await buildOttItem(c);
        if (it && ottIsFresh(it)) { intl.push(it); usedIds.add(c.id); } // same recency gate as the main pass
      }
      catch (e) { console.warn(`ott-backfill ${c.id}: ${e.message}`); }
      await sleep(150);
    }
  }

  // --- International surplus for /new-on-ott/. The homepage caps at 10; that page promises
  //     "all", links to itself from the homepage as "All new OTT releases this week", and until
  //     now rendered the SAME ten titles regrouped by platform — a click that gave the reader
  //     nothing they had not just seen. langPools fixes this for India, but it is empty on
  //     countries with no language pages, so those pages need their own surplus. Bounded, and
  //     it reuses candidates already fetched from trending — only the enrich call is new. ---
  const OTT_SURPLUS_MAX = 6;
  const surplus = [];
  for (const c of intlCands) {
    if (surplus.length >= OTT_SURPLUS_MAX) break;
    if (usedIds.has(c.id)) continue;
    try {
      const it = await buildOttItem(c);
      if (it && ottIsFresh(it)) { surplus.push(it); usedIds.add(c.id); } // same recency gate
    }
    catch (e) { console.warn(`ott-surplus ${c.id}: ${e.message}`); }
    await sleep(150);
  }

  // --- Recency-decay re-rank (see ottRecencyBonus, module scope). Selection above is
  //     quality-greedy; ORDER is quality + freshness, so this week's drops lead and a
  //     near-expiry season sinks toward the bottom instead of camping in the top 3.
  //     Pools are re-ranked separately so the regional-visibility interleave below keeps
  //     working on two internally-ordered lists. ---
  const ottOrder = (it) => (it._w || 0) + ottRecencyBonus(it.ottFreshDate || it.freshDate);
  intl.sort((a, b) => ottOrder(b) - ottOrder(a));
  regional.sort((a, b) => ottOrder(b) - ottOrder(a));

  // --- Interleave so regional stays visible instead of sinking below the international ---
  const ott = [];
  const step = regional.length ? Math.max(1, Math.floor(intl.length / regional.length)) : 0;
  let ri = 0;
  for (let i = 0; i < intl.length; i++) {
    ott.push(intl[i]);
    if (ri < regional.length && step && (i + 1) % step === 0) ott.push(regional[ri++]);
  }
  while (ri < regional.length) ott.push(regional[ri++]);
  // Integrity gate + honest split (module scope): drop pre-release provider listings,
  // sink threadbare cards, partition into "new this week" / "still worth it".
  const ottDisplay = orderOttForDisplay(ott);
  ott.length = 0;
  ott.push(...ottDisplay);
  // Everything past the homepage cap is already built, already through the integrity gate and
  // already in display order — it was simply being deleted. Keep it for /new-on-ott/ at zero
  // extra cost, then truncate the homepage list exactly as before.
  const ottOverflow = ott.slice(OTT_MAX);
  ott.length = Math.min(ott.length, OTT_MAX);

  // ---------- COMING SOON (next releases in India, soft language quota) ----------
  // Pure date-sorting made this skew to whatever industry had the most films dated soon
  // (often Malayalam). Instead, apply a SOFT language quota — 3 English, 2 Hindi, 3 regional
  // (= 8) — so Hollywood and Hindi get prominence while regional is capped at 3 (not flooded).
  // Within each language we surface the MOST ANTICIPATED upcoming films (by TMDB popularity),
  // since unreleased films have no ratings to rank by and buzz is the useful signal. SOFT:
  // any quota a language can't fill yields its slots to the fallback (best remaining upcoming
  // film of any language), so we never leave gaps or pad with nothing.
  const today = new Date().toISOString().slice(0, 10);
  const soonHorizon = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10); // ~3 months out
  const [up1, up2] = await Promise.all([
    tmdb("/movie/upcoming", { region: cfg.region, page: "1" }),
    tmdb("/movie/upcoming", { region: cfg.region, page: "2" }),
  ]);
  // The /upcoming feed for India under-represents Hollywood and Hindi (it skews to whatever
  // regional industry has the most films dated soon). So — like the theatre pool — we
  // supplement it with discover queries for upcoming ENGLISH and HINDI films specifically,
  // giving the quota more of those to draw from. Without this, the quota stays starved of
  // English/Hindi candidates and falls back to regional. Future window only (next ~3 months).
  const upSeen = new Set([...EXCLUDE_IDS]);
  const upPoolRaw = [];
  for (const m of [...up1.results, ...(up2.results || [])]) {
    if (!upSeen.has(m.id) && !isExcluded(m)) { upSeen.add(m.id); upPoolRaw.push(m); }
  }
  for (const lang of cfg.priorityLangs) {
    try {
      const d = await tmdb("/discover/movie", {
        region: cfg.region,
        with_original_language: lang,
        "primary_release_date.gte": today,
        "primary_release_date.lte": soonHorizon,
        sort_by: "popularity.desc",
        page: "1",
      });
      for (const m of (d.results || [])) {
        if (!upSeen.has(m.id) && !isExcluded(m)) { upSeen.add(m.id); upPoolRaw.push(m); }
      }
    } catch (e) { console.warn(`soon-discover ${cfg.code}/${lang}: ${e.message}`); }
    await sleep(150);
  }
  // Upcoming films have no ratings, so popularity (anticipation) is the only quality signal —
  // BUT TMDB popularity skews to Hollywood, so legitimate Hindi/regional films sit low. We
  // therefore do NOT pre-filter the quota pool by popularity (that erased Indian films and made
  // the section Hollywood-only). Instead:
  //   • the QUOTA (named languages, e.g. India = 3 English / 3 Hindi / 2 regional) draws from
  //     ALL dated-future films, so the intended mix reliably fills regardless of buzz, and
  //   • the buzz FLOOR applies only to the FALLBACK filler, so once the quota is satisfied we
  //     don't pad the list with ghost entries (popularity ~1).
  const SOON_BUZZ_FLOOR = 4; // fallback filler must clear this; quota languages are exempt
  const datedFuture = upPoolRaw
    .filter((m) => m.release_date && m.release_date > today)
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0)); // most anticipated first

  const SOON_TARGETS = cfg.soonTargets;
  const SOON_MAX = 8;
  // "regional" for coming-soon = a regionalLangs language not already a named soon target.
  // For India (soon targets name en+hi) this excludes hi — identical to the prior behaviour.
  const soonNamed = new Set(SOON_TARGETS.map(([k]) => k));
  const isSoonRegional = (m) => INDIAN_LANGS.includes(langCode(m)) && !soonNamed.has(langCode(m));
  const soonSeen = new Set();
  const soonBase = [];
  // QUOTA: fills the intended language mix from the full pool (most-anticipated first within
  // each language). Not floor-filtered, so Hindi/regional always get their guaranteed slots.
  for (const [key, n] of SOON_TARGETS) {
    const matches = datedFuture.filter((m) => {
      if (soonSeen.has(m.id)) return false;
      return key === "__regional__" ? isSoonRegional(m) : langCode(m) === key;
    });
    for (let i = 0; i < n && i < matches.length; i++) { soonBase.push(matches[i]); soonSeen.add(matches[i].id); }
  }
  // FALLBACK: top up toward SOON_MAX with the most-anticipated remaining films of ANY language,
  // but only those clearing the buzz floor — so filler is real anticipation, not dead-weight.
  for (const m of datedFuture) {
    if (soonBase.length >= SOON_MAX) break;
    if (soonSeen.has(m.id)) continue;
    if ((m.popularity || 0) < SOON_BUZZ_FLOOR) continue; // skip ghosts in the filler
    soonBase.push(m); soonSeen.add(m.id);
  }
  // Present in release-date order (soonest first) — within the curated set, chronological
  // reads most naturally as a "what's coming" list.
  soonBase.sort((a, b) => a.release_date.localeCompare(b.release_date));

  const comingSoon = [];
  for (const m of soonBase) {
    const item = {
      title: m.title,
      released: m.release_date,
      genre: genres(m.genre_ids),
      language: langName(langCode(m)),
      review: trim(m.overview, 120),
      poster: img(m.poster_path),
      kind: "movie",
      tmdbId: m.id,
      popularity: m.popularity ?? null, // buzz/anticipation signal (films are ranked by this)
    };
    // Full details so the modal can show trailer, backdrop, cast, runtime
    try { Object.assign(item, await enrich("movie", m.id, cfg.watchRegion)); } catch (e) { console.warn(`soon ${m.id}: ${e.message}`); }
    comingSoon.push(item);
    await sleep(150);
  }

  // ---------- CROSS-SECTION DEDUP (a film must appear in only ONE section) ----------
  // TMDB's now_playing for a region can include a film that is actually a STREAMING release
  // (e.g. a Netflix original given a theatrical date), so the same title can land in both the
  // theatres pool AND the OTT pool — showing twice, once wrongly under "In Theatres". OTT
  // membership REQUIRES a real subscription (flatrate) provider in the region (buildOttItem
  // returns null otherwise), so if a film is streamable, the streaming listing is the accurate
  // and actionable one. Remove any such film from theatres so it shows once, under Streaming Now.
  // (Theatrical-only films — and films merely available for digital rent/buy — have no flatrate
  // provider, so they are never pulled out of theatres by this.)
  const ottIds = new Set(ott.map((x) => x.tmdbId));
  for (let i = theatres.length - 1; i >= 0; i--) {
    if (ottIds.has(theatres[i].tmdbId)) {
      console.log(`[${cfg.code}] dedup: "${theatres[i].title}" is streaming -> removed from theatres, kept in OTT`);
      theatres.splice(i, 1);
    }
  }

  // ---------- PICK OF THE WEEK ----------
  // An endorsement must be earned: new films need >=6.5 to take the crown.
  // If no newcomer qualifies, a genuinely great holdover (>=7.0) can be re-featured.
  // If nothing clears either bar, there is no pick this week — honesty over decoration.
  const all = [...theatres, ...ott];
  const pickPool = all.filter((x) => x.rating != null && ((x.imdbRating != null ? (x.imdbVotes || 0) : (x.votes || 0)) >= 20));
  const pick = (pickPool.filter((x) => x.isRecent && x.rating >= 6.5).sort((a, b) => b.rating - a.rating)[0]) ||
               (pickPool.filter((x) => x.rating >= 7.0).sort((a, b) => b.rating - a.rating)[0]) || null;

  // Last gate before the bucket is persisted: nothing whose date has already passed may be
  // written as "coming soon" (see normalizeUpcoming).
  const upcoming = normalizeUpcoming(comingSoon);
  if (upcoming.length !== comingSoon.length) {
    const dropped = comingSoon.filter((x) => !upcoming.includes(x) && !upcoming.some((u) => u.tmdbId === x.tmdbId));
    for (const x of dropped) console.log(`[${cfg.code}] coming-soon: dropped "${x.title}" — release date ${x.released} has passed`);
  }
  // langPools carries the per-language surplus — titles that cleared the quality bar but lost
  // a homepage slot to the quota. The homepage never reads it; buildLanguagePage does, which
  // is what stops /malayalam/ and /kannada/ from being one-film pages. Only populated for
  // languages that have a landing page, so it is absent on countries without them.
  const langPools = {};
  for (const [name] of LANGUAGE_PAGES) {
    const t = (langTheatres[name] || []).filter((x) => !ottIds.has(x.tmdbId));
    const o = (langPool[name] || []).filter((x) => !ott.some((y) => y.tmdbId === x.tmdbId));
    if (t.length || o.length) langPools[name] = { theatres: t, ott: o };
  }

  // ottExtra is what /new-on-ott/ adds on top of the homepage ten: the display-order overflow
  // (free — it was being deleted), the international surplus, and every regional title the
  // homepage's 4-slot cap left behind. Deduped against the homepage list and against itself.
  const ottExtra = [];
  {
    const seen = new Set(ott.map((x) => x.tmdbId));
    const pools = Object.values(langPools).map((p) => p.ott);
    for (const x of [...ottOverflow, ...surplus, ...pools.flat()]) {
      if (!x || seen.has(x.tmdbId)) continue;
      seen.add(x.tmdbId);
      ottExtra.push(x);
    }
  }
  const data = { generatedAt: new Date().toISOString(), country: cfg.code, pick: pick ? pick.title : null, theatres, ott, comingSoon: upcoming, langPools, ottExtra };
  // Strip internal-only fields (ranking helpers) so they never reach the data file.
  const poolLists = [...Object.values(langPools).flatMap((p) => [p.theatres, p.ott]), ottExtra];
  for (const list of [data.theatres, data.ott, data.comingSoon, ...poolLists]) {
    for (const it of list) { delete it._pop; delete it._tmdbWeighted; delete it._imdbNum; delete it._imdbRating; delete it._imdbVotes; delete it._w; }
  }
  const poolCount = poolLists.reduce((n, l) => n + l.length, 0);
  console.log(`[${cfg.code}] ${theatres.length} theatre, ${ott.length} OTT, ${comingSoon.length} upcoming, ${poolCount} language-page extras. Pick: ${data.pick}`);
  return data;
  } // end buildCountry

  // Run the pipeline for every configured country, writing data-<code>.json for each.
  // India (first) ALSO writes the canonical data.json + per-film pages. Every country gets its
  // own indexable page: India at "/", others at "/<code>/". The pristine index.html template is
  // read ONCE here so per-country injections never stack (India's render writes back to
  // index.html, which would otherwise corrupt the template for later countries).
  let pageTemplate;
  try { pageTemplate = fs.readFileSync("index.html", "utf8"); }
  catch { pageTemplate = null; console.warn("index.html template not found — page render skipped"); }

  const builtCountries = [];
  const dataByCode = {};
  const allSlugSets = {};
  // Pass 1: build data for every country.
  for (const cfg of COUNTRIES) {
    const data = await buildCountry(cfg);
    assignSlugs(data);
    dataByCode[cfg.code] = data;
    const all = [...(data.theatres || []), ...(data.ott || []), ...(data.comingSoon || []), ...poolItems(data)];
    allSlugSets[cfg.code] = new Set(all.map((x) => x.slug).filter(Boolean));
    builtCountries.push(cfg);
  }

  // Watchlist for the 30-minute probe (scripts/probe.js): films that have opened in theatres
  // but have not yet been observed with a provider anywhere. The probe polls only these, so
  // its API cost stays bounded no matter how large the archive grows.
  try {
    const archived = new Set(readHistory().map((r) => `${r.c}:${r.k}:${r.id}`));
    const watch = [];
    for (const [code, d] of Object.entries(dataByCode)) {
      for (const it of [...(d.theatres || []), ...(d.comingSoon || [])]) {
        if (!it.tmdbId || it.kind === "tv") continue;
        if (archived.has(`${code}:movie:${it.tmdbId}`)) continue;
        watch.push({ code, kind: "movie", tmdbId: it.tmdbId, title: it.title,
          released: it.released || null, language: it.language || null, genre: it.genre || null,
          // Carried into the probe's archive row (scripts/probe.js) as the cinema date.
          th: it.theatricalHere ? (it.released || null) : null });
      }
    }
    fs.writeFileSync("ott-watch.json", JSON.stringify(watch, null, 1));
    console.log(`  probe watchlist: ${watch.length} title(s) awaiting a streaming sighting`);
  } catch (e) { stageFailed(`watchlist`, e); }

  // Cinema dates for archived films recorded before the archive stored them (fillCinemaDates
  // in lib/history.js): one TMDB call per film covers every country. /data/ and the film
  // pages' "FilmyChill data" line count only films that opened in cinemas in that country, so
  // a film is simply left out until its date is known. Bounded per run; the backlog of a few
  // hundred films clears in a run or two, after which new rows arrive with the date.
  try {
    const lines = readHistoryLines();
    const regionOf = (code) => (COUNTRIES.find((c) => c.code === code) || {}).region || String(code).toUpperCase();
    const r = await fillCinemaDates(lines, {
      lookup: (id) => tmdb(`/movie/${id}/release_dates`),
      cinemaDateFor: (body, code) => regionalTheatricalDate({ release_dates: body }, regionOf(code)),
      budget: CINEMA_DATE_BUDGET,
      pause: () => sleep(120),
    });
    if (r.filled) writeHistoryLines(lines);
    if (r.films) console.log(`  cinema dates: ${r.filled} archive row(s) filled from ${r.calls} TMDB call(s); ${r.pending} film(s) left to check`);
  } catch (e) { stageFailed("cinema-date backfill", e); }

  // Persist first-seen tracking (see ott-seen.json docs) — every country has now recorded
  // today's sightings; the workflow commits this file so tomorrow's run remembers them.
  fs.writeFileSync(OTT_SEEN_FILE, JSON.stringify(loadOttSeen(), null, 1));

  // Buzz signals attach BEFORE the data files are written, so client-rendered cards
  // (which read data.json) see the same badges the SSR cards do. Both are non-fatal.
  await attachBuzz(dataByCode);
  await attachTrailerStats(dataByCode);
  // Critics' takes attach last but still BEFORE data files are written, so
  // client-rendered cards (which read data.json) show the same line the SSR cards do.
  await attachTakes(dataByCode);
  // FilmyChill Score (lib/fcscore.js): audiences + critics, after the takes attach the critics
  // tone and before the data files are written, so cards, film pages and share cards agree.
  {
    const { scored, total } = attachFcScores(dataByCode, { toneFor: cachedCriticsTone });
    console.log(`FilmyChill Score: ${scored}/${total} listed titles scored (the rest: too early)`);
    // Pick of the Week is re-chosen now that scores exist (see choosePick in lib/surfaces.js).
    // The pick made in buildCountry stays as the fallback when nothing new qualifies.
    for (const [code, d] of Object.entries(dataByCode)) {
      if (!d) continue;
      const cfg = COUNTRIES.find((c) => c.code === code) || { code };
      const p = choosePick([...(d.theatres || []), ...(d.ott || [])], cfg, d.generatedAt);
      if (p && p.title !== d.pick) { console.log(`  pick [${code}]: ${d.pick || "—"} → ${p.title} (${p.fcScore.verdict})`); d.pick = p.title; }
    }
  }

  // Product stats, BEFORE data files are written so the client can render the
  // confidence strip ("N picks · M+ films tracked") from data alone.
  const priorManifest = loadPagesManifest();
  for (const cfg of builtCountries) {
    dataByCode[cfg.code].trackedFilms = Object.keys(priorManifest[cfg.code] || {}).length;
  }

  // Now write every country's data file (India also writes the legacy data.json).
  for (const cfg of builtCountries) {
    fs.writeFileSync(`data-${cfg.code}.json`, JSON.stringify(dataByCode[cfg.code], null, 1));
    if (cfg.code === "in") fs.writeFileSync("data.json", JSON.stringify(dataByCode[cfg.code], null, 1));
  }
  // Pass 2: now that ALL slug sets are known, generate per-film pages for every country (so
  // hreflang alternates between countries are accurate) and render each country homepage.
  for (const cfg of COUNTRIES) {
    // Cards BEFORE pages: socialImage() checks the card file on disk, so the render order
    // decides whether a page points at its branded card or falls back to the backdrop.
    try { writeShareCards(dataByCode[cfg.code], cfg); }
    catch (e) { stageFailed(`share cards [${cfg.code}]`, e, { optional: true }); }
    generatePages(dataByCode[cfg.code], cfg, allSlugSets);
    // Everything local for this country, in one place (see writeCountrySurfaces). Runs after
    // generatePages so this run's films are already in the browse listing and card lookups.
    writeCountrySurfaces(cfg, dataByCode[cfg.code], { template: pageTemplate, allCountries: builtCountries });
  }
  // India-only surfaces: language landing pages (/tamil/, /hindi/, ...) and the
  // permanent weekly snapshot (/week/<year>-W<ww>/). Both are pure re-renders of
  // this run's India data — zero extra API calls.
  if (dataByCode.in) {
    writeLanguagePages(dataByCode.in);
    writeWeekPage(dataByCode.in);
  }
  writeIndexNowPayload(builtCountries, dataByCode); // fresh URL list for the workflow's IndexNow ping
  writeLlmsTxt(dataByCode); // AI-answer-engine site map with this week's actual picks
  // Keep the About page's country sentence in step with the config (see patchAboutPage).
  // Non-fatal: a broken marker should surface loudly in the log, not kill a good build.
  try { patchAboutPage(); } catch (e) { stageFailed(`about page`, e); }

  // Archive pass: pages whose films left this week's lists get a one-time honesty patch,
  // and the manifest records real lastmod dates for the sitemap (see module-scope docs).
  const pagesManifest = loadPagesManifest();
  for (const cfg of builtCountries) {
    const d = dataByCode[cfg.code] || {};
    // slug -> the few fields the streaming sweep needs after this page freezes.
    const meta = {};
    for (const it of [...(d.theatres || []), ...(d.ott || []), ...(d.comingSoon || [])]) {
      if (it && it.slug) meta[it.slug] = { tmdbId: it.tmdbId, released: it.released, language: it.language, kind: it.kind, title: it.title };
    }
    archiveDepartedPages(pagesManifest, cfg, allSlugSets[cfg.code] || new Set(), meta);
  }
  // Re-check frozen theatrical pages for a streaming arrival they'd otherwise never
  // reflect (see sweepStreamingArrivals). Runs after archiving so newly-frozen pages
  // are eligible immediately; budgeted per country.
  for (const cfg of builtCountries) {
    // First give every frozen page an id the sweep can use (see recoverTmdbIds).
    try { await recoverTmdbIds(cfg, pagesManifest); }
    catch (e) { stageFailed(`id recovery [${cfg.code}]`, e); }
    try { await sweepStreamingArrivals(pagesManifest, cfg, new Date().toISOString().slice(0, 10)); }
    catch (e) { stageFailed(`sweep [${cfg.code}]`, e); }
    // The mirror pass: recheck claims we already made (see sweepStreamingDepartures).
    // Budgeted and slow-cadence, so this adds a flat ~15 calls per country per run no
    // matter how large the archive grows.
    try { backfillStreamClaims(pagesManifest, cfg); }
    catch (e) { stageFailed(`stream claims [${cfg.code}]`, e); }
    try { await sweepStreamingDepartures(pagesManifest, cfg, new Date().toISOString().slice(0, 10)); }
    catch (e) { stageFailed(`departure sweep [${cfg.code}]`, e); }
    // Free, local, no budget: move any page past its stamped release date (see patchDueIfPassed).
    try { refreshDuePages(cfg, countryNameFor(cfg), pagesManifest); }
    catch (e) { stageFailed(`due pass [${cfg.code}]`, e); }
  }
  // Wrong-market legacy pages (see repairLegacyPages). Before hreflang sync so rebuilt pages
  // rejoin their clusters in the same run.
  for (const cfg of builtCountries) {
    try { await repairLegacyPages(cfg, pagesManifest, { baseItem, withImdb }); }
    catch (e) { stageFailed(`legacy repair [${cfg.code}]`, e); }
  }
  // Back-catalogue backfill (see backfillCatalog). Runs after the weekly pipeline has taken
  // every slug it wants and before the hreflang + sitemap passes, so new catalogue pages join
  // their clusters and the sitemap in the same run they are written.
  if (CATALOG_ENABLED) {
    const catalogState = loadCatalogManifest();
    const reopened = reopenForBar(catalogState);
    if (reopened) console.log(`  catalog: eligibility bar changed — ${reopened} retired queue(s) re-opened`);
    for (const cfg of builtCountries) {
      try { await backfillCatalog(cfg, pagesManifest, { state: catalogState, baseItem, withImdb, batch: CATALOG_BATCH }); }
      catch (e) { stageFailed(`catalog [${cfg.code}]`, e); }
    }
    fs.writeFileSync(CATALOG_MANIFEST_FILE, JSON.stringify(catalogState, null, 1));
    for (const cfg of builtCountries) {
      const v = catalogStall(catalogState, cfg.code);
      RUN_HEALTH.catalog[cfg.code] = v.last;
      if (v.stalled) healthIssue(`catalog [${cfg.code}]: 0 new pages two runs in a row while ${v.live} queue(s) are still open — check the "catalog" lines in the build log`);
      else if (v.exhausted) healthNote(`catalog [${cfg.code}]: every queue retired — no more back-catalogue titles from this source`);
    }
  }

  // FilmyChill Score on pages that are never rebuilt (frozen + back-catalogue): a budgeted
  // sweep each run, never-scored first (lib/scoresweep.js).
  {
    try {
      const r = await sweepScores(pagesManifest, { today: todayStr() });
      console.log(`FilmyChill Score sweep: ${r.checked} checked, ${r.updated} pages updated${r.errors ? `, ${r.errors} TMDB errors` : ""}`);
      if (r.errors >= 5) healthNote(`score sweep stopped early after ${r.errors} TMDB errors — it resumes next run`);
      // Pages whose film couldn't be identified on TMDB (no id saved, no poster match) can't be
      // scored honestly, so they get no score box. Surface the count so it never goes unnoticed.
      let unidentified = 0;
      for (const m of Object.values(pagesManifest)) for (const e of Object.values(m || {})) if (e && !e.tmdbId && e.idLookup === "none") unidentified++;
      if (unidentified) healthNote(`${unidentified} old film page(s) have no FilmyChill Score: their film couldn't be matched on TMDB`);
    } catch (e) { stageFailed("score sweep", e); }
    // "If you liked this" on frozen/back-catalogue pages, redone once per rules version
    // (lib/relrefresh.js). Local only — no API calls.
    try {
      const r = refreshRelated(pagesManifest, COUNTRIES);
      if (r.checked) console.log(`Related-films refresh: ${r.checked} old pages checked, ${r.updated} updated`);
    } catch (e) { stageFailed("related-films refresh", e); }
    // Visitors' votes (lib/votes.js): read new ones, keep per-film totals, report privately.
    // Dormant until the FIREBASE_SERVICE_ACCOUNT secret exists.
    try {
      const v = await syncVotes({ dataByCode, note: healthNote });
      if (v.enabled) console.log(`Votes: ${v.fetched} new, ${v.touched} films re-counted, ${v.films} films with votes`);
    } catch (e) { stageFailed("votes", e); }
    // Film pages: styles into shared cached files, privacy link in every footer, browser icons,
    // the country in every non-India title, and the "FilmyChill data" window line checked
    // against the archive (lib/stylesheets.js). Runs after every page writer and patcher above.
    try {
      const records = readHistory();
      const starts = observationStarts(records);
      const byKey = new Map(records.map((r) => [`${r.c}:${r.k}:${r.id}`, r]));
      const fcdataClaim = (code, slug) => {
        const e = pagesManifest[code] && pagesManifest[code][slug];
        if (!e || !e.tmdbId) return { action: "unknown", days: null };
        return cinemaClaim(byKey.get(`${code}:${e.kind === "tv" ? "tv" : "movie"}:${e.tmdbId}`), starts);
      };
      const f = finishFilmPages(filmPageFiles(), { fcdataClaim });
      console.log(`Film pages finished: ${f.pages} checked, ${f.externalized} moved to shared styles, ${f.privacyLinked} privacy links added, ${f.iconed} icon tags added, `
        + `${f.retitled.length} titles given their country, ${f.fcdataDropped} window lines removed and ${f.fcdataFixed} corrected, ${f.cssFiles} stylesheets in use${f.removed ? `, ${f.removed} unused removed` : ""}`);
      // A new title is a real change: let the sitemap say so (syncFilmLastmods would also see
      // it, except on its first run, when it only records fingerprints).
      for (const k of f.retitled) {
        const [code, slug] = k.split("/");
        if (pagesManifest[code] && pagesManifest[code][slug]) pagesManifest[code][slug].last = todayStr();
      }
      // Oct 2026: the workflow didn't commit css/, so for a few hours every film page linked a
      // stylesheet that wasn't on the site. A missing stylesheet is a red run, not a note.
      if (f.missing) healthIssue(`${f.missing} film page(s) link a stylesheet that doesn't exist — they render unstyled. e.g. ${f.missingExamples.join("; ")}`);
    } catch (e) { stageFailed("film-page styles", e); }
    try {
      const s = finishSitePages(sitePageFiles());
      if (s.iconed) console.log(`Site pages: icon tags added to ${s.iconed} of ${s.pages}`);
    } catch (e) { stageFailed("site-page icons", e); }
    // Self-audit (lib/audit.js): contradictions a visitor would notice, reported in the run
    // summary before anyone else finds them. Read-only.
    try {
      const a = runAudit({ dataByCode, pagesManifest, countries: COUNTRIES, note: healthNote });
      console.log(`Audit: ${a.findings.length} finding(s)`);
    } catch (e) { stageFailed("self-audit", e); }
  }

  // "Streaming on <platform>" pages (see writeStreamingPages). After every claim for this run
  // has been made, rechecked or retired, so the lists reflect today's verified availability.
  for (const cfg of builtCountries) {
    try { writeStreamingPages(dataByCode[cfg.code], cfg, pagesManifest); }
    catch (e) { stageFailed(`streaming pages [${cfg.code}]`, e); }
    try { writePeoplePages(dataByCode[cfg.code], cfg, pagesManifest); }
    catch (e) { stageFailed(`people pages [${cfg.code}]`, e); }
    try { writeDatedOttPages(dataByCode[cfg.code], cfg, pagesManifest); }
    catch (e) { stageFailed(`dated OTT pages [${cfg.code}]`, e); }
  }

  // All countries are built by now, so the filesystem finally shows every cluster's true
  // membership — repair them in one pass before the sitemap is written.
  try {
    // No lastmod bump for this: an hreflang repair is a head-only edit, and the sitemap's own
    // alternates (rewritten every run) already tell Google about the cluster.
    syncHreflangClusters();
  } catch (e) { stageFailed(`hreflang sync`, e); }
  // Honest lastmod (lib/sitemap.js): after the last page edit of the run, a film's date moves
  // only if its content did.
  try {
    const l = syncFilmLastmods(pagesManifest, builtCountries, todayStr());
    console.log(`Film lastmod: ${l.changed} of ${l.pages} pages changed content${l.seeded ? `, ${l.seeded} fingerprinted for the first time` : ""}`);
  } catch (e) { stageFailed("film lastmod", e); }
  fs.writeFileSync(PAGES_MANIFEST_FILE, JSON.stringify(pagesManifest, null, 1));

  // Rewrite the sitemap to include every country page (with hreflang) now that all are built.
  // Frozen archived pages are never rewritten, so pages generated before the x-default
  // fix carry a dead India URL in their hreflang forever unless repaired in place.
  repairXDefaults(builtCountries);

  // Every hub for this run has been written or pruned by now, so disk is the truth.
  try { sweepDeadHubLinks(COUNTRIES); } catch (e) { stageFailed(`dead hub links`, e); }

  writeMultiCountrySitemap(builtCountries, pagesManifest);
  fs.writeFileSync(RUN_HEALTH_FILE, JSON.stringify(RUN_HEALTH, null, 1));
  console.log(`Done. Built ${COUNTRIES.length} countries: ${COUNTRIES.map((c) => c.code).join(", ")}.` +
    ` Health: ${RUN_HEALTH.issues.length} issue(s), ${RUN_HEALTH.notes.length} note(s).`);
}

// Run the build only when executed directly (not when required by tests/tools).
if (!process.env.PAGES_ONLY && require.main === module) main().catch((e) => {
  // Never leak the API key into Action logs, even via network error messages
  const msg = String(e && e.stack || e).split(API_KEY).join('***');
  console.error(msg);
  process.exit(1);
});

// Local regeneration from the data files already in the repo (no API calls):
//   PAGES_ONLY=1   node scripts/update.js   -> India, full (film pages + homepage + weekly + feed)
//   PAGES_ONLY=all node scripts/update.js   -> every country's COPY surfaces (homepage, weekly
//                                              page, feed) rebuilt from data-<code>.json
// The "all" scope exists for wording/template changes: those affect every country's homepage
// and weekly page, and without it a copy fix sits unpublished until the next scheduled run.
// It deliberately does NOT touch film pages or the sitemap — no API data, no archive churn.
// Placed at end of file so all const declarations (COUNTRY_PAGE_META etc.) are initialized.
if (process.env.PAGES_ONLY && require.main === module) {
  const inCfg = COUNTRIES.find((c) => c.code === "in") || { code: "in", name: "India", region: "IN" };
  if (String(process.env.PAGES_ONLY).toLowerCase() === "all") {
    // One pristine read of the template, reused per country (injections never stack).
    const template = fs.readFileSync("index.html", "utf8");
    for (const cfg of COUNTRIES) {
      const file = cfg.code === "in" ? "data.json" : `data-${cfg.code}.json`;
      if (!fs.existsSync(file)) { console.warn(`  ${file} missing — ${cfg.code} skipped`); continue; }
      const dc = JSON.parse(fs.readFileSync(file, "utf8"));
      assignSlugs(dc);
      // Same sequence the live build runs — one definition, no drift.
      writeCountrySurfaces(cfg, dc, { template });
    }
    process.exit(0);
  }
  const d = JSON.parse(fs.readFileSync("data.json", "utf8"));
  assignSlugs(d);
  const all = [...(d.theatres || []), ...(d.ott || []), ...(d.comingSoon || [])];
  const slugSets = { in: new Set(all.map((x) => x.slug).filter(Boolean)) };
  try { writeShareCards(d, inCfg); } catch (e) { stageFailed(`share cards`, e, { optional: true }); }
  generatePages(d, inCfg, slugSets); // India only in local regen
  prerenderIndex(d);
  writeOttWeekPage(d, inCfg, [inCfg]);
  writeRssFeed(d, inCfg);
  fs.writeFileSync("data.json", JSON.stringify(d, null, 1));
  process.exit(0);
}

// Export pure/helper functions for unit testing (only meaningful when required, not run).
module.exports = {
  filmScore, confidenceTier, rankValue, rankFilms,
  buildEmbedPage, buildEmbedInstructions, embedItems, writeEmbed,
  indexNowUrls,
  sectionCounts,
  buildDataPage, buildWindowsCsv, writeDataPage,
  appendHistory, readHistory, historyRecord, streamingWindowDays, windowStats,
  observationStarts, cinemaWindowDays, cinemaClaim, fillCinemaDates, readHistoryLines, writeHistoryLines,
  contentFingerprint, syncFilmLastmods, CINEMA_DATE_BUDGET,
  writeCountrySurfaces,
  syncHreflangClusters, patchHreflang, hreflangBlockFor, filmPageExists,
  buildBrowsePage, writeBrowseIndex, browsePath, BROWSE_PER_PAGE,
  filmIndexFor, relatedFilms, relatedScore,
  cardFontFiles,
  voteCountLabel,
  writeShareCards, cardPaths,
  shareCardSvg, wrapForCard, cardStatus,
  whyWatch, runtimePhrase, certClause,
  releaseState, releaseLabel, normalizeUpcoming, patchDueIfPassed, regionalTheatricalDate,
  verdict, takeConfident, marqueeScore, marqueePick,
  trim, img, slugify, escHtml, ytIdOf, replaceBetween, ARCHIVE_PATCH_VERSION,
  fmtRuntime, langCode, langName, LANG_CODE_OVERRIDES,
  streamVocab, streamWindowEstimate, streamWindowShort, filmMetaDescription,
  frozenFilmFacts, rewriteMetaDescription, sweepCandidates, applyArrivalPatch,
  assignSlugs, buildHeadTags, buildHomeJsonLd, ssrCard, ssrSoonCard,
  footerAttribution, RATINGS_SOURCE, USE_IMDB,
  deriveFreshDate, isOttFresh, OTT_FRESH_DAYS,
  filterTheatreFresh, THEATRE_WINDOW_DAYS, THEATRE_WINDOW_FALLBACK_DAYS, THEATRE_MIN_POOL,
  freshnessWindowLabel,
  ottRecencyBonus, OTT_RECENCY_MAX, freshBadge, freshLabel, fmtDateShort,
  buildOttWeekPage, ottWeekUrl, ottWeekPath,
  computeBuzz, fmtViews, trailerViewsLabel, localeFor, countryNameFor,
  ottArrival, recordOttSeen, pruneOttSeen, laterDate, earlierDate,
  buildRssFeed, archivePatchHtml, stripAggregateRating, retitleFrozen, filmTitleTag, reconcilePagesManifest,
  buildOttMonthPage, writeOttMonthPages, ottMonthPath, ottMonthUrl, backfillCatalog,
  buildScopedMonthPage, writePlatformMonthPages, writeLanguageMonthPages, monthRow,
  announcedDates, buildComingPage, buildTodayPage, writeDatedOttPages, weekRangeFor,
  recoverTmdbIds, digitalReleaseFor, digitalUpcoming, applyDigitalDatePatch, sweepCandidates, hubOgImage, ogImageTag, peopleIndexFor, buildPersonPage, writePeoplePages, personPageUrl, PEOPLE_MIN,
  verifiedAvailability, buildStreamingPage, writeStreamingPages, streamPagePath, streamPageUrl, STREAM_PAGE_MIN, STREAM_LANG_MIN,
  backfillStreamClaims, settleDepartedCopy, fitSiteTitle, fitFirst, ssrHero, heroPreload, ssrCard, pruneDeadHubLinks, sweepDeadHubLinks, theatreRunState, visibleText, crossCountryLeak, neutralizeCrossCountry, repairLegacyPages, freshenFrozenCopy, countryNameForms, settleReleasedCopy, patchDueIfPassed, applyArrivalPatch, certAudience, analyticsTag, cspWith, ensureAnalytics, GC_SITE, filmHubLinks,
  platformMonthPath, platformMonthUrl, languageMonthPath, languageMonthUrl, SCOPED_MONTH_MIN,
  ARRIVAL_BADGE_DAYS, ARRIVAL_MIN_RELEASE_AGE, ARRIVAL_MAX_RELEASE_AGE, SEEN_RETENTION_DAYS,
  socialImage,
  buildVerdictProse, buildGoodToKnow, buildFaqs, buildFilmPage,
  filmPagePath, filmPageUrl,
  analyzeReception, composeTake, TAKES_RETENTION_DAYS,
  ottRenderable, hasCardSubstance, isStillWorthIt, orderOttForDisplay, STILL_WORTH_DAYS,
  buildLanguagePage, LANGUAGE_PAGES, listingPageHtml,
  isoWeekOf, weekSlug, isoWeekMonday, isoWeekSunday, buildWeekPage,
  ssrOttSection, buildMoreLinks, ABOUT_LASTMOD, patchAboutPage, countryListForProse,
  isExcluded, EXCLUDE_TITLES,
  extractHook, audienceCounterpoint,
  certFor, regionalTheatricalDate, countryListForProse,
  extractCastPics,
  prevWeekSlug, writeIndexNowPayload, buildLlmsTxt,
  theatreEligible, THEATRE_EXCLUDE_IDS,
  ssrLastScan, reseedTake, isPoolTake, isLegacyTake, mineViewerAspects, composeTmdbTake, dedupeProviders, rankSimilar, TAKE_VERSION, xDefaultCode, repairXDefaults,
  capTrending, buildEditorNote, ssrEditorNote,
  platformSlug, hubsFor, hubUrl, hubPath, buildPlatformHubPage, indexNowUrls, poolItems,
  shortenTitleTag, departureCandidates, applyDeparturePatch, backfillLiveClaims,
  departureOutage, catalogStall, loadStateFile, stageFailed, RUN_HEALTH,
  buildLlmsFullTxt, llmsMachineSection,
  llmsRatingConfident, LLMS_MIN_VOTES, LLMS_EARLY_DAYS, LLMS_EARLY_MIN_VOTES,
};

