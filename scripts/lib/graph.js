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
    });
  }
  return out;
}

// Score a candidate as a neighbour of `item`. Same language is the strongest signal on a
// site this Indian-language-heavy; a shared genre next; closeness in time last, because a
// 2026 release recommending a 2019 one reads like filler.
function relatedScore(item, cand) {
  if (!cand.slug || cand.slug === item.slug) return -1;
  let score = 0;
  const lang = (x) => String(x.language || "").toLowerCase();
  // Language outweighs a full genre match on purpose: a reader on a Tamil film page wants
  // another Tamil film more than an English film of the same genre. Two shared genres (36)
  // must not beat a shared language (55), or the mesh drifts towards Hollywood titles.
  if (lang(item) && lang(item) === lang(cand)) score += 55;
  const genres = (x) => String(x.genre || "").split("/").map((g) => g.trim().toLowerCase()).filter(Boolean);
  const shared = genres(item).filter((g) => genres(cand).includes(g)).length;
  score += Math.min(shared, 2) * 18;
  if (item.kind === cand.kind) score += 8;
  const y = (x) => Number(String(x.released || "").slice(0, 4)) || 0;
  if (y(item) && y(cand)) score += Math.max(0, 12 - Math.abs(y(item) - y(cand)) * 3);
  return score;
}

// Pick N neighbours that ALL have real pages. Deliberately not "the N best": the top of the
// ranking is the same handful of popular titles for every film, which would funnel every new
// link into a dozen pages and leave the rest orphaned exactly as they are now. Candidates are
// taken from a wider band and rotated per source film, so links spread across the archive.
function relatedFilms(item, index, n = 6) {
  const ranked = (index || [])
    .map((c) => ({ c, s: relatedScore(item, c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.c.slug < b.c.slug ? -1 : 1));
  if (ranked.length <= n) return ranked.map((x) => x.c);
  const band = ranked.slice(0, Math.max(n * 4, Math.min(40, ranked.length)));
  const offset = Math.abs(hashKey(item.slug || item.title || "")) % band.length;
  const picked = [];
  for (let i = 0; i < band.length && picked.length < n; i++) picked.push(band[(offset + i) % band.length].c);
  return picked;
}

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

function buildBrowsePage(index, cfg, page, totalPages, updatedHuman) {
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
  const title = page > 1
    ? `Every film on FilmyChill ${m.name} — page ${page} of ${totalPages}`
    : `Every movie and series we've covered in ${m.name} | FilmyChill`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(`Browse all ${index.length} movies and series FilmyChill has covered in ${m.name} — ratings, verdicts and where to watch each one.`)}">
<link rel="canonical" href="${e(url)}">
${page > 1 ? `<link rel="prev" href="${e(browsePath(code, page - 1))}">` : ""}
${page < totalPages ? `<link rel="next" href="${e(browsePath(code, page + 1))}">` : ""}
<meta property="og:title" content="${e(title)}">
<meta property="og:url" content="${e(url)}">
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
  <ul>
      ${rows}
  </ul>
  ${nav}
  <div class="pages">Pages: ${pageLinks}</div>
  <footer><a href="${e(m.path)}">← This week's picks</a> · <a href="/about/">About FilmyChill</a></footer>
</body></html>`;
}

// Writes the whole paginated set and returns the URLs, for the sitemap.
function writeBrowseIndex(index, cfg, updatedHuman) {
  const code = (cfg && cfg.code) || "in";
  const sorted = [...index].sort((a, b) => String(b.released || "").localeCompare(String(a.released || ""))
    || String(a.title).localeCompare(String(b.title)));
  const totalPages = Math.max(1, Math.ceil(sorted.length / BROWSE_PER_PAGE));
  const urls = [];
  for (let page = 1; page <= totalPages; page++) {
    const dir = code === "in" ? (page === 1 ? "films" : `films/${page}`) : (page === 1 ? `${code}/films` : `${code}/films/${page}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/index.html`, buildBrowsePage(sorted, cfg, page, totalPages, updatedHuman));
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
  const existing = /(?:<link rel="alternate" hreflang="[^"]*" href="[^"]*"\/>\n?)+/;
  const has = existing.test(html);
  if (!block) return has ? { html: html.replace(existing, ""), changed: true } : { html, changed: false };
  if (has) {
    const current = (html.match(existing) || [""])[0].trim();
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
