// ============================================================================
// pagekit.js — the shared page kit every page builder uses: URL and path helpers (hubs,
// month archives, streaming and people pages), page chrome (analytics tag, CSP, OG image,
// footer attribution, the listing-page shell, title fitting), ISO-week helpers, streaming-date
// wording, and the theatre/streaming status pills written into frozen pages.
// ============================================================================
"use strict";

const fs = require("fs");
const {
  COUNTRIES,
  escHtml,
  filmPagePath,
  fmtDateShort,
  fmtDateFull,
  ICON_LINKS,
  ldJson,
  xDefaultCode,
  localeFor,
} = require("./core.js");
const { cardPaths } = require("./cards.js");
const { releaseState } = require("./release.js");
const { freshLabel, THEATRE_WINDOW_FALLBACK_DAYS } = require("./freshness.js");
const { canonProvider, countryNameFor, streamVocab } = require("./rules.js");
const { USE_IMDB } = require("./tmdb.js");

function img(path, size = "w342") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

// og:image / Twitter-card image URL, sized for Google Discover (favours >=1200px wide).
// Prefers the backdrop at w1280 (16:9, the shape Discover and social cards want); falls
// back to the poster at w780 so a backdrop-less title still clears the size bar instead of
// shipping a 342px thumbnail Discover would ignore. Uses raw *Path fields when present
// (real high-res); degrades to the pre-sized w780 backdrop / w342 poster strings only for
// items that predate those fields, so nothing crashes on a stale cache.
function socialImage(item, cfg) {
  if (!item) return null;
  // Branded card first — a shared link should preview as FilmyChill, not as a TMDB still.
  // Existence-checked rather than assumed, so a skipped/failed render silently degrades to
  // the backdrop instead of emitting an og:image that 404s.
  const card = cardPaths(item, cfg);
  if (card && fs.existsSync(card.file)) return card.url;
  if (item.backdropPath) return img(item.backdropPath, "w1280");
  if (item.posterPath) return img(item.posterPath, "w780");
  return item.backdrop || item.poster || null; // legacy fallback (already-sized strings)
}

function ytIdOf(url) {
  const m = /youtube\.com\/watch\?v=([\w-]{6,})/.exec(url || "");
  return m ? m[1] : null;
}

// ============================================================================
// ANALYTICS — GoatCounter, cookieless.
//
// Until now the site measured nothing at all. That is a defensible privacy stance and a bad
// operating position: there was no way to tell whether anyone returns, whether search visitors
// ever reach the WhatsApp channel, or which pages lose people. GoatCounter was chosen because
// it needs no cookies, no consent banner, no personal data and no account for the visitor: it
// records a page view and a referrer, and it honours Do Not Track.
//
// GC_SITE is the subdomain of the GoatCounter account (https://<code>.goatcounter.com). Set
// GC_SITE="" in the workflow to strip the tag from every page in the next build — the kill
// switch matters more than the tag, since this is the one piece of the site that touches a
// third party at runtime.
//
// Every page type carries a restrictive CSP, so the script host and the counting endpoint have
// to be allowed explicitly or the browser silently blocks it (see cspWith below). That is why
// both live in one place instead of being pasted into each template.
// ============================================================================
const GC_SITE = process.env.GC_SITE === undefined ? "filmychill" : String(process.env.GC_SITE).trim();

function analyticsTag() {
  if (!GC_SITE) return "";
  return `<script data-goatcounter="https://${escHtml(GC_SITE)}.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>`;
}

// Add the analytics origins to a CSP string, and nothing else. Returns the policy unchanged
// when analytics is off, so switching GC_SITE off also closes the hole it opened.
function cspWith(policy) {
  if (!GC_SITE) return policy;
  const host = `https://${GC_SITE}.goatcounter.com`;
  return policy
    .replace(/script-src ([^;]*)/, `script-src $1 https://gc.zgo.at`)
    .replace(/img-src ([^;]*)/, `img-src $1 ${host}`)
    .replace(/connect-src ([^;]*)/, `connect-src $1 ${host}`)
    // Pages whose policy has no connect-src at all inherit default-src 'self' and would block
    // the beacon, so give them one.
    .replace(/(default-src 'self';)(?![\s\S]*connect-src)/, `$1 connect-src 'self' ${host};`);
}

// Pure: swap a page's pending block for a "now streaming" answer, and upgrade the
// theatrical pill to real provider pills. Returns {html, changed} like archivePatchHtml.
// ============================================================================
// ANNOUNCED STREAMING DATES — one phrasing, used by the live page, the frozen-page patch, the
// FAQ, the title and the description, so they can never disagree.
// ============================================================================
function digitalAnnounceText(title, date, note, country, cfg) {
  const d = fmtDateFull(date, localeFor((cfg && cfg.code) || "in"));
  return `${title} is scheduled to start streaming${note ? ` on ${note}` : ""} in ${country} on ${d}.`;
}
function digitalUpcoming(item) {
  return !!(item && item.digitalDate && releaseState(item.digitalDate) !== "released"
    && !(Array.isArray(item.providers) && item.providers.length));
}

// ============================================================================
// DUE-DATE PASS — the other half of the freshness problem.
//
// The arrival sweep fixes pages whose film reached STREAMING. This fixes pages whose film
// reached THEATRES: a page frozen while the film was upcoming says "hasn't had its
// theatrical release yet, and is due 9 Oct" — which becomes a lie on 10 Oct and stays one,
// on exactly the query ("<film> release date") the page ranks for. Pure date logic against
// the <!--SW:due=YYYY-MM-DD--> stamp, so it costs no API budget and can run every build for
// every page. Rewrites only the pending block; the page's verdict and prose are untouched.
// ============================================================================
// ============================================================================
// THEATRICAL RUN STATE ON A FROZEN PAGE — what we can honestly say about "is it still on".
//
// No free source publishes per-cinema showtimes by country, so no page on this site can
// PROVE a film is still screening. What the site does have is its own working definition:
// the theatre lists only take films inside THEATRE_WINDOW_FALLBACK_DAYS of release. The run
// state uses exactly that, so a film page can never disagree with the homepage it came from:
//   open   — inside the window: "may still be showing — check local cinema listings"
//   ended  — past the window:   "its cinema run has most likely ended"
// Both are hedged on purpose. What this replaces was unhedged in both directions: the
// archive patch stamped "Theatrical run ended" the moment a film left the list — which for
// a coming-soon title is often RELEASE DAY (The Rope Curse 4, Singapore: frozen and marked
// "run ended" on 27 Aug, the day it opened) — while the FAQ said nothing either way.
// A page moves from open to ended once, on the day it crosses the window (see
// refreshDuePages), so the claim tracks time without rewriting the page every day.
// ============================================================================
function theatreRunState(released, now = Date.now()) {
  if (!released) return null;
  const days = Math.floor((now - Date.parse(`${released}T00:00:00Z`)) / 864e5);
  if (!Number.isFinite(days) || days < 0) return null;
  return days < THEATRE_WINDOW_FALLBACK_DAYS ? "open" : "ended";
}
// The frozen-page status pill for the open state. It names a fact (the opening date) rather
// than asserting a current screening, and it stays recognisable as a status pill ("cinema").
const openPill = (d) => `<span class="pill">Opened in cinemas ${escHtml(d)} — not streaming yet</span>`;
const OPEN_PILL_RE = /<span class="pill">Opened in cinemas [^<]* — not streaming yet<\/span>/;

// ============================================================================
// SETTLING A FROZEN PAGE PAST ITS RELEASE DATE.
//
// A page frozen before release carries pre-release copy in SIX places, and the due-date pass
// (patchDueIfPassed) only ever rewrote one of them — the streaming block. The rest kept
// saying the film was still to come, long after it opened:
//   header        "Releases 27 Aug 2026"
//   verdict       "It releases 2026-08-27; mark your calendar…"
//   where-to-watch "Not out yet — nowhere to stream or rent it until it opens."
//   FAQ + schema  "…hasn't released yet — it's due 2026-08-27. We'll list where to watch once it's out."
// Sept 2026: 107 pages site-wide showed a past release date beside a "coming soon" answer,
// and the FAQ one also sits in FAQPage schema, where Google can quote it verbatim.
//
// Two states, read from the page itself:
//   pending — released, not streaming. Says so, with the date it opened.
//   live    — the arrival sweep has stamped <!--SW:live-->. The FAQ says it's streaming and
//             the "not on any service" lines go, because the pills above now name them.
// Both states are idempotent, and pending -> live converts cleanly, so this runs safely from
// the due pass, the arrival patch and the archive sweep in any order.
//
// Only the page's own template sentences are matched; anything unrecognised is left alone.
// Apostrophes are matched in both forms because the same sentence lives in visible HTML
// (&#39;) and in JSON-LD ('), and each replacement keeps the escaping of the text it replaces.
// ============================================================================
function settleReleasedCopy(html, { countryName, cfg = null, now = Date.now() } = {}) {
  const date = (html.match(/"datePublished":"(\d{4}-\d{2}-\d{2})/) || html.match(/<!--SW:due=(\d{4}-\d{2}-\d{2})-->/) || [])[1];
  if (!date || releaseState(date, now) !== "released") return { html, changed: false };
  const live = html.includes("<!--SW:live=");
  const country = countryName || countryNameFor(cfg);
  const opened = fmtDateFull(date, localeFor(cfg && cfg.code));
  const APOS = "(?:'|&#39;)";
  const apos = (matched) => (matched.includes("&#39;") ? "&#39;" : "'");
  let out = html;

  // Header line.
  out = out.replace(/(<div class="meta" style="margin-top:8px">)Releases (?:today|[^<]+)(<\/div>)/, `$1Released ${escHtml(opened)}$2`);

  // Verdict close — ISO or human date, both forms the template has produced.
  out = out.replace(new RegExp(` It releases (?:on )?[^;<]+; mark your calendar if it${APOS}s on your list\\.`, "g"),
    (m) => ` It opened in theatres in ${escHtml(country)} on ${escHtml(opened)}.`);

  // Where-to-watch note.
  const pendingNote = `Not on a subscription service or to rent in ${escHtml(country)} yet.`;
  out = out.replace("Not out yet — nowhere to stream or rent it until it opens.", pendingNote);

  // FAQ "Where can I watch" — visible HTML and FAQPage JSON-LD. Pending pages also say
  // whether it may still be in cinemas (see theatreRunState): "opened on…" alone left the
  // one question a reader actually has — can I still see it? — unanswered.
  const run = live ? null : theatreRunState(date, now);
  const runClause = (a) => run === "open"
    ? ` and may still be showing — check local cinema listings`
    : run === "ended" ? `, and its cinema run has most likely ended` : "";
  const tail = (a) => live
    ? `opened in theatres in ${country} on ${opened}, and it${a}s streaming there now — see where to watch above.`
    : `opened in theatres in ${country} on ${opened}${runClause(a)}. It isn${a}t streaming yet — this page updates the day it is.`;
  out = out.replace(new RegExp(`hasn${APOS}t released yet(?: — it${APOS}s due [^.<"]+)?\\. We${APOS}ll list where to watch once it${APOS}s out\\.`, "g"),
    (m) => tail(apos(m)));
  if (!live) {
    // Pages settled before the run clause existed, or crossing from open to ended: rewrite the
    // sentence into the current state. Matches all three forms this template has produced.
    out = out.replace(new RegExp(`opened in theatres in ([^<"]+?) on ([^<".]+?)(?: and may still be showing — check local cinema listings|, and its cinema run has most likely ended)?\\. It isn${APOS}t streaming yet — this page updates the day it is\\.`, "g"),
      (m, c, d) => `opened in theatres in ${c} on ${d}${runClause(apos(m))}. It isn${apos(m)}t streaming yet — this page updates the day it is.`);
    // The archive patch's own run sentences say the run is over, unconditionally. Bring them
    // into the same state as the FAQ and the pill, or a page says "may still be showing" in
    // one place and "has finished its theatrical run" two paragraphs up.
    const V = streamVocab(cfg);
    out = out.replace(/It (?:had its theatrical run in|opened in theatres in) ([^<"—]+?)(?: on [^<"—]+?)? — check back here for its ((?:OTT|streaming) arrival)\./g,
      (m, c, arr) => run === "open"
        ? `It opened in theatres in ${c} on ${escHtml(opened)} — check back here for its ${V.arrival}.`
        : `It had its theatrical run in ${c} — check back here for its ${V.arrival}.`);
    out = out.replace(new RegExp(`(?:has finished its theatrical run in ([^<".]+?)|opened in theatres in ([^<".]+?) on [^<".]+?(?: and may still be showing — check local cinema listings|, and its cinema run has most likely ended)?)\\. (Its (?:OTT|streaming) release hasn${APOS}t been announced yet — check back soon\\.)`, "g"),
      (m, c1, c2, rest) => {
        const c = c1 || c2;
        const d = m.includes("&#39;") ? escHtml(opened) : opened;
        return run === "open"
          ? `opened in theatres in ${c} on ${d} and may still be showing — check local cinema listings. ${rest}`
          : `opened in theatres in ${c} on ${d}, and its cinema run has most likely ended. ${rest}`;
      });
    // The status pill. Only a THEATRICAL status pill is touched — never a provider.
    const short = fmtDateShort(date, now, localeFor(cfg && cfg.code));
    const statusPills = [OPEN_PILL_RE, /<span class="pill">Theatrical run ended — (?:OTT|streaming) arrival pending<\/span>/, /<span class="pill">In theatres<\/span>/];
    const want = run === "open" ? openPill(short)
      : `<span class="pill">Theatrical run ended — ${streamVocab(cfg).arrival} pending</span>`;
    for (const re of statusPills) { if (re.test(out)) { out = out.replace(re, want); break; } }
  }

  if (live) {
    // A page that settled while pending and has since started streaming.
    // The run clause goes with it — "may still be showing" is not the news any more.
    out = out.replace(new RegExp(`opened in theatres in ([^<"]+?) on ([^<".]+?)(?: and may still be showing — check local cinema listings|, and its cinema run has most likely ended)?\\. It isn${APOS}t streaming yet — this page updates the day it is\\.`, "g"),
      (m, c, d) => `opened in theatres in ${c} on ${d}, and it${apos(m)}s streaming there now — see where to watch above.`);
    out = out.split(pendingNote).join("");
    out = out.replace(/It (?:had its theatrical run in|opened in theatres in) ([^<"—]+?)(?: on [^<"—]+?)? — check back here for its (?:OTT|streaming) arrival\./g,
      (m, c) => `It had its theatrical run in ${c} and is streaming there now.`);
    out = out.replace(new RegExp(`(?:has finished its theatrical run in ([^<".]+?)|opened in theatres in ([^<".]+?) on [^<".]+?(?: and may still be showing — check local cinema listings|, and its cinema run has most likely ended)?)\\. Its (?:OTT|streaming) release hasn${APOS}t been announced yet — check back soon\\.`, "g"),
      (m, c1, c2) => `has finished its theatrical run in ${c1 || c2} and is streaming there now — see where to watch above.`);
    // The streaming-date FAQ ("…hasn't been officially announced yet… updates the day it
    // starts streaming") is answered now. The arrival patch never reached it either.
    out = out.replace(new RegExp(`\\bAn? (?:OTT|streaming|Streaming) [^<"]*?hasn${APOS}t been officially announced yet\\.[^<"]*?This page updates automatically the day it starts streaming\\.`, "g"),
      (m) => `It${apos(m)}s streaming in ${m.includes("&#39;") ? escHtml(country) : country} now — see where to watch above.`);
  }
  return { html: out, changed: out !== html };
}   // fewer arrivals than this is a thin page, not an archive

function ottMonthPath(code, month) {
  return code === "in" ? `new-on-ott/${month}/index.html` : `${code}/new-on-ott/${month}/index.html`;
}
const PLATFORM_SLUG_OVERRIDES = { "Amazon Prime Video": "prime-video", "Apple TV": "apple-tv", "Apple TV+": "apple-tv", "Disney+": "disney-plus", "Disney Plus": "disney-plus" };

// canonProvider (one name per service) lives in rules.js beside dedupeProviders, so every
// provider list read from TMDB is canonical from the start. Re-exported here for the callers
// that have always imported it from this module.
// A name that already says "Plus" before its "+" ("Movistar Plus+") reads "plus" once in the
// URL: /es/new-on-movistar-plus/, not /new-on-movistar-plus-plus/.
function platformSlug(name) {
  const n = canonProvider(name);
  if (PLATFORM_SLUG_OVERRIDES[n]) return PLATFORM_SLUG_OVERRIDES[n];
  return String(n).toLowerCase().replace(/plus\+/g, "plus").replace(/\+/g, " plus").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function hubPath(code, slug) { return code === "in" ? `new-on-${slug}/index.html` : `${code}/new-on-${slug}/index.html`; }
function hubUrl(code, slug) { return code === "in" ? `https://filmychill.com/new-on-${slug}/` : `https://filmychill.com/${code}/new-on-${slug}/`; }   // days since the platform was last confirmed
const STREAM_BASE = (code) => (code === "in" ? "streaming" : `${code}/streaming`);
const streamPagePath = (code, pslug, lslug = null) => `${STREAM_BASE(code)}/${pslug}/${lslug ? lslug + "/" : ""}index.html`;
const PEOPLE_BASE = (code) => (code === "in" ? "people" : `${code}/people`);
const personPagePath = (code, slug) => `${PEOPLE_BASE(code)}/${slug}/index.html`;

// Page titles: Google shows roughly 60 characters. The brand suffix is the first thing to go,
// because the query-bearing words come first on every page type and must survive intact.
function fitSiteTitle(t) {
  const s = String(t || "");
  return s.length > 60 && / \| FilmyChill$/.test(s) ? s.replace(/ \| FilmyChill$/, "") : s;
}
// First candidate that fits `max`, else the shortest.
function fitFirst(options, max) {
  const opts = options.filter(Boolean);
  return opts.find((x) => x.length <= max) || opts.reduce((a, b) => (b.length < a.length ? b : a), opts[0] || "");
}

function listingPageHtml({ title, desc, canonical, h1, updLine, lead, sections, faqs, extraLd, homeUrl, frozenNote, prevWeekHref = null, code = "in", altPaths = null, navLinks = null, ogImage = null }) {
  // ~80 hubs, month archives and week pages ran 61–72 characters; see fitSiteTitle.
  title = fitSiteTitle(title);
  const e = escHtml;
  // Back-link copy follows the market ("theatres + OTT" in India/UAE, "theatres +
  // streaming" everywhere else) — platform hubs exist for every country.
  const V = streamVocab({ code });
  const rowFor = (it) => {
    const badge = it.badge || (it.isRecent ? "New release" : null);
    const meta = [it.platform && it.platform !== "Theatres" ? it.platform : (it.platform === "Theatres" ? "In theatres" : null),
      it.genre ? it.genre.split(" / ")[0] : null, freshLabel(it) || null].filter(Boolean).map(e).join(" · ");
    const inner = `
      ${it.poster ? `<img src="${e(it.poster)}" alt="${e(it.title)} poster" width="92" height="138" loading="lazy">` : '<div class="nop"></div>'}
      <div>
        <div class="rt"><h3>${e(it.title)}</h3>${badge ? `<span class="badge">${e(badge)}</span>` : ""}${it.trending ? '<span class="badge trend">Trending</span>' : ""}</div>
        <div class="rm">${meta}</div>
        ${it.rating != null ? `<div class="rm"><b>★ ${Number(it.rating).toFixed(1)}</b>${it.fcScore ? " · " + e(it.fcScore.verdict) : ""}</div>` : (it.fcScore ? `<div class="rm">${e(it.fcScore.verdict)}</div>` : it.verdict ? `<div class="rm">${e(it.verdict)}</div>` : "")}
        ${it.hook ? `<div class="rm hk">${e(it.hook)}</div>` : ""}
        ${it.take ? `<div class="rm tk">${e(it.take)}</div>` : ""}
      </div>`;
    return it.slug ? `<a class="row" href="${e(filmPagePath(code, it.slug))}">${inner}</a>` : `<div class="row">${inner}</div>`;
  };
  const sectionHtml = sections.filter((sec) => sec.items.length).map((sec) => `
  <section>
    <h2>${e(sec.h2)} <span class="cnt">${sec.items.length}</span></h2>
    ${sec.items.map(rowFor).join("\n")}
  </section>`).join("\n");
  const faqHtml = faqs && faqs.length ? `
  <section>
    <h2>Quick answers</h2>
    <div class="faq">
      ${faqs.map((f) => `<details><summary>${e(f.q)}</summary><div class="fa">${e(f.a)}</div></details>`).join("\n      ")}
    </div>
  </section>` : "";
  const faqLd = faqs && faqs.length >= 2 ? {
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  } : null;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
${ICON_LINKS}
<meta name="robots" content="max-image-preview:large">
<link rel="canonical" href="${e(canonical)}">${altPaths && Object.keys(altPaths).length > 1 ? "\n" + Object.keys(altPaths).map((cc) => {
  const region = (COUNTRIES.find((x) => x.code === cc) || {}).region || cc.toUpperCase();
  return `<link rel="alternate" hreflang="${cc === "in" ? "en-IN" : "en-" + region}" href="https://filmychill.com${altPaths[cc]}"/>`;
}).join("\n") + `\n<link rel="alternate" hreflang="x-default" href="https://filmychill.com${altPaths[xDefaultCode(Object.keys(altPaths))] || altPaths[Object.keys(altPaths)[0]]}"/>` : ""}
<meta property="og:title" content="${e(h1)}">
<meta property="og:description" content="${e(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${e(canonical)}">
${ogImageTag(ogImage || hubOgImage((sections || []).flatMap((x) => x.items || []), { code }))}
<meta name="twitter:card" content="summary">
<meta http-equiv="Content-Security-Policy" content="${cspWith("default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' https://image.tmdb.org data:; object-src 'none'; base-uri 'self'")}">${analyticsTag()}
${(extraLd || []).map((o) => `<script type="application/ld+json">${ldJson(o)}</script>`).join("\n")}${faqLd ? `
<script type="application/ld+json">${ldJson(faqLd)}</script>` : ""}
<style>
  :root { --indigo:#4038C7; --marigold:#FFAD1F; --cream:#FFF7EC; --ink:#1A1633; --mute:#6B6890; --line:#E4E1F5; }
  * { box-sizing:border-box; } body { font-family:-apple-system,'Segoe UI',Roboto,sans-serif; background:#F7F5FF; color:var(--ink); margin:0; }
  .top { background:var(--indigo); padding:14px 16px; } .top a { color:var(--cream); text-decoration:none; font-weight:800; letter-spacing:1px; font-size:18px; }
  .top a span { color:var(--marigold); }
  .wrap { max-width:680px; margin:0 auto; padding:20px 16px 40px; }
  h1 { font-size:24px; margin:0 0 4px; line-height:1.3; }
  .upd { color:var(--mute); font-size:13px; margin-bottom:6px; }
  .lead { font-size:14.5px; line-height:1.6; color:var(--mute); margin:0 0 8px; }
  .nav { font-size:13px; line-height:2; margin:8px 0 2px; } .nav a { color:var(--indigo); text-decoration:none; font-weight:600; }
  .frozen { background:rgba(64,56,199,.07); border:1px solid var(--line); border-radius:10px; padding:10px 14px; font-size:13px; color:var(--mute); margin:10px 0 0; }
  h2 { font-size:17px; margin:26px 0 10px; } .cnt { color:var(--marigold); }
  .row { display:grid; grid-template-columns:92px 1fr; gap:12px; background:#fff; border:1px solid var(--line); border-radius:12px; padding:10px; margin-bottom:10px; text-decoration:none; color:inherit; }
  .row img { border-radius:8px; display:block; width:92px; height:138px; object-fit:cover; background:var(--line); }
  .nop { width:92px; height:138px; border-radius:8px; background:var(--line); }
  .rt { display:flex; gap:8px; align-items:center; flex-wrap:wrap; } .rt h3 { font-size:16px; margin:2px 0; }
  .badge { font-size:10px; letter-spacing:1px; text-transform:uppercase; color:var(--ink); background:var(--marigold); border-radius:5px; padding:3px 7px; font-weight:800; }
  .badge.trend { background:#FF4E3A; color:#fff; }
  .rm { color:var(--mute); font-size:13px; margin-top:4px; } .rm b { color:var(--indigo); }
  .rm.tk { color:var(--indigo); font-weight:600; }
  .rm.hk { font-style:italic; }
  .faq details { border-top:1px solid var(--line); padding:10px 0; }
  .faq summary { font-size:14.5px; font-weight:700; cursor:pointer; list-style:none; }
  .faq summary::-webkit-details-marker { display:none; }
  .faq summary::after { content:"+"; float:right; color:var(--indigo); font-weight:700; }
  .faq details[open] summary::after { content:"–"; }
  .faq .fa { font-size:14px; line-height:1.6; color:var(--mute); margin-top:8px; }
  .btn { display:inline-block; background:var(--indigo); color:#fff; font-weight:700; font-size:14px; padding:11px 20px; border-radius:10px; text-decoration:none; margin-top:20px; }
  footer { color:var(--mute); font-size:12px; text-align:center; padding:24px 16px; line-height:1.7; }
</style>
</head>
<body>
<div class="top"><a href="${e(homeUrl)}">FILMY<span>CHILL</span></a></div>
<div class="wrap">
  <h1>${e(h1)}</h1>
  <div class="upd">${e(updLine)}</div>
  <p class="lead">${e(lead)}</p>${navLinks && navLinks.length ? `
  <nav class="nav">${navLinks.map((l) => `<a href="${e(l.href)}">${e(l.label)}</a>`).join(" · ")}</nav>` : ""}${frozenNote ? `
  <div class="frozen">${e(frozenNote)}</div>` : ""}
${sectionHtml}
${faqHtml}
  <a class="btn" href="${e(homeUrl)}">← This week's full picks (theatres + ${e(V.word)})</a>${prevWeekHref ? `
  <a class="btn" style="background:transparent;color:var(--indigo);border:1.5px solid var(--indigo)" href="${e(prevWeekHref)}">← Previous week</a>` : ""}
</div>
<footer>
  ${footerAttribution()}© 2026 FilmyChill · Vikram Sharma
</footer>
</body>
</html>`;
}

// ============================================================================
// WEEKLY SNAPSHOTS — /week/<year>-W<ww>/ permalinks (India). Overwritten on
// every run DURING its week, frozen forever when the ISO week rolls over. Every
// WhatsApp share and RSS item gets a durable URL; Google gets dated, genuinely
// fresh pages weekly. Zero marginal content cost — it's this run's data.
// ============================================================================
function isoWeekOf(d = new Date()) { // ISO-8601 week number + week-year (UTC)
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return { year: date.getUTCFullYear(), week: Math.ceil((((date - yearStart) / 864e5) + 1) / 7) };
}
function weekSlug(w) { return `${w.year}-W${String(w.week).padStart(2, "0")}`; }
function isoWeekMonday(slug) { // "2026-W28" -> Date of that ISO week's Monday (UTC)
  const [y, w] = slug.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (w - 1) * 7);
  return monday;
}

// "21–27 Sept" (day-first markets) / "Sep 21–27" (US, Philippines): the current ISO week, in
// the market's own order. Shared by the homepage title and the weekly hub titles.
function weekRangeFor(when, code) {
  const wk = isoWeekOf(new Date(when));
  const mon = isoWeekMonday(weekSlug(wk));
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  const loc = localeFor(code);
  const dayMon = (d) => d.toLocaleDateString(loc, { day: "numeric", month: "short", timeZone: "UTC" });
  const monthFirst = /^[A-Za-z]/.test(dayMon(mon));
  const dd = (d) => String(d.getUTCDate());
  const mm = (d) => dayMon(d).replace(/\d+/, "").replace(/[ ,]+/g, " ").trim();
  return mon.getUTCMonth() === sun.getUTCMonth()
    ? (monthFirst ? `${mm(mon)} ${dd(mon)}–${dd(sun)}` : `${dd(mon)}–${dd(sun)} ${mm(sun)}`)
    : `${dayMon(mon)} – ${dayMon(sun)}`;
}

// Footer attribution text, matched to the active ratings source so the credit always reflects
// the data actually used. Takes useImdb (defaults to the global USE_IMDB) so both modes can be
// unit-tested directly, without spawning a subprocess. IMDb mode: TMDB credited for film data +
// IMDb credited for ratings using IMDb's REQUIRED verbatim wording. TMDB mode: TMDB credited for
// both (no IMDb name anywhere, since IMDb data isn't used and its terms forbid using its name
// without a current license).
// Every page footer links the privacy page (Oct 2026); templates follow this with "© 2026 …".
const PRIVACY_LINK = '<a href="/privacy/">Privacy</a> · ';
function footerAttribution(useImdb = USE_IMDB) {
  // Required wording kept verbatim (TMDB's disclaimer; IMDb's "Used with permission" when its
  // ratings are shown); only the layout is compact: credits on one line, the notice below.
  const tmdb = `<a href="https://www.themoviedb.org" rel="noopener" target="_blank">TMDB</a>`;
  const jw = `<a href="https://www.justwatch.com" rel="noopener" target="_blank">JustWatch</a>`;
  if (useImdb) {
    return `Film data from ${tmdb} · Where-to-watch data by ${jw} · Ratings information courtesy of <a href="https://www.imdb.com" rel="noopener" target="_blank">IMDb</a> (https://www.imdb.com). Used with permission.<br>This product uses the TMDB API but is not endorsed or certified by TMDB.<br>${PRIVACY_LINK}`;
  }
  return `Film data and ratings from ${tmdb} · Where-to-watch data by ${jw}<br>This product uses the TMDB API but is not endorsed or certified by TMDB.<br>${PRIVACY_LINK}`;
}

// A hub's share/Discover image: the first listed title with a large image (its branded card,
// else its w1280 backdrop — see socialImage). Every hub, homepage and week page used to share
// one logo image, which Discover skips and which made every link preview look identical.
function hubOgImage(items, cfg) {
  for (const it of items || []) {
    const src = socialImage(it, cfg);
    if (src && !/\/w(92|154|185|342)\//.test(src)) return src;
  }
  return "https://filmychill.com/og-image.png";
}
function ogImageTag(src) {
  const big = /\/w1280\//.test(src) ? '\n<meta property="og:image:width" content="1280">\n<meta property="og:image:height" content="720">'
    : /\/cards\//.test(src) || /og-image\.png$/.test(src) ? '\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">' : "";
  return `<meta property="og:image" content="${escHtml(src)}">${big}`;
}

module.exports = {
  PRIVACY_LINK,
  analyticsTag,
  canonProvider,
  cspWith,
  digitalAnnounceText,
  digitalUpcoming,
  fitFirst,
  fitSiteTitle,
  footerAttribution,
  GC_SITE,
  hubOgImage,
  hubPath,
  hubUrl,
  img,
  isoWeekMonday,
  isoWeekOf,
  listingPageHtml,
  ogImageTag,
  OPEN_PILL_RE,
  ottMonthPath,
  PEOPLE_BASE,
  personPagePath,
  platformSlug,
  settleReleasedCopy,
  socialImage,
  STREAM_BASE,
  streamPagePath,
  theatreRunState,
  weekRangeFor,
  weekSlug,
  ytIdOf,
};
