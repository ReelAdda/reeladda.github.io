// ============================================================================
// score.js — the FilmyChill confidence signal.
//
// The site shows TMDB's rating as-is, which quietly misleads: an 8.0 from 13 votes reads
// exactly like an 8.2 from 1,241, and can even sort above it. This does NOT invent a new
// number — the score stays TMDB's, honestly. What it adds is a judgment TMDB doesn't
// express: how much that number can be trusted, from the vote count we already fetch.
//
// Two things come out:
//   - a confidence TIER (solid / early / too-few) with a plain-text label, never colour alone
//   - a confidence-weighted RANK value, used only for ordering, so a thin high score can't
//     leapfrog a proven one. The DISPLAYED number is never the weighted one.
//
// Thresholds are tuned to THIS site's real vote densities (median ~820, p25 ~120), which run
// far lower than Hollywood-only databases — so "solid" here is calibrated to Indian-film
// reality, not a generic cutoff.
// ============================================================================
"use strict";

// Minimum votes before we'll show a number at all. Below this, TMDB's average is noise.
const MIN_VOTES = 10;
// A "solid" score has enough ratings that it won't move much. Set near this site's median.
const SOLID_VOTES = 300;

// Bayesian shrinkage toward the pooled mean C, with weight m. A film with few votes is
// pulled toward average; a film with many keeps its own score. This is the same idea behind
// every credible weighted-rating system (IMDb's Top 250 uses it) — it's what stops 13 votes
// from ranking like 13,000. Used for ORDERING only.
const PRIOR_MEAN = 6.5;   // the pooled average sits near here on a 10-point scale
const PRIOR_WEIGHT = 150; // ~ the p25 vote count: below it, the prior dominates; above, the film does

function ratingOf(item) {
  const useImdb = item && item.imdbRating != null && item.imdbVotes != null;
  const rating = useImdb ? item.imdbRating : (item ? item.rating : null);
  const votes = useImdb ? item.imdbVotes : (item ? item.votes : null);
  return { rating: rating == null ? null : Number(rating), votes: Number(votes) || 0 };
}

// Confidence tier. Returns { key, label, pct } — pct drives the little confidence bar (0..1).
// label is mandatory and carries the meaning so we never rely on colour alone.
function confidenceTier(votes) {
  if (!votes || votes < MIN_VOTES) return { key: "few", label: "Too few to call", pct: 0.06 };
  if (votes < SOLID_VOTES) return { key: "early", label: "Early — still settling", pct: Math.max(0.18, Math.min(0.55, votes / SOLID_VOTES)) };
  // Solid: scale the bar with a log so 300 and 3,000 don't look identical, capped at ~0.97.
  const pct = 0.6 + 0.37 * Math.min(1, Math.log10(votes / SOLID_VOTES) / Math.log10(30));
  return { key: "solid", label: "Solid", pct: Math.min(0.97, pct) };
}

// Ordering value only — never displayed. Confidence-weighted so a thin high score sinks.
function rankValue(item) {
  const { rating, votes } = ratingOf(item);
  if (rating == null || votes < MIN_VOTES) return -1; // unranked films sort last among rated
  return (votes * rating + PRIOR_WEIGHT * PRIOR_MEAN) / (votes + PRIOR_WEIGHT);
}

// The full signal for a film. displayRating is TMDB's own number (or null); tier is the
// trust flag; provisional marks a shown-but-thin score so the UI can append a caveat.
function filmScore(item) {
  const { rating, votes } = ratingOf(item);
  const tier = confidenceTier(votes);
  const show = rating != null && votes >= MIN_VOTES;
  return {
    displayRating: show ? Number(rating.toFixed(1)) : null,
    votes,
    tier: tier.key,               // "solid" | "early" | "few"
    tierLabel: tier.label,        // human text, always present
    confidencePct: tier.pct,      // 0..1 for the bar
    provisional: show && tier.key !== "solid",
    rank: rankValue(item),
  };
}

// Sort a list best-first by confidence-weighted rank, WITHOUT mutating the input.
function rankFilms(items) {
  return [...(items || [])]
    .map((it) => ({ it, r: rankValue(it) }))
    .sort((a, b) => b.r - a.r)
    .map((x) => x.it);
}

module.exports = {
  MIN_VOTES, SOLID_VOTES, confidenceTier, rankValue, filmScore, rankFilms, ratingOf,
};
