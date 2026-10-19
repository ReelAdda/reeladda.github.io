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
// The loader is Grow's own script as an external tag carrying the site ID —
//   <script src="https://faves.grow.me/main.js" data-grow-faves-site-id="…" defer>
// — not Grow's inline snippet, which the policy refuses. main.js reads the ID from its own tag
// (document.currentScript), and Grow's installation check reads it from the page's HTML: the
// first version loaded it from /js/grow.js, which the check couldn't see (19 Oct 2026).
// Measured: first paint and the hero image are unchanged with the tag deferred like this.
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
// Kill switch: GROW_SITE_ID="" in the workflow strips the loader and the origins from every page
// on the next build.
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");

const GROW_SITE_ID = process.env.GROW_SITE_ID === undefined
  ? "U2l0ZToxZTkwZjRlNS1kNTZiLTQ1M2UtOTA4Yy00NmYxNmIyNTZhOWE="
  : String(process.env.GROW_SITE_ID).trim();
const GROW_ON = !!GROW_SITE_ID;
const GROW_TAG = `<script src="https://faves.grow.me/main.js" data-grow-faves-site-id="${GROW_SITE_ID}" defer></script>`;
// The first version's loader, taken off any page that still has it.
const OLD_TAG = '<script src="/js/grow.js" defer></script>';
const GROW_SOURCES = {
  "script-src": ["https://faves.grow.me"],
  "connect-src": ["https://api.grow.me", "https://some.growplow.events", "https://img.grow.me", "https://itp.mediavine.com", "https://urls.grow.me"],
  "img-src": ["https://img.grow.me", "https://itp.mediavine.com"],
  "frame-src": ["https://app.grow.me"],
};

function parsePolicy(policy) {
  return String(policy).split(";").map((p) => p.trim()).filter(Boolean)
    .map((p) => { const [name, ...vals] = p.split(/\s+/); return [name, vals]; });
}
const serialize = (dirs) => dirs.map(([n, v]) => [n, ...v].join(" ")).join("; ");

// Pure: a policy with Grow's origins added (on) or taken out (off). A directive the page doesn't
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

// Pure: one page with Grow on (loader + origins) or off (neither). Idempotent.
function ensureGrow(html, on = GROW_ON) {
  let s = String(html);
  const m = CSP_RE.exec(s);
  if (m) s = s.replace(m[0], m[1] + growCsp(m[2], on) + m[3]);
  s = s.split(`${OLD_TAG}
`).join("").split(OLD_TAG).join("");
  if (on) {
    if (!s.includes(GROW_TAG) && s.includes("</body>")) {
      const at = s.lastIndexOf("</body>");
      s = `${s.slice(0, at)}${GROW_TAG}\n${s.slice(at)}`;
    }
  } else {
    s = s.split(`${GROW_TAG}\n`).join("").split(GROW_TAG).join("");
  }
  return s;
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

module.exports = { GROW_ON, GROW_SITE_ID, GROW_SOURCES, GROW_TAG, addGrowToPages, ensureGrow, growCsp };
