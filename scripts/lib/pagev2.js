// ============================================================================
// pagev2.js — the film-page redesign v2 (28 Oct 2026), behind rollout feature V2_FEATURE.
//
// Presentation only: the page's facts, titles, descriptions, canonical, hreflang, robots and
// dates are untouched, and every element lib/facts.js and the archive patchers read keeps its
// markup. What v2 adds, in page order: a header on --deep with a breadcrumb, the hero's meta
// line and score pill, a primary call to action in four states (streaming / rent / unreleased /
// not streaming), Share and Remind-me actions, a provenance strip, the episode progress bar
// (lib/series.js), a click-to-load trailer, a sticky "Watch" bar once the CTA scrolls away, and
// dark mode through the same variables. One blue for surfaces (--deep) and one for links
// (--indigo): v2 never fills with #4038C7 (v2Css rewrites the base sheet's few indigo fills).
//
// Never: an India release time (dates stay TMDB's, countdown in days only and only for a
// streaming date), the platform in the <title>, a byline, pages for franchise siblings.
// ============================================================================
"use strict";

const { escHtml, fmtDateFull, localeFor } = require("./core.js");
const { inRollout } = require("./rollout.js");
const { dialRating } = require("./meter.js");

const V2_FEATURE = "redesign-v2";
const V2_MARK = "<!--FC:v2-->";
const v2Page = (item) => !!(item && item.slug && inRollout(V2_FEATURE, item.slug));

// The palette the film page and the homepage share (28 Oct 2026 spec).
const DEEP = "#1B165F";
const DARK_VARS = "--cream:#0F0C24; --card:#1A1538; --ink:#F4F1FF; --mute:#A9A4CC; --line:#2A2454; --bg:#0F0C24; --tint:#3A2E10; --link:#B3AEFF;";

const V2_CSS = [
  "  /* Redesign v2, 28 Oct 2026: one blue for surfaces (--deep), one for links (--indigo) */",
  `  :root { --deep:${DEEP}; --card:#fff; --bg:#F7F5FF; --tint:#FFF1D6; --link:var(--indigo); }`,
  `  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK_VARS} } }`,
  `  :root[data-theme="dark"] { ${DARK_VARS} }`,
  "  body { background:var(--bg); color:var(--ink); font-size:15px; line-height:1.55; font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; }",
  "  a { color:var(--link); }",
  "  .top { background:var(--deep); padding:12px 16px; display:flex; align-items:center; justify-content:space-between; }",
  "  .top .mark { font-family:'Anton',sans-serif; font-weight:400; letter-spacing:1.2px; font-size:20px; color:#fff; } .top .mark span { color:#fff; }",
  "  .top .cpill { color:#fff; border:1px solid rgba(255,255,255,.55); border-radius:999px; padding:5px 11px; font-size:11px; letter-spacing:1.2px; text-transform:uppercase; font-weight:700; }",
  "  .hero { background-color:var(--deep); min-height:390px; display:flex; flex-direction:column; justify-content:space-between; padding:12px 16px 26px; margin:-20px -16px 0; border-radius:0 0 24px 24px; background-size:cover; background-position:center 30%; }",
  "  .crumbs { font-size:13px; color:rgba(255,255,255,.88); margin:0; } .crumbs a { color:#fff; text-decoration:none; } .crumbs span { margin:0 6px; opacity:.6; }",
  "  .hero .head { grid-template-columns:104px 1fr; gap:14px; align-items:end; margin-top:24px; }",
  "  .hero .poster { width:104px; height:156px; border-radius:10px; }",
  "  .hero h1 { font-family:'Anton',sans-serif; font-weight:400; font-size:44px; line-height:.95; letter-spacing:.2px; margin:0 0 8px; overflow-wrap:anywhere; }",
  "  .hero .meta { font-size:13px; color:rgba(255,255,255,.86); margin-bottom:10px; }",
  "  .spill { display:inline-flex; align-items:center; gap:8px; background:var(--marigold); color:#1A1633; border-radius:999px; padding:6px 13px 6px 9px; font-size:13px; font-weight:700; min-height:36px; }",
  "  .spill .sn { font-family:'Anton',sans-serif; font-size:18px; line-height:1; }",
  "  .spill svg { width:18px; height:18px; fill:none; stroke:#1A1633; stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round; }",
  "  .spill.soon { background:rgba(255,255,255,.18); color:#fff; } .spill.soon svg { stroke:#fff; }",
  "  .cta { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:56px; margin:16px 0 0; padding:10px 16px; background:var(--deep); color:#fff; border-radius:14px; text-decoration:none; }",
  "  .cta b { font-size:16px; display:block; } .cta small { display:block; font-size:12px; opacity:.85; margin-top:2px; } .cta .arrow { font-size:22px; line-height:1; }",
  "  .cta .cd { font-family:'Anton',sans-serif; font-size:22px; line-height:1; white-space:nowrap; }",
  "  .cta.none { background:transparent; color:var(--ink); border:1.5px dashed var(--mute); } .cta.none small { color:var(--mute); opacity:1; }",
  "  .acts { display:grid; grid-template-columns:repeat(auto-fit, minmax(0, 1fr)); gap:8px; margin-top:10px; }",
  "  .acts button { min-height:44px; border:1.5px solid var(--line); background:var(--card); color:var(--ink); border-radius:14px; font:700 13px system-ui,sans-serif; cursor:pointer; transition:border-color .15s ease; }",
  "  .acts button:hover, .acts button:focus-visible { border-color:var(--deep); }",
  "  .prov { font-size:12px; color:var(--mute); margin:10px 0 0; line-height:1.6; } .prov a { color:var(--link); }",
  "  .anscard { margin:14px 0 4px; background:var(--card); box-shadow:none; border:1px solid var(--line); border-radius:14px; } .anscard .answer { color:var(--ink); }",
  "  .nextep { background:var(--tint); color:var(--ink); }",
  "  h2 { font-family:'Anton',sans-serif; font-weight:400; font-size:22px; letter-spacing:.2px; margin:28px 0 10px; }",
  "  .lbl { font-size:11px; text-transform:uppercase; letter-spacing:1.2px; color:var(--mute); font-weight:700; }",
  "  .fcsb { background:var(--card); box-shadow:none; border:1px solid var(--line); border-radius:14px; } .fcsb-verdict .dial span { background:var(--card); color:var(--ink); } .fcsb-row { background:var(--bg); }",
  "  .fcsb-verdict .dial { background:conic-gradient(var(--dc) var(--p, 0%), var(--line) 0); } .fcsb-tag { background:var(--bg); color:var(--link); } .fcsb-tag.none, .fcsb-conf { background:var(--bg); color:var(--mute); }",
  "  .fit, .faq, .eplist, .vprose, .take, .whywatch, .skipif, .wtw { background:var(--card); border:1px solid var(--line); border-radius:14px; }",
  "  .vprose, .take, .whywatch, .skipif { padding:12px 14px; margin-top:8px; } .take { color:var(--ink); } .take .tsrc { color:var(--mute); } .skipif { border-left:1px solid var(--line); }",
  "  .fcdata { background:var(--cream); border-left-color:var(--marigold); } .verdict { background:var(--cream); }",
  "  .epn { background:var(--deep); } .btn { background:var(--deep); border-radius:14px; }",
  "  .ephead { display:flex; justify-content:space-between; align-items:baseline; gap:12px; } .ephead h2 { margin-bottom:6px; }",
  "  .epbar { height:6px; background:var(--line); border-radius:3px; overflow:hidden; margin:0 0 8px; } .epbar i { display:block; height:100%; width:0; background:var(--deep); border-radius:3px; transition:width .3s ease; }",
  "  .eplist { padding:4px 14px; } .eplist li { min-height:44px; align-items:center; border-top-color:var(--line); } .eplist b { color:var(--ink); }",
  "  .eplist .next { background:var(--tint); margin:0 -14px; padding:10px 14px; border-radius:10px; border-top:0; } .eplist .next b { font-weight:800; }",
  "  .eplist .next .epn { animation:fcpulse 2s ease-in-out infinite; }",
  "  @keyframes fcpulse { 0%,100% { box-shadow:0 0 0 0 rgba(255,173,31,.6); } 50% { box-shadow:0 0 0 6px rgba(255,173,31,0); } }",
  "  .eplist .soon .epn { background:transparent; border:1.5px solid var(--mute); color:var(--mute); }",
  "  .cast-card { flex:0 0 76px; } .cast-card img { width:64px; height:64px; }",
  "  .gtk tbody { display:flex; flex-wrap:wrap; gap:8px; } .gtk tr { flex-direction:row; align-items:center; gap:6px; border-radius:999px; padding:8px 12px; background:var(--card); }",
  "  .gtk td:first-child { font-size:11px; text-transform:uppercase; letter-spacing:1.2px; color:var(--mute); } .gtk td:last-child { font-size:13px; color:var(--ink); }",
  "  .wtw { padding:12px 14px; } .wtw .pill { display:flex; align-items:center; gap:10px; border:0; padding:6px 0; margin:0; font-size:15px; font-weight:700; background:none; color:var(--ink); }",
  "  .wtw .pill::before { content:''; width:40px; height:40px; border-radius:10px; background:var(--deep); flex-shrink:0; }",
  "  .pill { background:var(--card); color:var(--ink); }",
  "  .frame { border-radius:14px; } .frame.yt { cursor:pointer; } .frame.yt img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }",
  "  .frame.yt .play { position:absolute; left:50%; top:50%; width:60px; height:60px; margin:-30px 0 0 -30px; border-radius:50%; background:var(--marigold); border:0; cursor:pointer; display:grid; place-items:center; }",
  "  .frame.yt .play::after { content:''; border-style:solid; border-width:11px 0 11px 19px; border-color:transparent transparent transparent #1A1633; margin-left:4px; }",
  "  .simcard { background:var(--card); border:1px solid var(--line); box-shadow:none; border-radius:14px; transition:transform .15s ease; } .simcard:hover, .simcard:focus-visible { transform:translateY(-2px); }",
  "  .frcard b { color:var(--ink); } .faq .fa { color:var(--mute); } .faq summary::after { color:var(--link); } .faq details { border-top-color:var(--line); }",
  "  footer { background:var(--deep); color:rgba(255,255,255,.82); margin-top:24px; } footer a { color:#fff; }",
  "  .sticky { position:fixed; left:0; right:0; bottom:0; min-height:44px; background:var(--card); border-top:1px solid var(--line); display:flex; align-items:center; gap:10px; padding:6px 12px; transform:translateY(110%); transition:transform .15s ease; z-index:9; }",
  "  .sticky.on { transform:none; } .sticky img { width:36px; height:54px; border-radius:6px; object-fit:cover; background:var(--line); } .sticky .st { flex:1; min-width:0; }",
  "  .sticky b { display:block; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .sticky small { color:var(--mute); font-size:12px; }",
  "  .sticky a { background:var(--deep); color:#fff; border-radius:999px; padding:10px 16px; font-weight:700; text-decoration:none; min-height:44px; display:flex; align-items:center; }",
  "  body.sticky-on .wrap { padding-bottom:88px; }",
  "  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation:none !important; transition:none !important; } }",
  "  @media (min-width:600px) { .hero h1 { font-size:48px; } .hero .head { grid-template-columns:120px 1fr; } .hero .poster { width:120px; height:180px; } }",
].join("\n");

// Pure: the base sheet with its indigo FILLS moved to --deep (links keep --indigo). Shadows
// that use the indigo rgba stay: they aren't fills.
function v2Css(baseCss) {
  return String(baseCss)
    .replace(/background:var\(--indigo\)/g, "background:var(--deep)")
    .replace(/background:rgba\(64,56,199,[^)]*\)/g, "background:var(--cream)")
    + "\n" + V2_CSS;
}

// The hero overlay: legible white text on any backdrop.
const HERO_GRADIENT = "linear-gradient(180deg, rgba(27,22,95,.35) 30%, rgba(27,22,95,.92) 75%)";

// Pure: the header (wordmark + edition pill).
function v2Header(homeUrl, countryName) {
  const e = escHtml;
  return `<div class="top"><a class="mark" href="${e(homeUrl)}">FILMY<span>CHILL</span></a><span class="cpill">${e(countryName)}</span></div>`;
}

// Pure: the visible breadcrumb and its schema's middle crumb. The middle crumb links a page
// that exists (the edition's weekly list), and says what that page is called.
function v2Crumbs(item, { homeUrl, weeklyUrl, weeklyLabel }) {
  const e = escHtml;
  return `<nav class="crumbs" aria-label="Breadcrumb"><a href="${e(homeUrl)}">FilmyChill</a><span>›</span><a href="${e(weeklyUrl)}">${e(weeklyLabel)}</a><span>›</span>${e(item.title)}</nav>`;
}

// Pure: the hero's meta line — a series: year · limited series | N seasons · N episodes; a
// film: year · genre · language · runtime (the runtime stays here: lib/facts.js reads it).
function v2Meta(item, year) {
  const ep = item.kind === "tv" ? item.episodes : null;
  // The year stays in the h1 (lib/facts.js reads the title there), so it isn't repeated here.
  void year;
  const parts = item.kind === "tv"
    ? [ep && ep.limited ? "Limited series" : (item.seasons || (ep && ep.seasons)) > 1 ? `${item.seasons || ep.seasons} seasons` : null,
      ep && ep.count ? `${ep.count} episode${ep.count === 1 ? "" : "s"}` : null, item.genre, item.language]
    : [item.genre, item.language, item.runtime ? `${item.runtime} min` : null];
  return parts.filter(Boolean).map(escHtml).join(" · ");
}

const DIAL_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l4-5"/></svg>`;
// Pure: the score pill under the hero meta — the audience number and the FilmyChill verdict;
// "Verdict soon" (muted) until there is one.
function v2ScorePill(item) {
  const e = escHtml;
  const s = item.fcScore;
  const r = s ? dialRating(item) : null;
  if (!s || !s.verdict) return `<span class="spill soon">${DIAL_ICON}Verdict soon</span>`;
  return `<span class="spill" title="The FilmyChill Score combines audience ratings and critics' reception">${DIAL_ICON}${r != null ? `<span class="sn">${r.toFixed(1)}</span>` : ""}${e(s.verdict)}</span>`;
}

// Pure: the primary call to action, in its four states, plus the actions row and the provenance
// strip. `st` is the page's release state (lib/core.js releaseState).
function v2Cta(item, { cfg, country, asOf, relState, V }) {
  const e = escHtml;
  const code = (cfg && cfg.code) || "in";
  const fmt = (d) => fmtDateFull(d, localeFor(code));
  const provs = (item.providers || []).map(String);
  const rent = (item.rentBuy || []).map(String).filter((x) => !provs.includes(x));
  const upcoming = relState === "upcoming" || relState === "today";
  const ott = V.word === "OTT" ? "OTT" : "streaming";
  let cta, remindDate = null;
  if (provs.length) {
    cta = `<a class="cta" href="#where-to-watch"><span><b>Watch on ${e(provs[0])}</b><small>Included with subscription${rent.length ? ` · Rent or buy: ${e(rent.slice(0, 2).join(", "))}` : ""}</small></span><span class="arrow">→</span></a>`;
  } else if (rent.length) {
    cta = `<a class="cta" href="#where-to-watch"><span><b>Rent or buy on ${e(rent[0])}</b><small>Not on any subscription in ${e(country)} yet</small></span><span class="arrow">→</span></a>`;
  } else if (item.digitalDate && String(item.digitalDate).slice(0, 10) >= String(asOf || "").slice(0, 10)) {
    // A confirmed streaming date: the one date a countdown may count to (days, never a time).
    remindDate = String(item.digitalDate).slice(0, 10);
    cta = `<div class="cta"><span><b>Streams from ${e(fmt(remindDate))}</b><small>${item.digitalNote ? `On ${e(item.digitalNote)}` : `Confirmed ${ott} date`}</small></span><span class="cd" data-countdown="${e(remindDate)}">${e(daysWord(remindDate, asOf))}</span></div>`;
  } else if (upcoming && item.released) {
    // A theatre or first-air date is not a streaming date: no countdown.
    remindDate = String(item.released).slice(0, 10);
    const inTheatres = item.kind !== "tv";
    cta = `<div class="cta"><span><b>${inTheatres ? "In theatres from" : "Releases"} ${e(relState === "today" ? "today" : fmt(remindDate))}</b><small>${inTheatres ? `${e(V.article)} ${e(V.release)} date follows once it opens` : `${e(V.article)} ${e(V.release)} date will be listed here when announced`}</small></span></div>`;
  } else if (item.state === "gone") {
    cta = `<div class="cta none"><span><b>Not on ${ott} in ${e(country)} right now</b><small>${(item.wasOn || []).length ? `Was on ${e(item.wasOn.slice(0, 2).join(", "))} · ` : ""}we re-check every day</small></span></div>`;
  } else {
    cta = `<div class="cta none"><span><b>Not on ${ott} in ${e(country)} yet</b><small>We re-check every day and this page updates the day it lands</small></span></div>`;
  }
  const acts = `<div class="acts"><button type="button" data-act="share" data-title="${e(item.title)}">Share</button>${remindDate ? `<button type="button" data-act="remind" data-title="${e(item.title)}" data-date="${e(remindDate)}">Remind me</button>` : ""}</div>`;
  const votes = Number(item.votes || 0);
  const prov = `<p class="prov">${votes ? `${e(votes.toLocaleString("en-IN"))} ratings · ` : ""}${asOf ? `Page updated ${e(fmt(asOf))} · ` : ""}Sources: TMDB, JustWatch${item.takeSrc === "wiki" ? ", Wikipedia" : ""} · <a href="/about/#score">How we score</a></p>`;
  return cta + acts + prov;
}

// Pure: "in N days" from the page's own date (the script keeps it current after that).
function daysWord(date, asOf) {
  const a = Date.parse(`${String(asOf || "").slice(0, 10)}T00:00:00Z`), b = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "";
  const n = Math.round((b - a) / 864e5);
  return n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
}

// Pure: the click-to-load trailer (the real embed only on tap; same nocookie URL).
function v2Trailer(ytid, title) {
  const e = escHtml;
  return `<h2>Trailer</h2><div class="frame yt" data-yt="${e(ytid)}" role="button" tabindex="0" aria-label="Play the ${e(title)} trailer"><img src="https://img.youtube.com/vi/${e(ytid)}/hqdefault.jpg" alt="" width="480" height="360" loading="lazy"><button type="button" class="play" aria-label="Play trailer"></button></div><p class="tlink"><a href="https://www.youtube.com/watch?v=${e(ytid)}" rel="noopener">Watch the trailer on YouTube →</a></p>`;
}

// Pure: the sticky bar, only for a title streaming now.
function v2Sticky(item, provs) {
  const e = escHtml;
  if (!provs.length) return "";
  return `<div class="sticky" id="sticky" aria-hidden="true">${item.poster ? `<img src="${e(item.poster)}" alt="" width="36" height="54" loading="lazy">` : ""}<span class="st"><b>${e(item.title)}</b><small>${e(provs[0])} · included</small></span><a href="#where-to-watch">Watch</a></div>`;
}

module.exports = { DEEP, HERO_GRADIENT, V2_CSS, V2_FEATURE, V2_MARK, daysWord, v2Crumbs, v2Css, v2Cta, v2Header, v2Meta, v2Page, v2ScorePill, v2Sticky, v2Trailer };
