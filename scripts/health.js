// FilmyChill run-health check — turns silent failures into a red run.
//
// update.js records every stage that failed (and was skipped so the rest of the site could
// still ship) in run-health.json. This script runs LAST in the workflow, after the site has
// been committed and deployed, so a problem never blocks a good update. It:
//   - writes a summary table to the run page (Actions -> the run -> Summary)
//   - marks each issue/note as an annotation on the run
//   - exits 1 when there is any issue, which makes the run red and makes GitHub email you
//
// Usage: node scripts/health.js [path-to-run-health.json]
"use strict";
const fs = require("fs");

const file = process.argv[2] || "run-health.json";
let h;
try { h = JSON.parse(fs.readFileSync(file, "utf8")); }
catch (e) {
  console.log(`::error::run-health.json missing or unreadable (${e.message}) — the build did not finish normally`);
  process.exit(1);
}
const issues = Array.isArray(h.issues) ? h.issues : [];
const notes = Array.isArray(h.notes) ? h.notes : [];

// Broken internal links across the built site. Found 30 by hand on 28 Sept 2026 (month
// archives linking hubs that didn't exist); this makes the next one show up on its own.
// A note, not an issue: a dead link is worth fixing, not worth a red run.
const broken = brokenInternalLinks(process.env.HEALTH_SITE_ROOT || ".");
if (broken.count) {
  notes.push(`${broken.count} broken internal link(s) on the site, e.g. ${broken.examples.map((x) => `${x.from} → /${x.to}`).join("; ")}`);
}
const catalog = h.catalog || {};

// GitHub annotations must be single-line.
const one = (s) => String(s).replace(/[\r\n]+/g, " ");
for (const i of issues) console.log(`::error title=FilmyChill build::${one(i)}`);
for (const n of notes) console.log(`::warning title=FilmyChill build::${one(n)}`);

const lines = [];
lines.push(`## FilmyChill build health: ${issues.length ? "❌ " + issues.length + " issue(s)" : "✅ healthy"}`);
if (issues.length) { lines.push("", "### Issues", ...issues.map((i) => `- ${i}`)); }
if (notes.length) { lines.push("", "### Notes", ...notes.map((n) => `- ${n}`)); }
const codes = Object.keys(catalog);
if (codes.length) {
  lines.push("", "### Back-catalogue pages built this run", "",
    `| ${codes.join(" | ")} |`, `|${codes.map(() => "---").join("|")}|`,
    `| ${codes.map((c) => (catalog[c] == null ? "–" : catalog[c])).join(" | ")} |`);
}
const md = lines.join("\n") + "\n";
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);

process.exit(issues.length ? 1 : 0);

function brokenInternalLinks(root) {
  const path = require("path");
  const SKIP = new Set([".git", ".github", "scripts", "node_modules", "zz", "cloudflare", "_site"]);
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith(".html")) files.push(p);
    }
  })(root);
  const exists = new Map();
  const has = (p) => { if (!exists.has(p)) exists.set(p, fs.existsSync(path.join(root, p))); return exists.get(p); };
  let count = 0; const examples = []; const seen = new Set();
  for (const f of files) {
    const html = fs.readFileSync(f, "utf8");
    for (const m of html.matchAll(/href="([^"]+)"/g)) {
      let href = m[1].split("#")[0].split("?")[0];
      if (href.startsWith("https://filmychill.com")) href = href.slice("https://filmychill.com".length);
      if (!href.startsWith("/") || href.startsWith("//")) continue;
      let p = href.slice(1);
      if (p === "" || p.endsWith("/")) p += "index.html";
      if (has(p) || seen.has(p)) continue;
      seen.add(p); count++;
      if (examples.length < 5) examples.push({ from: path.relative(root, f), to: p });
    }
  }
  return { count, examples };
}

