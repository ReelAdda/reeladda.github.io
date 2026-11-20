// ============================================================================
// studiowindows.js — cinema-to-digital windows by studio outside India, the expected digital date
// they imply for films now in cinemas, and where the Best Picture nominees stream (20 Nov 2026).
//
// The India tables on /data/ answer the question an Indian desk asks: how long, by language. The
// same question in the US, the UK, Australia and Canada is asked by studio (3Vision's Movie
// Tracker, Tom's Guide's "when is it streaming? our best guess"), and FilmyChill's own measured
// record there is a dozen films per country. So, for those four countries only:
//
//   1. WINDOWS BY STUDIO. The same source and method as India's historical table
//      (lib/indiadata.js): TMDB's per-country release dates, cinema (types 2 and 3) to digital
//      (type 4). Outside India a "digital" date is usually the first day a film can be bought or
//      rented at home, not its arrival on a subscription service, and the page says so. The
//      studio is the first of the film's production companies that belongs to a major group;
//      TMDB has no distributor field, so this is the producing studio, which the page also says.
//
//   2. EXPECTED DIGITAL DATE. For a film in cinemas with no digital date yet: its cinema date
//      plus its studio's median in that country. Shown as an estimate, never as an announcement,
//      and only where the studio has STUDIO_MIN measured films there.
//
//   3. BEST PICTURE NOMINEES. Wikidata records each nomination on the producers, with the film
//      as "for work"; that gives ten films with TMDB ids (98th: 10 of 10; 97th: 10; 96th: 9, so
//      the section appears only when exactly ten are listed). Shown from the day ten are listed
//      until AWARDS_AFTER_DAYS after the ceremony. Outside that season nothing is asked.
//
// State: a "world" key inside ott-digital.json, beside India's own keys, which this module never
// reads or writes. That file is already committed by the workflow and never published.
// Everything here appears as sections of the one /data/ page; a section with too little behind
// it is not drawn, so the page is unchanged until the record has filled.
// ============================================================================
"use strict";

const fs = require("fs");
const { escHtml } = require("./core.js");
const { regionalTheatricalDate, digitalReleaseFor } = require("./enrich.js");
const { median } = require("./history.js");
const { DIGITAL_FILE, digitalWindows } = require("./indiadata.js");

const MARKETS = [
  { code: "us", region: "US", name: "United States" },
  { code: "uk", region: "GB", name: "United Kingdom" },
  { code: "au", region: "AU", name: "Australia" },
  { code: "ca", region: "CA", name: "Canada" },
];
const DISCOVER_PAGES = 3;         // per country and quarter: the 60 most popular cinema releases
const RECHECK_DAYS = 14;          // a film with no digital date yet is asked again this often
const RECHECK_AGE = 400;          // ...until its cinema release is this old
const MAX_WINDOW = 365;           // longer than this: a late catalogue listing, not a release window
const MARKET_MIN = 40;            // measured films before a country gets its section
const STUDIO_MIN = 8;             // measured films before a studio gets a row, or backs an estimate
const EXPECT_CINEMA_DAYS = 150;   // "now in cinemas": opened this recently, no digital date yet
const EXPECT_ROWS = 12;
const AWARDS_AFTER_DAYS = 45;     // the nominees table stays this long after the ceremony
const WIKIDATA = "https://query.wikidata.org/sparql";
const UA = "FilmyChillBuild/1.0 (https://filmychill.com; site build)";

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => iso(Date.parse(`${d}T00:00:00Z`) + n * 864e5);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const dayHuman = (x) => new Date(`${x}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const monthHuman = (x) => new Date(`${x}T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
function readStore(file = DIGITAL_FILE) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } }

// The major groups, by the production-company names TMDB uses. First match in the film's own
// company order wins, so a co-production goes to the company TMDB lists first.
const STUDIOS = [
  ["Disney", /^(walt disney pictures|walt disney animation studios|pixar|marvel studios|lucasfilm(?: ltd\.?)?|20th century studios|20th century animation|searchlight pictures)$/i],
  ["Warner Bros.", /^(warner bros\. pictures|warner bros\. pictures animation|warner bros\. animation|new line cinema|dc studios|dc films|castle rock entertainment)$/i],
  ["Universal", /^(universal pictures|focus features|illumination|dreamworks animation|working title films|universal animation studios)$/i],
  ["Sony", /^(columbia pictures|tristar pictures|screen gems|sony pictures animation|sony pictures classics|sony pictures|stage 6 films)$/i],
  ["Paramount", /^(paramount pictures|paramount animation|paramount players|nickelodeon movies|paramount)$/i],
  ["Lionsgate", /^(lionsgate|lionsgate films|summit entertainment)$/i],
  ["Amazon MGM", /^(amazon mgm studios|metro-goldwyn-mayer|amazon studios|orion pictures|united artists)$/i],
  ["A24", /^a24$/i],
  ["Apple", /^(apple studios|apple original films)$/i],
  ["Neon", /^neon$/i],
];
// Pure: the studio group for a film's production companies, or null.
function studioOf(companies) {
  for (const c of Array.isArray(companies) ? companies : []) {
    const name = String(c || "").trim();
    for (const [group, re] of STUDIOS) if (re.test(name)) return group;
  }
  return null;
}

// Pure: one film's window in one region, or why it has none.
function windowIn(f, region) {
  const r = f && f.r && f.r[region];
  if (!r || !r.th) return { why: "noCinemaDate" };
  if (!r.dig) return { why: "noDigitalDate" };
  const d = daysBetween(r.th, r.dig);
  if (d < 0) return { why: "digitalFirst" };
  if (d > MAX_WINDOW) return { why: "tooLong" };
  return { days: d };
}

// ---------------------------------------------------------------------------
// The budgeted, resumable read (the India backfill's shape).
// ---------------------------------------------------------------------------
async function discoverRegion(api, region, from, to, pages = DISCOVER_PAGES) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const r = await api.tmdb("/discover/movie", {
      region, with_release_type: "2|3", "release_date.gte": from, "release_date.lte": to,
      sort_by: "popularity.desc", include_adult: "false", page: String(page),
    });
    await api.pause(120);
    out.push(...((r && r.results) || []));
    if (!r || !r.total_pages || page >= r.total_pages) break;
  }
  return out;
}

async function runStudioBackfill({ api, today, budget = 300, file = DIGITAL_FILE, store = readStore(file),
  save = (s) => fs.writeFileSync(file, JSON.stringify(s, null, 1)) } = {}) {
  const w = (store.world = store.world || {});
  w.windows = w.windows || {}; w.films = w.films || {};
  const res = { calls: 0, discovered: 0, read: 0, dated: 0, errors: 0, left: 0 };
  const spend = () => res.calls < budget;
  const counting = { tmdb: async (p, q) => { res.calls++; return api.tmdb(p, q); }, pause: api.pause };
  const wins = digitalWindows(today);
  const recent = new Set(wins.slice(-2).map((x) => x.from));
  outer:
  for (const win of wins.slice().reverse()) {            // newest quarters first: they back the estimates
    for (const m of MARKETS) {
      const key = `${m.region}:${win.from}`;
      const done = w.windows[key];
      if (done && (!recent.has(win.from) || daysBetween(done, today) < 7)) continue;
      if (!spend()) break outer;
      try {
        for (const x of await discoverRegion(counting, m.region, win.from, win.to)) {
          if (!x || !x.id) continue;
          const f = w.films[x.id];
          if (!f) { w.films[x.id] = { t: x.title || x.original_title, votes: x.vote_count || 0 }; res.discovered++; }
          else f.votes = x.vote_count || f.votes || 0;
        }
        w.windows[key] = today;
      } catch { res.errors++; if (res.errors >= 5) break outer; }
    }
  }
  // One call per film gives its companies and every country's dates. Never-read films first
  // (most-voted first), then films still waiting for a digital date somewhere.
  const waiting = (f) => MARKETS.some((m) => { const r = f.r && f.r[m.region]; return r && r.th && !r.dig && daysBetween(r.th, today) <= RECHECK_AGE; });
  const due = Object.entries(w.films).filter(([, f]) => !f.at || (waiting(f) && daysBetween(f.at, today) >= RECHECK_DAYS))
    .sort(([, a], [, b]) => (!!a.at - !!b.at) || (b.votes || 0) - (a.votes || 0));
  for (const [id, f] of due) {
    if (!spend() || res.errors >= 5) break;
    try {
      const d = await counting.tmdb(`/movie/${id}`, { append_to_response: "release_dates" });
      await api.pause(120);
      f.c = ((d && d.production_companies) || []).map((c) => String((c && c.name) || "").trim()).filter(Boolean).slice(0, 8);
      f.r = {};
      let dated = false;
      for (const m of MARKETS) {
        const th = regionalTheatricalDate(d, m.region);
        if (!th) continue;
        const dig = digitalReleaseFor(d, m.region);
        f.r[m.region] = dig ? { th, dig: dig.date } : { th };
        if (dig) dated = true;
      }
      if (dated) res.dated++;
      f.at = today;
      res.read++;
    } catch { res.errors++; }
  }
  res.left = Object.values(w.films).filter((f) => !f.at).length;
  save(store);
  return res;
}

// ---------------------------------------------------------------------------
// The published figures for one country.
// ---------------------------------------------------------------------------
function studioStats(store, region, { today = iso(Date.now()) } = {}) {
  const films = Object.values((store && store.world && store.world.films) || {}).filter((f) => f && f.r && f.r[region] && f.r[region].th <= today);
  const rows = films.map((f) => ({ f, w: windowIn(f, region), studio: studioOf(f.c) }));
  const ok = rows.filter((x) => x.w.days != null);
  const by = new Map();
  for (const x of ok) { if (!x.studio) continue; if (!by.has(x.studio)) by.set(x.studio, []); by.get(x.studio).push(x.w.days); }
  const byStudio = [...by.entries()].map(([key, ds]) => ({ key, n: ds.length, median: median(ds) }))
    .filter((r) => r.n >= STUDIO_MIN).sort((a, b) => a.median - b.median || b.n - a.n);
  const med = new Map(byStudio.map((r) => [r.key, r.median]));
  const ths = ok.map((x) => x.f.r[region].th).sort();
  // Films in cinemas with no digital date yet, whose studio has a row: cinema date + that median.
  const expected = rows.filter((x) => x.w.why === "noDigitalDate" && x.studio && med.has(x.studio) && daysBetween(x.f.r[region].th, today) <= EXPECT_CINEMA_DAYS)
    .map((x) => ({ title: x.f.t, th: x.f.r[region].th, studio: x.studio, median: med.get(x.studio), date: addDays(x.f.r[region].th, med.get(x.studio)), votes: x.f.votes || 0 }))
    .filter((x) => x.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || b.votes - a.votes).slice(0, EXPECT_ROWS);
  return {
    films: films.length, measured: ok.length, overall: median(ok.map((x) => x.w.days)),
    named: ok.filter((x) => x.studio).length, inRows: byStudio.reduce((n, r) => n + r.n, 0),
    byStudio, expected, from: ths[0] || null, to: ths[ths.length - 1] || null,
  };
}

// ---------------------------------------------------------------------------
// Best Picture nominees (Wikidata) and where each streams.
// ---------------------------------------------------------------------------
const NOMINEES_QUERY = `SELECT DISTINCT ?cerLabel ?date ?workLabel ?tmdb WHERE {
  ?x p:P1411 ?st . ?st ps:P1411 wd:Q102427 ; pq:P805 ?cer . ?cer wdt:P585 ?date .
  FILTER(YEAR(?date) >= YEAR(NOW()) - 1)
  { ?st pq:P1686 ?work } UNION { ?x wdt:P31/wdt:P279* wd:Q11424 . BIND(?x AS ?work) }
  ?work wdt:P4947 ?tmdb .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
// Pure: the ceremony to show from a SPARQL answer, or null. The latest ceremony that is still in
// season (not more than AWARDS_AFTER_DAYS past) and lists exactly ten films with TMDB ids.
function pickCeremony(json, today) {
  const by = new Map();
  for (const b of (json && json.results && json.results.bindings) || []) {
    const name = b.cerLabel && b.cerLabel.value, date = b.date && String(b.date.value).slice(0, 10), id = b.tmdb && Number(b.tmdb.value);
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !Number.isInteger(id) || id <= 0) continue;
    if (!by.has(name)) by.set(name, { name, date, films: new Map() });
    const label = b.workLabel && b.workLabel.value;
    by.get(name).films.set(id, /^Q\d+$/.test(label || "") ? "" : label || "");
  }
  const live = [...by.values()].filter((c) => c.films.size === 10 && c.date >= addDays(today, -AWARDS_AFTER_DAYS))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return live ? { name: live.name, date: live.date, films: [...live.films.entries()].map(([id, title]) => ({ id, title })) } : null;
}
// The season: nominations are announced in January and the ceremony is in March. Outside
// December to April nothing is asked and the stored table is dropped.
const inSeason = (today) => [12, 1, 2, 3, 4].includes(Number(today.slice(5, 7)));

async function runAwards({ api, today, fetchImpl = fetch, file = DIGITAL_FILE, store = readStore(file),
  save = (s) => fs.writeFileSync(file, JSON.stringify(s, null, 1)) } = {}) {
  const w = (store.world = store.world || {});
  const res = { asked: false, films: 0, calls: 0, why: "" };
  if (!inSeason(today)) { if (w.awards) { delete w.awards; save(store); } res.why = "out of season"; return res; }
  if (w.awards && w.awards.at === today) { res.why = "already read today"; res.films = (w.awards.films || []).length; return res; }
  let json;
  try {
    const r = await fetchImpl(`${WIKIDATA}?query=${encodeURIComponent(NOMINEES_QUERY)}`, { headers: { accept: "application/sparql-results+json", "user-agent": UA } });
    json = await r.json();
    res.asked = true;
  } catch (e) { res.why = `Wikidata not read (${e.message})`; return res; }   // keep yesterday's table
  const cer = pickCeremony(json, today);
  if (!cer) { delete w.awards; save(store); res.why = "no ceremony with ten listed films in season"; return res; }
  const films = [];
  for (const f of cer.films) {
    try {
      const d = await api.tmdb(`/movie/${f.id}`, { append_to_response: "watch/providers" });
      await api.pause(120);
      res.calls++;
      const where = {};
      for (const m of MARKETS) {
        const wp = (d && d["watch/providers"] && d["watch/providers"].results && d["watch/providers"].results[m.region]) || {};
        const names = require("./rules.js").dedupeProviders((wp.flatrate || []).map((p) => p.provider_name)).slice(0, 2);
        where[m.region] = names.length ? names : ((wp.rent || []).length || (wp.buy || []).length) ? "rent" : "";
      }
      films.push({ id: f.id, title: (d && d.title) || f.title || "", where });
    } catch { /* this film's row is left out; the count below then hides the table */ }
  }
  if (films.length !== 10) { res.why = `only ${films.length} of 10 films read`; return res; }
  w.awards = { name: cer.name, date: cer.date, at: today, films: films.sort((a, b) => a.title.localeCompare(b.title)) };
  save(store);
  res.films = films.length;
  return res;
}

// ---------------------------------------------------------------------------
// The sections for /data/. Returns "" while nothing has enough behind it.
// ---------------------------------------------------------------------------
function worldSectionsHtml(store, { today = iso(Date.now()) } = {}) {
  const e = escHtml;
  const parts = [];
  const shown = [];
  for (const m of MARKETS) {
    const s = studioStats(store, m.region, { today });
    if (s.measured < MARKET_MIN || s.byStudio.length < 3) continue;
    shown.push(m.name);
    const rows = s.byStudio.map((r) => `<tr><td>${e(r.key)}</td><td class="n">${r.median}</td><td class="n">${r.n}</td></tr>`).join("");
    const rest = s.measured - s.inRows;
    const exp = s.expected.length ? `<h3>${e(m.name)}: expected digital release for films now in cinemas</h3>
  <table><thead><tr><th>Film</th><th>Studio</th><th>Opened</th><th>Expected around</th></tr></thead><tbody>${s.expected.map((x) =>
    `<tr><td>${e(x.title)}</td><td>${e(x.studio)}</td><td>${e(dayHuman(x.th))}</td><td>${e(dayHuman(x.date))}</td></tr>`).join("")}</tbody></table>
  <p class="plus">An estimate: the cinema date plus that studio's median above. No studio has announced these dates.</p>` : "";
    parts.push(`<h3 id="studios-${m.code}">${e(m.name)}</h3>
  <div class="sub">Median ${s.overall} days across ${s.measured} films that opened in cinemas there, ${e(monthHuman(s.from))} to ${e(monthHuman(s.to))}. Coverage: TMDB has a digital date for ${s.measured} of the ${s.films} films read.</div>
  <table><thead><tr><th>Studio</th><th class="n">Median days</th><th class="n">Films</th></tr></thead><tbody>${rows}</tbody></table>
  ${rest > 0 ? `<p class="plus">plus ${rest} film${rest === 1 ? "" : "s"} from other studios, or from studios with fewer than ${STUDIO_MIN} films, counted in the total but not given a row.</p>` : ""}
  ${exp}`);
  }
  if (parts.length) {
    parts.unshift(`<h2 id="studios">Outside India: cinema to digital release, by studio</h2>
  <p>From TMDB's release dates for ${e(shown.join(", ").replace(/, ([^,]*)$/, shown.length > 1 ? " and $1" : ", $1"))}: the days from a film's cinema release in that country to its digital release there. Outside India a digital release is usually the first day a film can be bought or rented at home, which comes before it reaches a subscription service. The studio is the producing studio TMDB lists first among the major groups; a film's distributor can differ. The dates are entered by TMDB's contributors, so each country shows how many films have one.</p>`);
  }
  const a = store && store.world && store.world.awards;
  if (a && Array.isArray(a.films) && a.films.length === 10 && a.date >= addDays(today, -AWARDS_AFTER_DAYS)) {
    const cell = (v) => (Array.isArray(v) && v.length ? e(v.join(", ")) : v === "rent" ? "Rent or buy" : "Not streaming");
    parts.push(`<h2 id="nominees">Where to stream the Best Picture nominees</h2>
  <div class="sub">${e(a.name)}, ${e(dayHuman(a.date))}. Nominees as listed on Wikidata; availability from JustWatch through TMDB, checked ${e(dayHuman(a.at))}.</div>
  <table><thead><tr><th>Film</th>${MARKETS.map((m) => `<th>${e(m.name)}</th>`).join("")}</tr></thead><tbody>${a.films.map((f) =>
    `<tr><td>${e(f.title)}</td>${MARKETS.map((m) => `<td>${cell(f.where && f.where[m.region])}</td>`).join("")}</tr>`).join("")}</tbody></table>
  <p class="plus">Subscription services are named; "Rent or buy" means it can be paid for at home but is on no subscription service there.</p>`);
  }
  return parts.join("\n\n  ");
}

module.exports = {
  MARKETS, STUDIO_MIN, MARKET_MIN, AWARDS_AFTER_DAYS, NOMINEES_QUERY,
  studioOf, windowIn, studioStats, pickCeremony, inSeason, runStudioBackfill, runAwards, worldSectionsHtml,
};
