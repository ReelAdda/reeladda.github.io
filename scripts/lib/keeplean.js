// ============================================================================
// keeplean.js — keeps the site lean on its own (27 Oct 2026, after the Oct cleanup).
//
// The 22 Oct 2026 drop came from things that grew with no rule asking whether they earned their
// place: 14,654 back-catalogue pages, month and week archives, thin lists. The cleanup fixed that
// once. These two jobs keep it fixed:
//
// 1. MONTHLY HIDE ROLL (rollHiddenList). google-hidden.json was a one-time snapshot. Every
//    ROLL_DAYS it is recomputed from Search Console: a page is hidden from Google when it had no
//    impression in the last WINDOW_DAYS and is a catalogue page (any age) or a weekly-list page
//    whose film is over WEEKLY_HIDE_DAYS old. A page that earned impressions is never listed — so a
//    hidden page that came back for news (a platform arrival) and was shown stays visible for good.
//    Guarded: if Search Console returns far fewer shown pages than last time (an outage, a
//    permissions change), the roll is skipped rather than hide everything.
//
// 2. WEEKLY HEALTH REPORT (weeklyHealth). Every 7 days: the numbers checked by hand in Oct 2026,
//    with alarms — indexed share of a sample of visible pages (URL Inspection), links from visible
//    pages to hidden ones, new titles under 3 links, visible pages with no link in, pages offered.
//    History in site-health.json (build data, not published).
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { accessToken } = require("./searchtop.js");
const G = require("./googlehide.js");

const ROLL_DAYS = 28;
const WINDOW_DAYS = 90;
const HEALTH_FILE = "site-health.json";
const HEALTH_EVERY_DAYS = 7;
const SAMPLE = 60;
const B = "https://filmychill.com/";
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

async function gscToken(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) return null;
  try { return await accessToken(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)); } catch { return null; }
}
const sitesOf = (env) => (env.GSC_SITE ? [env.GSC_SITE] : ["https://filmychill.com/", "sc-domain:filmychill.com"]);

// Every page address with at least one impression in the window (all pages of results).
async function shownPages(token, env, from, to, fetchImpl = fetch) {
  for (const site of sitesOf(env)) {
    const seen = new Set(); let ok = true;
    for (let startRow = 0; ; startRow += 25000) {
      const r = await fetchImpl(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ startDate: from, endDate: to, dimensions: ["page"], rowLimit: 25000, startRow, dataState: "all" }),
      });
      const j = await r.json();
      if (j.error) { ok = false; break; }
      const rows = j.rows || [];
      for (const x of rows) if (x.impressions > 0) seen.add(x.keys[0]);
      if (rows.length < 25000) break;
    }
    if (ok) return { site, seen };
  }
  return null;
}

// Pure: the hide list from the page records and the set of pages Google showed.
function rollList(manifest, shown, nowMs = Date.now(), { facts = (code, slug) => G.factsOf(code, slug) } = {}) {
  const pages = {};
  for (const [code, list] of Object.entries(manifest || {})) {
    if (!list || typeof list !== "object") continue;
    for (const [slug, e] of Object.entries(list)) {
      if (!e || typeof e !== "object") continue;
      const url = `${B}${code === "in" ? "" : `${code}/`}movie/${slug}.html`;
      if (shown.has(url)) continue;
      // A current title (a season airing, a recent release or arrival) is never listed, whatever
      // Google showed (lib/googlehide.js currentEntry, 31 Oct 2026).
      if (G.currentEntry(e, facts(code, slug), iso(nowMs))) continue;
      if (!e.catalog) {
        const rel = Date.parse(`${String(e.released || "").slice(0, 10)}T00:00:00Z`);
        if (!Number.isFinite(rel) || (nowMs - rel) / 864e5 <= G.WEEKLY_HIDE_DAYS) continue;
      }
      (pages[code] = pages[code] || []).push(slug);
    }
  }
  for (const k of Object.keys(pages)) pages[k].sort();
  return pages;
}

async function rollHiddenList({ manifest, env = process.env, nowMs = Date.now(), file = G.HIDE_FILE, force = false, fetchImpl = fetch } = {}) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none yet */ }
  const last = Date.parse(`${cur.rolled || cur.to || "1970-01-01"}T00:00:00Z`);
  if (!force && (nowMs - last) / 864e5 < ROLL_DAYS) return { rolled: false, why: `rolled ${cur.rolled || cur.to}; next after ${ROLL_DAYS} days` };
  const token = await gscToken(env);
  if (!token) return { rolled: false, why: "no Search Console access" };
  const to = iso(nowMs - 3 * 864e5), from = iso(nowMs - (WINDOW_DAYS + 2) * 864e5);
  const got = await shownPages(token, env, from, to, fetchImpl);
  if (!got) return { rolled: false, why: "Search Console query failed" };
  const before = cur.pagesWithImpressions || 0;
  if (before && got.seen.size < before * 0.5) return { rolled: false, why: `only ${got.seen.size} shown pages (last time ${before}): looks like missing data, kept the current list` };
  const pages = rollList(manifest, got.seen, nowMs);
  const total = Object.values(pages).reduce((n, xs) => n + xs.length, 0);
  const prev = new Set(); for (const [c, xs] of Object.entries(cur.pages || {})) for (const s of xs) prev.add(`${c}/${s}`);
  const next = new Set(); for (const [c, xs] of Object.entries(pages)) for (const s of xs) next.add(`${c}/${s}`);
  const added = [...next].filter((k) => !prev.has(k)).length, removed = [...prev].filter((k) => !next.has(k)).length;
  const out = { ...cur, pages, total, from, to, rolled: iso(nowMs), pagesWithImpressions: got.seen.size,
    _about: `Pages hidden from Google only (googlebot noindex, out of the sitemaps and of links from visible pages; Bing keeps them via sitemap-bing.xml). Recomputed every ${ROLL_DAYS} days by lib/keeplean.js: no Search Console impression in ${WINDOW_DAYS} days, and a catalogue page (any age) or a weekly-list page over ${G.WEEKLY_HIDE_DAYS} days old. "paths": actor pages, kept for the record (every people page is hidden by rule).` };
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  G.useHiddenList(null);   // the passes below read the new list
  return { rolled: true, total, added, removed, shown: got.seen.size };
}

// ---- weekly health ----------------------------------------------------------------------------
const NOI = /<meta name="googlebot" content="noindex">|<meta name="robots" content="[^"]*noindex/;

// Pure-ish: link numbers from the pages on disk.
function linkHealth({ root = ".", manifest = {}, nowMs = Date.now() } = {}) {
  const { filmPageFiles, sitePageFiles } = require("./stylesheets.js");
  const files = [...filmPageFiles(root), ...sitePageFiles(root)];
  const hidden = new Set(), exists = new Set(), visible = new Map();
  for (const rel of files) {
    const u = "/" + String(rel).replace(/\\/g, "/").replace(/index\.html$/, "");
    exists.add(u);
    let h; try { h = fs.readFileSync(path.join(root, rel), "utf8"); } catch { continue; }
    // A merge redirect stub (lib/merges.js) is an address, not a page: neither visible nor hidden,
    // so it isn't counted as unlinked (the 28 Oct 2026 audit found 32 of them among the "orphans").
    if (h.includes("<!--FC:merged-->")) { exists.delete(u); continue; }
    if (NOI.test(h.slice(0, 4096))) hidden.add(u); else visible.set(u, h);
  }
  const inbound = new Map(); let links = 0, toHidden = 0;
  for (const [u, h] of visible) {
    const seen = new Set();
    for (const m of h.matchAll(/<a\b[^>]*href="([^"#?]+)/g)) {
      let l = m[1]; if (l.startsWith(B)) l = "/" + l.slice(B.length);
      if (!l.startsWith("/") || l === u || seen.has(l) || !exists.has(l)) continue;
      seen.add(l); links++; if (hidden.has(l)) toHidden++;
      inbound.set(l, (inbound.get(l) || 0) + 1);
    }
  }
  const offered = [];
  for (const f of fs.readdirSync(root).filter((x) => /^sitemap-(?!bing).*\.xml$/.test(x))) {
    for (const m of fs.readFileSync(path.join(root, f), "utf8").matchAll(/<url><loc>([^<]+)<\/loc>/g)) offered.push("/" + m[1].slice(B.length));
  }
  const offeredSet = new Set(offered);
  const orphans = [...offeredSet].filter((u) => !inbound.get(u));
  let freshWeak = 0;
  for (const u of offeredSet) {
    const m = /^\/(?:([a-z]{2})\/)?movie\/([^/]+)\.html$/.exec(u); if (!m) continue;
    const e = ((manifest[m[1] || "in"] || {})[m[2]]) || {};
    const t = Date.parse(`${String(e.released || "").slice(0, 10)}T00:00:00Z`);
    if (Number.isFinite(t) && (nowMs - t) / 864e5 <= 60 && (inbound.get(u) || 0) < 3) freshWeak++;
  }
  return { offered: offeredSet.size, visiblePages: visible.size, hiddenPages: hidden.size, links, toHidden,
    toHiddenShare: links ? toHidden / links : 0, orphans: orphans.length, orphanSample: orphans.slice(0, 5), freshWeak, offeredList: [...offeredSet] };
}

// ---- repeated sentences and thin pages (27 Oct 2026 review) -----------------------------------
// The main content of a film page — from the answer to the end of the FAQ, never the footer or
// the vote widget — as sentences, each with the page's own title, language, genres and numbers
// replaced, so "Jaat is a solid, watchable Hindi film…" and "Dhoom is a solid, watchable Hindi
// film…" count as one pattern. A pattern on more than REPEAT_SHARE of pages is template text.
const REPEAT_SHARE = 0.05;
const WIDGET = /Watched it\?|Was it worth it|Your vote|No sign-up|^Worth it$|^Not worth it$/i;
function mainSentences(html) {
  const s = String(html);
  const from = Math.max(0, s.indexOf('class="anscard"') >= 0 ? s.indexOf('class="anscard"') : s.indexOf('class="answer"'));
  let to = s.indexOf('<a class="btn"', from); if (to < 0) to = s.indexOf("<footer", from); if (to < 0) to = s.length;
  const body = s.slice(from, to).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ");
  const ld = (/"inLanguage":"([^"]+)"/.exec(s) || [])[1] || "";
  const genres = ((/"genre":"([^"]+)"/.exec(s) || [])[1] || "").split(/\s*\/\s*|\s*&amp;\s*|\s*&\s*/).filter((g) => g.length > 2);
  const title = ((/"name":"([^"]+)"/.exec(s) || [])[1] || "").replace(/&amp;/g, "&");
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocks = [...body.matchAll(/<(p|dd|summary|li|td)\b[^>]*>([\s\S]*?)<\/\1>|<div class="fa">([\s\S]*?)<\/div>/g)].map((m) => m[2] || m[3] || "");
  const out = [];
  for (const b of blocks) {
    const text = b.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ").trim();
    for (const sent of text.split(/(?<=[.?!])\s+/)) {
      if (sent.length < 25 || WIDGET.test(sent)) continue;
      let p = sent;
      // The title as whole words only ("Film T" must not eat the "film t" in "film that").
      if (title) p = p.replace(new RegExp(`(^|[^\\w])${esc(title)}(?=[^\\w]|$)`, "gi"), "$1«T»");
      if (ld) p = p.replace(new RegExp(`\\b${esc(ld)}\\b`, "g"), "«L»");
      for (const g of genres) p = p.replace(new RegExp(`\\b${esc(g)}\\b`, "gi"), "«G»");
      p = p.replace(/\d[\d,.]*/g, "«N»").replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/g, "«M»");
      out.push({ pattern: p, words: sent.split(" ").length });
    }
  }
  return out;
}
// Over a sample of visible film pages: the patterns on more than REPEAT_SHARE of them, and the
// pages left with under THIN_WORDS words once those are set aside (recorded, never padded).
const THIN_WORDS = 150;
function contentRepetition(files, { root = ".", sample = 1500 } = {}) {
  const pages = [];
  const pick = files.length > sample ? files.filter((_, i) => i % Math.ceil(files.length / sample) === 0) : files;
  for (const rel of pick) {
    let h; try { h = fs.readFileSync(path.join(root, rel), "utf8"); } catch { continue; }
    if (NOI.test(h.slice(0, 4096))) continue;
    pages.push({ rel, sents: mainSentences(h) });
  }
  const seen = new Map();
  for (const p of pages) for (const pat of new Set(p.sents.map((x) => x.pattern))) seen.set(pat, (seen.get(pat) || 0) + 1);
  const n = pages.length || 1;
  const repeated = [...seen].filter(([, c]) => c / n > REPEAT_SHARE).sort((a, b) => b[1] - a[1]);
  const rep = new Set(repeated.map(([p]) => p));
  const thin = pages.filter((p) => p.sents.filter((x) => !rep.has(x.pattern)).reduce((w, x) => w + x.words, 0) < THIN_WORDS);
  return { sampled: pages.length, patterns: repeated.slice(0, 15).map(([p, c]) => ({ pattern: p, share: Math.round((c / n) * 1000) / 1000 })),
    repeatedCount: repeated.length, thinShare: Math.round((thin.length / n) * 1000) / 1000, thinSample: thin.slice(0, 5).map((p) => p.rel) };
}

// Pure: alarms from this week's record and last week's.
function healthAlarms(cur, prev) {
  const a = [];
  if (cur.toHiddenShare > 0.15) a.push(`${Math.round(cur.toHiddenShare * 100)}% of internal links on pages Google sees point at hidden pages (alarm over 15%)`);
  if (cur.freshWeak > 0) a.push(`${cur.freshWeak} new title(s) with fewer than 3 links in`);
  if (cur.orphans > 100) a.push(`${cur.orphans} pages offered to Google have no internal link in (alarm over 100)`);
  if (prev && prev.offered && cur.offered > prev.offered * 1.2) a.push(`pages offered to Google jumped ${Math.round((cur.offered / prev.offered - 1) * 100)}% in a week (${prev.offered} → ${cur.offered})`);
  if (prev && prev.indexedShare != null && cur.indexedShare != null && prev.prevIndexedFell && cur.indexedShare < prev.indexedShare) a.push(`indexed share fell two weeks running (${Math.round(prev.indexedShare * 100)}% → ${Math.round(cur.indexedShare * 100)}%)`);
  // A NEW template sentence spreading (the known ones are recorded for the 4 Nov review, not alarmed weekly).
  if (cur.repetition && prev && prev.repetition) {
    const before = new Set((prev.repetition.patterns || []).map((x) => x.pattern));
    const fresh = (cur.repetition.patterns || []).filter((x) => !before.has(x.pattern));
    if (cur.repetition.repeatedCount > prev.repetition.repeatedCount && fresh.length) a.push(`a new sentence pattern is on ${Math.round(fresh[0].share * 100)}% of film pages: "${fresh[0].pattern.slice(0, 90)}"`);
  }
  return a;
}

async function weeklyHealth({ manifest, env = process.env, nowMs = Date.now(), root = ".", file = HEALTH_FILE, force = false, fetchImpl = fetch } = {}) {
  let hist = { runs: [] };
  try { hist = JSON.parse(fs.readFileSync(path.join(root, file), "utf8")); } catch { /* first run */ }
  const prev = hist.runs[hist.runs.length - 1];
  if (!force && prev && (nowMs - Date.parse(`${prev.date}T00:00:00Z`)) / 864e5 < HEALTH_EVERY_DAYS) return { ran: false, why: `last report ${prev.date}` };
  const lh = linkHealth({ root, manifest, nowMs });
  const rec = { date: iso(nowMs), offered: lh.offered, visiblePages: lh.visiblePages, hiddenPages: lh.hiddenPages,
    toHiddenShare: Math.round(lh.toHiddenShare * 1000) / 1000, orphans: lh.orphans, freshWeak: lh.freshWeak, indexedShare: null, sampled: 0 };
  // Indexed share: a random sample of the pages offered, through URL Inspection.
  const token = await gscToken(env);
  if (token && lh.offeredList.length) {
    const pick = lh.offeredList.map((u) => [Math.random(), u]).sort((x, y) => x[0] - y[0]).slice(0, SAMPLE).map((x) => x[1]);
    let indexed = 0, n = 0;
    for (const u of pick) {
      try {
        const r = await fetchImpl("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ inspectionUrl: B + u.slice(1), siteUrl: sitesOf(env)[0] }),
        });
        const j = await r.json(); const st = j.inspectionResult && j.inspectionResult.indexStatusResult.coverageState;
        if (!st) continue; n++; if (/indexed/i.test(st) && !/not indexed/i.test(st)) indexed++;
      } catch { /* skip one */ }
    }
    if (n) { rec.indexedShare = Math.round((indexed / n) * 1000) / 1000; rec.sampled = n; }
  }
  rec.prevIndexedFell = !!(prev && prev.indexedShare != null && rec.indexedShare != null && rec.indexedShare < prev.indexedShare);
  try {
    const { filmPageFiles } = require("./stylesheets.js");
    rec.repetition = contentRepetition(filmPageFiles(root), { root });
  } catch { /* the report goes on without it */ }
  const alarms = healthAlarms(rec, prev);
  rec.alarms = alarms;
  hist.runs = [...hist.runs, rec].slice(-26);
  fs.writeFileSync(path.join(root, file), JSON.stringify(hist, null, 1) + "\n");
  return { ran: true, rec, alarms };
}

function healthLine(rec) {
  return `Site health (${rec.date}): ${rec.offered} pages offered to Google, ${rec.indexedShare == null ? "indexed share not sampled" : `${Math.round(rec.indexedShare * 100)}% indexed (sample of ${rec.sampled})`}, ${Math.round(rec.toHiddenShare * 100)}% of links to hidden pages, ${rec.orphans} unlinked, ${rec.freshWeak} new title(s) under 3 links`;
}

module.exports = { HEALTH_FILE, REPEAT_SHARE, ROLL_DAYS, THIN_WORDS, WINDOW_DAYS, contentRepetition, healthAlarms, healthLine, linkHealth, mainSentences, rollHiddenList, rollList, weeklyHealth };
