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
// Per-page clicks, impressions and average position — no visitor data — are kept in
// search-top.json (committed, like the other data files; not published on the site), keyed by
// edition. The searches behind each page are read for the run's opportunities report only (below).
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

const round1 = (n) => Math.round(n * 10) / 10;

// Pure: Search Analytics rows ({ keys: [page], clicks, impressions, position }) ->
// { code: [[slug, clicks, impressions, position?], ...] } (position: Google's average, when given).
function groupRows(rows) {
  const out = {};
  for (const r of rows || []) {
    const f = filmOfUrl(r && r.keys && r.keys[0]);
    if (!f) continue;
    const row = [f.slug, Math.round(r.clicks || 0), Math.round(r.impressions || 0)];
    if (typeof r.position === "number" && r.position > 0) row.push(round1(r.position));
    (out[f.code] = out[f.code] || []).push(row);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => b[1] - a[1] || b[2] - a[2] || a[0].localeCompare(b[0]));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Search opportunities: pages Google shows often but people rarely click, with the reason.
// Listed only when clicked less than CTR floors for its position (page 2 and lower: under 1.5%).
//   ranking — average position below 10: the page is on Google's page 2 or lower, so few
//             searchers ever see it. Better content and more links to it are the fix.
//   snippet — on page 1 but clicked far less than a page 1 result usually is: the title and
//             description Google shows aren't winning the click (or the searches want something
//             the page doesn't offer — the top searches show which).
// The click-rate floors are deliberately low (well under typical rates for each position), so only
// a clear shortfall is listed. Search queries are used for the run's report only and never saved.
// ---------------------------------------------------------------------------------------------
const OPP_MIN_IMPRESSIONS = 200;
const OPP_LIMIT = 15;
const ctrFloor = (pos) => (pos <= 3 ? 0.08 : pos <= 6 ? 0.03 : 0.015);

// Pure: page rows and page+query rows (both as the API returns them) -> the opportunities, most
// impressions first. manifest (optional) gives film pages their titles.
function opportunities(pageRows, queryRows, { manifest = {}, minImpressions = OPP_MIN_IMPRESSIONS, limit = OPP_LIMIT } = {}) {
  const byPage = new Map();
  for (const r of queryRows || []) {
    const [page, q] = (r && r.keys) || [];
    if (!page || !q) continue;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push({ q, clicks: Math.round(r.clicks || 0), impressions: Math.round(r.impressions || 0), position: round1(r.position || 0) });
  }
  const out = [];
  for (const r of pageRows || []) {
    const url = r && r.keys && r.keys[0];
    const impressions = Math.round(r.impressions || 0), clicks = Math.round(r.clicks || 0), position = round1(r.position || 0);
    if (!url || impressions < minImpressions || !position) continue;
    // Under-clicked for where it sits. A page whose average is past 10 but still clicked well (one
    // strong search, many stray low ones dragging the average) isn't a problem, so isn't listed.
    const ctr = clicks / impressions;
    if (ctr >= ctrFloor(position)) continue;
    const kind = position > 10 ? "ranking" : "snippet";
    const f = filmOfUrl(url);
    const m = f && manifest[f.code] && manifest[f.code][f.slug];
    const path = String(url).replace(/^https:\/\/(?:www\.)?filmychill\.com/, "") || "/";
    const known = Object.keys(manifest).length > 0;
    const label = m && m.title ? `${m.title}${f.code === "in" ? "" : ` (${f.code.toUpperCase()})`}` : f && known && !m ? `${path} (not a current page — merged or removed)` : path;
    const queries = (byPage.get(url) || []).sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks).slice(0, 3);
    out.push({ url, path, label, clicks, impressions, ctr, position, kind, queries });
  }
  return out.sort((a, b) => b.impressions - a.impressions || a.path.localeCompare(b.path)).slice(0, limit);
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const PROBLEM = {
  ranking: (o) => `Ranking — page ${Math.ceil(o.position / 10)} of Google (avg #${o.position})`,
  snippet: (o) => `Snippet — page 1 (avg #${o.position}) but rarely clicked`,
};

// The report: a few log lines and a table in the run summary. Pure apart from the writes.
function reportOpportunities(list, { from, to, log = console.log, summaryFile = process.env.GITHUB_STEP_SUMMARY } = {}) {
  if (!list || !list.length) { log(`Search opportunities: none (no page with ${OPP_MIN_IMPRESSIONS}+ impressions is under-clicked)`); return; }
  const n = (k) => list.filter((o) => o.kind === k).length;
  log(`Search opportunities (${from} to ${to}): ${list.length} — ${n("ranking")} ranking, ${n("snippet")} snippet`);
  const qs = (o) => o.queries.map((q) => `"${q.q}" #${q.position}`).join(", ");
  for (const o of list) log(`  ${o.label} — ${o.impressions} seen, ${o.clicks} click${o.clicks === 1 ? "" : "s"} (${pct(o.ctr)}) — ${PROBLEM[o.kind](o)}${o.queries.length ? ` — ${qs(o)}` : ""}`);
  if (!summaryFile) return;
  const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  const md = [`### Search opportunities (${from} to ${to})`, "",
    `Pages Google showed ${OPP_MIN_IMPRESSIONS}+ times but people rarely clicked. **Ranking**: the page sits on Google's page 2 or lower — strengthen the page and link to it more. **Snippet**: it's on page 1 but its title and description in Google aren't winning the click — or the searches want something else (see the top searches).`, "",
    "| Page | Seen | Clicks | Click rate | Problem | Top searches (avg position) |", "|---|---:|---:|---:|---|---|",
    ...list.map((o) => `| [${cell(o.label)}](https://filmychill.com${o.path}) | ${o.impressions} | ${o.clicks} | ${pct(o.ctr)} | ${cell(PROBLEM[o.kind](o))} | ${cell(qs(o)) || "—"} |`), ""].join("\n");
  try { fs.appendFileSync(summaryFile, md + "\n"); } catch { /* a nicety */ }
}

// ---------------------------------------------------------------------------------------------
// Search health: Google impressions per day, so a sudden drop is noticed within a day or two.
// On 22 Oct 2026 impressions fell from ~4,800 a day to 666 (Google visits ~58 a day to 3) and
// nothing in the build said so. Search Console's final data runs 2–3 days behind, so the latest
// FINAL day is compared with the average of the seven before it.
//   drop    — the latest day is under DROP_RATIO of normal and the day before wasn't: a new drop.
//             Logged and shown as a warning in the run summary; it never fails the build.
//   down    — still under DROP_RATIO: a note each run, so it's tracked without alarming every day.
//   ok      — otherwise.
// ---------------------------------------------------------------------------------------------
const DROP_RATIO = 0.4;

// Pure: daily rows ({ keys: [date], impressions, clicks }, final data, oldest first) -> the verdict.
function searchHealth(rows) {
  const days = (rows || []).map((r) => ({ date: r.keys[0], imp: Math.round(r.impressions || 0), clicks: Math.round(r.clicks || 0) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (days.length < 9) return { state: "unknown", why: `only ${days.length} day(s) of data` };
  const ratioAt = (i) => { const prev = days.slice(i - 7, i); const avg = prev.reduce((n, d) => n + d.imp, 0) / prev.length; return { avg, ratio: avg ? days[i].imp / avg : 1 }; };
  const last = days.length - 1;
  const now = ratioAt(last), before = ratioAt(last - 1);
  const d = days[last];
  const base = { date: d.date, impressions: d.imp, clicks: d.clicks, normal: Math.round(now.avg), ratio: now.ratio };
  if (now.ratio < DROP_RATIO) return { ...base, state: before.ratio < DROP_RATIO ? "down" : "drop" };
  return { ...base, state: "ok" };
}

function searchHealthLine(h) {
  if (!h || h.state === "unknown") return `Search health: not checked (${(h && h.why) || "no data"})`;
  const pct = Math.round(h.ratio * 100);
  const head = { drop: "SHARP DROP", down: "still down", ok: "normal" }[h.state];
  return `Search health (Google, ${h.date}): ${head} — ${h.impressions} impressions, ${h.clicks} clicks; ${pct}% of the previous week's average (${h.normal} a day)`;
}

// Fetch the last 17 days of final data and judge the latest day. Dormant without access.
async function checkSearchHealth({ env = process.env, fetchImpl = fetch, nowMs = Date.now() } = {}) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) return { state: "unknown", why: "no service account" };
  let creds;
  try { creds = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); } catch { return { state: "unknown", why: "the service account isn't valid JSON" }; }
  const token = await accessToken(creds, { fetchImpl, nowMs });
  const sites = env.GSC_SITE ? [env.GSC_SITE] : ["sc-domain:filmychill.com", "https://filmychill.com/"];
  let why = "";
  for (const site of sites) {
    const r = await querySearch(fetchImpl, token, site, { startDate: isoDay(nowMs - 17 * 864e5), endDate: isoDay(nowMs), dimensions: ["date"] });
    if (r.ok) return searchHealth(r.j.rows);
    why = `${site}: ${r.err}`;
  }
  return { state: "unknown", why };
}

async function querySearch(fetchImpl, token, site, body) {
  const r = await fetchImpl(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j, err: (j.error && j.error.message) || r.status };
}

// Fetch the latest seven days of page clicks and save them; then the searches behind each page, for
// the opportunities report (kept in memory only). Dormant (returns why) without access.
async function refreshSearchTop({ env = process.env, fetchImpl = fetch, nowMs = Date.now(), file = SEARCH_TOP_FILE, manifest } = {}) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) return { ok: false, why: "no service account" };
  let creds;
  try { creds = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); } catch { return { ok: false, why: "the service account isn't valid JSON" }; }
  const token = await accessToken(creds, { fetchImpl, nowMs });
  const to = isoDay(nowMs - 3 * 864e5), from = isoDay(nowMs - 9 * 864e5);
  const sites = env.GSC_SITE ? [env.GSC_SITE] : ["sc-domain:filmychill.com", "https://filmychill.com/"];
  let lastErr = "";
  for (const site of sites) {
    const pages = await querySearch(fetchImpl, token, site, { startDate: from, endDate: to, dimensions: ["page"], rowLimit: 5000 });
    if (!pages.ok) { lastErr = `${site}: ${pages.err}`; continue; }
    const saved = { asOf: isoDay(nowMs), from, to, site, pages: groupRows(pages.j.rows) };
    fs.writeFileSync(file, JSON.stringify(saved));
    // The searches per page: only for the report, so a failure here costs the report its top searches, nothing more.
    let queryRows = [], queriesWhy = "";
    try {
      const q = await querySearch(fetchImpl, token, site, { startDate: from, endDate: to, dimensions: ["page", "query"], rowLimit: 25000 });
      if (q.ok) queryRows = q.j.rows || []; else queriesWhy = String(q.err);
    } catch (e) { queriesWhy = e.message; }
    if (!manifest) { try { manifest = JSON.parse(fs.readFileSync("pages-manifest.json", "utf8")); } catch { manifest = {}; } }
    return { ok: true, site, from, to, films: Object.values(saved.pages).reduce((n, l) => n + l.length, 0),
      opportunities: opportunities(pages.j.rows, queryRows, { manifest }), queriesWhy };
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
    .map((c) => ({ keys: [c[0]], clicks: Number(c[1]) || 0, impressions: Number(c[2]) || 0, position: Number(c[4]) || 0 }));
  return { asOf, from, to, site: "export", pages: groupRows(rows) };
}

module.exports = { DROP_RATIO, checkSearchHealth, searchHealth, searchHealthLine, MIN_CLICKS, OPP_MIN_IMPRESSIONS, POPULAR_CSS, SEARCH_TOP_FILE, accessToken, filmOfUrl, fromExport, groupRows, loadSearchTop, opportunities, popularBlockFor, popularBlockHtml, popularItems, rangeLabel, refreshSearchTop, reportOpportunities, resetPopularCache };
