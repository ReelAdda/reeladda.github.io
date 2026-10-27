// ============================================================================
// series.js — episode guides and franchise links, from TMDB data (27 Oct 2026).
//
// A page-by-page comparison (VisionQuest against Esquire India, Pinkvilla and the Sunday
// Guardian) found the one thing every competing page answered and ours didn't: for a series
// on air, "how many episodes" and "when is the next one". And "how is it connected" for a film
// in a franchise. Both come from TMDB at no extra cost for pages being built (the details call
// already made, plus its keywords); older pages get them from a budgeted sweep.
//
// EPISODES: the latest season's episodes (number, title, date, runtime), the count, whether it
// is a limited series, and the next episode. Dates are TMDB's original release dates — the page
// says so; it never claims an Indian streaming time it has no source for.
//
// FRANCHISE: a film's TMDB collection ("Dhoom Collection"), or for a shared universe a TMDB
// keyword on FRANCHISE_KEYWORD ("marvel cinematic universe (mcu)"). The row links ONLY other
// titles of the same franchise that already have a page Google can see in the same edition —
// no page is created, and with no such title there is no row.
//
// Both ride in the page as one comment marker (FC:series), so lib/facts.js reads them back and
// a frozen page keeps them, as the audience rating does (lib/filmpage.js audienceMark).
// ============================================================================
"use strict";

const SERIES_SWEEP_VERSION = 1;
const RECENT_SEASON_DAYS = 150;   // a season that ended this recently still gets its episode list

// Shared universes TMDB marks with a keyword (collections cover plain sequels).
const FRANCHISE_KEYWORD = /cinematic universe|shared universe|\(mcu\)|\(dceu\)|monsterverse|wizarding world|spider-?verse|conjuring universe|spy universe|cop universe/i;

// Pure: the episode guide from a TMDB /tv/{id} response and, optionally, its latest season.
function episodesFrom(d, season = null) {
  if (!d || typeof d !== "object") return null;
  const count = Number(d.number_of_episodes) || 0;
  if (!count) return null;
  const n = (e) => e && e.air_date ? { s: e.season_number, e: e.episode_number, name: e.name || "", date: e.air_date } : null;
  const list = season && Array.isArray(season.episodes)
    ? season.episodes.map((x) => ({ e: x.episode_number, name: x.name || "", date: x.air_date || "", runtime: Number(x.runtime) || null })).filter((x) => x.e)
    : [];
  return {
    count,
    seasons: Number(d.number_of_seasons) || 1,
    limited: d.type === "Miniseries",
    season: season ? season.season_number : null,
    next: n(d.next_episode_to_air),
    list,
  };
}

// Pure: franchise memberships from a TMDB details response (with keywords appended).
function franchiseFrom(d) {
  if (!d || typeof d !== "object") return null;
  const c = d.belongs_to_collection && d.belongs_to_collection.id ? { id: d.belongs_to_collection.id, name: d.belongs_to_collection.name } : null;
  const kws = (d.keywords && (d.keywords.keywords || d.keywords.results)) || [];
  const u = kws.map((k) => k && k.name).filter((nm) => nm && FRANCHISE_KEYWORD.test(nm)).slice(0, 2);
  return c || u.length ? { c, u } : null;
}

// The season worth listing: the current one when a next episode is due, else the latest that
// aired recently. null when the show is long finished (its guide would just be history).
function seasonToFetch(d, now = Date.now()) {
  if (!d) return null;
  if (d.next_episode_to_air && d.next_episode_to_air.season_number) return d.next_episode_to_air.season_number;
  const last = d.last_episode_to_air;
  if (last && last.air_date && (now - Date.parse(`${last.air_date}T00:00:00Z`)) / 864e5 <= RECENT_SEASON_DAYS) return last.season_number;
  return null;
}

// Both from TMDB for one title: the details call (with keywords) and, for a series on air or
// just finished, its season. `tmdb` is lib/tmdb.js's client.
async function seriesFactsFor(kind, id, tmdb, now = Date.now()) {
  const d = await tmdb(`/${kind}/${id}`, { append_to_response: "keywords" });
  let episodes = null;
  if (kind === "tv") {
    const sn = seasonToFetch(d, now);
    let season = null;
    if (sn) { try { season = await tmdb(`/tv/${id}/season/${sn}`); } catch { /* the count alone */ } }
    episodes = episodesFrom(d, season);
  }
  // The backdrop rides along: older pages lost it (their facts never kept it), and the hero shows it.
  const bp = d && /^\/[\w.-]+$/.test(String(d.backdrop_path || "")) ? d.backdrop_path : null;
  return { episodes, franchise: franchiseFrom(d), backdropPath: bp };
}

// ---- the page ---------------------------------------------------------------------------------
const MARK_RE = /<!--FC:series=([^>]*?)-->/;
function seriesMark(item) {
  const v = {};
  if (item && item.episodes) v.ep = item.episodes;
  if (item && item.franchise) v.fr = item.franchise;
  return Object.keys(v).length ? `<!--FC:series=${encodeURIComponent(JSON.stringify(v))}-->` : "";
}
function readSeriesMark(html) {
  const m = MARK_RE.exec(String(html || ""));
  if (!m) return {};
  try { const v = JSON.parse(decodeURIComponent(m[1])); return { episodes: v.ep || null, franchise: v.fr || null }; } catch { return {}; }
}

const universeName = (kw) => String(kw).replace(/\s*\((?:mcu|dceu)\)\s*/i, "").replace(/\b\w/g, (ch) => ch.toUpperCase());
const seriesName = (c) => String(c.name || "").replace(/\s+Collection$/i, "");

// Pure: the titles to list in "More in this series" for `item`, from the edition's film index
// (entries carry `franchise` read from their own pages). Visible pages only (`visible(slug)`).
// The collection first (true sequels); a shared universe when the collection gives nothing.
function franchiseSiblings(item, index, { visible = () => true, max = 6 } = {}) {
  const fr = item && item.franchise;
  if (!fr || !Array.isArray(index)) return null;
  const pick = (test, heading, kind) => {
    const all = index.filter((x) => x && x.slug && x.slug !== item.slug && x.franchise && test(x.franchise) && visible(x.slug))
      .sort((a, b) => String(a.released || "").localeCompare(String(b.released || "")) || a.title.localeCompare(b.title));
    if (!all.length) return null;
    // The titles nearest this one in release order, so a long universe shows its neighbours.
    const mine = String(item.released || "");
    let at = all.findIndex((x) => String(x.released || "") > mine); if (at < 0) at = all.length;
    const from = Math.max(0, Math.min(at - Math.floor(max / 2), all.length - max));
    return { heading, kind, items: all.slice(from, from + max), total: all.length };
  };
  if (fr.c) {
    const r = pick((f) => f.c && f.c.id === fr.c.id, `More in the ${seriesName(fr.c)} series`, "collection");
    if (r) return r;
  }
  for (const u of fr.u || []) {
    const r = pick((f) => (f.u || []).includes(u), `More from the ${universeName(u)}`, "universe");
    if (r) return r;
  }
  return null;
}

// Pure: the "Episodes" section (series only). `fmt(date)` formats a date for the edition.
function episodesHtml(item, fmt, today = new Date().toISOString().slice(0, 10)) {
  const ep = item && item.kind === "tv" && item.episodes;
  if (!ep || !ep.count) return "";
  const e = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const summary = [`${ep.count} episode${ep.count === 1 ? "" : "s"}${ep.seasons > 1 ? ` across ${ep.seasons} seasons` : ""}`, ep.limited ? "limited series" : null].filter(Boolean).join(" · ");
  const nextNo = ep.next && ep.next.date >= today && (!ep.season || ep.next.s === ep.season) ? ep.next.e : null;
  // With no episode list, the next episode is said in words (the answer card says it too).
  const next = !(ep.list || []).length && ep.next && ep.next.date >= today
    ? `<p class="epnext"><b>Next episode:</b> ${ep.next.s > 1 || ep.seasons > 1 ? `S${ep.next.s} ` : ""}E${ep.next.e}${ep.next.name ? ` — ${e(ep.next.name)}` : ""}, ${e(fmt(ep.next.date))}</p>` : "";
  // A timeline: aired episodes filled, the next one marked, the rest outlined.
  const items = (ep.list || []).map((x) => {
    const state = x.e === nextNo ? "next" : x.date && x.date <= today ? "out" : "soon";
    const pair = x.date && (ep.list || []).some((y) => y !== x && y.date === x.date);
    const meta = [x.date ? fmt(x.date) : "Date to be announced", pair ? "same-day double drop" : null, x.runtime ? `${x.runtime} min` : null].filter(Boolean).join(" · ");
    return `<li class="${state}"><span class="epn">${x.e}</span><div><b>${e(x.name || `Episode ${x.e}`)}</b><small>${e(meta)}</small></div>${state === "next" ? '<span class="eptag">Next</span>' : ""}</li>`;
  }).join("");
  return `<h2>Episodes</h2><p>${e(summary)}${ep.season && ep.seasons > 1 ? ` · season ${ep.season} below` : ""} · original release dates</p>${next}`
    + (items ? `<ol class="eplist">${items}</ol>` : "");
}

// Pure: series FAQs, only from what the guide holds.
function episodeFaqs(item, fmt, today = new Date().toISOString().slice(0, 10)) {
  const ep = item && item.kind === "tv" && item.episodes;
  if (!ep || !ep.count) return [];
  const out = [{ q: `How many episodes does ${item.title} have?`, a: `${item.title} has ${ep.count} episode${ep.count === 1 ? "" : "s"}${ep.seasons > 1 ? ` across ${ep.seasons} seasons` : ""}${ep.limited ? " — it's a limited series" : ""}.` }];
  if (ep.next && ep.next.date >= today) {
    out.push({ q: `When is the next episode of ${item.title}?`, a: `Episode ${ep.next.e}${ep.next.name ? `, "${ep.next.name}",` : ""} is due on ${fmt(ep.next.date)} (its original release date).` });
  }
  return out;
}

// Pure: the fit rows a title's own data gives (null when it gives none): how a series on air is
// released, a finished limited series as one sitting, and the franchise titles to watch first
// (siblings released before it, from franchiseSiblings).
function fitFromData(item, franchise, fmt, today = new Date().toISOString().slice(0, 10)) {
  const out = { bestFor: null, skipIf: null, watchFirst: [] };
  const ep = item && item.kind === "tv" && item.episodes;
  if (ep && ep.count) {
    const dates = (ep.list || []).map((x) => x.date).filter(Boolean).sort();
    const last = dates.length ? dates[dates.length - 1] : null;
    if (ep.next && ep.next.date >= today && last) {
      out.bestFor = `following it week by week — new episodes until ${fmt(last)}`;
      out.skipIf = `you'd rather binge it in one go — the finale lands on ${fmt(last)}`;
    } else if (ep.limited && last && last <= today) {
      out.bestFor = `a complete ${ep.count}-episode story you can watch start to finish`;
    }
  }
  // Only a true sequel collection says what to watch first: a shared universe's other titles
  // aren't prerequisites (VisionQuest showed "Watch first: X-Men '97", 27 Oct 2026).
  if (franchise && franchise.items && franchise.kind === "collection") {
    const mine = String((item && item.released) || "");
    out.watchFirst = franchise.items.filter((x) => String(x.released || "") < mine).slice(-3);
  }
  return out.bestFor || out.watchFirst.length ? out : null;
}

// Pure: "Good to know" rows the guides add.
function seriesKnowRows(item) {
  const rows = [];
  const ep = item && item.kind === "tv" && item.episodes;
  if (ep && ep.count) {
    rows.push({ label: "Episodes", value: `${ep.count}${ep.seasons > 1 ? ` across ${ep.seasons} seasons` : ""}${ep.limited ? " · limited series" : ""}` });
    const rts = (ep.list || []).map((x) => x.runtime).filter(Boolean);
    if (rts.length) { const lo = Math.min(...rts), hi = Math.max(...rts); rows.push({ label: "Episode length", value: lo === hi ? `${lo} min` : `${lo}–${hi} min` }); }
  }
  const fr = item && item.franchise;
  if (fr && fr.c) rows.push({ label: "Part of", value: `${seriesName(fr.c)} series` });
  else if (fr && fr.u && fr.u.length) rows.push({ label: "Part of", value: universeName(fr.u[0]) });
  return rows;
}

// Is an airing series' guide due a refresh? Every 3 days while a next episode is due.
function seriesSweepDue(e, now = Date.now()) {
  if (!e || !e.tmdbId) return false;
  if ((e.srv || 0) < SERIES_SWEEP_VERSION) return true;
  if (e.kind === "tv" && e.epNext && e.epNext >= new Date(now).toISOString().slice(0, 10)) {
    return !e.srAt || (now - Date.parse(`${e.srAt}T00:00:00Z`)) / 864e5 >= 3;
  }
  return false;
}

// The sweep for pages already built: up to `budget` titles a run (one TMDB title serves every
// edition of it), visible pages only, airing series refreshed every 3 days. Each edition's page
// gets the result as a fact update (lib/factsq.js), so the render draws it.
async function sweepSeries(manifest, { budget = 300, tmdb, queueFacts, hidden = () => false, now = Date.now(), pause = null } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const byTitle = new Map();   // "kind:id" -> [[code, slug, entry], ...]
  for (const [code, pages] of Object.entries(manifest || {})) {
    if (!pages || typeof pages !== "object") continue;
    for (const [slug, e] of Object.entries(pages)) {
      if (!e || typeof e !== "object" || !e.tmdbId || hidden(code, slug, e) || !seriesSweepDue(e, now)) continue;
      const key = `${e.kind === "tv" ? "tv" : "movie"}:${e.tmdbId}`;
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push([code, slug, e]);
    }
  }
  // Airing series first (their guides go stale), then the rest.
  const keys = [...byTitle.keys()].sort((a, b) => (b.startsWith("tv:") ? 1 : 0) - (a.startsWith("tv:") ? 1 : 0));
  const res = { due: keys.length, fetched: 0, episodes: 0, franchise: 0, failed: 0 };
  for (const key of keys.slice(0, budget)) {
    const [kind, id] = key.split(":");
    let got;
    try { got = await seriesFactsFor(kind, id, tmdb, now); } catch { res.failed++; continue; }
    res.fetched++;
    if (got.episodes) res.episodes++;
    if (got.franchise) res.franchise++;
    for (const [code, slug, e] of byTitle.get(key)) {
      queueFacts(code, slug, { episodes: got.episodes || undefined, franchise: got.franchise || undefined,
        ...(got.backdropPath ? { backdropPath: got.backdropPath, backdrop: `https://image.tmdb.org/t/p/w780${got.backdropPath}` } : {}) });
      e.srv = SERIES_SWEEP_VERSION; e.srAt = today;
      if (got.episodes && got.episodes.next) e.epNext = got.episodes.next.date; else delete e.epNext;
    }
    if (pause) await pause(120);
  }
  return res;
}

module.exports = { FRANCHISE_KEYWORD, fitFromData, sweepSeries, SERIES_SWEEP_VERSION, episodeFaqs, episodesFrom, episodesHtml, franchiseFrom, franchiseSiblings,
  readSeriesMark, seasonToFetch, seriesFactsFor, seriesKnowRows, seriesMark, seriesName, seriesSweepDue, universeName };
