#!/usr/bin/env node
// ============================================================================
// alerts.js — send arrival alerts (lib/alerts.js). Runs in the daily build after the deploy
// and the live check, so every alert opens a page that already says the film is streaming.
//
//   node scripts/alerts.js          send today's alerts
//   node scripts/alerts.js --test   send a test ping to subscriptions made in the last hour
//                                   (the "Arrival alerts test" workflow; nothing is recorded)
//
// Never fails the build: problems are printed and written to the run summary.
// ============================================================================
"use strict";
const fs = require("fs");
const { sendAlerts } = require("./lib/alerts.js");

(async () => {
  const test = process.argv.includes("--test");
  const notes = [];
  let res;
  try {
    res = await sendAlerts({ test, note: (m) => { notes.push(m); console.log(m); } });
  } catch (e) {
    res = { enabled: false, error: e.message };
    console.log(`alerts: stopped (${e.message})`);
  }
  const line = res.enabled
    ? `Arrival alerts${test ? " (test)" : ""}: ${res.sent} sent, ${res.gone} expired subscription(s) removed, ${res.failed} failed, ${res.subs} subscription(s)`
    : `Arrival alerts: not sent${notes.length ? ` (${notes[notes.length - 1].replace(/^alerts: /, "")})` : ""}`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${line}\n`); } catch { /* summary is optional */ }
  }
})();
