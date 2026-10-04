#!/usr/bin/env node
// ============================================================================
// livecheck.js — after a deploy, check what visitors actually get (Oct 2026).
//
// Every other check in this repo inspects files on disk. On 4 Oct 2026 the disk was fine and
// the site wasn't: the build moved film-page CSS into /css/, the commit step never staged the
// folder, and all 11,151 film pages linked stylesheets that returned 404 for about five hours.
// Nothing went red. This runs last in the workflow and asks the live site:
//   1. Has this build landed? (live homepage byte-identical to the committed index.html)
//   2. Does EVERY stylesheet the committed film pages link come back as CSS?
//   3. Do sample film pages load — this week's picks and a few from the archive?
//   4. Are the homepage's own assets and the files crawlers read there?
//   5. Does a page that doesn't exist still return a real 404?
// Any failure exits 1, so the run goes red and GitHub emails. Every request carries a
// cache-busting query, so a CDN's stale copy can neither hide a problem nor fake one.
// ============================================================================
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASE = (process.env.LIVECHECK_BASE || "https://filmychill.com").replace(/\/$/, "");
const WAIT_MS = Number(process.env.LIVECHECK_WAIT_MS || 10 * 60 * 1000);
const POLL_MS = Number(process.env.LIVECHECK_POLL_MS || 20 * 1000);
const SAMPLE_PAGES = 3;

const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");

// Pure: every distinct /css/fp-*.css the given pages link, sorted.
function stylesheetsLinked(htmls) {
  const out = new Set();
  for (const h of htmls) {
    for (const m of String(h).matchAll(/<link rel="stylesheet" href="(\/css\/fp-[0-9a-f]{10}\.css)">/g)) out.add(m[1]);
  }
  return [...out].sort();
}

// Pure: same-origin files the homepage head asks for (preloaded fonts, manifest, icons).
function homepageAssets(html) {
  const out = new Set();
  for (const m of String(html).matchAll(/<link rel="(?:preload|manifest|icon|apple-touch-icon)"[^>]*href="(\/[^"/][^"]*)"/g)) out.add(m[1]);
  return [...out].sort();
}

// Every committed film page as a site path: /movie/x.html, /ae/movie/x.html, ...
function filmPagePaths(root = ".") {
  const out = [];
  const add = (dir, prefix) => {
    let names;
    try { names = fs.readdirSync(path.join(root, dir)); } catch { return; }
    for (const n of names.sort()) if (n.endsWith(".html")) out.push(`${prefix}/${n}`);
  };
  add("movie", "/movie");
  let tops = [];
  try { tops = fs.readdirSync(root); } catch { /* none */ }
  for (const t of tops.sort()) if (/^[a-z]{2}$/.test(t)) add(`${t}/movie`, `/${t}/movie`);
  return out;
}

// Pure: this week's India picks plus `n` archive pages chosen from a seed (the day, so a
// rerun checks the same pages), never repeating a page.
function sampleFilmPaths(all, picks = [], n = SAMPLE_PAGES, seed = 1) {
  const out = [...new Set(picks.filter((p) => all.includes(p)))];
  let x = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  for (let tries = 0; out.length < picks.length + n && tries < n * 20 && all.length; tries++) {
    x = (x * 16807) % 2147483647;
    const p = all[x % all.length];
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

// One request. Resolves with what's wrong (if anything) — never throws.
async function fetchCheck(fetchImpl, url, { expect = 200, type = null, minBytes = 1 } = {}) {
  const busted = `${url}${url.includes("?") ? "&" : "?"}livecheck=${Date.now()}`;
  try {
    const res = await fetchImpl(busted, { redirect: "manual", headers: { "user-agent": "FilmyChill-livecheck/1.0" } });
    const body = await res.text();
    const ct = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
    const problems = [];
    if (res.status !== expect) problems.push(`HTTP ${res.status}, expected ${expect}`);
    else if (expect === 200) {
      if (type && !ct.includes(type)) problems.push(`content-type "${ct || "none"}", expected ${type}`);
      if (body.length < minBytes) problems.push(`only ${body.length} bytes`);
    }
    return { url, ok: !problems.length, problems, body, status: res.status };
  } catch (e) {
    return { url, ok: false, problems: [`request failed: ${e.message}`], body: "", status: 0 };
  }
}

// Polls until the live homepage is byte-identical to the committed one, or time runs out.
async function waitForDeploy(fetchImpl, localHome, { base = BASE, waitMs = WAIT_MS, pollMs = POLL_MS, sleep } = {}) {
  const want = sha1(localHome);
  const deadline = Date.now() + waitMs;
  let polls = 0, last = null;
  for (;;) {
    polls++;
    last = await fetchCheck(fetchImpl, `${base}/`, { type: "text/html" });
    if (last.ok && sha1(last.body) === want) return { landed: true, polls, last };
    if (Date.now() + pollMs > deadline) return { landed: false, polls, last };
    await sleep(pollMs);
  }
}

async function main({
  root = ".", base = BASE, fetchImpl = globalThis.fetch, waitMs = WAIT_MS, pollMs = POLL_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, now = Date.now(),
} = {}) {
  const failures = [];
  const passes = [];
  const check = async (label, url, opts) => {
    const r = await fetchCheck(fetchImpl, url, opts);
    if (r.ok) passes.push(label); else failures.push(`${label}: ${r.problems.join("; ")}`);
    return r;
  };

  const localHome = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const deploy = await waitForDeploy(fetchImpl, localHome, { base, waitMs, pollMs, sleep });
  if (!deploy.landed) {
    const why = deploy.last && !deploy.last.ok ? deploy.last.problems.join("; ") : "it still serves the previous version";
    failures.push(`this build isn't live after ${Math.round(waitMs / 60000)} min (homepage: ${why}) — check the Pages / Cloudflare deployment`);
  } else {
    passes.push(`homepage serves this build (after ${deploy.polls} check${deploy.polls === 1 ? "" : "s"})`);

    const pages = filmPagePaths(root);
    const htmls = pages.map((p) => { try { return fs.readFileSync(path.join(root, p), "utf8"); } catch { return ""; } });
    for (const sheet of stylesheetsLinked(htmls)) await check(sheet, `${base}${sheet}`, { type: "text/css", minBytes: 100 });

    let picks = [];
    try {
      const d = JSON.parse(fs.readFileSync(path.join(root, "data.json"), "utf8"));
      picks = [d.theatres && d.theatres[0], d.ott && d.ott[0]].filter((x) => x && x.slug).map((x) => `/movie/${x.slug}.html`);
    } catch { /* no data file: archive samples only */ }
    for (const p of sampleFilmPaths(pages, picks, SAMPLE_PAGES, Math.floor(now / 864e5))) {
      await check(p, `${base}${p}`, { type: "text/html", minBytes: 1000 });
    }

    for (const asset of homepageAssets(localHome)) await check(asset, `${base}${asset}`);
    for (const [p, type] of [["/robots.txt", "text/plain"], ["/sitemap.xml", "xml"], ["/llms.txt", "text/plain"],
      ["/favicon.ico", "image/"], ["/data/", "text/html"]]) {
      await check(p, `${base}${p}`, { type });
    }
    await check("a missing page returns 404", `${base}/livecheck-missing-${now}.html`, { expect: 404 });
  }

  log(`Live site check (${base}): ${passes.length} passed, ${failures.length} failed`);
  for (const f of failures) log(`  ✗ ${f}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [`## Live site check — ${failures.length ? "❌ failed" : "✅ passed"}`, "",
      `${passes.length} checks passed against ${base}.`, "",
      ...failures.map((f) => `- ❌ ${f}`)].join("\n");
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch { /* summary is a nicety */ }
  }
  return { failures, passes };
}

if (require.main === module) {
  main().then(({ failures }) => { if (failures.length) process.exit(1); })
    .catch((e) => { console.error(`Live site check crashed: ${e.stack || e.message}`); process.exit(1); });
}

module.exports = { fetchCheck, filmPagePaths, homepageAssets, main, sampleFilmPaths, stylesheetsLinked, waitForDeploy };
