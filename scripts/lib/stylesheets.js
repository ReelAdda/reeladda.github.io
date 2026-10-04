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
// ============================================================================
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { PRIVACY_LINK } = require("./pagekit.js");

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

// Pure: make sure the page footer links the privacy page (pages written before Oct 2026).
function ensurePrivacyLink(html) {
  if (html.includes('href="/privacy/"')) return html;
  return html.replace(/(<footer>[\s\S]*?)(© 2026 FilmyChill)/, `$1${PRIVACY_LINK}$2`);
}

// The end-of-build pass over every film page. Returns counts; removes stylesheet files no
// page uses any more.
function finishFilmPages(files, { root = "." } = {}) {
  const used = new Set();
  const res = { pages: 0, externalized: 0, privacyLinked: 0, cssFiles: 0, removed: 0 };
  fs.mkdirSync(path.join(root, CSS_DIR), { recursive: true });
  for (const rel of files) {
    const file = path.join(root, rel);
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    res.pages++;
    let next = ensurePrivacyLink(html);
    if (next !== html) res.privacyLinked++;
    const ex = externalize(next);
    if (ex.css != null) {
      const cssFile = path.join(root, CSS_DIR, `${ex.name}.css`);
      if (!fs.existsSync(cssFile)) fs.writeFileSync(cssFile, ex.css);
      next = ex.html;
      res.externalized++;
    }
    const linked = LINK_RE.exec(next);
    if (linked) used.add(linked[1]);
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

module.exports = { externalize, ensurePrivacyLink, filmPageFiles, finishFilmPages, inlineStyles };
