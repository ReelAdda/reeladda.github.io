// ============================================================================
// surfaces.js — each country's homepage and shared page chrome: head tags, JSON-LD,
// footer, hero, pick of the week, the /data/ page, the About page, and writeCountrySurfaces().
// ============================================================================
"use strict";

const fs = require("fs");
const {
  COUNTRIES,
  COUNTRY_FLAG,
  COUNTRY_PAGE_META,
  LANGUAGE_PAGES,
  escHtml,
  filmPageUrl,
  localeFor,
} = require("./core.js");
const { readHistory, streamingWindowDays, windowStats, monthKey } = require("./history.js");
const { writeEmbed } = require("./embed.js");
const { browsePath, filmIndexFor, writeBrowseIndex } = require("./graph.js");
const { normalizeUpcoming } = require("./release.js");
const {
  comingPath,
  comingUrl,
  todayPath,
  todayUrl,
  writePlatformHubPages,
} = require("./dated.js");
const { freshnessWindowLabel } = require("./freshness.js");
const {
  hubsFor,
  writeLanguageMonthPages,
  writeOttMonthPages,
  writeOttWeekPage,
  writePlatformMonthPages,
} = require("./hubs.js");
const { refreshDuePages } = require("./lifecycle.js");
const {
  analyticsTag,
  cspWith,
  footerAttribution,
  hubOgImage,
  isoWeekOf,
  ogImageTag,
  ottMonthPath,
  STREAM_BASE,
  weekRangeFor,
  weekSlug,
} = require("./pagekit.js");
const {
  countryListForProse,
  countryNameFor,
  LANG_CODE_BY_NAME,
  OTT_FRESH_DAYS,
  replaceBetween,
  streamVocab,
} = require("./rules.js");
const { stageFailed } = require("./runhealth.js");
const { USE_IMDB } = require("./tmdb.js");
const { ssrCard, ssrEditorNote, ssrSoonCard, writeRssFeed } = require("./weekly.js");

// About page lastmod for the sitemap — bump manually when about/index.html changes.
const ABOUT_LASTMOD = "2026-09-14";

// The About page is hand-written, but ONE sentence in it is a fact the config owns: which
// countries the site covers. It drifted — the page still said "India (plus the US, UK,
// Australia and Germany)" three markets after UAE, Canada and Singapore shipped, which is a
// factual error on the page whose entire job is being trustworthy. The list now lives behind
// an SSR marker and is refilled from COUNTRIES on every run, so adding a market updates the
// page for free. replaceBetween throws on a missing marker, so a broken template fails the
// build rather than silently shipping. Absent file = nothing to do (the sitemap already
// treats about/ as optional).
function patchAboutPage() {
  const p = "about/index.html";
  if (!fs.existsSync(p)) return;
  const html = fs.readFileSync(p, "utf8");
  let next = replaceBetween(html, "COUNTRIES", countryListForProse());
  // The About page is hand-written, not generated, so the analytics tag is patched in here —
  // otherwise it would be the one page the GC_SITE kill switch can't reach.
  next = replaceBetween(next, "ANALYTICS", analyticsTag());
  if (next !== html) { fs.writeFileSync(p, next); console.log("About: refreshed"); }
}

// RECOGNITION score for the homepage meta description's marquee names.
// The description names two films, and those names are the only concrete hook in the whole
// string — everything after the dash is boilerplate every aggregator prints. Rail position
// answers "what did the ranker score highest"; the description needs "whose NAME will a
// searcher in THIS market recognise", which is a different question. Taking theatres[0] and
// ott[0] conflated the two: India's live description read "This week: Tony, Crew Girl" — an
// English indie and a teen rowing drama — while Mirzapur: The Movie and Toxic, the two names
// an Indian searcher actually knows, sat further down the same rails. The cost is highest on
// share previews (WhatsApp, Instagram), which render this string verbatim with no rewrite.
// Signals, in weight order:
//   • local language — a priorityLangs title for this market, decaying by priority rank
//   • Wikipedia weekly pageviews — a direct "people are looking this name up" measure
//   • the trending flag, then TMDB popularity as the fallback when pageview data is absent
// Country-generic by construction: India scores Hindi/Tamil/Telugu up, the US English and
// Spanish, Germany German. Both count terms are log-scaled so one huge number can't swamp
// the rest, and an item with no signals scores 0 — which preserves rail order (see pick).
function marqueeScore(it, cfg) {
  if (!it) return -Infinity;
  const full = (cfg && COUNTRIES.find((c) => c.code === cfg.code)) || cfg || null;
  const pri = (full && full.priorityLangs) || [];
  const idx = pri.indexOf(LANG_CODE_BY_NAME[it.language] || "\u0000");
  return (idx === -1 ? 0 : 6 - idx * 1.5)            // 6 / 4.5 / 3 by priority rank
    + Math.log10(1 + (it.wikiWeeklyViews || 0))      // ~0..6
    + (it.trending ? 2 : 0)
    + Math.log10(1 + (it.popularity || 0)) * 0.5;    // ~0..1.5
}
// Most recognisable title in a rail. Strict > keeps the rail's own order on ties, so a cold
// cache, a market with no pageview data, or a partial cfg falls back to today's behaviour.
function marqueePick(list, cfg) {
  const arr = (list || []).filter(Boolean);
  if (!arr.length) return null;
  let best = arr[0], bestScore = marqueeScore(arr[0], cfg);
  for (const it of arr) {
    const s = marqueeScore(it, cfg);
    if (s > bestScore) { best = it; bestScore = s; }
  }
  return best;
}

// PICK OF THE WEEK (Sept 2026). The old rule — highest raw rating among "recent" titles —
// crowned the same anime in 11 of 14 markets: "recent" meant newly ADDED to a platform (a
// March season listed in September counted), and enthusiast fan bases top TMDB's ratings.
// Now: (1) actually new — released or premiered within PICK_FRESH_DAYS; (2) ranked by the
// FilmyChill Score, so the hero always agrees with the score boxes below it; (3) ties go to
// what THIS market recognises (marqueeScore: its own languages, Wikipedia lookups,
// trending); then rating. Returns null when nothing qualifies — the caller keeps the old
// pick as the fallback, so there is always a Pick of the Week.
const PICK_FRESH_DAYS = 21;
const PICK_LEVEL = { "Must watch": 2, "Worth a watch": 1 };
function choosePick(items, cfg, nowIso) {
  const now = Date.parse(nowIso || new Date().toISOString());
  const cutoff = new Date(now - PICK_FRESH_DAYS * 864e5).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  const pool = (items || []).filter((x) => {
    if (!x || !x.fcScore || !PICK_LEVEL[x.fcScore.verdict]) return false;
    const d = String(x.freshDate || x.released || "").slice(0, 10);
    return d >= cutoff && d <= today;
  });
  pool.sort((a, b) => PICK_LEVEL[b.fcScore.verdict] - PICK_LEVEL[a.fcScore.verdict]
    || marqueeScore(b, cfg) - marqueeScore(a, cfg)
    || (b.rating || 0) - (a.rating || 0));
  return pool[0] || null;
}

function buildHeadTags(cfg, useImdb = USE_IMDB, data = null) {
  const m = COUNTRY_PAGE_META[cfg.code] || { name: cfg.name, path: `/${cfg.code}/` };
  const url = `https://filmychill.com${m.path}`;
  // The market's own word for streaming. India/UAE say "OTT"; a US, UK, German,
  // Australian, Canadian or Singaporean searcher says "streaming" and would read
  // "OTT" as jargon (or not at all) — so the title tag, description and share
  // copy below are all built from V rather than a hardcoded "OTT".
  const V = streamVocab(cfg);

  // SERP click-through: when this run's data is passed, the title carries the live month
  // (freshness a searcher can SEE in the results page) and the description leads with real
  // film names — a searcher choosing between ten generic "latest OTT releases" links clicks
  // the one showing titles they recognise. Without data (tests/legacy calls), the static
  // wording below is used unchanged.
  let dynTitle = null, dynDesc = null;
  if (data) {
    const monthYear = new Date(data.generatedAt || Date.now())
      .toLocaleDateString(localeFor(cfg.code), { month: "long", year: "numeric" });
    const monthShort = new Date(data.generatedAt || Date.now())
      .toLocaleDateString(localeFor(cfg.code), { month: "short", year: "numeric" });
    // The live homepage title ran 73 characters ("New Movies & OTT Releases This Week in
    // India (September 2026) | FilmyChill"), so Google truncated it mid-month — the freshness
    // signal the month exists to carry was the part being cut. Film pages have had a 60-char
    // cascade since August; the site's single best-converting page did not. Every tier keeps
    // the month, because that is the clause earning the click.
    // Priority when trimming: the query phrase ("New Movies", "This Week"), the market's own
    // word (OTT / Streaming), the country, and the month. The brand goes first — it is the
    // only part a searcher already knows. "Releases" goes next, being the one redundant noun.
    // The week's dates first: "this week (21–27 Sept)" is visibly fresher in a results page
    // than a month, and it is how the weekly query is written. The month tiers stay as the
    // fallback for markets whose name pushes the week form past 60 characters.
    const weekRange = weekRangeFor(data.generatedAt || Date.now(), cfg.code);
    const homeTitleOpts = [
      `New Movies & ${V.Releases} This Week in ${m.name} (${weekRange})`,
      `New Movies & ${V.Word} This Week in ${m.name} (${weekRange})`,
      `New Movies This Week in ${m.name} (${weekRange})`,
      `New Movies & ${V.Releases} This Week in ${m.name} (${monthYear}) | FilmyChill`,
      `New Movies & ${V.Releases} This Week in ${m.name} (${monthYear})`,
      `New Movies & ${V.Word} This Week in ${m.name} (${monthYear})`,
      // Abbreviated month before dropping it: Singapore's long name pushed the full form past
      // the budget, and losing the month loses the freshness signal the title exists to carry.
      `New Movies & ${V.Word} This Week in ${m.name} (${monthShort})`,
      `New Movies & ${V.Word} This Week in ${m.name}`,
    ];
    dynTitle = homeTitleOpts.find((t) => t.length <= 60) || homeTitleOpts[homeTitleOpts.length - 1];
    const all = [...(data.theatres || []), ...(data.ott || [])];
    // Two marquee names: the most RECOGNISABLE theatre title and OTT title for this market
    // (see marqueeScore) rather than the top-ranked one, which answers a different question.
    const picks = [marqueePick(data.theatres, cfg), marqueePick(data.ott, cfg)].filter(Boolean);
    const names = picks.map((x) => x.title);
    const desc = (n, more) => `This week: ${n} + ${more} more — ratings, verdicts & where to watch in ${m.name}. Updated twice daily.`;
    if (names.length && all.length > names.length) {
      dynDesc = desc(names.join(", "), all.length - names.length);
      if (dynDesc.length > 158) {
        // Overflow -> keep the STRONGER name, not reflexively the theatre one: two long
        // titles used to collapse to names[0] regardless of which had earned the click.
        // Try each in recognition order; if even one name can't fit (very long title in a
        // long-named market), leave dynDesc null so the static description is used.
        dynDesc = null;
        for (const p of picks.slice().sort((a, b) => marqueeScore(b, cfg) - marqueeScore(a, cfg))) {
          const d = desc(p.title, all.length - 1);
          if (d.length <= 158) { dynDesc = d; break; }
        }
      }
    }
  }
  // Ratings wording follows the active source (same principle as footerAttribution): IMDb's
  // name may only appear when IMDb data is actually used — its terms forbid using the name
  // without a current license, and in TMDB mode the claim would simply be false. TMDB mode
  // says just "ratings": accurate, and the TMDB brand adds nothing to a search snippet.
  const ratingsWord = useImdb ? "IMDb ratings" : "ratings";
  // max-image-preview:large is REQUIRED for Google Discover eligibility — Discover is the
  // channel where daily entertainment content actually goes viral in India. One tag,
  // emitted on every page type (homepages here; film + ott-week pages set it themselves).
  const discover = `<meta name="robots" content="max-image-preview:large">`
    + `\n<link rel="alternate" type="application/rss+xml" title="FilmyChill — New Movies & ${V.Word}" href="https://filmychill.com${m.path}feed.xml">`;

  // On-page hreflang for the five homepages. Film + new-on-ott pages already emit these;
  // the homepages only declared alternates in the sitemap, which is the weaker signal —
  // without on-page tags Google can serve the Indian page to US searchers or treat five
  // near-identical homepages as competing duplicates. x-default -> India (the canonical root).
  const homeAlts = COUNTRIES.map((cc) => {
    const alt = COUNTRY_PAGE_META[cc.code] || { path: `/${cc.code}/` };
    return `<link rel="alternate" hreflang="${cc.code === "in" ? "en-IN" : "en-" + cc.region}" href="https://filmychill.com${alt.path}"/>`;
  }).join("\n") + `\n<link rel="alternate" hreflang="x-default" href="https://filmychill.com/"/>`;

  // Share/social tags: og mirrors the DYNAMIC title/description (a WhatsApp/X share should
  // show this week's real films, not a generic pitch), og:url anchors shares to the right
  // country page, og:locale marks the market, twitter:card upgrades bare links to cards.
  const ogLocale = cfg.code === "in" ? "en_IN" : "en_" + ((cfg && cfg.region) || (COUNTRIES.find((cc) => cc.code === cfg.code) || {}).region || cfg.code.toUpperCase());
  const shareTags = `<meta property="og:url" content="${url}">\n`
    + `<meta property="og:locale" content="${ogLocale}">\n`
    + `<meta name="twitter:card" content="summary_large_image">`;
  if (cfg.code === "in") {
    // Root keeps the multi-country, India-first wording as the no-data fallback.
    return `<title>${escHtml(dynTitle || `FilmyChill — Latest Movie & ${V.Releases}, with Reviews, Updated Twice Daily`)}</title>\n`
      + `<meta name="description" content="${escHtml(dynDesc) || `Latest theatre and ${V.releases} across ${countryListForProse()} — trailers, ${ratingsWord}, verdicts, auto-updated twice daily.`}">\n`
      + discover + "\n"
      + `<link rel="canonical" href="${url}">\n`
      + homeAlts + "\n"
      + `<meta property="og:title" content="${escHtml(dynTitle) || "FilmyChill — What's worth watching this week"}">\n`
      + `<meta property="og:description" content="${escHtml(dynDesc) || `Latest theatre and ${V.releases} across ${countryListForProse()} — trailers, ${ratingsWord}, verdicts. Auto-updated daily.`}">\n`
      + shareTags;
  }
  return `<title>${escHtml(dynTitle) || `FilmyChill — Latest Movie &amp; ${V.Releases} in ${m.name}, with Reviews, Updated Twice Daily`}</title>\n`
    + `<meta name="description" content="${escHtml(dynDesc) || `Latest theatre and ${V.releases} in ${m.name} on Netflix, Prime Video, Disney+ and more — trailers, ${ratingsWord}, verdicts, auto-updated twice daily.`}">\n`
    + discover + "\n"
    + `<link rel="canonical" href="${url}">\n`
    + homeAlts + "\n"
    + `<meta property="og:title" content="${escHtml(dynTitle) || `FilmyChill — What's worth watching this week in ${m.name}`}">\n`
    + `<meta property="og:description" content="${escHtml(dynDesc) || `Top theatre releases + ${V.word} picks in ${m.name} with trailers, ${ratingsWord} and verdicts. Auto-updated daily.`}">\n`
    + shareTags;
}

// Homepage structured data: WebSite + dateModified + an ItemList of this
// week's films, so crawlers see a fresh, ranked collection without running JS.
function buildHomeJsonLd(data, cfg) {
  const m = COUNTRY_PAGE_META[(cfg && cfg.code) || "in"] || { name: "", path: "/" };
  const pageUrl = `https://filmychill.com${m.path}`;
  const date = (data.generatedAt || new Date().toISOString()).slice(0, 10);
  const code = (cfg && cfg.code) || "in";
  const isIndia = code === "in";
  // Every country now has its own per-film pages, so each list item links to its real page.
  const listItems = [...(data.theatres || []), ...(data.ott || [])]
    .filter((x) => x.slug)
    .map((x, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: filmPageUrl(code, x.slug),
      name: x.title,
    }));
  const listName = isIndia ? "What's worth watching this week" : `What's worth watching this week in ${m.name}`;
  const graph = [
    {
      // Brand entity: feeds logo/knowledge-panel treatment for "filmychill" queries —
      // which (per Search Console) is most of the site's current impressions.
      "@type": "Organization",
      "@id": "https://filmychill.com/#org",
      name: "FilmyChill",
      url: "https://filmychill.com/",
      logo: { "@type": "ImageObject", url: "https://filmychill.com/icon-192.png", width: 192, height: 192 },
      sameAs: ["https://whatsapp.com/channel/0029Vb81Fe8C6ZvdMR2oxH3j"],
    },
    {
      "@type": "WebSite",
      "@id": "https://filmychill.com/#website",
      name: "FilmyChill",
      url: "https://filmychill.com/",
      publisher: { "@id": "https://filmychill.com/#org" },
      author: { "@type": "Person", name: "Vikram Sharma" },
      datePublished: "2026-01-01",
      dateModified: data.generatedAt || `${date}T00:00:00.000Z`,
    },
    {
      "@type": "ItemList",
      name: listName,
      url: pageUrl,
      dateModified: data.generatedAt || `${date}T00:00:00.000Z`,
      numberOfItems: listItems.length,
      itemListElement: listItems,
    },
  ];
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph });
}

// Render one country's page from the pristine template string and write it to its path
// (root index.html for India, <code>/index.html for others). The template is read ONCE by
// the caller and passed in, so per-country injections never stack on each other.
// SSR OTT section with the honest divider: cards in order, one "Still worth it"
// separator before the first stillGood card (only when a fresh group precedes it,
// so an all-older list never renders a heading with nothing above it).
function ssrOttSection(items, code) {
  let out = "", divided = false;
  items.forEach((x, i) => {
    if (!divided && x.stillGood && i > 0) {
      out += `<div class="ott-divider">Still worth it — standouts from earlier weeks</div>`;
      divided = true;
    }
    out += ssrCard(x, i, code);
  });
  return out;
}

// Footer cross-links, injected per country: India links its language pages and the
// current week's snapshot; every country links About. New indexable surfaces get
// crawl paths from every page on the site.
// ============================================================================
// HOMEPAGE FOOTER — four short columns and one quiet bar.
//
// It had grown into 60+ inline links in one centred block: every language, every hub, the
// month archive, twelve "newly added" titles, thirteen countries and three credit lines.
// Each link was added for a good reason (mostly crawl paths), and together they made the
// page's last impression look like a link farm. Now:
//   Discover · Streaming on · Languages (India only) · FilmyChill
// and a bottom bar with the copyright and a country picker.
//
// Crawl paths are kept, just placed where they belong:
//   - "Newly added" catalogue titles moved to the top of All films (see buildBrowsePage),
//     one link away; the Streaming-on pages also link hundreds of catalogue titles.
//   - The other countries are real <a> links inside a <details> picker: closed by default,
//     still in the HTML, still crawlable (hreflang annotates; it is not a crawl path).
// ============================================================================
function buildMoreLinks(code, data = null) {
  const e = escHtml;
  const V = streamVocab({ code });
  const base = code === "in" ? "" : `/${code}`;
  const li = (href, label) => `<li><a href="${e(href)}">${e(label)}</a></li>`;
  const col = (title, items) => items.length ? `<div><h3>${e(title)}</h3><ul>${items.join("")}</ul></div>` : "";

  const thisMonth = monthKey(new Date().toISOString());
  const discover = [
    li(`${base}/new-on-ott/`, `New on ${V.word} this week`),
    fs.existsSync(todayPath(code)) ? li(todayUrl(code).replace("https://filmychill.com", ""), `New on ${V.word} today`) : "",
    fs.existsSync(comingPath(code)) ? li(comingUrl(code).replace("https://filmychill.com", ""), `Coming to ${V.word}`) : "",
    fs.existsSync(ottMonthPath(code, thisMonth)) ? li(`${base}/new-on-ott/${thisMonth}/`, "This month") : "",
    li(browsePath(code, 1), "All films"),
  ].filter(Boolean);

  // Evergreen platform pages first (they link into the catalogue); this week's platform hubs
  // only when a country has none yet. Four is enough for a footer.
  let platforms = streamingPagesFor(code).slice(0, 4).map((x) => li(x.href, x.name));
  if (!platforms.length && data) platforms = hubsFor(data).slice(0, 4).map((h) => li(`${base}/new-on-${h.slug}/`, h.name));

  const languages = code === "in" ? LANGUAGE_PAGES.map(([name, slug]) => li(`/${slug}/`, name)) : [];

  const site = [
    li("/about/", "About"),
    li("/data/", "Streaming data"),
    code === "in" ? li("/embed/", "Embed widget") : "",
    code === "in" ? li(`/week/${weekSlug(isoWeekOf())}/`, "Weekly archive") : "",
    li("https://whatsapp.com/channel/0029Vb81Fe8C6ZvdMR2oxH3j", "WhatsApp channel"),
  ].filter(Boolean);

  const others = COUNTRIES.filter((c) => c.code !== code).map((c) => {
    const meta = COUNTRY_PAGE_META[c.code] || { name: c.name, path: `/${c.code}/` };
    return `<a href="${e(meta.path)}">${e(meta.name.replace(/^the /, ""))}</a>`;
  }).join("");
  const here = COUNTRIES.find((c) => c.code === code) || { name: "India" };

  return `<nav class="foot-cols" aria-label="Site">${col("Discover", discover)}${col("Streaming on", platforms)}${col("Languages", languages)}${col("FilmyChill", site)}</nav>`
    + `<div class="foot-bar"><span>© ${new Date().getFullYear()} FilmyChill · Vikram Sharma</span>`
    + `<details class="foot-country"><summary>${e(COUNTRY_FLAG[code] || "")} ${e(here.name)}</summary><div class="foot-country-list">${others}</div></details></div>`;
}

// The platform pages that exist for this country, biggest first (read from disk: they are
// written and pruned by writeStreamingPages).
function streamingPagesFor(code) {
  const base = STREAM_BASE(code);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base)
    .filter((d) => fs.existsSync(`${base}/${d}/index.html`))
    .map((d) => {
      const html = fs.readFileSync(`${base}/${d}/index.html`, "utf8");
      const n = Number((/<h1>[^<]*<\/h1>[\s\S]*?(\d+) titles?/.exec(html) || [])[1] || 0);
      const name = ((/<h1>[^<]*? on ([^<]+?) in [^<]*<\/h1>/.exec(html) || [])[1] || d).replace(/&amp;/g, "&");
      return { href: `/${base}/${d}/`, name, n };
    })
    .sort((a, b) => b.n - a.n)
    .slice(0, 6);
}

// The newest catalogue pages for this country: a fresh set of links from the homepage every
// run, so Google meets new catalogue pages within a crawl or two instead of weeks later.
let _manifestCache = null;
function newlyAddedFor(code, max = 12) {
  if (!_manifestCache) {
    try { _manifestCache = JSON.parse(fs.readFileSync("pages-manifest.json", "utf8")); } catch { _manifestCache = {}; }
  }
  const m = _manifestCache[code] || {};
  const dir = code === "in" ? "movie" : `${code}/movie`;
  return Object.entries(m)
    .filter(([slug, e]) => e && e.catalog && e.live && fs.existsSync(`${dir}/${slug}.html`))
    .sort((a, b) => String(b[1].archivedOn || "").localeCompare(String(a[1].archivedOn || "")) || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([slug, e]) => ({ title: e.title || slug, href: `/${dir}/${slug}.html` }));
}

// ============================================================================
// writeCountrySurfaces — the ONE definition of what a country's local output is.
//
// This sequence used to exist twice: once in main() and once in the PAGES_ONLY path. They
// drifted, and the drift was silent — a call added to the wrong copy referenced a variable
// that only existed in the other, threw into a catch, and disabled the browse index on every
// live run while looking perfectly healthy. Both callers now go through here, so a step
// added once is a step that runs everywhere.
//
// Local only: no network, no API budget. Callers do the fetching and pass the data in.
// ============================================================================
// ============================================================================
// /data/ — the citable page.
//
// A dataset nobody can see is not a moat. This publishes what the archive measures, states
// the method plainly, and offers the raw CSV under attribution — the three things that make
// a number quotable by someone writing an article. Deliberately shows the sample size next
// to every median: a median of three films is not a finding, and saying so is what makes
// the rest believable.
// ============================================================================
function buildDataPage(records, updatedHuman) {
  const e = escHtml;
  const s = windowStats(records);
  const row = (r) => `<tr><td>${e(r.key)}</td><td class="n">${r.median}</td><td class="n">${r.n}</td></tr>`;
  const table = (title, rows) => !rows.length ? "" :
    `<h2>${e(title)}</h2><table><thead><tr><th>${title.includes("language") ? "Language" : "Platform"}</th>`
    + `<th class="n">Median days</th><th class="n">Films</th></tr></thead><tbody>${rows.map(row).join("")}</tbody></table>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
${analyticsTag()}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>How long films take to reach streaming — FilmyChill data</title>
<meta name="description" content="How many days films take to go from theatrical release to streaming, measured daily by FilmyChill across ${e(String(s.total))} titles in ${COUNTRIES.length} countries. Free to use with attribution.">
<link rel="canonical" href="https://filmychill.com/data/">
<meta name="robots" content="max-image-preview:large">
<meta property="og:title" content="How long films take to reach streaming — FilmyChill data">
<meta property="og:url" content="https://filmychill.com/data/">
<style>
  body { font-family: system-ui,-apple-system,sans-serif; max-width: 780px; margin: 0 auto;
         padding: 26px 18px 70px; background: #FFF7EC; color: #1A1633; line-height: 1.65; }
  h1 { font-size: 28px; margin-bottom: 6px; } h2 { font-size: 19px; margin-top: 32px; }
  .sub { color: #6B6890; font-size: 14px; }
  .big { font-size: 46px; font-weight: 800; color: #4038C7; margin: 18px 0 2px; }
  table { border-collapse: collapse; width: 100%; margin-top: 10px; font-size: 15px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #E7DFD0; }
  th { font-size: 13px; color: #6B6890; font-weight: 600; } .n { text-align: right; }
  .method { background: #fff; border-radius: 10px; padding: 14px 16px; margin-top: 26px; font-size: 14px; }
  a { color: #4038C7; } code { background: #fff; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid #E7DFD0; font-size: 13px; color: #6B6890; }
</style></head><body>
  <h1>How long does a film take to reach streaming?</h1>
  <div class="sub">Measured by FilmyChill, updated ${e(updatedHuman)} · ${e(String(s.total))} titles tracked across ${COUNTRIES.length} countries</div>

  ${s.overall != null ? `<div class="big">${s.overall} days</div>
  <div class="sub">median from theatrical release to first streaming sighting, across ${e(String(s.measured))} films with both dates known</div>` :
  `<p>Not enough measured films yet to publish a median. The archive is still filling.</p>`}

  ${table("Median window by language", s.byLanguage)}
  ${table("Median window by platform", s.byPlatform)}

  <div class="method">
    <b>Method.</b> FilmyChill checks streaming availability every day in ${COUNTRIES.length} countries and records the
    first date each film appears with a provider. The window is that date minus the film's theatrical
    release date. Straight-to-streaming titles and gaps over two years are excluded, since neither is a
    theatrical window. Groups with fewer than three films are not shown. This is a record of when a film
    became <i>visible to us</i>, which is normally the day it drops but is not a studio announcement.
  </div>

  <h2>Use the data</h2>
  <p>The full record is available as <a href="/data/streaming-windows.csv">CSV</a>, free to use for any
  purpose including commercially, with attribution to FilmyChill and a link to this page. No API key,
  no signup. If you're writing something and want a cut we don't publish here, ask.</p>

  <footer><a href="/">← FilmyChill</a> · <a href="/about/">About</a></footer>
</body></html>`;
}

function buildWindowsCsv(records) {
  const rows = [["tmdb_id", "kind", "title", "country", "platform", "theatrical_release", "first_seen_streaming", "window_days"]];
  for (const r of records) {
    const d = streamingWindowDays(r);
    if (d == null) continue;
    rows.push([r.id, r.k, `"${String(r.t || "").replace(/"/g, '""')}"`, r.c, `"${String(r.p || "").replace(/"/g, '""')}"`, r.rel, r.first, d]);
  }
  return rows.map((r) => r.join(",")).join("\n") + "\n";
}

function writeDataPage(updatedHuman) {
  const records = readHistory();
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/index.html", buildDataPage(records, updatedHuman));
  fs.writeFileSync("data/streaming-windows.csv", buildWindowsCsv(records));
  const s = windowStats(records);
  console.log(`  /data/: ${s.measured} measured window(s), median ${s.overall == null ? "n/a" : s.overall + "d"}`);
}

function writeCountrySurfaces(cfg, data, { template = null, allCountries = COUNTRIES } = {}) {
  const stamp = new Date(data.generatedAt || Date.now())
    .toLocaleDateString(localeFor(cfg.code), { day: "numeric", month: "long", year: "numeric" });
  const step = (name, fn) => {
    try { fn(); }
    catch (e) { stageFailed(`${name} [${cfg.code}]`, e); }
  };
  // Month archive FIRST: the footer's "everything new this month" link is only written when
  // the page it points at exists, so building it after the country page would delay the link
  // by a full run (and permanently, on a month's first build).
  step("month archive", () => writeOttMonthPages(cfg));
  // Hubs before platform months: a month page links its platform's hub only if the hub
  // exists, so the hub set must already be this run's (created and pruned) when they're built.
  step("platform hubs", () => writePlatformHubPages(data, cfg));
  step("platform months", () => writePlatformMonthPages(cfg));
  if (cfg.code === "in") step("language months", () => writeLanguageMonthPages());
  if (template) step("country page", () => renderCountryPage(template, cfg, data));
  step("weekly page", () => writeOttWeekPage(data, cfg, allCountries));
  step("rss feed", () => writeRssFeed(data, cfg));
  step("due-date pass", () => refreshDuePages(cfg, countryNameFor(cfg)));
  step("browse index", () => writeBrowseIndex(filmIndexFor(cfg), cfg, stamp, analyticsTag(), newlyAddedFor(cfg.code)));
  step("embed widget", () => writeEmbed(data, cfg, stamp)); // /embed/week/ per country + /embed/ (India)
  if (cfg.code === "in") step("data page", () => writeDataPage(stamp)); // site-wide, built once
}

// Section header labels, server-rendered from the data (so the header can't drift from the
// list under it, which is the bug this fixed — it used to be a hardcoded TOP 5 / TOP 10).
// Presented as a simple total: the "Still worth it — standouts from earlier weeks" divider
// further down already separates new arrivals from carried-over titles, and each card has
// its own freshness cue, so the header stays clean.
function sectionCounts(data) {
  return {
    theatres: `TOP ${((data && data.theatres) || []).length}`,
    ott: `TOP ${((data && data.ott) || []).length}`,
  };
}

// The freshness stamp under the header, rendered at BUILD time.
//
// It used to ship as the literal text "Loading fresh picks…" and was only filled in once the
// client had fetched data-<code>.json. Every other visible string on this page is
// server-rendered, so a page full of real, current films carried the one line that looked
// broken — for crawlers, for anyone with JS blocked, and for the first moment of every slow
// connection.
//
// An ABSOLUTE date, not the client's relative wording. The client computes "Updated today"
// live and is right to; the same words baked into a static file would keep claiming today
// forever on a stale cache. A date can't go false — it just gets older, which is the honest
// thing for it to do.
function ssrLastScan(data, cfg = null) {
  const gen = data && data.generatedAt ? new Date(data.generatedAt) : null;
  if (!gen || isNaN(gen.getTime())) return "Updated this week";
  return `Updated ${gen.toLocaleDateString(localeFor((cfg && cfg.code) || "in"), { day: "numeric", month: "short" })}`;
}

// The homepage's own policy. Looser than the generated pages' (the page runs its own inline
// script and self-hosted fonts), and the single place it is defined now that the CSP is
// rendered rather than hardcoded in the template.
const HOME_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' https://image.tmdb.org data:; frame-src https://www.youtube-nocookie.com; connect-src 'self'; object-src 'none'; base-uri 'self'";

// ============================================================================
// PICK OF THE WEEK, SERVER-RENDERED.
//
// The hero used to ship as display:none with an empty backdrop, and only appeared once the
// page's JavaScript had fetched this country's data file. On a phone that meant two things:
// the biggest image above the fold (the backdrop — the page's LCP element) could not even
// start downloading until JS and a JSON fetch had finished, and when the hero did appear it
// pushed every card below it down the screen (layout shift). 71% of clicks are mobile.
// Rendering it at build time, with the backdrop preloaded at high priority, fixes both. The
// client code still runs and sets the same values — it just no longer has to reveal anything.
// ============================================================================
const HERO_HIDDEN = `<div class="hero" id="hero" style="display:none">
  <div class="hero-card" id="heroCard">
    <div class="hero-bg" id="heroBg"></div>
    <div class="hero-grad"></div>
    <div class="hero-content">
      <span class="hero-eyebrow"><svg class="ic" aria-hidden="true"><use href="#icTrophy"/></svg> Pick of the Week</span>
      <div class="hero-title" id="heroTitle"></div>
      <div class="hero-meta" id="heroMeta"></div>
      <div class="hero-verdict" id="heroVerdict"></div>
    </div>
  </div>
</div>`;

function heroPickOf(data) {
  if (!data || !data.pick) return null;
  return [...(data.theatres || []), ...(data.ott || [])].find((x) => x && x.title === data.pick) || null;
}
// Same sanitising the client applies before putting the URL in a CSS url("…").
const heroBgUrl = (u) => String(u || "").replace(/["'()\\]/g, "");

function ssrHero(data) {
  const pick = heroPickOf(data);
  if (!pick) return HERO_HIDDEN;
  const e = escHtml;
  const bg = pick.backdrop ? ` style="background-image:url(&quot;${e(heroBgUrl(pick.backdrop))}&quot;)"` : "";
  const meta = [pick.platform, pick.genre, pick.language].filter(Boolean).join(" · ");
  return `<div class="hero" id="hero">
  <div class="hero-card" id="heroCard">
    <div class="hero-bg" id="heroBg"${bg}></div>
    <div class="hero-grad"></div>
    <div class="hero-content">
      <span class="hero-eyebrow"><svg class="ic" aria-hidden="true"><use href="#icTrophy"/></svg> Pick of the Week</span>
      <div class="hero-title" id="heroTitle">${e(pick.title)}</div>
      <div class="hero-meta" id="heroMeta">${e(meta)}</div>
      <div class="hero-verdict" id="heroVerdict">▸ ${e((pick.fcScore && pick.fcScore.verdict) || pick.verdict || "")}</div>
    </div>
  </div>
</div>`;
}

function heroPreload(data) {
  const pick = heroPickOf(data);
  if (!pick || !pick.backdrop) return "";
  return `<link rel="preload" as="image" href="${escHtml(heroBgUrl(pick.backdrop))}" fetchpriority="high">`;
}

function renderCountryPage(templateHtml, cfg, data) {
  const isIndia = cfg.code === "in";
  const V = streamVocab(cfg);
  let html = templateHtml;
  html = replaceBetween(html, "HEAD", buildHeadTags(cfg, USE_IMDB, data));
  // fc-stream-word rides along with fc-page: the client script renders a few strings at
  // runtime (My List tracking states, watchlist alerts) and must use the same word this
  // page is written in, without re-deriving it from a duplicated country list.
  html = replaceBetween(html, "PAGECODE",
    `<meta name="fc-page" content="${cfg.code}"><meta name="fc-stream-word" content="${escHtml(V.word)}"><meta name="fc-locale" content="${escHtml(localeFor(cfg.code))}">`);
  // Visible copy that names the concept. India/UAE keep "OTT"; every other market reads
  // "streaming" — the word its visitors actually use and search with.
  html = replaceBetween(html, "TAGLINE", `New movies &amp; ${escHtml(V.releases)} this week`);
  html = replaceBetween(html, "MYLISTSUB", `tracked until they hit ${escHtml(V.word)}`);
  html = replaceBetween(html, "OTTLINK", `All new ${escHtml(V.releases)} this week`);
  html = replaceBetween(html, "MORELINKS", buildMoreLinks(cfg.code, data));
  // The country switcher is rendered from COUNTRIES. It used to be a hardcoded <option>
  // list, which is why adding a country meant editing the same names in four places.
  html = replaceBetween(html, "COUNTRYOPTS", COUNTRIES.map((c) =>
    `<option value="${c.code}">${COUNTRY_FLAG[c.code] || ""} ${escHtml(c.name)}</option>`).join("\n    "));
  // The page's own JS reads its country labels and paths back out of the rendered <option>
  // list — markers can't go inside a <script>, and one rendered list beats three copies.
  // Analytics and the policy that has to allow it are rendered together: turning GC_SITE off
  // strips the tag AND closes the CSP hole in the same build (see analyticsTag/cspWith).
  html = replaceBetween(html, "CSP", `<meta http-equiv="Content-Security-Policy" content="${cspWith(HOME_CSP)}">`);
  html = replaceBetween(html, "ANALYTICS", analyticsTag());
  html = replaceBetween(html, "LASTSCAN", escHtml(ssrLastScan(data, cfg)));
  html = replaceBetween(html, "EDNOTE", ssrEditorNote(data, cfg));
  // Homepage share/Discover image: the Pick of the Week, then the lists (see hubOgImage).
  html = replaceBetween(html, "OGIMAGE", ogImageTag(hubOgImage([heroPickOf(data), ...(data.theatres || []), ...(data.ott || [])].filter(Boolean), cfg)));
  html = replaceBetween(html, "HERO", ssrHero(data));
  html = replaceBetween(html, "HEROPRELOAD", heroPreload(data));
  // The first two theatre posters sit above the fold on desktop: load them immediately.
  html = replaceBetween(html, "THEATRES", (data.theatres || []).map((x, i) => ssrCard(x, i, cfg.code, { eager: i < 2 })).join(""));
  html = replaceBetween(html, "OTT", ssrOttSection(data.ott || [], cfg.code));
  // Re-derived at render, not just at fetch: the committed data file can be a day old by the
  // time a page is rebuilt, and a passed date must never render inside "Coming soon".
  html = replaceBetween(html, "SOON", normalizeUpcoming(data.comingSoon).map((x) => ssrSoonCard(x, cfg.code)).join(""));
  // Counts were hardcoded "TOP 5" / "TOP 10" in the template while the sections rendered
  // whatever the week produced — the theatre header said 5 above seven films. The client
  // corrected it after hydration, but the server-rendered page (what Google reads, and what
  // shows before JS runs) was wrong. Render them from the data instead.
  const counts = sectionCounts(data);
  html = replaceBetween(html, "TCOUNT", counts.theatres);
  // Measured, not asserted — see freshnessWindowLabel.
  html = replaceBetween(html, "TWINDOW", freshnessWindowLabel(data.theatres) || "Now in cinemas");
  // Streaming measures ARRIVAL, not release — see freshnessWindowLabel.
  html = replaceBetween(html, "OWINDOW", freshnessWindowLabel(data.ott, Date.now(), OTT_FRESH_DAYS,
    { verb: "Added", past: "in the past", dateOf: (x) => x && (x.freshDate || x.released) }) || "Newly added to streaming");
  html = replaceBetween(html, "OCOUNT", counts.ott);
  // The SSR markers wrap the ENTIRE <script> element (never sit inside it): HTML
  // comments are NOT stripped inside <script>, so markers inside the tag made the
  // JSON-LD start with "<!--" — a syntax error to Google's structured-data parser.
  // Same lesson as the fc-page meta tag, now applied to the block that predated it.
  html = replaceBetween(html, "JSONLD",
    `<script type="application/ld+json">${buildHomeJsonLd(data, cfg)}</script>`);
  html = replaceBetween(html, "ATTRIBUTION", footerAttribution());
  if (isIndia) {
    fs.writeFileSync("index.html", html);
  } else {
    if (!fs.existsSync(cfg.code)) fs.mkdirSync(cfg.code, { recursive: true });
    fs.writeFileSync(`${cfg.code}/index.html`, html);
  }
  console.log(`  page rendered: ${isIndia ? "/ (index.html)" : "/" + cfg.code + "/"}`);
}

// PAGES_ONLY local regeneration: India only (the canonical page from data.json).
function prerenderIndex(data) {
  let html;
  try { html = fs.readFileSync("index.html", "utf8"); }
  catch { console.warn("index.html not found — prerender skipped"); return; }
  renderCountryPage(html, { code: "in", name: "India" }, data);
  console.log("index.html pre-rendered with this week's films.");
}

module.exports = {
  choosePick,
  PICK_FRESH_DAYS,
  ABOUT_LASTMOD,
  buildDataPage,
  buildHeadTags,
  buildHomeJsonLd,
  buildMoreLinks,
  buildWindowsCsv,
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
};
