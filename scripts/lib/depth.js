// ============================================================================
// depth.js — facts no other site publishes, from data FilmyChill already holds (owner's plan of
// 9 Nov 2026: "ranked no 1 in terms of depth of content"). Each is one line or one row inside a
// block the page already has, drawn only where the data exists, data rather than sentences:
//
//   elsewhere        (ELSEWHERE)  "Elsewhere: Netflix in the US, UK and 9 more · out in the UK on
//                                 19 Oct, the US on 23 Oct", under the platform pill. From every
//                                 edition's own page and its manifest date.
//   platform-history (LATER)      later platforms' live sightings, after the arrival line.
//   readers-verdict  (READERS)    "Readers: 78% say worth it (142 votes)" in the score card, once a
//                                 film has READERS_MIN votes (votes.js waits for 50).
//   review-stars     (STARS)      "3 of 4 reviews gave stars: median 3.5 out of 5" atop the
//                                 review block, only stars a feed stated.
//   box-office       (GROSS)      "Box office: over ₹142 crore worldwide (Wikipedia, 8 Nov)" in
//                                 Good to know, from the article's own lead sentence.
//
// A rank within the title's language and year ("#3 of 47 Hindi films from 2014") was built and
// dropped the same day: the owner found the numbers made no sense to a reader (9 Nov 2026).
// Audio languages (plan item 8) are left out until a structured source exists (owner, option B).
// ============================================================================
"use strict";

const fs = require("fs");
const { escHtml } = require("./core.js");
const { inRollout } = require("./rollout.js");

const ELSEWHERE = "elsewhere";
const LATER = "platform-history";
const READERS = "readers-verdict";
const STARS = "review-stars";
const GROSS = "box-office";
const on = (feature, item) => !!(item && item.slug) && inRollout(feature, item.slug);

// Short country names, as a reader says them in a list.
const SHORT = { in: "India", us: "the US", uk: "the UK", au: "Australia", de: "Germany", ae: "the UAE", ca: "Canada",
  sg: "Singapore", my: "Malaysia", ph: "the Philippines", nz: "New Zealand", kr: "South Korea", jp: "Japan",
  id: "Indonesia", br: "Brazil", mx: "Mexico", es: "Spain", fr: "France" };
const keyOf = (kind, id) => `${kind === "tv" ? "tv" : "movie"}:${id}`;
const listOf = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// ---- ELSEWHERE ---------------------------------------------------------------------------------
// The map is built once a run, before any page is written, from every edition's pages on disk and
// its manifest: what each edition's own page says today. A page another edition rewrites this run
// shows here from the next run (a half-day at most).
let ELSE = null;
// Pure: entries [{ code, kind, tmdbId, slug, providers, released }] -> Map(key -> entries).
function useElsewhere(entries) {
  ELSE = new Map();
  for (const x of entries || []) {
    if (!x || !x.code || !x.tmdbId) continue;
    const k = keyOf(x.kind, x.tmdbId);
    if (!ELSE.has(k)) ELSE.set(k, []);
    ELSE.get(k).push(x);
  }
  return ELSE;
}
// The entries, from each edition's manifest (id, kind, date) and its page index (platforms).
function elsewhereEntries(manifest, indexByCode) {
  const { canonProvider } = require("./rules.js");
  const out = [];
  for (const [code, ed] of Object.entries(manifest || {})) {
    const idx = new Map((indexByCode[code] || []).map((x) => [x.slug, x]));
    for (const [slug, e] of Object.entries(ed || {})) {
      const ix = idx.get(slug);
      if (!e || !e.tmdbId || !ix) continue;   // no page on disk: nothing to say about it
      const providers = [...new Set((ix.providers || []).map((p) => canonProvider(p) || p).filter(Boolean))];
      out.push({ code, slug, kind: e.kind === "tv" ? "tv" : "movie", tmdbId: e.tmdbId, providers, released: /^\d{4}-\d{2}-\d{2}/.test(e.released || "") ? e.released.slice(0, 10) : null });
    }
  }
  return out;
}
// Pure: the line, or "". Platforms elsewhere, most countries first, two at most; and, for a film
// out in the last 60 days or not out yet, the other countries' dates that differ from this one's.
const RELEASE_RECENT_DAYS = 60;
function elsewhereHtml(code, item, { fmt = (d) => d, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!ELSE || !item || !item.tmdbId) return "";
  const others = (ELSE.get(keyOf(item.kind, item.tmdbId)) || []).filter((x) => x.code !== code);
  if (!others.length) return "";
  const byPlatform = new Map();
  for (const x of others) for (const p of x.providers) {
    if (!byPlatform.has(p)) byPlatform.set(p, []);
    byPlatform.get(p).push(x.code);
  }
  const plats = [...byPlatform.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 2)
    .map(([p, codes]) => {
      const names = codes.map((c) => SHORT[c] || c.toUpperCase());
      const shown = names.slice(0, 3);
      return `${escHtml(p)} in ${names.length > 3 ? `${shown.join(", ")} and ${names.length - 3} more` : listOf(shown)}`;
    });
  let dates = "";
  const here = /^\d{4}-\d{2}-\d{2}/.test(item.released || "") ? String(item.released).slice(0, 10) : null;
  const age = here ? (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${here}T00:00:00Z`)) / 864e5 : null;
  if (item.kind !== "tv" && age != null && age <= RELEASE_RECENT_DAYS) {
    const diff = others.filter((x) => x.released && x.released !== here).sort((a, b) => a.released.localeCompare(b.released) || a.code.localeCompare(b.code));
    const shown = diff.slice(0, 3).map((x) => `${SHORT[x.code] || x.code.toUpperCase()} on ${escHtml(fmt(x.released))}`);
    const more = diff.length - shown.length;
    if (shown.length) dates = more > 0 ? `out in ${shown.join(", ")} and ${more} more countr${more === 1 ? "y" : "ies"}` : `out in ${listOf(shown)}`;
  }
  const parts = [plats.join(" · "), dates].filter(Boolean);
  if (!parts.length) return "";
  return `<p class="welse" style="font-size:13.5px;color:var(--mute);margin:6px 0 0;line-height:1.5"><b style="color:var(--ink)">Elsewhere:</b> ${parts.join(" · ")}</p>`;
}

// ---- READERS' VERDICT --------------------------------------------------------------------------
const READERS_MIN = 50;
let VOTES = null;
function useVotes(agg) { VOTES = agg || null; return VOTES; }
function loadVotes(file = require("./votes.js").VOTES_AGG_FILE) {
  try { return useVotes(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { return useVotes(null); }
}
// Pure: { up, n, pct } once the film has READERS_MIN votes, else null.
function readersFor(item) {
  if (!VOTES || !item || !item.tmdbId) return null;
  const v = VOTES[`${item.kind === "tv" ? "tv" : "movie"}-${item.tmdbId}`];
  const up = v ? Number(v.up) || 0 : 0, n = v ? up + (Number(v.down) || 0) : 0;
  return n >= READERS_MIN ? { up, n, pct: Math.round((100 * up) / n) } : null;
}
function readersClause(item) {
  const r = readersFor(item);
  return r ? ` · <b>Readers:</b> ${r.pct}% say worth it (${r.n.toLocaleString("en-IN")} votes)` : "";
}

// ---- REVIEWERS' STARS --------------------------------------------------------------------------
// Pure: the line atop the review block, from stars the feeds stated; only with two or more (one
// is already on its own row).
function starsLine(reviews) {
  const seen = new Set();
  const rows = (reviews || []).filter((r) => r && r.u && !seen.has(r.u) && seen.add(r.u));
  const stars = rows.map((r) => r.s).filter((s) => typeof s === "number" && s >= 0 && s <= 5).sort((a, b) => a - b);
  if (stars.length < 2) return "";
  const mid = stars.length % 2 ? stars[(stars.length - 1) / 2] : (stars[stars.length / 2 - 1] + stars[stars.length / 2]) / 2;
  const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0$/, ""));
  return `<p class="rvs-sum" style="font-size:13px;color:var(--mute);margin:4px 0 0">${stars.length} of ${rows.length} reviews gave stars: median ${fmt(mid)} out of 5</p>`;
}

// ---- BOX OFFICE --------------------------------------------------------------------------------
// Pure: the gross the article's lead states, as it states it ("over ₹142 crore worldwide"), or
// null. A verb of earning must govern the figure, so a budget or a record is never read as the
// gross. Absent beats invented.
const MONEY = String.raw`(?:(?:over|more than|approximately|about|around|nearly|almost|an estimated|a total of|a worldwide total of)\s+)?(?:₹|Rs\.?\s?|INR\s?|US\$|\$|€|£|¥|₩)\s?[\d][\d.,]*(?:\s?(?:crore|lakh|million|billion))?`;
const GROSS_RE = new RegExp(String.raw`\b(?:grossed|grossing|earned|collected)\b(?:[^.;]{0,30}?)(${MONEY})(\s+(?:worldwide|globally|in India|domestically|in North America|in the United States))?`, "i");
function grossFromLead(lead) {
  const t = String(lead || "").replace(/\s+/g, " ").replace(/\[\d+\]/g, "");
  const m = GROSS_RE.exec(t);
  if (!m) return null;
  return `${m[1].replace(/\s+/g, " ").trim()}${m[2] ? m[2].replace(/\s+/g, " ") : ""}`;
}
// The figures by TMDB id ("movie:123" -> { t, at, article }), kept between runs: pages drawn from
// their facts have no IMDb id to find the Wikipedia record by. Written by lib/editorial.js as it
// reads the articles; a figure stays until a later read of the same article changes it.
const GROSS_FILE = "gross.json";
let GROSS_MAP = null;
function loadGross(file = GROSS_FILE) {
  try { GROSS_MAP = JSON.parse(fs.readFileSync(file, "utf8")); } catch { GROSS_MAP = {}; }
  return GROSS_MAP;
}
function useGross(map) { GROSS_MAP = map || null; }
function recordGross(updates, file = GROSS_FILE) {
  const map = loadGross(file);
  let changed = 0;
  for (const [k, g] of Object.entries(updates || {})) {
    if (!g || !g.t) continue;
    const have = map[k];
    if (have && have.t === g.t) continue;
    map[k] = { t: g.t, at: g.at, article: g.article };
    changed++;
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(map));
  return changed;
}
function grossFor(item) {
  if (!item || !item.tmdbId) return null;
  if (!GROSS_MAP) loadGross();
  return GROSS_MAP[keyOf(item.kind, item.tmdbId)] || null;
}
function grossRow(item, fmt = (d) => d) {
  const g = item && item.gross;
  if (!g || !g.t) return "";
  const link = g.article ? `<a href="https://en.wikipedia.org/wiki/${encodeURIComponent(String(g.article).replace(/ /g, "_"))}" rel="noopener" target="_blank">Wikipedia</a>` : "Wikipedia";
  return `<tr><td>Box office</td><td>${escHtml(g.t)} (${link}${g.at ? `, ${escHtml(fmt(g.at))}` : ""})</td></tr>`;
}

module.exports = {
  ELSEWHERE, LATER, READERS, STARS, GROSS, READERS_MIN, RELEASE_RECENT_DAYS,
  GROSS_FILE, grossFor, loadGross, recordGross, useGross,
  on, elsewhereEntries, elsewhereHtml, grossFromLead, grossRow, loadVotes,
  readersClause, readersFor, starsLine, useElsewhere, useVotes,
};
