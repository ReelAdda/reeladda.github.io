#!/usr/bin/env node
// Plain-wording check before a commit (lib/prosecheck.js). Run by .githooks/pre-commit and by the
// Claude Code hook in ~/.claude/skills/human-prose/hook.js; run it by hand any time:
//   node scripts/prose-check.js              every page state, plus the hand-written pages
//   node scripts/prose-check.js <dir|file>   also scan built pages as they are
// Exit 0: no signs of AI writing. Exit 1: the list, and where to fix it.
"use strict";
const path = require("path");
process.chdir(path.join(__dirname, ".."));
const quiet = process.argv.includes("--quiet");
const extra = process.argv.slice(2).filter((a) => !a.startsWith("--"));
let res;
try { res = require("./lib/prosecheck.js").runCheck({ extra }); }
catch (e) {
  // A half-edited file can't render. That is not a wording problem: say so and don't block.
  console.error(`prose check could not run: ${e && e.message ? e.message.split("\n")[0] : e}`);
  process.exit(0);
}
if (!res.hits.length) {
  if (!quiet) console.log(`prose check: no signs of AI writing on ${res.pages} page(s)`);
  process.exit(0);
}
const shown = new Set();
console.error(`prose check: ${res.hits.length} sign(s) of AI writing in FilmyChill's own text`);
for (const h of res.hits) {
  const k = `${h.rule}|${h.sentence}`;
  if (shown.has(k)) continue;
  shown.add(k);
  if (shown.size > 25) { console.error("  …"); break; }
  console.error(`  - ${h.page}: ${h.rule} "${h.match}" in: ${h.sentence}\n    Fix: ${h.fix}`);
}
console.error("Rewrite the template or page these come from (see the human-prose skill), then check again.");
process.exit(1);
