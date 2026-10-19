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
// Deliberately NOT allowed: cdn.prod.euid.eu, the EUID advertising-identity SDK Grow tries to
// load. Grow gives it 15 s, then carries on without it. Allow it only if the site ever needs it
// for advertising — and update the Privacy page first.
//
// Kill switch: GROW_SITE_ID="" in the workflow strips the snippet and the origins from every
// page on the next build.
// ============================================================================
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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
  "connect-src": ["https://api.grow.me", "https://some.growplow.events", "https://img.grow.me", "https://itp.mediavine.com", "https://urls.grow.me"],
  "img-src": ["https://img.grow.me", "https://itp.mediavine.com"],
  "frame-src": ["https://app.grow.me"],
};

function parsePolicy(policy) {
  return String(policy).split(";").map((p) => p.trim()).filter(Boolean)
    .map((p) => { const [name, ...vals] = p.split(/\s+/); return [name, vals]; });
}
const serialize = (dirs) => dirs.map(([n, v]) => [n, ...v].join(" ")).join("; ");

// Pure: a policy with Grow's sources added (on) or taken out (off). A directive the page doesn't
// have starts from its default-src, so adding Grow never loosens anything else.
function growCsp(policy, on = GROW_ON) {
  const dirs = parsePolicy(policy);
  const def = (dirs.find(([n]) => n === "default-src") || [null, ["'self'"]])[1];
  for (const [name, srcs] of Object.entries(GROW_SOURCES)) {
    let d = dirs.find(([n]) => n === name);
    if (on) {
      if (!d) { d = [name, def.filter((x) => x !== "'none'")]; dirs.push(d); }
      for (const s of srcs) if (!d[1].includes(s)) d[1].push(s);
    } else if (d) {
      d[1] = d[1].filter((x) => !srcs.includes(x));
    }
  }
  return serialize(dirs);
}

const CSP_RE = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(">)/;
const strip = (s, tag) => s.split(`${tag}\n`).join("").split(tag).join("");

// Pure: one page with Grow on (snippet in <head> + sources) or off (neither). Idempotent.
function ensureGrow(html, on = GROW_ON) {
  let s = String(html);
  const m = CSP_RE.exec(s);
  if (m) s = s.replace(m[0], m[1] + growCsp(m[2], on) + m[3]);
  for (const t of OLD_TAGS) s = strip(s, t);
  if (!on) return strip(s, GROW_TAG);
  if (s.includes(GROW_TAG)) return s;
  // In <head>, after the policy (the meta must come first to apply to it).
  const at = s.indexOf("</head>");
  if (at >= 0) return `${s.slice(0, at)}${GROW_TAG}\n${s.slice(at)}`;
  const body = s.lastIndexOf("</body>");
  return body >= 0 ? `${s.slice(0, body)}${GROW_TAG}\n${s.slice(body)}` : s;
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
