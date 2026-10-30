// ============================================================================
// filmpage.js — the per-film static page: slugs, the film-history record, meta description,
// title tag, arrival dates, hub links, buildFilmPage() and generatePages().
// ============================================================================
"use strict";

const { writeIfChanged } = require("./writeif.js");
const { earlyReadLabel, isRecent, noScoreText, notOutYet, scoreNeed } = require("./fcscore.js");
const { VOTE_CONNECT, VOTE_CSS, voteWidgetHtml } = require("./vote.js");
const { ratingDial } = require("./meter.js");
const fs = require("fs");
const {
  COUNTRIES,
  LANGUAGE_PAGES,
  escHtml,
  tidyProse,
  filmPagePath,
  filmPageUrl,
  fmtDateShort,
  fmtDateFull,
  fmtRuntime,
  ICON_LINKS,
  ldJson,
  slugify,
  trim,
  videoUploadDate,
  xDefaultCode,
  localeFor,
} = require("./core.js");
const { readHistory, cinemaWindowDays, observationStarts, monthKey, monthLabel } = require("./history.js");
const { filmScore } = require("./score.js");
const { filmIndexFor, filmPageExists, relatedFilms, sameFilmPageExists } = require("./graph.js");
const { inRollout } = require("./rollout.js");
const { cap, whyWatch } = require("./whywatch.js");
const { skipIf } = require("./skipif.js");
const { watchFit } = require("./watchfit.js");
const { releaseState } = require("./release.js");
const { buildFaqs, buildGoodToKnow, buildVerdictProse } = require("./filmcopy.js");
const {
  analyticsTag,
  canonProvider,
  cspWith,
  digitalAnnounceText,
  digitalPassed,
  digitalPassedBlock,
  digitalUpcoming,
  footerAttribution,
  hubPath,
  img,
  ottMonthPath,
  PEOPLE_BASE,
  personPagePath,
  platformSlug,
  socialImage,
  STREAM_BASE,
  streamPagePath,
  ytIdOf,
} = require("./pagekit.js");
const { countryNameFor, dedupeProviders, hasLanguageWindow, streamVocab, streamWindowEstimate, streamWindowShort, titleWithCountry } = require("./rules.js");

// ============================================================
// PER-FILM STATIC PAGES — one SEO-indexable page per film,
// written to movie/<slug>.html. Pages are never deleted: the
// archive accrues search value after films leave the lists.
// ============================================================


// Every item the site renders anywhere, including the language-page and /new-on-ott/ pools.
// These are real enriched films, but they live outside data.theatres/ott/comingSoon, so any
// loop that hardcodes those three lists silently skips them. That is how pool titles ended up
// on /malayalam/ as unlinked plain text with slug === undefined, and how some were dropped
// outright by `.filter(x => x.slug)` further downstream.
function poolItems(data) {
  if (!data) return [];
  const out = [...(data.ottExtra || []), ...(data.soonExtra || [])];
  for (const p of Object.values(data.langPools || {})) out.push(...(p.theatres || []), ...(p.ott || []));
  const seen = new Set();
  return out.filter((x) => {
    if (!x) return false;
    if (x.tmdbId == null) return true;
    if (seen.has(x.tmdbId)) return false;
    seen.add(x.tmdbId);
    return true;
  });
}

// `existing` (optional, from existingSlugsById) and `code` (this edition): a film TMDB renames
// keeps its address. "Drishyam 3" became "Drishyam: The Conclusion" and the build started a
// second page beside the first (32 such duplicate groups, Oct 2026 audit). In order:
//   1. this edition already has a page for the film: keep it (the current title's slug only if
//      that page is the one using it), so an edition never gets a second page;
//   2. no page here yet: the current title's slug if another edition uses it, else the address
//      most editions use, so the hreflang cluster stays whole.
function assignSlugs(data, existing = null, code = null) {
  const used = new Map(); // slug -> tmdbId
  for (const list of [data.theatres, data.ott, data.comingSoon, poolItems(data)]) {
    for (const item of list || []) {
      const fresh = slugify(item.title) || `film-${item.tmdbId || ""}`;
      const year = (item.released || "").slice(0, 4);
      // Same id AND same release year: a wrong id on an old entry must never send a new film
      // onto another film's page.
      const known = existing && item.tmdbId != null && year ? existing.get(`${item.kind === "tv" ? "tv" : "movie"}:${item.tmdbId}:${year}`) : null;
      const here = known && code && known.byEdition.get(code);
      let slug = fresh;
      if (here && here.size) slug = here.has(fresh) ? fresh : here.has(known.preferred) ? known.preferred : [...here].sort()[0];
      else if (known && !known.slugs.has(fresh)) slug = known.preferred;
      if (used.has(slug) && used.get(slug) !== item.tmdbId && year) slug = `${slug}-${year}`;
      // An address another film already owns in this edition is taken too. Only this run's
      // slugs were checked, so the TV series WAR (2026) overwrote the Hindi film War's page in
      // Canada, and the manifest kept the old film's id: every sweep then applied the wrong
      // film's facts to it (Oct 2026 audit; "Made in Korea" in Malaysia the same way).
      const owner = existing && existing.owners && code ? existing.owners.get(code) : null;
      const me = `${item.kind === "tv" ? "tv" : "movie"}:${item.tmdbId}`;
      const takenHere = (s) => !!(owner && owner.has(s) && owner.get(s) !== me) || (used.has(s) && used.get(s) !== item.tmdbId);
      if (item.tmdbId != null && takenHere(slug)) {
        const withYear = year ? `${fresh}-${year}` : null;
        slug = withYear && !takenHere(withYear) ? withYear : `${fresh}-${item.kind === "tv" ? "tv-" : ""}${item.tmdbId}`;
      }
      used.set(slug, item.tmdbId);
      item.slug = slug;
    }
  }
}

// "kind:tmdbId:year" -> { slugs, preferred, byEdition } over every edition's manifest, for pages
// on disk. `preferred` is the slug the most editions use (ties: alphabetical, so it is stable);
// `byEdition` maps an edition to the slugs it has for the film.
function existingSlugsById(manifest, { exists = () => true } = {}) {
  const counts = new Map(), eds = new Map();
  for (const [code, m] of Object.entries(manifest || {})) {
    for (const [slug, e] of Object.entries(m || {})) {
      const year = String((e && e.released) || "").slice(0, 4);
      if (!e || e.tmdbId == null || !/^\d{4}$/.test(year) || !exists(code, slug)) continue;
      const k = `${e.kind === "tv" ? "tv" : "movie"}:${e.tmdbId}:${year}`;
      if (!counts.has(k)) { counts.set(k, new Map()); eds.set(k, new Map()); }
      counts.get(k).set(slug, (counts.get(k).get(slug) || 0) + 1);
      if (!eds.get(k).has(code)) eds.get(k).set(code, new Set());
      eds.get(k).get(code).add(slug);
    }
  }
  const out = new Map();
  for (const [k, c] of counts) {
    const preferred = [...c.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    out.set(k, { slugs: new Set(c.keys()), preferred, byEdition: eds.get(k) });
  }
  // Who owns each address, per edition: "kind:tmdbId" by slug (assignSlugs).
  const owners = new Map();
  for (const [code, m] of Object.entries(manifest || {})) {
    const own = new Map();
    for (const [slug, e] of Object.entries(m || {})) {
      if (e && e.tmdbId != null && exists(code, slug)) own.set(slug, `${e.kind === "tv" ? "tv" : "movie"}:${e.tmdbId}`);
    }
    owners.set(code, own);
  }
  out.owners = owners;
  return out;
}



let _filmHistory = null, _filmHistoryStarts = null;
const FILM_HISTORY = {
  load() {
    if (!_filmHistory) {
      const all = readHistory();
      _filmHistory = new Map();
      for (const r of all) _filmHistory.set(`${r.c}:${r.k}:${r.id}`, r);
      _filmHistoryStarts = observationStarts(all);
    }
  },
  get(key) { this.load(); return _filmHistory.get(key); },
  // When the archive began watching each country (see observationStarts in lib/history.js).
  starts() { this.load(); return _filmHistoryStarts; },
};


// ============================================================================
// FILM META DESCRIPTION — a snippet is an ad, not an answer.
//
// Sept 2026 GSC: 367 queries ranked inside Google's top 10 and returned 0.69% CTR across
// 3,928 impressions; 346 of them took ZERO clicks. The cause was the old builder doing its
// job too well. Both shapes it produced ENDED the search inside the results page:
//   streaming  -> "Watch X in the UK on Netflix"  (answered; the click went to Netflix)
//   theatrical -> "OTT release date coming soon"  (no answer exists; nothing worth clicking)
// Every fact below still lives in the H1, the body copy and the JSON-LD, so Google matches
// these queries exactly as it did before. What changes is that the reader has to open the
// page to finish the thought. Exactly one thing is now withheld: the PLATFORM NAME on
// streaming titles. The theatrical branch does the opposite and LEADS with the window
// estimate — the one thing competitors cannot source, and which streamWindowEstimate has
// been rendering on-page since August without ever reaching a snippet.
//
// Shape is lifted from buildHeadTags' homepage description ("This week: X, Y + 15 more…"),
// which is the only description on this site already clearing 16% CTR.
//
// Pure and self-contained so the frozen-archive patcher (rewriteMetaDescription) can call it
// with a synthetic item rebuilt from a page on disk. One source of truth, one shape, one
// place to change it — the same reason streamVocab exists.
// `opts.runEnded` is set by the archive patcher for pages whose theatrical run is over:
// without it a frozen page says "Theatrical run ended" in its body and "is in cinemas"
// in its description, which is how filmychill.com/movie/insidious-out-of-the-further.html
// shipped on 14 Sept 2026.
// ============================================================================
// Pick the first candidate inside Google's ~155-char display, else trim the shortest.
// Same degradation ladder as fitTitle, for the same reason: the clause that earns the click
// must survive truncation, so it goes early and the decoration goes last. The old code
// appended its payoff line and THEN trimmed to 155, which amputated it on every live page —
// the "this page updates the day it streams" promise never once reached a SERP.
function fitDesc(optsList) {
  const live = optsList.filter(Boolean);
  return live.find((t) => t.length <= 155) || trim(live[live.length - 1] || "", 155);
}

// Everything the description branches share, worked out once (Power-of-Ten audit, Oct 2026:
// filmMetaDescription was one 198-line function nested ten deep; each page state now has its
// own small function below, and this is the common ground they stand on).
function descContext(item, cfg, opts) {
  const country = countryNameFor(cfg);
  const year = (item.released || "").slice(0, 4);
  const providers = Array.isArray(item.providers) ? item.providers : [];
  const rentBuy = Array.isArray(item.rentBuy) ? item.rentBuy : [];
  const relState = releaseState(item.released);
  const upcoming = relState === "upcoming" || relState === "today";
  const runEnded = !!opts.runEnded;
  // A frozen page inside the run window: we know when it opened, not that it is still on.
  const runOpen = !runEnded && !!opts.runOpen;
  const now = opts.now ? new Date(opts.now) : new Date();
  const dvotes = item.imdbRating != null ? item.imdbVotes : item.votes;
  const ratingBit = item.rating != null && dvotes >= 10 ? `${Number(item.rating).toFixed(1)}/10` : "";
  const runtimeBit = item.kind === "tv" ? "" : fmtRuntime(item.runtime);
  const stats = [ratingBit, runtimeBit].filter(Boolean).join(", ");
  // A title already ending in punctuation must not collect a second colon
  // ("Abijit Ganguly: Baby: OTT release expected…"), and a title that already CONTAINS one
  // ("Insidious: Out of the Further") reads badly with a third — the highest-impression page
  // on the site is exactly that shape, so it gets a dash instead.
  const rawTitle = String(item.title || "").trim();
  const titleSep = /[:.!?—-]$/.test(rawTitle) ? "" : (rawTitle.includes(":") ? " —" : ":");
  // A released film with no platform at all. A frozen page's facts can carry no `platform`,
  // where a weekly page says "Theatres"; both mean the same, and the title (filmTitle) already
  // treats them alike. 93 pages titled "Not Announced Yet" had a description promising "where
  // to watch it" because only "Theatres" counted here (The Invite, Oct 2026).
  const inCinemasOnly = item.kind !== "tv" && !providers.length && !rentBuy.length
    && (item.platform === "Theatres" || !item.platform);
  // Quote the window only where doing so is honest: a released theatrical title, nothing
  // streaming or rentable yet, and a window that has not already lapsed.
  const est = (inCinemasOnly && !upcoming)
    ? streamWindowShort(item.released, item.language, now) : null;
  const openedOn = item.released ? `${fmtDateShort(item.released, now.getTime(), localeFor(cfg && cfg.code))}` : "";
  return {
    item, cfg, opts, country, V: streamVocab(cfg), yr: year ? ` (${year})` : "",
    providers, rentBuy, upcoming, runEnded, runOpen, now,
    ratingBit, runtimeBit, statsClause: stats ? `${stats}, ` : "",
    thing: item.kind === "tv" ? "series" : "film",
    titleSep, inCinemasOnly, est, openedOn,
    inCinemas: runEnded ? `theatrical run over in ${country}`
      : runOpen ? `opened in cinemas in ${country}${openedOn ? ` on ${openedOn}` : ""}`
      : `in cinemas in ${country} now`,
    // Name the language only when STREAM_WINDOW_WEEKS actually carries one for it. Everything
    // else gets the honest generic phrasing rather than an implied dataset we don't have.
    windowBasis: est && est.known ? `the usual ${item.language} window` : "the usual window for a release like this",
    // The full date in the edition's locale (India's when there is no edition).
    fullDate: (d) => fmtDateFull(d, localeFor((cfg && cfg.code) || "in")),
  };
}

// A digital date announced and still ahead.
function descDigitalUpcoming({ item, yr, country, fullDate }) {
  const when = fullDate(item.digitalDate);
  const on = item.digitalNote ? ` on ${item.digitalNote}` : "";
  return fitDesc([
    `${item.title}${yr} starts streaming${on} in ${country} on ${when}. The verdict, runtime and cast — and whether it's worth the wait.`,
    `${item.title} streams${on} in ${country} from ${when} — verdict, runtime and cast.`,
    `${item.title} streams${on} in ${country} from ${when}.`,
  ]);
}

// The announced digital date has passed and it isn't showing yet.
function descDigitalPassed({ item, yr, country, fullDate }) {
  const when = fullDate(item.digitalDate);
  const on = item.digitalNote ? ` on ${canonProvider(item.digitalNote)}` : "";
  return fitDesc([
    `${item.title}${yr} was due to stream${on} in ${country} from ${when} but isn't showing yet. We check twice a day and update this page the moment it lands.`,
    `${item.title} was due to stream${on} in ${country} from ${when} — not showing yet. We update this page the moment it lands.`,
    `${item.title} was due to stream${on} in ${country} from ${when}.`,
  ]);
}

// Left every subscription service we track. Say so — never "in cinemas", never a platform.
function descGone({ item, yr, country }) {
  return fitDesc([
    `${item.title}${yr} isn't on a subscription service in ${country} right now. Where it streamed before, the verdict, and whether it's worth tracking down.`,
    `${item.title}${yr} isn't streaming in ${country} right now — where it was, and the verdict.`,
    `${item.title} isn't streaming in ${country} right now.`,
  ]);
}

// Pre-release: the date is the draw and it is public anyway, so lead with it. What is held
// back is what the searcher wants next — is it any good, how long, when will it stream.
function descUpcoming({ item, country, V, providers, rentBuy, now, fullDate }) {
  const when = fullDate(item.released);
  // Searchers ask about OTT before a film opens; quote the usual window (the page body
  // carries the same estimate, labelled as one). Cinema releases only.
  const w = item.kind !== "tv" && !providers.length && !rentBuy.length && item.platform === "Theatres"
    ? windowDates(item, now.getTime()) : null;
  const expect = w ? `${V.word === "OTT" ? "Expected on OTT" : "Expected to stream"} ${partOfMonth(w.from)} to ${partOfMonth(w.to)}` : "";
  return fitDesc([
    expect && `${item.title} opens in cinemas in ${country} on ${when}. ${expect} — runtime, cast, trailer and early reception.`,
    expect && `${item.title} opens in ${country} on ${when}. ${expect} — runtime, cast and trailer.`,
    expect && `${item.title} opens in ${country} on ${when}. ${expect}.`,
    `${item.title} opens in cinemas in ${country} on ${when}. Runtime, cast, the trailer and the early reception — plus when it's likely to reach ${V.word}.`,
    `${item.title} opens in cinemas in ${country} on ${when}. Runtime, cast, trailer and when it's likely to reach ${V.word}.`,
    `${item.title} opens in ${country} on ${when} — runtime, cast, trailer and early reception.`,
    `${item.title} opens in cinemas in ${country} on ${when}.`,
  ]);
}

// NEVER open with the platform name. That one clause is what put
// /uk/movie/don-t-say-good-luck.html at position 1.12 with ZERO clicks from 247
// impressions: the searcher read "Netflix" in the results page and went to Netflix.
// Saying it IS streaming keeps the snippet honest and on-intent; not saying WHERE is the
// entire reason to click.
function descStreaming({ item, country, statsClause }) {
  // A new sentence starts with a capital when there's no rating or runtime to lead it: 1,817
  // descriptions read "…worth your evening? the critics' take…" (VisionQuest, 27 Oct 2026).
  const lead = (rest) => (statsClause ? statsClause + rest : rest.charAt(0).toUpperCase() + rest.slice(1));
  return fitDesc([
    `${item.title} is streaming in ${country} — but is it worth your evening? ${lead("the critics' take, the audience counterpoint and every platform carrying it.")}`,
    `${item.title} is streaming in ${country} — but is it worth your evening? ${lead("critics' take and every platform carrying it.")}`,
    `${item.title} is streaming in ${country}. ${lead("verdict, critics' take and where to watch it.")}`,
    `${item.title} is streaming in ${country} — the verdict and where to watch.`,
  ]);
}

function descRentBuy({ item, country, statsClause }) {
  return fitDesc([
    `${item.title} isn't on any subscription in ${country} yet — where to rent or buy it, ${statsClause}the critics' take and whether it's worth paying for.`,
    `${item.title} isn't on a subscription in ${country} yet. Where to rent or buy it, ${statsClause}and whether it's worth paying for.`,
    `${item.title} in ${country}: where to rent or buy it, ${statsClause}and the verdict.`,
    `${item.title} — where to rent or buy it in ${country}, and the verdict.`,
  ]);
}

// A film in its streaming window, no date announced. Answers the searcher's question first
// ("Not announced yet"), then the honest estimate in plain words, then the payoff.
function descNotAnnounced({ item, V, est, now, ratingBit, runtimeBit, titleSep }) {
  const w = windowDates(item, now.getTime());
  const nowMs = now.getTime();
  const when = w.from.getTime() <= nowMs
    ? `likely by ${partOfMonth(w.to)}`
    : `expect ${partOfMonth(w.from)} to ${partOfMonth(w.to)}`;
  const venue = V.word === "OTT" ? "theatres" : "cinemas";
  const basis = est.known ? `${item.language} films usually reach ${V.word} ${est.lo}–${est.hi} weeks after ${venue}`
    : `Films like this usually reach ${V.word} ${est.lo}–${est.hi} weeks after ${venue}`;
  // Same sentence with short month names, for long titles ("late Oct to mid-Nov").
  const shortWhen = when.replace(/(January|February|March|April|May|June|July|August|September|October|November|December)/g, (m) => m.slice(0, 3));
  const statsDot = [ratingBit, runtimeBit].filter(Boolean).join(" · ");
  const pay = "We update this page the day it streams.";
  return fitDesc([
    `Not announced yet. ${basis}, so ${item.title} is ${when}. ${statsDot ? `${statsDot}. ` : ""}${pay}`,
    `Not announced yet. ${basis}, so ${item.title} is ${when}. ${pay}`,
    `Not announced yet. ${basis}, so ${item.title} is ${shortWhen}. ${pay}`,
    // Shorter, still led by the film's name: without these, a title too long for the forms
    // above fell through to the title-less ones below, and 30-odd pages shared one snippet.
    `${item.title}${titleSep} ${titleSep ? "not" : "Not"} announced yet. ${basis}, so expect it ${shortWhen.replace(/^(likely|expect) /, "")}. ${pay}`,
    `${item.title}${titleSep} ${titleSep ? "not" : "Not"} announced yet; usually ${est.lo}–${est.hi} weeks after ${venue}, so ${shortWhen.replace(/^(likely|expect) /, "")}. ${pay}`,
    `Not announced yet. ${basis}, so expect it ${when.replace(/^(likely|expect) /, "")}. ${pay}`,
    `Not announced yet. ${basis}, so expect it ${shortWhen.replace(/^(likely|expect) /, "")}. ${pay}`,
    `Not announced yet — ${item.title} is ${when}. ${pay}`,
  ].map((t) => t.replace(" is expect ", " should land ")));
}

// The money branch. "<film> ott release date" is the highest-volume query shape these
// pages rank for, and the snippet used to answer it with "coming soon". A dated window,
// labelled as a pattern, beats both a non-answer and a competitor's unsourced guess.
function descExpectedWindow({ item, V, est, titleSep, windowBasis, inCinemas, statsClause }) {
  return fitDesc([
    `${item.title}${titleSep} ${V.word} release expected around ${est.short} (${windowBasis}, not a confirmed date). ${cap(inCinemas)}; ${statsClause}verdict inside.`,
    `${item.title}${titleSep} ${V.word} release expected around ${est.short} (${windowBasis}, not a confirmed date). ${statsClause}verdict and runtime inside.`,
    `${item.title}${titleSep} ${V.word} release expected around ${est.short} (a pattern, not a confirmed date). ${cap(inCinemas)}.`,
    `${item.title}${titleSep} ${V.word} release expected around ${est.short}. ${cap(inCinemas)}.`,
  ]);
}

// Released, not streaming, and past the usual window: the honest answer to "when on OTT?"
// is that nobody has said — so the snippet says exactly that, first. Led by the film's own
// name (Oct 2026): without it, 747 pages shared 93 identical snippets.
function descLapsed({ item, yr, country, V, ratingBit, runtimeBit }) {
  const usual = hasLanguageWindow(item.language) ? `the usual ${item.language} window` : "the usual window";
  const statsDot = [ratingBit, runtimeBit].filter(Boolean).join(" · ");
  const platform = V.word === "OTT" ? "OTT platform" : "streaming service";
  return fitDesc([
    `${item.title}${yr} isn't on any ${platform} in ${country} yet, and it's later than ${usual} — no date has been announced. ${statsDot ? `${statsDot}. ` : ""}We check twice a day and update this page the moment it streams.`,
    `${item.title}${yr} isn't on any ${platform} in ${country} yet, and no date has been announced. We check twice a day and update this page the moment it streams.`,
    `${item.title} isn't streaming in ${country} yet, and no date has been announced. We update this page the moment it streams.`,
    `${item.title} isn't streaming in ${country} yet — no date announced.`,
  ]);
}

// In cinemas with no usable window (no release date on file). There is genuinely nothing to
// promise about the date, so the payoff clause carries the click.
function descInCinemas({ item, country, V, runEnded, runOpen, openedOn, statsClause }) {
  const lead = runEnded
    ? `${item.title} has finished its theatrical run in ${country}`
    : runOpen ? `${item.title} opened in cinemas in ${country}${openedOn ? ` on ${openedOn}` : ""}`
    : `${item.title} is in cinemas in ${country}`;
  return fitDesc([
    `${lead}. We re-check for ${V.article.toLowerCase()} ${V.releaseDate} every single day — ${statsClause}critics' take and the verdict inside.`,
    `${lead}. We check daily for ${V.article.toLowerCase()} ${V.releaseDate} — ${statsClause}critics' take and the verdict.`,
    `${lead} — ${statsClause}critics' take and the verdict.`,
    `${lead}.`,
  ]);
}

// Availability unknown. The old generic line at least named the film; give it a payoff
// clause too, rather than trailing off into a truncated synopsis.
function descGeneric({ item, yr, country, thing, statsClause }) {
  return fitDesc([
    `${item.title}${yr}: ${[item.language, item.genre].filter(Boolean).join(" ")} ${thing} — ${statsClause}the verdict, the critics' take and where to watch it in ${country}.`,
    `${item.title}${yr}: ${[item.language, item.genre].filter(Boolean).join(" ")} ${thing} — rating, verdict and where to watch in ${country}.`,
    `${item.title}${yr} — rating, verdict and where to watch in ${country}.`,
  ]);
}

// Which state the page is in, checked in this order (the first match wins); returns the
// description for it. The lapsed check sits inside the cinemas state, as it always has.
function descForState(c) {
  const { item, opts, upcoming, providers, rentBuy, est, inCinemasOnly } = c;
  const film = item.kind !== "tv";
  if (film && digitalUpcoming(item)) return descDigitalUpcoming(c);
  if (film && digitalPassed(item)) return descDigitalPassed(c);
  if (opts.gone) return descGone(c);
  if (upcoming && item.released) return descUpcoming(c);
  if (providers.length) return descStreaming(c);
  if (rentBuy.length) return descRentBuy(c);
  if (est && film) return descNotAnnounced(c);
  if (est) return descExpectedWindow(c);
  if (item.platform === "Theatres" || (inCinemasOnly && item.released && !upcoming)) {
    const lapsed = film && item.released && !upcoming && !providers.length && !rentBuy.length;
    return lapsed ? { final: descLapsed(c) } : descInCinemas(c);
  }
  return descGeneric(c);
}

function filmMetaDescription(item, cfg = null, opts = {}) {
  // A series on air: its schedule is what people come for (lib/series.js seriesDescription).
  // The flag is worked out here too: the frozen-page chain (lib/archive.js rewriteMetaDescription)
  // calls this with the stored item, which never carries buildFilmPage's _fix30.
  const code0 = (cfg && cfg.code) || "in";
  const airLabel = !!(item && (item._fix30 || (item.slug && inRollout(PAGE_FIXES, item.slug) && !require("./googlehide.js").listedHidden(code0, item.slug))));
  const sd = require("./series.js").seriesDescription(item, (dt) => fmtDateFull(dt, localeFor(code0)), undefined, { airLabel });
  if (sd) return trim(sd, 160);
  const c = descContext(item, cfg, opts);
  let desc = descForState(c);
  if (desc && typeof desc === "object") return desc.final;
  // Last-resort guard: five live pages once shipped with an empty description. Never again.
  if (!desc || desc.trim().length < 20) {
    desc = trim(`${item.title}${c.yr}: ${[item.language, item.genre, c.thing].filter(Boolean).join(" ")} — review, rating and where to watch in ${c.country}`, 155);
  }
  return desc;
}

// The expected streaming window as it still applies today: months already gone are dropped,
// so a Sep–Oct window read on 3 Oct says "Oct". Null once the whole window has passed.
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// LEAN PAGE (Oct 2026, rollout feature LEAN_PAGE): every fact once. The rating lives in the
// FilmyChill Score ring (no header rating line); the rating count once in the score box; the
// platform in the answer box, which leads the page; runtime, genre and language in the header
// line; one "skip if" list; prose sentences that only restate those are left out; the
// certificate in "Good to know" only; the synopsis ("Story") after the cast. Measured on three
// pages: rating shown 5x -> 1x, count 4-6x -> 1x, runtime 2-3x -> 1x, ~20% fewer words.
const LEAN_PAGE = "lean-page";
const leanPage = (item) => !!(item && item.slug && inRollout(LEAN_PAGE, item.slug));
// A sentence that only restates the rating, count, platform or runtime shown elsewhere.
// (The cinema opening and "check back" lines restate the answer box at the top.)
const RESTATES = /\d(?:\.\d)?\/10|\bratings?\b|you can stream it|is streaming in|clocks in at|runs about|runs a manageable|\b\d+[ -]minutes?\b|episodes run|\b\d+h(?: \d+m)? of |opened in (?:theatres|cinemas)|opens in (?:theatres|cinemas)|is in (?:theatres|cinemas)|check back here|in theatres in [^.]* now|best caught on the big screen|theatrical run|have rated it|treat that \d/i;
const leanText = (s) => String(s || "").split(/(?<=\.)\s+/).filter((x) => x && !RESTATES.test(x)).join(" ");
const LEAN_MARK = "<!--FC:lean-->";
// Machine-readable rating and count for lib/facts.js (the visible copies were the header line and
// the audience row, which the lean layout no longer carries). A comment: never shown, not content.
const audienceMark = (item) => `<!--FC:audience=${item.rating != null ? Number(item.rating) : ""}|${Number(item.votes) || 0}-->`;
// The edition's film index for franchise rows, read once per build (lib/graph.js filmIndexFor
// reads every page on disk; a frozen page's render has no index of its own).
const _franchiseIdx = new Map();
function franchiseIndexFor(code) {
  const key = `${process.cwd()}|${code}`;
  if (!_franchiseIdx.has(key)) _franchiseIdx.set(key, filmIndexFor({ code }));
  return _franchiseIdx.get(key);
}
// Tests: read the pages on disk again.
function resetFranchiseIndex() { _franchiseIdx.clear(); }
// The poster is the first image a phone draws (SEO audit, 25 Oct 2026): it comes from TMDB's
// image server, so the browser opens that connection while it reads the <head>, and the poster
// itself is fetched ahead of the rest (fetchpriority="high" on the <img>). With the lean layout,
// so each page is rewritten once, in the same batches.
const posterFirst = (item, lean) => (lean && /^https:\/\/image\.tmdb\.org\//.test(String(item.poster || ""))
  ? '\n<link rel="preconnect" href="https://image.tmdb.org">' : "");
// An overseas page this recent is never treated as an empty shell (see isShellPage).
const RECENT_RELEASE_DAYS = 180;
// Titles that match the search (filmTitleTag; rollout feature INTENT_TITLES): overseas, a film's
// first CINEMA_TITLE_DAYS lead with its local release date; past STREAMING_DATE_TITLE_DAYS (a year), a
// streaming film's title drops "OTT Release Date".
const INTENT_TITLES = "intent-titles";
// "If you liked this" picks pages Google can see first (lib/graph.js relatedFilms), in stages.
const VISIBLE_SIMILAR = "visible-similar";
// Five page fixes from the VisionQuest audit (30 Oct 2026), in stages; see buildFilmPage.
const PAGE_FIXES = "page-fixes-30oct";
const wikiUrl = (article) => `https://en.wikipedia.org/wiki/${encodeURIComponent(String(article).replace(/ /g, "_"))}`;
const CINEMA_TITLE_DAYS = 28;
const STREAMING_DATE_TITLE_DAYS = 365;
const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function windowDates(item, nowMs) {
  const est = streamWindowShort(item.released, item.language, new Date(nowMs));
  if (!est) return null;
  const rel = Date.parse(`${item.released}T00:00:00Z`);
  const from = new Date(rel + est.lo * 7 * 864e5), to = new Date(rel + est.hi * 7 * 864e5);
  return { est, from, to };
}
function expectedMonthsLeft(item, nowMs) {
  const w = windowDates(item, nowMs);
  if (!w) return null;
  const start = w.from.getTime() > nowMs ? w.from : new Date(nowMs);
  const a = MON3[start.getUTCMonth()], b = MON3[w.to.getUTCMonth()];
  return a === b ? a : `${a}\u2013${b}`;
}
// "early/mid/late October" — how a person says when, rather than a pair of dates.
function partOfMonth(d) {
  const day = d.getUTCDate();
  return `${day <= 10 ? "early" : day <= 20 ? "mid" : "late"}${day <= 10 || day > 20 ? " " : "-"}${MONTH_FULL[d.getUTCMonth()]}`;
}

// ============================================================================
// FILM-PAGE TITLE — pure, so the live builder and the frozen-archive retitler cannot drift.
//
// Sept 2026 GSC forced this rule. India film pages that were NOT streaming carried an
// "<film> OTT Release Date" title, on the theory that the query shape is where the volume is.
// The volume is real and the titles rank: 8,616 impressions from "ott release date" queries
// in 28 days, at positions 4-10. They produced 37 clicks — 0.43%. The reason is visible in
// the SERP: the page ranks, the snippet honestly says the date has not been announced, and
// the searcher picks a result that claims to know. A title that promises an answer the page
// cannot give earns the impression and loses the click, and a page-1 listing that nobody
// clicks is a ranking signal working against every other query the site competes for.
//
// So the date wording is now reserved for the case where the page HAS the answer: the film
// is streaming, the date arrived, and the page can say where. Everything else targets
// "where to watch <film>", which is what these pages can always answer truthfully.
//
// Google shows ~60 chars; the ladder drops decoration (brand, year) before it drops the
// query-bearing words, so truncation never eats the part that earns the click. Outside India
// the country is never dropped (titleWithCountry): a long title beats one shared by 14 editions.
function filmTitleTag(item, cfg = null) {
  const country = countryNameFor(cfg);
  const V = streamVocab(cfg);
  const year = (item.released || "").slice(0, 4);
  const yr = year ? ` (${year})` : "";
  const providers = Array.isArray(item.providers) ? item.providers : [];
  const fitTitle = (opts) => {
    const pool = opts.map((t) => titleWithCountry(t, cfg));
    return pool.find((t) => t.length <= 60) || pool[pool.length - 1];
  };
  // NOT OUT YET in this country: the only thing the page can answer is when. Sept 2026 GSC:
  // "<film> release date in <country>" drew ~1,900 impressions a month at position ~9.6 and
  // 7 clicks, because these pages were titled "Review & Where to Watch" — two things a film
  // that hasn't opened cannot offer — while the date the searcher wanted sat unseen in the
  // body. Same rule as the OTT-date wording: the title promises what the page can answer.
  // It switches back on release day (live pages regenerate; frozen ones via the due pass).
  if (item.released && releaseState(item.released) === "upcoming" && !providers.length) {
    const code = (cfg && cfg.code) || "in";
    const d = fmtDateShort(item.released, Date.now(), localeFor(code));
    return fitTitle([
      `${item.title}${yr} — Release Date in ${country}: ${d} | FilmyChill`,
      `${item.title}${yr} — Release Date in ${country}: ${d}`,
      `${item.title} — Release Date in ${country}: ${d}`,
      `${item.title}${yr} — Release Date in ${country}`,
      `${item.title} — Release Date: ${d}`,
      `${item.title}${yr} — Release Date`,
    ]);
  }
  // Announced streaming date, not arrived yet: the page CAN answer "OTT release date" now,
  // with the date (and platform when TMDB names it). See digitalReleaseFor.
  // Once that date has passed without the film arriving, the announced date is still the
  // answer to "OTT release date"; the page body says it hasn't shown up yet (digitalPassed).
  if (item.kind !== "tv" && (digitalUpcoming(item) || digitalPassed(item))) {
    const code = (cfg && cfg.code) || "in";
    const d = fmtDateShort(item.digitalDate, Date.now(), localeFor(code));
    const on = item.digitalNote ? ` on ${canonProvider(item.digitalNote)}` : "";
    const label = V.word === "OTT" ? "OTT Release Date" : "Streaming Date";
    return fitTitle([
      `${item.title}${yr} ${label}: ${d}${on} | FilmyChill`,
      `${item.title}${yr} ${label}: ${d}${on}`,
      `${item.title} ${label}: ${d}${on}`,
      `${item.title}${yr} ${label}: ${d}`,
      `${item.title} ${label}: ${d}`,
    ]);
  }
  // OUT IN THEATRES, NOT STREAMING, NO ANNOUNCED DATE (Oct 2026). The Sept rule above moved
  // these to "Where to Watch", and Search Console then measured it: "ott release date" searches
  // fell from 0.43% CTR to 0.23% — the title no longer matched the question at all. The old
  // title failed for a different reason: it promised a date and the snippet had none. This
  // one answers the question honestly IN the title: the expected window, marked unconfirmed,
  // or "Not Announced Yet" once the usual window has passed. Films only; TV has no such date.
  // A film that left streaming (lib/factsq.js state "gone") isn't awaiting a release date.
  if (item.kind !== "tv" && !providers.length && item.released && releaseState(item.released) !== "upcoming" && item.state !== "gone") {
    const left = expectedMonthsLeft(item, Date.now());
    // FIRST WEEKS IN CINEMAS, OUTSIDE INDIA (Oct 2026, rollout "intent-titles"). Overseas, the
    // searches in a film's cinema run are "<film> release date <country>" ("clayface release
    // date philippines": ~65 a day at #8.8, 0 clicks; "you can see everything singapore release
    // date"), and the title answered only the streaming date. It now leads with the local release
    // date — the same date the page's body states as the cinema opening — then the window.
    const code0 = (cfg && cfg.code) || "in";
    const daysOut = (Date.now() - Date.parse(`${String(item.released).slice(0, 10)}T00:00:00Z`)) / 864e5;
    if (code0 !== "in" && daysOut >= 0 && daysOut <= CINEMA_TITLE_DAYS && inRollout(INTENT_TITLES, item.slug)) {
      const d = fmtDateShort(item.released, Date.now(), localeFor(code0));
      const next = left ? `${V.word === "OTT" ? "OTT" : "Streaming"} ${left}` : "";
      return fitTitle([
        next ? `${item.title}${yr} Release Date in ${country}: ${d} · ${next}` : null,
        next ? `${item.title} Release Date in ${country}: ${d} · ${next}` : null,
        `${item.title}${yr} Release Date in ${country}: ${d}`,
        `${item.title} Release Date in ${country}: ${d}`,
        `${item.title} — Release Date in ${country}`,
      ].filter(Boolean));
    }
    if (V.word === "OTT") {
      // India is the home edition, so no country in its title; fitTitle adds it for the UAE.
      if (left) {
        return fitTitle([
          `${item.title}${yr} OTT Release Date: Expected ${left}, Not Yet Confirmed`,
          `${item.title}${yr} OTT Release Date: Expected ${left} (Unconfirmed)`,
          // Before the year goes: "Street Fighter (2026) OTT Release Date: Expected Nov–Dec"
          // (56 chars) was never offered, so the year fell out — and "street fighter 2026 …"
          // searches had ~400 impressions in a month. The description says it's unconfirmed.
          // Every with-year form comes first: once the window shrank to "Dec", the no-year
          // "(Unconfirmed)" form fit in 60 and dropped the year again (28 Oct 2026).
          `${item.title}${yr} OTT Release Date: Expected ${left}`,
          `${item.title} OTT Release Date: Expected ${left}, Not Yet Confirmed`,
          `${item.title} OTT Release Date: Expected ${left} (Unconfirmed)`,
          `${item.title} OTT Release Date: Expected ${left}`,
        ]);
      }
      return fitTitle([
        `${item.title}${yr} OTT Release Date: Not Announced Yet`,
        `${item.title} OTT Release Date: Not Announced Yet`,
        `${item.title} — OTT Release Date`,
      ]);
    }
    // Elsewhere the country stays in the title where it fits: 14 editions of one film must not
    // share an identical title, and the country tells a searcher the result is about them.
    if (left) {
      return fitTitle([
        `${item.title}${yr} Streaming Date in ${country}: Expected ${left}`,
        `${item.title} Streaming Date in ${country}: Expected ${left}`,
        `${item.title}${yr} Streaming Date: Expected ${left}`,
        `${item.title} Streaming Date: Expected ${left}`,
      ]);
    }
    return fitTitle([
      `${item.title}${yr} Streaming Date in ${country}: Not Announced`,
      `${item.title} Streaming Date in ${country}: Not Announced`,
      `${item.title}${yr} Streaming Date: Not Announced Yet`,
      `${item.title} — Streaming Date in ${country}`,
      `${item.title} — Streaming Date`,
    ]);
  }
  // "OTT" is Indian-market phrasing; TV has no OTT release date to speak of; and with no
  // provider on file there is no date to report.
  // A film streaming for months isn't searched for its "OTT release date" (KILL 2024, Jawan 2023
  // were titled that way): past STREAMING_DATE_TITLE_DAYS it's "Review & Where to Watch" (rollout
  // "intent-titles").
  // A SERIES ON AIR (lib/series.js, 27 Oct 2026): the searches while it runs are "episode 5 release
  // date", "how many episodes", "<show> episode schedule" — every competing page led with the
  // schedule. While a next episode is due the title says the page has it.
  const epNext = item.kind === "tv" && item.episodes && item.episodes.next && item.episodes.next.date;
  if (epNext && epNext >= new Date().toISOString().slice(0, 10)) {
    return fitTitle([
      `${item.title}${yr}: Episode Schedule & Where to Watch in ${country} | FilmyChill`,
      `${item.title}${yr}: Episode Schedule & Where to Watch in ${country}`,
      `${item.title}: Episode Schedule & Where to Watch in ${country}`,
      `${item.title}${yr}: Episode Schedule & Where to Watch`,
      `${item.title}: Episode Schedule`,
    ]);
  }
  const longOut = item.released && (Date.now() - Date.parse(`${String(item.released).slice(0, 10)}T00:00:00Z`)) / 864e5 > STREAMING_DATE_TITLE_DAYS
    && inRollout(INTENT_TITLES, item.slug);
  const canAnswerDate = V.word === "OTT" && item.kind !== "tv" && providers.length > 0 && !longOut;
  return canAnswerDate
    ? fitTitle([
        `${item.title}${yr} ${V.titleFragment}, Review & Where to Watch | FilmyChill`,
        `${item.title}${yr} ${V.titleFragment}, Review & Where to Watch`,
        `${item.title}${yr} ${V.titleFragment} & Review`,
        `${item.title}${yr} ${V.titleFragment}`,
      ])
    // "Where to Watch" is the query-bearing phrase in this branch, so it survives to the
      // LAST tier. The old ladder ended at "— Review", which threw the query words away on
      // exactly the long titles that most needed them.
    : fitTitle([
        `${item.title}${yr} — Review, Rating & Where to Watch in ${country} | FilmyChill`,
        `${item.title}${yr} — Review, Rating & Where to Watch in ${country}`,
        `${item.title}${yr} — Review & Where to Watch in ${country}`,
        `${item.title}${yr} — Where to Watch in ${country}`,
        // Long titles used to fall straight to the bare tier, so all 14 editions of the same
        // film showed an identical title with no country in it. The year is the cheaper thing
        // to lose: the H1 and the page carry it, and the country is what tells a searcher in
        // Manila that this result is about Manila.
        year ? `${item.title} — Where to Watch in ${country}` : null,
        `${item.title}${yr} — Where to Watch`,
      ].filter(Boolean));
}

// Arrival dates from the append-only archive, indexed once per process: country:kind:id ->
// first-seen date. buildFilmPage runs ~1,600 times a build, so this can't re-read the file.
let _arrivalIdx = null;
function arrivalDateFor(code, kind, tmdbId) {
  if (!_arrivalIdx) {
    _arrivalIdx = new Map();
    for (const r of readHistory()) {
      if (r && r.c && r.id) _arrivalIdx.set(`${r.c}:${r.k}:${r.id}`, r.first);
    }
  }
  return _arrivalIdx.get(`${code}:${kind === "tv" ? "tv" : "movie"}:${tmdbId}`) || null;
}

// Crawl paths OUT of a film page, into the two hubs it belongs to: the platform carrying it
// and the month it arrived. Sept 2026: a Netflix title linked to five language hubs and the
// weekly OTT page, and to nothing Netflix-related — the platform hubs had almost no inbound
// links from the archive that feeds them. Both links are written only when the target page
// exists on disk, so this can never point at a 404.
function filmHubLinks(item, cfg) {
  const code = (cfg && cfg.code) || "in";
  const out = [];
  const providers = Array.isArray(item.providers) ? item.providers : [];
  if (providers.length) {
    const name = canonProvider(providers[0]);
    const slug = platformSlug(name);
    if (slug && fs.existsSync(hubPath(code, slug))) {
      out.push(`<a href="${escHtml(code === "in" ? `/new-on-${slug}/` : `/${code}/new-on-${slug}/`)}">Everything new on ${escHtml(name)}</a>`);
    }
    // The evergreen page for this platform, when it exists: the crawl path back from every
    // film to the page that lists them all.
    if (slug && fs.existsSync(streamPagePath(code, slug))) {
      out.push(`<a href="/${escHtml(STREAM_BASE(code))}/${escHtml(slug)}/">All ${escHtml(name)} titles in ${escHtml(countryNameFor(cfg))}</a>`);
    }
    const arrival = arrivalDateFor(code, item.kind, item.tmdbId);
    const m = arrival ? monthKey(arrival) : null;
    if (m && fs.existsSync(ottMonthPath(code, m))) {
      out.push(`<a href="${escHtml(code === "in" ? `/new-on-ott/${m}/` : `/${code}/new-on-ott/${m}/`)}">Everything that arrived in ${escHtml(monthLabel(m, localeFor(code)))}</a>`);
    }
  }
  return out.length
    ? `<p style="color:var(--mute);font-size:12.5px;margin-top:10px">More: ${out.join(" · ")}</p>`
    : "";
}

const FCSB_CSS = [
  "  /* FilmyChill Score (lib/fcscore.js) */",
  "  @font-face { font-family:'Anton'; src:url('/fonts/anton-latin.woff2') format('woff2'); font-display:swap; }",
  "  .fcsb { margin:18px 0 6px; padding:18px; background:#fff; border-radius:18px; box-shadow:0 4px 18px rgba(64,56,199,.08); }",
  "  .fcsb-label { display:flex; align-items:center; gap:6px; font-size:11px; font-weight:700; letter-spacing:1.3px; text-transform:uppercase; color:#8A5800; }",
  "  .fcsb-label svg { width:15px; height:15px; fill:none; stroke:#A66B00; stroke-width:2.5; stroke-linecap:round; stroke-linejoin:round; }",
  "  .fcsb-verdict { display:flex; align-items:center; flex-wrap:wrap; gap:10px 14px; margin-top:12px; }",
  // The audience-rating ring (Oct 2026 redesign; the homepage cards use the same one): filled to
  // the rating out of 10, coloured by the verdict; a dashed ring when there is no rating to show.
  "  .fcsb-verdict .dial { --dc:#D18A00; width:56px; height:56px; border-radius:50%; flex-shrink:0; display:grid; place-items:center; background:conic-gradient(var(--dc) var(--p, 0%), #EFE6D6 0); }",
  "  .fcsb-verdict .dial span { width:44px; height:44px; border-radius:50%; background:#fff; display:grid; place-items:center; font-family:'Anton',sans-serif; font-size:18px; line-height:1; color:var(--ink); }",
  "  .fcsb-verdict .dial-must { --dc:#1E7A4C; } .fcsb-verdict .dial-worth { --dc:#D18A00; } .fcsb-verdict .dial-skip { --dc:#D93A28; }",
  "  .fcsb-verdict .dial-note { width:64px; text-align:center; font-size:11px; font-weight:700; line-height:1.25; color:#8C85A3; }",
  "  .fcsb-stamp { display:inline-block; padding:8px 14px; border-radius:10px; font-family:'Anton',sans-serif; font-size:28px; line-height:1; letter-spacing:.4px; text-transform:uppercase; white-space:nowrap; }",
  "  @media (max-width: 420px) { .fcsb-verdict .dial { width:50px; height:50px; } .fcsb-verdict .dial span { width:40px; height:40px; font-size:16px; } .fcsb-stamp { font-size:24px; padding:7px 12px; } }",
  "  .fcsb-must { background:#1E7A4C; color:#FFFFFF; } .fcsb-worth { background:#FFAD1F; color:#241D52; }",
  "  .fcsb-skip { background:#FBE3DF; color:#A52617; }",
  "  .fcsb-early { background:#EFE6D6; color:#5E5878; }",
  "  .fcsb-why { font-size:15.5px; line-height:1.55; margin:12px 0 0; }",
  "  .fcsb-rows { margin-top:14px; padding-top:12px; border-top:1px solid #EFE6D6; display:grid; gap:10px; }",
  "  .fcsb-row { display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:13px; }",
  "  .fcsb-row small { display:block; color:var(--mute); font-size:12px; margin-top:2px; }",
  "  .fcsb-tag { font-size:12px; font-weight:700; padding:4px 10px; border-radius:999px; background:#EAE8FA; color:var(--indigo); white-space:nowrap; }",
  "  .fcsb-tag.none { background:#F4F1EA; color:#5A5470; }",
  "  .fcsb-conf { font-size:12px; font-weight:700; letter-spacing:.3px; color:#5A5470; background:#F4F1EA; border-radius:999px; padding:5px 11px; white-space:nowrap; }",
  ...VOTE_CSS,
  // Answer-first (Oct 2026): a page with no score yet shows one line, not an empty card, and
  // the answer to the search sits above it. Kept before .fcsb-note: injectScoreSection's
  // refresh matches this block up to that rule.
  "  .fcsb.fcsb-compact { margin:4px 2px 16px; padding:0; background:none; box-shadow:none; border-radius:0; }",
  "  .fcsb-mini { font-size:13px; color:var(--mute); line-height:1.6; margin:0; }",
  "  .fcsb-mini-k { font-weight:700; color:#8A5800; text-transform:uppercase; letter-spacing:1px; font-size:11px; margin-right:6px; }",
  "  .answer:has(+ .fcsb-compact) { font-size:16.5px; line-height:1.6; border-left-color:var(--marigold); margin-top:16px; }",
  "  body:has(.fcsb-compact) .rating-few { display:none; }",
  "  .fcsb-note { font-size:13px; color:var(--mute); line-height:1.5; margin:8px 0 0; }",
].join("\n");

// THE 27 OCT 2026 REDESIGN (lean pages; the owner approved the mock-up). Same palette and fonts:
// the backdrop behind the title (.hero), the answer as a card over it with the next episode
// (.anscard, .nextep), a bigger score ring with the two halves as tiles, Good to know as tiles,
// the episode timeline (.eplist), the franchise row with "You're here" (.frrow), cards for the
// fit rows and the FAQ. Styling and wrappers only: every element lib/facts.js and the archive
// patchers read keeps its markup.
const REDESIGN_CSS = [
  "  /* Redesign, 27 Oct 2026 */",
  "  .hero { margin:-20px -16px 0; padding:22px 16px 66px; background-color:#2B2486; background-size:cover; background-position:center 30%; color:#fff; }",
  "  .hero .head { align-items:end; } .hero h1 { color:#fff; font-size:27px; line-height:1.15; } .hero .meta { color:rgba(255,255,255,.86); }",
  "  .hero .poster { box-shadow:0 12px 30px rgba(10,6,40,.5); }",
  "  .anscard { position:relative; margin:-50px 0 4px; background:#fff; border-radius:18px; box-shadow:0 8px 26px rgba(64,56,199,.14); padding:2px 0 4px; }",
  "  .anscard .answer { margin:0; border:0; background:none; border-radius:0; padding:14px 16px 6px; font-size:17px; }",
  "  .anscard .ansub { padding:0 16px !important; margin:0 0 10px !important; }",
  "  .nextep { margin:0 12px 12px; background:var(--cream); border-radius:12px; padding:10px 12px; font-size:14px; line-height:1.5; }",
  "  .fcsb-verdict .dial { width:84px; height:84px; } .fcsb-verdict .dial span { width:68px; height:68px; font-size:28px; }",
  // The ring is the AUDIENCE rating (lib/meter.js), not the FilmyChill Score: say so under it.
  "  .fcsb-verdict .dial { position:relative; margin-bottom:16px; } .fcsb-verdict .dial::after { content:'Audience rating'; position:absolute; top:100%; left:50%; transform:translateX(-50%); margin-top:4px; font-size:10.5px; font-weight:600; color:var(--mute); white-space:nowrap; }",
  "  .tlink { margin-top:8px; font-size:14px; }",
  "  .fcsb-rows { grid-template-columns:1fr 1fr; } .fcsb-row { flex-direction:column; align-items:flex-start; background:#F7F5FF; border-radius:12px; padding:10px; }",
  "  h2 { font-size:18px; margin:26px 0 10px; }",
  "  .fit { border-left:0; background:#fff; border-radius:16px; padding:14px 16px; }",
  "  .gtk { display:block; } .gtk tbody { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; }",
  "  .gtk tr { display:flex; flex-direction:column; gap:3px; background:#fff; border:1px solid var(--line); border-radius:14px; padding:12px; }",
  "  .gtk td { border:0; padding:0; width:auto !important; text-align:left !important; } .gtk td:first-child { font-size:12px; } .gtk td:last-child { font-size:15px; font-weight:700; }",
  "  .eplist { list-style:none; margin:8px 0 0; padding:4px 14px; background:#fff; border-radius:16px; }",
  "  .eplist li { display:flex; gap:12px; align-items:flex-start; padding:10px 0; border-top:1px solid #F0EEF9; } .eplist li:first-child { border-top:0; }",
  "  .epn { width:26px; height:26px; flex-shrink:0; border-radius:50%; display:grid; place-items:center; font-size:12px; font-weight:700; background:var(--indigo); color:#fff; }",
  "  .eplist .next .epn { background:var(--marigold); color:#241D52; } .eplist .soon .epn { background:#fff; color:var(--mute); border:1.5px solid #C9C4EC; }",
  "  .eplist b { display:block; font-size:14.5px; } .eplist small { color:var(--mute); font-size:12.5px; } .eplist .soon b { color:var(--mute); }",
  "  .epcadence { color:var(--mute); font-size:14px; margin:4px 0 0; }",
  "  .eptag { margin-left:auto; font-size:11px; font-weight:700; padding:3px 8px; border-radius:999px; background:var(--marigold); color:#241D52; white-space:nowrap; }",
  "  .frrow { display:flex; gap:10px; overflow-x:auto; padding:4px 0 8px; }",
  "  .frcard { flex:0 0 104px; text-decoration:none; color:var(--ink); }",
  "  .frcard img, .frcard .nop { width:104px; aspect-ratio:2/3; object-fit:cover; border-radius:10px; display:block; background:var(--line); }",
  "  .frcard b { display:block; font-size:12.5px; margin-top:6px; line-height:1.25; } .frcard small { color:var(--mute); font-size:11px; }",
  "  .frcard.here img, .frcard.here .nop { outline:2px solid var(--marigold); outline-offset:-2px; }",
  "  .frhere { display:inline-block; margin-top:6px; font-size:10.5px; font-weight:700; background:var(--marigold); color:#241D52; border-radius:999px; padding:2px 8px; }",
  "  .simcard { border:0; box-shadow:0 2px 10px rgba(64,56,199,.07); }",
  "  .frame { border-radius:16px; }",
  "  .faq { background:#fff; border-radius:16px; padding:2px 16px; } .faq details:first-child { border-top:0; }",
].join("\n");

// The franchise row: the siblings and this title in release order, this one marked.
function franchiseRowHtml(fr, item, code) {
  const e = escHtml;
  const yr = (x) => String(x.released || "").slice(0, 4);
  const self = { slug: item.slug, title: item.title, released: item.released, poster: item.poster, here: true };
  const all = [...fr.items, self].sort((a, b) => String(a.released || "").localeCompare(String(b.released || "")));
  const card = (x) => {
    const img = x.poster ? `<img src="${e(cardPoster(x.poster))}" alt="${e(x.title)} poster" loading="lazy">` : `<span class="nop"></span>`;
    return x.here
      ? `<div class="frcard here">${img}<span class="frhere">You're here</span><b>${e(x.title)}</b><small>${e(yr(x))}</small></div>`
      : `<a class="frcard" href="${e(filmPagePath(code, x.slug))}">${img}<b>${e(x.title)}</b><small>${e(yr(x))}</small></a>`;
  };
  return `<h2>${e(fr.heading)}</h2><div class="frrow">${all.map(card).join("")}</div>`;
}

// The score line for a page with no score yet. `label` and `audience` come from the item on a
// live render, or from the page's own card on a frozen one (see compactEarlyScore).
function compactScoreHtml(label, audience, tail = ", no critics' verdict yet.") {
  const e = escHtml;
  return `<section class="fcsb fcsb-compact" id="filmychill-score"><p class="fcsb-mini"><span class="fcsb-mini-k">FilmyChill score</span> <span class="fcsb-mini-v">${e(label)}</span> — ${e(audience)}${tail} <a href="/about/#score">How scoring works</a></p></section>`;
}
// Time words ("so far", "yet") only for a film that's actually new; an older film gets the plain
// count ("only 12 audience ratings"), never a hint that more are on the way (Oct 2026).
function audiencePhrase(votes, recent) {
  const n = Number(votes || 0);
  if (n > 0) return recent
    ? `${n.toLocaleString("en-IN")} audience rating${n === 1 ? "" : "s"} so far`
    : `only ${n.toLocaleString("en-IN")} audience rating${n === 1 ? "" : "s"}`;
  return recent ? "no audience ratings yet" : "no audience ratings on TMDB";
}

// The answer line above a compact score line; below the full card (and its vote widget) once a
// film has a score. Used by the score sweep and the frozen-page pass, so a page moves either
// way as its score changes. Idempotent; a page with no answer line or no score is left alone.
const SCORE_SECTION_RE = /<section class="fcsb[^"]*" id="filmychill-score">[\s\S]*?<\/section>(?:\s*<p class="fcsb-note">[\s\S]*?<\/p>)?/;
function orderAnswer(html) {
  // A lean page (LEAN_PAGE) keeps its answer (and its "Included with…" line) above the score,
  // whatever the score: the platform is the first thing a reader is told.
  if (html.includes(LEAN_MARK)) return html;
  const ans = /\n?[ \t]*<p class="answer">[\s\S]*?<\/p>/.exec(html);
  const sec = SCORE_SECTION_RE.exec(html);
  if (!ans || !sec) return html;
  const answer = ans[0].trim();
  const compact = sec[0].includes("fcsb-compact");
  if (compact) {
    if (ans.index < sec.index && html.slice(ans.index + ans[0].length, sec.index).trim() === "") return html;
    const without = html.slice(0, ans.index) + html.slice(ans.index + ans[0].length);
    const at = SCORE_SECTION_RE.exec(without).index;
    return without.slice(0, at) + answer + "\n  " + without.slice(at);
  }
  if (ans.index > sec.index) return html;
  const without = html.slice(0, ans.index) + html.slice(ans.index + ans[0].length);
  const s2 = SCORE_SECTION_RE.exec(without);
  let at = s2.index + s2[0].length;
  const vote = /\s*<div class="fcvote"[\s\S]*?<\/div>\s*<\/div>(?:\s*<script src="\/js\/vote\.js" defer><\/script>)?/.exec(without.slice(at));
  if (vote && vote.index === 0) at += vote[0].length;
  return without.slice(0, at) + "\n  " + answer + without.slice(at);
}

// "If you liked this" — exported so the related-films refresh (lib/relrefresh.js) writes the
// exact same markup into pages that are never rebuilt.
// A card poster: one URL at w342. Pages and facts written before the fix carry "url1,url2"
// (see filmIndexFor in lib/graph.js), and cards are 2:3 thumbnails, not 780px posters.
const cardPoster = (src) => String(src || "").split(",")[0].trim().replace(/(image\.tmdb\.org\/t\/p\/)w\d+\//, "$1w342/");
function simGridHtml(similar, code, linkable = () => true) {
  const e = escHtml;
  return similar.length ? `<h2>If you liked this</h2><div class="simgrid">${similar.map((s) => {
    const exists = linkable(s);
    const poster = cardPoster(s.poster);
    const inner = `${poster ? `<img src="${e(poster)}" alt="${e(s.title)} poster" loading="lazy">` : ""}<div class="st">${e(s.title)}</div><div class="sm">${[s.language, s.kind === "tv" ? "Series" : "Film"].filter(Boolean).map(e).join(" · ")}</div>`;
    return exists
      ? `<a class="simcard" href="${e(filmPagePath(code, s.slug))}">${inner}</a>`
      : `<div class="simcard" style="cursor:default">${inner}</div>`;
  }).join("")}</div>` : "";
}

// The header's confidence-tiered audience rating. Exported so the score sweep can refresh it on
// frozen and back-catalogue pages at the same time as the score, keeping the two in agreement.
function headRatingHtml(item) {
  const e = escHtml;
        // Confidence-tiered rating (see lib/score.js). The number stays TMDB's own; what we
        // add is how much to trust it, from the vote count — so an 8.0 on 13 votes reads
        // differently from an 8.2 on 1,200. Colour is backed by a text label, never alone.
        const recent = isRecent(item);
        const sc = filmScore(item, { recent });
        if (sc.displayRating == null) {
          if (recent) return `<div class="rating rating-few"><span class="cdot"></span>Rating still forming <span class="cvotes">— too few ratings yet</span></div>`;
          const n = Number(item.votes || 0);
          return n > 0
            ? `<div class="rating rating-few"><span class="cdot"></span>Too few ratings to rate <span class="cvotes">— only ${e(n.toLocaleString("en-IN"))}</span></div>`
            : `<div class="rating rating-few"><span class="cdot"></span>Not rated on TMDB</div>`;
        }
        return `<div class="rating rating-${sc.tier}"><span class="cdot"></span>★ ${Number(sc.displayRating).toFixed(1)}`
          + ` <span class="ctag">${e(sc.tierLabel)}</span>`
          + ` <span class="cvotes">${e(sc.votes.toLocaleString("en-IN"))} ratings</span>`
          + `<span class="cbar"><i style="width:${Math.round(sc.confidencePct * 100)}%"></i></span></div>`;
}

// The FilmyChill Score section of a film page (block + note). Exported so the score sweep
// (lib/scoresweep.js) can add the exact same section to frozen and back-catalogue pages,
// which are never rebuilt. Needs FCSB_CSS in the page's <style>.
function fcScoreSection(item) {
  const e = escHtml;
  const none = noScoreText(item);
    // FilmyChill Score (lib/fcscore.js): the site's own verdict, audiences + critics. It
    // replaces the header's audience-only verdict pill; the audience rating itself stays in
    // the header and again in the breakdown, labelled as the audience's.
    // Not out yet: no score, whatever the facts carried over from an older page (7 pages showed
    // "Worth a watch" ahead of release, 16 Oct 2026 audit), and the line says why. The vote count
    // stays in the "N audience ratings so far" form, which lib/facts.js reads back.
    if (notOutYet(item)) {
      const n = Number(item.votes || 0);
      return compactScoreHtml(none.label, n > 0
        ? `${n.toLocaleString("en-IN")} audience rating${n === 1 ? "" : "s"} so far, all from before its release`
        : "nobody has seen it yet", ". The score comes once people have watched it.");
    }
    const s = item.fcScore || null;
    // No score yet: one line instead of a card of empty rows (832 pages led with four
    // "not enough ratings" blocks before the answer, Oct 2026).
    // "Critics split" says the reviews are in: the line must not then add "no critics' verdict yet".
    if (!s) return compactScoreHtml(none.label, audiencePhrase(item.votes, isRecent(item)),
      none.label === "Critics split" ? ", and the critics' reviews are divided."
        : isRecent(item) ? undefined : ", and no settled critics' verdict.");
    const votes = item.votes ? Number(item.votes).toLocaleString("en-IN") : "0";
    // Lean layout (LEAN_PAGE): the ring carries the rating and the count is said once — in the
    // "Based on N ratings" chip on an early read, else here.
    const lean = leanPage(item);
    const aud = s && s.audience
      ? { tag: s.audience, sub: s.early
        ? (lean ? "Few ratings, so weighted toward an average film" : `★ ${Number(item.rating).toFixed(1)} from ${votes} ratings — few ratings, so weighted toward an average film`)
        : (lean ? `From ${votes} ratings on TMDB` : `★ ${Number(item.rating).toFixed(1)} from ${votes} ratings on TMDB`) }
      : item.rating != null && item.votes
        ? { tag: "Too few ratings", sub: `★ ${Number(item.rating).toFixed(1)} from ${votes} rating${Number(item.votes) === 1 ? "" : "s"} — counts from ${scoreNeed(item)}`, none: true }
        // A count but no average yet (TMDB publishes one later): never "no audience ratings".
        : Number(item.votes) > 0
        ? { tag: "Too few ratings", sub: `${votes} rating${Number(item.votes) === 1 ? "" : "s"} ${isRecent(item) ? "so far" : "on TMDB"} — counts from ${scoreNeed(item)}`, none: true }
        : isRecent(item)
          ? { tag: "Not rated yet", sub: "No audience ratings yet", none: true }
          : { tag: "Not rated", sub: "No audience ratings on TMDB", none: true };
    // The Critics row cites its figures (lib/reception.js, rollout "wiki-reception"): RT and
    // Metacritic with counts, the published ratings' count and median, dated to the Wikipedia read.
    const RC = require("./reception.js");
    const cited = item.reception && inRollout(RC.RECEPTION_FEATURE, item.slug)
      ? RC.receptionLine(item.reception, (d) => fmtDateFull(d, localeFor((item._code) || "in")), { tone: s && s.critics }) : "";
    const cri = s && s.critics
      ? { tag: s.critics.charAt(0).toUpperCase() + s.critics.slice(1), sub: cited || "From published reviews" }
      : { tag: "No verdict", sub: cited || "No settled critics' reception on record", none: true };
    const row = (label, x) => `<div class="fcsb-row"><div><b>${label}</b><small>${e(x.sub)}</small></div><span class="fcsb-tag${x.none ? " none" : ""}">${e(x.tag)}</span></div>`;
    const lvl = !s ? "early" : /^must/i.test(s.verdict) ? "must" : /^skip/i.test(s.verdict) ? "skip" : "worth";
    // Page v3: the two halves as one line under the card ("Audience ★ 8.6 (196 ratings) · Critics:
    // positive — 91% on Rotten Tomatoes …"), the detail sheet's form; the rows otherwise.
    const v3 = inRollout("page-v3", item.slug);
    // The label follows the cited figure when the page's own reading has no settled tone: never
    // "no settled verdict" beside "90% on Rotten Tomatoes" (28 Oct 2026).
    const criLabel = cri.none ? (RC.toneFromFigure(cited ? item.reception : null) || "no settled verdict") : cri.tag.toLowerCase();
    // One fact once (28 Oct 2026): the ring carries the audience number; the line names its
    // source and count without repeating it, then the critics' side when there is one.
    const nVotes = Number(item.votes || 0);
    const audPart = item.rating != null && nVotes ? `<b>Audience:</b> ${e(nVotes.toLocaleString("en-IN"))} ratings on TMDB`
      : nVotes ? `<b>Audience:</b> ${e(nVotes.toLocaleString("en-IN"))} ratings on TMDB, no average yet` : `<b>Audience:</b> not rated on TMDB yet`;
    // "per Wikipedia" links the article the figures came from (CC BY-SA asks for the source).
    // The reception record carries its article too (30 Oct 2026): v3 and frozen pages have no take.
    const article = item.takeArticle || (item._fix30 && item.reception && item.reception.article) || "";
    const citedHtml = cited ? (article
      ? e(cited).replace("per Wikipedia", `per <a href="${wikiUrl(article)}" rel="noopener" target="_blank">Wikipedia</a>`)
      : e(cited)) : "";
    const criPart = !cri.none || cited ? ` · <b>Critics:</b> ${e(criLabel)}${cited ? ` — ${citedHtml}` : ""}` : "";
    const line = v3 ? `<p class="fcsb-line">${audPart}${criPart}</p>` : "";
    // The two halves as a marker too (<!--FC:fcs=audience|critics-->): lib/facts.js read them from
    // the rows' tags, which the v3 line replaces; without them a frozen render lost the ring.
    const fcsMark = `<!--FC:fcs=${e(s && s.audience ? s.audience : "")}|${e(s && s.critics ? s.critics : "")}-->`;
    return `<section class="fcsb" id="filmychill-score">${RC.receptionMark(item.reception)}${fcsMark}
    <div class="fcsb-label">FilmyChill score</div>
    <div class="fcsb-verdict">${ratingDial(item)}<span class="fcsb-stamp fcsb-${lvl}">${e(s ? s.verdict : none.label)}</span>${s && s.early ? ` <span class="fcsb-conf">${e(earlyReadLabel(s))}</span>` : ""}</div>
    <p class="fcsb-why">${e(s ? RC.plainReason(s.reason) : none.why)}</p>
    ${v3 ? line : `<div class="fcsb-rows">${row("Audience", aud)}${row("Critics", cri)}</div>`}
  </section>
  <p class="fcsb-note">The FilmyChill Score combines audience ratings and critics' reception, and updates twice a day. No studio or platform can pay for a score. <a href="/about/#score">How the score works</a></p>`;
}

// The measured window as the "FilmyChill data" line words it. Shared with the frozen-page
// pass (lib/stylesheets.js), which corrects the number on pages written before Oct 2026.
function fcdataWindowPhrase(days) {
  return days === 0 ? "the same day it opened" : `${days} day${days === 1 ? "" : "s"} after its theatrical release`;
}

function buildFilmPage(item, asOf, knownSlugs, cfg, filmIndex = null) {
  // No score before release, wherever it came from: facts read back from an older page carry
  // the score it showed, and the FAQ, share-card text and panel would all repeat it.
  if (item && item.fcScore && notOutYet(item)) item = { ...item, fcScore: null };
  // One name per service (rollout "tidy-names", 29 Oct 2026). Records from before names were
  // canonicalised keep TMDB's raw ones, so 1,021 pages said "Amazon Prime Video" or "Disney Plus"
  // where every list says "Prime Video" and "Disney+", and 243 named one service twice ("Amazon
  // Prime Video", "Amazon Prime Video with Ads"). Pages Google sees only; the facts fingerprint
  // reads names the same way (lib/facts.js keyFacts), so tidying moves no page's date.
  if (item && inRollout("tidy-names", item.slug) && !require("./googlehide.js").listedHidden((cfg && cfg.code) || "in", item.slug)) {
    const tidy = (xs) => (Array.isArray(xs) ? dedupeProviders(xs) : xs);
    item = { ...item, providers: tidy(item.providers), rentBuy: tidy(item.rentBuy), ...(Array.isArray(item.wasOn) ? { wasOn: tidy(item.wasOn) } : {}) };
  }
  // Five page fixes (rollout "page-fixes-30oct", from the VisionQuest audit), pages Google sees
  // only: a series' creator is labelled Creator, not Director (TMDB's created_by fills the field);
  // the trailer preview's YouTube image is allowed by the page's CSP (it was blocked everywhere);
  // "per Wikipedia" and the footer credit link the film's article; series dates say they are
  // original air dates; an episode-length range says which episodes it covers. None of these is
  // in the facts fingerprint (lib/facts.js keyFacts), so no sitemap date moves.
  if (item && inRollout(PAGE_FIXES, item.slug) && !require("./googlehide.js").listedHidden((cfg && cfg.code) || "in", item.slug)) item = { ...item, _fix30: true };
  const e = escHtml;
  const lean = leanPage(item);   // every fact once (LEAN_PAGE)
  const V2 = require("./pagev2.js");
  const v2 = lean && V2.v2Page(item);   // the 28 Oct 2026 redesign (lib/pagev2.js), on lean pages
  // Page v3 (rollout "page-v3"): the owner's sequence — backdrop, title with its status tag, meta
  // line, audience + platform pills, score card with one Audience/Critics line, the full Story,
  // director, cast, Good to know with the where-to-watch row, episodes, trailer, franchise,
  // similar, FAQ. No answer card, call to action, prose fillers, fit rows or separate Where to
  // watch block. Every fact the readers need keeps its markup (the where-to-watch row carries
  // the pills, the availability date and the sweep markers inside <!--FC:wtw-->).
  const v3 = v2 && inRollout("page-v3", item.slug);
  const code = (cfg && cfg.code) || "in";
  // Episodes before Good to know (the owner, 30 Oct 2026): the schedule is what a series page's
  // title promises, and it sat fourth, under Story, Cast and Good to know. Nothing else moves.
  // Pages Google sees only, like the other 30 Oct changes.
  const seen = !require("./googlehide.js").listedHidden(code, item.slug);   // a page Google sees
  const epFirst = v3 && item.kind === "tv" && seen;
  // Markup clean-up and a visible date (the owner, 30 Oct 2026), pages Google sees on v3: no
  // BreadcrumbList (v3 shows no breadcrumb) and no FAQPage (the questions stay on the page; the
  // markup earns nothing); a trailer VideoObject only with the trailer's real publish date, not
  // the premiere as a stand-in; "Page updated" shown, dated like the sitemap (lib/migrate.js).
  const tidyLd = v3 && seen;
  const country = countryNameFor(cfg); // "the US", not the config's "United States" — reads right in titles and prose
  const homeUrl = code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`;
  const year = (item.released || "").slice(0, 4);
  // Three states (see releaseState): a film releasing TODAY is neither "Released" nor
  // "Coming soon". `upcoming` stays truthy for today so the page keeps its pre-release
  // shape (no streaming estimate can be computed from a run that hasn't started).
  const relState = releaseState(item.released);
  const upcoming = relState === "upcoming" || relState === "today";
  const relLabel = relState === "upcoming" ? "Releases" : relState === "today" ? "Releases today" : "Released";
  const synopsis = tidyProse(item.fullReview || item.review || "");
  const url = filmPageUrl(code, item.slug);
  const ytid = ytIdOf(item.trailer);
  const cast = Array.isArray(item.cast) ? item.cast.slice(0, 6) : [];
  const providers = Array.isArray(item.providers) ? item.providers : [];
  // Title cascade lives in filmTitleTag (pure) so the frozen-archive retitler runs the
  // identical rule — see the note there for why the date wording is gated on availability.
  const V_TITLE = streamVocab(cfg);
  const titleTag = filmTitleTag(item, cfg);
  // See filmMetaDescription above for why this is no longer built inline: the same function
  // has to serve both this live render and the frozen-archive patcher, or the fix reaches
  // only the ~5% of film pages that happen to be in a current list this week.
  // Streaming-window estimates are as of the page's own date (the build passes today).
  const asOfDate = /^\d{4}-\d{2}-\d{2}/.test(asOf || "") ? new Date(`${asOf.slice(0, 10)}T00:00:00Z`) : new Date();
  const desc = filmMetaDescription(item, cfg, { now: asOfDate.getTime() });

  // ---- EMPTY-SHELL COUNTRY PAGES ------------------------------------------
  // A NON-India film page carrying no market-specific availability at all — no provider, no
  // rent/buy option, no theatrical run, no upcoming date — is a shell: same title, synopsis
  // and verdict as the India copy, with nothing a searcher in that market can act on. Sept
  // 2026 GSC: 454 country film pages drew 4,100 impressions and ZERO clicks between them,
  // while single films ran to eight indexed URLs apiece.
  // The page is still WRITTEN (hubs link to it, and it fills in the moment data lands) — it
  // just leaves the index, so the cluster's ranking sits on one URL instead of being split.
  // DELIBERATELY NARROW. Any page with a provider, a rent/buy option, a theatrical run or a
  // release date ahead of it is a real localised answer and stays indexed:
  // /sg/movie/the-rope-curse-4-kuntilanak earns Singapore clicks at position 6.7 and must
  // never be caught by this rule.
  // A RECENT RELEASE is never a shell (Oct 2026). Frozen pages don't keep the "in cinemas" flag
  // (item.platform is empty once a film leaves the lists), so every released, not-yet-streaming
  // overseas page was read as empty and noindexed — 122 pages that answer "when does it stream
  // here?", 60 of which had earned impressions (Pacific US, Victorian Psycho UK, OK Madam Bon
  // Voyage SG), and GREEN US, the page Verde (US, ~1,500 impressions) was merged into. Within
  // RECENT_RELEASE_DAYS of release the page carries a dated, local answer: the streaming window.
  const relMs = /^\d{4}-\d{2}-\d{2}/.test(item.released || "") ? Date.parse(`${item.released.slice(0, 10)}T00:00:00Z`) : NaN;
  const recentRelease = Number.isFinite(relMs) && (asOfDate.getTime() - relMs) / 864e5 <= RECENT_RELEASE_DAYS;
  const isShellPage = code !== "in" && !providers.length && !(item.rentBuy || []).length
    && item.platform !== "Theatres" && !upcoming && !recentRelease;
  const robotsTag = isShellPage
    ? `<meta name="robots" content="noindex,follow,max-image-preview:large">`
    : `<meta name="robots" content="max-image-preview:large">`;
  void synopsis;

  // hreflang alternates: the SAME film may have a page in several countries. crossCountry maps
  // code -> true for every other country whose current run also has this slug. Passed in by
  // generatePages (it knows all countries' slug sets); absent for ad-hoc/test renders.
  const alts = (item._alts && Array.isArray(item._alts)) ? item._alts : [];

  const SER = require("./series.js"); // episodes + franchise (series.js needs nothing from here)
  const ld = {
    "@context": "https://schema.org",
    "@type": item.kind === "tv" ? "TVSeries" : "Movie",
    name: item.title,
    url,
    // Google's Discover guidance asks for images at least 1200px wide; the w342 poster alone
    // never qualified. Large poster first (it is the film's canonical image), then backdrop.
    image: [item.posterPath ? img(item.posterPath, "w780") : item.poster, item.backdropPath ? img(item.backdropPath, "w1280") : null]
      .filter(Boolean).length ? [item.posterPath ? img(item.posterPath, "w780") : item.poster, item.backdropPath ? img(item.backdropPath, "w1280") : null].filter(Boolean) : undefined,
    datePublished: item.released || undefined,
    dateModified: (asOf || new Date().toISOString().slice(0, 10)),
    numberOfSeasons: item.kind === "tv" && (item.seasons || (item.episodes && item.episodes.seasons)) ? (item.seasons || item.episodes.seasons) : undefined,
    numberOfEpisodes: item.kind === "tv" && item.episodes && item.episodes.count ? item.episodes.count : undefined,
    // The episode guide as TVSeason → TVEpisode (28 Oct 2026): the title promises a schedule, so
    // the structured data carries it too — the same dated list the Episodes section shows.
    containsSeason: item.kind === "tv" ? SER.episodeSchema(item.episodes) : undefined,
    genre: item.genre || undefined,
    inLanguage: item.language || undefined,
    // A series' "director" is TMDB's created_by (lib/enrich.js): schema.org's creator, once fixed.
    director: item.director && !(item._fix30 && item.kind === "tv") ? { "@type": "Person", name: item.director } : undefined,
    creator: item.director && item._fix30 && item.kind === "tv" ? { "@type": "Person", name: item.director } : undefined,
    actor: (item.castPics && item.castPics.length)
      ? item.castPics.map((c) => ({ "@type": "Person", name: c.name, image: c.photo }))
      : cast.map((c) => ({ "@type": "Person", name: c })),
  };
  // Deliberately NO aggregateRating: Google's review-snippet guidelines require ratings in
  // structured data to be collected by THIS site. Marking up TMDB/IMDb numbers as our own is
  // the classic review-snippet manual-action trigger — and a schema penalty on the domain is
  // exactly what we can't afford heading into ad-network applications. The rating stays
  // visible and attributed in the page body; it just doesn't go in the markup.
  if (item.runtime && item.kind !== "tv") ld.duration = `PT${Math.round(item.runtime)}M`;
  if (item.cert) ld.contentRating = String(item.cert);
  // AI-era trust signals: name the source the critics' take was distilled from (verifiable
  // provenance beats assertion), and give agents an actionable target.
  if (item.takeSrc === "wiki" && item.takeArticle) {
    ld.citation = { "@type": "CreativeWork", name: `Wikipedia: ${item.takeArticle}`,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(item.takeArticle).replace(/ /g, "_"))}` };
  }
  // A WatchAction target must be where the WORK can be watched; a trailer is not the work.
  // schema.org gives trailers their own home: Movie/TVSeries.trailer. Google requires
  // uploadDate on a VideoObject: the trailer's real YouTube publish date from TMDB, else the
  // film's own date (videoUploadDate in core.js). With neither, the trailer stays on the page
  // but out of the markup — an item missing a required field is only an error in Search
  // Console. embedUrl is the privacy-friendly nocookie embed we already render; contentUrl is
  // the watch URL.
  const _upDate = tidyLd ? videoUploadDate(item.trailerDate, null) : videoUploadDate(item.trailerDate, item.freshDate || item.released);
  if (item.trailer && /youtube\.com\/watch/.test(item.trailer) && _upDate) {
    const _ytid = ytIdOf(item.trailer);
    ld.trailer = {
      "@type": "VideoObject",
      name: `${item.title} — Official Trailer`,
      description: `Official trailer for ${item.title}${item.language ? ` (${item.language})` : ""}.`,
      thumbnailUrl: _ytid ? `https://img.youtube.com/vi/${_ytid}/hqdefault.jpg` : undefined,
      uploadDate: _upDate,
      contentUrl: tidyLd ? undefined : item.trailer,   // a watch page is not the media file
      embedUrl: _ytid ? `https://www.youtube-nocookie.com/embed/${_ytid}` : undefined,
    };
  }

  // v2: a middle crumb, the edition's weekly list — a page that exists, under its own name.
  const weeklyUrl = `${homeUrl}new-on-ott/`;
  const weeklyLabel = `New on ${streamVocab(cfg).word === "OTT" ? "OTT" : "streaming"}`;
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "FilmyChill", item: homeUrl },
      ...(v2 ? [{ "@type": "ListItem", position: 2, name: weeklyLabel, item: weeklyUrl }] : []),
      { "@type": "ListItem", position: v2 ? 3 : 2, name: item.title, item: url },
    ],
  };

  // --- Enriched, deterministic sections (original content -> SEO value) ---
  const verdictProse = buildVerdictProse(item, country, localeFor(code));
  // Episodes and franchise (lib/series.js) lead "Good to know"; series FAQs follow "where to watch".
  const fmtFull = (dt) => fmtDateFull(dt, localeFor(code));
  const goodToKnow = [...SER.seriesKnowRows(item, { partialRuntimes: !!item._fix30 }), ...buildGoodToKnow(item, cfg)];
  const faqs = buildFaqs(item, country, cfg);
  faqs.splice(Math.min(2, faqs.length), 0, ...SER.episodeFaqs(item, fmtFull));
  // "More in this series": other titles of the franchise with a page Google can see here.
  const franchise = SER.franchiseSiblings(item, franchiseIndexFor(code), { visible: (s) => !require("./googlehide.js").listedHidden(code, s) });
  // On-site titles outrank off-site ones in the strip: a recommendation the reader can
  // actually open beats a dead card, and each one is a contextual internal link on a
  // page that otherwise has almost none (742 of 1,044 film pages had zero inlinks).
  // Neighbours come from the pages we actually HAVE (see filmIndexFor), not from TMDB's
  // recommendation list — those were 6 dead cards per page because TMDB recommends films
  // this site has never covered. Every entry below resolves to a real URL.
  // Pages Google can see first (lib/graph.js relatedFilms; rollout "visible-similar").
  const visOpt = inRollout(VISIBLE_SIMILAR, item.slug) ? { visible: (c) => !require("./googlehide.js").listedHidden((cfg && cfg.code) || "in", c.slug) } : {};
  const related = Array.isArray(filmIndex) && filmIndex.length ? relatedFilms(item, filmIndex, 6, visOpt) : [];
  const simAll = Array.isArray(item.similar) ? item.similar : [];
  const onSite = (s) => knownSlugs && knownSlugs.has(s.slug);
  const inFranchise = new Set(franchise ? franchise.items.map((x) => x.slug) : []);
  const similar = (related.length >= 3 ? related
    : [...simAll.filter(onSite), ...simAll.filter((s) => !onSite(s))].slice(0, 6)).filter((s) => !inFranchise.has(s.slug));
  const linkable = related.length >= 3 ? () => true : onSite;

  // FAQPage schema — only when we have at least 2 Q&As (Google wants a real list).
  const faqLd = faqs.length >= 2 && !tidyLd ? {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  } : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(titleTag)}</title>
<meta name="description" content="${e(desc)}">
${ICON_LINKS}${v2 ? `\n<link rel="manifest" href="/manifest.json">\n<meta name="theme-color" content="${V2.DEEP}">` : ""}${posterFirst(item, lean)}
${robotsTag}
<link rel="canonical" href="${e(url)}">${alts.length ? "\n" + alts.map((a) => `<link rel="alternate" hreflang="${a.code === "in" ? "en-IN" : "en-" + a.region}" href="${e(filmPageUrl(a.code, item.slug))}"/>`).join("\n") + `\n<link rel="alternate" hreflang="x-default" href="${e(filmPageUrl(xDefaultCode(alts.map((a) => a.code)), item.slug))}"/>` : ""}
<meta property="og:title" content="${e(item.title)}${year ? " (" + year + ")" : ""} — FilmyChill verdict">
<meta property="og:description" content="${e(desc)}">
<meta property="og:type" content="${item.kind === "tv" ? "video.tv_show" : "video.movie"}">
<meta property="og:url" content="${e(url)}">
<meta property="og:locale" content="${cfg && cfg.code === "in" ? "en_IN" : "en_" + (((cfg || {}).region) || String((cfg || {}).code || "IN").toUpperCase())}">
${(() => {
  const src = socialImage(item, cfg);
  if (!src) return "";
  const isCard = /\/cards\//.test(src);
  const dims = isCard ? '\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">'
    : item.backdropPath ? '\n<meta property="og:image:width" content="1280">\n<meta property="og:image:height" content="720">' : "";
  const alt = isCard ? `\n<meta property="og:image:alt" content="${e(`${item.title} — FilmyChill verdict${(item.fcScore && item.fcScore.verdict) || item.verdict ? `: ${(item.fcScore && item.fcScore.verdict) || item.verdict}` : ""}`)}">` : "";
  return `<meta property="og:image" content="${e(src)}">${dims}${alt}`;
})()}
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="Content-Security-Policy" content="${cspWith(`default-src 'self'; connect-src 'self' ${VOTE_CONNECT.join(" ")}; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' https://image.tmdb.org${item._fix30 && ytid ? " https://img.youtube.com" : ""} data:; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'`)}">${analyticsTag()}
<script type="application/ld+json">${ldJson(ld)}</script>${tidyLd ? "" : `
<script type="application/ld+json">${ldJson(breadcrumb)}</script>`}${faqLd ? `
<script type="application/ld+json">${ldJson(faqLd)}</script>` : ""}
${v2 ? `<script src="/js/film.js" defer></script>\n` : ""}<style>
${(() => { const base = `  :root { --indigo:#4038C7; --marigold:#FFAD1F; --cream:#FFF7EC; --ink:#1A1633; --mute:#6B6890; --line:#E4E1F5; }
  * { box-sizing:border-box; } body { font-family:-apple-system,'Segoe UI',Roboto,sans-serif; background:#F7F5FF; color:var(--ink); margin:0; }
  .top { background:var(--indigo); padding:14px 16px; } .top a { color:var(--cream); text-decoration:none; font-weight:800; letter-spacing:1px; font-size:18px; }
  .top a span { color:#FFC04D; } /* 4.95:1 on indigo; marigold is 4.3:1 */
  .wrap { max-width:680px; margin:0 auto; padding:20px 16px 40px; }
  .head { display:grid; grid-template-columns:140px 1fr; gap:16px; }
  .poster { width:140px; height:auto; aspect-ratio:2/3; object-fit:cover; border-radius:12px; display:block; }
  h1 { font-size:24px; margin:0 0 6px; } .meta { color:var(--mute); font-size:14px; margin-bottom:10px; }
  .rating { color:var(--indigo); font-weight:800; font-size:18px; display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
  .cdot { width:9px; height:9px; border-radius:50%; flex-shrink:0; }
  .ctag { font-size:11px; font-weight:700; letter-spacing:.3px; text-transform:uppercase; padding:2px 8px; border-radius:10px; }
  .cvotes { color:var(--mute); font-weight:400; font-size:13px; }
  .cbar { flex-basis:100%; height:4px; background:#EEE9DC; border-radius:2px; overflow:hidden; margin-top:2px; }
  .cbar i { display:block; height:100%; border-radius:2px; }
  .rating-solid .cdot, .rating-solid .cbar i { background:#2E9E5B; } .rating-solid .ctag { background:rgba(46,158,91,.13); color:#237A45; }
  .rating-early .cdot, .rating-early .cbar i { background:#E39A1C; } .rating-early .ctag { background:rgba(227,154,28,.15); color:#B87910; }
  .rating-few { color:var(--mute); font-weight:600; font-size:15px; } .rating-few .cdot, .rating-few .cbar i { background:#C4BEDA; } .rating-few .ctag { display:none; }
  .verdict { display:inline-block; background:rgba(64,56,199,.08); color:var(--indigo); font-weight:700; font-size:13px; padding:6px 14px; border-radius:999px; margin-top:8px; }
${FCSB_CSS}
  .fit { margin:18px 0 4px; border-left:3px solid var(--indigo); padding:2px 0 2px 16px; }
  .fit dl { margin:0; }
  .fit dt { font-weight:700; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--indigo); margin-top:12px; }
  .fit dt:first-child { margin-top:0; }
  .fit dd { margin:3px 0 0; font-size:15px; line-height:1.5; }
  .fit dt.skip { color:#9a3412; }
  h2 { font-size:16px; margin:24px 0 8px; } p { line-height:1.65; font-size:15px; margin:0; }
  .pill { display:inline-block; background:#fff; border:1px solid var(--line); border-radius:999px; padding:6px 12px; font-size:13px; margin:0 6px 6px 0; }
  .frame { position:relative; padding-top:56.25%; border-radius:12px; overflow:hidden; background:#000; margin-top:8px; }
  .frame iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
  .btn { display:inline-flex; align-items:center; min-height:44px; box-sizing:border-box; background:var(--indigo); color:#fff; font-weight:700; font-size:14px; padding:11px 20px; border-radius:10px; text-decoration:none; margin-top:20px; }
  footer { color:var(--mute); font-size:12px; text-align:center; padding:24px 16px; line-height:1.7; }
  .vprose { font-size:15px; line-height:1.7; margin-top:8px; }
  .answer { font-size:16px; line-height:1.6; margin:14px 0 6px; padding:12px 14px; background:#fff;
            border:1px solid #E7DFD0; border-left:3px solid var(--indigo); border-radius:0 8px 8px 0; }
  .fcdata { font-size:14px; line-height:1.6; margin-top:10px; padding:10px 12px; border-radius:8px;
            background:rgba(64,56,199,.07); border-left:3px solid var(--indigo); }
  /* Fit line: same weight as body copy, warm card so it reads as the site's own voice
     rather than another metadata row. */
  .whywatch { font-size:15px; line-height:1.7; background:var(--bg); border-left:3px solid var(--marigold);
              padding:12px 14px; border-radius:0 10px 10px 0; margin-top:8px; }
  /* Skip block: deliberately quieter than the fit line — muted rule, no fill, smaller type.
     It is the counterweight to everything above it, not a warning banner. Shouting would
     make it read as a content advisory; it is a preference mismatch, which is calmer. */
  .skipif { margin-top:14px; padding:12px 14px; border-left:3px solid var(--mute);
            border-radius:0 10px 10px 0; background:rgba(0,0,0,.02); }
  .skipif h3 { font-size:13px; letter-spacing:.02em; text-transform:uppercase; color:var(--mute);
               margin:0 0 8px; font-weight:700; }
  .skipif ul { margin:0; padding-left:18px; }
  .skipif li { font-size:14.5px; line-height:1.65; margin:4px 0; }
  .take { font-size:14.5px; font-weight:600; color:var(--indigo); line-height:1.6; margin-top:10px; }
  .tsrc { color:var(--mute); font-weight:400; font-size:12px; }
  .hook { font-size:13.5px; color:var(--mute); font-style:italic; margin-top:8px; }
  .cast-strip { display:flex; gap:14px; overflow-x:auto; padding:4px 0 8px; }
  .cast-card { flex:0 0 84px; text-align:center; }
  .cast-card img { width:72px; height:72px; border-radius:50%; object-fit:cover; background:var(--line); display:block; margin:0 auto; }
  .cast-name { font-size:12px; font-weight:700; margin-top:6px; line-height:1.3; }
  .cast-role { font-size:11px; color:var(--mute); line-height:1.3; margin-top:1px; }
  .tcounter { color:var(--marigold-dk, #A66B00); font-weight:700; }
  .gtk { width:100%; border-collapse:collapse; margin-top:8px; }
  .gtk td { padding:9px 0; border-top:1px solid var(--line); font-size:14px; vertical-align:top; }
  .gtk td:first-child { color:var(--mute); width:46%; }
  .gtk td:last-child { font-weight:600; text-align:right; }
  .epnext { background:var(--cream, #FFF7EC); border-left:4px solid var(--marigold, #FFAD1F); padding:8px 12px; border-radius:6px; font-size:14px; }
  .eptable { overflow-x:auto; margin-top:8px; }
  .eptable table { width:100%; border-collapse:collapse; font-size:13.5px; }
  .eptable th { text-align:left; color:var(--mute); font-weight:600; font-size:12px; padding:6px 8px 6px 0; border-bottom:1px solid var(--line); }
  .eptable td { padding:8px 8px 8px 0; border-bottom:1px solid var(--line); vertical-align:top; }
  .eptable td:first-child { color:var(--mute); width:28px; }
  .eptable tr.soon td { color:var(--mute); }
  .epnote { color:var(--mute); font-size:12px; margin-top:6px; }
  .simgrid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-top:8px; }
  .simcard { display:block; background:#fff; border:1px solid var(--line); border-radius:10px; overflow:hidden; text-decoration:none; color:var(--ink); }
  .simcard img { width:100%; aspect-ratio:2/3; object-fit:cover; display:block; background:var(--line); }
  .simcard .st { font-size:12.5px; font-weight:700; padding:8px 8px 2px; line-height:1.25; }
  .simcard .sm { font-size:11px; color:var(--mute); padding:0 8px 8px; }
  .faq { margin-top:8px; }
  .faq details { border-top:1px solid var(--line); padding:10px 0; }
  .faq summary { font-size:14.5px; font-weight:700; cursor:pointer; list-style:none; min-height:44px; display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .faq summary::-webkit-details-marker { display:none; }
  .faq summary::after { content:"+"; float:right; color:var(--indigo); font-weight:700; }
  .faq details[open] summary::after { content:"–"; }
  .faq .fa { font-size:14px; line-height:1.6; color:var(--mute); margin-top:8px; }
  @media (max-width:420px){ .head { grid-template-columns:110px 1fr; } .poster { width:110px; } h1 { font-size:20px; } }
${REDESIGN_CSS}`; return v3 ? V2.v3Css(base) : v2 ? V2.v2Css(base) : base; })()}
</style>
</head>
<body>
${v3 ? V2.v3Header(homeUrl, country) : v2 ? V2.v2Header(homeUrl, country) : `<div class="top"><a href="${e(homeUrl)}">FILMY<span>CHILL</span></a></div>`}
<div class="wrap">${lean ? LEAN_MARK + audienceMark(item) : ""}${v2 ? V2.V2_MARK : ""}${SER.seriesMark(item)}
  ${v3 ? `<div class="bd"${/^https:\/\/image\.tmdb\.org\//.test(String(item.backdrop || "")) ? ` style="background-image:url('${e(item.backdrop)}')"` : ""}></div>` : ""}
  ${lean && !v3 ? `<div class="hero"${/^https:\/\/image\.tmdb\.org\//.test(String(item.backdrop || "")) ? ` style="background-image:${v2 ? V2.HERO_GRADIENT : "linear-gradient(rgba(27,22,95,.84),rgba(27,22,95,.94))"},url('${e(item.backdrop)}')"` : ""}>` : ""}${v2 && !v3 ? "\n  " + V2.v2Crumbs(item, { homeUrl, weeklyUrl, weeklyLabel }) : ""}
  <div class="head${v3 ? " v3" : ""}">
    ${item.poster && !v3 ? `<img class="poster" src="${e(item.poster)}" alt="${e(item.title)} poster" width="${v2 ? 104 : 140}" height="${v2 ? 156 : 210}"${lean ? ' fetchpriority="high"' : ""}>` : v3 ? "" : "<div></div>"}
    <div>${v3 ? V2.v3Tag(item) : ""}
      <h1>${e(item.title)}${year ? ` (${year})` : ""}</h1>
      <div class="meta">${v3 ? V2.v3Meta(item, { fmt: (d) => fmtDateFull(d, localeFor(code)), airLabel: !!item._fix30 }) : v2 ? V2.v2Meta(item, year) : (lean
        ? [item.language, item.genre, item.runtime ? (item.kind === "tv" ? `${item.runtime} min episodes` : item.runtime + " min") : null]
        : [item.language, item.genre, item.runtime ? item.runtime + " min" : null, item.cert]).filter(Boolean).map(e).join(" · ")}</div>
      ${lean ? "" : headRatingHtml(item)}${v3 ? "\n      " + V2.v3Where(item, { relState, country, V: V_TITLE, asOf, fmt: (d) => fmtDateFull(d, localeFor(code)) }) : v2 ? "\n      " + V2.v2ScorePill(item) : ""}
      ${item.released && !v2 ? `<div class="meta" style="margin-top:8px">${relState === "today" ? relLabel : `${relLabel} ${e(fmtDateFull(item.released, localeFor(code)))}`}</div>` : ""}
      ${asOf ? `<div class="meta" style="margin-top:2px;font-size:12.5px"${v2 && !tidyLd ? ' hidden' : ""}>Page updated ${e(fmtDateFull(asOf, localeFor(code)))}</div>` : ""}
    </div>
  </div>${lean && !v3 ? "\n  </div>" : ""}
  ${v2 && !v3 ? V2.v2Cta(item, { cfg, country, asOf, relState, V: V_TITLE }) : ""}
  ${v3 ? `${fcScoreSection(item)}\n  ${voteWidgetHtml(item, code)}` : (() => { const answerBlock = (() => {
    // Lead answer line. The GSC data showed pages ranking on page 1 for "where to watch [film]"
    // and "[film] ott release date" but pulling <1% CTR, and answer engines had nothing at the
    // top to lift. This puts the direct answer FIRST, in one snippet-shaped sentence, before the
    // review prose. Facts only — mirrors the FAQ, never invents a date or platform.
    const provs = (item.providers || []).map(String);
    const st = releaseState(item.released);
    let ans;
    if (st === "upcoming") {
      ans = item.released
        ? `<b>${e(item.title)}</b> releases in ${e(country)} on ${e(fmtDateShort(item.released, Date.now(), localeFor(code)))} ${e(String(item.released).slice(0,4))}. ${V_TITLE.article} ${e(V_TITLE.release)} date will be listed here as soon as it's announced.`
        : `<b>${e(item.title)}</b> hasn't released yet in ${e(country)}. This page updates with the ${e(V_TITLE.release)} date the day it's announced.`;
    } else if (provs.length) {
      ans = `<b>${e(item.title)}</b> is streaming in ${e(country)} on ${e(provs.slice(0,3).join(", "))}${(item.rentBuy||[]).length && !provs.length ? "" : ""}.`;
    } else if ((item.rentBuy || []).length) {
      ans = `<b>${e(item.title)}</b> is available to rent or buy in ${e(country)} on ${e(item.rentBuy.slice(0,3).map(String).join(", "))}. No subscription carries it yet.`;
    } else if (item.platform === "Theatres") {
      ans = `<b>${e(item.title)}</b> is in cinemas in ${e(country)} now. Its ${e(V_TITLE.release)} date hasn't been announced — this page updates the day it lands on streaming.`;
    } else {
      ans = `Where to watch <b>${e(item.title)}</b> in ${e(country)} isn't confirmed yet — this page updates the moment a platform lists it.`;
    }
    // Lean: how it's available, in one line under the answer (subscription vs rent/buy).
    const rent = (item.rentBuy || []).map(String).filter((x) => !provs.includes(x));
    const how = lean && provs.length
      ? `\n  <p class="ansub" style="margin:-2px 0 10px;padding:0 14px;font-size:13px;line-height:1.5;color:var(--mute)">Included with subscription${rent.length ? ` · Rent or buy: ${e(rent.slice(0, 3).join(", "))}` : ""}</p>` : "";
    // Lean (the 27 Oct 2026 redesign): the answer is a card over the hero, with the next
    // episode of a series on air under it. The answer's own markup is unchanged inside.
    if (!lean) return `<p class="answer">${ans}</p>${how}`;
    // Every episode of the next drop, with its date (never "today": the page is read for days).
    const nd = item.kind === "tv" && item.episodes ? SER.nextDrop(item.episodes) : null;
    const nextEp = nd
      ? `\n  <p class="nextep"><b>Next:</b> ${nd.label}${nd.name ? ` “${e(nd.name)}”` : ""} · out ${e(fmtDateFull(nd.date, localeFor(code)))}</p>` : "";
    return `<div class="anscard"><p class="answer">${ans}</p>${how}${nextEp}</div>`;
  })();
    // Lean: the answer leads, then the score. Otherwise orderAnswer decides (below a full card).
    return lean
      ? `${answerBlock}\n  ${fcScoreSection(item)}\n  ${voteWidgetHtml(item, code)}`
      : orderAnswer(`${fcScoreSection(item)}\n  ${voteWidgetHtml(item, code)}\n  ${answerBlock}`);
  })()}
  ${v3 ? "" : (lean ? leanText(verdictProse) : verdictProse) ? `<h2>What the audience says</h2><p class="vprose">${e(lean ? leanText(verdictProse) : verdictProse)}</p>` : ""}
  ${!v3 && item.hook ? `<p class="hook">${e(item.hook)}</p>` : ""}
  ${!v3 && item.take && lean ? `<h2>What the critics say</h2>` : ""}
  ${!v3 && item.take ? `<p class="take">${e(item.take)}${item.takeCounter ? ` <span class="tcounter">${e(item.takeCounter)}</span>` : ""}${item.takeSrc === "wiki" ? ` <span class="tsrc">— distilled from critics' published reviews</span>` : ""}</p>` : ""}
  ${v3 ? `${synopsis ? `<h2>Story</h2><p>${e(synopsis)}</p>` : ""}${item.director ? `<p class="dir"><b>${item._fix30 && item.kind === "tv" ? "Creator" : "Director"}:</b> ${e(item.director)}</p>` : ""}` : ""}
  ${(() => {
    // The one fact on this page no competitor can reproduce: measured from our own archive
    // (lib/history.js), not from any API. TMDB stores no history of provider changes.
    // Films that opened in cinemas HERE only, seen arriving while we were watching
    // (cinemaWindowDays). Until Oct 2026 TV series and streaming originals got a "theatrical
    // release" window they never had — 704 pages, anime series among them.
    const rec = FILM_HISTORY.get(`${code}:${item.kind === "tv" ? "tv" : "movie"}:${item.tmdbId}`);
    const days = rec ? cinemaWindowDays(rec, FILM_HISTORY.starts()) : null;
    if (days == null || v3) return "";   // v3: a "Good to know" row instead (below)
    return `<p class="fcdata"><b>FilmyChill data:</b> reached streaming in ${e(country)} `
      + `${fcdataWindowPhrase(days)}${rec.p ? `, on ${e(rec.p)}` : ""}.</p>`;
  })()}
  ${v3 ? "" : (() => {
    // Fit line (see whyWatch). Sits after the reception blocks and before the synopsis:
    // by this point the reader knows if it's good — this answers whether it's for them.
    const ww = whyWatch(item);
    if (!ww) return "";
    if (!lean) return `<h2>${e(ww.heading)}</h2><p class="whywatch">${e(ww.text)}</p>`;
    // Lean: the runtime is in the header line, so neither the heading ("Should you spend 1h 45m
    // on it?") nor the text repeats it, the rating or the platform.
    const text = leanText(ww.text);
    if (!text) return "";
    const heading = /\d+\s?(?:h|m|min)\b/.test(ww.heading) ? "Is it for you?" : ww.heading;
    return `<h2>${e(heading)}</h2><p class="whywatch">${e(text)}</p>`;
  })()}
  ${v3 ? "" : (() => {
    // Skip block (see lib/skipif.js). Sits immediately after the fit line, because the two
    // are one argument: here is who this is for, and here is who it is not for. Every other
    // block on this page argues for watching; a page that never says "not you" is a page a
    // reader learns to discount. Returns null on most films, and that is intended.
    const skip = skipIf(item);
    if (!skip) return "";
    // Lean: one "not for you if" list — the house format's "Skip if" row says it when present.
    const wfSkip = lean ? watchFit(item) : null;
    if (wfSkip && wfSkip.skipIf) return "";
    if (lean) { const kept = skip.filter((r) => !RESTATES.test(r) && !/number you can lean on/i.test(r)); if (!kept.length) return ""; skip.length = 0; skip.push(...kept); }
    return `<div class="skipif"><h3>Don't watch this if\u2026</h3><ul>`
      + skip.map((r) => `<li>${e(r)}</li>`).join("")
      + `</ul></div>`;
  })()}
  ${v3 ? "" : (() => {
    // The scannable house format (lib/watchfit.js): same three rows, same order, on every
    // page that qualifies. Sits directly under the fit prose because it is the same
    // question compressed — a reader who skims takes this and leaves, which is the point.
    // Gated inside watchFit(): returns null on thin signal rather than inventing rows.
    // Rows from the title's own data replace the genre-shaped ones where there is data (27 Oct
    // 2026 review: "an episode-a-night rhythm" would fit any series): a series' release cadence,
    // and what to watch first from its franchise (lib/series.js fitFromData).
    const fd = SER.fitFromData(item, franchise, fmtFull);
    const wf = watchFit(item) || (fd ? {} : null);
    if (!wf) return "";
    const bestFor = fd && fd.bestFor ? fd.bestFor : wf.bestFor;
    const skipIf = fd && fd.bestFor ? fd.skipIf : wf.skipIf;
    const rows = [
      // Lean: a "Why" that only restates the rating ("7.2/10 from 550 ratings…") goes.
      wf.why && !(lean && RESTATES.test(wf.why)) ? `<dt>Why</dt><dd>${e(wf.why)}</dd>` : "",
      // Each with its year and, where its page lists one, the platform it streams on here.
      fd && fd.watchFirst.length ? `<dt>Watch first</dt><dd>${fd.watchFirst.map((x) => `<a href="${e(filmPagePath(code, x.slug))}">${e(x.title)}</a>${x.released ? ` (${e(String(x.released).slice(0, 4))})` : ""}${(x.platforms || []).length ? `, on ${e(x.platforms[0])}` : ""}`).join("; ")}</dd>` : "",
      skipIf ? `<dt class="skip">Skip if</dt><dd>${e(skipIf)}</dd>` : "",
      bestFor ? `<dt>Best for</dt><dd>${e(cap(bestFor))}</dd>` : "",
      fd && fd.bingeFrom ? `<dt>Binge it</dt><dd>From ${e(fd.bingeFrom)}</dd>` : "",
    ].join("");
    return rows ? `<div class="fit"><dl>${rows}</dl></div>` : "";
  })()}
  ${synopsis && !lean ? `<h2>Story</h2><p>${e(synopsis)}</p>` : ""}
  ${v3 ? "" : (() => {
    // Lean: rows the header line already gives (runtime, genre, language) are left out.
    const rows = lean ? goodToKnow.filter((r) => !/^(Runtime|Genre|Language)$/.test(r.label)) : goodToKnow;
    return rows.length ? `<h2>Good to know</h2><table class="gtk">${rows.map((row) => `<tr><td>${e(row.label)}</td><td>${e(row.value)}</td></tr>`).join("")}</table>` : "";
  })()}
  ${!v3 && item.director ? `<h2>${item._fix30 && item.kind === "tv" ? "Creator" : "Director"}</h2><p>${e(item.director)}</p>` : ""}
  ${(item.castPics && item.castPics.length) ? `<h2>Cast</h2><div class="cast-strip">${item.castPics.map((c) => {
    // A name links to its people page when one exists (5+ films here) — see writePeoplePages — and
    // Google can see it. Every people page is hidden from Google (lib/googlehide.js, 25 Oct 2026),
    // so names are plain text: 3,036 links on visible pages led only to hidden ones (27 Oct audit).
    const ps = slugify(c.name || "");
    const nm = ps && fs.existsSync(personPagePath(code, ps)) && !require("./googlehide.js").pathHidden(personPagePath(code, ps)) ? `<a href="/${e(PEOPLE_BASE(code))}/${e(ps)}/">${e(c.name)}</a>` : e(c.name);
    return `<div class="cast-card"><img src="${e(c.photo)}" alt="${e(c.name)}" width="72" height="72" loading="lazy"><div class="cast-name">${nm}</div>${c.character ? `<div class="cast-role">${e(c.character)}</div>` : ""}</div>`;
  }).join("")}</div>`
    : cast.length ? `<h2>Cast</h2><div>${cast.map((c) => `<span class="pill">${e(c)}</span>`).join("")}</div>` : ""}
  ${synopsis && lean && !v3 ? `<h2>Story</h2><p>${e(synopsis)}</p>` : ""}
  ${(() => {
    // ---- "When is X coming to streaming/OTT?" ----------------------------------
    // The single highest-intent question on a theatrical film page, and the one the
    // page previously answered only inside a collapsed FAQ. Rendered as a real
    // section, above Where-to-watch, because it is why these visitors arrived.
    // Shown only for films with NO streaming provider — once real data exists the
    // Where-to-watch block below is the better answer and this disappears on the
    // next build. Never invents a date: an estimate is always a labelled range.
    // A departure (lib/factsq.js state "gone"): the block the departure notice fills on every
    // render (lib/migrate.js renderFrozen) — series and films alike, platform or not. Without
    // it the notice had nowhere to go and the next render erased it (Oct 2026 audit).
    if (item.state === "gone" && !providers.length) return "<!--SW:pending--><!--/SW:pending-->";
    if (item.kind === "tv" || providers.length) return "";
    if (item.platform !== "Theatres" && !upcoming) return "";
    const V = streamVocab(cfg);
    if (upcoming) {
      // The due date is stamped into the marker so refreshDuePages() can find this block on a
      // FROZEN page once the date passes and rewrite it — without an API call and without
      // re-rendering the page's earned prose. Without that, a page archived while the film was
      // still upcoming would claim "hasn't had its theatrical release yet" forever.
      const due = item.released ? String(item.released).slice(0, 10) : "";
      const opens = relState === "today"
        ? `${e(item.title)} opens in theatres in ${e(country)} today.`
        : `${e(item.title)} hasn't had its theatrical release yet${due ? `, and is due ${e(fmtDateFull(due, localeFor(code)))}` : ""}.`;
      // The usual window, labelled as an estimate: people search "<film> OTT release date"
      // before it opens (Street Fighter, Oct 2026: 1,272 such impressions on a page that only
      // gave the cinema date). The description quotes the same window, so the page backs it.
      const est = item.platform === "Theatres" ? streamWindowEstimate(item.released, item.language, asOfDate) : null;
      const usual = est && !est.passed
        ? ` ${e(hasLanguageWindow(item.language) ? `${item.language} releases` : "Releases like this")} usually reach ${V.word === "OTT" ? "OTT" : "streaming"} ${est.lo}–${est.hi} weeks after opening, which would put it around <strong>${e(est.span)}</strong> — an estimate, not a confirmed date.`
        : "";
      return `<!--SW:pending--><!--SW:due=${e(due)}--><h2>${e(V.heading(item.title))}</h2><p>${opens} ${e(V.article)} ${e(V.releaseDate)} won't be set until after it opens — this page updates automatically the day it starts streaming.${usual}</p><!--/SW:pending-->`;
    }
    if (digitalUpcoming(item)) {
      const on = item.digitalNote ? ` on ${e(item.digitalNote)}` : "";
      return `<!--SW:pending--><!--SW:digital=${e(item.digitalDate)}|${e(item.digitalNote || "")}--><h2>${e(V.heading(item.title))}</h2>`
        + `<p><strong>Streaming from ${e(fmtDateFull(item.digitalDate, localeFor(code)))}${on}.</strong> ${e(digitalAnnounceText(item.title, item.digitalDate, item.digitalNote, country, cfg))} This page switches to \u201cstreaming now\u201d the day it lands.</p><!--/SW:pending-->`;
    }
    if (digitalPassed(item)) return digitalPassedBlock(item.title, item.digitalDate, item.digitalNote, country, cfg);
    const est = streamWindowEstimate(item.released, item.language, asOfDate);
    const body = est && !est.passed
      ? `<p>Not streaming yet — ${e(item.title)} is in its theatrical run in ${e(country)}${item.released ? `, released ${e(item.released)}` : ""}. ${e(item.language || "Films like this")} releases typically reach streaming about ${est.lo}–${est.hi} weeks after opening, which would put it somewhere around <strong>${e(est.span)}</strong>.</p><p style="color:var(--mute);font-size:13px">That's the usual pattern, not a confirmed date — no platform has announced one. We re-check every day and this page updates the moment it lands.</p>`
      : `<p>Not streaming yet in ${e(country)}${item.released ? ` — ${e(item.title)} released in theatres ${e(item.released)}` : ""}. No platform has announced ${e(V.article.toLowerCase())} ${e(V.releaseDate)}. We re-check every day and this page updates the moment it lands.</p>`;
    return `<!--SW:pending--><h2>${e(V.heading(item.title))}</h2>${body}<!--/SW:pending-->`;
  })()}
  ${epFirst ? SER.episodesHtml(item, fmtFull, undefined, { v2 }) : ""}
  ${((wtw) => {
    // v3: the where-to-watch block lives under the title (v3Where in lib/pagev2.js, which carries
    // everything this one carried); here only "Good to know" is drawn, in its place before Episodes.
    if (v3) {
      void wtw;
      const rows = goodToKnow.filter((r) => !/^(Runtime|Genre|Language)$/.test(r.label)).map((row) => `<tr><td>${e(row.label)}</td><td>${e(row.value)}</td></tr>`);
      // The site's own measurement (lib/history.js): how long after cinemas the film reached
      // streaming here — the one fact no competitor can publish, as a row where facts are read.
      const rec = FILM_HISTORY.get(`${code}:${item.kind === "tv" ? "tv" : "movie"}:${item.tmdbId}`);
      const days = rec ? cinemaWindowDays(rec, FILM_HISTORY.starts()) : null;
      if (days != null) rows.unshift(`<tr><td>OTT arrival</td><td>${e(fcdataWindowPhrase(days))}${rec.p ? `, on ${e(rec.p)}` : ""} (FilmyChill data)</td></tr>`);
      // The platform's own pages (crawl paths from every film back to the lists), as a row.
      const links = filmHubLinks(item, cfg).replace(/^<p[^>]*>More: /, "").replace(/<\/p>$/, "");
      if (links && providers.length) rows.push(`<tr><td>More on ${e(canonProvider(providers[0]))}</td><td>${links}</td></tr>`);
      return rows.length ? `<h2>Good to know</h2><table class="gtk">${rows.join("")}</table>` : "";
    }
    return v2 && wtw ? `<div class="wtw" id="where-to-watch">${wtw}</div>` : wtw;
  })((() => {
    // Three honest states: streaming (included with a subscription — no extra charge),
    // rent/buy (pay per title), and theatres-only. The subscription-vs-rent distinction
    // is the most common unanswered question on OTT listings; TMDB's monetization split
    // (flatrate vs rent/buy) answers it for free from data we already fetch.
    const rb = Array.isArray(item.rentBuy) ? item.rentBuy : [];
    const rbRow = rb.length ? `<div style="margin-top:10px"><div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin-bottom:5px">Rent or buy</div><div>${rb.map((p) => `<span class="pill">${e(p)}</span>`).join("")}</div></div>` : "";
    const note = `<p style="color:var(--mute);font-size:12px;margin-top:6px">Availability as of ${asOf ? e(fmtDateFull(asOf, localeFor(code))) : ""} — platforms may change over time.</p>`;
    // Wrapped in SW:stream + SW:live so the departure sweep can find and rewrite it. Pages
    // born streaming (the whole catalogue) used to carry no marker at all, so no sweep could
    // ever touch their "you can stream it on…" claim — permanent, unchecked availability.
    // "Streaming on Netflix since 16 Oct": only a verified arrival (lib/lifecycle.js arrivalDate),
    // never a first-seen date. Named for the platform it arrived on while that one still lists
    // it; the marker carries the date through every later render.
    const arrivedLine = item.arrived && providers.length
      ? `<!--SW:arrived=${e(item.arrived)}|${e(item.arrivedOn || providers[0])}--><p class="arrived" style="font-size:13.5px;margin-top:8px"><b>Streaming ${providers.includes(item.arrivedOn) ? `on ${e(item.arrivedOn)} ` : ""}in ${e(country)} since ${e(fmtDateFull(item.arrived, localeFor(code)))}.</b></p>`
      : "";
    if (providers.length) return `<!--SW:stream--><!--SW:live=${e(asOf || "")}--><h2>Where to watch in ${e(country)}</h2><div>${providers.map((p) => `<span class="pill">${e(p)}</span>`).join("")}</div>${arrivedLine}<p style="color:var(--mute);font-size:12.5px;margin-top:6px">Included with a subscription — no extra charge on these platforms.</p>${rbRow}${note}${filmHubLinks(item, cfg)}<!--/SW:stream-->`;
    // Not streaming yet: the date says when that was last checked, not just "as of".
    // A film we can't look up (no TMDB match, or an id TMDB no longer has) is never rechecked:
    // "checked that day" under a date weeks old read as current (Pulavar, Oct 2026 audit).
    const checkedNote = item.untracked
      ? `<p style="color:var(--mute);font-size:12px;margin-top:6px">Availability as of ${asOf ? e(fmtDateFull(asOf, localeFor(code))) : ""} — the last time we could check. We can't match this film on TMDB, so this page won't update on its own.</p>`
      : `<p style="color:var(--mute);font-size:12px;margin-top:6px">Availability as of ${asOf ? e(fmtDateFull(asOf, localeFor(code))) : ""} — checked that day: not on any streaming service in ${e(country)} yet.</p>`;
    if (item.platform === "Theatres") return `<h2>Where to watch in ${e(country)}</h2><div><span class="pill">In theatres</span></div>${rb.length ? rbRow + `<p style="color:var(--mute);font-size:12.5px;margin-top:6px">Not on any streaming subscription yet — renting is the only way to watch it at home for now.</p>${note}` : checkedNote}`;
    if (rb.length) return `<h2>Where to watch in ${e(country)}</h2>${rbRow}<p style="color:var(--mute);font-size:12.5px;margin-top:6px">Not on any streaming subscription yet — renting is the only way to watch it at home for now.</p>${note}`;
    // Unreleased film: previously this block rendered nothing at all, so the page answered
    // "where to watch" with silence. State it plainly instead.
    if (upcoming && item.released) {
      const when = relState === "today" ? "today" : fmtDateFull(item.released, localeFor(code));
      return `<h2>Where to watch in ${e(country)}</h2><div><span class="pill">${relState === "today" ? "In cinemas today" : `In cinemas from ${e(when)}`}</span></div><p style="color:var(--mute);font-size:12.5px;margin-top:6px">Not out yet — nowhere to stream or rent it until it opens.</p>`;
    }
    return "";
  })())}
  ${epFirst ? "" : SER.episodesHtml(item, fmtFull, undefined, { v2 })}
  ${ytid ? (v2 ? V2.v2Trailer(ytid, item.title) : `<h2>Trailer</h2><div class="frame"><iframe loading="lazy" src="https://www.youtube-nocookie.com/embed/${e(ytid)}?rel=0" title="${e(item.title)} trailer" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe></div><p class="tlink"><a href="https://www.youtube.com/watch?v=${e(ytid)}" rel="noopener">Watch the trailer on YouTube →</a></p>`) : item.trailer ? `<h2>Trailer</h2><p><a href="${e(item.trailer)}" rel="noopener">Find the trailer on YouTube →</a></p>` : ""}
  ${franchise ? franchiseRowHtml(franchise, item, code) : ""}
  ${simGridHtml(similar, code, linkable)}
  ${faqs.length ? `<h2>Frequently asked</h2><div class="faq">${faqs.map((f) => `<details><summary>${e(f.q)}</summary><div class="fa">${e(f.a)}</div></details>`).join("")}</div>` : ""}
  ${(() => {
    // The film's language page, from the page body rather than only the footer menu
    // (Oct 2026 GSC: language pages averaged position 48.5, film pages 13.3). India only, where
    // those pages live; written only when the page exists, so it never leads to a 404.
    const lp = code === "in" && LANGUAGE_PAGES.find(([n]) => n === item.language);
    return lp && fs.existsSync(`${lp[1]}/index.html`) ? `<a class="btn" href="/${e(lp[1])}/">New ${e(lp[0])} movies &amp; OTT this week →</a>` : "";
  })()}
  <a class="btn" href="${e(homeUrl)}#${e(item.slug)}">See this week's top picks on FilmyChill →</a>
</div>${v2 && !v3 && !upcoming ? "\n" + V2.v2Sticky(item, providers.map(String)) : ""}
<footer>
  <nav><a href="${e(homeUrl)}">This week in ${e(country)}</a> · <a href="${code === "in" ? "/new-on-ott/" : `/${e(code)}/new-on-ott/`}">New on ${e(streamVocab(cfg).word === "OTT" ? "OTT" : "streaming")}</a>${code === "in" ? ` · ${LANGUAGE_PAGES.map(([n, s]) => `<a href="/${s}/">${n}</a>`).join(" · ")}` : ""} · <a href="/about/">About</a></nav>
  Verdicts are compiled by FilmyChill's ${item._fix30 ? "automated system" : "editorial system"} from audience ratings and published critic reception — <a href="/about/">how we rate</a>.<br>
  ${(() => {
    // The CC BY-SA credit links the film's own article when the page knows it (30 Oct 2026).
    const article = item._fix30 && (item.takeArticle || (item.reception && item.reception.article));
    return article ? footerAttribution().replace('<a href="https://en.wikipedia.org/" rel="noopener" target="_blank">Wikipedia</a>', `<a href="${e(wikiUrl(article))}" rel="noopener" target="_blank">Wikipedia</a>`) : footerAttribution();
  })()}© 2026 FilmyChill · Vikram Sharma
</footer>
</body>
</html>`;
}

// Generate per-film pages for ONE country. India writes to movie/ (flat, legacy); other
// countries write to <code>/movie/. allSlugSets maps code -> Set(slugs) for EVERY country in
// this run, so each page can emit hreflang alternates pointing only at countries that actually
// have that film. knownSlugs (this country's own set + its archive) gates "If you liked this".
function generatePages(data, cfg, allSlugSets) {
  const code = (cfg && cfg.code) || "in";
  const dir = code === "in" ? "movie" : `${code}/movie`;
  const asOf = (data.generatedAt || new Date().toISOString()).slice(0, 10);
  fs.mkdirSync(dir, { recursive: true });
  // Pool items get film pages too. Without them the language pages and /new-on-ott/ would
  // link to slugs that 404, which is worse than the unlinked text they rendered before.
  const all = [...(data.theatres || []), ...(data.ott || []), ...(data.comingSoon || []), ...poolItems(data)];
  // Slugs that resolve to a real page in THIS country: this run + this country's archive.
  const archived = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5))
    : [];
  const knownSlugs = new Set([...archived, ...all.map((x) => x.slug).filter(Boolean)]);
  // Neighbour pool: every film page already on disk for this country, plus the ones about to
  // be written in this run (so today's releases can link to each other, not only backwards).
  const filmIndex = [...filmIndexFor(cfg), ...all.filter((x) => x.slug).map((x) => ({
    slug: x.slug, title: x.title, genre: x.genre || "", language: x.language || "",
    released: x.released || "", poster: x.poster || "", kind: x.kind || "movie",
  }))].filter((v, i, arr) => arr.findIndex((z) => z.slug === v.slug) === i);
  // Countries (in this run) that have this slug — INCLUDING this one. Every page in an
  // hreflang cluster must carry a self-referencing alternate, or Google flags the set as
  // "no return tags" and ignores the whole cluster. A cluster only exists when at least one
  // OTHER country shares the film; a single-country film emits no alternates at all. This
  // also fixes x-default as a side effect: with "in" now present in the codes, xDefaultCode
  // resolves to the India copy instead of falling through to the first foreign market.
  let written = 0;
  for (const item of all) {
    if (!item.slug) continue;
    const cluster = COUNTRIES
      // Membership comes from pages that EXIST, not from this week's lists. A film covered in
      // the UK in March and in India in August belongs to one cluster, but the run-scoped
      // check only ever saw the countries featuring it that week — so the sets came out
      // asymmetric and Google discarded them ("no return tags"). Disk is the source of truth.
      .filter((c) => c.code === code || sameFilmPageExists(c.code, item.slug, item.tmdbId ? `${item.kind || "movie"}:${item.tmdbId}` : null)
        || (allSlugSets && allSlugSets[c.code] && allSlugSets[c.code].has(item.slug)))
      .map((c) => ({ code: c.code, region: c.region }));
    item._alts = cluster.length > 1 ? cluster : [];
    try {
      writeIfChanged(`${dir}/${item.slug}.html`, buildFilmPage(item, asOf, knownSlugs, cfg, filmIndex));
      written++;
    } catch (err) { console.warn(`page ${code}/${item.slug}: ${err.message}`); }
    finally { delete item._alts; }
  }
  const total = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).length;
  console.log(`Pages [${code}]: ${written} written, ${total} total in ${dir}/.`);
}

module.exports = {
  PAGE_FIXES,
  VISIBLE_SIMILAR,
  resetFranchiseIndex,
  simGridHtml,
  headRatingHtml,
  FCSB_CSS,
  audiencePhrase,
  compactScoreHtml,
  fcScoreSection,
  orderAnswer,
  fcdataWindowPhrase,
  assignSlugs,
  existingSlugsById,
  buildFilmPage,
  filmHubLinks,
  filmMetaDescription,
  filmTitleTag,
  generatePages,
  poolItems,
};
