// ============================================================================
// votes.js (build side) — reads visitors' votes from Firestore and keeps per-film totals.
//
// Runs in the twice-daily build with the FIREBASE_SERVICE_ACCOUNT secret. Without the secret
// (or without the optional firebase-admin package) it does nothing and says so once.
//
//   - fetches only votes written since the last run (votes-state.json keeps the bookmark);
//   - for every film that got new votes, re-counts its worth-it / not-worth-it totals from
//     Firestore (a vote someone changed is counted once, as its latest value);
//   - flags a film that gets a sudden flood of votes (the fan-army pattern) in the run summary;
//   - reports, privately, how often voters agree with the FilmyChill Score.
// Totals live in votes-agg.json. Nothing here shows votes on the site yet — that switch
// comes later, once films regularly pass 50 votes and the agreement report looks sane.
// ============================================================================
"use strict";

const fs = require("fs");

const VOTES_STATE_FILE = "votes-state.json";
const VOTES_AGG_FILE = "votes-agg.json";
const MAX_FETCH = 20000;     // votes read per run, at most
const FLOOD_MIN = 50;        // new votes on one film in one run before a flood is considered…
const FLOOD_RATIO = 3;       // …and more than this multiple of everything it had before

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

// Pure: films whose new votes look like a coordinated flood.
function floodedFilms(newByFilm, agg) {
  const out = [];
  for (const [film, n] of Object.entries(newByFilm || {})) {
    const before = agg[film] ? (agg[film].up || 0) + (agg[film].down || 0) : 0;
    if (n >= FLOOD_MIN && n > FLOOD_RATIO * Math.max(before, 1)) out.push({ film, n, before });
  }
  return out;
}

// Pure: how often voters agree with the FilmyChill Score, over films with 10+ votes.
// "Agree" = mostly worth-it (60%+) on a Must watch / Worth a watch, mostly not (≤40%) on a Skip.
function agreement(agg, verdictByFilm) {
  let judged = 0, agreed = 0;
  for (const [film, a] of Object.entries(agg || {})) {
    const total = (a.up || 0) + (a.down || 0);
    const v = verdictByFilm[film];
    if (total < 10 || !v) continue;
    const share = (a.up || 0) / total;
    if (share > 0.4 && share < 0.6) continue; // split vote: no call either way
    judged++;
    if ((/^Skip/.test(v) && share <= 0.4) || (!/^Skip/.test(v) && share >= 0.6)) agreed++;
  }
  return { judged, agreed };
}

// firebase-admin's modular API (v11+; v14 dropped the old namespaced one).
function loadAdmin() {
  const app = require("firebase-admin/app");
  const store = require("firebase-admin/firestore");
  return {
    connect(creds) {
      const a = app.getApps().length ? app.getApps()[0] : app.initializeApp({ credential: app.cert(creds) });
      return store.getFirestore(a);
    },
    Timestamp: store.Timestamp,
  };
}

async function syncVotes({ dataByCode = {}, note = () => {}, env = process.env, admin: injected = null } = {}) {
  const res = { enabled: false, fetched: 0, films: 0, touched: 0 };
  if (!env.FIREBASE_SERVICE_ACCOUNT) return res;
  let admin = injected;
  if (!admin) {
    try { admin = loadAdmin(); }
    catch { note("votes: firebase-admin isn't installed, so votes weren't read this run"); return res; }
  }
  let creds;
  try { creds = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); }
  catch { note("votes: the FIREBASE_SERVICE_ACCOUNT secret isn't valid JSON — paste the whole key file"); return res; }
  const db = admin.connect(creds);
  res.enabled = true;

  const state = readJson(VOTES_STATE_FILE, {});
  const agg = readJson(VOTES_AGG_FILE, {});
  const since = admin.Timestamp.fromMillis(state.lastT ? Date.parse(state.lastT) : 0);

  // New votes since the bookmark, oldest first, in pages.
  const newByFilm = {};
  let last = since, fetched = 0;
  for (;;) {
    const snap = await db.collection("votes").where("t", ">", last).orderBy("t").limit(1000).get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      const x = d.data();
      if (x && x.film) newByFilm[x.film] = (newByFilm[x.film] || 0) + 1;
      if (x && x.t) last = x.t;
    }
    fetched += snap.size;
    if (snap.size < 1000 || fetched >= MAX_FETCH) break;
  }
  res.fetched = fetched;

  // Re-count each touched film (latest value per voter — each voter is one document).
  for (const film of Object.keys(newByFilm)) {
    const q = db.collection("votes").where("film", "==", film);
    const [up, down] = await Promise.all([
      q.where("v", "==", 1).count().get(),
      q.where("v", "==", -1).count().get(),
    ]);
    agg[film] = { up: up.data().count, down: down.data().count, at: new Date().toISOString().slice(0, 10) };
  }
  res.touched = Object.keys(newByFilm).length;
  res.films = Object.keys(agg).length;

  const floods = floodedFilms(newByFilm, agg);
  for (const f of floods) note(`votes: ${f.film} got ${f.n} votes in one run (it had ${f.before} before) — possible coordinated voting`);

  // Private agreement report, against this run's FilmyChill Scores.
  const verdictByFilm = {};
  for (const d of Object.values(dataByCode || {})) {
    for (const list of [d && d.theatres, d && d.ott, d && d.ottExtra]) {
      for (const it of list || []) if (it && it.tmdbId && it.fcScore) verdictByFilm[`${it.kind === "tv" ? "tv" : "movie"}-${it.tmdbId}`] = it.fcScore.verdict;
    }
  }
  const ag = agreement(agg, verdictByFilm);
  const totalVotes = Object.values(agg).reduce((s, a) => s + (a.up || 0) + (a.down || 0), 0);
  note(`votes: ${fetched} new this run · ${totalVotes} total across ${res.films} films` +
    (ag.judged ? ` · voters agree with the FilmyChill Score on ${ag.agreed} of ${ag.judged} films with 10+ votes` : ""));

  if (fetched) state.lastT = new Date(last.toMillis ? last.toMillis() : Date.parse(last)).toISOString();
  fs.writeFileSync(VOTES_STATE_FILE, JSON.stringify(state, null, 1));
  fs.writeFileSync(VOTES_AGG_FILE, JSON.stringify(agg, null, 1));
  return res;
}

module.exports = { VOTES_AGG_FILE, VOTES_STATE_FILE, agreement, floodedFilms, syncVotes };
