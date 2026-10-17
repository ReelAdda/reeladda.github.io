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

const { regionalTheatricalDate } = require("./enrich.js");
const { dedupeProviders, langCode, langName } = require("./rules.js");

// Pure: the facts TMDB gives for one edition, from /movie|tv/{id} with watch/providers (and
// release_dates for films) appended. Same rules as the build (lib/enrich.js): subscription
// platforms deduped, at most four; a film's date is the edition's theatrical date, else TMDB's.
function tmdbTruth(d, kind, cfg, asOf) {
  if (!d) return null;
  const region = (cfg && (cfg.watchRegion || cfg.region)) || "IN";
  const wp = (d["watch/providers"] && d["watch/providers"].results && d["watch/providers"].results[region]) || {};
  const tv = kind === "tv";
  const released = tv ? String(d.first_air_date || "").slice(0, 10)
    : (regionalTheatricalDate(d, (cfg && cfg.region) || region) || String(d.release_date || "").slice(0, 10));
  return {
    at: asOf,
    providers: dedupeProviders((wp.flatrate || []).map((p) => p.provider_name)).slice(0, 4),
    rentBuy: dedupeProviders([...(wp.rent || []), ...(wp.buy || [])].map((p) => p.provider_name)).slice(0, 3),
    ...(released ? { released } : {}),
    ...((tv ? d.name : d.title) ? { title: tv ? d.name : d.title } : {}),
    ...(tmdbLanguage(d) ? { language: tmdbLanguage(d) } : {}),
  };
}

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
  return { item: out, changed };
}

module.exports = { applyTruth, tmdbLanguage, tmdbTruth };
