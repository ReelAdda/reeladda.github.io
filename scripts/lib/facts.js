// ============================================================================
// facts.js — a film page's facts, read back out of its own HTML (Oct 2026).
//
// The first half of moving the site from "frozen HTML, patched forever" to "facts, rendered by
// the live template" (lib/migrate.js). Every fact a page shows is already in it: the JSON-LD
// carries name, date, language, genre, runtime, certificate, director and trailer; the body
// carries synopsis, cast, ratings, the score, platforms and similar titles. Reading them back
// needs no API call and changes nothing a reader relies on, which keyFacts() checks.
//
// The store is one JSON-lines file per edition, facts/<code>.jsonl, sorted by slug so each
// build's change is a small diff: {"slug": …, "updated": "YYYY-MM-DD", "item": {…}}.
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");

const FACTS_DIR = "facts";

const dec = (s) => String(s == null ? "" : s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (s) => dec(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
function section(html, title) {
  const i = html.search(new RegExp(`<h2>${title}`));
  if (i < 0) return "";
  const j = html.indexOf("<h2", i + 4);
  return html.slice(i, j < 0 ? undefined : j);
}
const STATUS_PILL = /theatre|cinema|Theatrical run|Not out|arrival pending/i;

function jsonLd(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
}

// Pure: the item buildFilmPage needs, from a rendered film page. null when the page has no
// Movie/TVSeries structured data (an unrecognised shape is left alone, never guessed at).
function extractFacts(html, slug, { tmdbId = null } = {}) {
  const ld = jsonLd(html).find((o) => o["@type"] === "Movie" || o["@type"] === "TVSeries");
  if (!ld || !ld.name) return null;
  const dur = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(ld.duration || "");
  const scoreAt = html.indexOf('id="filmychill-score"');
  const head = html.slice(Math.max(0, html.indexOf('<div class="head"')), scoreAt > 0 ? scoreAt : undefined);
  const star = /★ ([\d.]+)/.exec(head);
  const votesHead = /<span class="cvotes">(?:— only )?([\d,]+)(?: ratings)?<\/span>/.exec(head) || /\(([\d,]+) votes\)/.exec(head);
  const audRow = /<b>Audience<\/b><small>★ ([\d.]+) from ([\d,]+) ratings/.exec(html);
  const story = /<h2>Story<\/h2><p>([\s\S]*?)<\/p>/.exec(html);
  const castPics = [...html.matchAll(/<div class="cast-card"><img src="([^"]*)" alt="[^"]*"[^>]*><div class="cast-name">([\s\S]*?)<\/div>(?:<div class="cast-role">([\s\S]*?)<\/div>)?<\/div>/g)]
    .map((m) => ({ name: text(m[2]), photo: dec(m[1]), ...(m[3] ? { character: text(m[3]) } : {}) }));
  const wtw = section(html, "Where to watch");
  const cut = wtw.indexOf("Rent or buy");
  const pills = (t) => [...t.matchAll(/<span class="pill">([^<]+)<\/span>/g)].map((x) => dec(x[1]).trim());
  const providers = pills(cut >= 0 ? wtw.slice(0, cut) : wtw).filter((p) => !STATUS_PILL.test(p));
  const rentBuy = cut >= 0 ? pills(wtw.slice(cut)) : [];
  const yt = (ld.trailer && (ld.trailer.url || ld.trailer.contentUrl || ld.trailer.embedUrl) || "").match(/(?:embed\/|watch\?v=|vi\/)([A-Za-z0-9_-]{6,})/)
    || /youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)([A-Za-z0-9_-]{6,})/.exec(html);
  const similar = [...html.matchAll(/<(?:a class="simcard" href="([^"]+)"|div class="simcard" style="cursor:default")>(?:<img src="([^"]*)"[^>]*>)?<div class="st">([\s\S]*?)<\/div><div class="sm">([\s\S]*?)<\/div><\/(?:a|div)>/g)]
    .map((m) => {
      const sm = text(m[4]);
      return { title: text(m[3]), slug: m[1] ? (/\/([^/]+)\.html$/.exec(m[1]) || [])[1] : slugGuess(text(m[3])),
        poster: dec(m[2] || ""), language: sm.split(" · ")[0] || "", kind: /Series/.test(sm) ? "tv" : "movie" };
    });
  const stamp = /class="fcsb-stamp fcsb-(?:must|worth|skip)">([^<]+)</.exec(html);
  const why = /<p class="fcsb-why">([\s\S]*?)<\/p>/.exec(html);
  const tag = (label) => (new RegExp(`<b>${label}<\\/b><small>[^<]*<\\/small><\\/div><span class="fcsb-tag(?: none)?">([^<]+)<`).exec(html) || [])[1];
  const audTag = tag("Audience"), criTag = tag("Critics");
  const conf = /<span class="fcsb-conf">Based on ([\d,]+) ratings<\/span>/.exec(html);
  const take = /<p class="take">([\s\S]*?)(?: <span class="tcounter">([\s\S]*?)<\/span>)?(?: <span class="tsrc">[^<]*<\/span>)?<\/p>/.exec(html);
  const cite = ld.citation && /^Wikipedia: (.+)$/.exec(ld.citation.name || "");
  const dig = /<!--SW:digital=(\d{4}-\d{2}-\d{2})\|([^>]*?)-->/.exec(html);
  const cert = (/<td>Watch with family\?<\/td><td>([^<·]+?)\s*·/.exec(html) || [])[1];
  const rating = star ? Number(star[1]) : audRow ? Number(audRow[1]) : null;
  // The compact score line ("Too early — 3 audience ratings so far") is the only place a
  // brand-new film's count appears.
  const compactVotes = /<span class="fcsb-mini-v">[^<]*<\/span> — ([\d,]+) audience ratings? so far/.exec(html);
  const votes = votesHead ? Number(votesHead[1].replace(/,/g, "")) : audRow ? Number(audRow[2].replace(/,/g, ""))
    : compactVotes ? Number(compactVotes[1].replace(/,/g, "")) : 0;
  // Series carry their episode length in the "Good to know" table, not in the JSON-LD.
  const gtkRuntime = (/<td>Runtime<\/td><td>([^<]+)<\/td>/.exec(html) || [])[1] || "";
  const runtimeFromTable = (() => {
    const ep = /~?(\d+) min per episode/.exec(gtkRuntime); if (ep) return Number(ep[1]);
    const hm = /(\d+)h(?: (\d+)m)?/.exec(gtkRuntime); if (hm) return Number(hm[1]) * 60 + Number(hm[2] || 0);
    const mm = /^(\d+)m/.exec(gtkRuntime); return mm ? Number(mm[1]) : null;
  })();
  const actorNames = [].concat(ld.actor || []).map((a) => a && a.name).filter(Boolean);
  const item = {
    title: dec(ld.name), slug, kind: ld["@type"] === "TVSeries" ? "tv" : "movie",
    language: ld.inLanguage || "", genre: [].concat(ld.genre || []).join(" / "),
    released: String(ld.datePublished || ld.startDate || "").slice(0, 10),
    runtime: dur ? Number(dur[1] || 0) * 60 + Number(dur[2] || 0) : runtimeFromTable,
    review: story ? text(story[1]) : "",
    cast: castPics.length ? castPics.map((c) => c.name) : actorNames,
    castPics, providers, rentBuy,
    // "Theatres" only once a film has opened; a pre-release page ("In cinemas from 20 Nov")
    // renders from its release date, like the live builder's coming-soon items.
    platform: providers.length ? providers[0] : (/Theatrical run ended|Opened in cinemas|>In theatres</.test(wtw) ? "Theatres" : ""),
    rating, votes, similar,
  };
  if (tmdbId) item.tmdbId = tmdbId;
  if (ld.numberOfSeasons) item.seasons = ld.numberOfSeasons;
  if (cert || ld.contentRating) item.cert = (cert || ld.contentRating).trim();
  const director = [].concat(ld.director || []).map((d) => d && d.name).filter(Boolean).join(", ");
  if (director) item.director = director;
  const poster = (/<img class="poster" src="([^"]+)"/.exec(html) || [])[1];
  if (poster) item.poster = dec(poster);
  if (yt) item.trailer = `https://www.youtube.com/watch?v=${yt[1]}`;
  else {
    // No video found: the page links a YouTube search instead ("Find the trailer on YouTube").
    const search = /<a href="([^"]+)" rel="noopener">Find the trailer on YouTube →<\/a>/.exec(html);
    if (search) item.trailer = dec(search[1]);
  }
  // The framing fact under the verdict ("The follow-up to 'Awarapan'.", lib/editorial.js).
  const hook = /<p class="hook">([\s\S]*?)<\/p>/.exec(html);
  if (hook) item.hook = text(hook[1]);
  if (stamp) {
    item.fcScore = { verdict: dec(stamp[1]), reason: text(why && why[1]),
      audience: audTag && !/Too few|Not rated/i.test(audTag) ? dec(audTag) : null,
      critics: criTag && !/No verdict/i.test(criTag) ? dec(criTag).toLowerCase() : null,
      basis: audTag && criTag && !/Too few|Not rated/i.test(audTag) && !/No verdict/i.test(criTag) ? "both" : (criTag && !/No verdict/i.test(criTag) ? "critics" : "audience") };
    if (conf) { item.fcScore.early = true; item.fcScore.votes = Number(conf[1].replace(/,/g, "")); }
  }
  if (take) {
    item.take = text(take[1]);
    if (take[2]) item.takeCounter = text(take[2]);
    if (/class="tsrc"/.test(take[0])) item.takeSrc = "wiki";
    if (cite) item.takeArticle = cite[1];
  }
  if (dig) { item.digitalDate = dig[1]; if (dig[2]) item.digitalNote = dec(dig[2]); }
  return item;
}
const slugGuess = (t) => String(t).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Pure: where the page stands, from its own markers.
function pageState(html) {
  if (/<!--SW:gone=/.test(html)) return "gone";
  const wtw = section(html, "Where to watch");
  const cut = wtw.indexOf("Rent or buy");
  if ((cut >= 0 ? wtw.slice(0, cut) : wtw).match(/<span class="pill">([^<]+)<\/span>/g)?.some((p) => !STATUS_PILL.test(p))) return "streaming";
  if (/<!--SW:digital=/.test(html)) return "announced";
  if (/<!--SW:due=/.test(html)) return "upcoming";
  if (cut >= 0) return "rent";
  if (/<!--SW:pending-->/.test(html)) return "theatrical";
  return "other";
}

// Pure: the facts a reader relies on, from either version of a page. A migration switches a
// page only when these are identical before and after; wording and layout may change.
function keyFacts(html) {
  const wtw = section(html, "Where to watch");
  const cut = wtw.indexOf("Rent or buy");
  const pillSet = (t) => [...t.matchAll(/<span class="pill">([^<]+)<\/span>/g)].map((x) => dec(x[1]).trim()).filter((p) => !STATUS_PILL.test(p)).sort().join(",");
  return {
    state: pageState(html),
    title: text((/<h1>([\s\S]*?)<\/h1>/.exec(html) || [])[1]),
    released: (/"datePublished":"([^"]+)"/.exec(html) || [])[1] || "",
    synopsis: text((/<h2>Story<\/h2><p>([\s\S]*?)<\/p>/.exec(html) || [])[1]),
    cast: [...html.matchAll(/<div class="cast-name">([\s\S]*?)<\/div>/g)].map((m) => text(m[1])).join(","),
    providers: pillSet(cut >= 0 ? wtw.slice(0, cut) : wtw),
    rentBuy: cut >= 0 ? pillSet(wtw.slice(cut)) : "",
    // "Too early" and "Not enough ratings" both mean "no score yet"; which one shows depends on
    // the film's age on the day the page is drawn.
    verdict: ((/class="fcsb-(?:stamp fcsb-[a-z]+|mini-v)">([^<]+)</.exec(html) || [])[1] || "").replace(/^(Too early|Not enough ratings)$/, "no score yet"),
    rating: (/★ ([\d.]+)/.exec(html.slice(Math.max(0, html.indexOf('<div class="head"')))) || [])[1] || "",
    trailer: (/youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)([A-Za-z0-9_-]{6,})/.exec(html) || [])[1] || "",
    digital: (/<!--SW:digital=(\d{4}-\d{2}-\d{2})/.exec(html) || [])[1] || "",
    availability: availabilityText(html),
    runtime: runtimeMinutes((/<td>Runtime<\/td><td>([^<]+)<\/td>/.exec(html) || [])[1] || ""),
  };
}
// "108 min", "1h 48m", "1h 48m — long" and "~23 min per episode" as minutes, so a format
// change is not mistaken for a different runtime.
function runtimeMinutes(s) {
  const hm = /(\d+)h(?: (\d+)m)?/.exec(s); if (hm) return String(Number(hm[1]) * 60 + Number(hm[2] || 0));
  const m = /(\d+) ?min/.exec(s) || /^(\d+)m\b/.exec(s); return m ? String(Number(m[1])) : "";
}
// The page's own "Availability as of …" date, exactly as written. It records when the
// platforms were last confirmed, so a re-render must keep it rather than restate it.
function availabilityText(html) {
  return (/Availability as of ([^<—]+?) — /.exec(html) || [])[1] || "";
}
function factsDiff(a, b) {
  return Object.keys(a).filter((k) => a[k] !== b[k]);
}

// ---- the store --------------------------------------------------------------------------
const factsPath = (code, root = ".") => path.join(root, FACTS_DIR, `${code}.jsonl`);
function readFacts(code, root = ".") {
  const out = new Map();
  let raw = "";
  try { raw = fs.readFileSync(factsPath(code, root), "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && r.slug) out.set(r.slug, r); } catch { /* skip a bad line, never the file */ }
  }
  return out;
}
function writeFacts(code, map, root = ".") {
  fs.mkdirSync(path.join(root, FACTS_DIR), { recursive: true });
  const lines = [...map.values()].sort((a, b) => a.slug.localeCompare(b.slug)).map((r) => JSON.stringify(r));
  fs.writeFileSync(factsPath(code, root), lines.join("\n") + (lines.length ? "\n" : ""));
}

module.exports = { FACTS_DIR, availabilityText, extractFacts, factsDiff, keyFacts, pageState, readFacts, writeFacts };
