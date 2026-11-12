// ============================================================================
// brand.js — the FilmyChill mark (ring + play) beside the wordmark in every page's header.
//
// The mark is the site's rating ring around a play button: an amber arc over a faint track (the
// same colours as the ring on every card), with the play triangle inside. It is drawn inline (no
// extra request) and sized by attributes and inline style, so it needs no stylesheet change —
// archived pages, whose stylesheets are shared and frozen, show it the same as rebuilt ones.
//
// Applied in one pass after the last page writer (addBrandToPages), like Grow and analytics:
//   - the indigo top bar on film, list and hand-written pages: <div class="top"><a …>FILMY<span>CHILL</span></a>
//   - the homepage's large wordmark: <div class="logo">FILMY<span>CHILL</span></div>
// The same files as the app icons and favicon (icon-192.png, icon-512.png, favicon.ico).
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");

const shape = (track, play) =>
  `<circle cx="50" cy="50" r="37" fill="none" stroke="${track}" stroke-width="13"/>`
  + `<circle cx="50" cy="50" r="37" fill="none" stroke="#FFAD1F" stroke-width="13" stroke-linecap="round" stroke-dasharray="176 300" transform="rotate(38 50 50)"/>`
  + `<path d="M42 33 Q40 32 40 35 L40 65 Q40 68 42 67 L66 52.5 Q68 50 66 47.5 Z" fill="${play}"/>`;
// ONE LOGO (12 Nov 2026, owner: "we cannot have different colours for the brand"). The logo is
// the marigold ring with a white play on the brand's dark band (#1C1838): the wordmark's own two
// colours on the bar's own colour. Until now the headers drew an indigo play (made for the old
// cream header) and the app icon sat on an indigo tile, so the site, the icon and Instagram showed
// three versions. The owner saw the indigo tile on the dark bar in a mock-up, found the two blues
// clashed, and chose to move the logo to the bar's colour.
//   LOGO       on the dark bar: the ring and the play, nothing behind them.
//   LOGO_TILE  on anything else (the 404 page's cream, the app icon, the share of the logo alone):
//              the same on a rounded tile of the bar's colour.
// The track and the play carry their colours as inline styles too: the brand bar's stylesheet
// (TOP_BAR_CSS) recolours a mark's first circle and its path, and that stylesheet stays as it is
// so the pages that still show the old ring are not rewritten.
const BAND = "#1C1838";
const LOGO = shape("rgba(255,255,255,.22)", "#FFFFFF")
  .replace('stroke="rgba(255,255,255,.22)"', 'stroke="rgba(255,255,255,.22)" style="stroke:rgba(255,255,255,.22)"')
  .replace('fill="#FFFFFF"/>', 'fill="#FFFFFF" style="fill:#FFFFFF"/>');
const LOGO_TILE = `<rect width="100" height="100" rx="22" fill="${BAND}"/><g transform="translate(16 16) scale(.68)">${LOGO}</g>`;
const TOP_ATTRS = `class="brand-mark" viewBox="0 0 100 100" width="24" height="24" aria-hidden="true" style="flex:none;margin-right:8px"`;
const HOME_ATTRS = `class="brand-mark" viewBox="0 0 100 100" aria-hidden="true" style="width:.92em;height:.92em;flex:none;margin-right:.16em"`;
const MARK_TOP = `<svg ${TOP_ATTRS}>${LOGO}</svg>`;
const MARK_HOME = `<svg ${HOME_ATTRS}>${LOGO}</svg>`;
// The ring alone, as it was drawn until the logo: for pages whose stage hasn't come.
const RING_TOP = `<svg ${TOP_ATTRS}>${shape("rgba(255,255,255,.2)", "#FFFFFF")}</svg>`;
const RING_HOME = `<svg ${HOME_ATTRS}>${shape("#EFE6D6", "#4038C7")}</svg>`;

const TOP_RE = /<div class="top"><a href="([^"]*)">FILMY<span>CHILL<\/span><\/a>/g;
const HOME_RE = /<div class="logo">FILMY<span>CHILL<\/span><\/div>/g;
// A mark already on a page (hand-kept pages, the homepage template, film pages the builder wrote
// with the old ring): its drawing becomes the logo, its size and spacing stay. A mark already on
// its tile (the 404 page, on cream) is left as it is. Pure and idempotent.
const MARK_RE = /(<svg class="brand-mark"[^>]*>)((?:(?!<\/svg>)[\s\S])*)<\/svg>/g;
const oneLogo = (html) => String(html).replace(MARK_RE, (m, open, inner) => (inner.includes("<rect ") ? m : `${open}${LOGO}</svg>`));
// Film and person pages take the logo in stages (rollout "one-logo"): the mark is in every one of
// about 21,000 film pages, and no build rewrites that many. Every edition of a film together.
const ONE_LOGO = "one-logo";
function stagedKey(rel) {
  const m = /(?:^|\/)(movie|people)\/([^/]+?)(?:\.html|\/index\.html|\/)?$/.exec(String(rel).replace(/\\/g, "/"));
  return m ? (m[1] === "movie" ? m[2] : `people/${m[2]}`) : null;
}

// Pure: one page with the mark beside its header wordmark. Idempotent; a page without either
// header shape is returned unchanged. `upgrade: false` (a staged page whose stage hasn't come)
// leaves a mark already there as drawn and gives a page without one the ring.
function ensureBrandMark(html, { upgrade = true } = {}) {
  const s = String(html);
  if (s.includes('class="brand-mark"')) return upgrade ? oneLogo(s) : s;
  return s
    .replace(TOP_RE, (m, href) => `<div class="top"><a href="${href}" style="display:inline-flex;align-items:center">${upgrade ? MARK_TOP : RING_TOP}FILMY<span>CHILL</span></a>`)
    .replace(HOME_RE, `<div class="logo" style="display:inline-flex;align-items:center">${upgrade ? MARK_HOME : RING_HOME}FILMY<span>CHILL</span></div>`);
}

// The browser's toolbar colour (Android Chrome, an installed app's title bar) is the bar's colour
// too (12 Nov 2026): it was the indigo, a bright strip above the dark bar. With the logo, by the
// same stages. Pure and idempotent.
const THEME_OLD = '<meta name="theme-color" content="#4038C7">';
const THEME_NEW = `<meta name="theme-color" content="${BAND}">`;
const barColour = (html, on = true) => (on ? String(html).split(THEME_OLD).join(THEME_NEW) : String(html));

// The pass over every page, after the last page writer. The embed widget renders inside other
// people's sites and post.html is a hand-kept draft: both are skipped.
function addBrandToPages(files, { root = ".", included = (key) => require("./rollout.js").inRollout(ONE_LOGO, key) } = {}) {
  const res = { pages: 0, changed: 0 };
  for (const rel of files) {
    const r = String(rel).replace(/\\/g, "/");
    if (/(?:^|\/)embed\//.test(r) || r === "post.html") continue;
    const file = path.join(root, rel);
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    res.pages++;
    const key = stagedKey(r);
    const upgrade = !key || included(key);
    const next = barColour(ensureBrandMark(html, { upgrade }), upgrade);
    if (next !== html) { fs.writeFileSync(file, next); res.changed++; }
  }
  return res;
}

// The FilmyChill Verdict label (6 Nov 2026, owner): the two-colour wordmark, then "Verdict".
// Wherever the verdict is labelled: film-page score card, compact card, detail sheet.
// No mark (the owner keeps the icon for the homepage header). Colours for a light card: indigo
// FILMY, the dark marigold CHILL (bright marigold is unreadable on cream), ink VERDICT; on dark,
// the light link indigo and the bright marigold.
// Twin in js/app.js (VERDICT_LOCKUP); styles in VERDICT_CSS here and in index.html.
const VERDICT_LOCKUP = `<span class="fcv">Filmy<b>Chill</b><i>Verdict</i></span>`;
const VERDICT_DARK = ".fcv { color:#B3AEFF; } .fcv b { color:#FFAD1F; } .fcv i { color:#F4F1FF; }";
const VERDICT_CSS = [
  "  .fcv { display:inline-block; font-family:'Anton',Impact,sans-serif; font-weight:400; font-size:15px; letter-spacing:1px; line-height:1; text-transform:uppercase; color:#4038C7; white-space:nowrap; vertical-align:middle; }",
  "  .fcv b { font-weight:400; color:#8A5900; }",
  "  .fcv i { font-style:normal; color:var(--ink,#1A1633); margin-left:.3em; }",
  `  @media (prefers-color-scheme: dark) { ${VERDICT_DARK.replace(/(^|\} )\.fcv/g, "$1:root:not([data-theme=\"light\"]) .fcv")} }`,
  `  ${VERDICT_DARK.replace(/(^|\} )\.fcv/g, "$1:root[data-theme=\"dark\"] .fcv")}`,
].join("\n");

// The brand bar on list, hub and site pages (8 Nov 2026, owner: one brand look everywhere): the
// dark band of the homepage and film pages, the Anton wordmark in cream and marigold, a marigold
// edge, and the ring recoloured to a cream track and an indigo play. Replaces the indigo bar; the
// search button (js/search.js) sits in it as before. The logo (ONE LOGO above) carries inline
// colours, so the recolouring only reaches pages that still show the ring.
const TOP_BAR_OLD_CSS = "  .top { background:var(--indigo); padding:14px 16px; } .top a { color:var(--cream); text-decoration:none; font-weight:800; letter-spacing:1px; font-size:18px; }\n"
  + "  .top a span { color:#FFC04D; } /* 4.95:1 on indigo; marigold is 4.3:1 */";
const TOP_BAR_CSS = [
  "  /* Brand bar (lib/brand.js TOP_BAR_CSS) */",
  "  @font-face { font-family:'Anton'; src:url('/fonts/anton-latin.woff2') format('woff2'); font-display:swap; }",
  "  .top { background:#1C1838; padding:12px 16px; position:relative; } .top::before { content:''; position:absolute; left:0; top:0; bottom:0; width:5px; background:#FFAD1F; }",
  "  .top a { color:#FFF7EC; text-decoration:none; font-family:'Anton',Impact,sans-serif; font-weight:400; letter-spacing:1.2px; font-size:24px; line-height:1.2; }",
  "  .top a span { color:#FFAD1F; } .top .brand-mark circle:first-child { stroke:#EFE6D6; } .top .brand-mark path { fill:#4038C7; }",
].join("\n");

module.exports = { barColour, BAND, LOGO, LOGO_TILE, ONE_LOGO, oneLogo, stagedKey, MARK_HOME, MARK_TOP, TOP_BAR_CSS, TOP_BAR_OLD_CSS, VERDICT_CSS, VERDICT_LOCKUP, brandShape: shape, addBrandToPages, ensureBrandMark };
