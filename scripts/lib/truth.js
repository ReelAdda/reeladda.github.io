// ============================================================================
// truth.js — what TMDB says a frozen page should show today, and the page made to agree
// (Oct 2026).
//
// The data accuracy check (scripts/accuracy.js) found frozen pages disagreeing with TMDB in
// three ways the sweeps never corrected: a platform list that changed while the film stayed
// streaming (A Minecraft Movie, Japan: U-NEXT on the page, Prime Video and Hulu on TMDB), a
// release date that moved (Shakti Shalini: 24 Dec on the page, postponed to 12 Mar 2027), and
// rent/buy options a waiting page never showed. Every sweep already fetches the film from
// TMDB, so each records what it saw in the manifest (`e.truth`), and lib/migrate.js applies it
// when it renders the page from its facts. No extra API calls.
// ============================================================================
"use strict";

const { isReRelease, regionalTheatricalDate } = require("./enrich.js");
const { dedupeProviders, langCode, langName } = require("./rules.js");

// Pure: the facts TMDB gives for one edition, from /movie|tv/{id} with watch/providers (and
// release_dates for films) appended. Same rules as the build (lib/enrich.js): subscription
// platforms deduped, at most four; a film's date is the edition's theatrical date, else TMDB's.
function tmdbTruth(d, kind, cfg, asOf) {
  if (!d) return null;
  const region = (cfg && (cfg.watchRegion || cfg.region)) || "IN";
  const wp = (d["watch/providers"] && d["watch/providers"].results && d["watch/providers"].results[region]) || {};
  const tv = kind === "tv";
  const regional = tv ? null : regionalTheatricalDate(d, (cfg && cfg.region) || region);
  const released = tv ? String(d.first_air_date || "").slice(0, 10)
    : ((regional && !isReRelease(regional, d.release_date)) ? regional : String(d.release_date || "").slice(0, 10));
  return {
    at: asOf,
    providers: dedupeProviders((wp.flatrate || []).map((p) => p.provider_name)).slice(0, 4),
    rentBuy: dedupeProviders([...(wp.rent || []), ...(wp.buy || [])].map((p) => p.provider_name)).slice(0, 3),
    ...(released ? { released } : {}),
    ...((tv ? d.name : d.title) ? { title: tv ? d.name : d.title } : {}),
    ...(tmdbLanguage(d) ? { language: tmdbLanguage(d) } : {}),
    ...credits(d, tv),
  };
}

// Pure: runtime, genres, director and the top-billed cast, from the same response (credits
// appended). Only what TMDB actually returned; the page keeps its own for anything missing.
function credits(d, tv) {
  const out = {};
  const runtime = tv ? ((d.episode_run_time || [])[0] || null) : (d.runtime || null);
  if (runtime) out.runtime = runtime;
  const g = (d.genres || []).map((x) => x.name).filter(Boolean).slice(0, 2);
  if (g.length) out.genre = g.join(" / ");
  const crew = (d.credits && d.credits.crew) || [];
  const dirs = tv ? (d.created_by || []).map((x) => x.name) : crew.filter((x) => x.job === "Director").map((x) => x.name);
  if (dirs.length) out.director = dirs.slice(0, 2).join(", ");
  const cast = ((tv ? d.aggregate_credits && d.aggregate_credits.cast : d.credits && d.credits.cast) || []).map((x) => x.name).filter(Boolean).slice(0, 6);
  if (cast.length) out.cast = cast;
  return out;
}

const nm = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");

// Pure: the film's language as the site names it (the build's own override list applies).
// The Weight (2026), an Ethan Hawke film, was "Portuguese" on five editions because TMDB had
// it wrong the week those pages were built (accuracy check, 17 Oct 2026).
function tmdbLanguage(d) {
  if (!d || !d.original_language) return null;
  const n = langName(langCode(d));
  return n && !/^[a-z]{2,3}$/.test(n) ? n : null;
}

// Pure: the item with TMDB's facts applied, and which fields moved. An empty platform list is
// never applied: a film leaving streaming goes through the departure sweep's two confirming
// checks, so one empty answer (often a JustWatch outage) can't strip a page.
function applyTruth(item, truth) {
  if (!item || !truth) return { item, changed: [] };
  const out = { ...item }, changed = [];
  const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
  if (truth.providers && truth.providers.length && !same(out.providers, truth.providers)) {
    out.providers = truth.providers; out.platform = truth.providers[0]; changed.push("providers");
  }
  if (Array.isArray(truth.rentBuy) && !same(out.rentBuy, truth.rentBuy)) { out.rentBuy = truth.rentBuy; changed.push("rentBuy"); }
  if (truth.released && truth.released !== out.released) { out.released = truth.released; changed.push("released"); }
  if (truth.title && truth.title !== out.title) { out.title = truth.title; changed.push("title"); }
  if (truth.language && truth.language !== out.language) { out.language = truth.language; changed.push("language"); }
  // Credits and runtime (Oct 2026 audit: the accuracy check found them wrong but nothing fixed
  // them). Applied only on a real disagreement, the same tests the accuracy check uses, so a
  // page whose facts are merely ordered differently is left alone.
  if (truth.runtime && out.runtime && Math.abs(Number(out.runtime) - truth.runtime) > 5) { out.runtime = truth.runtime; changed.push("runtime"); }
  if (truth.director && out.director && !String(out.director).split(", ").some((x) => truth.director.split(", ").some((y) => nm(x) === nm(y)))) { out.director = truth.director; changed.push("director"); }
  const lead = Array.isArray(out.cast) ? out.cast[0] : null;
  if (Array.isArray(truth.cast) && truth.cast.length && lead && !truth.cast.some((x) => nm(x) === nm(lead))) {
    out.cast = truth.cast;
    // Photos only for people still in the cast; no photo beats someone else's face.
    if (Array.isArray(out.castPics)) out.castPics = out.castPics.filter((p) => truth.cast.some((x) => nm(x) === nm(p.name)));
    changed.push("cast");
  }
  if (truth.genre && out.genre) {
    const mine = String(out.genre).split(" / "), theirs = truth.genre.split(" / ");
    if (!mine.every((g) => theirs.some((t) => nm(t).includes(nm(g)) || nm(g).includes(nm(t))))) { out.genre = truth.genre; changed.push("genre"); }
  }
  return { item: out, changed };
}

module.exports = { applyTruth, tmdbLanguage, tmdbTruth };
