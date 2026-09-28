// ============================================================================
// fcscore.js — the FilmyChill Score: FilmyChill's own verdict, computed every build from
// two signals the pipeline already collects. Fully automated; nobody writes it by hand.
//
//   AUDIENCE  TMDB rating, counted only with 50+ ratings (below that it isn't an audience):
//               Loved ★7.5+   ·  Liked ★6.5–7.4  ·  Lukewarm below ★6.5
//   CRITICS   the reception tone of the film's Wikipedia article (lib/editorial.js
//             analyzeReception), attached as item.criticsTone under the same release-week
//             gate as the critics' take: acclaim/positive · mixed · negative.
//             Deliberately the TONE, never a Rotten Tomatoes / Metacritic percentage:
//             those are other companies' proprietary scores.
//
// Both signals -> the 3×3 table below. One signal -> the score uses it and says which.
// Neither (or critics alone and split) -> no score: the page says "too early", never guesses.
// Licence-clean (no IMDb data), so it survives monetisation unchanged.
// ============================================================================
"use strict";

const SCORE_MIN_VOTES = 50;
const LEVELS = ["Must watch", "Worth a watch", "Skip"];

// Rows: audience tier. Columns: critics. [verdict, reason]
const TABLE = {
  Loved: {
    positive: ["Must watch", "Audiences and critics agree."],
    mixed: ["Worth a watch", "Audiences love it; critics are split."],
    negative: ["Worth a watch", "Audiences rate it far above critics."],
  },
  Liked: {
    positive: ["Worth a watch", "Critics are warmer than audiences."],
    mixed: ["Worth a watch", "A solid watch; nobody's raving."],
    negative: ["Worth a watch", "Audiences like it more than critics."],
  },
  Lukewarm: {
    positive: ["Worth a watch", "Critics like it more than audiences."],
    mixed: ["Skip", "Neither audiences nor critics are sold."],
    negative: ["Skip", "Audiences and critics agree: skip it."],
  },
};

// Worded neutrally: "no critics signal" is as often an older title Wikipedia never
// summarised as a new one whose reviews are pending, so never claim they're "coming".
const AUDIENCE_ONLY = {
  Loved: ["Must watch", "Audiences love it."],
  Liked: ["Worth a watch", "Audiences like it."],
  Lukewarm: ["Skip", "Audiences are lukewarm on it."],
};

const CRITICS_ONLY = {
  positive: ["Worth a watch", "Critics are positive; audience ratings are still coming in."],
  negative: ["Skip", "Critics are negative; audience ratings are still coming in."],
  // mixed alone is inconclusive: no score.
};

function audienceTier(item) {
  if (!item || item.rating == null || !Number.isFinite(Number(item.rating))) return null;
  if (!item.votes || item.votes < SCORE_MIN_VOTES) return null;
  const r = Number(item.rating);
  return r >= 7.5 ? "Loved" : r >= 6.5 ? "Liked" : "Lukewarm";
}

function criticsTier(item) {
  const t = item && item.criticsTone;
  if (t === "acclaim" || t === "positive") return "positive";
  if (t === "mixed") return "mixed";
  if (t === "negative") return "negative";
  return null;
}

// Pure: the score for one item, or null when there isn't enough to say.
function fcScore(item) {
  const audience = audienceTier(item);
  const critics = criticsTier(item);
  let hit = null, basis = null;
  if (audience && critics) { hit = TABLE[audience][critics]; basis = "both"; }
  else if (audience) { hit = AUDIENCE_ONLY[audience]; basis = "audience"; }
  else if (critics) { hit = CRITICS_ONLY[critics] || null; basis = "critics"; }
  if (!hit) return null;
  return { verdict: hit[0], reason: hit[1], audience, critics, basis };
}

// Attach item.fcScore to every listed title in every market (theatres + streaming).
function attachFcScores(dataByCode) {
  let scored = 0, total = 0;
  for (const data of Object.values(dataByCode || {})) {
    for (const list of [data && data.theatres, data && data.ott]) {
      for (const item of list || []) {
        if (!item) continue;
        total++;
        const s = fcScore(item);
        if (s) { item.fcScore = s; scored++; } else delete item.fcScore;
      }
    }
  }
  return { scored, total };
}

module.exports = {
  LEVELS,
  SCORE_MIN_VOTES,
  attachFcScores,
  audienceTier,
  criticsTier,
  fcScore,
};
