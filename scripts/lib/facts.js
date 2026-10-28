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
const { tidyProse } = require("./core.js");

const FACTS_DIR = "facts";

const dec = (s) => String(s == null ? "" : s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (s) => dec(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
function section(html, title) {
  const i = html.search(new RegExp(`<h2>${title}`));
  if (i < 0) return "";
  const j = html.indexOf("<h2", i + 4);
  return html.slice(i, j < 0 ? undefined : j);
}
// The first meta line under the title: "Hindi · Action / Thriller · 141 min · U/A 16+".
const headMeta = (html) => (/<h1>[\s\S]*?<\/h1>\s*<div class="meta">([^<]*)<\/div>/.exec(html) || [])[1] || "";
// The certificate at the end of that line, when the page has no table row for it ("· U",
// "· U/A 16+", "· R 18+"). Only a recognised certificate shape, never a genre or a runtime.
const CERT_RE = /^(?:U|UA|U\/A(?: \d{1,2}\+)?|A|S|G|PG|PG-1[23]|M|MA ?15\+|R|R ?1[368]\+?|NC-?1[67]|TV-(?:Y7?|G|PG|14|MA)|FSK ?\d{1,2}|\d{1,2}\+?|P13|SPG|SU|ALL)$/;
const certOf = (meta) => { const last = meta.split(" · ").pop().trim(); return meta.includes(" · ") && CERT_RE.test(last) ? last : ""; };
// Status pills, matched by how they start (lib/archive.js frozenFilmFacts has the same rule):
// "cinema" anywhere also matched platforms — Queer Cinemab, Now TV Cinema, Curzon Home Cinema.
const STATUS_PILL = /^(?:In (?:theatres|cinemas)\b|Opened in (?:theatres|cinemas)\b|Theatrical run\b|Releases? in (?:theatres|cinemas)\b|Not out\b)|arrival pending/i;

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
  // "ratings?": one vote reads "from 1 rating" since 14 Oct 2026.
  const audRow = /<b>Audience<\/b><small>★ ([\d.]+) from ([\d,]+) ratings?\b/.exec(html);
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
  // "If you liked this" only: the franchise row (lib/series.js) uses the same cards and isn't it.
  const simAt = html.indexOf("<h2>If you liked this</h2>");
  const simHtml = simAt < 0 ? "" : html.slice(simAt, (html.indexOf("<h2", simAt + 4) + 1 || html.length + 1) - 1);
  const similar = [...simHtml.matchAll(/<(?:a class="simcard" href="([^"]+)"|div class="simcard" style="cursor:default")>(?:<img src="([^"]*)"[^>]*>)?<div class="st">([\s\S]*?)<\/div><div class="sm">([\s\S]*?)<\/div><\/(?:a|div)>/g)]
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
  // Lean pages (lib/filmpage.js LEAN_PAGE) show the rating only in the score ring and the count
  // once; their machine-readable copy is a comment, read first.
  const mark = /<!--FC:audience=([\d.]*)\|(\d*)-->/.exec(html);
  const rating = mark ? (mark[1] !== "" ? Number(mark[1]) : null) : star ? Number(star[1]) : audRow ? Number(audRow[1]) : null;
  // The compact score line ("Too early — 3 audience ratings so far") is the only place a
  // brand-new film's count appears.
  // Older films read "only 12 audience ratings" (no "so far": time words are for new films only).
  const compactVotes = /<span class="fcsb-mini-v">[^<]*<\/span> — (?:only )?([\d,]+) audience ratings?(?: so far)?/.exec(html);
  const votes = mark ? Number(mark[2] || 0) : votesHead ? Number(votesHead[1].replace(/,/g, "")) : audRow ? Number(audRow[2].replace(/,/g, ""))
    : compactVotes ? Number(compactVotes[1].replace(/,/g, "")) : 0;
  // Series carry their episode length in the "Good to know" table, not in the JSON-LD.
  const gtkRuntime = (/<td>Runtime<\/td><td>([^<]+)<\/td>/.exec(html) || [])[1] || "";
  const runtimeFromTable = (() => {
    const ep = /~?(\d+) min per episode/.exec(gtkRuntime); if (ep) return Number(ep[1]);
    const hm = /(\d+)h(?: (\d+)m)?/.exec(gtkRuntime); if (hm) return Number(hm[1]) * 60 + Number(hm[2] || 0);
    // "102 min": the older layout's form (175 pages held for it, Oct 2026).
    const mm = /^(\d+) ?m(?:in)?\b/.exec(gtkRuntime); if (mm) return Number(mm[1]);
    // Older pages: only the header line carries it ("Marathi · Comedy / Drama · 182 min").
    const meta = /· (\d+) min\b/.exec(headMeta(html)); return meta ? Number(meta[1]) : null;
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
  // The backdrop: the structured data's second image (w1280), for the redesign's hero.
  const ldImg = Array.isArray(ld.image) ? ld.image : [];
  const bdm = /^https:\/\/image\.tmdb\.org\/t\/p\/w\d+(\/[^"/]+)$/.exec(String(ldImg[1] || ""));
  if (bdm) { item.backdropPath = bdm[1]; item.backdrop = `https://image.tmdb.org/t/p/w780${bdm[1]}`; }
  // Episode guide and franchise, from the page's marker (lib/series.js).
  const ser = require("./series.js").readSeriesMark(html);
  if (ser.episodes) item.episodes = ser.episodes;
  if (ser.franchise) item.franchise = ser.franchise;
  // The Critics row's figures, from the score card's marker (lib/reception.js).
  const rec = require("./reception.js").readReceptionMark(html);
  if (rec) item.reception = rec;
  const headCert = certOf(headMeta(html));
  if (cert || ld.contentRating || headCert) item.cert = (cert || ld.contentRating || headCert).trim();
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
  // A verified arrival (lib/lifecycle.js arrivalDate), only while the page lists platforms.
  const arr = /<!--SW:arrived=(\d{4}-\d{2}-\d{2})\|([^>]*?)-->/.exec(html);
  if (arr && providers.length) { item.arrived = arr[1]; if (arr[2]) item.arrivedOn = dec(arr[2]); }
  // State that lived only in the page (Oct 2026, lib/factsq.js): when availability was last
  // confirmed, and a departure. Without them a re-render erased every departure notice.
  const checked = isoFromShown(availabilityText(html));
  if (checked) item.checkedAt = checked;
  const gone = /<!--SW:gone=(\d{4}-\d{2}-\d{2})?-->/.exec(html);
  if (gone && !providers.length) {
    item.state = "gone";
    if (gone[1]) item.goneAt = gone[1];
    const was = / — it was on ([^<]+?)\.(?: |<)/.exec(html.slice(gone.index));
    if (was) item.wasOn = dec(was[1]).split(/, /).map((x) => x.trim()).filter(Boolean);
    const rb = /You can still rent or buy it on ([^<]+?)\.</.exec(html.slice(gone.index));
    if (rb && !rentBuy.length) item.rentBuy = dec(rb[1]).split(/, /).map((x) => x.trim()).filter(Boolean);
    if (/<strong>Not streaming yet\.<\/strong>/.test(html.slice(gone.index))) item.goneUnconfirmed = true;
  }
  return item;
}

// "17 Oct 2026", "30 Sept 2026", "Oct 1, 2026", "17 October 2026" -> "2026-10-17". null if unknown.
const MONTH_INDEX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function isoFromShown(s) {
  if (!s) return null;
  let m = /(\d{1,2}) ([A-Za-z]+)\.? (\d{4})/.exec(s), d, mo, y;
  if (m) { d = m[1]; mo = MONTH_INDEX[m[2].slice(0, 3).toLowerCase()]; y = m[3]; }
  else if ((m = /([A-Za-z]+)\.? (\d{1,2}), (\d{4})/.exec(s))) { d = m[2]; mo = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()]; y = m[3]; }
  if (!mo) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
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
  // The older layout has no markers, only its status pill (260 pages held for it, Oct 2026).
  const status = (wtw.match(/<span class="pill">([^<]+)<\/span>/g) || []).join(" ");
  if (/In cinemas from|In cinemas today|Releases/.test(status)) return "upcoming";
  if (/Theatrical run ended|In theatres|Opened in cinemas|arrival pending/.test(status)) return "theatrical";
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
    // The title's own date: episodes inside containsSeason (lib/series.js episodeSchema) carry
    // datePublished too, and a series without a release date must not borrow its first episode's.
    released: (/"datePublished":"([^"]+)"/.exec(html.split('"containsSeason"')[0]) || [])[1] || "",
    // Tidied on both sides: punctuation fixes from lib/core.js tidyProse are not a fact change.
    synopsis: tidyProse(text((/<h2>Story<\/h2><p>([\s\S]*?)<\/p>/.exec(html) || [])[1])),
    cast: [...html.matchAll(/<div class="cast-name">([\s\S]*?)<\/div>/g)].map((m) => text(m[1])).join(","),
    providers: pillSet(cut >= 0 ? wtw.slice(0, cut) : wtw),
    rentBuy: cut >= 0 ? pillSet(wtw.slice(cut)) : "",
    // "Too early" and "Not enough ratings" both mean "no score yet"; which one shows depends on
    // the film's age on the day the page is drawn.
    verdict: ((/class="fcsb-(?:stamp fcsb-[a-z]+|mini-v)">([^<]+)</.exec(html) || [])[1] || "").replace(/^(Too early|Not enough ratings|Not out yet|Critics split)$/, "no score yet"),
    // A lean page's rating is in its marker (lib/filmpage.js audienceMark); older pages' in the header.
    rating: ((/<!--FC:audience=([\d.]+)\|/.exec(html) || [])[1]) || (/★ ([\d.]+)/.exec(html.slice(Math.max(0, html.indexOf('<div class="head"')))) || [])[1] || "",
    trailer: (/youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)([A-Za-z0-9_-]{6,})/.exec(html) || [])[1] || "",
    digital: (/<!--SW:digital=(\d{4}-\d{2}-\d{2})/.exec(html) || [])[1] || "",
    availability: availabilityText(html),
    cert: ((/<td>Watch with family\?<\/td><td>([^<·]+?)\s*·/.exec(html) || [])[1] || certOf(headMeta(html))).trim(),
    // The table, else the header line: a runtime shown only in the header still counts.
    runtime: runtimeMinutes((/<td>Runtime<\/td><td>([^<]+)<\/td>/.exec(html) || [])[1] || "") || runtimeMinutes((/· (\d+ min)\b/.exec(headMeta(html)) || [])[1] || ""),
    // A series' episode guide (lib/series.js) is a fact too: the count, the next drop, how many
    // episodes are listed and how many carry a rating. Not the rating values, which drift daily.
    // Absent (so no fingerprint changes) on every page without a guide.
    episodes: (() => {
      const ep = require("./series.js").readSeriesMark(html).episodes;
      if (!ep || !ep.count) return undefined;
      const list = ep.list || [];
      return `${ep.count}|${ep.next ? ep.next.date : ""}|${list.length}|${list.filter((x) => x.rating).length}`;
    })(),
    // The critics' figures the score card cites (lib/reception.js): values and counts are facts;
    // the read date is not. Absent on every page without them.
    reception: (() => { const R = require("./reception.js"); const k = R.receptionKey(R.readReceptionMark(html)); return k || undefined; })(),
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
    // A bad line is skipped, never the file, and counted: since the record is the page's only
    // source (lib/factsq.js), a lost one must never go unnoticed (review, Oct 2026).
    try { const r = JSON.parse(line); if (r && r.slug) out.set(r.slug, r); else out.skipped = (out.skipped || 0) + 1; }
    catch { out.skipped = (out.skipped || 0) + 1; }
  }
  return out;
}
function writeFacts(code, map, root = ".") {
  fs.mkdirSync(path.join(root, FACTS_DIR), { recursive: true });
  const lines = [...map.values()].sort((a, b) => a.slug.localeCompare(b.slug)).map((r) => JSON.stringify(r));
  fs.writeFileSync(factsPath(code, root), lines.join("\n") + (lines.length ? "\n" : ""));
}

module.exports = { FACTS_DIR, STATUS_PILL, availabilityText, extractFacts, factsDiff, isoFromShown, keyFacts, pageState, readFacts, writeFacts };
