// ============================================================================
// runhealth.js — the run-health report (so a skipped stage is never silent) and the
// strict state-file loader. Read by scripts/health.js at the end of every build.
// ============================================================================
"use strict";

const fs = require("fs");
const { OTT_SEEN_FILE, pruneOttSeen } = require("./freshness.js");

// ============================================================================
// RUN HEALTH — so a failure is never silent again.
//
// Every stage below runs inside its own try/catch so one broken stage can't take the whole
// site down. The cost of that design was that a broken stage only ever left a log line
// nobody reads: on 27 Sept 2026 the back-catalogue died in five markets and nothing said so.
// Now every swallowed failure is recorded here, written to run-health.json at the end of the
// build, and scripts/health.js turns it into a red run (GitHub emails you) plus a summary.
//   issues -> something is broken; the run goes red AFTER the site is committed and deployed
//   notes  -> worth knowing, handled safely; shown in the run summary, run stays green
// ============================================================================
const RUN_HEALTH_FILE = "run-health.json";
const RUN_HEALTH = { issues: [], notes: [], catalog: {} };
function stageFailed(label, e, { optional = false } = {}) {
  const msg = `${label}: ${(e && e.message) || e}`;
  console.warn(`  ${label} skipped: ${(e && e.message) || e}`);
  (optional ? RUN_HEALTH.notes : RUN_HEALTH.issues).push(msg);
}
function healthNote(msg) { RUN_HEALTH.notes.push(msg); }
function healthIssue(msg) { RUN_HEALTH.issues.push(msg); }

// State files carry history the site cannot rebuild (first-seen dates, every page's live
// claim, the catalogue cursor). Missing = first run, start empty. PRESENT BUT UNREADABLE =
// stop the build: silently starting from {} would overwrite months of history with nothing
// on the very next commit, and every OTT title would "arrive" again the same day.
function loadStateFile(file, fallback = {}) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`${file} exists but is not valid JSON (${e.message}) — refusing to overwrite its history`); }
}

let OTT_SEEN = null; // loaded once per process, written once after all countries build
function loadOttSeen() {
  if (OTT_SEEN) return OTT_SEEN;
  // Missing -> cold start for every country (first ever run). Corrupt -> the build stops.
  OTT_SEEN = pruneOttSeen(loadStateFile(OTT_SEEN_FILE, {}));
  return OTT_SEEN;
}

module.exports = {
  healthIssue,
  healthNote,
  loadOttSeen,
  loadStateFile,
  RUN_HEALTH,
  RUN_HEALTH_FILE,
  stageFailed,
};
