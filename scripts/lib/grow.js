// ============================================================================
// grow.js — Mediavine Grow (grow.me) on every page, and the security policy that lets it run.
//
// Grow is a third-party widget (bookmarks, recommendations, email sign-up) loaded from
// faves.grow.me. Every FilmyChill page carries a strict Content-Security-Policy, so the widget
// needs (a) its loader on the page and (b) its origins allowed — exactly the ones it uses, and
// nothing broader. Both are applied in ONE pass after the last page writer of a build
// (addGrowToPages), the same way the search script is, so rebuilt, frozen and hand-written pages
// all carry it.
//
// The loader is Grow's OWN snippet, byte for byte, in each page's <head>, allowed by its SHA-256
// hash in script-src: the browser runs exactly that code and still refuses every other inline
// script ('unsafe-inline' is never added). Grow's installation check looks for its snippet in
// the page; two earlier versions — a site file (/js/grow.js) and an external main.js tag at the
// end of <body> — loaded Grow fine but were not recognised by the check (19 Oct 2026).
//
// Origins, from Grow's own scripts (main.js and its app bundle, Oct 2026):
//   faves.grow.me      the widget's scripts (and the chunks they import)
//   api.grow.me        its backend
//   some.growplow.events  its analytics (Snowplow)
//   img.grow.me, itp.mediavine.com  image resizing
//   urls.grow.me       its short links
//   app.grow.me        the hidden login frame (sign-in to save favourites)
//   faves.grow.me (fetch)  the widget's text and translations
//   client-rapi-mediavine.recombee.com  its recommendation engine (Recombee)
// (The last two only appear once the site is verified in Grow — seen in a browser, 19 Oct 2026.)
// Deliberately NOT allowed:
//   cdn.prod.euid.eu, cdn.prod.uidapi.com — the EUID and UID2 advertising-identity SDKs Grow tries
//     to load. Grow gives them 15 s, then carries on without them. Allow them only if the site
//     ever needs them for advertising — and update the Privacy page first.
//   fonts.googleapis.com — the widget's Lato web font: loading Google Fonts sends each visitor's
//     IP address to Google, so the widget uses the site's own fonts instead.
//
// Kill switch: GROW_SITE_ID="" in the workflow strips the snippet and the origins from every
// page on the next build.
// ============================================================================
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { mapPolicy, placeInHead, removeTag, withSources } = require("./csp.js");

const GROW_SITE_ID = process.env.GROW_SITE_ID === undefined
  ? "U2l0ZToxZTkwZjRlNS1kNTZiLTQ1M2UtOTA4Yy00NmYxNmIyNTZhOWE="
  : String(process.env.GROW_SITE_ID).trim();
const GROW_ON = !!GROW_SITE_ID;
// Grow's snippet exactly as its dashboard gives it (only the site ID varies).
const GROW_CODE = '!(function(){window.growMe||((window.growMe=function(e){window.growMe._.push(e);}),(window.growMe._=[]));var e=document.createElement("script");(e.type="text/javascript"),(e.src="https://faves.grow.me/main.js"),(e.defer=!0),e.setAttribute("data-grow-faves-site-id","'
  + GROW_SITE_ID + '");var t=document.getElementsByTagName("script")[0];t.parentNode.insertBefore(e,t);})();';
const GROW_TAG = `<script data-grow-initializer="">${GROW_CODE}</script>`;
const GROW_HASH = `'sha256-${crypto.createHash("sha256").update(GROW_CODE, "utf8").digest("base64")}'`;
// Earlier loaders, taken off any page that still has one.
const OLD_TAGS = [
  '<script src="/js/grow.js" defer></script>',
  `<script src="https://faves.grow.me/main.js" data-grow-faves-site-id="${GROW_SITE_ID}" defer></script>`,
];
const GROW_SOURCES = {
  "script-src": [GROW_HASH, "https://faves.grow.me"],
  "connect-src": ["https://api.grow.me", "https://faves.grow.me", "https://client-rapi-mediavine.recombee.com", "https://some.growplow.events", "https://img.grow.me", "https://itp.mediavine.com", "https://urls.grow.me"],
  "img-src": ["https://img.grow.me", "https://itp.mediavine.com"],
  "frame-src": ["https://app.grow.me"],
};

// Pure: a policy with Grow's sources added (on) or taken out (off) (lib/csp.js).
const growCsp = (policy, on = GROW_ON) => withSources(policy, GROW_SOURCES, on);

// Pure: one page with Grow on (snippet in <head> + sources) or off (neither). Idempotent.
function ensureGrow(html, on = GROW_ON) {
  let s = mapPolicy(String(html), (p) => growCsp(p, on));
  for (const t of OLD_TAGS) s = removeTag(s, t);
  return on ? placeInHead(s, GROW_TAG) : removeTag(s, GROW_TAG);
}

// The pass over every page, after the last page writer of the run. The embed widget renders
// inside other people's sites and post.html is a hand-kept draft: both are skipped.
function addGrowToPages(files, { root = ".", on = GROW_ON } = {}) {
  const res = { pages: 0, changed: 0 };
  for (const rel of files) {
    const r = String(rel).replace(/\\/g, "/");
    if (/(?:^|\/)embed\//.test(r) || r === "post.html") continue;
    const file = path.join(root, rel);
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    res.pages++;
    const next = ensureGrow(html, on);
    if (next !== html) { fs.writeFileSync(file, next); res.changed++; }
  }
  return res;
}

module.exports = { GROW_CODE, GROW_HASH, GROW_ON, GROW_SITE_ID, GROW_SOURCES, GROW_TAG, addGrowToPages, ensureGrow, growCsp };
