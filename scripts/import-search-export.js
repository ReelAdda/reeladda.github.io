"use strict";
// Load a Search Console performance export (the zip from "Export → Download ZIP", or its unpacked
// folder) into search-top.json, the data behind the "Most searched" block (lib/searchtop.js).
// The build fetches the same data itself once Search Console access is set up; this is for loading
// an export by hand in the meantime.
//
//   node scripts/import-search-export.js "C:\Users\me\Downloads\https___filmychill.com_-Performance-on-Search-2026-10-19.zip"
//
// The date range is read from the export's own daily chart (Chart.csv), so the block's heading says
// exactly what the export covers ("this week" only for a week).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { SEARCH_TOP_FILE, fromExport, rangeLabel } = require("./lib/searchtop.js");

function main(arg) {
  if (!arg) { console.error("usage: node scripts/import-search-export.js <export.zip | export folder>"); process.exit(1); }
  let dir = arg;
  if (/\.zip$/i.test(arg)) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsc-"));
    // bsdtar reads zip files: Windows 10+ ships it as System32\tar.exe (a GNU tar earlier on the
    // PATH, as in Git Bash, can't); macOS's tar is bsdtar too.
    const winTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    execFileSync(process.platform === "win32" && fs.existsSync(winTar) ? winTar : "tar", ["-xf", arg, "-C", dir]);
  }
  const pages = fs.readFileSync(path.join(dir, "Pages.csv"), "utf8");
  const days = fs.readFileSync(path.join(dir, "Chart.csv"), "utf8").split(/\r?\n/).slice(1)
    .map((l) => l.split(",")[0]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!days.length) throw new Error("Chart.csv has no dates — is this a Search Console performance export?");
  const saved = fromExport(pages, { from: days[0], to: days[days.length - 1], asOf: new Date().toISOString().slice(0, 10) });
  fs.writeFileSync(SEARCH_TOP_FILE, JSON.stringify(saved));
  const n = Object.values(saved.pages).reduce((s, l) => s + l.length, 0);
  console.log(`${SEARCH_TOP_FILE}: ${n} film pages across ${Object.keys(saved.pages).length} editions, ${saved.from} to ${saved.to} — the block will read "${rangeLabel(saved).h}".`);
}

if (require.main === module) main(process.argv[2]);
module.exports = { main };
