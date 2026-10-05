// ============================================================================
// fcscore.js — the FilmyChill Score: FilmyChill's own verdict, computed every build from
// two signals the pipeline already collects. Fully automated; nobody writes it by hand.
//
//   AUDIENCE  TMDB rating, counted only with 50+ ratings (below that it isn't an audience):
//               Loved ★7.5+   ·  Liked ★6.5–7.4  ·  Lukewarm below ★6.5
//   CRITICS   the reception tone of the film's Wikipedia article (lib/editorial.js
//             readCritics: the stated consensus, else the median of the critics' ratings
//             it lists), attached as item.criticsTone under the same release-week gate as
//             the critics' take (lifted at five listed reviews): acclaim/positive · mixed ·
//             negative.
//             Deliberately the TONE, never a Rotten Tomatoes / Metacritic percentage:
//             those are other companies' proprietary scores.
//
// Both signals -> the 3×3 table below. One signal -> the score uses it and says which.
// Neither (or critics alone and split) -> no score: the page says "too early", never guesses.
// Licence-clean (no IMDb data), so it survives monetisation unchanged.
// ============================================================================
"use strict";

const SCORE_MIN_VOTES = 50;

// EARLY READS (Sept 2026). An older film with 15–49 ratings may never reach 50 — TMDB votes
// barely grow once a film is a few months old — so "not enough ratings" would be permanent.
// Past its release window it gets a tentative score instead, built so a small sample can't
// mislead: the rating is pulled toward an average film (a Bayesian average — the fewer the
// votes, the stronger the pull), it can never be "Must watch", and it is always labelled
// "early read" with its vote count.
const EARLY_READ_MIN_VOTES = 15;
const EARLY_READ_AGE_DAYS = 60;
const PRIOR_MEAN = 6.5;    // "an average film" on TMDB's scale
const PRIOR_WEIGHT = 50;   // how many average votes a small sample is blended with

function releasedDaysAgo(item, nowMs) {
  const d = String((item && (item.freshDate || item.released)) || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return (nowMs - Date.parse(d)) / 864e5;
}
function shrunkRating(rating, votes) {
  return (votes * rating + PRIOR_WEIGHT * PRIOR_MEAN) / (votes + PRIOR_WEIGHT);
}
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

const tierOf = (r) => (r >= 7.5 ? "Loved" : r >= 6.5 ? "Liked" : "Lukewarm");

// Audience tier, or null. With 50+ ratings the rating is taken as it is; an older film with
// 15–49 gets an early read on the shrunk rating (see above).
function audienceRead(item, nowMs = Date.now()) {
  if (!item || item.rating == null || !Number.isFinite(Number(item.rating))) return null;
  const votes = Number(item.votes || 0), r = Number(item.rating);
  if (votes >= SCORE_MIN_VOTES) return { tier: tierOf(r), early: false };
  const age = releasedDaysAgo(item, nowMs);
  if (votes >= EARLY_READ_MIN_VOTES && age != null && age >= EARLY_READ_AGE_DAYS) {
    return { tier: tierOf(shrunkRating(r, votes)), early: true };
  }
  return null;
}
function audienceTier(item, nowMs) {
  const a = audienceRead(item, nowMs);
  return a ? a.tier : null;
}

function criticsTier(item) {
  const t = item && item.criticsTone;
  if (t === "acclaim" || t === "positive") return "positive";
  if (t === "mixed") return "mixed";
  if (t === "negative") return "negative";
  return null;
}

// Early reads, audience only: same tiers, softer wording, never "Must watch".
// Worded by COUNT, not time: these films are months old, so "early" would be false.
const EARLY_AUDIENCE_ONLY = {
  Loved: ["Worth a watch", "The few who rated it love it."],
  Liked: ["Worth a watch", "The few who rated it like it."],
  Lukewarm: ["Skip", "The few who rated it are lukewarm on it."],
};

// Pure: the score for one item, or null when there isn't enough to say.
function fcScore(item, nowMs = Date.now()) {
  const read = audienceRead(item, nowMs);
  const audience = read ? read.tier : null;
  const critics = criticsTier(item);
  let hit = null, basis = null;
  if (audience && critics) { hit = TABLE[audience][critics]; basis = "both"; }
  else if (audience) { hit = (read.early ? EARLY_AUDIENCE_ONLY : AUDIENCE_ONLY)[audience]; basis = "audience"; }
  else if (critics) { hit = CRITICS_ONLY[critics] || null; basis = "critics"; }
  if (!hit) return null;
  const out = { verdict: hit[0], reason: hit[1], audience, critics, basis };
  if (read && read.early) {
    if (out.verdict === "Must watch") out.verdict = "Worth a watch"; // thin data never earns the top verdict
    out.early = true;
    out.votes = Number(item.votes);
  }
  return out;
}

// The label every surface shows next to a few-ratings score: "Based on 21 ratings".
// (Internally still called an "early read"; readers never see the word "early" on a film
// that isn't new.)
function earlyReadLabel(s) {
  return s && s.early ? `Based on ${Number(s.votes || 0).toLocaleString("en-IN")} ratings` : "";
}

// THE RULE FOR ALL RATING WORDING (Sept 2026): words about TIME — "too early", "just
// released", "still settling", "yet", "NEW" — only for a film that is actually new (out
// within EARLY_DAYS, or not out). For anything older, say what's true about the COUNT
// ("few ratings", "only 21 ratings"). isRecent() is the one test every surface uses.
function isRecent(item, nowMs = Date.now()) {
  const age = releasedDaysAgo(item, nowMs);
  return age != null && age < EARLY_DAYS;
}
// How many ratings this film needs before it can be scored at all.
function scoreNeed(item, nowMs = Date.now()) {
  const age = releasedDaysAgo(item, nowMs);
  return age != null && age >= EARLY_READ_AGE_DAYS ? EARLY_READ_MIN_VOTES : SCORE_MIN_VOTES;
}

// What to say when there is NO score. "Too early" is only true for something that has just
// come out; a film released in July with 21 ratings isn't early, it's under-rated — saying
// "too early" there reads as broken (Sept 2026). So: recent → "Too early"; otherwise say
// plainly what's missing, with the real vote count.
const EARLY_DAYS = 28;
function noScoreText(item, nowMs = Date.now()) {
  const recent = isRecent(item, nowMs);
  if (recent) {
    // Reviews already in but split (a mixed reception scores nothing on its own, and the
    // audience half isn't there yet): say so, rather than claim there are no reviews.
    if (criticsTier(item) === "mixed") return { label: "Too early", why: "Critics are split; audience ratings are still coming in." };
    return { label: "Too early", why: "Just released — not enough ratings or reviews yet." };
  }
  const votes = Number((item && item.votes) || 0);
  const n = votes.toLocaleString("en-IN");
  const who = votes === 1 ? "1 person has" : `${n} people have`;
  // Older films can score from 15 ratings; newer ones need 50.
  const need = scoreNeed(item, nowMs);
  if (criticsTier(item) === "mixed") {
    return { label: "Not enough ratings", why: `Critics are split, and ${votes ? `only ${who}` : "nobody has"} rated it — the score needs ${need} ratings to decide.` };
  }
  // Enough votes but no usable rating (TMDB sometimes has a count and no average): never
  // claim "only 111 people … needs 15".
  if (votes >= need) return { label: "Not enough ratings", why: "There's no usable audience rating for it on TMDB yet, and no settled critics' reception." };
  // (No "so far" here: this film isn't new, so don't imply more ratings are on the way.)
  if (votes > 0) return { label: "Not enough ratings", why: `Only ${who} rated it — the score needs at least ${need}.` };
  return { label: "Not enough ratings", why: "Nobody has rated it yet, and there's no settled critics' reception." };
}

// Attach item.fcScore to every listed title in every market (theatres + streaming).
// Every list in a market's data that gets film pages: the homepage lists AND the extra pools
// (ottExtra, per-language pools) that generatePages also writes pages for. Scoring only the
// homepage lists left pool pages unscored — one with 3,492 ratings was told it "needs at
// least 15" (Sept 2026).
function itemLists(data) {
  if (!data) return [];
  const out = [data.theatres, data.ott, data.ottExtra, data.comingSoon];
  for (const p of Object.values(data.langPools || {})) if (p) out.push(p.theatres, p.ott);
  return out.filter(Array.isArray);
}

// ONE VERDICT PER FILM (Oct 2026). `item.verdict` used to be the rating-band label from
// rules.js (audience only, 10+ votes) while pages showed the FilmyChill Score (audiences +
// critics, 50+ votes), so data.json and llms-full.txt contradicted the page: Runner was
// "Must watch" there and "Worth a watch" everywhere a person could see. Every surface that
// reads item.verdict — data.json, llms-full.txt, the RSS feed, hub FAQs, the embed widget —
// now carries the score's verdict, or the page's own "no verdict yet" wording when there is
// no score (an existing no-verdict phrase is kept, never a verdict the score withholds).
function verdictFor(item, s, nowMs = Date.now()) {
  if (s) return s.verdict;
  const v = item && item.verdict;
  if (v && /verdict soon|enough ratings/i.test(v)) return v;
  return isRecent(item, nowMs) ? "Just released — verdict soon" : "Not enough ratings";
}

// Attach item.fcScore to every title that gets a film page, in every market.
// `toneFor(imdbId, item)` fills the critics tone from the takes cache for titles the takes step
// left without one; it gets the item so it can keep the same release-week gate.
function attachFcScores(dataByCode, { toneFor = null, nowMs = Date.now() } = {}) {
  let scored = 0, total = 0;
  for (const data of Object.values(dataByCode || {})) {
    for (const list of itemLists(data)) {
      for (const item of list) {
        if (!item) continue;
        total++;
        if (!item.criticsTone && toneFor && item.imdbId) {
          const t = toneFor(item.imdbId, item);
          if (t) item.criticsTone = t;
        }
        const s = fcScore(item, nowMs);
        if (s) { item.fcScore = s; scored++; } else delete item.fcScore;
        item.verdict = verdictFor(item, s, nowMs);
      }
    }
  }
  return { scored, total };
}

module.exports = {
  isRecent,
  verdictFor,
  scoreNeed,
  itemLists,
  EARLY_READ_AGE_DAYS,
  EARLY_READ_MIN_VOTES,
  earlyReadLabel,
  shrunkRating,
  EARLY_DAYS,
  noScoreText,
  LEVELS,
  SCORE_MIN_VOTES,
  attachFcScores,
  audienceTier,
  criticsTier,
  fcScore,
};
