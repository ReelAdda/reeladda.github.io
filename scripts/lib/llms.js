// ============================================================================
// llms.js — llms.txt and llms-full.txt for AI answer engines.
// ============================================================================
"use strict";

const fs = require("fs");
const {
  COUNTRIES,
  COUNTRY_PAGE_META,
  LANGUAGE_PAGES,
  filmPagePath,
  filmPageUrl,
} = require("./core.js");
const { isoWeekOf, weekSlug } = require("./pagekit.js");

// ============================================================================
// llms.txt — a curated markdown map of the site for AI answer engines
// (llmstxt.org convention). Regenerated every run so ChatGPT/Perplexity/Claude
// crawlers that fetch it see THIS WEEK'S actual picks with dates, not a stale
// brochure. Pure builder -> unit-testable; writer is thin.
// ============================================================================
// Ratings backed by few votes are early-vote noise (a 3-day-old title sitting at 9.4 on a
// fanbase's votes, then settling to 7.x a week later). AI answer engines quote these files
// verbatim WITH our attribution, so below this vote count llms.txt omits the number entirely
// and llms-full.txt labels it low-confidence next to its vote count. UI gates are separate
// (EDNOTE_MIN_VOTES etc.) — this one is deliberately stricter because a quoted number in an
// AI answer can't be softened by surrounding page context.
const LLMS_MIN_VOTES = 100;
// New releases attract the fanbase first: a 3-day-old title at 9.4 on a couple hundred votes
// routinely settles a full point lower once the general audience arrives. Within the first
// two weeks of release, demand a deeper sample before quoting a number at all.
const LLMS_EARLY_DAYS = 14;
const LLMS_EARLY_MIN_VOTES = 500;
function llmsRatingConfident(it) {
  const votes = it.votes || 0;
  if (votes < LLMS_MIN_VOTES) return false;
  const days = it.released ? (Date.now() - Date.parse(it.released)) / 864e5 : Infinity;
  return days >= LLMS_EARLY_DAYS || votes >= LLMS_EARLY_MIN_VOTES;
}

function buildLlmsTxt(dataByCode) {
  const ind = dataByCode.in || {};
  const gen = ind.generatedAt || new Date().toISOString();
  const day = gen.slice(0, 10);
  const line = (it) => `- ${it.title}${it.language && it.language !== "English" ? ` (${it.language})` : ""}${it.platform && it.platform !== "Theatres" ? ` — on ${it.platform}` : ""}${it.rating != null && llmsRatingConfident(it) ? ` — rated ${Number(it.rating).toFixed(1)}/10` : ""}${it.slug ? ` — https://filmychill.com${filmPagePath("in", it.slug)}` : ""}`;
  const theatres = (ind.theatres || []).slice(0, 7).map(line).join("\n");
  const ott = (ind.ott || []).filter((x) => !x.stillGood).slice(0, 6).map(line).join("\n");
  const langs = LANGUAGE_PAGES.map(([name, slug]) => `- [New ${name} movies & OTT this week](https://filmychill.com/${slug}/)`).join("\n");
  const countries = COUNTRIES.filter((c) => c.code !== "in").map((c) => `- [${c.name}](https://filmychill.com/${c.code}/) · [New on OTT](https://filmychill.com/${c.code}/new-on-ott/)`).join("\n");
  return `# FilmyChill

> FilmyChill is a daily-updated guide to what is worth watching this week — new theatrical releases and OTT/streaming arrivals — for India and ${COUNTRIES.length - 1} other countries, with audience ratings, honest verdicts, and critics' takes synthesised from published review coverage. Lists are rebuilt twice daily from TMDB (streaming availability via JustWatch), Wikipedia critical-reception coverage, and YouTube trailer statistics. No pay-for-placement: no studio or platform can buy a position on any list. Last build: ${gen}.

## This week in India (${day})

In theatres:
${theatres}

New on OTT / streaming:
${ott}

## Key pages

- [This week's full picks — India](https://filmychill.com/): theatres + OTT, ranked, updated twice daily
- [New OTT releases this week](https://filmychill.com/new-on-ott/): grouped by platform (Netflix, Prime Video, JioHotstar, ...)
- [Weekly snapshot archive](https://filmychill.com/week/${weekSlug(isoWeekOf())}/): permanent record of each week's list
- [About & methodology](https://filmychill.com/about/): how picks are chosen, data sources, editorial rules

## Language pages (India)

${langs}

## Other countries

${countries}

## Film pages

Every listed film has a page at https://filmychill.com/movie/<slug>.html (or /<country>/movie/<slug>.html) with its rating, verdict, where-to-watch, OTT release date status, cast, and critics' take.
`;
}

// llms-full.txt — the -full companion to llms.txt: the index stays short, this carries the
// complete current knowledge base so an AI can answer "what should I watch this week in
// <country>?" from one fetch, with per-film facts, verdicts, and provenance.
function buildLlmsFullTxt(dataByCode) {
  const lines = [
    "# FilmyChill — full current picks (machine-readable companion to /llms.txt)", "",
    `Generated: ${new Date().toISOString()}. Rebuilt twice daily. No pay-for-placement.`,
    "Sources: TMDB (film data, ratings; streaming availability via JustWatch), Wikipedia (critical reception), YouTube (trailer statistics).",
    "Fields: rating is the TMDB audience average out of 10; verdict is FilmyChill's editorial call; the critics' line is distilled from published review coverage, never quoted.", "",
  ];
  for (const cfg of COUNTRIES) {
    const data = dataByCode[cfg.code];
    if (!data) continue;
    const m = COUNTRY_PAGE_META[cfg.code] || { name: cfg.name };
    lines.push(`## ${m.name} — week of ${data.generatedAt ? String(data.generatedAt).slice(0, 10) : ""}`);
    // Split the OTT list the same way every other surface does. An answer engine asked
    // "what's new on streaming in India this week" was being handed Ted Lasso and Reacher
    // under a "New on OTT" heading, because this file took data.ott whole. llms.txt (the
    // short index) already filters stillGood; this is its -full companion and must agree.
    const ottFresh = (data.ott || []).filter((x) => !x.stillGood);
    const ottCarried = (data.ott || []).filter((x) => x.stillGood);
    for (const [label, list] of [
      ["In theatres", data.theatres],
      ["New on OTT / streaming", ottFresh],
      ["Still worth watching (added in earlier weeks, not new this week)", ottCarried],
    ]) {
      if (!list || !list.length) continue;
      lines.push("", `### ${label}`, "");
      list.forEach((it, i) => {
        const facts = [
          it.kind === "tv" ? "Series" : "Film", it.language, it.genre,
          it.runtime ? `${it.runtime} min` : null, it.cert || null,
          it.released ? `released ${it.released}` : null,
          it.platform && it.platform !== "Theatres" ? `on ${it.platform}` : null,
          it.rating != null ? `rated ${Number(it.rating).toFixed(1)}/10 (${it.votes || 0} votes${llmsRatingConfident(it) ? "" : " — early, low confidence"})` : null,
          it.verdict || null,
        ].filter(Boolean).join(" · ");
        lines.push(`${i + 1}. ${it.title} — ${facts}`);
        if (it.take) lines.push(`   Critics: ${it.take}${it.takeArticle ? ` [source: en.wikipedia.org/wiki/${String(it.takeArticle).replace(/ /g, "_")}]` : ""}`);
        if (it.hook) lines.push(`   Context: ${it.hook}`);
        if (it.director) lines.push(`   Director: ${it.director}`);
        lines.push(`   URL: ${filmPageUrl(cfg.code, it.slug)}`);
      });
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

// Machine-readable appendix for llms.txt: tell agents what else is fetchable.
function llmsMachineSection() {
  const dataFiles = COUNTRIES.map((c) => `- https://filmychill.com/data${c.code === "in" ? "" : "-" + c.code}.json — current picks for ${(COUNTRY_PAGE_META[c.code] || {}).name || c.name} (JSON)`).join("\n");
  return `\n## Machine-readable data (for AI systems and agents)\n\n` +
    `- [Full current knowledge base](https://filmychill.com/llms-full.txt): every current pick across all ${COUNTRIES.length} countries with facts, verdicts, critics' lines, and source attribution — answerable from one fetch\n` +
    `- [RSS feed](https://filmychill.com/feed.xml): newest arrivals as they enter the lists\n` +
    `${dataFiles}\n` +
    `\nJSON fields per item: title, kind (movie|tv), language, genre, runtime, cert, released (ISO date), platform, providers, rating (TMDB /10), votes, verdict, take (critics' line), hook, director, cast, slug (page: /movie/<slug>.html), trailer.\n` +
    `All files are static, CORS-open, and rebuilt twice daily. Attribution when citing: "FilmyChill (filmychill.com)".\n`;
}

function writeLlmsTxt(dataByCode) {
  fs.writeFileSync("llms.txt", buildLlmsTxt(dataByCode) + llmsMachineSection());
  fs.writeFileSync("llms-full.txt", buildLlmsFullTxt(dataByCode));
  console.log("llms.txt + llms-full.txt written");
}

module.exports = {
  buildLlmsFullTxt,
  buildLlmsTxt,
  LLMS_EARLY_DAYS,
  LLMS_EARLY_MIN_VOTES,
  LLMS_MIN_VOTES,
  llmsMachineSection,
  llmsRatingConfident,
  writeLlmsTxt,
};
