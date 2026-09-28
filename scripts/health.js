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
