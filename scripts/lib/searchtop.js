// ============================================================================
// searchtop.js — "Most searched this week": the film pages Google sends the most people to,
// linked from the homepage and the hubs, so the site's own links point where search demand is.
//
// Data: Google Search Console's Search Analytics API, clicks per page over the latest seven days
// it has (its data runs two to three days behind). Read with the Google service account the build
// already uses for visitors' votes (FIREBASE_SERVICE_ACCOUNT): add that account's email as a
// user on the Search Console property (Restricted is enough) and enable the "Google Search
// Console API" in its Google Cloud project. Without access this stays dormant: the last saved
// list is used if it is under two weeks old, otherwise no block is shown.
//
// Only per-page click and impression totals are read — no visitor data. They are kept in
// search-top.json (committed, like the other data files), keyed by edition.
//
// What the block says is what the data is: the pages people found most from Google search in
// the latest week of data. A film must have at least MIN_CLICKS clicks to be listed, so one stray
// visit never makes a film "most searched".
// ============================================================================
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const { escHtml, filmPagePath } = require("./core.js");
const { verdictPill } = require("./meter.js");

const SEARCH_TOP_FILE = "search-top.json";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const MIN_CLICKS = 2;
const MAX_AGE_DAYS = 14;
const LIMIT = 8;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// A service-account access token (OAuth 2.0 JWT bearer flow), no extra libraries.
async function accessToken(creds, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(nowMs / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: creds.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 })}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(creds.private_key).toString("base64url");
  const r = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${unsigned}.${sig}`,
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`token: ${j.error_description || j.error || r.status}`);
  return j.access_token;
}

// Pure: the heading and sub-line for the range the data covers — "this week" only when it is a week.
function rangeLabel(top) {
  const days = top && top.from && top.to ? Math.round((Date.parse(top.to) - Date.parse(top.from)) / 864e5) + 1 : 7;
  return days <= 8 ? { h: "Most searched this week", span: "in the latest week" } : { h: `Most searched in the last ${days} days`, span: `over the last ${days} days` };
}

// Pure: a Search Console page URL -> { code, slug } for a film page, else null.
function filmOfUrl(url) {
  const m = /^https:\/\/(?:www\.)?filmychill\.com\/(?:([a-z]{2})\/)?movie\/([^/?#]+)\.html$/.exec(String(url));
  return m ? { code: m[1] || "in", slug: decodeURIComponent(m[2]) } : null;
}

// Pure: Search Analytics rows ({ keys: [page], clicks, impressions }) -> { code: [[slug, clicks, impressions], ...] }.
function groupRows(rows) {
  const out = {};
  for (const r of rows || []) {
    const f = filmOfUrl(r && r.keys && r.keys[0]);
    if (!f) continue;
    (out[f.code] = out[f.code] || []).push([f.slug, Math.round(r.clicks || 0), Math.round(r.impressions || 0)]);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => b[1] - a[1] || b[2] - a[2] || a[0].localeCompare(b[0]));
  return out;
}

// Fetch the latest seven days of page clicks and save them. Dormant (returns why) without access.
async function refreshSearchTop({ env = process.env, fetchImpl = fetch, nowMs = Date.now(), file = SEARCH_TOP_FILE } = {}) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) return { ok: false, why: "no service account" };
  let creds;
  try { creds = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); } catch { return { ok: false, why: "the service account isn't valid JSON" }; }
  const token = await accessToken(creds, { fetchImpl, nowMs });
  const to = isoDay(nowMs - 3 * 864e5), from = isoDay(nowMs - 9 * 864e5);
  const sites = env.GSC_SITE ? [env.GSC_SITE] : ["sc-domain:filmychill.com", "https://filmychill.com/"];
  let lastErr = "";
  for (const site of sites) {
    const r = await fetchImpl(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ startDate: from, endDate: to, dimensions: ["page"], rowLimit: 5000 }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { lastErr = `${site}: ${(j.error && j.error.message) || r.status}`; continue; }
    const saved = { asOf: isoDay(nowMs), from, to, site, pages: groupRows(j.rows) };
    fs.writeFileSync(file, JSON.stringify(saved));
    return { ok: true, site, films: Object.values(saved.pages).reduce((n, l) => n + l.length, 0) };
  }
  return { ok: false, why: lastErr };
}

function loadSearchTop(file = SEARCH_TOP_FILE, nowMs = Date.now()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j || !j.asOf || (nowMs - Date.parse(j.asOf)) / 864e5 > MAX_AGE_DAYS) return null; // too old to call "this week"
    return j;
  } catch { return null; }
}

// Pure: the films to list for one edition — at least MIN_CLICKS clicks, a page that exists (in
// the manifest), passing \`keep\` (a hub's own filter), not already on the page (\`exclude\`).
function popularItems(top, code, manifest, { keep = () => true, exclude = new Set(), limit = LIMIT } = {}) {
  const rows = (top && top.pages && top.pages[code]) || [];
  const pages = (manifest && manifest[code]) || {};
  const out = [];
  for (const [slug, clicks] of rows) {
    if (out.length >= limit) break;
    if (clicks < MIN_CLICKS || exclude.has(slug)) continue;
    const m = pages[slug];
    if (!m || !m.title || !keep(m)) continue;
    out.push({ slug, clicks, title: m.title, lang: m.lang || "", year: String(m.released || "").slice(0, 4), kind: m.kind, verdict: (m.fcs && m.fcs.v) || "" });
  }
  return out;
}

const SCORED = /^(Must watch|Worth a watch|Skip)$/;
// The block: a numbered list of links, each with its language, year and FilmyChill verdict. Empty
// when fewer than three films qualify — a "most searched" list of one isn't a list.
function popularBlockHtml(items, code, top = null) {
  if (!items || items.length < 3) return "";
  const lbl = rangeLabel(top);
  const e = escHtml;
  const li = items.map((x) => {
    const meta = [x.lang, x.year, x.kind === "tv" ? "Series" : ""].filter(Boolean).map(e).join(" · ");
    const pill = SCORED.test(x.verdict) ? ` ${verdictPill(x.verdict)}` : "";
    return `<li><a href="${e(filmPagePath(code, x.slug))}"><span class="pop-b"><span class="pop-t">${e(x.title)}</span><span class="pop-m">${meta}</span>${pill}</span></a></li>`;
  }).join("");
  return `<section class="popular" aria-labelledby="pop-h"><div class="section-head"><h2 id="pop-h">${e(lbl.h)}</h2><span class="sub">The FilmyChill pages people found most on Google ${e(lbl.span)}</span></div><ol class="pop-list">${li}</ol></section>`;
}

// The block's styles, shared by the homepage and the list pages (the homepage's verdict pills and
// .section-head already exist there; list pages have their own heading style).
const POPULAR_CSS = ".popular { margin-top:32px; } .pop-list { list-style:none; margin:0; padding:0; counter-reset:pop; display:grid; gap:8px; }"
  + " .pop-list li { counter-increment:pop; } .pop-list a { display:flex; align-items:center; gap:10px; min-height:44px; padding:8px 12px; border-radius:12px; background:#fff; border:1px solid #EFE6D6; text-decoration:none; color:inherit; }"
  + " .pop-list a::before { content:counter(pop); font-family:'Anton',sans-serif; font-size:18px; color:#8A5800; min-width:18px; }"
  + " .pop-b { display:flex; flex-wrap:wrap; align-items:center; gap:4px 10px; min-width:0; } .pop-t { font-weight:700; font-size:14.5px; } .pop-m { color:#716A8C; font-size:12.5px; }"
  + " @media (min-width:720px) { .pop-list { grid-template-columns:1fr 1fr; } }";

// The block for one edition, from the saved data and the pages manifest (each read once a run).
// keep: a page's own filter (a hub's language or platform); exclude: slugs the page already lists.
let cache = null;
function popularBlockFor(code, { keep, exclude } = {}) {
  if (!cache) {
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync("pages-manifest.json", "utf8")); } catch { /* none yet */ }
    cache = { top: loadSearchTop(), manifest };
  }
  if (!cache.top) return "";
  return popularBlockHtml(popularItems(cache.top, code, cache.manifest, { keep, exclude }), code, cache.top);
}
function resetPopularCache() { cache = null; }

// Pure: a Search Console "Pages.csv" export (Top pages, Clicks, Impressions, ...) and its date range
// -> the saved shape. For loading an export by hand (scripts/import-search-export.js).
function fromExport(pagesCsv, { from, to, asOf }) {
  const rows = String(pagesCsv).split(/\r?\n/).slice(1).map((l) => l.split(",")).filter((c) => c.length >= 3)
    .map((c) => ({ keys: [c[0]], clicks: Number(c[1]) || 0, impressions: Number(c[2]) || 0 }));
  return { asOf, from, to, site: "export", pages: groupRows(rows) };
}

module.exports = { MIN_CLICKS, POPULAR_CSS, SEARCH_TOP_FILE, accessToken, filmOfUrl, fromExport, groupRows, loadSearchTop, popularBlockFor, popularBlockHtml, popularItems, rangeLabel, refreshSearchTop, resetPopularCache };
