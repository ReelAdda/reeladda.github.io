"use strict";

const { pickVariant, runtimePhrase } = require("./whywatch.js");

// ============================================================================
// THE STRUCTURED FIT BLOCK — "Why / Skip if / Best for".
//
// Sibling to whyWatch() (lib/whywatch.js), not a replacement. whyWatch writes PROSE
// answering "what am I signing up for". This writes three SCANNABLE lines answering
// "should I press play", in a fixed order, with a fixed shape, on every page that
// qualifies. That fixed shape is the point: a recognisable house format is what makes
// a verdict feel like a judgement rather than a database row.
//
// The same three rules as whyWatch, because they are what keep this from becoming
// generated filler:
//   1. Nothing is asserted that isn't in the data. We know a film's genre, runtime,
//      certificate, rating and vote count. We do NOT know that the performances are
//      great, so "Why" never says so — that claim belongs to the critics' take, which
//      is sourced, and which sits above this block.
//   2. No line restates the verdict label or the critics' take.
//   3. Thin signal returns null. A missing block beats a generic one: an invented
//      "Skip if" stamped across 500 pages is exactly the scaled-content pattern this
//      site's whole architecture exists to avoid.
//
// Everything here is a lookup or a band check — no free generation. Two films with the
// same shape get the same rubric applied, and pickVariant (id-keyed, stable across
// builds) chooses the wording so the pages don't read as one template.
// ============================================================================

// "Skip if" is the line that earns the trust. Every other row here is obtainable from a
// database; a site that tells you NOT to watch something is visibly not optimising for
// the click. So each entry is the honest inverse of the genre's defining trait — the
// reason a reasonable person would bounce off a GOOD film of this kind. Never a euphemism
// for "it's bad": quality is the verdict's job, fit is this block's job.
const GENRE_SKIP = {
  "action": ["you want a slower, character-led story", "you'd rather the plot moved on people than on set pieces"],
  "adventure": ["you want something grounded and small-scale", "sprawling quest structure isn't what you're after"],
  "animation": ["you won't get past the format", "you want live action tonight"],
  "comedy": ["you want real stakes underneath the jokes", "you're in the mood for something with weight"],
  "crime": ["you dislike slow-burn procedural pacing", "you want resolution faster than the genre gives it"],
  "documentary": ["you want a story rather than an argument", "you'd rather not be taught something tonight"],
  "drama": ["you want plot momentum over character work", "you're after something that moves faster than it feels"],
  "family": ["you want something with an adult edge", "you're watching alone and want more bite"],
  "fantasy": ["you'd rather not do the world-building work", "invented rules and maps put you off"],
  "history": ["you want pace ahead of period detail", "you'd rather not keep track of who's who"],
  "horror": ["dread and jump scares aren't what you want tonight", "you want to sleep afterwards"],
  "music": ["the songs aren't the reason you'd watch", "you want narrative over performance"],
  "mystery": ["you want answers early rather than a slow reveal", "being kept in the dark frustrates you"],
  "romance": ["you find romantic plots hard to invest in", "you want the central question to be something other than whether they end up together"],
  "science fiction": ["you'd rather not do the world-building work", "you want something set in a world you already know"],
  "thriller": ["you'd rather not sit with tension for the whole runtime", "you want to relax rather than be wound up"],
  "war": ["you want to avoid sustained combat violence", "you're not up for something heavy"],
  "western": ["the genre's rhythms don't work for you", "you want something with a faster pulse"],
  // TV-side TMDB genre names, which differ from the movie list.
  "action & adventure": ["you want a slower, character-led story", "set pieces aren't the draw for you"],
  "sci-fi & fantasy": ["you'd rather not do the world-building work", "invented rules and maps put you off"],
  "war & politics": ["you want to avoid heavy subject matter", "procedural politics isn't your thing"],
  "kids": ["you want something with an adult edge", "you're watching alone"],
  "reality": ["you want scripted storytelling", "constructed drama isn't what you're after"],
  "soap": ["you want a story that ends", "open-ended melodrama isn't the mood"],
};

// Non-genre skips that OUTRANK the genre line, because they'd change the decision more.
// Only one skip line is ever shown — the most decision-relevant one wins.
function overrideSkip(item) {
  const rt = runtimePhrase(item.runtime);
  if (!(item.providers || []).length && (item.rentBuy || []).length) {
    return pickVariant(item, [
      "you're not willing to pay per view for it",
      "you were hoping a subscription you already have would cover it",
    ]);
  }
  if (item.kind === "tv" && (item.seasons || 0) > 2) {
    return pickVariant(item, [
      "you don't want to start something several seasons deep",
      "a backlog this size is the opposite of what you're after",
    ]);
  }
  if (rt && rt.band === "epic") {
    return pickVariant(item, [
      "you don't have a clear three hours",
      "you want something you can finish before a reasonable bedtime",
    ]);
  }
  return null;
}

function skipLine(item) {
  const over = overrideSkip(item);
  if (over) return over;
  const genres = String(item.genre || "").split("/").map((g) => g.trim().toLowerCase()).filter(Boolean);
  for (const g of genres) {
    if (GENRE_SKIP[g]) return pickVariant(item, GENRE_SKIP[g]);
  }
  return null;
}

// "Best for" = who + when, both derived. The certificate decides who can be in the room;
// the runtime band decides what kind of evening it needs. Nothing about mood, because we
// have no mood signal and inventing one is how this becomes horoscope copy.
function bestForLine(item) {
  const rt = runtimePhrase(item.runtime);
  const c = String(item.cert || "").toUpperCase();
  const adult = /^(A|R|NC-17|18)$/.test(c);
  const family = /^(U|G|PG|TV-G|TV-Y|TV-PG)$/.test(c);
  const genres = String(item.genre || "").split("/").map((g) => g.trim().toLowerCase());
  const tense = genres.some((g) => /horror|thriller/.test(g));

  if (item.kind === "tv") {
    const n = item.seasons || 0;
    if (n > 2) return pickVariant(item, ["a long run rather than a single sitting", "a proper binge, once you've got the weeks for it"]);
    if (family) return pickVariant(item, ["watching together as a household", "an evening the whole house can share"]);
    return pickVariant(item, ["an episode-a-night rhythm", "a slow burn across the week"]);
  }
  if (adult && tense) return pickVariant(item, ["a late night with the lights off", "watching alone or with someone who won't talk through it"]);
  if (adult) return pickVariant(item, ["a solo watch or an evening with adults", "a night when you don't need it to be for everyone"]);
  if (family && rt && rt.band === "short") return pickVariant(item, ["a weekend afternoon with the family", "a family evening that doesn't run late"]);
  if (family) return pickVariant(item, ["a weekend watch with the family", "an evening with the household together"]);
  if (!rt) return null;
  if (rt.band === "short") return pickVariant(item, ["a weeknight", "a night you still want to end early"]);
  if (rt.band === "long") return pickVariant(item, ["an evening with no interruptions", "a night you can give it your full attention"]);
  if (rt.band === "epic") return pickVariant(item, ["a free weekend evening", "a night with nothing after it"]);
  return pickVariant(item, ["an ordinary evening in", "a normal night, nothing to plan around"]);
}

// "Why" is the only line carrying a positive claim, so it is the most tightly bound:
// it says what the RATING says and how much weight sits behind it, and nothing else.
// It never characterises the film's craft — that claim is the critics' take's to make,
// with a source. Requires a settled sample: below 50 ratings the number isn't a finding
// yet, and lib/whywatch.js already says so in prose.
const WHY_MIN_VOTES = 50;

function whyLine(item) {
  const useImdb = item.imdbVotes != null && item.imdbRating != null;
  const votes = useImdb ? item.imdbVotes : item.votes;
  const rating = useImdb ? item.imdbRating : item.rating;
  if (rating == null || !votes || votes < WHY_MIN_VOTES) return null;
  const r = Number(rating).toFixed(1);
  const n = Number(votes).toLocaleString("en-IN");
  const heavy = votes >= 5000;
  if (rating >= 7.5) {
    return heavy
      ? pickVariant(item, [
        `It rates ${r}/10 across ${n} ratings — among the strongest scores on this week's list, and settled enough to trust.`,
        `A ${r}/10 that holds up over ${n} ratings, which puts it at the top of the current list.`,
      ])
      : pickVariant(item, [
        `It rates ${r}/10 on ${n} ratings so far — a strong early showing.`,
        `Currently ${r}/10 from ${n} ratings, which is a good sign this early.`,
      ]);
  }
  if (rating >= 6.5) {
    return heavy
      ? pickVariant(item, [
        `${r}/10 over ${n} ratings — solidly liked rather than loved, and the number isn't going to move.`,
        `It sits at ${r}/10 across ${n} ratings: dependable, not remarkable.`,
      ])
      : pickVariant(item, [`${r}/10 from ${n} ratings — well received so far, on a modest sample.`]);
  }
  if (rating >= 5.5) {
    return pickVariant(item, [
      `${r}/10 across ${n} ratings — a middling reception, so this one depends on whether the premise appeals to you.`,
      `At ${r}/10 from ${n} ratings, audiences are split; the genre fit matters more than the score here.`,
    ]);
  }
  return pickVariant(item, [
    `${r}/10 across ${n} ratings — audiences haven't taken to it, so go in curious rather than expectant.`,
    `It's rated ${r}/10 on ${n} ratings, which is a weak reception by any reading.`,
  ]);
}

// Public: { why, skipIf, bestFor } or null.
// Null whenever fewer than two of the three lines survive — one lonely row is not a
// house format, it's a stray sentence, and it reads worse than the prose block above it.
function watchFit(item) {
  if (!item) return null;
  const why = whyLine(item);
  const skipIf = skipLine(item);
  const bestFor = bestForLine(item);
  const present = [why, skipIf, bestFor].filter(Boolean).length;
  if (present < 2) return null;
  return { why, skipIf, bestFor };
}

module.exports = {
  bestForLine,
  overrideSkip,
  skipLine,
  watchFit,
  whyLine,
  GENRE_SKIP,
  WHY_MIN_VOTES,
};
