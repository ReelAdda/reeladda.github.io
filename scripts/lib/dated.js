// ============================================================================
// dated.js — dated and listing pages: 'Coming to OTT', 'New on OTT today', language landing
// pages, weekly snapshots, the platform-hub writer and the IndexNow payload.
// ============================================================================
"use strict";

const fs = require("fs");
const { writeIfChanged } = require("./writeif.js");
const {
  LANGUAGE_PAGES,
  filmPageUrl,
  fmtDateShort,
  fmtDateFull,
  localeFor,
} = require("./core.js");
const { readHistory } = require("./history.js");
const { filmIndexFor } = require("./graph.js");
const { normalizeUpcoming, releaseState } = require("./release.js");
const {
  buildPlatformHubPage,
  existingHubSlugs,
  hubsFor,
  LIVE_HUBS,
  monthRow,
} = require("./hubs.js");
const {
  fitFirst,
  hubPath,
  hubUrl,
  isoWeekMonday,
  isoWeekOf,
  listingPageHtml,
  weekSlug,
  whereLabel,
} = require("./pagekit.js");
const { popularBlockFor } = require("./searchtop.js");
const { DIGITAL_UNNAMED, countryNameFor, digitalNoteName, streamVocab } = require("./rules.js");
const { ottWeekUrl } = require("./weekly.js");

// ============================================================================
// "COMING TO OTT" and "NEW ON OTT TODAY" — the two dated pages the field has and we didn't.
//
// Coming to OTT: every ANNOUNCED streaming date we hold for this country (live lists via
// enrich, frozen pages via the arrival sweep), grouped by week. It answers "upcoming OTT
// releases" / "OTT releases next week" with dates, which no amount of "new this week" can.
// Only announced dates — never the pattern estimates. Gated at COMING_MIN titles.
//
// New on OTT today: what first appeared on a subscription service in this country today,
// yesterday and earlier this week, from the arrival record (ott-history.jsonl) — the site's
// own observations, not a feed. Never empty: a quiet day shows the most recent arrivals.
// ============================================================================
const COMING_MIN = 3;
const comingPath = (code) => (code === "in" ? "coming-to-ott/index.html" : `${code}/coming-to-ott/index.html`);
const comingUrl = (code) => (code === "in" ? "https://filmychill.com/coming-to-ott/" : `https://filmychill.com/${code}/coming-to-ott/`);
const todayPath = (code) => (code === "in" ? "new-on-ott/today/index.html" : `${code}/new-on-ott/today/index.html`);
const todayUrl = (code) => (code === "in" ? "https://filmychill.com/new-on-ott/today/" : `https://filmychill.com/${code}/new-on-ott/today/`);

// Pure: announced streaming dates for one country, today or later, soonest first.
function announcedDates(data, manifestForCountry, index = [], now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const idx = new Map((index || []).map((x) => [x.slug, x]));
  const out = new Map();
  for (const it of [...((data && data.theatres) || []), ...((data && data.comingSoon) || []), ...((data && data.langPools) ? Object.values(data.langPools).flat() : [])]) {
    if (!it || !it.slug || !it.digitalDate || it.digitalDate < today) continue;
    if (Array.isArray(it.providers) && it.providers.length) continue;
    out.set(it.slug, { slug: it.slug, title: it.title, language: it.language || "", kind: it.kind || "movie", genre: it.genre || "",
      poster: it.poster || "", rating: it.rating ?? null, votes: it.votes || 0, verdict: it.verdict || null,
      date: it.digitalDate, platform: it.digitalNote || null });
  }
  for (const [slug, e] of Object.entries(manifestForCountry || {})) {
    const dg = e && e.digital;
    if (!dg || !dg.date || dg.date < today || out.has(slug) || e.live) continue;
    const ix = idx.get(slug) || {};
    out.set(slug, { slug, title: e.title || ix.title || slug, language: e.lang || ix.language || "", kind: e.kind || "movie",
      genre: ix.genre || "", poster: ix.poster || "", rating: null, votes: 0, verdict: null, date: dg.date, platform: dg.note || null });
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

// STILL WAITING (step 7, 8 Nov 2026): films in this edition's cinemas that are past their
// language's usual window (lib/windows.js, measured) and have no announced streaming date and no
// platform yet. No date is predicted: the row states how long it has been, the measured pattern
// and that no date is in our sources. Only languages with a usable measured range; the probe's
// watchlist (ott-watch.json) holds the films that opened and aren't streaming. Pure.
const WAITING_MAX_DAYS = 120;
const WAITING_MAX_ROWS = 20;   // older than this is a film that never came to streaming, not one on its way
function stillWaiting(watch, code, { manifest = {}, index = [], announced = new Set(), today = new Date().toISOString().slice(0, 10), V = { word: "OTT" } } = {}) {
  const { slugify } = require("./core.js");
  const { windowInfo } = require("./rules.js");
  const bySlug = new Map((index || []).map((x) => [x.slug, x]));
  const out = [];
  for (const w of Array.isArray(watch) ? watch : []) {
    if (!w || w.code !== code || w.kind === "tv" || !w.title) continue;
    const opened = String(w.th || w.released || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opened) || opened > today) continue;
    const info = windowInfo(w.language);
    if (!info) continue;
    const days = Math.round((Date.parse(today) - Date.parse(opened)) / 864e5);
    if (days <= info.hi * 7 || days > WAITING_MAX_DAYS) continue;   // inside the window, or long past being "waiting"
    const slug = slugify(w.title);
    const e = manifest[slug];
    if (announced.has(slug) || (e && (e.live || (e.digital && e.digital.date)))) continue;
    const page = bySlug.get(slug);
    if (page && ((page.providers || []).length || page.digitalDate)) continue;
    out.push({ slug: page ? slug : null, title: w.title, language: w.language || "", kind: "movie", genre: w.genre || "", poster: page ? page.poster || "" : "",
      days, hook: `Opened in cinemas ${days} days ago · ${w.language} films usually take ${info.lo}–${info.hi} weeks · no ${V.word === "OTT" ? "OTT" : "streaming"} date in our sources yet` });
  }
  // Films with a page first (the ones people search for), then the most recently overdue; 20 at most.
  return out.sort((a, b) => (!!b.slug - !!a.slug) || a.days - b.days || a.title.localeCompare(b.title)).slice(0, WAITING_MAX_ROWS);
}

function buildComingPage(items, cfg, { now = Date.now(), hasToday = true, waiting = [] } = {}) {
  const code = (cfg && cfg.code) || "in";
  const country = countryNameFor(cfg);
  const V = streamVocab(cfg);
  const loc = localeFor(code);
  const today = new Date(now);
  const wk = (d) => { const dt = new Date(`${d}T00:00:00Z`); const w = isoWeekOf(dt); return weekSlug(w); };
  const thisWk = weekSlug(isoWeekOf(today));
  const nextMon = isoWeekMonday(thisWk); nextMon.setUTCDate(nextMon.getUTCDate() + 7);
  const nextWk = weekSlug(isoWeekOf(nextMon));
  const groups = [["This week", []], ["Next week", []], ["Later", []]];
  for (const x of items) {
    const w = wk(x.date);
    // TMDB's digital date often names no service outside India (0 of 16 US dates, 31 Oct 2026),
    // and a US "digital" date usually means rental and purchase across every store. The card
    // names the service when the record does, "digital stores" when the note says VOD, and
    // otherwise says the date is a digital release whose platform isn't named yet.
    const name = digitalNoteName(x.platform);
    const row = { ...x, platform: name, hook: `Streaming from ${fmtDateFull(x.date, loc)}${name ? ` on ${name}` : ""}`,
      ...(name ? {} : { where: DIGITAL_UNNAMED }) };
    (w === thisWk ? groups[0] : w === nextWk ? groups[1] : groups[2])[1].push(row);
  }
  const sections = groups.filter(([, xs]) => xs.length).map(([h, xs]) => ({ h2: h, items: xs }));
  if (waiting.length) sections.push({ h2: "Still waiting: past the usual window, no date yet", items: waiting });
  const n = items.length;
  // Plain wording (rollout "human-prose", lib/humanprose.js), by the page's canonical URL.
  const plain = require("./humanprose.js").plainOn(comingUrl(code));
  const faqs = [{
    q: `What's coming to ${V.word} in ${country} next?`,
    a: items.slice(0, 5).map((x) => { const p = digitalNoteName(x.platform); return `${x.title} (${fmtDateShort(x.date, now, loc)}${p ? `, ${p}` : ", platform not named yet"})`; }).join(", ") + (n > 5 ? `, and ${n - 5} more.` : "."),
  }, {
    q: `Are these dates confirmed?`,
    // Repair sprint, 10 Nov 2026: the dates are TMDB's digital release dates, which its contributors
    // enter; FilmyChill doesn't check each against an announcement, so the page no longer says
    // "announced by the platform" or "Nothing here is a guess".
    a: `Not by FilmyChill. Each date comes from TMDB, where contributors add it, usually from the platform's or studio's announcement. We never list our own estimates, and each page switches to "streaming now" the day the title turns up.`,
  }];
  const url = comingUrl(code);
  const linkable = items.filter((x) => x.slug);
  return listingPageHtml({
    title: fitFirst([`Upcoming ${V.Releases} in ${country}: ${n} Dates | FilmyChill`, `Upcoming ${V.Releases} in ${country}: ${n} Dates`,
      `Upcoming ${V.Releases} in ${country} (${n})`, `Coming to ${V.word} in ${country}`], 60),
    desc: fitFirst([`${n} films with an ${V.word === "OTT" ? "OTT" : "streaming"} release date in ${country}, soonest first, with the platform where it's been named. Dates from TMDB, never our estimates.`,
      `${n} ${V.word === "OTT" ? "OTT" : "streaming"} release dates in ${country}, soonest first. Dates from TMDB.`], 160),
    canonical: url,
    h1: `Coming to ${V.word} in ${country}`,
    updLine: `${n} date${n === 1 ? "" : "s"} · updated ${new Date(now).toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" })}`,
    lead: `Films with a streaming date on TMDB, soonest first. TMDB's contributors add these dates, usually from the platform's or studio's announcement, and we don't check each one ourselves. When a date changes there, it changes here.`,
    sections, faqs, code,
    extraLd: [{ "@context": "https://schema.org", "@type": "CollectionPage", name: `Coming to ${V.word} in ${country}`, url,
      isPartOf: { "@type": "WebSite", "@id": "https://filmychill.com/#website" },
      mainEntity: { "@type": "ItemList", numberOfItems: linkable.length,
        itemListElement: linkable.map((x, i) => ({ "@type": "ListItem", position: i + 1, name: x.title, url: filmPageUrl(code, x.slug) })) } }],
    navLinks: [...(hasToday ? [{ href: todayUrl(code), label: `New on ${V.word} today` }] : []), { href: ottWeekUrl(code), label: `This week's ${V.word} releases` }],
    homeUrl: code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`,
  });
}

// THE ARRIVAL LOG (step 4, 8 Nov 2026): the today page as a dated log of the last two weeks, one
// section per day, each title with the part of the edition's day FilmyChill spotted it and, for a
// film we watched leave cinemas, how long that took. "Spotted", never "released": we know when we
// saw it, at one of the day's checks, not when the platform made it live. No clock times: the
// checks run a few hours apart, so a minute would claim a precision we don't have.
const LOG_DAYS = 14;
// Pure: the edition's local day and the part of it a sighting was made, from the record's write
// time; null without one (older records, tests).
function spottedAt(seenISO, code) {
  const tz = require("./freshness.js").EDITION_TZ[code];
  const t = seenISO ? new Date(seenISO) : null;
  if (!tz || !t || Number.isNaN(t.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(t);
  const g = (k) => (parts.find((p) => p.type === k) || {}).value;
  const h = Number(g("hour"));
  const part = h >= 22 || h < 5 ? "overnight" : h < 12 ? "in the morning" : h < 17 ? "in the afternoon" : "in the evening";
  return { day: `${g("year")}-${g("month")}-${g("day")}`, part };
}

// THE ARRIVAL RECORD ON A FILM PAGE (rollout "arrival-record", 9 Nov 2026): the same sighting the
// log shows, on the title's own page, for good. Only a live sighting counts: one whose write time
// falls within a day of its first date (dayOf above). A record written later is a backfill or a
// catalogue listing, and saying "spotted on 16 Oct" for it would be false. The first live sighting
// per edition and title is kept; it never changes afterwards, so the line can't churn a page.
// Two more guards, because a page keeps the line for good: the records written on the archive's
// first day (27 Aug 2026, 137 of them) are the titles already streaming when it started, not
// arrivals (The Simpsons, "first" 26 Aug on Disney+); and a title out more than two years before
// its first sighting is a catalogue listing, the line lib/history.js draws for windows too.
const SIGHTINGS_FROM = "2026-08-28";
const SIGHTING_MAX_GAP_DAYS = 730;
let SIGHTINGS = null;
function sightingOf(r, code) {
  const s = r && r.first ? spottedAt(r.seen, code) : null;
  if (!s || Math.abs(Date.parse(s.day) - Date.parse(String(r.first).slice(0, 10))) > 864e5) return null;
  if (String(r.seen).slice(0, 10) < SIGHTINGS_FROM) return null;
  const gap = r.rel ? (Date.parse(String(r.first).slice(0, 10)) - Date.parse(String(r.rel).slice(0, 10))) / 864e5 : null;
  if (gap != null && gap > SIGHTING_MAX_GAP_DAYS) return null;
  return { day: s.day, part: s.part, platform: require("./rules.js").canonProvider(r.p) || r.p };
}
// Each platform's first live sighting is kept too (rollout "platform-history", lib/depth.js): a
// title that later reaches a second platform says when that was seen as well.
let SIGHTINGS_BY_PLATFORM = null;
function useSightings(records) {
  const map = new Map(), all = new Map();
  for (const r of records || []) {
    if (!r || !r.c || !r.id) continue;
    const s = sightingOf(r, r.c);
    if (!s) continue;
    const key = `${r.c}:${r.k === "tv" ? "tv" : "movie"}:${r.id}`;
    const have = map.get(key);
    if (!have || s.day < have.day) map.set(key, s);
    if (!all.has(key)) all.set(key, new Map());
    const per = all.get(key), was = per.get(s.platform);
    if (!was || s.day < was.day) per.set(s.platform, s);
  }
  SIGHTINGS = map;
  SIGHTINGS_BY_PLATFORM = all;
  return map;
}
function sightingFor(code, item) {
  if (!SIGHTINGS || !item || !item.tmdbId) return null;
  return SIGHTINGS.get(`${code}:${item.kind === "tv" ? "tv" : "movie"}:${item.tmdbId}`) || null;
}
// The other platforms' first live sightings, after the first one, oldest first; only platforms
// the page still lists, so the line never reads as a platform it has left.
function laterSightingsFor(code, item, providers = []) {
  const first = sightingFor(code, item);
  if (!first || !SIGHTINGS_BY_PLATFORM) return [];
  const now = new Set((providers || []).map((p) => String(require("./rules.js").canonProvider(p) || p).toLowerCase()));
  return [...(SIGHTINGS_BY_PLATFORM.get(`${code}:${item.kind === "tv" ? "tv" : "movie"}:${item.tmdbId}`) || new Map()).values()]
    .filter((s) => s.platform !== first.platform && now.has(String(s.platform).toLowerCase()))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function buildTodayPage(records, cfg, { index = [], now = Date.now(), hasComing = true } = {}) {
  const code = (cfg && cfg.code) || "in";
  const country = countryNameFor(cfg);
  const V = streamVocab(cfg);
  const loc = localeFor(code);
  const { editionToday } = require("./freshness.js");
  const W = require("./windows.js");
  const today = editionToday(code, now);
  const back = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
  const yday = back(1), since = back(LOG_DAYS - 1);
  const bySlug = new Map((index || []).map((x) => [x.slug, x]));
  // A sighting's day is the edition's local day of the check that saw it; a record without a
  // usable write time (or one written well after its first day) keeps its recorded date.
  const dayOf = (r) => {
    const s = spottedAt(r.seen, code);
    return s && Math.abs(Date.parse(s.day) - Date.parse(String(r.first).slice(0, 10))) <= 864e5 ? s : { day: String(r.first).slice(0, 10), part: null };
  };
  const mine = (records || []).filter((r) => r && r.c === code && r.first).map((r) => ({ r, at: dayOf(r) }))
    .filter((x) => x.at.day >= since && x.at.day <= today)
    .sort((a, b) => b.at.day.localeCompare(a.at.day) || String(b.r.seen || "").localeCompare(String(a.r.seen || "")) || String(a.r.t || "").localeCompare(String(b.r.t || "")));
  const rowOf = ({ r, at }) => {
    const row = monthRow(r, { bySlug, code, now });
    const clock = W.clockFor(code, { kind: r.k === "tv" ? "tv" : "movie", tmdbId: r.id });
    // Counted to the day the row is filed under (lib/windows.js daysToSighting): "28 days" under
    // "Friday 7 Nov" for a film out 9 Oct read wrong by a day (All Pass, 9 Nov 2026).
    const days = clock ? (at.part ? W.daysToSighting(clock, { day: at.day }) : clock.days) : null;
    const bits = [`Spotted ${at.part ? `${at.part} ` : ""}on ${r.p}`, clock ? `${days} day${days === 1 ? "" : "s"} after cinemas` : null];
    return { ...row, hook: bits.filter(Boolean).join(" · ") };
  };
  const tod = mine.filter((x) => x.at.day === today).map(rowOf);
  const days = new Map();
  for (const x of mine) { if (!days.has(x.at.day)) days.set(x.at.day, []); days.get(x.at.day).push(x); }
  const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const sections = [...days.entries()].map(([d, xs]) => {
    const name = d === today ? "Today" : d === yday ? "Yesterday" : WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()];
    // The list shows each section's count beside its heading, so the heading is the day alone.
    return { h2: `${name}, ${fmtDateShort(d, now, loc)}`, items: xs.map(rowOf) };
  });
  const d = fmtDateShort(today, now, loc);
  // Plain wording (rollout "human-prose", lib/humanprose.js), by the page's canonical URL.
  const plain = require("./humanprose.js").plainOn(todayUrl(code));
  return listingPageHtml({
    title: fitFirst(tod.length
      ? [`${tod.length} New on ${V.word} Today in ${country} (${d}) | FilmyChill`, `${tod.length} New on ${V.word} Today in ${country} (${d})`, `New on ${V.word} Today (${d})`]
      : [`New on ${V.word} Today in ${country} (${d}) | FilmyChill`, `New on ${V.word} Today in ${country} (${d})`, `New on ${V.word} Today (${d})`], 60),
    desc: fitFirst([tod.length
      ? `${tod.length} title${tod.length === 1 ? "" : "s"} started streaming in ${country} today, ${d}, plus everything that arrived this week${plain ? ". Checked several times a day." : " — checked several times a day."}`
      : plain ? `What started streaming in ${country} over the last week, newest first. ${d}'s arrivals appear as soon as they land. Checked several times a day.`
      : `What started streaming in ${country} over the last week, newest first — ${d}'s arrivals appear as soon as they land. Checked several times a day.`], 160),
    canonical: todayUrl(code),
    h1: `New on ${V.word} today — ${country}`,
    updLine: `Updated ${new Date(now).toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" })} · checked several times a day`,
    // The log's own terms (8 Nov 2026): "spotted" at one of the day's checks, of the titles we track.
    lead: `${tod.length ? "" : `Nothing new has landed in ${country} yet today. `}Every title FilmyChill spotted arriving on a subscription service in ${country} over the last two weeks, by day, newest first, with the part of the day we first saw it. That is when we spotted it, not necessarily when it went live, and only for the titles we track.`,
    sections, faqs: [], code, extraLd: [],
    // Only link pages that exist this run — the coming page is gated and can be absent.
    navLinks: [...(hasComing ? [{ href: comingUrl(code), label: `Coming to ${V.word}` }] : []), { href: ottWeekUrl(code), label: `This week's ${V.word} releases` }],
    homeUrl: code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`,
  });
}

function writeDatedOttPages(data, cfg, manifest, records = null) {
  const code = cfg.code;
  const idx = filmIndexFor(cfg);
  const items = announcedDates(data, (manifest || {})[code] || {}, idx);
  const recs = records || readHistory();
  const hasWeek = recs.some((r) => r && r.c === code && r.first && r.first >= new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10));
  const hasComing = items.length >= COMING_MIN;
  const cp = comingPath(code);
  if (hasComing) {
    fs.mkdirSync(cp.slice(0, cp.lastIndexOf("/")), { recursive: true });
    let watch = [];
    try { watch = JSON.parse(fs.readFileSync("ott-watch.json", "utf8")); } catch { /* no watchlist this run */ }
    const waiting = stillWaiting(watch, code, { manifest: (manifest || {})[code] || {}, index: idx, announced: new Set(items.map((x) => x.slug)), today: require("./freshness.js").editionToday(code), V: streamVocab(cfg) });
    writeIfChanged(cp, buildComingPage(items, cfg, { hasToday: hasWeek, waiting }));
  } else if (fs.existsSync(cp)) {
    fs.rmSync(cp.slice(0, cp.lastIndexOf("/")), { recursive: true, force: true });
  }
  // "Movies released last week" (lib/lastweek.js), with the page index this step already read.
  try { require("./lastweek.js").writeLastWeekPage(data, cfg, manifest, idx); }
  catch (e) { console.warn(`  released-last-week [${code}]: ${e.message}`); }
  const tp = todayPath(code);
  if (hasWeek) {
    fs.mkdirSync(tp.slice(0, tp.lastIndexOf("/")), { recursive: true });
    writeIfChanged(tp, buildTodayPage(recs, cfg, { index: idx, hasComing }));
  } else if (fs.existsSync(tp)) {
    fs.rmSync(tp.slice(0, tp.lastIndexOf("/")), { recursive: true, force: true });
  }
  console.log(`  dated OTT pages [${code}]: ${items.length} announced date(s)${items.length >= COMING_MIN ? "" : " (below gate — no coming page)"}${hasWeek ? ", today page written" : ""}`);
}

function writePlatformHubPages(data, cfg) {
  const code = (cfg && cfg.code) || "in";
  const existing = existingHubSlugs(code);
  const hubs = hubsFor(data, existing);
  for (const hub of hubs) {
    const p = hubPath(code, hub.slug);
    const dir = p.slice(0, p.lastIndexOf("/"));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeIfChanged(p, buildPlatformHubPage(data, cfg, hub));
  }
  const live = new Set(hubs.map((h) => h.slug));
  LIVE_HUBS.set(code, live);

  // Prune hubs that no longer qualify. They stop being rewritten but were never removed, so
  // they lingered as unlinked pages serving month-old data while the sitemap kept claiming
  // they were fresh. Removing the directory lets the branded 404 handle any inbound link,
  // which drops them from the index cleanly. The keep-threshold above is what stops a
  // boundary provider from being created and pruned on alternate runs.
  const base = code === "in" ? "." : code;
  for (const slug of existing) {
    if (live.has(slug)) continue;
    const dir = `${base}/new-on-${slug}`;
    // Remove the hub PAGE only. Its directory also holds the platform's month archives
    // (/new-on-<slug>/YYYY-MM/), which are permanent records; deleting the directory used to
    // 404 them until the next run rebuilt them.
    try {
      fs.rmSync(`${dir}/index.html`, { force: true });
      if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
      console.log(`  hub pruned (${code}): new-on-${slug} — no longer qualifies`);
    } catch (e) { console.warn(`hub prune ${dir}: ${e.message}`); }
  }
  if (hubs.length) console.log(`  platform hubs (${code}): ${hubs.map((h) => "new-on-" + h.slug).join(", ")}`);
  return hubs;
}

// Pure: India data + language name -> full language landing page HTML.
// `archive` is this country's film index (see filmIndexFor) — every film page already on
// disk. It feeds the cumulative "More <language>" section below. Optional: tests and ad-hoc
// renders pass three arguments and get the old week-only page.
function buildLanguagePage(data, langName, slug, archive = null) {
  const url = `https://filmychill.com/${slug}/`;
  const gen = data.generatedAt || new Date().toISOString();
  const monthYear = new Date(gen).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const updatedHuman = new Date(gen).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  // Homepage titles in this language, PLUS the per-language pool built for exactly this page
  // (see langPools in buildCountry). Before the pool existed these pages were a pure filter
  // over a 7-slot theatre list and a 10-slot OTT list assembled for a mixed-language homepage,
  // which is how /malayalam/ and /kannada/ ended up rendering a single film each. Homepage
  // titles keep their order and lead; pool titles follow, deduped by tmdbId.
  const of = (k) => (data[k] || []).filter((x) => x && x.language === langName);
  const pool = (data.langPools && data.langPools[langName]) || { theatres: [], ott: [] };
  const merge = (primary, extra) => {
    const seen = new Set(primary.map((x) => x.tmdbId));
    const out = [...primary];
    for (const x of extra || []) {
      if (!x || seen.has(x.tmdbId)) continue;
      seen.add(x.tmdbId);
      out.push(x);
    }
    return out;
  };
  // A film that hasn't opened yet goes under "Coming soon", never "In theatres" (29 Oct 2026: the
  // Telugu page listed AK47 "In theatres · Releases 30 Oct" the day before it opened).
  const notOpen = (x) => releaseState(x && x.released, Date.parse(gen) || Date.now()) === "upcoming";
  const theatresAll = merge(of("theatres"), pool.theatres);
  const theatres = theatresAll.filter((x) => !notOpen(x));
  const ott = merge(of("ott"), pool.ott);
  // A page with almost nothing on it must not promise "every" title — that is a completeness
  // claim it cannot back, and thin-content-plus-overclaim is the worst combination to put in
  // front of a crawler. Below the threshold the copy softens and says so plainly instead.
  const thin = theatres.length + ott.length < 3;
  // The homepage's few coming-soon titles first, then this language's own upcoming pool
  // (soonExtra in buildCountry), soonest first. Never a passed date (normalizeUpcoming).
  // Where each one will be, from its own page: "In theatres from 5 Nov" (the date then not repeated),
  // or its platform when the page already names one.
  const genMs = Date.parse(gen) || Date.now();
  const pageOf = new Map((Array.isArray(archive) ? archive : []).filter((x) => x && x.slug).map((x) => [x.slug, x]));
  const soonWhere = (x) => {
    const w = whereLabel(pageOf.get(x.slug), { code: "in" }, { now: genMs });
    if (w === "In cinemas" && x.released) return { where: `In theatres from ${fmtDateShort(x.released, genMs, "en-IN")}`, whereDated: true };
    return w && (pageOf.get(x.slug).providers || []).length ? { where: w } : {};
  };
  // A cinema-list film not open yet is a theatrical release even before it has a page of its own.
  const opensLater = theatresAll.filter(notOpen).map((x) => ({ ...x, platform: null,
    ...(x.released ? { where: `In theatres from ${fmtDateShort(x.released, genMs, "en-IN")}`, whereDated: true } : {}) }));
  const soon = normalizeUpcoming(merge(merge(of("comingSoon"), of("soonExtra")), opensLater)
    .sort((a, b) => String(a.released || "").localeCompare(String(b.released || ""))))
    .map((x) => ({ ...x, ...soonWhere(x) }));
  const faqs = [];
  if (ott.length) faqs.push({
    q: `What's new in ${langName} on OTT this week?`,
    a: `New ${langName} titles streaming this week: ${ott.map((t) => `${t.title}${t.platform ? ` (${t.platform})` : ""}`).join(", ")}.`,
  });
  const best = [...theatres, ...ott].filter((x) => x.rating != null).sort((a, b) => b.rating - a.rating).slice(0, 3);
  if (best.length >= 2) faqs.push({
    q: `What are the best new ${langName} movies and shows this week?`,
    a: `Top-rated ${langName} picks: ${best.map((x) => `${x.title} (${Number(x.rating).toFixed(1)}/10)`).join(", ")}.`,
  });
  if (soon.length) faqs.push({
    q: `Which ${langName} movies are releasing soon?`,
    a: `Coming up: ${soon.map((x) => `${x.title}${x.released ? ` (${fmtDateFull(x.released, "en-IN")})` : ""}`).join(", ")}.`,
  });
  // ---- CUMULATIVE DEPTH ---------------------------------------------------
  // Sept 2026 GSC: the five language hubs drew 1,224 impressions for 11 clicks at average
  // position 42.4. /malayalam/ sat at 51.8 rendering ONE film under the line "A quiet week for
  // Malayalam". They were chasing head terms ("new malayalam movies") with less content than
  // every competitor on the page, because a strict this-week filter throws away every film
  // page we have ever built.
  // This adds the back catalogue we already own: same language, page exists on disk, released
  // in the last ~6 months, not already listed above. It is LABELLED as a back catalogue and
  // kept deliberately OUT of the this-week counts, the FAQ answers and the CollectionPage
  // ItemList — all of which make currency claims only this week's arrivals may back (see the
  // "currency claims" group in test.js).
  const BACK_CATALOGUE_DAYS = 180;
  const listedSlugs = new Set([...theatres, ...ott, ...soon].map((x) => x.slug).filter(Boolean));
  const bcCutoff = new Date(Date.parse(gen) - BACK_CATALOGUE_DAYS * 86400000).toISOString().slice(0, 10);
  const backCatalogue = (Array.isArray(archive) ? archive : [])
    .filter((x) => x && x.slug && x.language === langName && !listedSlugs.has(x.slug))
    .filter((x) => x.released && x.released >= bcCutoff && x.released <= gen.slice(0, 10))
    .sort((a, b) => String(b.released).localeCompare(String(a.released)))
    .slice(0, 24)
    // Each card says where to watch it, from its own page (29 Oct 2026): 34 of these were streaming
    // and named no platform, and 64 that aren't gave no hint of it.
    .map((x) => ({ ...x, where: whereLabel(x, { code: "in" }, { now: Date.parse(gen) || Date.now() }) || undefined }));
  const all = [...theatres, ...ott].filter((x) => x.slug);
  const extraLd = [{
    "@context": "https://schema.org", "@type": "CollectionPage",
    name: `New ${langName} Movies & OTT Releases This Week`, url, dateModified: gen,
    isPartOf: { "@type": "WebSite", "@id": "https://filmychill.com/#website" },
    mainEntity: { "@type": "ItemList", numberOfItems: all.length,
      itemListElement: all.map((x, i) => ({ "@type": "ListItem", position: i + 1, name: x.title, url: filmPageUrl("in", x.slug) })) },
  }, {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "FilmyChill", item: "https://filmychill.com/" },
      { "@type": "ListItem", position: 2, name: `${langName} this week`, item: url },
    ],
  }];
  // Plain wording (rollout "human-prose", lib/humanprose.js), by the page's canonical URL.
  const plain = require("./humanprose.js").plainOn(url);
  return listingPageHtml({
    title: `New ${langName} Movies & OTT Releases This Week (${monthYear}) | FilmyChill`,
    desc: plain
      ? `${thin ? "New" : "Every new"} ${langName} movie${thin ? "s" : ""} in theatres and on OTT this week, with ratings, critics' verdicts and where to watch. Updated twice daily.`
      : thin
        ? `New ${langName} movies in theatres and on OTT this week — ratings, critics' verdicts and where to watch. Updated twice daily.`
        : `Every new ${langName} movie in theatres and on OTT this week — ratings, critics' verdicts and where to watch. Updated twice daily.`,
    canonical: url,
    h1: `New ${langName} Movies & OTT This Week`,
    updLine: `Updated ${updatedHuman} · refreshed twice daily`,
    lead: plain
      ? (thin
        ? `The ${langName} titles in theatres and on OTT right now, with ratings, and what's coming next. It's a quiet week for ${langName}, so this page grows as more titles land.`
        : `Every ${langName} title that hit theatres or started streaming this week, with ratings, and what's coming next.`)
      : thin
        ? `The ${langName} titles in theatres and on OTT right now, ranked and rated — plus what's coming next. A quiet week for ${langName}; this page fills out as more lands.`
        : `Every ${langName} title that hit theatres or started streaming this week, ranked and rated — plus what's coming next.`,
    sections: [
      { h2: "In theatres", items: theatres },
      { h2: "Streaming now", items: ott },
      { h2: "Coming soon", items: soon },
      // The heading names the timeframe outright, so the page can never imply these are new.
      { h2: `More ${langName} from the last six months`, items: backCatalogue },
    ],
    faqs, extraLd, homeUrl: "https://filmychill.com/",
    // The language's most-searched film pages not already on this page (lib/searchtop.js).
    popular: popularBlockFor("in", { keep: (m) => m.lang === langName, exclude: new Set([...theatres, ...ott, ...soon, ...backCatalogue].map((x) => x && x.slug).filter(Boolean)) }),
  });
}

function writeLanguagePages(data) {
  // One disk walk for all five hubs, not one per hub.
  const archive = filmIndexFor({ code: "in" });
  for (const [langName, slug] of LANGUAGE_PAGES) {
    if (!fs.existsSync(slug)) fs.mkdirSync(slug, { recursive: true });
    writeIfChanged(`${slug}/index.html`, buildLanguagePage(data, langName, slug, archive));
  }
  console.log(`Language pages: ${LANGUAGE_PAGES.map(([, sl]) => "/" + sl + "/").join(" ")}`);
}
// Previous ISO week's slug — same week math, so year boundaries just work.
function prevWeekSlug(slug) {
  const monday = isoWeekMonday(slug);
  monday.setUTCDate(monday.getUTCDate() - 7);
  return weekSlug(isoWeekOf(monday));
}

// Deterministic lastmod for FROZEN week pages: the week's own Sunday. Never
// "today" for a page we didn't touch — the same honesty rule as the film archive.
function isoWeekSunday(slug) {
  const sun = isoWeekMonday(slug);
  sun.setUTCDate(sun.getUTCDate() + 6);
  return sun.toISOString().slice(0, 10);
}

// Pure: India data + week slug -> frozen-snapshot page HTML.
function buildWeekPage(data, slug, prevExists = false) {
  const url = `https://filmychill.com/week/${slug}/`;
  const monday = isoWeekMonday(slug);
  const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = (d) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  const range = `${fmt(monday)} – ${fmt(sunday)} ${sunday.getUTCFullYear()}`;
  const weekNo = Number(slug.split("-W")[1]);
  const theatres = (data.theatres || []).filter((x) => x && x.title);
  const ott = (data.ott || []).filter((x) => x && x.title);
  const all = [...theatres, ...ott].filter((x) => x.slug);
  const extraLd = [{
    "@context": "https://schema.org", "@type": "CollectionPage",
    name: `FilmyChill — Week ${weekNo}, ${slug.slice(0, 4)}`, url,
    dateModified: data.generatedAt || undefined,
    isPartOf: { "@type": "WebSite", "@id": "https://filmychill.com/#website" },
    mainEntity: { "@type": "ItemList", numberOfItems: all.length,
      itemListElement: all.map((x, i) => ({ "@type": "ListItem", position: i + 1, name: x.title, url: filmPageUrl("in", x.slug) })) },
  }];
  return listingPageHtml({
    // Nobody searches "Week 39"; they search "new OTT releases" plus a date.
    title: fitFirst([`New Movies & OTT Releases: ${range} (India)`, `New OTT Releases: ${range} (India)`, `OTT Releases: ${range}`], 60),
    desc: `What was worth watching in India in week ${weekNo} (${range}) — theatre releases and new OTT titles with ratings and verdicts. A permanent weekly snapshot.`,
    canonical: url,
    h1: `New movies & OTT releases: ${range}`,
    updLine: `India · theatres + OTT`,
    lead: `A permanent snapshot of what was worth watching this week — every share link stays alive forever.`,
    frozenNote: `This page captures week ${weekNo} of ${slug.slice(0, 4)} and stays frozen once the week ends. For the current list, head to the homepage.`,
    sections: [
      { h2: "In theatres", items: theatres },
      { h2: "Streaming", items: ott },
    ],
    faqs: [], extraLd, homeUrl: "https://filmychill.com/",
    // Chain to the previous snapshot so frozen weeks never orphan — a crawlable
    // (and human-browsable) path backwards through the whole archive.
    prevWeekHref: prevExists ? `https://filmychill.com/week/${prevWeekSlug(slug)}/` : null,
  });
}

// RETIRED, 26 Oct 2026 (the owner's decision), like the month archives (lib/hubs.js
// pruneRetiredListings): 17 snapshots earned 61 impressions and 1 click in 90 days, the current
// one repeated the homepage and /new-on-ott/, and past weeks are records nobody searches for.
// Removed first thing each build (the site branch is restored before a build); nothing links to
// them any more (footer, llms.txt and the IndexNow list dropped them; the dead-link pass unlinks
// anything older). buildWeekPage/writeWeekPage stay, tested, so this can be undone.
function pruneWeekPages(root = ".") {
  const path = require("path");
  const dir = path.join(root, "week");
  let n = 0;
  try { n = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "index.html"))).length; } catch { return 0; }
  fs.rmSync(dir, { recursive: true, force: true });
  return n;
}

function writeWeekPage(data) {
  const slug = weekSlug(isoWeekOf());
  const dir = `week/${slug}`;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const prevExists = fs.existsSync(`week/${prevWeekSlug(slug)}/index.html`);
  writeIfChanged(`${dir}/index.html`, buildWeekPage(data, slug, prevExists));
  console.log(`Week snapshot: /week/${slug}/${prevExists ? " → chained to previous week" : ""}`);
}

// IndexNow payload, regenerated each run. The key is public by design — IndexNow proves ownership
// via the matching KEY.txt served from the repo root, not by keeping the key secret.
// Only what changed (2 Nov 2026). Until then the base list carried every hub and every current
// film page (~900 URLs) twice a day whether or not they changed: ~1,800 "nothing changed" pings a
// day, which is the one pattern Bing's guidance says can get a key's pings deprioritised. Now the
// base list is the pages that change every build by construction (home, New on OTT and the
// language pages); hubs and film pages ride only when their sitemap lastmod is today
// (lib/sitemap.js extendIndexNowWithChanged), and hidden pages are announced once.
function indexNowUrls(builtCountries, dataByCode = {}) {
  void dataByCode;
  const urls = ["https://filmychill.com/", "https://filmychill.com/new-on-ott/", "https://filmychill.com/data/"];
  for (const cfg of builtCountries) {
    if (cfg.code !== "in") urls.push(`https://filmychill.com/${cfg.code}/`, `https://filmychill.com/${cfg.code}/new-on-ott/`);
  }
  for (const [, slug] of LANGUAGE_PAGES) urls.push(`https://filmychill.com/${slug}/`);
  return [...new Set(urls)].slice(0, 900);
}
function writeIndexNowPayload(builtCountries, dataByCode = {}) {
  const urls = indexNowUrls(builtCountries, dataByCode);
  fs.writeFileSync("indexnow-payload.json", JSON.stringify({
    host: "filmychill.com",
    key: "a95eba27e6b3f0e85e89e609241d6699",
    urlList: urls,
  }, null, 1));
  console.log(`IndexNow payload: ${urls.length} URLs`);
}

module.exports = {
  announcedDates,
  spottedAt,
  sightingFor,
  laterSightingsFor,
  sightingOf,
  useSightings,
  stillWaiting,
  buildComingPage,
  buildLanguagePage,
  buildTodayPage,
  buildWeekPage,
  comingPath,
  comingUrl,
  indexNowUrls,
  isoWeekSunday,
  prevWeekSlug,
  todayPath,
  todayUrl,
  writeDatedOttPages,
  writeIndexNowPayload,
  writeLanguagePages,
  writePlatformHubPages,
  writeWeekPage,
  pruneWeekPages,
};
