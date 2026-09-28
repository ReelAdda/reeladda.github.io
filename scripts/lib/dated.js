// ============================================================================
// dated.js — dated and listing pages: 'Coming to OTT', 'New on OTT today', language landing
// pages, weekly snapshots, the platform-hub writer and the IndexNow payload.
// ============================================================================
"use strict";

const fs = require("fs");
const {
  LANGUAGE_PAGES,
  filmPageUrl,
  fmtDateShort,
  fmtDateFull,
  localeFor,
} = require("./core.js");
const { readHistory } = require("./history.js");
const { browsePath, filmIndexFor } = require("./graph.js");
const { normalizeUpcoming } = require("./release.js");
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
} = require("./pagekit.js");
const { countryNameFor, streamVocab } = require("./rules.js");
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

function buildComingPage(items, cfg, { now = Date.now(), hasToday = true } = {}) {
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
    const row = { ...x, hook: `Streaming from ${fmtDateFull(x.date, loc)}${x.platform ? ` on ${x.platform}` : ""}` };
    (w === thisWk ? groups[0] : w === nextWk ? groups[1] : groups[2])[1].push(row);
  }
  const sections = groups.filter(([, xs]) => xs.length).map(([h, xs]) => ({ h2: h, items: xs }));
  const n = items.length;
  const faqs = [{
    q: `What's coming to ${V.word} in ${country} next?`,
    a: items.slice(0, 5).map((x) => `${x.title} (${fmtDateShort(x.date, now, loc)}${x.platform ? `, ${x.platform}` : ""})`).join(", ") + (n > 5 ? `, and ${n - 5} more.` : "."),
  }, {
    q: `Are these dates confirmed?`,
    a: `Yes — every date here was announced by the platform or studio and published on TMDB. Estimates are never listed. Each page switches to "streaming now" the day the title lands.`,
  }];
  const url = comingUrl(code);
  const linkable = items.filter((x) => x.slug);
  return listingPageHtml({
    title: fitFirst([`Upcoming ${V.Releases} in ${country}: ${n} Dates Announced | FilmyChill`, `Upcoming ${V.Releases} in ${country}: ${n} Dates Announced`,
      `Upcoming ${V.Releases} in ${country} (${n})`, `Coming to ${V.word} in ${country}`], 60),
    desc: fitFirst([`${n} films with an announced ${V.word === "OTT" ? "OTT" : "streaming"} release date in ${country}, soonest first — with the platform, where it's been named. Announced dates only, never estimates.`,
      `${n} announced ${V.word === "OTT" ? "OTT" : "streaming"} release dates in ${country}, soonest first.`], 160),
    canonical: url,
    h1: `Coming to ${V.word} in ${country}`,
    updLine: `${n} announced date${n === 1 ? "" : "s"} · updated ${new Date(now).toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" })}`,
    lead: `Films with a streaming date the platform has announced, soonest first. Nothing here is a guess: when a date moves, the list moves with it.`,
    sections, faqs, code,
    extraLd: [{ "@context": "https://schema.org", "@type": "CollectionPage", name: `Coming to ${V.word} in ${country}`, url,
      isPartOf: { "@type": "WebSite", "@id": "https://filmychill.com/#website" },
      mainEntity: { "@type": "ItemList", numberOfItems: linkable.length,
        itemListElement: linkable.map((x, i) => ({ "@type": "ListItem", position: i + 1, name: x.title, url: filmPageUrl(code, x.slug) })) } }],
    navLinks: [...(hasToday ? [{ href: todayUrl(code), label: `New on ${V.word} today` }] : []), { href: ottWeekUrl(code), label: `This week's ${V.word} releases` }],
    homeUrl: code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`,
  });
}

function buildTodayPage(records, cfg, { index = [], now = Date.now(), hasComing = true } = {}) {
  const code = (cfg && cfg.code) || "in";
  const country = countryNameFor(cfg);
  const V = streamVocab(cfg);
  const loc = localeFor(code);
  const day = (offset) => new Date(now - offset * 864e5).toISOString().slice(0, 10);
  const today = day(0), yday = day(1), weekAgo = day(7);
  const bySlug = new Map((index || []).map((x) => [x.slug, x]));
  const mine = (records || []).filter((r) => r && r.c === code && r.first && r.first >= weekAgo)
    .sort((a, b) => String(b.first).localeCompare(String(a.first)) || String(a.t || "").localeCompare(String(b.t || "")));
  const rowOf = (r) => monthRow(r, { bySlug, code, now });
  const tod = mine.filter((r) => r.first === today).map(rowOf);
  const yst = mine.filter((r) => r.first === yday).map(rowOf);
  const earlier = mine.filter((r) => r.first < yday).map(rowOf);
  const sections = [];
  if (tod.length) sections.push({ h2: `Today, ${fmtDateShort(today, now, loc)}`, items: tod });
  if (yst.length) sections.push({ h2: `Yesterday, ${fmtDateShort(yday, now, loc)}`, items: yst });
  if (earlier.length) sections.push({ h2: "Earlier this week", items: earlier });
  const d = fmtDateShort(today, now, loc);
  return listingPageHtml({
    title: fitFirst(tod.length
      ? [`${tod.length} New on ${V.word} Today in ${country} (${d}) | FilmyChill`, `${tod.length} New on ${V.word} Today in ${country} (${d})`, `New on ${V.word} Today (${d})`]
      : [`New on ${V.word} Today in ${country} (${d}) | FilmyChill`, `New on ${V.word} Today in ${country} (${d})`, `New on ${V.word} Today (${d})`], 60),
    desc: fitFirst([tod.length
      ? `${tod.length} title${tod.length === 1 ? "" : "s"} started streaming in ${country} today, ${d}, plus everything that arrived this week — checked twice a day.`
      : `What started streaming in ${country} over the last week, newest first — ${d}'s arrivals appear as soon as they land. Checked twice a day.`], 160),
    canonical: todayUrl(code),
    h1: `New on ${V.word} today — ${country}`,
    updLine: `Updated ${new Date(now).toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" })} · checked twice a day`,
    lead: tod.length
      ? `What appeared on a subscription service in ${country} today, then the rest of the week. Every date is the day FilmyChill first saw it streaming.`
      : `Nothing new has landed in ${country} yet today. Here's everything that arrived this week, newest first — today's titles appear here the moment they do.`,
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
    fs.writeFileSync(cp, buildComingPage(items, cfg, { hasToday: hasWeek }));
  } else if (fs.existsSync(cp)) {
    fs.rmSync(cp.slice(0, cp.lastIndexOf("/")), { recursive: true, force: true });
  }
  const tp = todayPath(code);
  if (hasWeek) {
    fs.mkdirSync(tp.slice(0, tp.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(tp, buildTodayPage(recs, cfg, { index: idx, hasComing }));
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
    fs.writeFileSync(p, buildPlatformHubPage(data, cfg, hub));
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
  const theatres = merge(of("theatres"), pool.theatres);
  const ott = merge(of("ott"), pool.ott);
  // A page with almost nothing on it must not promise "every" title — that is a completeness
  // claim it cannot back, and thin-content-plus-overclaim is the worst combination to put in
  // front of a crawler. Below the threshold the copy softens and says so plainly instead.
  const thin = theatres.length + ott.length < 3;
  const soon = normalizeUpcoming(of("comingSoon")); // never list a passed date under "Coming soon"
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
    .slice(0, 24);
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
  return listingPageHtml({
    title: `New ${langName} Movies & OTT Releases This Week (${monthYear}) | FilmyChill`,
    desc: thin
      ? `New ${langName} movies in theatres and on OTT this week — ratings, critics' verdicts and where to watch. Updated twice daily.`
      : `Every new ${langName} movie in theatres and on OTT this week — ratings, critics' verdicts and where to watch. Updated twice daily.`,
    canonical: url,
    h1: `New ${langName} Movies & OTT This Week`,
    updLine: `Updated ${updatedHuman} · refreshed twice daily`,
    lead: thin
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
  });
}

function writeLanguagePages(data) {
  // One disk walk for all five hubs, not one per hub.
  const archive = filmIndexFor({ code: "in" });
  for (const [langName, slug] of LANGUAGE_PAGES) {
    if (!fs.existsSync(slug)) fs.mkdirSync(slug, { recursive: true });
    fs.writeFileSync(`${slug}/index.html`, buildLanguagePage(data, langName, slug, archive));
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

function writeWeekPage(data) {
  const slug = weekSlug(isoWeekOf());
  const dir = `week/${slug}`;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const prevExists = fs.existsSync(`week/${prevWeekSlug(slug)}/index.html`);
  fs.writeFileSync(`${dir}/index.html`, buildWeekPage(data, slug, prevExists));
  console.log(`Week snapshot: /week/${slug}/${prevExists ? " → chained to previous week" : ""}`);
}

// IndexNow payload, regenerated each run so DYNAMIC urls (the current week snapshot)
// and every configured country/language page get pinged without ever editing the
// workflow again. The key is public by design — IndexNow proves ownership via the
// matching KEY.txt served from the repo root, not by keeping the key secret.
function indexNowUrls(builtCountries, dataByCode = {}) {
  const urls = ["https://filmychill.com/", "https://filmychill.com/new-on-ott/",
    "https://filmychill.com/data/", "https://filmychill.com/llms-full.txt"];
  for (const cfg of builtCountries) {
    if (cfg.code !== "in") urls.push(`https://filmychill.com/${cfg.code}/`, `https://filmychill.com/${cfg.code}/new-on-ott/`);
    // Browse index (page 1 per country): the crawl path into the archive. Announcing it on
    // every run keeps the door Google walks through freshly stamped.
    urls.push(`https://filmychill.com${browsePath(cfg.code, 1)}`);
    const d = dataByCode[cfg.code];
    if (!d) continue;
    for (const h of hubsFor(d)) urls.push(hubUrl(cfg.code, h.slug));
    for (const it of [...(d.theatres || []), ...(d.ott || [])]) if (it.slug) urls.push(filmPageUrl(cfg.code, it.slug));
  }
  for (const [, slug] of LANGUAGE_PAGES) urls.push(`https://filmychill.com/${slug}/`);
  urls.push(`https://filmychill.com/week/${weekSlug(isoWeekOf())}/`);
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
};
