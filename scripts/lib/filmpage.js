// ============================================================================
// filmpage.js — the per-film static page: slugs, the film-history record, meta description,
// title tag, arrival dates, hub links, buildFilmPage() and generatePages().
// ============================================================================
"use strict";

const { meterLevel, meterSvg } = require("./meter.js");
const fs = require("fs");
const {
  COUNTRIES,
  LANGUAGE_PAGES,
  escHtml,
  filmPagePath,
  filmPageUrl,
  fmtDateShort,
  fmtDateFull,
  fmtRuntime,
  slugify,
  trim,
  xDefaultCode,
  localeFor,
} = require("./core.js");
const { readHistory, streamingWindowDays, monthKey, monthLabel } = require("./history.js");
const { filmScore } = require("./score.js");
const { browsePath, filmIndexFor, filmPageExists, relatedFilms } = require("./graph.js");
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
const { countryNameFor, streamVocab, streamWindowEstimate, streamWindowShort } = require("./rules.js");

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
  const out = [...(data.ottExtra || [])];
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

function assignSlugs(data) {
  const used = new Map(); // slug -> tmdbId
  for (const list of [data.theatres, data.ott, data.comingSoon, poolItems(data)]) {
    for (const item of list || []) {
      let slug = slugify(item.title) || `film-${item.tmdbId || ""}`;
      const year = (item.released || "").slice(0, 4);
      if (used.has(slug) && used.get(slug) !== item.tmdbId && year) slug = `${slug}-${year}`;
      used.set(slug, item.tmdbId);
      item.slug = slug;
    }
  }
}



let _filmHistory = null;
const FILM_HISTORY = {
  get(key) {
    if (!_filmHistory) {
      _filmHistory = new Map();
      for (const r of readHistory()) _filmHistory.set(`${r.c}:${r.k}:${r.id}`, r);
    }
    return _filmHistory.get(key);
  },
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
function filmMetaDescription(item, cfg = null, opts = {}) {
  const country = countryNameFor(cfg);
  const V = streamVocab(cfg);
  const year = (item.released || "").slice(0, 4);
  const yr = year ? ` (${year})` : "";
  const providers = Array.isArray(item.providers) ? item.providers : [];
  const rentBuy = Array.isArray(item.rentBuy) ? item.rentBuy : [];
  const relState = releaseState(item.released);
  const upcoming = relState === "upcoming" || relState === "today";
  const runEnded = !!opts.runEnded;
  // A frozen page inside the run window: we know when it opened, not that it is still on.
  const runOpen = !runEnded && !!opts.runOpen;
  const now = opts.now ? new Date(opts.now) : new Date();

  // Pick the first candidate inside Google's ~155-char display, else trim the shortest.
  // Same degradation ladder as fitTitle, for the same reason: the clause that earns the click
  // must survive truncation, so it goes early and the decoration goes last. The old code
  // appended its payoff line and THEN trimmed to 155, which amputated it on every live page —
  // the "this page updates the day it streams" promise never once reached a SERP.
  const fitDesc = (optsList) => {
    const live = optsList.filter(Boolean);
    return live.find((t) => t.length <= 155) || trim(live[live.length - 1] || "", 155);
  };

  const dvotes = item.imdbRating != null ? item.imdbVotes : item.votes;
  const ratingBit = item.rating != null && dvotes >= 10 ? `${Number(item.rating).toFixed(1)}/10` : "";
  const runtimeBit = item.kind === "tv" ? "" : fmtRuntime(item.runtime);
  const stats = [ratingBit, runtimeBit].filter(Boolean).join(", ");
  const statsClause = stats ? `${stats}, ` : "";
  const thing = item.kind === "tv" ? "series" : "film";
  // Title already ending in punctuation must not collect a second colon
  // ("Abijit Ganguly: Baby: OTT release expected…").
  // A title already ending in punctuation must not collect a second colon, and a title that
  // already CONTAINS one ("Insidious: Out of the Further") reads badly with a third — the
  // highest-impression page on the site is exactly that shape, so it gets a dash instead.
  const rawTitle = String(item.title || "").trim();
  const titleSep = /[:.!?\u2014-]$/.test(rawTitle) ? "" : (rawTitle.includes(":") ? " \u2014" : ":");
  // Quote the window only where doing so is honest: a released theatrical title, nothing
  // streaming or rentable yet, and a window that has not already lapsed.
  const est = (item.kind !== "tv" && !providers.length && !rentBuy.length
    && item.platform === "Theatres" && !upcoming)
    ? streamWindowShort(item.released, item.language, now) : null;
  const openedOn = item.released ? `${fmtDateShort(item.released, now.getTime(), localeFor(cfg && cfg.code))}` : "";
  const inCinemas = runEnded ? `theatrical run over in ${country}`
    : runOpen ? `opened in cinemas in ${country}${openedOn ? ` on ${openedOn}` : ""}`
    : `in cinemas in ${country} now`;
  // Name the language only when STREAM_WINDOW_WEEKS actually carries one for it. Everything
  // else gets the honest generic phrasing rather than an implied dataset we don't have.
  const windowBasis = est && est.known ? `the usual ${item.language} window` : "the usual window for a release like this";

  let desc;
  if (item.kind !== "tv" && digitalUpcoming(item)) {
    const when = fmtDateFull(item.digitalDate, localeFor((cfg && cfg.code) || "in"));
    const on = item.digitalNote ? ` on ${item.digitalNote}` : "";
    desc = fitDesc([
      `${item.title}${yr} starts streaming${on} in ${country} on ${when}. The verdict, runtime and cast — and whether it's worth the wait.`,
      `${item.title} streams${on} in ${country} from ${when} — verdict, runtime and cast.`,
      `${item.title} streams${on} in ${country} from ${when}.`,
    ]);
  } else if (opts.gone) {
    // Left every subscription service we track. Say so — never "in cinemas", never a platform.
    desc = fitDesc([
      `${item.title}${yr} isn't on a subscription service in ${country} right now. Where it streamed before, the verdict, and whether it's worth tracking down.`,
      `${item.title}${yr} isn't streaming in ${country} right now — where it was, and the verdict.`,
      `${item.title} isn't streaming in ${country} right now.`,
    ]);
  } else if (upcoming && item.released) {
    // Pre-release: the date is the draw and it is public anyway, so lead with it. What is held
    // back is what the searcher wants next — is it any good, how long, when will it stream.
    const when = fmtDateFull(item.released, localeFor((cfg && cfg.code) || "in"));
    desc = fitDesc([
      `${item.title} opens in cinemas in ${country} on ${when}. Runtime, cast, the trailer and the early reception \u2014 plus when it's likely to reach ${V.word}.`,
      `${item.title} opens in cinemas in ${country} on ${when}. Runtime, cast, trailer and when it's likely to reach ${V.word}.`,
      `${item.title} opens in ${country} on ${when} \u2014 runtime, cast, trailer and early reception.`,
      `${item.title} opens in cinemas in ${country} on ${when}.`,
    ]);
  } else if (providers.length) {
    // NEVER open with the platform name. That one clause is what put
    // /uk/movie/don-t-say-good-luck.html at position 1.12 with ZERO clicks from 247
    // impressions: the searcher read "Netflix" in the results page and went to Netflix.
    // Saying it IS streaming keeps the snippet honest and on-intent; not saying WHERE is the
    // entire reason to click.
    desc = fitDesc([
      `${item.title} is streaming in ${country} \u2014 but is it worth your evening? ${statsClause}the critics' take, the audience counterpoint and every platform carrying it.`,
      `${item.title} is streaming in ${country} \u2014 but is it worth your evening? ${statsClause}critics' take and every platform carrying it.`,
      `${item.title} is streaming in ${country}. ${statsClause}verdict, critics' take and where to watch it.`,
      `${item.title} is streaming in ${country} \u2014 the verdict and where to watch.`,
    ]);
  } else if (rentBuy.length) {
    desc = fitDesc([
      `${item.title} isn't on any subscription in ${country} yet \u2014 where to rent or buy it, ${statsClause}the critics' take and whether it's worth paying for.`,
      `${item.title} isn't on a subscription in ${country} yet. Where to rent or buy it, ${statsClause}and whether it's worth paying for.`,
      `${item.title} in ${country}: where to rent or buy it, ${statsClause}and the verdict.`,
      `${item.title} \u2014 where to rent or buy it in ${country}, and the verdict.`,
    ]);
  } else if (est) {
    // The money branch. "<film> ott release date" is the highest-volume query shape these
    // pages rank for, and the snippet used to answer it with "coming soon". A dated window,
    // labelled as a pattern, beats both a non-answer and a competitor's unsourced guess.
    desc = fitDesc([
      `${item.title}${titleSep} ${V.word} release expected around ${est.short} (${windowBasis}, not a confirmed date). ${cap(inCinemas)}; ${statsClause}verdict inside.`,
      `${item.title}${titleSep} ${V.word} release expected around ${est.short} (${windowBasis}, not a confirmed date). ${statsClause}verdict and runtime inside.`,
      `${item.title}${titleSep} ${V.word} release expected around ${est.short} (a pattern, not a confirmed date). ${cap(inCinemas)}.`,
      `${item.title}${titleSep} ${V.word} release expected around ${est.short}. ${cap(inCinemas)}.`,
    ]);
  } else if (item.platform === "Theatres") {
    // No usable window (no release date on file, or the window already lapsed). There is
    // genuinely nothing to promise about the date, so the payoff clause carries the click.
    const lead = runEnded
      ? `${item.title} has finished its theatrical run in ${country}`
      : runOpen ? `${item.title} opened in cinemas in ${country}${openedOn ? ` on ${openedOn}` : ""}`
      : `${item.title} is in cinemas in ${country}`;
    desc = fitDesc([
      `${lead}. We re-check for ${V.article.toLowerCase()} ${V.releaseDate} every single day \u2014 ${statsClause}critics' take and the verdict inside.`,
      `${lead}. We check daily for ${V.article.toLowerCase()} ${V.releaseDate} \u2014 ${statsClause}critics' take and the verdict.`,
      `${lead} \u2014 ${statsClause}critics' take and the verdict.`,
      `${lead}.`,
    ]);
  } else {
    // Availability unknown. The old generic line at least named the film; give it a payoff
    // clause too, rather than trailing off into a truncated synopsis.
    desc = fitDesc([
      `${item.title}${yr}: ${[item.language, item.genre].filter(Boolean).join(" ")} ${thing} \u2014 ${statsClause}the verdict, the critics' take and where to watch it in ${country}.`,
      `${item.title}${yr}: ${[item.language, item.genre].filter(Boolean).join(" ")} ${thing} \u2014 rating, verdict and where to watch in ${country}.`,
      `${item.title}${yr} \u2014 rating, verdict and where to watch in ${country}.`,
    ]);
  }
  // Last-resort guard: five live pages once shipped with an empty description. Never again.
  if (!desc || desc.trim().length < 20) {
    desc = trim(`${item.title}${yr}: ${[item.language, item.genre, thing].filter(Boolean).join(" ")} \u2014 review, rating and where to watch in ${country}`, 155);
  }
  return desc;
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
// Google shows ~60 chars; the ladder drops decoration (brand, country) before it drops the
// query-bearing words, so truncation never eats the part that earns the click.
function filmTitleTag(item, cfg = null) {
  const country = countryNameFor(cfg);
  const V = streamVocab(cfg);
  const year = (item.released || "").slice(0, 4);
  const yr = year ? ` (${year})` : "";
  const providers = Array.isArray(item.providers) ? item.providers : [];
  const fitTitle = (opts) => opts.find((t) => t.length <= 60) || opts[opts.length - 1];
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
  if (item.kind !== "tv" && digitalUpcoming(item)) {
    const code = (cfg && cfg.code) || "in";
    const d = fmtDateShort(item.digitalDate, Date.now(), localeFor(code));
    const on = item.digitalNote ? ` on ${item.digitalNote}` : "";
    const label = V.word === "OTT" ? "OTT Release Date" : "Streaming Date";
    return fitTitle([
      `${item.title}${yr} ${label}: ${d}${on} | FilmyChill`,
      `${item.title}${yr} ${label}: ${d}${on}`,
      `${item.title} ${label}: ${d}${on}`,
      `${item.title}${yr} ${label}: ${d}`,
      `${item.title} ${label}: ${d}`,
    ]);
  }
  // "OTT" is Indian-market phrasing; TV has no OTT release date to speak of; and with no
  // provider on file there is no date to report.
  const canAnswerDate = V.word === "OTT" && item.kind !== "tv" && providers.length > 0;
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
  "  .fcsb-m { display:block; width:56px; height:35px; flex-shrink:0; }",
  "  .fcsb-stamp { display:inline-block; padding:8px 14px; border-radius:10px; font-family:'Anton',sans-serif; font-size:28px; line-height:1; letter-spacing:.4px; text-transform:uppercase; white-space:nowrap; }",
  "  @media (max-width: 420px) { .fcsb-m { width:48px; height:30px; } .fcsb-stamp { font-size:24px; padding:7px 12px; } }",
  "  .fcsb-must { background:var(--indigo); color:#fff; } .fcsb-worth { background:var(--marigold); color:var(--ink); }",
  "  .fcsb-skip { border:2px solid var(--ink); color:var(--ink); padding:6px 12px; }",
  "  .fcsb-early { background:#F4F1EA; color:var(--mute); }",
  "  .fcsb-why { font-size:15.5px; line-height:1.55; margin:12px 0 0; }",
  "  .fcsb-rows { margin-top:14px; padding-top:12px; border-top:1px solid #EFE6D6; display:grid; gap:10px; }",
  "  .fcsb-row { display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:13px; }",
  "  .fcsb-row small { display:block; color:var(--mute); font-size:12px; margin-top:2px; }",
  "  .fcsb-tag { font-size:12px; font-weight:700; padding:4px 10px; border-radius:999px; background:#EAE8FA; color:var(--indigo); white-space:nowrap; }",
  "  .fcsb-tag.none { background:#F4F1EA; color:#5A5470; }",
  "  .fcsb-note { font-size:13px; color:var(--mute); line-height:1.5; margin:8px 0 0; }",
].join("\n");

// The header's confidence-tiered audience rating. Exported so the score sweep can refresh it on
// frozen and back-catalogue pages at the same time as the score, keeping the two in agreement.
function headRatingHtml(item) {
  const e = escHtml;
        // Confidence-tiered rating (see lib/score.js). The number stays TMDB's own; what we
        // add is how much to trust it, from the vote count — so an 8.0 on 13 votes reads
        // differently from an 8.2 on 1,200. Colour is backed by a text label, never alone.
        const sc = filmScore(item);
        if (sc.displayRating == null) {
          return `<div class="rating rating-few"><span class="cdot"></span>Rating still forming <span class="cvotes">— too few ratings yet</span></div>`;
        }
        return `<div class="rating rating-${sc.tier}"><span class="cdot"></span>★ ${sc.displayRating}`
          + ` <span class="ctag">${e(sc.tierLabel)}</span>`
          + ` <span class="cvotes">${e(sc.votes.toLocaleString("en-IN"))} ratings</span>`
          + `<span class="cbar"><i style="width:${Math.round(sc.confidencePct * 100)}%"></i></span></div>`;
}

// The FilmyChill Score section of a film page (block + note). Exported so the score sweep
// (lib/scoresweep.js) can add the exact same section to frozen and back-catalogue pages,
// which are never rebuilt. Needs FCSB_CSS in the page's <style>.
function fcScoreSection(item) {
  const e = escHtml;
    // FilmyChill Score (lib/fcscore.js): the site's own verdict, audiences + critics. It
    // replaces the header's audience-only verdict pill; the audience rating itself stays in
    // the header and again in the breakdown, labelled as the audience's.
    const s = item.fcScore || null;
    const votes = item.votes ? Number(item.votes).toLocaleString("en-IN") : "0";
    const aud = s && s.audience
      ? { tag: s.audience, sub: `★ ${Number(item.rating).toFixed(1)} from ${votes} ratings on TMDB` }
      : item.rating != null && item.votes
        ? { tag: "Too few ratings", sub: `★ ${Number(item.rating).toFixed(1)} from ${votes} ratings — counts from 50`, none: true }
        : { tag: "Not rated yet", sub: "No audience ratings yet", none: true };
    const cri = s && s.critics
      ? { tag: s.critics.charAt(0).toUpperCase() + s.critics.slice(1), sub: "From published reviews" }
      : { tag: "No verdict", sub: "No settled critics' reception on record", none: true };
    const row = (label, x) => `<div class="fcsb-row"><div><b>${label}</b><small>${e(x.sub)}</small></div><span class="fcsb-tag${x.none ? " none" : ""}">${e(x.tag)}</span></div>`;
    const lvl = !s ? "early" : /^must/i.test(s.verdict) ? "must" : /^skip/i.test(s.verdict) ? "skip" : "worth";
    return `<section class="fcsb" id="filmychill-score">
    <div class="fcsb-label">FilmyChill score</div>
    <div class="fcsb-verdict">${meterSvg(s ? meterLevel(s.verdict) : "early", { size: 56, cls: "fcsb-m" })}<span class="fcsb-stamp fcsb-${lvl}">${e(s ? s.verdict : "Too early")}</span></div>
    <p class="fcsb-why">${e(s ? s.reason : "Not enough ratings or reviews yet. The score appears once there are.")}</p>
    <div class="fcsb-rows">${row("Audience", aud)}${row("Critics", cri)}</div>
  </section>
  <p class="fcsb-note">The FilmyChill Score combines audience ratings and critics' reception, and updates twice a day. No studio or platform can pay for a score. <a href="/about/#score">How the score works</a></p>`;
}

function buildFilmPage(item, asOf, knownSlugs, cfg, filmIndex = null) {
  const e = escHtml;
  const code = (cfg && cfg.code) || "in";
  const country = countryNameFor(cfg); // "the US", not the config's "United States" — reads right in titles and prose
  const homeUrl = code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`;
  const year = (item.released || "").slice(0, 4);
  // Three states (see releaseState): a film releasing TODAY is neither "Released" nor
  // "Coming soon". `upcoming` stays truthy for today so the page keeps its pre-release
  // shape (no streaming estimate can be computed from a run that hasn't started).
  const relState = releaseState(item.released);
  const upcoming = relState === "upcoming" || relState === "today";
  const relLabel = relState === "upcoming" ? "Releases" : relState === "today" ? "Releases today" : "Released";
  const synopsis = item.fullReview || item.review || "";
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
  const desc = filmMetaDescription(item, cfg);

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
  const isShellPage = code !== "in" && !providers.length && !(item.rentBuy || []).length
    && item.platform !== "Theatres" && !upcoming;
  const robotsTag = isShellPage
    ? `<meta name="robots" content="noindex,follow,max-image-preview:large">`
    : `<meta name="robots" content="max-image-preview:large">`;
  void synopsis;

  // hreflang alternates: the SAME film may have a page in several countries. crossCountry maps
  // code -> true for every other country whose current run also has this slug. Passed in by
  // generatePages (it knows all countries' slug sets); absent for ad-hoc/test renders.
  const alts = (item._alts && Array.isArray(item._alts)) ? item._alts : [];

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
    numberOfSeasons: item.kind === "tv" && item.seasons ? item.seasons : undefined,
    genre: item.genre || undefined,
    inLanguage: item.language || undefined,
    director: item.director ? { "@type": "Person", name: item.director } : undefined,
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
  if (item.trailer && /youtube\.com\/watch/.test(item.trailer)) {
    // A WatchAction target must be where the WORK can be watched; a trailer is not the
    // work. schema.org gives trailers their own home: Movie/TVSeries.trailer.
    // Google requires uploadDate and one of contentUrl/embedUrl on a VideoObject, or it drops
    // the video rich result. We don't have the trailer's true YouTube publish date (that needs
    // the YouTube API), so we use the film's own date as an honest proxy — a trailer is
    // published around a film's release window. embedUrl is the privacy-friendly nocookie
    // embed we already render; contentUrl is the watch URL.
    const _ytid = ytIdOf(item.trailer);
    const _upDate = item.freshDate || item.released || null;
    ld.trailer = {
      "@type": "VideoObject",
      name: `${item.title} — Official Trailer`,
      description: `Official trailer for ${item.title}${item.language ? ` (${item.language})` : ""}.`,
      thumbnailUrl: _ytid ? `https://img.youtube.com/vi/${_ytid}/hqdefault.jpg` : undefined,
      uploadDate: _upDate ? `${String(_upDate).slice(0, 10)}T00:00:00+05:30` : undefined,
      contentUrl: item.trailer,
      embedUrl: _ytid ? `https://www.youtube-nocookie.com/embed/${_ytid}` : undefined,
    };
  }

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "FilmyChill", item: homeUrl },
      { "@type": "ListItem", position: 2, name: item.title, item: url },
    ],
  };

  // --- Enriched, deterministic sections (original content -> SEO value) ---
  const verdictProse = buildVerdictProse(item, country, localeFor(code));
  const goodToKnow = buildGoodToKnow(item);
  const faqs = buildFaqs(item, country, cfg);
  // On-site titles outrank off-site ones in the strip: a recommendation the reader can
  // actually open beats a dead card, and each one is a contextual internal link on a
  // page that otherwise has almost none (742 of 1,044 film pages had zero inlinks).
  // Neighbours come from the pages we actually HAVE (see filmIndexFor), not from TMDB's
  // recommendation list — those were 6 dead cards per page because TMDB recommends films
  // this site has never covered. Every entry below resolves to a real URL.
  const related = Array.isArray(filmIndex) && filmIndex.length ? relatedFilms(item, filmIndex, 6) : [];
  const simAll = Array.isArray(item.similar) ? item.similar : [];
  const onSite = (s) => knownSlugs && knownSlugs.has(s.slug);
  const similar = related.length >= 3 ? related
    : [...simAll.filter(onSite), ...simAll.filter((s) => !onSite(s))].slice(0, 6);
  const linkable = related.length >= 3 ? () => true : onSite;

  // FAQPage schema — only when we have at least 2 Q&As (Google wants a real list).
  const faqLd = faqs.length >= 2 ? {
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
<meta http-equiv="Content-Security-Policy" content="${cspWith("default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' https://image.tmdb.org data:; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'")}">${analyticsTag()}
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>${faqLd ? `
<script type="application/ld+json">${JSON.stringify(faqLd)}</script>` : ""}
<style>
  :root { --indigo:#4038C7; --marigold:#FFAD1F; --cream:#FFF7EC; --ink:#1A1633; --mute:#6B6890; --line:#E4E1F5; }
  * { box-sizing:border-box; } body { font-family:-apple-system,'Segoe UI',Roboto,sans-serif; background:#F7F5FF; color:var(--ink); margin:0; }
  .top { background:var(--indigo); padding:14px 16px; } .top a { color:var(--cream); text-decoration:none; font-weight:800; letter-spacing:1px; font-size:18px; }
  .top a span { color:var(--marigold); }
  .wrap { max-width:680px; margin:0 auto; padding:20px 16px 40px; }
  .head { display:grid; grid-template-columns:140px 1fr; gap:16px; }
  .poster { width:140px; border-radius:12px; display:block; }
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
  .btn { display:inline-block; background:var(--indigo); color:#fff; font-weight:700; font-size:14px; padding:11px 20px; border-radius:10px; text-decoration:none; margin-top:20px; }
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
  .simgrid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-top:8px; }
  .simcard { display:block; background:#fff; border:1px solid var(--line); border-radius:10px; overflow:hidden; text-decoration:none; color:var(--ink); }
  .simcard img { width:100%; aspect-ratio:2/3; object-fit:cover; display:block; background:var(--line); }
  .simcard .st { font-size:12.5px; font-weight:700; padding:8px 8px 2px; line-height:1.25; }
  .simcard .sm { font-size:11px; color:var(--mute); padding:0 8px 8px; }
  .faq { margin-top:8px; }
  .faq details { border-top:1px solid var(--line); padding:10px 0; }
  .faq summary { font-size:14.5px; font-weight:700; cursor:pointer; list-style:none; }
  .faq summary::-webkit-details-marker { display:none; }
  .faq summary::after { content:"+"; float:right; color:var(--indigo); font-weight:700; }
  .faq details[open] summary::after { content:"–"; }
  .faq .fa { font-size:14px; line-height:1.6; color:var(--mute); margin-top:8px; }
  @media (max-width:420px){ .head { grid-template-columns:110px 1fr; } .poster { width:110px; } h1 { font-size:20px; } }
</style>
</head>
<body>
<div class="top"><a href="${e(homeUrl)}">FILMY<span>CHILL</span></a></div>
<div class="wrap">
  <div class="head">
    ${item.poster ? `<img class="poster" src="${e(item.poster)}" alt="${e(item.title)} poster" width="72" height="106">` : "<div></div>"}
    <div>
      <h1>${e(item.title)}${year ? ` (${year})` : ""}</h1>
      <div class="meta">${[item.language, item.genre, item.runtime ? item.runtime + " min" : null, item.cert].filter(Boolean).map(e).join(" · ")}</div>
      ${headRatingHtml(item)}
      ${item.released ? `<div class="meta" style="margin-top:8px">${relState === "today" ? relLabel : `${relLabel} ${e(fmtDateFull(item.released, localeFor(code)))}`}</div>` : ""}
      ${asOf ? `<div class="meta" style="margin-top:2px;font-size:12.5px">Page updated ${e(fmtDateFull(asOf, localeFor(code)))}</div>` : ""}
    </div>
  </div>
  ${fcScoreSection(item)}
  ${(() => {
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
    return `<p class="answer">${ans}</p>`;
  })()}
  ${verdictProse ? `<h2>What the audience says</h2><p class="vprose">${e(verdictProse)}</p>` : ""}
  ${item.hook ? `<p class="hook">${e(item.hook)}</p>` : ""}
  ${item.take ? `<p class="take">${e(item.take)}${item.takeCounter ? ` <span class="tcounter">${e(item.takeCounter)}</span>` : ""}${item.takeSrc === "wiki" ? ` <span class="tsrc">— distilled from critics' published reviews</span>` : ""}</p>` : ""}
  ${(() => {
    // The one fact on this page no competitor can reproduce: measured from our own archive
    // (lib/history.js), not from any API. TMDB stores no history of provider changes.
    const rec = FILM_HISTORY.get(`${code}:${item.kind === "tv" ? "tv" : "movie"}:${item.tmdbId}`);
    const days = rec ? streamingWindowDays(rec) : null;
    if (days == null) return "";
    return `<p class="fcdata"><b>FilmyChill data:</b> reached streaming in ${e(country)} `
      + `${days === 0 ? "the same day it opened" : `${days} day${days === 1 ? "" : "s"} after its theatrical release`}`
      + `${rec.p ? `, on ${e(rec.p)}` : ""}.</p>`;
  })()}
  ${(() => {
    // Fit line (see whyWatch). Sits after the reception blocks and before the synopsis:
    // by this point the reader knows if it's good — this answers whether it's for them.
    const ww = whyWatch(item);
    return ww ? `<h2>${e(ww.heading)}</h2><p class="whywatch">${e(ww.text)}</p>` : "";
  })()}
  ${(() => {
    // Skip block (see lib/skipif.js). Sits immediately after the fit line, because the two
    // are one argument: here is who this is for, and here is who it is not for. Every other
    // block on this page argues for watching; a page that never says "not you" is a page a
    // reader learns to discount. Returns null on most films, and that is intended.
    const skip = skipIf(item);
    if (!skip) return "";
    return `<div class="skipif"><h3>Don't watch this if\u2026</h3><ul>`
      + skip.map((r) => `<li>${e(r)}</li>`).join("")
      + `</ul></div>`;
  })()}
  ${(() => {
    // The scannable house format (lib/watchfit.js): same three rows, same order, on every
    // page that qualifies. Sits directly under the fit prose because it is the same
    // question compressed — a reader who skims takes this and leaves, which is the point.
    // Gated inside watchFit(): returns null on thin signal rather than inventing rows.
    const wf = watchFit(item);
    if (!wf) return "";
    const rows = [
      wf.why ? `<dt>Why</dt><dd>${e(wf.why)}</dd>` : "",
      wf.skipIf ? `<dt class="skip">Skip if</dt><dd>${e(wf.skipIf)}</dd>` : "",
      wf.bestFor ? `<dt>Best for</dt><dd>${e(cap(wf.bestFor))}</dd>` : "",
    ].join("");
    return `<div class="fit"><dl>${rows}</dl></div>`;
  })()}
  ${synopsis ? `<h2>Story</h2><p>${e(synopsis)}</p>` : ""}
  ${goodToKnow.length ? `<h2>Good to know</h2><table class="gtk">${goodToKnow.map((row) => `<tr><td>${e(row.label)}</td><td>${e(row.value)}</td></tr>`).join("")}</table>` : ""}
  ${item.director ? `<h2>Director</h2><p>${e(item.director)}</p>` : ""}
  ${(item.castPics && item.castPics.length) ? `<h2>Cast</h2><div class="cast-strip">${item.castPics.map((c) => {
    // A name links to its people page when one exists (5+ films here) — see writePeoplePages.
    const ps = slugify(c.name || "");
    const nm = ps && fs.existsSync(personPagePath(code, ps)) ? `<a href="/${e(PEOPLE_BASE(code))}/${e(ps)}/">${e(c.name)}</a>` : e(c.name);
    return `<div class="cast-card"><img src="${e(c.photo)}" alt="${e(c.name)}" width="72" height="72" loading="lazy"><div class="cast-name">${nm}</div>${c.character ? `<div class="cast-role">${e(c.character)}</div>` : ""}</div>`;
  }).join("")}</div>`
    : cast.length ? `<h2>Cast</h2><div>${cast.map((c) => `<span class="pill">${e(c)}</span>`).join("")}</div>` : ""}
  ${(() => {
    // ---- "When is X coming to streaming/OTT?" ----------------------------------
    // The single highest-intent question on a theatrical film page, and the one the
    // page previously answered only inside a collapsed FAQ. Rendered as a real
    // section, above Where-to-watch, because it is why these visitors arrived.
    // Shown only for films with NO streaming provider — once real data exists the
    // Where-to-watch block below is the better answer and this disappears on the
    // next build. Never invents a date: an estimate is always a labelled range.
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
      return `<!--SW:pending--><!--SW:due=${e(due)}--><h2>${e(V.heading(item.title))}</h2><p>${opens} ${e(V.article)} ${e(V.releaseDate)} won't be set until after it opens — this page updates automatically the day it starts streaming.</p><!--/SW:pending-->`;
    }
    if (digitalUpcoming(item)) {
      const on = item.digitalNote ? ` on ${e(item.digitalNote)}` : "";
      return `<!--SW:pending--><!--SW:digital=${e(item.digitalDate)}|${e(item.digitalNote || "")}--><h2>${e(V.heading(item.title))}</h2>`
        + `<p><strong>Streaming from ${e(fmtDateFull(item.digitalDate, localeFor(code)))}${on}.</strong> ${e(digitalAnnounceText(item.title, item.digitalDate, item.digitalNote, country, cfg))} This page switches to \u201cstreaming now\u201d the day it lands.</p><!--/SW:pending-->`;
    }
    const est = streamWindowEstimate(item.released, item.language);
    const body = est && !est.passed
      ? `<p>Not streaming yet — ${e(item.title)} is in its theatrical run in ${e(country)}${item.released ? `, released ${e(item.released)}` : ""}. ${e(item.language || "Films like this")} releases typically reach streaming about ${est.lo}–${est.hi} weeks after opening, which would put it somewhere around <strong>${e(est.span)}</strong>.</p><p style="color:var(--mute);font-size:13px">That's the usual pattern, not a confirmed date — no platform has announced one. We re-check every day and this page updates the moment it lands.</p>`
      : `<p>Not streaming yet in ${e(country)}${item.released ? ` — ${e(item.title)} released in theatres ${e(item.released)}` : ""}. No platform has announced ${e(V.article.toLowerCase())} ${e(V.releaseDate)}. We re-check every day and this page updates the moment it lands.</p>`;
    return `<!--SW:pending--><h2>${e(V.heading(item.title))}</h2>${body}<!--/SW:pending-->`;
  })()}
  ${(() => {
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
    if (providers.length) return `<!--SW:stream--><!--SW:live=${e(asOf || "")}--><h2>Where to watch in ${e(country)}</h2><div>${providers.map((p) => `<span class="pill">${e(p)}</span>`).join("")}</div><p style="color:var(--mute);font-size:12.5px;margin-top:6px">Included with a subscription — no extra charge on these platforms.</p>${rbRow}${note}${filmHubLinks(item, cfg)}<!--/SW:stream-->`;
    if (item.platform === "Theatres") return `<h2>Where to watch in ${e(country)}</h2><div><span class="pill">In theatres</span></div>${rb.length ? rbRow + `<p style="color:var(--mute);font-size:12.5px;margin-top:6px">Not on any streaming subscription yet — renting is the only way to watch it at home for now.</p>` : ""}${note}`;
    if (rb.length) return `<h2>Where to watch in ${e(country)}</h2>${rbRow}<p style="color:var(--mute);font-size:12.5px;margin-top:6px">Not on any streaming subscription yet — renting is the only way to watch it at home for now.</p>${note}`;
    // Unreleased film: previously this block rendered nothing at all, so the page answered
    // "where to watch" with silence. State it plainly instead.
    if (upcoming && item.released) {
      const when = relState === "today" ? "today" : fmtDateFull(item.released, localeFor(code));
      return `<h2>Where to watch in ${e(country)}</h2><div><span class="pill">${relState === "today" ? "In cinemas today" : `In cinemas from ${e(when)}`}</span></div><p style="color:var(--mute);font-size:12.5px;margin-top:6px">Not out yet — nowhere to stream or rent it until it opens.</p>`;
    }
    return "";
  })()}
  ${ytid ? `<h2>Trailer</h2><div class="frame"><iframe loading="lazy" src="https://www.youtube-nocookie.com/embed/${e(ytid)}?rel=0" title="${e(item.title)} trailer" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe></div>` : item.trailer ? `<h2>Trailer</h2><p><a href="${e(item.trailer)}" rel="noopener">Find the trailer on YouTube →</a></p>` : ""}
  ${similar.length ? `<h2>If you liked this</h2><div class="simgrid">${similar.map((s) => {
    const exists = linkable(s);
    const inner = `${s.poster ? `<img src="${e(s.poster)}" alt="${e(s.title)} poster" loading="lazy">` : ""}<div class="st">${e(s.title)}</div><div class="sm">${[s.language, s.kind === "tv" ? "Series" : "Film"].filter(Boolean).map(e).join(" · ")}</div>`;
    return exists
      ? `<a class="simcard" href="${e(filmPagePath(code, s.slug))}">${inner}</a>`
      : `<div class="simcard" style="cursor:default">${inner}</div>`;
  }).join("")}</div>` : ""}
  ${faqs.length ? `<h2>Frequently asked</h2><div class="faq">${faqs.map((f) => `<details><summary>${e(f.q)}</summary><div class="fa">${e(f.a)}</div></details>`).join("")}</div>` : ""}
  <a class="btn" href="${e(homeUrl)}#${e(item.slug)}">See this week's top picks on FilmyChill →</a>
  <a class="btn" href="${e(browsePath(code, 1))}">Browse every film we've covered →</a>
</div>
<footer>
  <nav><a href="${e(homeUrl)}">This week in ${e(country)}</a> · <a href="${code === "in" ? "/new-on-ott/" : `/${e(code)}/new-on-ott/`}">New on ${e(streamVocab(cfg).word === "OTT" ? "OTT" : "streaming")}</a>${code === "in" ? ` · ${LANGUAGE_PAGES.map(([n, s]) => `<a href="/${s}/">${n}</a>`).join(" · ")}` : ""} · <a href="/about/">About</a></nav>
  Verdicts are compiled by FilmyChill's editorial system from audience ratings and published critic reception — <a href="/about/">how we rate</a>.<br>
  ${footerAttribution()}© 2026 FilmyChill · Vikram Sharma
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
      .filter((c) => c.code === code || filmPageExists(c.code, item.slug)
        || (allSlugSets && allSlugSets[c.code] && allSlugSets[c.code].has(item.slug)))
      .map((c) => ({ code: c.code, region: c.region }));
    item._alts = cluster.length > 1 ? cluster : [];
    try {
      fs.writeFileSync(`${dir}/${item.slug}.html`, buildFilmPage(item, asOf, knownSlugs, cfg, filmIndex));
      written++;
    } catch (err) { console.warn(`page ${code}/${item.slug}: ${err.message}`); }
    finally { delete item._alts; }
  }
  const total = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).length;
  console.log(`Pages [${code}]: ${written} written, ${total} total in ${dir}/.`);
}

module.exports = {
  headRatingHtml,
  FCSB_CSS,
  fcScoreSection,
  assignSlugs,
  buildFilmPage,
  filmHubLinks,
  filmMetaDescription,
  filmTitleTag,
  generatePages,
  poolItems,
};
