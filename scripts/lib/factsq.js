// ============================================================================
// factsq.js — the facts record becomes the only source of truth for a frozen film page
// (Oct 2026), switched on edition by edition, automatically.
//
// Before: every frozen page was rendered from facts, but the facts were READ BACK OUT OF THE
// PAGE each run (lib/facts.js extractFacts), and the sweeps changed pages by patching their
// HTML. The HTML was the channel the sweeps used to hand facts to the render, and every
// misread or forgotten patch left a page contradicting itself (17 Oct 2026 audit: Cocoon's
// platform lost to a pill rule, departures erased by the next render).
//
// Now each sweep also records what it found as a fact update for the page (queueFacts). An
// edition in "facts" mode renders every page from its stored record plus this run's updates,
// and never reads the old page. An edition in "shadow" mode keeps today's path, and renders
// each page the facts-only way too, compares the two, and counts the pages that differ.
//
// The switch is automatic (decideModes): an edition is promoted after SHADOW_CLEAN_RUNS clean
// runs in a row, one edition per run, smallest first and India last; an edition in facts mode
// goes back to shadow (and the run turns red) if the render loses pages or the self-audit finds
// a false claim on it. State lives in facts-mode.json (committed, never published).
// ============================================================================
"use strict";

const fs = require("fs");

const MODE_FILE = "facts-mode.json";
// Two days of twice-daily runs with the two renders agreeing before an edition switches.
const SHADOW_CLEAN_RUNS = 4;
// "Agreeing": at most this share of pages differing (and never more than SHADOW_MAX_DIFFS),
// so one odd page can't hold an edition back for good, but a missed sweep (which touches many
// pages) always does.
const SHADOW_MAX_SHARE = 0.002;
const SHADOW_MAX_DIFFS = 3;
// Smallest editions first, India (the largest audience) last.
const PROMOTION_ORDER = ["nz", "es", "fr", "mx", "br", "jp", "kr", "id", "ph", "my", "sg", "au", "ca", "de", "uk", "us", "ae", "in"];

// ---- this run's fact updates, by edition and page ----------------------------------------
const queue = new Map();   // code -> Map(slug -> patch)
// A patch is merged into the page's facts: a key set to undefined is removed.
function queueFacts(code, slug, patch) {
  if (!code || !slug || !patch) return;
  if (!queue.has(code)) queue.set(code, new Map());
  const m = queue.get(code);
  m.set(slug, { ...(m.get(slug) || {}), ...patch });
}
function queuedFacts(code) { return queue.get(code) || new Map(); }
function clearQueue() { queue.clear(); }
// Pure: an item with one patch applied.
function applyPatch(item, patch) {
  if (!patch) return item;
  const out = { ...item };
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete out[k]; else out[k] = v; }
  return out;
}

// ---- modes --------------------------------------------------------------------------------
function loadModes(file = MODE_FILE) {
  try { const s = JSON.parse(fs.readFileSync(file, "utf8")); if (s && s.editions) return s; } catch { /* first run */ }
  return { v: 1, editions: {} };
}
function saveModes(state, file = MODE_FILE) { fs.writeFileSync(file, JSON.stringify(state, null, 1) + "\n"); }
function modeOf(state, code) { return (state.editions[code] && state.editions[code].mode) || "shadow"; }

// Pure: next run's modes from this run's results. `results[code]` = { pages, shadowDiffs, lost,
// falseClaims }. Mutates and returns `state`, plus what changed (for the run summary).
function decideModes(state, results, today) {
  const events = [];
  for (const [code, r] of Object.entries(results || {})) {
    const e = state.editions[code] = state.editions[code] || { mode: "shadow", clean: 0 };
    e.lastRun = today;
    if (e.mode === "facts") {
      const why = r.lost ? `${r.lost} page(s) couldn't be rendered` : r.falseClaims ? `${r.falseClaims} false claim(s) in the self-audit` : null;
      if (why) {
        Object.assign(e, { mode: "shadow", clean: 0, rolledBack: today, rollbackWhy: why });
        events.push({ code, kind: "rollback", why });
      }
      continue;
    }
    const limit = Math.min(SHADOW_MAX_DIFFS, Math.floor((r.pages || 0) * SHADOW_MAX_SHARE));
    const clean = (r.pages || 0) > 0 && !r.lost && (r.shadowDiffs || 0) <= limit;
    e.clean = clean ? (e.clean || 0) + 1 : 0;
    e.lastDiffs = r.shadowDiffs || 0;
    // A week of runs that never come clean is reported (once a week), never silent.
    e.dirtyRuns = clean ? 0 : (e.dirtyRuns || 0) + 1;
    if (e.dirtyRuns && e.dirtyRuns % 14 === 0) events.push({ code, kind: "stalled", diffs: e.lastDiffs });
  }
  // One promotion per run: the first edition in order that is clean (one that isn't never holds
  // the rest back). A rollback waits a week before it may try again. India goes only once
  // every other edition built this run is in facts mode.
  const cooling = (e) => e.rolledBack && (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${e.rolledBack}T00:00:00Z`)) / 864e5 < 7;
  const built = PROMOTION_ORDER.filter((c) => results && results[c]);
  const next = built.find((c) => {
    const e = state.editions[c];
    if (modeOf(state, c) === "facts" || e.clean < SHADOW_CLEAN_RUNS || cooling(e)) return false;
    if (c === "in") return built.every((o) => o === "in" || modeOf(state, o) === "facts");
    return true;
  });
  if (next) {
    Object.assign(state.editions[next], { mode: "facts", since: today });
    events.push({ code: next, kind: "promote" });
  }
  return { state, events };
}

module.exports = {
  MODE_FILE, PROMOTION_ORDER, SHADOW_CLEAN_RUNS, SHADOW_MAX_DIFFS, SHADOW_MAX_SHARE,
  applyPatch, clearQueue, decideModes, loadModes, modeOf, queueFacts, queuedFacts, saveModes,
};
