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
// The site's own indigo (28 Oct 2026: the owner kept the palette; the layout changed, the colours did not).
const DEEP = "#4038C7";
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
  // The "Next" pulse is a ring on its own layer that only scales and fades (30 Oct 2026): it used
  // to animate box-shadow, which no browser can hand to the GPU, so phones repainted it on every
  // frame for as long as the page was open (Lighthouse, VisionQuest mobile: ~2 s of rendering).
  "  .eplist .next .epn { position:relative; } .eplist .next .epn::after { content:''; position:absolute; inset:0; border-radius:50%; box-shadow:0 0 0 6px rgba(255,173,31,.6); opacity:0; pointer-events:none; will-change:transform, opacity; animation:fcpulse 2s ease-out infinite; }",
  "  @keyframes fcpulse { 0% { opacity:1; transform:scale(.78); } 50%,100% { opacity:0; transform:scale(1); } }",
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
  "  footer { margin-top:24px; border-top:1px solid var(--line); } footer a { color:var(--link); }",
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

// ---- Page v3 (28 Oct 2026): the owner's sequence, the detail sheet's top block on the page ----
// The homepage's header on the film page: the mark (lib/brand.js shape) beside the wordmark,
// indigo FILMY and marigold CHILL on the cream, the edition pill and the search button as cards.
const MARK = `<svg class="brand-mark" viewBox="0 0 100 100" aria-hidden="true" style="width:.92em;height:.92em;flex:none;margin-right:.16em"><circle cx="50" cy="50" r="37" fill="none" stroke="#EFE6D6" stroke-width="13"/><circle cx="50" cy="50" r="37" fill="none" stroke="#FFAD1F" stroke-width="13" stroke-linecap="round" stroke-dasharray="176 300" transform="rotate(38 50 50)"/><path d="M42 33 Q40 32 40 35 L40 65 Q40 68 42 67 L66 52.5 Q68 50 66 47.5 Z" fill="#4038C7"/></svg>`;
function v3Header(homeUrl, countryName) {
  const e = escHtml;
  return `<div class="top v3"><a class="mark" href="${e(homeUrl)}">${MARK}FILMY<span>CHILL</span></a><span class="cpill">${e(countryName)}</span></div>`;
}
const V3_CSS = [
  "  /* Page v3: the homepage's palette and header; backdrop, title block, pills, score card with one line */",
  "  :root { --bg:#FFF7EC; --ink:#241D52; --mute:#716A8C; --line:#EFE6D6; --cream:#FFF7EC; --tint:#FFF3DC; --coral:#D93A28; --marigold-dk:#8A5900; }",
  "  .top.v3 { background:var(--bg); border-bottom:1px solid var(--line); min-height:60px; }",
  "  .top.v3 .mark { font-family:'Anton',sans-serif; font-weight:400; font-size:24px; letter-spacing:1.2px; color:var(--indigo); display:inline-flex; align-items:center; }",
  "  .top.v3 .mark span { color:var(--marigold); -webkit-text-stroke:1px var(--indigo); }",
  "  .top.v3 .cpill, .top.v3 .fcs-btn { color:var(--ink); background:var(--card); border:1px solid var(--line); box-shadow:0 4px 18px rgba(64,56,199,.08); font-weight:700; }",
  "  .top.v3 .fcs-btn svg { color:var(--indigo); }",
  "  @media (prefers-color-scheme: dark) { :root:not([data-theme=\"light\"]) .top.v3 .mark span { -webkit-text-stroke:0; } }",
  "  :root[data-theme=\"dark\"] .top.v3 .mark span { -webkit-text-stroke:0; }",
  "  .bd { margin:-20px -16px 0; height:220px; background:var(--deep); background-size:cover; background-position:center 25%; }",
  "  @media (min-width:600px) { .bd { height:300px; } }",
  "  .head.v3 { display:block; padding-top:18px; } .head.v3 h1 { font-size:32px; line-height:1.05; margin:0 0 6px; }",
  "  .v3tag { display:inline-block; margin:0 0 8px; padding:4px 10px; border-radius:6px; background:var(--coral,#D93A28); color:#fff; font:800 11px/1.2 system-ui,sans-serif; letter-spacing:1px; text-transform:uppercase; }",
  "  .v3tag.new { background:var(--marigold); color:#1A1633; } .v3tag.season { background:var(--deep); }",
  "  .head.v3 .meta { font-size:14px; color:var(--mute); margin-bottom:12px; }",
  "  .pills { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 4px; }",
  "  .rpill { display:inline-flex; align-items:center; min-height:40px; padding:0 14px; border-radius:999px; background:var(--cream); border:1px solid var(--line); color:var(--ink); font-weight:800; font-size:14px; }",
  "  .ppill { display:inline-flex; align-items:center; min-height:40px; padding:0 14px; border-radius:999px; background:var(--deep); color:#fff; font-weight:800; font-size:14px; }",
  "  .ppill.none { background:transparent; color:var(--mute); border:1.5px dashed var(--mute); font-weight:700; }",
  "  .pills .pill { display:inline-flex; align-items:center; min-height:40px; padding:0 14px; border-radius:999px; margin:0; font-size:14px; font-weight:800; background:var(--deep); color:#fff; border:0; }",
  "  .pills .st .pill { background:transparent; color:var(--mute); border:1.5px dashed var(--mute); font-weight:700; }",
  "  .pills .wlbl + .pill { background:var(--card); color:var(--ink); border:1px solid var(--line); }",
  "  .wlbl { display:inline-flex; align-items:center; font-size:11px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:var(--mute); padding:0 4px; }",
  "  .wnote.arrived b { color:var(--ink); }",
  "  .fcsb-line { font-size:14px; color:var(--mute); line-height:1.6; margin:12px 0 0; padding-top:12px; border-top:1px solid var(--line); } .fcsb-line b { color:var(--ink); }",
  "  .dir { margin:10px 0 0; font-size:15px; } .dir b { font-weight:800; }",
  // The vote widget follows the theme (it was a white card with dark-mode text, unreadable in dark).
  "  .fcvote { background:var(--card); border-color:var(--line); color:var(--ink); } .fcvote-q { color:var(--ink); }",
  "  .fcvote-b button { background:var(--card); color:var(--ink); border-color:var(--line); } .fcvote-b button.on { background:var(--deep); border-color:var(--deep); color:#fff; }",
  "  .wnote { margin:6px 0 0; font-size:12.5px; color:var(--mute); } .wnote b { color:var(--ink); font-weight:700; }",
  "  .gtk td .pill { margin:0 6px 6px 0; } .gtk td p { margin:4px 0 0; font-size:12.5px !important; }",
].join("\n");
function v3Css(baseCss) { return v2Css(baseCss) + "\n" + V3_CSS; }
// Pure: the status tag above the title — Trending, else the freshness badge (New season / New
// show / New release), else nothing. Above the h1, not inside it: lib/facts.js reads the h1.
function v3Tag(item) {
  const e = escHtml;
  if (item.trending) return `<span class="v3tag">Trending</span>`;
  // The badge as the lists compute it (lib/freshness.js freshBadge), from the latest season's
  // start — so a frozen page, which has no badge in its facts, says "New season" when the
  // pop-up does, and never from the series' first-ever air date.
  const start = item.kind === "tv" ? seasonStart(item) : (item.freshDate || item.released);
  const seasons = item.kind === "tv" ? (item.seasons || (item.episodes && item.episodes.seasons) || null) : null;
  const derived = start ? require("./freshness.js").freshBadge(item.kind === "tv" ? "tv" : "movie", String(start).slice(0, 10), Date.now(), seasons) : null;
  const badge = item.badge || derived || (item.isRecent ? "New release" : null);
  if (!badge) return "";
  return `<span class="v3tag ${/season/i.test(badge) ? "season" : "new"}">${e(badge)}</span>`;
}
// Pure: when the LATEST season started — the current season's first episode date from the
// episode guide (kept in the facts), else `freshDate` (this week's data); never the series'
// first-ever air date, which `released` holds for a series (Lupin: 8 Jan 2021 is not "latest
// season", 28 Oct 2026). null when neither is known: the line then says nothing about it.
function seasonStart(item) {
  // This week's data first (the pop-up's date, lib/rules.js deriveFreshDate: the market's own
  // date where it differs); the episode guide's earliest date for frozen pages, which carry no
  // freshDate.
  if (item && item.freshDate) return String(item.freshDate).slice(0, 10);
  const ep = item && item.kind === "tv" ? item.episodes : null;
  const first = ep && ep.list && ep.list.length ? ep.list.map((x) => x.date).filter(Boolean).sort()[0] : null;
  return first || null;
}
// Pure: the meta line — genre · language · latest season / released <date> · runtime · trailer views.
// `airLabel` (rollout "page-fixes-30oct"): a season start taken from the episode guide is TMDB's
// original air date, not necessarily the edition's ("13 Oct" in the US, 14 Oct on JioHotstar).
function v3Meta(item, { fmt = (d) => d, airLabel = false } = {}) {
  const { trailerViewsLabel } = require("./editorial.js");
  const start = item.kind === "tv" ? seasonStart(item) : null;
  const ep = item.kind === "tv" ? item.episodes : null;
  const guideFirst = ep && ep.list && ep.list.length ? ep.list.map((x) => x.date).filter(Boolean).sort()[0] : null;
  const when = item.kind === "tv"
    ? (start ? `Latest season ${fmt(start)}${airLabel && guideFirst && start === guideFirst ? " (original air date)" : ""}` : null)
    : (item.released ? `Released ${fmt(item.released)}` : null);
  const tv = item.trailerViews ? trailerViewsLabel(item.trailerViews) : null;
  return [item.genre, item.language, when, item.runtime ? `${item.runtime} min` : null, tv].filter(Boolean).map(escHtml).join(" · ");
}
// Pure: the audience pill (TMDB's number, its count), the platform pills and the where-to-watch
// caption — the page's one where-to-watch block (28 Oct 2026: the owner wants it said once, at
// the top). Inside <!--FC:wtw--> it carries exactly what the old section carried for the readers
// and the sweeps: provider pills (class "pill"), the rent/buy pills after a "Rent or buy" label,
// the "Availability as of <date> — …" sentence in its two forms, the SW:stream / SW:live /
// SW:arrived markers, and the hub links. The audience pill is not class "pill", so it is never
// read as a provider.
function v3Where(item, { relState, country, V, asOf = "", fmt = (d) => d }) {
  const e = escHtml;
  // The platform pill alone (28 Oct 2026): the audience number lives in the score card's ring.
  const aud = "";
  const provs = (item.providers || []).map(String), rb = Array.isArray(item.rentBuy) ? item.rentBuy.map(String) : [];
  const ott = V.word === "OTT" ? "OTT" : "streaming";
  const when = asOf ? e(fmt(asOf)) : "";
  // The platform pill is the whole visible answer (the owner: "platform name is enough"). The
  // availability sentence the facts store and the sweeps read stays, as a comment, in its two
  // exact forms; nothing else is printed.
  const note = `<!--Availability as of ${when} — platforms may change over time.-->`;
  const checked = item.untracked
    ? `<!--Availability as of ${when} — the last time we could check. We can't match this film on TMDB, so this page won't update on its own.-->`
    : `<!--Availability as of ${when} — checked that day: not on any streaming service in ${e(country)} yet.-->`;
  const rentPills = rb.length ? `<span class="wlbl">Rent or buy</span>${rb.map((p) => `<span class="pill">${e(p)}</span>`).join("")}` : "";
  const wrap = (pills, caption, { live = false } = {}) => (live
    ? `<!--FC:wtw--><!--SW:stream--><!--SW:live=${e(asOf || "")}--><div class="pills">${aud}${pills}</div>${caption}<!--/SW:stream--><!--/FC:wtw-->`
    : `<!--FC:wtw--><div class="pills">${aud}${pills}</div>${caption}<!--/FC:wtw-->`);
  if (provs.length) {
    const arrived = item.arrived ? `<!--SW:arrived=${e(item.arrived)}|${e(item.arrivedOn || provs[0])}-->` : "";
    // class="pill" exactly: lib/facts.js reads providers by that attribute, character for character.
    return wrap(provs.map((p) => `<span class="pill">${e(p)}</span>`).join("") + rentPills, `${arrived}${note}`, { live: true });
  }
  // Status pills (not providers; lib/facts.js STATUS_PILL skips them) sit in a .st wrapper, so
  // they draw as the quiet dashed pill while keeping the class the readers expect.
  if (item.platform === "Theatres") return wrap(`<span class="st"><span class="pill">In theatres</span></span>${rentPills}`, rb.length ? note : checked);
  if (rb.length) return wrap(rentPills, note);
  if ((relState === "upcoming" || relState === "today") && item.released) {
    const pill = relState === "today" ? "In cinemas today" : `In cinemas from ${e(fmt(item.released))}`;
    return wrap(`<span class="st"><span class="pill">${pill}</span></span>`, "");
  }
  // Nowhere: no block for the readers (as before), just the honest pill.
  return `<div class="pills">${aud}<span class="ppill none">Not on ${ott} in ${e(country)} ${item.state === "gone" ? "right now" : "yet"}</span></div>`;
}
// Kept for the mock-up's callers.
function v3Pills(item, opts) { return v3Where(item, opts); }

module.exports = { DEEP, HERO_GRADIENT, V2_CSS, V2_FEATURE, V2_MARK, V3_CSS, daysWord, v2Crumbs, v2Css, v2Cta, v2Header, v2Meta, v2Page, v2ScorePill, v2Sticky, v2Trailer, seasonStart, v3Css, v3Header, v3Meta, v3Pills, v3Tag, v3Where };
