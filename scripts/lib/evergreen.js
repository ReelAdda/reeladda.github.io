// ============================================================================
// evergreen.js — evergreen pages: 'Streaming on <platform>' and people pages.
// ============================================================================
"use strict";

const fs = require("fs");
const {
  escHtml,
  filmPageUrl,
  fmtDateFull,
  slugify,
  localeFor,
} = require("./core.js");
const { rankFilms } = require("./score.js");
const { filmIndexFor } = require("./graph.js");
const {
  canonProvider,
  fitFirst,
  hubPath,
  hubUrl,
  listingPageHtml,
  PEOPLE_BASE,
  personPagePath,
  platformSlug,
  STREAM_BASE,
  streamPagePath,
} = require("./pagekit.js");
const { countryNameFor, streamVocab } = require("./rules.js");

 // code -> Set(slug)

// ============================================================================
// "STREAMING ON <PLATFORM>" PAGES — the evergreen answer to "movies on Netflix India".
//
// Two jobs. (1) They answer the year-round, high-volume query shape the weekly hubs can't:
// not "what's new on Netflix this week" but "what's on Netflix". (2) They are the crawl path
// into the catalogue. Sept 2026 GSC: catalogue pages had the best CTR of any film page (2.8%)
// but only 95 of ~1,680 had appeared in search, because nothing important linked to them.
// Each of these pages links dozens to hundreds of them from one crawlable URL.
//
// Honesty rule: a title is listed only if its availability was CONFIRMED recently — in this
// run's lists, or by a live claim the departure sweep rechecked within STREAM_PAGE_MAX_AGE
// days. Old frozen pages with an unchecked platform pill are not evidence. The lead says
// what the page is: the titles FilmyChill covers and has checked, not the whole library.
//
// Gates: a platform page needs STREAM_PAGE_MIN titles, a platform x language page
// STREAM_LANG_MIN. Below that, no page (thin pages are the scaled-content pattern).
// URLs: /streaming/<platform>/ and /streaming/<platform>/<language>/, per country.
// ============================================================================
const STREAM_PAGE_MIN = 12;
const STREAM_LANG_MIN = 6;
const STREAM_PAGE_MAX_AGE = 45;
const streamPageUrl = (code, pslug, lslug = null) => `https://filmychill.com/${STREAM_BASE(code)}/${pslug}/${lslug ? lslug + "/" : ""}`;

// Pure: which titles are verifiably on which platform, from this run's lists plus fresh
// manifest claims. Returns Map(platformName -> [{slug,title,language,kind,rating,votes,...}]).
function verifiedAvailability(data, manifestForCountry, index, now = Date.now()) {
  const byPlatform = new Map();
  const seen = new Map();   // slug -> entry (lists win over claims: they're today's data)
  const idx = new Map((index || []).map((x) => [x.slug, x]));
  const add = (slug, row, providers) => {
    if (!slug || seen.has(slug)) return;
    const provs = [...new Set((providers || []).map(canonProvider).filter(Boolean))];
    if (!provs.length) return;
    const entry = { ...row, slug, providers: provs };
    seen.set(slug, entry);
    for (const p of provs) {
      if (!byPlatform.has(p)) byPlatform.set(p, []);
      byPlatform.get(p).push(entry);
    }
  };
  for (const it of [...((data && data.ott) || []), ...((data && data.ottExtra) || [])]) {
    if (!it || !it.slug) continue;
    add(it.slug, { title: it.title, language: it.language || "", kind: it.kind || "movie", genre: it.genre || "",
      rating: it.rating ?? null, votes: it.votes || 0, verdict: it.verdict || null, poster: it.poster || "",
      released: it.released || null, platform: null }, it.providers);
  }
  for (const [slug, e] of Object.entries(manifestForCountry || {})) {
    const live = e && e.live;
    if (!live || !Array.isArray(live.providers) || !live.providers.length) continue;
    const checked = Date.parse(`${live.lastCheck || live.since}T00:00:00Z`);
    if (!Number.isFinite(checked) || (now - checked) / 864e5 > STREAM_PAGE_MAX_AGE) continue;
    const ix = idx.get(slug) || {};
    add(slug, { title: e.title || ix.title || slug, language: e.lang || ix.language || "", kind: e.kind || ix.kind || "movie",
      genre: ix.genre || "", rating: null, votes: 0, verdict: null, poster: ix.poster || "", released: e.released || ix.released || null,
      platform: null }, live.providers);
  }
  for (const list of byPlatform.values()) for (const x of list) x.platform = x.platform || null;
  return byPlatform;
}

function buildStreamingPage(items, cfg, { platform, pslug, language = null, lslug = null, langLinks = [], weeklyHub = null, now = Date.now() }) {
  const code = (cfg && cfg.code) || "in";
  const country = countryNameFor(cfg);
  const url = streamPageUrl(code, pslug, lslug);
  const n = items.length;
  const sorted = rankFilms(items);
  const films = sorted.filter((x) => x.kind !== "tv");
  const series = sorted.filter((x) => x.kind === "tv");
  const subject = language ? `${language} Movies & Series` : "Movies & Series";
  const checked = new Date(now).toLocaleDateString(localeFor(code), { day: "numeric", month: "short", year: "numeric" });
  const sections = [];
  if (films.length) sections.push({ h2: `${language ? language + " films" : "Films"} on ${platform}`, items: films.map((x) => ({ ...x, platform })) });
  if (series.length) sections.push({ h2: `${language ? language + " series" : "Series"} on ${platform}`, items: series.map((x) => ({ ...x, platform })) });
  const rated = sorted.filter((x) => x.rating != null && (x.votes || 0) >= 50);
  const faqs = [{
    q: `How many ${language ? language + " " : ""}titles are on ${platform} in ${country}?`,
    a: `FilmyChill has confirmed ${n} ${language ? language + " " : ""}film${n === 1 ? "" : "s"} and series streaming on ${platform} in ${country} (${films.length} film${films.length === 1 ? "" : "s"}, ${series.length} series). That is the part of the ${platform} library FilmyChill covers, not the whole catalogue.`,
  }];
  if (rated.length) faqs.push({
    q: `What's the best-rated ${language ? language + " " : ""}title on ${platform} in ${country}?`,
    a: `${rated[0].title}${rated[0].rating != null ? ` — ${Number(rated[0].rating).toFixed(1)}/10 across ${Number(rated[0].votes).toLocaleString("en-IN")} ratings` : ""}${rated[1] ? `, then ${rated[1].title}` : ""}${rated[2] ? ` and ${rated[2].title}` : ""}.`,
  });
  faqs.push({
    q: `How current is this list?`,
    a: `Every title was confirmed on ${platform} in ${country} within the last ${STREAM_PAGE_MAX_AGE} days, and FilmyChill rechecks each one. When a title leaves, its page says so and it drops off this list.`,
  });
  const navLinks = [];
  if (language) navLinks.push({ href: streamPageUrl(code, pslug), label: `Everything on ${platform} in ${country}` });
  for (const l of langLinks) navLinks.push({ href: streamPageUrl(code, pslug, l.slug), label: `${l.name} (${l.n})` });
  if (weeklyHub) navLinks.push({ href: weeklyHub, label: `New on ${platform} this week` });
  const linkable = sorted.filter((x) => x.slug);
  const extraLd = [{
    "@context": "https://schema.org", "@type": "CollectionPage",
    name: `${subject} on ${platform} in ${country}`, url,
    isPartOf: { "@type": "WebSite", "@id": "https://filmychill.com/#website" },
    mainEntity: { "@type": "ItemList", numberOfItems: linkable.length,
      itemListElement: linkable.slice(0, 200).map((x, i) => ({ "@type": "ListItem", position: i + 1, name: x.title, url: filmPageUrl(code, x.slug) })) },
  }, {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "FilmyChill", item: code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/` },
      { "@type": "ListItem", position: 2, name: `On ${platform}`, item: streamPageUrl(code, pslug) },
      ...(language ? [{ "@type": "ListItem", position: 3, name: language, item: url }] : []),
    ],
  }];
  return listingPageHtml({
    title: fitFirst([
      `${subject} on ${platform} in ${country} (${n}) | FilmyChill`,
      `${subject} on ${platform} in ${country} (${n})`,
      `${subject} on ${platform} (${country})`,
      `${language ? language + " " : ""}Titles on ${platform} in ${country}`,
    ], 60),
    desc: fitFirst([
      `All ${n} ${language ? language + " " : ""}movies and series FilmyChill has confirmed streaming on ${platform} in ${country}, rated and ranked — each one rechecked, last updated ${checked}.`,
      `${n} ${language ? language + " " : ""}movies and series confirmed on ${platform} in ${country}, rated and ranked. Updated ${checked}.`,
    ], 160),
    canonical: url,
    h1: `${subject} on ${platform} in ${country}`,
    updLine: `${n} title${n === 1 ? "" : "s"} · availability confirmed within ${STREAM_PAGE_MAX_AGE} days · updated ${checked}`,
    lead: `The ${language ? language + " " : ""}films and series FilmyChill covers that are streaming on ${platform} in ${country} right now, best-rated first. Not the whole ${platform} library — every title here has been checked against ${platform}'s current listing.`,
    sections, faqs, extraLd, navLinks, code,
    homeUrl: code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`,
  });
}

// Writes every page that clears its gate and removes the ones that no longer do. Returns the
// written set, so hubs, film pages and the footer can link only to pages that exist.
function writeStreamingPages(data, cfg, manifest, index = null) {
  const code = cfg.code;
  const idx = index || filmIndexFor(cfg);
  const avail = verifiedAvailability(data, (manifest || {})[code] || {}, idx);
  const written = new Set();
  const summary = [];
  for (const [platform, items] of avail) {
    if (items.length < STREAM_PAGE_MIN) continue;
    const pslug = platformSlug(platform);
    if (!pslug) continue;
    const byLang = new Map();
    for (const x of items) { if (!x.language) continue; if (!byLang.has(x.language)) byLang.set(x.language, []); byLang.get(x.language).push(x); }
    const langs = [...byLang.entries()].filter(([, xs]) => xs.length >= STREAM_LANG_MIN)
      .sort((a, b) => b[1].length - a[1].length).map(([name, xs]) => ({ name, slug: slugify(name), n: xs.length, xs }));
    const weekly = fs.existsSync(hubPath(code, pslug)) ? hubUrl(code, pslug) : null;
    const main = streamPagePath(code, pslug);
    fs.mkdirSync(main.slice(0, main.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(main, buildStreamingPage(items, cfg, { platform, pslug, langLinks: langs, weeklyHub: weekly }));
    written.add(main);
    for (const l of langs) {
      const lp = streamPagePath(code, pslug, l.slug);
      fs.mkdirSync(lp.slice(0, lp.lastIndexOf("/")), { recursive: true });
      fs.writeFileSync(lp, buildStreamingPage(l.xs, cfg, { platform, pslug, language: l.name, lslug: l.slug,
        langLinks: langs.filter((x) => x.slug !== l.slug), weeklyHub: weekly }));
      written.add(lp);
    }
    summary.push(`${platform} ${items.length}${langs.length ? ` (${langs.map((l) => l.name + " " + l.n).join(", ")})` : ""}`);
  }
  // Prune pages that fell below their gate: a page that still exists would keep claiming
  // titles we can no longer confirm.
  const base = STREAM_BASE(code);
  if (fs.existsSync(base)) {
    for (const p of fs.readdirSync(base)) {
      const pdir = `${base}/${p}`;
      if (!fs.statSync(pdir).isDirectory()) continue;
      for (const l of fs.readdirSync(pdir)) {
        const ldir = `${pdir}/${l}`;
        if (fs.statSync(ldir).isDirectory() && !written.has(`${ldir}/index.html`)) fs.rmSync(ldir, { recursive: true, force: true });
      }
      if (!written.has(`${pdir}/index.html`)) fs.rmSync(pdir, { recursive: true, force: true });
    }
  }
  if (summary.length) console.log(`  streaming pages [${code}]: ${summary.join("; ")}`);
  return written;
}

// ============================================================================
// PEOPLE PAGES — "Fahadh Faasil: films streaming now".
//
// 206 actors and 31 directors already had 3+ films on the India site in Sept 2026, with no
// page of their own. The query shape these can win is not the bare name (Wikipedia and IMDb
// own that) but name + platform / "movies on OTT" — so the page leads with what is streaming
// now and where, then everything else FilmyChill covers. It never claims to be a complete
// filmography: the lead says it lists the films this site covers.
//
// Built from the film pages on disk (their JSON-LD names the top-billed cast and director,
// with TMDB profile images), gated at PEOPLE_MIN films per country. Streaming status comes
// from the same verified-availability rule as the platform pages — a recent confirmation,
// never an old pill.
// ============================================================================
const PEOPLE_MIN = 5;
const personPageUrl = (code, slug) => `https://filmychill.com/${PEOPLE_BASE(code)}/${slug}/`;
const peopleIndexUrl = (code) => `https://filmychill.com/${PEOPLE_BASE(code)}/`;

// Reads each film page's JSON-LD once: person -> films. Top-billed only (the first four
// actors), because a supporting role in one film is not what someone searching a name wants.
function peopleIndexFor(cfg) {
  const code = cfg.code;
  const dir = code === "in" ? "movie" : `${code}/movie`;
  const people = new Map();
  if (!fs.existsSync(dir)) return people;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".html")) continue;
    let html;
    try { html = fs.readFileSync(`${dir}/${f}`, "utf8"); } catch { continue; }
    if (/<meta name="robots" content="[^"]*noindex/.test(html)) continue;
    const m = /<script type="application\/ld\+json">(\{"@context[^<]*?"@type":"(?:Movie|TVSeries)"[\s\S]*?)<\/script>/.exec(html);
    if (!m) continue;
    let ld; try { ld = JSON.parse(m[1]); } catch { continue; }
    const film = { slug: f.slice(0, -5), title: ld.name, kind: ld["@type"] === "TVSeries" ? "tv" : "movie",
      language: ld.inLanguage || "", genre: ld.genre || "", released: String(ld.datePublished || "").slice(0, 10),
      poster: Array.isArray(ld.image) ? ld.image[0] : (ld.image || "") };
    const roles = [];
    for (const a of (ld.actor || []).slice(0, 4)) if (a && a.name) roles.push({ name: a.name, image: a.image || "", role: "actor" });
    for (const d of [].concat(ld.director || [])) if (d && d.name) roles.push({ name: d.name, image: d.image || "", role: "director" });
    for (const r of roles) {
      const key = slugify(r.name);
      if (!key) continue;
      if (!people.has(key)) people.set(key, { name: r.name, slug: key, image: "", films: new Map(), roles: new Set() });
      const p = people.get(key);
      if (!p.image && r.image) p.image = r.image;
      p.roles.add(r.role);
      p.films.set(film.slug, film);
    }
  }
  return people;
}

function buildPersonPage(person, cfg, { availability, now = Date.now() }) {
  const code = (cfg && cfg.code) || "in";
  const country = countryNameFor(cfg);
  const url = personPageUrl(code, person.slug);
  const films = [...person.films.values()].sort((a, b) => String(b.released).localeCompare(String(a.released)));
  const streaming = [], elsewhere = [];
  for (const f of films) {
    const provs = availability.get(f.slug);
    (provs && provs.length ? streaming : elsewhere).push({ ...f, platform: provs && provs.length ? provs[0] : null, providers: provs || [] });
  }
  const n = films.length;
  const roleWord = person.roles.has("actor") ? (person.roles.has("director") ? "Films" : "Films") : "Films directed by";
  const who = person.roles.has("actor") ? person.name : `${person.name}`;
  const sections = [];
  if (streaming.length) sections.push({ h2: `Streaming now in ${country}`, items: streaming });
  if (elsewhere.length) sections.push({ h2: streaming.length ? "More of their films on FilmyChill" : `Films on FilmyChill`, items: elsewhere });
  const platforms = [...new Set(streaming.flatMap((x) => x.providers))].slice(0, 4);
  const faqs = [];
  if (streaming.length) faqs.push({
    q: `Which ${person.name} films can I stream in ${country}?`,
    a: `${streaming.length} right now: ${streaming.slice(0, 5).map((x) => `${x.title} (${x.platform})`).join(", ")}${streaming.length > 5 ? ", and more below" : ""}.`,
  });
  if (films[0]) faqs.push({
    q: `What's the latest ${person.name} ${films[0].kind === "tv" ? "title" : "film"} on FilmyChill?`,
    a: `${films[0].title}${films[0].released ? `, released ${fmtDateFull(films[0].released, localeFor(code))}` : ""}.`,
  });
  const titleBits = streaming.length
    ? [`${person.name} Movies Streaming in ${country}: ${platforms.slice(0, 2).join(", ")} | FilmyChill`,
       `${person.name} Movies Streaming in ${country}: ${platforms.slice(0, 2).join(", ")}`,
       `${person.name} Movies Streaming in ${country}`,
       `${person.name} Movies on ${streamVocab(cfg).word}`]
    : [`${person.name}: ${n} Films & Where to Watch in ${country} | FilmyChill`,
       `${person.name}: ${n} Films & Where to Watch in ${country}`,
       `${person.name} Films — Where to Watch`];
  const extraLd = [{
    "@context": "https://schema.org", "@type": "ProfilePage", url,
    mainEntity: { "@type": "Person", name: person.name, ...(person.image ? { image: person.image } : {}) },
    isPartOf: { "@type": "WebSite", "@id": "https://filmychill.com/#website" },
  }, {
    "@context": "https://schema.org", "@type": "ItemList", numberOfItems: n,
    itemListElement: films.map((x, i) => ({ "@type": "ListItem", position: i + 1, name: x.title, url: filmPageUrl(code, x.slug) })),
  }, {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "FilmyChill", item: code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/` },
      { "@type": "ListItem", position: 2, name: "People", item: peopleIndexUrl(code) },
      { "@type": "ListItem", position: 3, name: person.name, item: url },
    ],
  }];
  void roleWord; void who;
  return listingPageHtml({
    title: fitFirst(titleBits, 60),
    desc: fitFirst([
      streaming.length
        ? `${streaming.length} ${person.name} ${streaming.length === 1 ? "title is" : "titles are"} streaming in ${country} now${platforms.length ? ` on ${platforms.join(", ")}` : ""}. Every ${person.name} film FilmyChill covers, with ratings and where to watch.`
        : `The ${n} ${person.name} films FilmyChill covers in ${country}, with ratings, verdicts and where each one is streaming.`,
      `${person.name}: the ${n} films FilmyChill covers in ${country}, and where to watch each.`,
    ], 160),
    canonical: url,
    h1: streaming.length ? `${person.name}: films streaming in ${country}` : `${person.name} on FilmyChill`,
    updLine: `${n} film${n === 1 ? "" : "s"} covered · ${streaming.length} streaming now in ${country}`,
    lead: `The ${person.name} films and series FilmyChill covers — streaming ones first, with the platform each is on today. Not a complete filmography: only titles this site has a page for.`,
    sections, faqs, extraLd, code,
    navLinks: [{ href: peopleIndexUrl(code), label: `More people on FilmyChill ${country}` }],
    homeUrl: code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`,
  });
}

function writePeoplePages(data, cfg, manifest) {
  const code = cfg.code;
  const people = [...peopleIndexFor(cfg).values()].filter((p) => p.films.size >= PEOPLE_MIN);
  const avail = new Map();
  for (const [platform, items] of verifiedAvailability(data, (manifest || {})[code] || {}, filmIndexFor(cfg))) {
    for (const x of items) { if (!avail.has(x.slug)) avail.set(x.slug, []); avail.get(x.slug).push(platform); }
  }
  const written = new Set();
  for (const p of people) {
    const path = personPagePath(code, p.slug);
    fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(path, buildPersonPage(p, cfg, { availability: avail }));
    written.add(p.slug);
  }
  const base = PEOPLE_BASE(code);
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      if (fs.statSync(`${base}/${d}`).isDirectory() && !written.has(d)) fs.rmSync(`${base}/${d}`, { recursive: true, force: true });
    }
  }
  if (people.length) {
    // One index per country: the crawl path to every person page, alphabetical.
    const country = countryNameFor(cfg);
    const sorted = people.slice().sort((a, b) => a.name.localeCompare(b.name));
    const items = sorted.map((p) => ({ title: p.name, slug: null, href: personPageUrl(code, p.slug), language: `${p.films.size} films`, kind: "movie" }));
    const listHtml = `<ul class="people">${sorted.map((p) => `<li><a href="/${escHtml(base)}/${escHtml(p.slug)}/">${escHtml(p.name)}</a> <span style="color:var(--mute)">· ${p.films.size} films</span></li>`).join("")}</ul>`;
    void items;
    const page = listingPageHtml({
      title: fitFirst([`Actors & Directors on FilmyChill ${country} | FilmyChill`, `Actors & Directors on FilmyChill ${country}`], 60),
      desc: `Where to stream the films of ${sorted.length} actors and directors FilmyChill covers in ${country} — each page lists what is streaming now and on which platform.`,
      canonical: peopleIndexUrl(code),
      h1: `Actors & directors — ${country}`,
      updLine: `${sorted.length} people with ${PEOPLE_MIN}+ films on FilmyChill`,
      lead: `Pick a name to see which of their films are streaming in ${country} right now, and where.`,
      sections: [], faqs: [], extraLd: [], code,
      homeUrl: code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`,
    }).replace(/(<p class="lead">[\s\S]*?<\/p>)/, `$1${listHtml}`);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(`${base}/index.html`, page);
    console.log(`  people pages [${code}]: ${people.length} (${PEOPLE_MIN}+ films each)`);
  } else if (fs.existsSync(`${base}/index.html`)) {
    fs.rmSync(`${base}/index.html`, { force: true });
  }
  return written;
}

module.exports = {
  buildPersonPage,
  buildStreamingPage,
  PEOPLE_MIN,
  peopleIndexFor,
  peopleIndexUrl,
  personPageUrl,
  STREAM_LANG_MIN,
  STREAM_PAGE_MIN,
  streamPageUrl,
  verifiedAvailability,
  writePeoplePages,
  writeStreamingPages,
};
