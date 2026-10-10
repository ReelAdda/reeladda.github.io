// ============================================================================
// stylesheets.js — film pages share their styles instead of each carrying a copy.
//
// Every film page used to inline the same ~9.6 KB <style> block: ~11,000 pages, ~100 MB —
// about a third of the whole site — repeated byte for byte, and re-downloaded on every page
// a visitor opens. There are only a handful of distinct versions (pages written in different
// months), so each distinct block becomes one file, named by its own content:
//
//     /css/fp-<hash>.css        e.g. /css/fp-3fea0d9f25.css
//
// A page keeps exactly the CSS it had — same rules, same order — just loaded from a file the
// browser caches once for every page. Nothing renders differently. New versions get new
// names automatically, so there is never a stale cached copy to worry about.
//
// Pages are still WRITTEN with inline styles by every builder and patcher (simplest for them);
// this pass, run at the end of the build, moves the style block out. The one patcher that
// edits a page's CSS (lib/scoresweep.js) puts it back inline first with inlineStyles().
//
// The same end-of-build walk finishes what frozen pages can't get from a rebuild (Oct 2026):
// browser icons in the <head>, the country in every non-India title, the "FilmyChill
// data" window line checked against the archive, and the uploadDate Google requires on a
// trailer's VideoObject. finishSitePages adds the icons to every
// other page on the site. Each fix is idempotent: a finished page is never written again.
// ============================================================================
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { COUNTRIES, escHtml, fmtDateFull, ICON_LINKS, ldJson, localeFor, videoUploadDate } = require("./core.js");
const { fcdataWindowPhrase } = require("./filmpage.js");
const { FOOTER_LINKS, NO_HOSTING_NOTICE, ytIdOf } = require("./pagekit.js");
const { titleWithCountry } = require("./rules.js");

const CSS_DIR = "css";
const STYLE_RE = /<style>([\s\S]*?)<\/style>/;
const LINK_RE = /<link rel="stylesheet" href="\/css\/(fp-[0-9a-f]{10})\.css">/;

const hashOf = (css) => crypto.createHash("sha1").update(css).digest("hex").slice(0, 10);

// Pure: the page with its style block replaced by a link, plus the CSS to write.
// Pages without exactly one <style> block are left alone.
function externalize(html) {
  const blocks = html.match(/<style>/g) || [];
  if (blocks.length !== 1) return { html, css: null, name: null };
  const m = STYLE_RE.exec(html);
  const name = `fp-${hashOf(m[1])}`;
  let out = html.replace(STYLE_RE, `<link rel="stylesheet" href="/css/${name}.css">`);
  // The page's own security policy must allow its stylesheet ('self').
  out = out.replace(/style-src 'unsafe-inline'/, "style-src 'self' 'unsafe-inline'");
  return { html: out, css: m[1], name };
}

// The page with its shared stylesheet put back inline (for patchers that edit CSS).
function inlineStyles(html, root = ".") {
  const m = LINK_RE.exec(html);
  if (!m) return html;
  let css;
  try { css = fs.readFileSync(path.join(root, CSS_DIR, `${m[1]}.css`), "utf8"); } catch { return html; }
  return html.replace(LINK_RE, `<style>${css}</style>`);
}

// Pure: the footer's no-hosting notice and Privacy · Copyright links (pagekit.js), on a page
// written before they existed. Only a footer carrying "© 2026 FilmyChill" is touched: the
// line goes just before it, replacing whichever of the pieces an older page already had.
const FOOTER_RE = /<footer>([\s\S]*?)<\/footer>/;
function ensureFooterLegal(html) {
  const m = FOOTER_RE.exec(html);
  if (!m) return html;
  const foot = m[1];
  // A homepage's credit line is footerAttribution(), re-rendered every run between these markers.
  if (foot.includes("<!--SSR:ATTRIBUTION-->")) return html;
  if (foot.includes(NO_HOSTING_NOTICE) && foot.includes('href="/dmca/"') && foot.includes('href="/privacy/"')) return html;
  const at = foot.indexOf("© 2026 FilmyChill");
  if (at < 0) return html;
  let before = foot.slice(0, at);
  for (const piece of [`${NO_HOSTING_NOTICE}<br>`, '<a href="/privacy/">Privacy</a> · ', '<a href="/dmca/">Copyright</a> · ']) before = before.replace(piece, "");
  before = before.trimEnd();
  const sep = before && !before.endsWith("<br>") ? "<br>" : "";
  return html.replace(m[0], `<footer>${before}${sep}${NO_HOSTING_NOTICE}<br>${FOOTER_LINKS}${foot.slice(at)}</footer>`);
}

// Pure: declare the browser icons (core.js ICON_LINKS) on a page that has none. Only the
// homepage did until Oct 2026; everything else 404ed on /favicon.ico. A page with no <head>
// (Google's verification file) is left exactly as it is.
function ensureIconLinks(html) {
  if (/<link rel="icon"/.test(html) || !html.includes("</head>")) return html;
  return html.replace("</head>", `${ICON_LINKS}\n</head>`);
}

// Pure: the edition's country in a non-India film title (see titleWithCountry in rules.js).
// Titles carrying an entity the decoder doesn't know are left alone rather than re-escaped
// into a double-encoded mess.
function ensureCountryTitle(html, cfg) {
  const m = /<title>([\s\S]*?)<\/title>/.exec(html);
  if (!m) return html;
  const cur = m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  if (/&[#a-z0-9]+;/i.test(cur)) return html;
  const next = titleWithCountry(cur, cfg);
  return next === cur ? html : html.replace(m[0], `<title>${escHtml(next)}</title>`);
}

// The "FilmyChill data: reached streaming … N days after its theatrical release" line on a
// page written before Oct 2026, checked against the archive. `claim` is cinemaClaim() from
// lib/history.js: "drop" removes the line (TV, straight to streaming here, or a cold-start
// sighting), "keep" corrects the number to the film's own cinema date, "unknown" leaves it.
const FCDATA_RE = /<p class="fcdata">[\s\S]*?<\/p>/;
function applyFcdataClaim(html, claim) {
  if (!claim || !FCDATA_RE.test(html)) return html;
  if (claim.action === "drop") return html.replace(FCDATA_RE, "");
  if (claim.action !== "keep" || claim.days == null) return html;
  return html.replace(/(<p class="fcdata"><b>FilmyChill data:<\/b> reached streaming in [^<]*? )(the same day it opened|\d+ days? after its theatrical release)/,
    (whole, lead) => `${lead}${fcdataWindowPhrase(claim.days)}`);
}

// Pure: the uploadDate Google requires on a trailer VideoObject, for pages that lack one
// (videoUploadDate in core.js). Pages written before Sept 2026 carry a trailer with only a
// name, url, description and thumbnail, and frozen pages are never rebuilt, so 186 of them sat
// in Search Console as invalid items in Oct 2026. The date is the film's own — the work's
// datePublished on the same page, the generator's proxy — and the watch and embed URLs the
// current markup has are added beside it. With no usable date the trailer leaves the markup
// (it stays on the page). Returns { html, fix: "dated" | "dropped" | null }.
const LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
function ensureTrailerUploadDate(html, nowMs = Date.now()) {
  let fix = null;
  if (!html.includes('"VideoObject"')) return { html, fix };
  const out = html.replace(LD_RE, (whole, json) => {
    if (!json.includes('"VideoObject"')) return whole;
    let o;
    try { o = JSON.parse(json); } catch { return whole; }
    const t = o && o.trailer;
    if (!t || t["@type"] !== "VideoObject" || t.uploadDate) return whole;
    const up = videoUploadDate(null, o.datePublished || o.startDate || o.dateCreated, nowMs);
    if (!up) {
      delete o.trailer;
      fix = "dropped";
    } else {
      const id = ytIdOf(t.contentUrl || t.url);
      o.trailer = { ...t, uploadDate: up,
        ...(t.contentUrl || !t.url ? {} : { contentUrl: t.url }),
        ...(t.embedUrl || !id ? {} : { embedUrl: `https://www.youtube-nocookie.com/embed/${id}` }) };
      fix = "dated";
    }
    return `<script type="application/ld+json">${ldJson(o)}</script>`;
  });
  return { html: out, fix };
}

// Pure: a film page's visible "Page updated" date and its JSON-LD dateModified, brought to the
// later of the two. The score sweep moved only the visible one until Oct 2026, so 8,906 pages
// told readers one date and search engines another. The visible date is in the edition's
// locale (fmtDateFull) or, on old pages, ISO; anything unreadable leaves the page alone.
const DATE_LOOKUP = new Map();
function isoFromPageDate(text, code) {
  const t = String(text).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const locale = localeFor(code);
  if (!DATE_LOOKUP.has(locale)) {
    const m = new Map();
    for (let ms = Date.UTC(2025, 0, 1); ms <= Date.now() + 864e5; ms += 864e5) {
      const iso = new Date(ms).toISOString().slice(0, 10);
      m.set(fmtDateFull(iso, locale), iso);
    }
    DATE_LOOKUP.set(locale, m);
  }
  return DATE_LOOKUP.get(locale).get(t) || null;
}
const PAGE_UPDATED_RE = /(<div class="meta" style="margin-top:2px;font-size:12\.5px">Page updated )([^<]+)(<\/div>)/;
function syncDateModified(html, code) {
  const vis = PAGE_UPDATED_RE.exec(html);
  const ld = /"dateModified":"(\d{4}-\d{2}-\d{2})/.exec(html);
  if (!vis || !ld) return html;
  const shown = isoFromPageDate(escDecode(vis[2]), code);
  if (!shown || shown === ld[1]) return html;
  if (shown > ld[1]) return html.replace(ld[0], `"dateModified":"${shown}`);
  return html.replace(vis[0], `${vis[1]}${escHtml(fmtDateFull(ld[1], localeFor(code)))}${vis[3]}`);
}
const escDecode = (s) => s.replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// "ae/movie/x.html" -> { code: "ae", slug: "x" }; India's pages live in /movie/.
function filmPageKey(rel) {
  const m = /^(?:([a-z]{2})\/)?movie\/([^/]+)\.html$/.exec(String(rel).replace(/\\/g, "/"));
  return m ? { code: m[1] || "in", slug: m[2] } : null;
}

// The end-of-build pass over every film page. Returns counts; removes stylesheet files no
// page uses any more. `fcdataClaim(code, slug)` (optional) answers for the window line.
// `retitled` lists "code/slug" for every page whose title changed, so the caller can tell the
// sitemap: a new title is a change worth a recrawl. `trailerFixed` does the same for pages
// whose trailer markup was repaired (trailerDropped of them lost it).
function finishFilmPages(files, { root = ".", fcdataClaim = null } = {}) {
  const used = new Set();
  const res = { pages: 0, externalized: 0, footerLinked: 0, cssFiles: 0, removed: 0, missing: 0, missingExamples: [],
    iconed: 0, retitled: [], fcdataDropped: 0, fcdataFixed: 0, trailerFixed: [], trailerDropped: 0, dateSynced: 0 };
  fs.mkdirSync(path.join(root, CSS_DIR), { recursive: true });
  for (const rel of files) {
    const file = path.join(root, rel);
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    res.pages++;
    let next = ensureFooterLegal(html);
    if (next !== html) res.footerLinked++;
    const key = filmPageKey(rel);
    if (key) {
      const iconed = ensureIconLinks(next);
      if (iconed !== next) { next = iconed; res.iconed++; }
      if (key.code !== "in") {
        const cfg = COUNTRIES.find((c) => c.code === key.code) || { code: key.code };
        const titled = ensureCountryTitle(next, cfg);
        if (titled !== next) { next = titled; res.retitled.push(`${key.code}/${key.slug}`); }
      }
      if (fcdataClaim && FCDATA_RE.test(next)) {
        const claim = fcdataClaim(key.code, key.slug);
        const checked = applyFcdataClaim(next, claim);
        if (checked !== next) { next = checked; if (claim.action === "drop") res.fcdataDropped++; else res.fcdataFixed++; }
      }
      const synced = syncDateModified(next, key.code);
      if (synced !== next) { next = synced; res.dateSynced++; }
      const dated = ensureTrailerUploadDate(next);
      if (dated.fix) {
        next = dated.html;
        res.trailerFixed.push(`${key.code}/${key.slug}`);
        if (dated.fix === "dropped") res.trailerDropped++;
      }
    }
    const ex = externalize(next);
    if (ex.css != null) {
      const cssFile = path.join(root, CSS_DIR, `${ex.name}.css`);
      if (!fs.existsSync(cssFile)) fs.writeFileSync(cssFile, ex.css);
      next = ex.html;
      res.externalized++;
    }
    const linked = LINK_RE.exec(next);
    if (linked) {
      used.add(linked[1]);
      // A page pointing at a stylesheet that doesn't exist renders unstyled. Never silently.
      if (!fs.existsSync(path.join(root, CSS_DIR, `${linked[1]}.css`))) {
        res.missing++;
        if (res.missingExamples.length < 3) res.missingExamples.push(`${rel} → /css/${linked[1]}.css`);
      }
    }
    if (next !== html) fs.writeFileSync(file, next);
  }
  for (const f of fs.readdirSync(path.join(root, CSS_DIR))) {
    const m = /^(fp-[0-9a-f]{10})\.css$/.exec(f);
    if (!m) continue;
    if (used.has(m[1])) res.cssFiles++;
    else { fs.unlinkSync(path.join(root, CSS_DIR, f)); res.removed++; }
  }
  return res;
}

// Every film page on disk, as paths relative to the site root.
function filmPageFiles(root = ".") {
  const out = [];
  const add = (dir) => {
    let names;
    try { names = fs.readdirSync(path.join(root, dir)); } catch { return; }
    for (const n of names) if (n.endsWith(".html")) out.push(`${dir}/${n}`);
  };
  add("movie");
  let tops = [];
  try { tops = fs.readdirSync(root); } catch { /* none */ }
  for (const t of tops) if (/^[a-z]{2}$/.test(t)) add(`${t}/movie`);
  return out;
}

// Every other HTML page on the site (film pages have their own pass above), as paths relative
// to the site root. Folders that are not website content are skipped.
const NOT_SITE = new Set([".git", ".github", ".wrangler", "_site", "cards", "cloudflare", "css", "fonts", "js", "node_modules", "scripts", "zz"]);
function sitePageFiles(root = ".") {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!dir && NOT_SITE.has(d.name)) continue;
        if (/^(?:[a-z]{2}\/)?movie$/.test(rel)) continue;
        walk(rel);
      } else if (d.name.endsWith(".html")) out.push(rel);
    }
  };
  walk("");
  return out;
}

// Browser icons on every non-film page: hubs, people, archives, About, Privacy, 404. Pages
// rebuilt each run already carry them; this reaches the frozen ones (past weeks and months,
// hand-written pages). The embed widget is skipped: it renders inside other people's pages.
function finishSitePages(files, { root = "." } = {}) {
  const res = { pages: 0, iconed: 0, footerLinked: 0 };
  for (const rel of files) {
    if (/(?:^|\/)embed\/week\//.test(rel)) continue;
    const file = path.join(root, rel);
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    res.pages++;
    let next = ensureIconLinks(html);
    if (next !== html) res.iconed++;
    const footed = ensureFooterLegal(next);
    if (footed !== next) { next = footed; res.footerLinked++; }
    if (next !== html) fs.writeFileSync(file, next);
  }
  return res;
}

// Pure: internal links whose target page no longer exists, taken out of a page. Every builder
// links a hub or a person page only when it exists, but a frozen page (a closed month, an
// archived film) keeps the link after a weekly hub is pruned or a person drops below the
// film minimum — 9 such pages in Oct 2026. A link in a " · " list leaves with its separator,
// any other keeps its text, and a "More:" line left empty goes. A platform month archive's
// breadcrumb moves from its missing hub to the week's OTT page, as buildScopedMonthPage does
// when the hub is already gone. `missing(href)` answers for site-relative or absolute URLs.
const SITE = "https://filmychill.com";
const MONTH_ARCHIVE_RE = /^(?:([a-z]{2})\/)?new-on-([^/]+)\/\d{4}-\d{2}\/index\.html$/;
function unlinkMissingPages(html, missing, rel = "") {
  const dead = (href) => {
    const h = href.startsWith(SITE + "/") ? href.slice(SITE.length) : href;
    return h.startsWith("/") && !h.startsWith("//") && missing(h);
  };
  // Mark each dead link, then drop marked links with a separator; the rest keep their text.
  let out = html.replace(/<a href="([^"]+)">([^<\u0000\u0001]*)<\/a>/g, (whole, href, text) => (dead(href) ? `\u0000${text}\u0001` : whole));
  out = out.replace(/ · \u0000[^\u0001]*\u0001/g, "").replace(/\u0000[^\u0001]*\u0001 · /g, "")
    .replace(/(More: )\u0000[^\u0001]*\u0001(<\/p>)/g, "$1$2").replace(/\u0000([^\u0001]*)\u0001/g, "$1");
  out = out.replace(/<p style="color:var\(--mute\);font-size:12\.5px;margin-top:10px">More: <\/p>/g, "");
  const arch = MONTH_ARCHIVE_RE.exec(String(rel).replace(/\\/g, "/"));
  if (arch && arch[2] !== "ott") {
    const code = arch[1] || "in";
    const week = code === "in" ? `${SITE}/new-on-ott/` : `${SITE}/${code}/new-on-ott/`;
    out = out.replace(/"name":"(?:[^"\\]|\\.)*","item":"(https:\/\/filmychill\.com\/[^"]*\/)"/g,
      (whole, item) => (item.endsWith(`/new-on-${arch[2]}/`) && dead(item) ? `"name":"New this week","item":"${week}"` : whole));
  }
  return out;
}

// The pass over every page, after the last page writer of the run (people pages included).
function repairDeadLinks(files, { root = "." } = {}) {
  const res = { pages: 0, fixed: [] };
  const seen = new Map();
  const missing = (href) => {
    let p = href.split("#")[0].split("?")[0].slice(1);
    if (p === "" || p.endsWith("/")) p += "index.html";
    if (!seen.has(p)) seen.set(p, !fs.existsSync(path.join(root, p)));
    return seen.get(p);
  };
  for (const rel of files) {
    const file = path.join(root, rel);
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    res.pages++;
    const next = unlinkMissingPages(html, missing, rel);
    if (next !== html) { fs.writeFileSync(file, next); res.fixed.push(rel.replace(/\\/g, "/")); }
  }
  return res;
}

module.exports = {
  applyFcdataClaim,
  ensureCountryTitle,
  ensureIconLinks,
  ensureFooterLegal,
  ensureTrailerUploadDate,
  externalize,
  filmPageFiles,
  filmPageKey,
  finishFilmPages,
  finishSitePages,
  inlineStyles,
  repairDeadLinks,
  sitePageFiles,
  syncDateModified,
  unlinkMissingPages,
};
