"use strict";

const fs = require("fs");
const { COUNTRIES, COUNTRY_PAGE_META, escHtml, filmPagePath, filmPageUrl, xDefaultCode } = require("./core.js");

// ============================================================================
// FILM INDEX — the fix for orphaned pages.
//
// The site generates ~1,180 film pages but only links to the ~220 in this week's lists, so
// Google reports the rest as "Discovered — currently not indexed": it has the URLs from the
// sitemap and declines to spend a crawl on pages nothing recommends. A sitemap entry is a
// suggestion; an internal link is a recommendation.
//
// This reads every page ALREADY on disk and recovers its metadata from the Movie JSON-LD it
// already carries (name, genre, inLanguage, datePublished, image). No API calls, no new data
// source, and it covers pages built months ago that will never be regenerated.
// ============================================================================
function filmIndexFor(cfg) {
  const code = (cfg && cfg.code) || "in";
  const dir = code === "in" ? "movie" : `${code}/movie`;
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".html")) continue;
    let html;
    try { html = fs.readFileSync(`${dir}/${f}`, "utf8"); } catch { continue; }
    const m = html.match(/<script type="application\/ld\+json">(\{"@context[^<]*?"@type":"(?:Movie|TVSeries)"[\s\S]*?)<\/script>/);
    if (!m) continue;
    let ld;
    try { ld = JSON.parse(m[1]); } catch { continue; }
    if (!ld.name) continue;
    out.push({
      slug: f.slice(0, -5),
      title: ld.name,
      genre: ld.genre || "",
      language: ld.inLanguage || "",
      released: (ld.datePublished || "").slice(0, 10),
      poster: ld.image || "",
      kind: ld["@type"] === "TVSeries" ? "tv" : "movie",
      // People, for "same actor / same director" neighbours (already in the page's JSON-LD).
      cast: personNames(ld.actor).slice(0, 8),
      director: personNames(ld.director || ld.creator).slice(0, 3),
    });
  }
  return out;
}

function personNames(v) {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return arr.map((p) => (typeof p === "string" ? p : p && p.name) || "").map((n) => String(n).trim()).filter(Boolean);
}

// LANGUAGE AFFINITY (Sept 2026). "Same language or nothing" sent a Spanish crime film's page to
// Tamil action films: with no other Spanish titles, every other language counted as equally
// foreign. Audiences cross languages along real lines — Indian languages into each other
// (south Indian films especially, via dubbing), European languages into each other,
// East Asian ones likewise, and English as the international bridge for all non-Indian
// cinema. The score follows those lines.
const LANG_GROUPS = {
  indic: ["hindi", "tamil", "telugu", "malayalam", "kannada", "bengali", "marathi", "punjabi", "gujarati", "odia", "assamese", "urdu", "bhojpuri", "tulu", "konkani"],
  european: ["spanish", "portuguese", "french", "italian", "catalan", "german", "dutch", "swedish", "danish", "norwegian", "finnish", "polish", "russian", "ukrainian", "greek", "romanian", "czech", "hungarian", "turkish"],
  eastasian: ["japanese", "korean", "chinese", "mandarin", "cantonese", "thai", "vietnamese", "indonesian", "malay", "tagalog", "filipino"],
};
const SOUTH_INDIAN = ["tamil", "telugu", "malayalam", "kannada"];
const groupOf = (l) => Object.keys(LANG_GROUPS).find((g) => LANG_GROUPS[g].includes(l)) || null;
function languageAffinity(a, b) {
  const x = String(a || "").toLowerCase().trim(), y = String(b || "").toLowerCase().trim();
  if (!x || !y) return 0;
  if (x === y) return 55;
  const gx = groupOf(x), gy = groupOf(y);
  if (gx && gx === gy) return gx === "indic" && SOUTH_INDIAN.includes(x) && SOUTH_INDIAN.includes(y) ? 35 : 30;
  // English bridges to world cinema; less so to Indian-language cinema.
  if ((x === "english" && gy !== "indic") || (y === "english" && gx !== "indic")) return 20;
  if (x === "english" || y === "english") return 10;
  return 0;
}
// "Close" = a neighbour a reader of THIS film would plausibly want: a related language, or a
// shared actor/director. Anything else is only used when there aren't three close ones.
const CLOSE_AFFINITY = 20;

const lowerSet = (xs) => new Set((xs || []).map((n) => String(n).toLowerCase()));
function peopleOverlap(item, cand) {
  const castA = lowerSet(item.cast), castB = lowerSet(cand.cast);
  const dirA = lowerSet(personNames(item.director)), dirB = lowerSet(personNames(cand.director));
  let actors = 0, directors = 0;
  for (const n of castA) if (castB.has(n)) actors++;
  for (const n of dirA) if (dirB.has(n)) directors++;
  return { actors, directors };
}

// Genres that define what a title IS: a documentary or an animation should be matched with
// its own kind, and never offered to a reader of the other kind.
const DEFINING = ["documentary", "animation"];

// Score a candidate as a neighbour of `item`: genre gates, then language affinity, people,
// genre closeness, format and era order what's left.
function relatedScore(item, cand) {
  if (!cand.slug || cand.slug === item.slug) return -1;
  const genres = (x) => String(x.genre || "").split("/").map((g) => g.trim().toLowerCase()).filter(Boolean);
  const mine = genres(item), theirs = genres(cand);
  const shared = mine.filter((g) => theirs.includes(g)).length;
  // HARD GATE. Language and recency alone used to qualify a candidate, which is how a
  // horror page ended up recommending Moana: "English" and "is a movie" were the whole
  // case for it. If the source film has genres, a candidate must share at least one —
  // including candidates whose own genre data is missing, which would otherwise score on
  // language alone and outrank a real genre match (measured: one such film took the top
  // slot on the Backrooms page at 75 points against 38 for an actual horror neighbour).
  if (mine.length && shared === 0) return -1;
  for (const d of DEFINING) if (mine.includes(d) !== theirs.includes(d)) return -1;
  let score = languageAffinity(item.language, cand.language);
  const { actors, directors } = peopleOverlap(item, cand);
  score += Math.min(actors, 2) * 22 + Math.min(directors, 1) * 18;
  // Genre closeness: how much of the two genre sets overlap, plus the lead genre matching.
  const union = new Set([...mine, ...theirs]).size || 1;
  score += Math.round((shared / union) * 36);
  if (mine[0] && mine[0] === theirs[0]) score += 22; // same lead genre: a horror page shows horror first
  if (item.kind === cand.kind) score += 10;
  const y = (x) => Number(String(x.released || "").slice(0, 4)) || 0;
  if (y(item) && y(cand)) score += Math.max(0, 12 - Math.abs(y(item) - y(cand)) * 2);
  return score;
}
function isClose(item, cand) {
  if (languageAffinity(item.language, cand.language) >= CLOSE_AFFINITY) return true;
  const { actors, directors } = peopleOverlap(item, cand);
  return actors + directors > 0;
}

// Pick N neighbours that ALL have real pages. Deliberately not "the N best": the top of the
// ranking is the same handful of popular titles for every film, which would funnel every new
// link into a dozen pages and leave the rest orphaned exactly as they are now. Candidates are
// taken from a wider band and rotated per source film, so links spread across the archive.
function relatedFilms(item, index, n = 6) {
  const all = (index || [])
    .map((c) => ({ c, s: relatedScore(item, c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.c.slug < b.c.slug ? -1 : 1));
  // Close neighbours only (related language or shared people). Distant ones are used only
  // when fewer than three close ones exist — and then they're still ranked by the score.
  // Three right answers beat six with three wrong ones.
  const close = all.filter((x) => isClose(item, x.c));
  const ranked = close.length >= 3 ? close : all;
  if (ranked.length <= n) return ranked.map((x) => x.c);
  // The band used to be `max(n*4, min(40, len))`, i.e. up to 40 candidates. On a catalogue
  // of ~40 films that IS the whole list, so the rotation below drew from everything and the
  // ranking above became decorative — a horror page could and did surface six titles
  // scoring at the floor. The band is now defined by SCORE, not by count: only candidates
  // within QUALITY_WINDOW of the best one are eligible to be rotated between. Spread is
  // preserved wherever there are genuinely comparable neighbours, and where there aren't,
  // the best ones win outright — which is the correct answer for a small catalogue.
  const best = ranked[0].s;
  let band = ranked.filter((x) => x.s >= best - QUALITY_WINDOW);
  if (band.length < n) band = ranked.slice(0, Math.max(n, band.length));
  band = band.slice(0, Math.max(n * 2, Math.min(24, band.length)));
  const offset = Math.abs(hashKey(item.slug || item.title || "")) % band.length;
  const picked = [];
  for (let i = 0; i < band.length && picked.length < n; i++) picked.push(band[(offset + i) % band.length].c);
  return picked;
}

// One shared genre (18) plus a year of drift is inside the window; a language switch (55)
// or a genre-count drop of two is not. Tuned so the band holds real alternatives only.
const QUALITY_WINDOW = 22;

function hashKey(key) {
  let h = 0;
  for (let i = 0; i < String(key).length; i++) h = (Math.imul(h, 31) + String(key).charCodeAt(i)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0; h ^= h >>> 13;
  return h >>> 0;
}

// ============================================================================
// BROWSE INDEX — makes indexation keep pace with generation.
//
// The related-films mesh fixes pages built from now on, but a page archived months ago is
// frozen and never regenerated, so it can only gain links from NEW pages pointing back at
// it. This closes the gap permanently: every film page, however old, is listed here, and
// this index is linked from the footer of every page on the site. Result: nothing the build
// generates is ever more than two clicks from the homepage, forever.
//
// Deliberately plain — titles, year, language, one link each. It is navigation, not content,
// and padding it with descriptions would make 12 thin pages out of a useful one.
// ============================================================================
const BROWSE_PER_PAGE = 120;

function browsePath(code, page) {
  const base = code === "in" ? "/films/" : `/${code}/films/`;
  return page <= 1 ? base : `${base}${page}/`;
}

function buildBrowsePage(index, cfg, page, totalPages, updatedHuman, headExtra = "", newlyAdded = []) {
  const e = escHtml;
  const code = (cfg && cfg.code) || "in";
  const m = COUNTRY_PAGE_META[code] || { name: (cfg && cfg.name) || "India", path: `/${code}/` };
  const start = (page - 1) * BROWSE_PER_PAGE;
  const slice = index.slice(start, start + BROWSE_PER_PAGE);
  const rows = slice.map((f) => {
    const meta = [f.language, f.released ? String(f.released).slice(0, 4) : null,
      f.kind === "tv" ? "Series" : null].filter(Boolean).join(" · ");
    return `<li><a href="${e(filmPagePath(code, f.slug))}">${e(f.title)}</a>${meta ? ` <span class="bm">${e(meta)}</span>` : ""}</li>`;
  }).join("\n      ");
  const nav = [
    page > 1 ? `<a class="btn" href="${e(browsePath(code, page - 1))}">← Previous</a>` : "",
    page < totalPages ? `<a class="btn" href="${e(browsePath(code, page + 1))}">Next →</a>` : "",
  ].filter(Boolean).join(" ");
  // Every page of the set links to every other page: with 10+ pages a prev/next chain alone
  // buries the tail dozens of hops deep, which is how paginated archives go uncrawled.
  const pageLinks = Array.from({ length: totalPages }, (_, i) => i + 1)
    .map((n) => n === page ? `<b>${n}</b>` : `<a href="${e(browsePath(code, n))}">${n}</a>`).join(" · ");
  const url = `https://filmychill.com${browsePath(code, page)}`;
  // Page 1 drops the brand suffix when it would push the title past ~60 characters (Google
  // cuts there; "…covered in Singapore | FilmyChill" was 62). Later pages name their position,
  // and so does every description — the three pages used to share one description exactly.
  const title1 = `Every movie and series we've covered in ${m.name} | FilmyChill`;
  const title = page > 1
    ? `Every film on FilmyChill ${m.name} — page ${page} of ${totalPages}`
    : (title1.length > 60 ? title1.replace(/ \| FilmyChill$/, "") : title1);
  const desc = page > 1
    ? `Page ${page} of ${totalPages}: films and series ${start + 1}–${start + slice.length} of the ${index.length} FilmyChill has covered in ${m.name}, with ratings, verdicts and where to watch.`
    : `Browse all ${index.length} movies and series FilmyChill has covered in ${m.name} — ratings, verdicts and where to watch each one.`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
<link rel="canonical" href="${e(url)}">
${page > 1 ? `<link rel="prev" href="${e(browsePath(code, page - 1))}">` : ""}
${page < totalPages ? `<link rel="next" href="${e(browsePath(code, page + 1))}">` : ""}
<meta property="og:title" content="${e(title)}">
<meta property="og:url" content="${e(url)}">
${headExtra || ""}
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 0 auto;
         padding: 24px 18px 60px; background: #FFF7EC; color: #1A1633; line-height: 1.6; }
  h1 { font-size: 26px; margin: 0 0 4px; } .sub { color: #6B6890; font-size: 14px; margin-bottom: 22px; }
  ul { list-style: none; padding: 0; columns: 2; column-gap: 34px; }
  @media (max-width: 620px) { ul { columns: 1; } }
  li { break-inside: avoid; padding: 5px 0; font-size: 15px; }
  a { color: #4038C7; text-decoration: none; } a:hover { text-decoration: underline; }
  .bm { color: #6B6890; font-size: 12.5px; }
  .btn { display: inline-block; background: #4038C7; color: #fff; padding: 9px 16px;
         border-radius: 8px; font-size: 14px; margin: 18px 6px 0 0; }
  .pages { margin-top: 20px; font-size: 14px; color: #6B6890; } .pages a { margin: 0 2px; }
  footer { margin-top: 34px; padding-top: 18px; border-top: 1px solid #E7DFD0; font-size: 13px; color: #6B6890; }
</style></head><body>
  <h1>Every film we've covered in ${e(m.name)}</h1>
  <div class="sub">${index.length} titles · page ${page} of ${totalPages} · updated ${e(updatedHuman)}</div>
  ${page === 1 && newlyAdded && newlyAdded.length ? `<h2 style="font-size:16px;margin:18px 0 6px">Newly added</h2><p style="margin:0 0 14px;line-height:1.9">${newlyAdded.map((x) => `<a href="${e(x.href)}">${e(x.title)}</a>`).join(" · ")}</p>` : ""}
  <ul>
      ${rows}
  </ul>
  ${nav}
  <div class="pages">Pages: ${pageLinks}</div>
  <footer><a href="${e(m.path)}">← This week's picks</a> · <a href="/about/">About FilmyChill</a></footer>
</body></html>`;
}

// Writes the whole paginated set and returns the URLs, for the sitemap.
function writeBrowseIndex(index, cfg, updatedHuman, headExtra = "", newlyAdded = []) {
  const code = (cfg && cfg.code) || "in";
  const sorted = [...index].sort((a, b) => String(b.released || "").localeCompare(String(a.released || ""))
    || String(a.title).localeCompare(String(b.title)));
  const totalPages = Math.max(1, Math.ceil(sorted.length / BROWSE_PER_PAGE));
  const urls = [];
  for (let page = 1; page <= totalPages; page++) {
    const dir = code === "in" ? (page === 1 ? "films" : `films/${page}`) : (page === 1 ? `${code}/films` : `${code}/films/${page}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/index.html`, buildBrowsePage(sorted, cfg, page, totalPages, updatedHuman, headExtra, newlyAdded));
    urls.push(`https://filmychill.com${browsePath(code, page)}`);
  }
  console.log(`  browse index [${code}]: ${sorted.length} films across ${totalPages} page(s)`);
  return urls;
}

function filmPageDir(code) { return code === "in" ? "movie" : `${code}/movie`; }
function filmPageExists(code, slug) {
  return !!slug && fs.existsSync(`${filmPageDir(code)}/${slug}.html`);
}

// ============================================================================
// HREFLANG SYNC — repairs clusters across the whole archive.
//
// The same film gets a page per country and those pages are ~63% identical (often more).
// hreflang is what tells Google they are regional variants of one thing rather than
// duplicates competing for a single index slot. Google's rule is strict: EVERY page in a
// set must point to itself and to every other member, or the entire set is discarded.
//
// 74% of multi-country clusters were broken, because membership used to be computed from
// the current week's lists and archived pages are never rebuilt. This walks every film page
// on disk, works out the true cluster from the filesystem, and rewrites the alternates.
// Pure string surgery on the <head>; nothing else on the page is touched.
// ============================================================================
function hreflangBlockFor(codes, slug) {
  if (!codes || codes.length < 2) return "";
  const ordered = COUNTRIES.map((c) => c.code).filter((c) => codes.includes(c));
  const lines = ordered.map((c) => {
    const region = (COUNTRIES.find((x) => x.code === c) || {}).region || c.toUpperCase();
    return `<link rel="alternate" hreflang="${c === "in" ? "en-IN" : "en-" + region}" href="${filmPageUrl(c, slug)}"/>`;
  });
  lines.push(`<link rel="alternate" hreflang="x-default" href="${filmPageUrl(xDefaultCode(ordered), slug)}"/>`);
  return lines.join("\n");
}

function patchHreflang(html, codes, slug) {
  const block = hreflangBlockFor(codes, slug);
  // \r?\n, not \n: on a CRLF working copy the repetition stopped after the FIRST link, so
  // the partial match never equalled `block` and a fresh block was appended instead of
  // replacing the old one. One build from a Windows clone gave 8,558 pages duplicate
  // alternates; CI never saw it because CI is Linux. .gitattributes now pins LF as well,
  // but this matcher no longer depends on the checkout being right.
  const existing = /(?:<link rel="alternate" hreflang="[^"]*" href="[^"]*"\/>\r?\n?)+/;
  const has = existing.test(html);
  if (!block) return has ? { html: html.replace(existing, ""), changed: true } : { html, changed: false };
  if (has) {
    const current = (html.match(existing) || [""])[0].trim().replace(/\r/g, "");
    if (current === block) return { html, changed: false };
    return { html: html.replace(existing, block + "\n"), changed: true };
  }
  const canon = html.match(/<link rel="canonical" href="[^"]*">/);
  if (!canon) return { html, changed: false };
  return { html: html.replace(canon[0], `${canon[0]}\n${block}`), changed: true };
}

function syncHreflangClusters(onChange = null) {
  const bySlug = new Map();
  for (const c of COUNTRIES) {
    const dir = filmPageDir(c.code);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".html")) continue;
      const slug = f.slice(0, -5);
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push(c.code);
    }
  }
  let fixed = 0, clusters = 0;
  for (const [slug, codes] of bySlug) {
    if (codes.length > 1) clusters++;
    for (const code of codes) {
      const path = `${filmPageDir(code)}/${slug}.html`;
      let html;
      try { html = fs.readFileSync(path, "utf8"); } catch { continue; }
      const { html: out, changed } = patchHreflang(html, codes, slug);
      if (changed) { fs.writeFileSync(path, out); fixed++; if (onChange) onChange(code, slug); }
    }
  }
  console.log(`  hreflang sync: ${clusters} multi-country cluster(s), ${fixed} page(s) corrected`);
  return fixed;
}


// OTT freshness window: how recent a title's EFFECTIVE freshness date (release/season date
// OR first sighting on a platform — see first-seen tracking below) must be to count as a
// current OTT release. Tightened from 75 to 45 days: with first-seen tracking, a late OTT
// arrival stays fresh via its arrival date, so the wide release-date window is no longer
// needed to protect those — 45d keeps the list genuinely current. Revert knob: set 75.

module.exports = {
  languageAffinity,
  isClose,
  BROWSE_PER_PAGE,
  browsePath,
  buildBrowsePage,
  filmIndexFor,
  filmPageDir,
  filmPageExists,
  hashKey,
  hreflangBlockFor,
  patchHreflang,
  relatedFilms,
  relatedScore,
  syncHreflangClusters,
  writeBrowseIndex,
};
