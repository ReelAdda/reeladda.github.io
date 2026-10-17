#!/usr/bin/env node
// ============================================================================
// accuracy.js — film pages checked against TMDB, the site's source (Oct 2026).
//
// Every other check reads the site against itself. This asks TMDB, for a sample of film pages
// in every edition, what the page should say today, and lists each disagreement:
//   streaming    page lists no platform but TMDB has one (or the reverse); a platform TMDB
//                doesn't list for that country; rent/buy present on one side only
//   release      the page's date isn't any date TMDB gives for that country, nor the film's
//   language, kind, runtime (±5 min), director, lead actor, title, genres
// Read-only: it changes nothing, commits nothing, and never fails the run (a TMDB error skips
// the page). Run from GitHub Actions (data-accuracy.yml), where TMDB_API_KEY is a secret.
//   ACCURACY_PER_EDITION  pages per edition (default 14: ~250 pages, ~250 TMDB calls)
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { COUNTRIES } = require("./lib/core.js");
const { extractFacts, STATUS_PILL } = require("./lib/facts.js");
const { canonProvider, dedupeProviders, langName, looksLikeOutage } = require("./lib/rules.js");

const SITE = "https://filmychill.com";
const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").trim();
const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
// The same person written two ways: "Lasja F. Susatyo" and "Lasja Fauzia Susatyo" (same first and
// last name, middle names agreeing on their initials).
function sameName(a, b) {
  const x = norm(a).split(" "), y = norm(b).split(" ");
  if (x.join(" ") === y.join(" ")) return true;
  if (x.length < 2 || y.length < 2 || x[0] !== y[0] || x[x.length - 1] !== y[y.length - 1]) return false;
  const mx = x.slice(1, -1), my = y.slice(1, -1);
  return mx.length === my.length && mx.every((t, i) => t[0] === my[i][0]);
}

// Pure: the sample. Per edition, up to `per` facts-rendered pages with a TMDB id: a third that
// still say "not streaming yet" (the ones most likely to have gone stale), the rest spread
// evenly over the edition's slugs. Stable for a given day, so a rerun checks the same pages.
function samplePages(manifest, { per = 14, exists = () => true, isPending = () => false, seed = 1 } = {}) {
  const out = [];
  for (const c of COUNTRIES) {
    const m = (manifest && manifest[c.code]) || {};
    const slugs = Object.keys(m).filter((s) => m[s] && m[s].tmdbId && m[s].rendered && exists(c.code, s)).sort();
    if (!slugs.length) continue;
    const pending = slugs.filter((s) => isPending(c.code, s));
    const pick = (arr, n, offset) => { const r = []; if (!arr.length) return r; const step = Math.max(1, Math.floor(arr.length / n)); for (let i = offset % step; i < arr.length && r.length < n; i += step) r.push(arr[i]); return r; };
    const chosen = new Set(pick(pending, Math.ceil(per / 3), seed));
    for (const s of pick(slugs, per, seed + 7)) { if (chosen.size >= per) break; chosen.add(s); }
    for (const s of chosen) out.push({ code: c.code, slug: s, kind: m[s].kind === "tv" ? "tv" : "movie", tmdbId: m[s].tmdbId });
  }
  return out;
}

// Pure: what TMDB says a page in this country should show. `d` is /movie|tv/{id} with
// watch/providers, release_dates (movies), credits (movies) / aggregate credits (series).
function expectedFromTmdb(d, kind, cfg) {
  const region = cfg.watchRegion || cfg.region;
  const wp = (d && d["watch/providers"] && d["watch/providers"].results && d["watch/providers"].results[region]) || {};
  const flat = dedupeProviders((wp.flatrate || []).map((p) => p.provider_name)).slice(0, 4);
  const rentBuy = dedupeProviders([...(wp.rent || []), ...(wp.buy || [])].map((p) => p.provider_name));
  const dates = new Set();
  const primary = String((kind === "tv" ? d.first_air_date : d.release_date) || "").slice(0, 10);
  if (primary) dates.add(primary);
  const local = ((d.release_dates && d.release_dates.results) || []).find((r) => r.iso_3166_1 === cfg.region);
  for (const x of (local && local.release_dates) || []) if (x.release_date) dates.add(String(x.release_date).slice(0, 10));
  const crew = (d.credits && d.credits.crew) || [];
  const directors = kind === "tv" ? (d.created_by || []).map((x) => x.name) : crew.filter((x) => x.job === "Director").map((x) => x.name);
  const cast = ((kind === "tv" ? d.aggregate_credits && d.aggregate_credits.cast : d.credits && d.credits.cast) || []).map((x) => x.name);
  const runtime = kind === "tv" ? ((d.episode_run_time || [])[0] || null) : (d.runtime || null);
  return {
    title: kind === "tv" ? d.name : d.title, original: kind === "tv" ? d.original_name : d.original_title,
    language: langName(d.original_language), genres: (d.genres || []).map((g) => g.name),
    dates: [...dates], primary, runtime, directors, cast, flat, rentBuy,
  };
}

// Pure: the disagreements between a page's facts and TMDB's, as [{ field, severity, page, tmdb }].
function compare(item, exp) {
  const out = [];
  const add = (field, severity, page, tmdb) => out.push({ field, severity, page: String(page), tmdb: String(tmdb) });
  const pageFlat = (item.providers || []).filter((p) => !STATUS_PILL.test(p));
  const has = (list, p) => list.some((x) => canonProvider(x).toLowerCase() === canonProvider(p).toLowerCase());
  if (!pageFlat.length && exp.flat.length) add("streaming", "high", "not streaming", `on ${exp.flat.join(", ")}`);
  else if (pageFlat.length && !exp.flat.length) add("streaming", "high", `on ${pageFlat.join(", ")}`, exp.rentBuy.length ? "rent/buy only" : "on no subscription service");
  else {
    const extra = pageFlat.filter((p) => !has(exp.flat, p));
    if (extra.length) add("platform", "high", pageFlat.join(", "), exp.flat.join(", "));
  }
  if (!!(item.rentBuy || []).length !== !!exp.rentBuy.length && (pageFlat.length || exp.flat.length) === 0) add("rent/buy", "medium", (item.rentBuy || []).join(", ") || "none", exp.rentBuy.join(", ") || "none");
  if (item.released && exp.dates.length && !exp.dates.some((d) => days(d, item.released) <= 1)) add("release date", days(exp.dates.sort()[0], item.released) > 7 ? "high" : "medium", item.released, exp.dates.sort().join(" / "));
  if (item.language && exp.language && norm(item.language) !== norm(exp.language)) add("language", "high", item.language, exp.language);
  if (item.runtime && exp.runtime && Math.abs(item.runtime - exp.runtime) > 5) add("runtime", "medium", `${item.runtime} min`, `${exp.runtime} min`);
  if (item.director && exp.directors.length && !item.director.split(", ").some((x) => exp.directors.some((y) => sameName(x, y)))) add("director", "medium", item.director, exp.directors.join(", "));
  const lead = (item.cast || [])[0];
  if (lead && exp.cast.length && !exp.cast.some((x) => sameName(x, lead))) add("lead actor", "medium", lead, exp.cast.slice(0, 3).join(", "));
  if (item.title && exp.title && norm(item.title) !== norm(exp.title) && norm(item.title) !== norm(exp.original)) add("title", "low", item.title, exp.title);
  const pageGenres = String(item.genre || "").split(" / ").filter(Boolean);
  if (pageGenres.length && exp.genres.length && !pageGenres.every((g) => exp.genres.some((x) => norm(x) === norm(g) || norm(x).includes(norm(g)) || norm(g).includes(norm(x))))) add("genres", "low", pageGenres.join(" / "), exp.genres.join(", "));
  return out;
}

function report(rows, { checked, errors, per, at }) {
  const fields = ["streaming", "platform", "rent/buy", "release date", "language", "runtime", "director", "lead actor", "title", "genres"];
  const byField = Object.fromEntries(fields.map((f) => [f, 0]));
  const byEd = {};
  for (const r of rows) { byField[r.field]++; byEd[r.code] = (byEd[r.code] || 0) + 1; }
  const pagesWith = new Set(rows.map((r) => `${r.code}/${r.slug}`)).size;
  const high = rows.filter((r) => r.severity === "high");
  const url = (r) => `${SITE}/${r.code === "in" ? "" : r.code + "/"}movie/${r.slug}.html`;
  const line = (r) => `| ${r.severity} | [${r.code}/${r.slug}](${url(r)}) | ${r.field} | ${r.page.replace(/\|/g, "/")} | ${r.tmdb.replace(/\|/g, "/")} |`;
  return [
    `## Data accuracy check — ${at}`, "",
    `${checked} film pages compared with TMDB (${per} per edition, a third of them "not streaming yet"); ${errors} skipped on a TMDB error.`,
    `**${pagesWith} page(s) disagree with TMDB on at least one fact; ${high.length} high-severity finding(s).**`, "",
    "| Check | Disagreements |", "|---|---|", ...fields.map((f) => `| ${f} | ${byField[f]} |`), "",
    `By edition: ${Object.entries(byEd).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`, "",
    rows.length ? "| Severity | Page | Field | Page says | TMDB says |" : "No disagreements.", rows.length ? "|---|---|---|---|---|" : "",
    ...rows.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : b.severity === "high" ? 1 : a.severity === "medium" ? -1 : 1)).slice(0, 300).map(line),
    rows.length > 300 ? `\n…and ${rows.length - 300} more.` : "",
    "", "TMDB's streaming data comes from JustWatch and can trail a release by a few days, so a 'streaming' disagreement on a film that arrived this week may be TMDB catching up, not the page.",
  ].join("\n");
}

async function main({ root = ".", per = Number(process.env.ACCURACY_PER_EDITION || 14), api = null, now = new Date(), log = console.log } = {}) {
  if (!api) {
    if (!process.env.TMDB_API_KEY) { log("accuracy: no TMDB_API_KEY — nothing to check"); return { rows: [], checked: 0, errors: 0 }; }
    const t = require("./lib/tmdb.js");
    api = { tmdb: t.tmdb, pause: t.sleep };
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "pages-manifest.json"), "utf8"));
  const file = (code, slug) => path.join(root, code === "in" ? "movie" : `${code}/movie`, `${slug}.html`);
  const exists = (code, slug) => fs.existsSync(file(code, slug));
  const isPending = (code, slug) => { try { return fs.readFileSync(file(code, slug), "utf8").includes("<!--SW:pending-->"); } catch { return false; } };
  const sample = samplePages(manifest, { per, exists, isPending, seed: Math.floor(now.getTime() / 864e5) });
  const rows = [];
  let checked = 0, errors = 0;
  for (const s of sample) {
    const cfg = COUNTRIES.find((c) => c.code === s.code);
    let d;
    try {
      d = await api.tmdb(`/${s.kind}/${s.tmdbId}`, { append_to_response: s.kind === "tv" ? "watch/providers,aggregate_credits" : "watch/providers,release_dates,credits" });
      await api.pause(120);
    } catch (e) { errors++; continue; }
    const item = extractFacts(fs.readFileSync(file(s.code, s.slug), "utf8"), s.slug);
    if (!item) continue;
    checked++;
    for (const r of compare(item, expectedFromTmdb(d, s.kind, cfg))) rows.push({ ...r, code: s.code, slug: s.slug });
  }
  const md = report(rows, { checked, errors, per, at: now.toISOString().slice(0, 16).replace("T", " ") + " UTC" });
  if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch { /* summary is a nicety */ } }
  fs.writeFileSync(path.join(root, "accuracy-report.md"), md + "\n");
  log(md);
  return { rows, checked, errors };
}

// The daily build's pass (scripts/update.js): a smaller sample each run (a different slice each
// day), measured before anything is corrected; then, for frozen pages, TMDB's facts are recorded
// (lib/truth.js) so the render from facts later in the same run corrects them. Results go to
// accuracy-latest.json (this run's findings) and accuracy-history.jsonl (one line per run), both
// committed, so the trend is in git without anyone copying a summary.
const CORRECTABLE = new Set(["streaming", "platform", "rent/buy", "release date", "title"]);
async function runAccuracyPass(manifest, { root = ".", per = 6, api, now = new Date(), log = console.log } = {}) {
  const { tmdbTruth } = require("./lib/truth.js");
  const today = now.toISOString().slice(0, 10);
  const file = (code, slug) => path.join(root, code === "in" ? "movie" : `${code}/movie`, `${slug}.html`);
  const exists = (code, slug) => fs.existsSync(file(code, slug));
  const isPending = (code, slug) => { try { return fs.readFileSync(file(code, slug), "utf8").includes("<!--SW:pending-->"); } catch { return false; } };
  const sample = samplePages(manifest, { per, exists, isPending, seed: Math.floor(now.getTime() / 864e5) * 13 });
  const rows = [];
  let checked = 0, errors = 0, recorded = 0, liveChecked = 0;
  const emptyClaims = [];
  for (const s of sample) {
    const cfg = COUNTRIES.find((c) => c.code === s.code);
    let d;
    try {
      d = await api.tmdb(`/${s.kind}/${s.tmdbId}`, { append_to_response: s.kind === "tv" ? "watch/providers,aggregate_credits" : "watch/providers,release_dates,credits" });
      await api.pause(120);
    } catch (e) { errors++; continue; }
    const item = extractFacts(fs.readFileSync(file(s.code, s.slug), "utf8"), s.slug);
    if (!item) continue;
    checked++;
    for (const r of compare(item, expectedFromTmdb(d, s.kind, cfg))) rows.push({ ...r, code: s.code, slug: s.slug });
    const e = manifest[s.code] && manifest[s.code][s.slug];
    if (e && e.archivedOn) {
      e.truth = tmdbTruth(d, s.kind, cfg, today); recorded++;
      if (e.live && !(e.truth.providers || []).length) emptyClaims.push(e);
      if (e.live) liveChecked++;
    }
  }
  // A page still claiming a platform that TMDB no longer lists: this check counts as the
  // departure sweep's first empty check, and the confirming one comes next run, not in 30 days.
  // Never on a batch that looks like a provider-data outage (most claims empty at once).
  const outage = looksLikeOutage(liveChecked, emptyClaims.length);
  if (!outage) for (const e of emptyClaims) e.live = { ...e.live, misses: (e.live.misses || 0) + 1, lastCheck: today };
  const byField = {};
  for (const r of rows) byField[r.field] = (byField[r.field] || 0) + 1;
  const pages = new Set(rows.map((r) => `${r.code}/${r.slug}`));
  const summary = { date: today, checked, errors, pagesDisagreeing: pages.size,
    high: rows.filter((r) => r.severity === "high").length,
    correctable: new Set(rows.filter((r) => CORRECTABLE.has(r.field)).map((r) => `${r.code}/${r.slug}`)).size,
    byField };
  fs.writeFileSync(path.join(root, "accuracy-latest.json"), JSON.stringify({ ...summary, rows }, null, 1) + "\n");
  fs.appendFileSync(path.join(root, "accuracy-history.jsonl"), JSON.stringify(summary) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report(rows, { checked, errors, per, at: today }) + "\n"); } catch { /* nicety */ } }
  log(`Accuracy: ${checked} pages compared with TMDB, ${pages.size} disagree (${summary.high} high); ${summary.correctable} correctable now, TMDB facts recorded for ${recorded} frozen page(s)${emptyClaims.length && !outage ? `; ${emptyClaims.length} streaming claim(s) TMDB no longer lists, queued to confirm next run` : ""}`);
  return summary;
}

if (require.main === module) {
  main().catch((e) => { console.error(`accuracy check failed: ${e.stack || e.message}`); process.exit(0); });
}

module.exports = { compare, expectedFromTmdb, main, report, runAccuracyPass, sameName, samplePages };
