// ============================================================================
// sitemap.js — dead hub links on frozen pages, and the multi-country sitemap writer.
// ============================================================================
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { LANGUAGE_PAGES, xDefaultCode } = require("./core.js");
const { monthKey } = require("./history.js");
const { browsePath } = require("./graph.js");
const {
  comingPath,
  comingUrl,
  isoWeekSunday,
  todayPath,
  todayUrl,
} = require("./dated.js");
const { peopleIndexUrl, personPageUrl, streamPageUrl } = require("./evergreen.js");
const { existingHubSlugs, LIVE_HUBS, ottMonthUrl } = require("./hubs.js");
const { isoWeekOf, PEOPLE_BASE, STREAM_BASE, weekSlug } = require("./pagekit.js");
const { ABOUT_LASTMOD } = require("./surfaces.js");
const { ottWeekUrl } = require("./weekly.js");

// Complete sitemap: every country homepage (with hreflang alternates) + every country's
// per-film pages. A film that exists in several countries gets hreflang alternates linking
// those copies together; a film unique to one country stands alone.
// ============================================================================
// DEAD HUB LINKS ON FROZEN PAGES.
//
// A film page links to the hubs it belongs to ("Everything new on Apple TV", "Everything that
// arrived in September") — but only if the hub existed when the page was written. Platform
// hubs come and go as platforms clear or miss the weekly threshold, and frozen pages are never
// regenerated, so a pruned hub left a dead link behind: 17 in Sept 2026, across 8 countries,
// with more on every prune. This pass drops links whose target is gone. It never adds one;
// the next page built for that film links whatever exists then.
// ============================================================================
const HUB_LINE_RE = /<p style="color:var\(--mute\);font-size:12\.5px;margin-top:10px">More: ([\s\S]*?)<\/p>/;

// Pure. `exists(href)` answers whether an internal URL resolves.
function pruneDeadHubLinks(html, exists) {
  const m = HUB_LINE_RE.exec(html);
  if (!m) return { html, changed: false };
  const links = m[1].split(" · ");
  const keep = links.filter((a) => {
    const href = (/href="([^"]+)"/.exec(a) || [])[1];
    return !href || exists(href);
  });
  if (keep.length === links.length) return { html, changed: false };
  const next = keep.length ? m[0].replace(m[1], keep.join(" · ")) : "";
  return { html: html.replace(m[0], next), changed: true };
}

function hrefExistsOnDisk(href) {
  const p = String(href).replace(/^\//, "");
  return fs.existsSync(p === "" || p.endsWith("/") ? `${p}index.html` : p);
}

function sweepDeadHubLinks(countries) {
  let fixed = 0;
  for (const c of countries) {
    const dir = c.code === "in" ? "movie" : `${c.code}/movie`;
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".html")) continue;
      const p = `${dir}/${f}`;
      let html;
      try { html = fs.readFileSync(p, "utf8"); } catch { continue; }
      if (!html.includes("More: ")) continue;
      const r = pruneDeadHubLinks(html, hrefExistsOnDisk);
      if (r.changed) { fs.writeFileSync(p, r.html); fixed++; }
    }
  }
  if (fixed) console.log(`  dead hub links: removed from ${fixed} film page(s)`);
  return fixed;
}

// ============================================================================
// HONEST LASTMOD FOR FILM PAGES (Oct 2026).
//
// 11,096 of 11,143 film URLs carried a lastmod from the past five days: live pages were
// stamped today on every rewrite (twice a day), and sweeps stamped pages for markup-only
// edits — a vote widget, an hreflang cluster. Google learns to ignore a sitemap whose dates
// always say "today", and then the pages that really changed (a film that just got its OTT
// date) wait for an ordinary recrawl. Now a film's `last` moves only when its CONTENT moves:
// the title, the meta description or the visible text. Head tags, scripts, the footer, the
// vote widget, "Page updated" / "as of" stamps and every digit (dates, vote counts, trailer
// views) are left out, so re-rendering the same facts never looks like news.
// ============================================================================
const VOTE_WIDGET_RE = /<div class="fcvote"[\s\S]*?<div class="fcvote-done"[^>]*><\/div>\s*<\/div>/g;

// Pure: a short hash of what a reader (and a search engine) would call the page's content.
function contentFingerprint(html) {
  const s = String(html || "");
  const title = (/<title>([\s\S]*?)<\/title>/.exec(s) || [])[1] || "";
  const desc = (/<meta name="description" content="([^"]*)"/.exec(s) || [])[1] || "";
  const at = s.indexOf("<body");
  const body = (at >= 0 ? s.slice(at) : s)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, " ")
    .replace(/<footer[\s\S]*?<\/footer>/g, " ")
    .replace(VOTE_WIDGET_RE, " ")
    .replace(/Page updated [^<]*/g, " ")
    .replace(/\bas of \d{1,2} [A-Za-z]+\.? \d{4}/g, " ")
    .replace(/<[^>]+>/g, " ");
  const text = `${title}\n${desc}\n${body}`.replace(/\d/g, "").replace(/\s+/g, " ").trim();
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
}

// The end-of-build pass: every film page's fingerprint against the one in its manifest
// entry. A changed fingerprint moves `last` to today; a page seen for the first time is
// recorded without moving its date (the first run of this pass must not stamp 11,000 pages
// today, the exact problem it fixes). Only existing entries are touched — every film page
// has one, and entries drive other sweeps, so this never invents them. Mutates the manifest.
function syncFilmLastmods(pagesManifest, countries, today, { root = "." } = {}) {
  const res = { pages: 0, changed: 0, seeded: 0 };
  for (const c of countries || []) {
    const dir = path.join(root, c.code === "in" ? "movie" : `${c.code}/movie`);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    const m = (pagesManifest && pagesManifest[c.code]) || {};
    for (const f of files) {
      if (!f.endsWith(".html")) continue;
      const e = m[f.slice(0, -5)];
      if (!e) continue;
      let html;
      try { html = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
      res.pages++;
      const fp = contentFingerprint(html);
      if (!e.fp) { e.fp = fp; res.seeded++; continue; }
      if (e.fp !== fp) { e.fp = fp; e.last = today; res.changed++; }
    }
  }
  return res;
}

function writeMultiCountrySitemap(countries, pagesManifest = null) {
  const today = new Date().toISOString().slice(0, 10);
  // Every lastmod must be a valid W3C date or Google rejects the sitemap with "Invalid date".
  // A single frozen page whose stored date was null/malformed once emitted an empty <lastmod>
  // and flagged the whole file. This coerces anything that isn't a clean YYYY-MM-DD back to
  // today, so one bad manifest value can never break the sitemap again.
  const lastmodOf = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10)) ? v.slice(0, 10) : today);
  // Honest per-film lastmod: a page's date is when it was last actually written (current
  // films: today; archived films: their freeze date) — claiming lastmod=today for frozen
  // pages teaches crawlers to distrust the whole sitemap's lastmod signal.
  const filmLastmod = (code, slug) => {
    const e = pagesManifest && pagesManifest[code] && pagesManifest[code][slug];
    // Prefer the most recent touch: a page re-edited after archiving (hreflang fix, due-date
    // rewrite, streaming arrival) should carry the EDIT date, not its original archive date.
    return lastmodOf(e ? (e.last || e.archivedOn || today) : today);
  };
  const pathFor = (code) => (code === "in" ? "https://filmychill.com/" : `https://filmychill.com/${code}/`);
  const homeAlts = countries.map((c) =>
    `    <xhtml:link rel="alternate" hreflang="${c.code === "in" ? "en-IN" : "en-" + c.region}" href="${pathFor(c.code)}"/>`).join("\n")
    + `\n    <xhtml:link rel="alternate" hreflang="x-default" href="https://filmychill.com/"/>`;
  const countryUrls = countries.map((c) =>
    `  <url><loc>${pathFor(c.code)}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority>\n${homeAlts}\n  </url>`);

  // "New on OTT this week" pages — the organic-discovery pages. Daily changefreq + fresh
  // lastmod signal Google to recrawl them for the freshness-sensitive weekly queries.
  const ottAlts = countries.map((c) =>
    `    <xhtml:link rel="alternate" hreflang="${c.code === "in" ? "en-IN" : "en-" + c.region}" href="${ottWeekUrl(c.code)}"/>`).join("\n")
    + `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${ottWeekUrl("in")}"/>`;
  const ottUrls = countries.map((c) =>
    `  <url><loc>${ottWeekUrl(c.code)}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.9</priority>\n${ottAlts}\n  </url>`);

  // Per-film pages for every country. Build a map slug -> [codes that have it] so we can emit
  // hreflang alternates for films shared across markets.
  const dirFor = (code) => (code === "in" ? "movie" : `${code}/movie`);
  const filmUrlFor = (code, slug) => (code === "in"
    ? `https://filmychill.com/movie/${slug}.html`
    : `https://filmychill.com/${code}/movie/${slug}.html`);
  // A page carrying noindex must not appear in the sitemap: submitting a URL you have asked
  // Google not to index is a contradictory signal, and Search Console reports it outright as
  // "Submitted URL marked noindex". Cheap — only the head is read, and these same files are
  // already walked by repairXDefaults and filmIndexFor on every run.
  const noIndexed = new Set(); // "code/slug" — excluded from the sitemap AND from hreflang
  const isNoIndex = (path) => {
    try {
      return /<meta name="robots" content="[^"]*noindex/.test(fs.readFileSync(path, "utf8").slice(0, 2048));
    } catch { return false; }
  };
  const slugCodes = {}; // slug -> Set(codes)
  for (const c of countries) {
    const dir = dirFor(c.code);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".html"))) {
      const slug = f.slice(0, -5);
      if (isNoIndex(`${dir}/${f}`)) { noIndexed.add(`${c.code}/${slug}`); continue; }
      (slugCodes[slug] = slugCodes[slug] || new Set()).add(c.code);
    }
  }
  const regionOf = (code) => (countries.find((c) => c.code === code) || {}).region || code.toUpperCase();
  let filmCount = 0;
  const filmUrls = [];
  const filmUrlsBy = {};
  for (const c of countries) {
    const dir = dirFor(c.code);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".html")).sort()) {
      const slug = f.slice(0, -5);
      if (noIndexed.has(`${c.code}/${slug}`)) continue; // empty-shell country page
      const codes = [...(slugCodes[slug] || [])];
      const alts = codes.length > 1
        ? "\n" + codes.map((cc) =>
            `    <xhtml:link rel="alternate" hreflang="${cc === "in" ? "en-IN" : "en-" + regionOf(cc)}" href="${filmUrlFor(cc, slug)}"/>`).join("\n")
          + `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${filmUrlFor(xDefaultCode(codes), slug)}"/>`
        : "";
      // The 1200x630 share card is the one image on the page that exists nowhere else on the
      // web (posters are TMDB's and appear on thousands of sites), so it is the one worth
      // offering to image search.
      const card = `cards/${c.code}/${slug}.png`;
      const img = fs.existsSync(card) ? `\n    <image:image><image:loc>https://filmychill.com/${card}</image:loc></image:image>` : "";
      const entry = `  <url><loc>${filmUrlFor(c.code, slug)}</loc><lastmod>${filmLastmod(c.code, slug)}</lastmod><priority>0.5</priority>${img}${alts ? alts + "\n  " : (img ? "\n  " : "")}</url>`;
      filmUrls.push(entry);
      (filmUrlsBy[c.code] = filmUrlsBy[c.code] || []).push(entry);
      filmCount++;
    }
  }
  // Language landing pages (India) — daily-refreshed discovery surfaces.
  // Only hubs written on THIS run (see LIVE_HUBS). Falls back to a directory scan when the
  // registry is empty — a sitemap-only rebuild that never called writePlatformHubPages —
  // so this can never silently drop every hub from the sitemap.
  const hubUrls = [];
  for (const c of countries) {
    const base = c.code === "in" ? "." : c.code;
    if (!fs.existsSync(base)) continue;
    const live = LIVE_HUBS.get(c.code);
    const slugs = (live && live.size)
      ? [...live]
      : (LIVE_HUBS.size ? [] : [...existingHubSlugs(c.code)]);
    for (const slug of slugs) {
      if (!fs.existsSync(`${base}/new-on-${slug}/index.html`)) continue;
      hubUrls.push(`  <url><loc>https://filmychill.com${c.code === "in" ? "" : "/" + c.code}/new-on-${slug}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`);
    }
  }
  const langUrls = LANGUAGE_PAGES.filter(([, slug]) => fs.existsSync(`${slug}/index.html`))
    .map(([, slug]) => `  <url><loc>https://filmychill.com/${slug}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`);
  // Weekly snapshots: the current week reports today; FROZEN weeks report their own
  // Sunday — deterministic from the directory name, never "today" for an untouched page.
  const weekUrls = [];
  if (fs.existsSync("week")) {
    const cur = weekSlug(isoWeekOf());
    for (const d of fs.readdirSync("week").filter((x) => /^\d{4}-W\d{2}$/.test(x)).sort()) {
      weekUrls.push(`  <url><loc>https://filmychill.com/week/${d}/</loc><lastmod>${lastmodOf(d === cur ? today : isoWeekSunday(d))}</lastmod><priority>0.4</priority></url>`);
    }
  }
  // Browse index pages. High priority: these are the crawl paths into the archive, so they
  // should be fetched often — every newly generated film page appears on one of them.
  const browseUrls = [];
  for (const c of countries) {
    const base = c.code === "in" ? "films" : `${c.code}/films`;
    if (!fs.existsSync(`${base}/index.html`)) continue;
    browseUrls.push(`  <url><loc>https://filmychill.com${browsePath(c.code, 1)}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.7</priority></url>`);
    for (const d of fs.readdirSync(base).filter((x) => /^\d+$/.test(x)).sort((a, b) => a - b)) {
      if (fs.existsSync(`${base}/${d}/index.html`))
        browseUrls.push(`  <url><loc>https://filmychill.com${browsePath(c.code, Number(d))}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.6</priority></url>`);
    }
  }
  // Monthly OTT archive (see buildOttMonthPage). The current month changes daily; a closed
  // month reports the last day of that month and never moves again.
  const monthUrls = [];
  const curMonth = monthKey(new Date().toISOString());
  for (const c of countries) {
    const base = c.code === "in" ? "new-on-ott" : `${c.code}/new-on-ott`;
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).filter((x) => /^\d{4}-\d{2}$/.test(x)).sort()) {
      if (!fs.existsSync(`${base}/${d}/index.html`)) continue;
      const [yy, mm] = d.split("-").map(Number);
      const lastDay = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
      monthUrls.push(`  <url><loc>${ottMonthUrl(c.code, d)}</loc><lastmod>${d === curMonth ? today : lastDay}</lastmod><priority>${d === curMonth ? "0.7" : "0.5"}</priority></url>`);
    }
  }
  // Scoped month archives: platform x month (every country) and language x month (India).
  // Same lastmod rule as the site-wide month pages — a closed month reports its own last day.
  const scopedMonthUrls = [];
  const lastDayOf = (m) => { const [yy, mm] = m.split("-").map(Number); return new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10); };
  for (const c of countries) {
    const base = c.code === "in" ? "." : c.code;
    if (!fs.existsSync(base)) continue;
    for (const dir of fs.readdirSync(base).filter((x) => x.startsWith("new-on-") && x !== "new-on-ott")) {
      const full = `${base}/${dir}`;
      if (!fs.statSync(full).isDirectory()) continue;
      for (const m of fs.readdirSync(full).filter((x) => /^\d{4}-\d{2}$/.test(x)).sort()) {
        if (!fs.existsSync(`${full}/${m}/index.html`)) continue;
        const loc = `https://filmychill.com${c.code === "in" ? "" : "/" + c.code}/${dir}/${m}/`;
        scopedMonthUrls.push(`  <url><loc>${loc}</loc><lastmod>${m === curMonth ? today : lastDayOf(m)}</lastmod><priority>${m === curMonth ? "0.6" : "0.4"}</priority></url>`);
      }
    }
  }
  for (const [, slug] of LANGUAGE_PAGES) {
    if (!fs.existsSync(slug)) continue;
    for (const m of fs.readdirSync(slug).filter((x) => /^\d{4}-\d{2}$/.test(x)).sort()) {
      if (!fs.existsSync(`${slug}/${m}/index.html`)) continue;
      scopedMonthUrls.push(`  <url><loc>https://filmychill.com/${slug}/${m}/</loc><lastmod>${m === curMonth ? today : lastDayOf(m)}</lastmod><priority>${m === curMonth ? "0.6" : "0.4"}</priority></url>`);
    }
  }
  const aboutUrls = [
    ...(fs.existsSync("about/index.html") ? [`  <url><loc>https://filmychill.com/about/</loc><lastmod>${ABOUT_LASTMOD}</lastmod><priority>0.3</priority></url>`] : []),
    ...(fs.existsSync("privacy/index.html") ? ["  <url><loc>https://filmychill.com/privacy/</loc><lastmod>2026-10-04</lastmod><priority>0.2</priority></url>"] : []),
  ];
  // /data/ was reaching IndexNow (so Bing saw it) but was absent from the sitemap, which is
  // Google's main discovery path — so Google could only find it by crawling a footer link.
  // It refreshes whenever the archive grows, hence changefreq weekly.
  const dataUrls = fs.existsSync("data/index.html")
    ? [`  <url><loc>https://filmychill.com/data/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`] : [];
  // The /embed/ instructions page is indexable (people should find it); the widget pages
  // under /embed/week/ are noindex, so they're intentionally NOT listed here.
  const embedUrls = fs.existsSync("embed/index.html")
    ? [`  <url><loc>https://filmychill.com/embed/</loc><lastmod>${today}</lastmod><priority>0.4</priority></url>`] : [];
  // Evergreen "streaming on <platform>" pages and people pages (both rebuilt every run).
  const streamUrls = [];
  for (const c of countries) {
    const base = STREAM_BASE(c.code);
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).sort()) {
      if (!fs.existsSync(`${base}/${d}/index.html`)) continue;
      streamUrls.push(`  <url><loc>${streamPageUrl(c.code, d)}</loc><lastmod>${today}</lastmod><priority>0.7</priority></url>`);
      for (const l of fs.readdirSync(`${base}/${d}`).sort()) {
        if (fs.existsSync(`${base}/${d}/${l}/index.html`)) streamUrls.push(`  <url><loc>${streamPageUrl(c.code, d, l)}</loc><lastmod>${today}</lastmod><priority>0.6</priority></url>`);
      }
    }
  }
  // Dated OTT pages: they change every run, so today is their honest lastmod.
  const datedUrls = [];
  for (const c of countries) {
    if (fs.existsSync(comingPath(c.code))) datedUrls.push(`  <url><loc>${comingUrl(c.code)}</loc><lastmod>${today}</lastmod><priority>0.7</priority></url>`);
    if (fs.existsSync(todayPath(c.code))) datedUrls.push(`  <url><loc>${todayUrl(c.code)}</loc><lastmod>${today}</lastmod><priority>0.7</priority></url>`);
  }
  const peopleUrls = [];
  for (const c of countries) {
    const base = PEOPLE_BASE(c.code);
    if (!fs.existsSync(base)) continue;
    if (fs.existsSync(`${base}/index.html`)) peopleUrls.push(`  <url><loc>${peopleIndexUrl(c.code)}</loc><lastmod>${today}</lastmod><priority>0.4</priority></url>`);
    for (const d of fs.readdirSync(base).sort()) {
      if (fs.existsSync(`${base}/${d}/index.html`)) peopleUrls.push(`  <url><loc>${personPageUrl(c.code, d)}</loc><lastmod>${today}</lastmod><priority>0.5</priority></url>`);
    }
  }

  // SITEMAP INDEX. One file per country's film pages plus one for everything else. At ~9,000
  // film URLs and growing ~700 a day, the single file was heading for the 50,000 limit — and
  // one file hides the number that matters now: Search Console reports "submitted vs indexed"
  // PER SITEMAP, so split files show how much of each market's catalogue Google has taken.
  const NS = `xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"`;
  const urlset = (entries) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset ${NS}>\n${entries.join("\n")}\n</urlset>\n`;
  const newest = (entries) => entries.reduce((mx, x) => { const d = (/<lastmod>([^<]+)<\/lastmod>/.exec(x) || [])[1] || ""; return d > mx ? d : mx; }, "") || today;
  const children = [];
  const pageEntries = [...countryUrls, ...langUrls, ...hubUrls, ...datedUrls, ...streamUrls, ...peopleUrls, ...browseUrls, ...dataUrls, ...embedUrls, ...weekUrls, ...monthUrls, ...scopedMonthUrls, ...aboutUrls, ...ottUrls];
  fs.writeFileSync("sitemap-pages.xml", urlset(pageEntries));
  children.push({ file: "sitemap-pages.xml", lastmod: newest(pageEntries) });
  for (const c of countries) {
    const entries = filmUrlsBy[c.code] || [];
    if (!entries.length) continue;
    const file = `sitemap-films-${c.code}.xml`;
    fs.writeFileSync(file, urlset(entries));
    children.push({ file, lastmod: newest(entries) });
  }
  // A market that no longer builds must not leave its old film sitemap behind.
  for (const f of fs.readdirSync(".").filter((x) => /^sitemap-films-[a-z]{2}\.xml$/.test(x))) {
    if (!children.some((c) => c.file === f)) fs.rmSync(f, { force: true });
  }
  fs.writeFileSync("sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${children.map((c) =>
      `  <sitemap><loc>https://filmychill.com/${c.file}</loc><lastmod>${c.lastmod}</lastmod></sitemap>`).join("\n")}\n</sitemapindex>\n`);
  console.log(`Sitemap index: ${children.length} files — ${countries.length} country + ${langUrls.length} language + ${streamUrls.length} streaming + ${peopleUrls.length} people + ${browseUrls.length} browse${dataUrls.length ? " + data" : ""} + ${weekUrls.length} week + ${monthUrls.length} month + ${scopedMonthUrls.length} scoped-month + ${filmCount} film pages.`);
}

module.exports = {
  contentFingerprint,
  pruneDeadHubLinks,
  sweepDeadHubLinks,
  syncFilmLastmods,
  writeMultiCountrySitemap,
};
