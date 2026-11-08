"use strict";

// ============================================================================
// alerts.js — arrival alerts (5 Nov 2026).
//
// A reader who saves a film in My List can ask for one ping when it starts streaming in their
// edition ("Clayface is now on Prime Video"). The browser half is in js/app.js: it subscribes
// to standard Web Push and writes alerts/<anonymous uid> to Firestore (subscription, saved film
// keys with the day each was saved, edition). firestore.rules lets a reader write and delete
// only their own record; nobody can read records from a browser.
//
// This half runs in the daily build AFTER the deploy and the live check (scripts/alerts.js),
// so an alert never runs ahead of the page it opens: a film counts as arrived only when its
// manifest entry says it is live — the same verified claim the page shows — with no missed
// check, since a day on or after the reader saved it, and within ARRIVAL_DAYS. One alert per
// reader per day at most; never the same film twice (alertSent/<uid>, closed to browsers).
// Subscriptions the push service reports gone (404/410) are deleted with their record.
//
// Switch: rollout.json "arrival-alerts" (0 turns the opt-in off on the next build and stops
// sending). Keys: VAPID_PUBLIC_KEY (repository variable, also written into the homepage) and
// VAPID_PRIVATE_KEY (secret). Without either, nothing is offered and nothing is sent.
// ============================================================================

const FEATURE = "arrival-alerts";
const ARRIVAL_DAYS = 14;
const FILM_KEY = /^(movie|tv)-\d{1,9}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VAPID_KEY = /^[A-Za-z0-9_-]{86,88}$/;     // a P-256 public key, 65 bytes in base64url
const MAX_SENDS = 5000;                          // per run, a safety cap
const SENT_KEEP_DAYS = 365;                      // how long a film stays in a reader's sent list
const LEVELS = new Set(["Must watch", "Worth a watch", "Skip"]);

const filmPath = (code, slug) => (code === "in" ? `/movie/${slug}.html` : `/${code}/movie/${slug}.html`);
const daysBetween = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5;

// Is the feature on, with a usable public key? Decides both the homepage opt-in and sending.
function alertsEnabled(env = process.env, config = null) {
  const key = String(env.VAPID_PUBLIC_KEY || "").trim();
  if (!VAPID_KEY.test(key)) return false;
  const R = require("./rollout.js");
  return R.percentOf(config || R.rolloutConfig(), FEATURE) > 0;
}
const publicKey = (env = process.env) => String(env.VAPID_PUBLIC_KEY || "").trim();

// Pure: film key ("movie-123") -> { slug, e } for one edition's manifest.
function filmIndex(manifestForCountry = {}) {
  const out = new Map();
  for (const [slug, e] of Object.entries(manifestForCountry || {})) {
    if (!e || !e.tmdbId) continue;
    const key = `${e.kind === "tv" ? "tv" : "movie"}-${e.tmdbId}`;
    const prev = out.get(key);
    if (!prev || (!prev.e.live && e.live)) out.set(key, { slug, e });
  }
  return out;
}

// Pure: has this film arrived on a platform, as the page now says? Returns the arrival or null.
function arrivalOf(e, today) {
  const live = e && e.live;
  if (!live || !DAY.test(String(live.since || ""))) return null;
  if (Number(live.misses) > 0) return null;                    // the last check didn't see it
  const providers = (Array.isArray(live.providers) ? live.providers : []).filter((p) => typeof p === "string" && p);
  if (!providers.length) return null;
  // A catalogue page records its build day as `since` (the film was already streaming): only
  // an arrival seen after the page was archived is news. Same rule as the new-pages sitemap.
  if (e.catalog && !(e.archivedOn && live.since > e.archivedOn)) return null;
  const age = daysBetween(live.since, today);
  if (!(age >= 0 && age <= ARRIVAL_DAYS)) return null;
  return { since: live.since, providers };
}

// Pure: the notification for one film. The wording was approved on the 5 Nov mock-up.
function alertPayload(e, slug, code, arrival, { hasReviews = false } = {}) {
  const title = String((e && e.title) || slug);
  const apps = [...new Set(arrival.providers)].slice(0, 2).join(" and ");
  const v = e && e.fcs && LEVELS.has(e.fcs.v) ? e.fcs.v : null;
  const body = v === "Skip" ? "Our verdict: Skip. Tap to see why."
    : v ? `${v}. Tap for the verdict${hasReviews ? " and reviews" : ""}.`
    : "Tap for the ratings so far and where to watch.";
  return { title: `${title} is now on ${apps}`, body, url: filmPath(code, slug), tag: `fc-${slug}` };
}

// Pure: parse a stored subscription (JSON text from the browser). Null when it isn't one.
function parseSubscription(text) {
  let s;
  try { s = JSON.parse(String(text || "")); } catch { return null; }
  if (!s || typeof s.endpoint !== "string" || !/^https:\/\/[^\s]+$/.test(s.endpoint)) return null;
  if (!s.keys || typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string") return null;
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

// Pure: who gets which alert this run. `subs`: [{ uid, sub, films: { key: savedDay }, c }];
// `sent`: { uid: { films: { key: day }, last: day } }; `manifest`: the pages manifest.
function pickAlerts({ subs = [], sent = {}, manifest = {}, today, hasReviews = () => false, max = MAX_SENDS }) {
  const indexes = new Map();
  const out = [];
  for (const s of subs) {
    if (out.length >= max) break;
    if (!s || !s.uid || !s.sub || !/^[a-z]{2}$/.test(String(s.c || "")) || !manifest[s.c]) continue;
    const was = sent[s.uid] || {};
    if (was.last === today) continue;                            // one alert a day
    if (!indexes.has(s.c)) indexes.set(s.c, filmIndex(manifest[s.c]));
    const idx = indexes.get(s.c);
    const done = was.films || {};
    const options = [];
    for (const [key, saved] of Object.entries(s.films || {})) {
      if (!FILM_KEY.test(key) || !DAY.test(String(saved)) || done[key]) continue;
      const hit = idx.get(key);
      if (!hit) continue;
      const a = arrivalOf(hit.e, today);
      if (!a || a.since < saved) continue;                       // it was already streaming when saved
      options.push({ key, slug: hit.slug, e: hit.e, a });
    }
    if (!options.length) continue;
    options.sort((x, y) => y.a.since.localeCompare(x.a.since) || String(x.e.title).localeCompare(String(y.e.title)));
    const o = options[0];
    const kind = o.key.startsWith("tv-") ? "tv" : "movie";
    out.push({ uid: s.uid, sub: s.sub, key: o.key, code: s.c,
      payload: alertPayload(o.e, o.slug, s.c, o.a, { hasReviews: hasReviews(kind, o.e.tmdbId) }) });
  }
  return out;
}

// THE FRIDAY DIGEST (step 8, 8 Nov 2026). A reader with alerts on can also ask for one weekly
// ping with the week's arrivals in their edition. The opt-in rides in the record's films map as
// films.digest = the day it was turned on (firestore.rules already allows any key there and the
// film alerts above skip keys that aren't film keys), so no rules change is needed.
// Sent on the first build that falls on a Friday daytime (09:00–21:59) in the edition's own time,
// once per week (alertSent.digest = that week's Monday), never on a day the reader already had an
// alert, never for a week with nothing new. Counts are of the titles FilmyChill tracks.
const DIGEST_KEY = "digest";
function editionClock(code, now) {
  const tz = require("./freshness.js").EDITION_TZ[code];
  if (!tz) return null;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const g = (k) => (parts.find((p) => p.type === k) || {}).value;
  return { weekday: g("weekday"), hour: Number(g("hour")), day: `${g("year")}-${g("month")}-${g("day")}` };
}
const mondayOf = (day) => { const t = Date.parse(`${day}T00:00:00Z`); const wd = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - wd * 864e5).toISOString().slice(0, 10); };
// Pure: the digest for one edition this week, or null when nothing arrived.
function digestPayload(records, code, localDay, { V = { word: "OTT" }, country = "" } = {}) {
  const since = new Date(Date.parse(`${localDay}T00:00:00Z`) - 6 * 864e5).toISOString().slice(0, 10);
  const mine = (records || []).filter((r) => r && r.c === code && r.first && String(r.first).slice(0, 10) >= since && String(r.first).slice(0, 10) <= localDay && r.p)
    .sort((a, b) => String(b.seen || b.first).localeCompare(String(a.seen || a.first)));
  if (!mine.length) return null;
  const named = mine.slice(0, 2).map((r) => `${r.t} on ${r.p}`);
  const n = mine.length;
  const where = country ? ` in ${country}` : "";
  return {
    title: `This week on ${V.word}${where}: ${n} new arrival${n === 1 ? "" : "s"}`,
    body: `Including ${named.join(" and ")}. Tap for the full list.`,
    url: code === "in" ? "/new-on-ott/today/" : `/${code}/new-on-ott/today/`,
    tag: "fc-digest",
  };
}
// Pure: who gets this week's digest this run. `skip`: uids already alerted this run.
function pickDigests({ subs = [], sent = {}, records = [], now = Date.now(), skip = new Set() } = {}) {
  const { COUNTRIES } = require("./core.js");
  const { countryNameFor, streamVocab } = require("./rules.js");
  const out = [], payloads = new Map();
  for (const s of subs) {
    if (!s || !s.uid || !s.sub || skip.has(s.uid) || !s.films || !DAY.test(String(s.films[DIGEST_KEY] || ""))) continue;
    const cfg = COUNTRIES.find((c) => c.code === s.c);
    const clock = cfg && editionClock(cfg.code, now);
    if (!clock || clock.weekday !== "Fri" || clock.hour < 9 || clock.hour > 21) continue;
    const week = mondayOf(clock.day);
    const was = sent[s.uid] || {};
    if (was.digest === week || was.last === clock.day) continue;
    if (!payloads.has(cfg.code)) payloads.set(cfg.code, digestPayload(records, cfg.code, clock.day, { V: streamVocab(cfg), country: countryNameFor(cfg) }));
    const payload = payloads.get(cfg.code);
    if (!payload) continue;
    out.push({ uid: s.uid, sub: s.sub, key: null, digest: week, day: clock.day, payload });
  }
  return out;
}

// Pure: a reader's sent record after one more alert, dropping films older than a year.
function nextSent(was = {}, key, today) {
  const films = {};
  for (const [k, d] of Object.entries((was && was.films) || {})) if (DAY.test(String(d)) && daysBetween(d, today) <= SENT_KEEP_DAYS) films[k] = d;
  films[key] = today;
  return { ...(was && was.digest ? { digest: was.digest } : {}), films, last: today };
}

const TEST_PAYLOAD = { title: "FilmyChill alerts are on", body: "This is a test. You'll get a ping like this when a saved film starts streaming.", url: "/", tag: "fc-test" };

// The build step. Fails soft: every problem is a note, never a failed build.
async function sendAlerts({ env = process.env, manifest = null, today = new Date().toISOString().slice(0, 10),
  note = () => {}, admin = null, webpush = null, test = false, testMinutes = 60, now = Date.now() } = {}) {
  const res = { enabled: false, subs: 0, sent: 0, gone: 0, failed: 0 };
  if (!alertsEnabled(env)) { note("alerts: off (rollout switch or VAPID_PUBLIC_KEY missing)"); return res; }
  if (!env.VAPID_PRIVATE_KEY) { note("alerts: the VAPID_PRIVATE_KEY secret isn't set, so nothing was sent"); return res; }
  if (!env.FIREBASE_SERVICE_ACCOUNT) { note("alerts: no FIREBASE_SERVICE_ACCOUNT, so subscriptions couldn't be read"); return res; }
  let wp = webpush;
  if (!wp) {
    try { wp = require("web-push"); } catch { note("alerts: web-push isn't installed, so nothing was sent"); return res; }
  }
  let creds;
  try { creds = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); } catch { note("alerts: FIREBASE_SERVICE_ACCOUNT isn't valid JSON"); return res; }
  let db;
  try {
    const store = admin || (() => {
      const app = require("firebase-admin/app"), fs = require("firebase-admin/firestore");
      return { connect: (c) => fs.getFirestore(app.getApps().length ? app.getApps()[0] : app.initializeApp({ credential: app.cert(c) })) };
    })();
    db = store.connect(creds);
  } catch (e) { note(`alerts: Firestore unavailable (${e.message})`); return res; }
  try { wp.setVapidDetails("mailto:contact@filmychill.com", publicKey(env), String(env.VAPID_PRIVATE_KEY).trim()); }
  catch (e) { note(`alerts: the VAPID keys don't form a pair (${e.message})`); return res; }
  res.enabled = true;

  const subs = [];
  const subSnap = await db.collection("alerts").get();
  for (const d of subSnap.docs) {
    const x = d.data() || {};
    const sub = parseSubscription(x.sub);
    if (!sub) continue;
    const t = x.t && typeof x.t.toMillis === "function" ? x.t.toMillis() : 0;
    subs.push({ uid: d.id, sub, films: x.films && typeof x.films === "object" ? x.films : {}, c: x.c, t });
  }
  res.subs = subs.length;

  let picks;
  if (test) {
    picks = subs.filter((s) => s.t && now - s.t <= testMinutes * 60000).map((s) => ({ uid: s.uid, sub: s.sub, key: null, payload: TEST_PAYLOAD }));
  } else {
    const sent = {};
    const sentSnap = await db.collection("alertSent").get();
    for (const d of sentSnap.docs) sent[d.id] = d.data() || {};
    let m = manifest;
    if (!m) { try { m = JSON.parse(require("fs").readFileSync("pages-manifest.json", "utf8")); } catch { m = {}; } }
    const RV = require("./reviews.js");
    picks = pickAlerts({ subs, sent, manifest: m, today, hasReviews: (kind, id) => RV.reviewsFor(kind, id).length > 0 });
    // The Friday digest, for readers who asked for it and had no film alert this run.
    const digests = pickDigests({ subs, sent, records: require("./history.js").readHistory(), now, skip: new Set(picks.map((p) => p.uid)) });
    res.digests = digests.length;
    picks = picks.concat(digests);
    for (const p of picks) p.was = sent[p.uid];
  }

  for (const p of picks) {
    try {
      await wp.sendNotification(p.sub, JSON.stringify(p.payload), { TTL: 86400, urgency: "normal" });
      res.sent++;
      if (p.key) await db.collection("alertSent").doc(p.uid).set(nextSent(p.was, p.key, today));
      else if (p.digest) await db.collection("alertSent").doc(p.uid).set({ ...(p.was || {}), digest: p.digest, last: p.day });
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        res.gone++;
        await Promise.allSettled([db.collection("alerts").doc(p.uid).delete(), db.collection("alertSent").doc(p.uid).delete()]);
      } else {
        res.failed++;
        if (res.failed <= 3) note(`alerts: a send failed (${(e && (e.statusCode || e.message)) || "unknown"})`);
      }
    }
  }
  return res;
}

module.exports = { DIGEST_KEY, digestPayload, editionClock, mondayOf, pickDigests, ARRIVAL_DAYS, FEATURE, TEST_PAYLOAD, alertPayload, alertsEnabled, arrivalOf, filmIndex, filmPath, nextSent, parseSubscription, pickAlerts, publicKey, sendAlerts };
