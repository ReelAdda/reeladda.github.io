"use strict";

const { fmtRuntime } = require("./core.js");

// ============================================================================
// "SHOULD YOU SPEND 2 HOURS ON THIS?" — the fit line.
//
// Every film page carries the same architecture, which is the thin-content risk: hundreds
// of pages whose only unique text is a title and a synopsis. This composes a short,
// decision-useful paragraph from signal we ALREADY fetch — runtime, genre pair, language,
// certification, rating confidence, format, and how you'd actually pay for it.
//
// Three rules, because a fit line that lies is worse than no fit line:
//   1. Never assert anything not in the data. We know a film is 142 minutes of Tamil
//      romance rated A; we do NOT know its plot is "straightforward", so we never say so.
//   2. Never restate the verdict or the critics' take — those blocks are right above it.
//      This answers a different question: what are you signing up for?
//   3. Return null when the signal is too thin. A page with no fit line beats a page with
//      a generic one; generic lines stamped across 500 pages ARE the duplication problem.
// ============================================================================
function runtimePhrase(mins) {
  if (!mins || mins < 25) return null;
  if (mins <= 100) return { text: `${mins} minutes`, band: "short" };
  if (mins <= 135) return { text: fmtRuntime(mins), band: "standard" };
  if (mins <= 165) return { text: fmtRuntime(mins), band: "long" };
  return { text: fmtRuntime(mins), band: "epic" };
}

function certClause(cert) {
  if (!cert) return null;
  const c = String(cert).toUpperCase();
  if (/^(A|R|NC-17|18)$/.test(c)) return "adults only";
  if (/^(U\/A|UA|PG-13|12|15|TV-14|TV-MA)/.test(c)) return "not one for younger kids";
  if (/^(U|G|PG|TV-G|TV-Y|TV-PG)$/.test(c)) return "fine for the whole family";
  return null;
}

function article(word) { return /^[aeiou]/i.test(String(word || "")) ? "an" : "a"; }

// Deterministic variant picker. Two films with the same shape must not produce the same
// sentence — that is the "500 pages of the same template" failure — but the choice must be
// STABLE across builds, or every rebuild churns the git diff. Keyed on the film's own id.
function pickVariant(item, options) {
  const key = String((item && (item.tmdbId || item.slug || item.title)) || "");
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
  // Finalizer: TMDB ids are near-sequential, and a plain modulo maps neighbouring ids to
  // the same bucket in runs. Mixing the bits first spreads adjacent films across variants.
  // NOTE the trailing >>> 0. `h ^= h >>> 13` yields a SIGNED 32-bit int, so without the
  // coercion h is negative for half of all inputs, `h % options.length` is negative, and
  // options[-1] is undefined. That silently dropped the caveat sentence for ~25% of films
  // and rendered a literal "undefined" into the page for any of them with two genres.
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0; h = (h ^ (h >>> 13)) >>> 0;
  return options[h % options.length];
}

// Sentence 1 — what you are committing to.
function commitmentLine(item) {
  const rt = runtimePhrase(item.runtime);
  const genres = String(item.genre || "").split("/").map((g) => g.trim()).filter(Boolean);
  const lead = genres[0] ? genres[0].toLowerCase() : null;
  const second = genres[1] ? genres[1].toLowerCase() : null;
  const lang = item.language || null;
  const cert = certClause(item.cert);
  const blend = second ? pickVariant(item, [
    ` with ${article(second)} ${second} streak`, ` with ${second} threaded through`, `, leaning ${second}`,
  ]) : "";
  if (item.kind === "tv") {
    const n = item.seasons || 0;
    if (!n && !lead) return null;
    const shape = n > 1 ? `${n} seasons deep` : "a first season";
    const what = [lang, lead].filter(Boolean).join(" ");
    return `This is ${shape}${what ? ` — ${what}${blend}` : ""}${cert ? `, ${cert}` : ""}.`;
  }
  // A movie with neither a runtime nor a certificate has nothing to say that the metadata
  // rows above don't already show. Say nothing.
  if (!rt && !cert) return null;
  if (rt && lead) return `${cap(rt.text)} of ${lang ? `${lang} ` : ""}${lead}${blend}${cert ? `, ${cert}` : ""}.`;
  if (rt) return `${cap(rt.text)} long${cert ? `, ${cert}` : ""}.`;
  return `${cap(lang ? `${lang} ${lead}` : lead || "")}${cert ? `, ${cert}` : ""}.`;
}

// Sentence 2 — the most decision-relevant thing we can defend, and only one of them.
// Ordered by how much it should change the answer.
function fitCaveat(item) {
  const useImdb = item.imdbVotes != null && item.imdbRating != null;
  const votes = useImdb ? item.imdbVotes : item.votes;
  const rating = useImdb ? item.imdbRating : item.rating;
  const rt = runtimePhrase(item.runtime);
  if (!(item.providers || []).length && (item.rentBuy || []).length) {
    return pickVariant(item, [
      "No subscription covers it here — you'd be paying per view, so it wants to be a deliberate pick.",
      "It's rent-or-buy only in this market, which makes it a decision rather than a background watch.",
    ]);
  }
  if (rating != null && votes && votes < 50) {
    return pickVariant(item, [
      `The ${Number(rating).toFixed(1)} rests on just ${votes} rating${votes === 1 ? "" : "s"} so far — promising, not proven.`,
      `Only ${votes} people have rated it, so treat that ${Number(rating).toFixed(1)} as an early signal rather than a verdict.`,
    ]);
  }
  if (rating != null && votes && votes >= 5000) {
    return pickVariant(item, [
      `That score holds across ${Number(votes).toLocaleString("en-IN")} ratings, so it's about as safe as this week's list gets.`,
      `With ${Number(votes).toLocaleString("en-IN")} ratings behind it, the number isn't going to move much — you know what you're getting.`,
    ]);
  }
  if (item.kind === "tv" && (item.seasons || 0) > 2) {
    return pickVariant(item, [
      "Several seasons in, so it's a commitment to start rather than a one-night sampler.",
      "Starting now means a backlog — worth knowing before you press play.",
      "There's a lot of it, which is either the appeal or the problem depending on your week.",
    ]);
  }
  if (!rt) return null;
  if (rt.band === "epic") return pickVariant(item, [
    "Past two and a half hours, it needs a proper evening rather than a weeknight.",
    "At this length it's the whole evening's plan, not something to slot in after dinner.",
  ]);
  if (rt.band === "long") return pickVariant(item, [
    "Long enough that it wants your full attention rather than a second screen.",
    "A little over the usual, so start it earlier than you think.",
  ]);
  if (rt.band === "short") return pickVariant(item, [
    "Short enough to finish on a weeknight without losing the next morning.",
    "Under the two-hour mark — an easy weeknight watch.",
    "Tight enough that it's an easy yes if you're undecided.",
  ]);
  return pickVariant(item, [
    "Standard length — a normal evening's watch, nothing to plan around.",
    "Runs about as long as you'd expect, so no scheduling gymnastics needed.",
  ]);
}

function cap(str) { return str ? str.charAt(0).toUpperCase() + str.slice(1) : str; }

// Public: { heading, text } or null. The heading is per-film on purpose — no two pages
// share an H2 ("Should you spend 2h 22m on it?").
function whyWatch(item) {
  if (!item) return null;
  const first = commitmentLine(item);
  if (!first) return null;                       // too thin to say anything true
  const second = fitCaveat(item);
  const rt = runtimePhrase(item.runtime);
  const heading = item.kind === "tv" ? "Is it worth starting?"
    : rt ? `Should you spend ${rt.text} on it?` : "Is it worth your time?";
  return { heading, text: second ? `${first} ${second}` : first };
}

module.exports = {
  article,
  cap,
  certClause,
  commitmentLine,
  fitCaveat,
  pickVariant,
  runtimePhrase,
  whyWatch,
};
