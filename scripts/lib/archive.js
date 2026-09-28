// ============================================================================
// archive.js — frozen film pages: the pages manifest, the archive patch that keeps frozen
// copy honest (meta description, title, aggregateRating, analytics back-fill, freshened wording),
// and repair of pages built for the wrong market.
// ============================================================================
"use strict";

const fs = require("fs");
const {
  COUNTRIES,
  COUNTRY_PAGE_META,
  escHtml,
  fmtDateFull,
  localeFor,
} = require("./core.js");
const { filmIndexFor } = require("./graph.js");
const { todayStr } = require("./release.js");
const { enrich } = require("./enrich.js");
const { buildFilmPage, filmMetaDescription, filmTitleTag } = require("./filmpage.js");
const {
  analyticsTag,
  cspWith,
  GC_SITE,
  OPEN_PILL_RE,
  settleReleasedCopy,
} = require("./pagekit.js");
const { countryNameFor, streamVocab } = require("./rules.js");
const { sleep, tmdb } = require("./tmdb.js");

// ============================================================================
// CROSS-COUNTRY LEGACY PAGES — built for one market with another market's data.
//
// A batch of pages frozen in mid-2026, before the pipeline was fully country-generic, was
// rendered for the US, UK, Australia, Germany, Canada, the UAE, Singapore and Malaysia with
// India's copy and India's data inside the right country's shell. Sept 2026 audit, 136
// pages. The failures are not cosmetic:
//   "In India you can stream it on Prime Video"   on the AUSTRALIAN edition
//   "is currently playing in theatres across India" on the German one
//   an India CBFC certificate ("A", "U/A 16+") in the family-viewing row of a US page
// A reader in Sydney is being told India's availability. No text patch can fix that,
// because the right answer (Australia's providers, Australia's rating) isn't on the page.
//
// So these pages are REBUILT, once, from TMDB for their own market by the current builder,
// then passed through the archive chain like any frozen page. The TMDB id comes from the
// manifest, or a same-slug entry in another edition, or a title+year search — and in every
// case it must match the poster already on the page before anything is overwritten, so a
// same-titled different film can never replace the page. A page whose film can't be
// identified with certainty gets the wrong-country claims removed instead (neutralized),
// which leaves less on the page but nothing false.
// ============================================================================
const LEGACY_REPAIR_BUDGET = 30;   // pages per country per run; ~3 TMDB calls each

// Pure: why this page is wrong for its own edition. [] means it's fine.
function crossCountryLeak(html, cfg) {
  const code = (cfg && cfg.code) || "in";
  const own = new Set(countryNameForms(cfg));
  const reasons = [];
  const body = html.split("Also on FilmyChill")[0];
  // Only the builder's own claim sentences — never a synopsis ("In Singapore, Krishna is
  // forced…" is a plot, not an availability claim) or a title ("The India Story").
  const NAME = "((?:the )?[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)";
  const claim = new RegExp([
    `in theatres in ${NAME} now`,
    `playing in theatres across ${NAME}\\.`,
    `\\bIn ${NAME} you can stream it on`,
    `You can stream [^<".]{1,80}? in ${NAME} on`,
    `Where to watch in ${NAME}<`,
  ].join("|"), "g");
  const markets = new Map();
  for (const c of COUNTRIES) for (const n of countryNameForms({ code: c.code })) markets.set(n, c.code);
  for (const m of body.matchAll(claim)) {
    const name = m.slice(1).find(Boolean);
    if (markets.has(name) && !own.has(name) && markets.get(name) !== code) reasons.push(`names ${name}`);
  }
  if (code !== "in" && /<td>Watch with family\?<\/td><td>(?:A|UA[^<·]*|U\/A[^<·]*) ·/.test(html)) reasons.push("India certificate");
  return [...new Set(reasons)];
}

// Pure: remove the wrong-country claims when the film can't be identified for a rebuild.
function neutralizeCrossCountry(html, cfg, title) {
  const own = new Set(countryNameForms(cfg));
  const others = [];
  for (const c of COUNTRIES) for (const n of countryNameForms({ code: c.code })) if (!own.has(n)) others.push(reEsc(n));
  const O = others.sort((a, b) => b.length - a.length).join("|");
  const country = countryNameFor(cfg);
  const A = "(?:'|&#39;)";
  const unknown = (m) => `Streaming availability for ${m.includes("&#39;") ? escHtml(title) : title} in ${m.includes("&#39;") ? escHtml(country) : country} isn${m.includes("&#39;") ? "&#39;" : "'"}t confirmed yet — check back as platforms update.`;
  let out = html
    .replace(new RegExp(` It${A}s in theatres in (?:${O}) now — best caught on the big screen\\.`, "g"), "")
    .replace(new RegExp(` In (?:${O}) you can stream it on [^.<"]+\\.`, "g"), "")
    .replace(new RegExp(`[^.<">]*? is currently playing in theatres across (?:${O})\\.[^<"]*?announced yet\\.`, "g"), unknown)
    .replace(new RegExp(`You can stream [^.<"]+? in (?:${O}) on [^.<"]+\\.`, "g"), unknown);
  if ((cfg && cfg.code) !== "in") {
    // An India CBFC certificate says nothing true about this market: drop the row, and the
    // FAQ answer built from it, in both the visible HTML and the FAQPage schema.
    out = out.replace(/<tr><td>Watch with family\?<\/td><td>(?:A|UA[^<·]*|U\/A[^<·]*) ·[^<]*<\/td><\/tr>/g, "");
    out = out.replace(/<details><summary>Is [^<]*? family friendly\?<\/summary><div[^>]*>[^<]*? is rated (?:A|UA[^<.]*|U\/A[^<.]*)[\s\S]*?<\/details>/g, "");
    out = out.replace(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@type":"FAQPage"[\s\S]*?)<\/script>/, (m, json) => {
      try {
        const d = JSON.parse(json);
        d.mainEntity = (d.mainEntity || []).filter((q) => !(/family friendly\?$/.test(q.name) && / is rated (?:A|UA|U\/A)\b/.test((q.acceptedAnswer || {}).text || "")));
        return `<script type="application/ld+json">${JSON.stringify(d).replace(/</g, "\\u003c")}</script>`;
      } catch { return m; }
    });
  }
  return { html: out, changed: out !== html };
}

// `api` is injectable so the whole path — identification, the poster guard, rebuild vs
// neutralize, the manifest stamp — is testable without the network.
async function repairLegacyPages(cfg, pagesManifest, { baseItem, withImdb, budget = LEGACY_REPAIR_BUDGET,
  api = { tmdb, enrich, pause: sleep } }) {
  const code = cfg.code;
  const dir = code === "in" ? "movie" : `${code}/movie`;
  if (!fs.existsSync(dir)) return 0;
  const m = (pagesManifest[code] = pagesManifest[code] || {});
  const have = new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5)));
  const filmIndex = filmIndexFor(cfg);
  const today = todayStr();
  const countryName = countryNameFor(cfg);
  let rebuilt = 0, neutralized = 0, tried = 0;
  for (const slug of [...have].sort()) {
    if (tried >= budget) break;
    const p = `${dir}/${slug}.html`;
    let html;
    try { html = fs.readFileSync(p, "utf8"); } catch { continue; }
    if (!crossCountryLeak(html, cfg).length) continue;
    tried++;
    const kind = /"@type":"TVSeries"/.test(html) ? "tv" : "movie";
    const poster = (html.match(/image\.tmdb\.org\/t\/p\/w\d+(\/[A-Za-z0-9_-]+\.(?:jpg|png))/) || [])[1] || null;
    const h1 = (html.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1] || "";
    const title = h1.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s*\((\d{4})\)\s*$/, "").trim();
    const year = (h1.match(/\((\d{4})\)\s*$/) || [])[1];
    const candidates = [];
    if (m[slug] && m[slug].tmdbId) candidates.push(m[slug].tmdbId);
    for (const c of COUNTRIES) { const e = (pagesManifest[c.code] || {})[slug]; if (e && e.tmdbId) candidates.push(e.tmdbId); }
    let chosen = null;
    try {
      for (const id of [...new Set(candidates)]) {
        const d = await api.tmdb(`/${kind}/${id}`); await api.pause(120);
        if (d && d.id && poster && d.poster_path === poster) { chosen = d; break; }
      }
      if (!chosen && poster && title) {
        const q = { query: title, include_adult: "false" };
        if (year) q[kind === "tv" ? "first_air_date_year" : "year"] = year;
        const r = await api.tmdb(`/search/${kind}`, q); await api.pause(120);
        const hit = (r.results || []).find((x) => x.poster_path === poster);
        if (hit) { chosen = await api.tmdb(`/${kind}/${hit.id}`); await api.pause(120); }
      }
    } catch (e) { console.warn(`  legacy lookup ${code}/${slug}: ${e.message}`); }

    if (!chosen) {
      // Can't prove which film this is — remove what is false rather than guess.
      const n = neutralizeCrossCountry(html, cfg, title || slug);
      if (n.changed) { fs.writeFileSync(p, n.html); neutralized++; if (m[slug]) m[slug].last = today; }
      continue;
    }
    try {
      const d0 = { ...chosen, genre_ids: (chosen.genres || []).map((g) => g.id) };
      const item = { ...baseItem(d0, kind) };
      Object.assign(item, await api.enrich(kind, chosen.id, cfg.watchRegion));
      withImdb(item);
      await api.pause(120);
      item.slug = slug;
      const providers = Array.isArray(item.providers) ? item.providers : [];
      item.platform = providers[0] || null;
      let page = buildFilmPage(item, today, have, cfg, filmIndex);
      page = archivePatchHtml(page, countryName, cfg).html;   // it is a frozen page: past tense
      fs.writeFileSync(p, page);
      m[slug] = { ...(m[slug] || {}), last: today, archivedOn: (m[slug] && m[slug].archivedOn) || today,
        pv: ARCHIVE_PATCH_VERSION, tmdbId: item.tmdbId, released: item.released || null,
        lang: item.language || null, kind, title: item.title, repairedOn: today };
      rebuilt++;
    } catch (e) { console.warn(`  legacy rebuild ${code}/${slug}: ${e.message}`); }
  }
  if (rebuilt || neutralized) console.log(`  legacy repair [${code}]: ${rebuilt} rebuilt for ${countryName}, ${neutralized} neutralized`);
  return rebuilt + neutralized;
}

// ============================================================================
// FILM-PAGE ARCHIVE — makes the long tail honest instead of stale. Film pages
// stay on disk (and in the sitemap) forever after a title leaves the weekly
// list, which is exactly right for late queries like "X ott release date" —
// but until now an archived theatrical page claimed "It's in theatres now"
// indefinitely, and every old page reported lastmod=today (which teaches
// Google to distrust the sitemap's lastmod entirely).
// pages-manifest.json (committed) tracks per country: slug -> { last: date
// last listed, archivedOn?: date }. On the run where a title leaves the list,
// its page gets a ONE-TIME honesty patch (theatrical-run claims -> past tense
// + an OTT-arrival pointer) and then freezes; lastmod reports the truth. If a
// title RETURNS to the list (e.g. its OTT arrival — first-seen tracking's
// specialty), generatePages rewrites the page fresh and the archive mark is
// cleared. The patch phrases are generated by buildVerdictProse/buildFaqs, and
// a sync-guard test asserts patcher and generator stay in step.
// ============================================================================
const PAGES_MANIFEST_FILE = "pages-manifest.json";

// Pure: one-time honesty rewrite for a page whose film has left the list.
// Returns { html, changed }. No-op for OTT pages (their availability claims stay valid).
// Bump when new patch patterns are added: already-archived pages get one re-sweep so
// the fix reaches pages frozen before the pattern existed.
// Bumped to 4 for the title-length sweep: pv-stamped pages below this version get one
// re-pass so the archive picks up the 60-char cascade it was written before.
// 5: one-time re-sweep of the whole archive for the Sept 2026 meta-description rewrite.
// Bumping this is what actually ships the CTR fix — frozen pages are otherwise never touched.
// 6: strip aggregateRating from frozen JSON-LD. The live builder dropped it (see the Movie
//    schema note in buildFilmPage) but 325 archived pages froze before that change and still
//    mark up TMDB numbers as a site rating — GSC was still reporting a Review snippet
//    appearance in Sept 2026 because of them.
// 7: retitle sweep. The "OTT Release Date" title shape is now reserved for pages that can
//    answer it (see filmTitleTag); frozen pages written under the old rule need the one-time
//    pass or the change reaches only the ~5% of films in a current list.
// 8: analytics sweep. The archive is never regenerated, so frozen pages would otherwise be
//    the only pages on the site that aren't measured — and they are most of the traffic.
// 9: freshness sweep (Sept 2026 audit). Frozen pages past their release date still carried
//    pre-release copy (settleReleasedCopy, 118 pages); "in theatres now" survived on 270
//    pages whose country name didn't match the literal swaps, India's "OTT" wording on 358
//    pages in streaming markets, raw ISO header dates on 650, expired window estimates on 2
//    (freshenFrozenCopy).
// 10: run-state sweep. Frozen pages past release now say whether the film may still be in
//     cinemas (theatreRunState), and pages stamped "Theatrical run ended" inside the run
//     window — often on their release day — are corrected.
// 11: catalogue pages were stamped current at birth and never swept, so 50 of them still said
//     "on offer right now". One sweep for the ones already built; new ones are now written
//     through the chain (see backfillCatalog). Also carries the dead-hub-link and title-ladder
//     changes to frozen pages.
// 12: frozen pages for films not yet released in their country get the release-date title
//     (see filmTitleTag); the due pass switches them back on release day.
const ARCHIVE_PATCH_VERSION = 12;

// Verdict openers keyed to list-recency ("brand new to the list", "only just landed")
// or the future ("on the calendar") read as broken on a page someone opens years after
// the film left the list. At freeze, each becomes its past-tense, timeless equivalent.
// SYNC: one pattern per time-relative variant in buildVerdictProse — the sync test
// builds every variant, patches it, and asserts nothing time-relative survives.
// Patterns run on escaped HTML, so apostrophes appear as &#39;.
const ARCHIVE_LEAD_SWAPS = [
  // unrated, just landed
  [/is a fresh ([^<]{0,40}?)(film|series) that&#39;s only just landed, so ratings are still settling\./g,
   "is a $1$2 that left our list before ratings settled \u2014 too few votes for a firm verdict."],
  [/has only just arrived, so ratings for the ([^<]{0,60}?) are still finding their level\./g,
   "left our list before ratings for the $1 found their level \u2014 too few votes for a firm verdict."],
  [/is brand new to the list \u2014 too early for the numbers on this ([^<]{0,60}?) to mean much yet\./g,
   "left our list before the numbers on this $1 settled \u2014 too few votes for a firm verdict."],
  // unrated and no longer recent (tracked titles that never drew votes)
  [/hasn&#39;t gathered enough ratings yet for a firm read on this ([^<]{0,60}?)\./g,
   "never gathered enough ratings for a firm read on this $1 while it was on our list."],
  [/is still short of the ratings needed to call this ([^<]{0,60}?) either way\./g,
   "stayed short of the ratings needed to call this $1 either way."],
  [/are still too thin to say where this ([^<]{0,60}?) lands\./g,
   "stayed too thin to say where this $1 lands."],
  // upcoming that never arrived (or left before release)
  [/is one of the more anticipated ((?:[^<]{0,30}? )?)releases on the calendar\./g,
   "was one of the more anticipated $1releases while it was on our radar."],
  [/sits high on the ((?:[^<]{0,30}? )?)watchlist for the weeks ahead\./g,
   "sat high on the $1watchlist while it was on our radar."],
  [/is the kind of ((?:[^<]{0,30}? )?)release people circle on the calendar\./g,
   "was the kind of $1release people circle on the calendar."],
  // top band "now"-phrasing
  [/lands among the stronger ([^<]{0,50}?) on offer right now/g,
   "landed among the stronger $1 of its release window"],
  [/stands out as one of the better-rated ([^<]{0,50}?) around at the moment/g,
   "stood out as one of the better-rated $1 of its release window"],
  [/ranks near the top of the current ([^<]{0,50}?) crop/g,
   "ranked near the top of that week&#39;s $1 crop"],
];

// Rewrite an over-long <title> (and its og:title twin) on a page already on disk.
//
// Film pages are only regenerated while the film is in a current list. Once it leaves, the
// page is frozen — so every template improvement reaches only the ~5% of pages live that
// week, and the archive keeps whatever was correct on the day it was written. The 60-char
// title cascade shipped in August; 115 of 115 July pages are still stamped with the old
// long form and would have stayed that way permanently.
//
// This reconstructs the film's own name from the frozen title by stripping the known
// suffixes, then re-runs the same cascade the live builder uses. No TMDB call — everything
// needed is already in the string. Pages already inside the budget are left untouched.
const TITLE_SUFFIXES = [
  / — Review, Rating & Where to Watch in .+? \| FilmyChill$/,
  / — Review, Rating & Where to Watch in .+?$/,
  / — Review & Where to Watch in .+?$/,
  / — Review & Where to Watch$/,
  / — Where to Watch in .+? \| FilmyChill$/,
  / — Where to Watch in .+?$/,
  / — Where to Watch$/,
  / — Review$/,
  / (?:OTT Release Date|Streaming Release Date), Review & Where to Watch \| FilmyChill$/,
  / (?:OTT Release Date|Streaming Release Date), Review & Where to Watch$/,
  / (?:OTT Release Date|Streaming Release Date) & Review$/,
  / (?:OTT Release Date|Streaming Release Date)$/,
];
function shortenTitleTag(html, countryName, cfg = null) {
  const TITLE_BUDGET = 60;
  const m = html.match(/<title>([\s\S]*?)<\/title>/);
  if (!m) return { html, changed: false };
  const decode = (t) => t.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const current = decode(m[1]);
  if (current.length <= TITLE_BUDGET) return { html, changed: false };

  let stem = current;
  for (const re of TITLE_SUFFIXES) {
    if (re.test(stem)) { stem = stem.replace(re, ""); break; }
  }
  // No recognised suffix means an unknown shape — leave it alone rather than mangle it.
  if (stem === current || !stem.trim()) return { html, changed: false };

  const V = streamVocab(cfg);
  const wasOtt = /(?:OTT|Streaming) Release Date/.test(current);
  const opts = wasOtt
    ? [`${stem} ${V.titleFragment}, Review & Where to Watch | FilmyChill`,
       `${stem} ${V.titleFragment}, Review & Where to Watch`,
       `${stem} ${V.titleFragment} & Review`,
       `${stem} ${V.titleFragment}`]
    : [`${stem} — Review, Rating & Where to Watch in ${countryName} | FilmyChill`,
       `${stem} — Review, Rating & Where to Watch in ${countryName}`,
       `${stem} — Review & Where to Watch in ${countryName}`,
       `${stem} — Where to Watch in ${countryName}`,
       `${stem} — Where to Watch`];
  const next = opts.find((t) => t.length <= TITLE_BUDGET) || opts[opts.length - 1];
  // Never lengthen. When the film's own name already exceeds the budget there is nothing
  // left to trim, and the shortest cascade option can still come out longer than whatever
  // was frozen on the page. Leaving the original alone is the right answer there.
  if (next === current || next.length >= current.length) return { html, changed: false };

  const esc = escHtml(next);
  let out = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc}</title>`);
  out = out.replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc}$2`);
  return { html: out, changed: true };
}

// ============================================================================
// FROZEN-PAGE DESCRIPTION REWRITE — without this, the CTR fix reaches almost nobody.
//
// Film pages freeze the moment a film leaves the weekly lists (see shortenTitleTag's note:
// template improvements reach "only the ~5% of pages live that week"). Verified: a full
// PAGES_ONLY=all rebuild on 14 Sept 2026 rewrote hubs, feeds and browse indexes and left all
// 1,546 film pages byte-identical. Every impression in the GSC window that made this fix
// worth doing comes from pages that froze weeks ago, so shipping the new builder alone would
// have changed nothing measurable.
//
// Everything needed is already in the HTML — no TMDB call, no data.json lookup. JSON-LD
// carries name/inLanguage/datePublished/duration/genre; the visible strip carries the star
// rating; the SW markers carry the streaming state; the where-to-watch pills carry providers
// and rent/buy. Reconstruct a synthetic item, run the SAME filmMetaDescription the live
// builder uses, and swap the description and its og: twin.
// ============================================================================
function frozenFilmFacts(html) {
  const m = html.match(/<script type="application\/ld\+json">(\{"@context[^<]*?"@type":"(?:Movie|TVSeries)"[\s\S]*?)<\/script>/);
  if (!m) return null;
  let ld;
  try { ld = JSON.parse(m[1]); } catch { return null; }
  if (!ld.name) return null; // unrecognised shape — leave the page alone rather than mangle it
  const dur = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(ld.duration || "");
  const star = /\u2605\s*([0-9]+(?:\.[0-9])?)/.exec(html);
  // The pill block under "Where to watch" holds subscription providers first, then a
  // "Rent or buy" sub-heading and its own pills. Split on that label rather than guessing.
  const wtw = /<h2>Where to watch[^<]*<\/h2>([\s\S]{0,900}?)(?:<h2|<footer)/.exec(html);
  const chunk = wtw ? wtw[1] : "";
  const cut = chunk.indexOf("Rent or buy");
  const pillsIn = (t) => [...t.matchAll(/<span class="pill">([^<]+)<\/span>/g)].map((x) => x[1].trim());
  const subPills = pillsIn(cut >= 0 ? chunk.slice(0, cut) : chunk);
  const rentBuy = cut >= 0 ? pillsIn(chunk.slice(cut)) : [];
  // "In theatres", "In cinemas from …" and the archive patcher's "Theatrical run ended — …"
  // are status pills, not platforms.
  const statusPill = /theatre|cinema|Theatrical run/i;
  const providers = subPills.filter((p) => !statusPill.test(p));
  const pending = /<!--SW:pending-->/.test(html);
  const gone = /<!--SW:gone=/.test(html);
  const dig = /<!--SW:digital=(\d{4}-\d{2}-\d{2})\|([^>]*?)-->/.exec(html);
  const runEnded = /Theatrical run ended/.test(html);
  const runOpen = OPEN_PILL_RE.test(html);
  return {
    gone,
    runEnded,
    runOpen,
    item: {
      title: ld.name,
      kind: ld["@type"] === "TVSeries" ? "tv" : "movie",
      language: ld.inLanguage || "",
      genre: ld.genre || "",
      released: String(ld.datePublished || "").slice(0, 10),
      runtime: dur ? (Number(dur[1] || 0) * 60 + Number(dur[2] || 0)) : null,
      // The star only renders once the page's own confidence gate has passed, so a visible
      // rating is already vote-qualified. votes is set past the gate to say so.
      rating: star ? Number(star[1]) : null,
      votes: star ? 999 : 0,
      providers,
      ...(dig ? { digitalDate: dig[1], ...(dig[2] ? { digitalNote: dig[2].replace(/&amp;/g, "&") } : {}) } : {}),
      rentBuy,
      platform: providers.length ? providers[0] : (gone ? "" : (pending || runEnded || runOpen ? "Theatres" : "")),
    },
  };
}

// Returns {html, changed} like the other patchers. Never lengthens past the snippet budget,
// never writes when the parse failed, never writes when the result is identical.
function rewriteMetaDescription(html, cfg = null) {
  const cur = /<meta name="description" content="([^"]*)"/.exec(html);
  if (!cur) return { html, changed: false };
  const facts = frozenFilmFacts(html);
  if (!facts) return { html, changed: false };
  const next = filmMetaDescription(facts.item, cfg, { runEnded: facts.runEnded, runOpen: facts.runOpen, gone: facts.gone });
  const esc = escHtml(next);
  if (!next || next.length < 20 || esc === cur[1]) return { html, changed: false };
  let out = html.replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc}$2`);
  out = out.replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc}$2`);
  return { html: out, changed: true };
}

// Pure: remove "aggregateRating":{...} from JSON-LD on a frozen page. The object is flat
// (@type/ratingValue/ratingCount/bestRating), so a no-nested-braces match is exact; the
// surrounding comma is consumed on whichever side carries it so the JSON stays valid.
function stripAggregateRating(html) {
  if (!html.includes('"aggregateRating"')) return { html, changed: false };
  const out = html
    .replace(/,"aggregateRating":\{[^{}]*\}/g, "")
    .replace(/"aggregateRating":\{[^{}]*\},?/g, "");
  return { html: out, changed: out !== html };
}

// Retitle a FROZEN page whose title was written under the old availability rule (see
// filmTitleTag). Frozen pages are never regenerated, so without this the 1,289 archived pages
// keep promising an "OTT Release Date" they cannot supply — which is the bulk of the traffic
// the rule change is meant to fix. Everything needed is already in the HTML: frozenFilmFacts
// reads the provider pills, so the same rule decides the same way it does on a live render.
// Only <title> is touched; og:title carries the "— FilmyChill verdict" social form.
function retitleFrozen(html, cfg = null) {
  const cur = /<title>([\s\S]*?)<\/title>/.exec(html);
  if (!cur) return { html, changed: false };
  const facts = frozenFilmFacts(html);
  if (!facts) return { html, changed: false };
  const next = filmTitleTag(facts.item, cfg);
  const esc = escHtml(next);
  if (!next || esc === cur[1]) return { html, changed: false };
  return { html: html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc}</title>`), changed: true };
}

// Frozen pages need the analytics tag too, or the measurement misses exactly the pages that
// get the traffic: 1,289 of the ~1,600 film pages are archived and are never regenerated, and
// they are where most search visitors land. Adds the tag and widens the page's CSP to allow
// it; with GC_SITE off it does the reverse, so the kill switch reaches the archive as well.
function ensureAnalytics(html) {
  const has = html.includes("gc.zgo.at/count.js");
  if (!GC_SITE) {
    if (!has) return { html, changed: false };
    const host = "https://[a-z0-9-]+\\.goatcounter\\.com";
    let out = html.replace(/<script data-goatcounter="[^"]*"[^>]*><\/script>\n?/g, "");
    out = out.replace(/ https:\/\/gc\.zgo\.at/g, "").replace(new RegExp(` ${host}`, "g"), "");
    return { html: out, changed: out !== html };
  }
  if (has) return { html, changed: false };
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  if (!m) return { html, changed: false };   // unknown shape — leave the page alone
  const next = `<meta http-equiv="Content-Security-Policy" content="${cspWith(m[1])}">${analyticsTag()}`;
  const out = html.replace(m[0], next);
  return { html: out, changed: out !== html };
}

// ============================================================================
// FROZEN-PAGE FRESHNESS, PART 2 — the phrasings the name-literal swaps never matched.
//
// archivePatchHtml's theatrical swaps compare exact strings built from TODAY's country
// name. Pages frozen under older templates used other forms of the same name ("United
// States" vs "the US"), or were written before the per-country vocabulary split, so the
// swaps silently missed them. Sept 2026 audit, after every earlier sweep:
//   270 frozen pages still said a film was "in theatres … now" months after its run.
//   358 pages in "streaming" markets still used India's "OTT" template wording.
//   650 page headers showed a raw ISO date ("Released 2026-06-12").
//     2 pages still offered a streaming-window estimate whose window had already ended.
// Every rule below matches the page's own template sentence, in both the HTML-escaped
// (&#39;) and JSON-LD (') forms, and only when the named country is THIS edition's country
// in one of its name forms. A sentence naming a different country is not a tense problem —
// the page was built with the wrong market's data, and repairLegacyPage handles that.
// ============================================================================
function countryNameForms(cfg) {
  const code = (cfg && cfg.code) || "in";
  const c = COUNTRIES.find((x) => x.code === code) || {};
  const forms = new Set([c.name, (COUNTRY_PAGE_META[code] || {}).name, countryNameFor(cfg)].filter(Boolean));
  for (const f of [...forms]) { forms.add(f.replace(/^the /, "")); if (!/^the /.test(f) && /^(US|UK|UAE|Philippines)$/.test(f)) forms.add(`the ${f}`); }
  if (code === "us") forms.add("United States").add("the United States");
  if (code === "uk") forms.add("United Kingdom").add("the United Kingdom");
  return [...forms].sort((a, b) => b.length - a.length);   // longest first: "the US" before "US"
}
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function freshenFrozenCopy(html, { countryName, cfg = null, now = Date.now() } = {}) {
  const code = (cfg && cfg.code) || "in";
  const V = streamVocab(cfg);
  const names = countryNameForms(cfg).map(reEsc).join("|");
  const country = countryName || countryNameFor(cfg);
  const A = "(?:'|&#39;)";
  const ap = (m) => (m.includes("&#39;") ? "&#39;" : "'");
  let out = html;

  // Theatrical present tense, any name form of THIS country.
  out = out.replace(new RegExp(`It${A}s in theatres in (?:${names}) now — best caught on the big screen\\.`, "g"),
    (m) => `It had its theatrical run in ${escHtml(country)} — check back here for its ${V.arrival}.`);
  out = out.replace(new RegExp(`is currently playing in theatres across (?:${names})\\. An? (?:OTT|streaming) release hasn${A}t been announced yet\\.`, "g"),
    (m) => `has finished its theatrical run in ${m.includes("&#39;") ? escHtml(country) : country}. Its ${V.release} hasn${ap(m)}t been announced yet — check back soon.`);

  // India's vocabulary on a "streaming" market — template phrases only, never film titles.
  if (V.word !== "OTT") {
    out = out
      .replace(/Theatrical run ended — OTT arrival pending/g, `Theatrical run ended — ${V.arrival} pending`)
      .replace(/check back here for its OTT arrival/g, `check back here for its ${V.arrival}`)
      .replace(/\bAn OTT release hasn(?:'|&#39;)t been announced yet/g, (m) => `A streaming release hasn${ap(m)}t been announced yet`)
      .replace(/\bIts OTT release hasn(?:'|&#39;)t been announced yet/g, (m) => `Its streaming release hasn${ap(m)}t been announced yet`)
      .replace(/\bAn OTT release date for /g, "A streaming release date for ")
      .replace(/\bOTT releases typically reach streaming/g, "releases typically reach streaming")
      // The FAQ question itself, frozen with India's doubled phrasing — in the visible
      // <summary> and in the FAQPage schema's "name", both of which Google shows.
      .replace(/When is ([^<"?]+?) releasing on OTT\? \(OTT release date\)/g, (m, t) => V.faqQuestion(t));
  }

  // "Released 12 Jun 2025 2025": the year printed twice by an earlier date fix (fmtDateShort
  // already includes the year for past-year dates). Both locale shapes: "12 Jun 2025 2025" and
  // "Jun 12, 2025 2025". Only a day-month-year followed by the same year matches.
  out = out.replace(/\b(\d{1,2} [A-Z][a-z]{2,4} (\d{4})) \2\b/g, "$1")
    .replace(/\b([A-Z][a-z]{2,4} \d{1,2}, (\d{4})) \2\b/g, "$1");
  // "Page updated 2026-08-26" -> the edition's date format. Cosmetic: visibleText ignores this
  // line, so reformatting it never counts as a content change for the sitemap.
  out = out.replace(/(<div class="meta" style="margin-top:2px;font-size:12\.5px">Page updated )(\d{4}-\d{2}-\d{2})(<\/div>)/,
    (m, a, iso, b) => `${a}${escHtml(fmtDateFull(iso, localeFor(code)))}${b}`);
  out = out.replace(/Availability as of (\d{4}-\d{2}-\d{2}) — /g,
    (m, iso) => `Availability as of ${escHtml(fmtDateFull(iso, localeFor(code)))} — `);
  // Header date: raw ISO -> the edition's human date.
  out = out.replace(/(<div class="meta" style="margin-top:8px">)(Released|Releases) (\d{4}-\d{2}-\d{2})(<\/div>)/,
    (m, a, verb, iso, b) => `${a}${verb} ${escHtml(fmtDateFull(iso, localeFor(code)))}${b}`);

  // A streaming-window estimate whose window has already closed is no longer a pattern, it is
  // a missed prediction. Drop the clause; the "not announced" sentence around it stays true.
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  out = out.replace(/ ([A-Za-z]+ )?releases typically reach streaming about \d+–\d+ weeks after their theatrical run, which would put it around (?:(\w+) (\d{4}) and )?(\w+) (\d{4}) — that(?:'|&#39;)s a pattern, not a confirmed date\./g,
    (m, _lang, _m1, _y1, m2, y2) => {
      const idx = MONTHS.indexOf(m2);
      if (idx < 0) return m;
      const end = Date.UTC(Number(y2), idx + 1, 1);          // first day after the window
      return now >= end ? "" : m;
    });
  return { html: out, changed: out !== html };
}

// Visible text of a page, for deciding whether a patch changed what a reader sees. A patch
// that only touches markup (an analytics tag, a CSP) must not move the sitemap's lastmod;
// one that corrects a sentence must, or Google keeps serving the stale snippet for months.
function visibleText(html) {
  return String(html).replace(/<div class="meta" style="margin-top:2px;font-size:12\.5px">Page updated [^<]*<\/div>/g, "").replace(/<script(?![^>]*application\/ld)[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function archivePatchHtml(html, countryName, cfg = null) {
  const V = streamVocab(cfg);
  // Pages frozen BEFORE the per-country vocabulary split carry India's "OTT" wording
  // in every market, so we match both the country's current word and the legacy one.
  // Replacements always use the country's current vocabulary.
  const variants = [
    { article: "An", release: "OTT release", arrival: "OTT arrival" },
    { article: "A", release: "streaming release", arrival: "streaming arrival" },
  ];
  const swaps = [
    [`It&#39;s in theatres in ${countryName} now — best caught on the big screen.`,
     `It had its theatrical run in ${countryName} — check back here for its ${V.arrival}.`],
    [`<span class="pill">In theatres</span>`,
     `<span class="pill">Theatrical run ended — ${V.arrival} pending</span>`],
  ];
  for (const v of variants) {
    swaps.push([
      `is currently playing in theatres across ${countryName}. ${v.article} ${v.release} hasn&#39;t been announced yet.`,
      `has finished its theatrical run in ${countryName}. Its ${V.release} hasn&#39;t been announced yet — check back soon.`,
    ]);
  }
  let out = html, changed = false;
  for (const [from, to] of swaps) {
    if (out.includes(from)) { out = out.split(from).join(to); changed = true; }
  }
  for (const [re, to] of ARCHIVE_LEAD_SWAPS) {
    if (re.test(out)) { out = out.replace(re, to); changed = true; }
    re.lastIndex = 0; // global regexes are stateful across .test/.replace calls
  }
  const r = stripAggregateRating(out);
  if (r.changed) { out = r.html; changed = true; }
  const rt = retitleFrozen(out, cfg);
  if (rt.changed) { out = rt.html; changed = true; }
  const an = ensureAnalytics(out);
  if (an.changed) { out = an.html; changed = true; }
  const st = settleReleasedCopy(out, { countryName, cfg });
  if (st.changed) { out = st.html; changed = true; }
  const fz = freshenFrozenCopy(out, { countryName, cfg });
  if (fz.changed) { out = fz.html; changed = true; }
  const t = shortenTitleTag(out, countryName, cfg);
  if (t.changed) { out = t.html; changed = true; }
  // Runs LAST, after the body swaps above have set "Theatrical run ended" — frozenFilmFacts
  // reads that marker to decide between "in cinemas" and "theatrical run over", so ordering
  // here is load-bearing.
  const d = rewriteMetaDescription(out, cfg);
  if (d.changed) { out = d.html; changed = true; }
  return { html: out, changed };
}

// Pure-ish: reconcile one country's manifest with today's reality. Bumps `last` for
// current slugs (clearing any archive mark — the page was just regenerated fresh),
// and returns the slugs that need the one-time archive patch (on disk, not current,
// not yet archived). Mutates manifest[code]; caller persists.
function reconcilePagesManifest(manifest, code, currentSlugs, diskSlugs, todayStr, meta = null) {
  const m = (manifest[code] = manifest[code] || {});
  for (const slug of currentSlugs) {
    const entry = (m[slug] = m[slug] || {});
    entry.last = todayStr;
    // Stamp what the refresh sweep will need once this page freezes: TMDB id to
    // re-query providers, release date + language to decide whether it's still
    // inside a plausible streaming window. Recorded while current, kept after.
    const info = meta && meta[slug];
    if (info) {
      if (info.tmdbId) entry.tmdbId = info.tmdbId;
      if (info.released) entry.released = info.released;
      if (info.language) entry.lang = info.language;
      if (info.kind) entry.kind = info.kind;
      if (info.title) entry.title = info.title;
    }
    delete entry.archivedOn;
  }
  // Entries that lost `last` to an old bug (a function was stored instead of a date, and
  // JSON.stringify dropped it) fall back to their freeze date — the truest date available.
  for (const e of Object.values(m)) if (e && !e.last && e.archivedOn) e.last = e.archivedOn;
  const toArchive = [];
  for (const slug of diskSlugs) {
    if (currentSlugs.has(slug)) continue;
    const entry = (m[slug] = m[slug] || { last: todayStr });
    if (!entry.archivedOn) { entry.archivedOn = todayStr; toArchive.push(slug); }
  }
  return toArchive;
}

module.exports = {
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
  reEsc,
  repairLegacyPages,
  retitleFrozen,
  rewriteMetaDescription,
  shortenTitleTag,
  stripAggregateRating,
  visibleText,
};
