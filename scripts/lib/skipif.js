"use strict";

const { fmtRuntime } = require("./core.js");

// ============================================================================
// "DON'T WATCH THIS IF…" — the skip line.
//
// Every other block on a film page argues FOR watching: the verdict, the critics' take,
// the fit line, the rating. A page that only ever pushes is a page a reader learns to
// discount, because they know it will never tell them to walk away. This block exists to
// be the one place that does.
//
// It is the cheapest credibility on the site and the hardest to fake, because it costs
// something every time it fires. That is exactly why it works.
//
// FOUR RULES, and rule 1 is the whole feature:
//   1. Every reason must be a fact we hold, restated as a preference it conflicts with.
//      We know a film runs 187 minutes; we may say "you don't have three hours tonight".
//      We do NOT know it drags, so we never say so. The line reports the film's shape and
//      lets the reader decide it is wrong for them — it never renders a quality judgement
//      the data cannot support.
//   2. Never a reason that is merely the genre restated. "Skip if you don't like horror"
//      on a film labelled Horror is noise wearing the costume of advice; it teaches the
//      reader that this block is filler. A genre only earns a line when it combines with
//      something else (an adults-only certificate, a punishing runtime).
//   3. Never restate the verdict or the critics' take. Those sit directly above. This
//      answers a different question: who is this actively wrong for?
//   4. Return null when fewer than MIN_REASONS hold. A missing block beats a generic one.
//      One honest reason is worth more than three padded ones, but one reason also reads
//      as an afterthought, so the floor is two. No block is a perfectly good outcome and
//      will be the outcome on plenty of films.
//
// Everything here derives from fields already fetched. No new API calls, no inference,
// no LLM, nothing invented.
// ============================================================================

const MIN_REASONS = 2;
const MAX_REASONS = 4;

// Deterministic variant picker — same contract as whywatch.js. Two films with the same
// shape must not produce identical sentences, but the pick must be STABLE across builds
// or every rebuild churns the git diff. Keyed on the film's own id.
function pickVariant(item, options) {
  const key = String((item && (item.tmdbId || item.slug || item.title)) || "");
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return options[h % options.length];
}

// --- runtime -----------------------------------------------------------------
// A long film is not a worse film. It is a bigger ask on a weeknight, which is a real
// reason to pick something else tonight and no reason at all to think less of it.
function runtimeReason(item) {
  const m = Number(item.runtime) || 0;
  if (m < 150) return null;                       // under 2.5h asks nothing unusual
  const t = fmtRuntime(m);
  if (m >= 180) {
    return pickVariant(item, [
      `you don't have ${t} to give it tonight — this is a full evening, not a background watch`,
      `you're short on time. At ${t} it wants the whole night`,
    ]);
  }
  return pickVariant(item, [
    `you want something you can finish quickly — it runs ${t}`,
    `you've only got a couple of hours. It needs ${t}`,
  ]);
}

// --- certificate + audience ---------------------------------------------------
// The certificate is the one hard content signal we hold. Report it as a viewing
// situation it rules out, never as a description of what is in the film.
function certReason(item) {
  const c = String(item.cert || "").toUpperCase();
  if (!c) return null;
  if (/^(A|R|NC-17|18|TV-MA)/.test(c)) {
    return pickVariant(item, [
      `you're watching with family — it's certified ${item.cert}`,
      `kids are in the room. This one is rated ${item.cert}`,
      `this is the shared-living-room pick — the certificate is ${item.cert}`,
      `you need something everyone can sit through. Rated ${item.cert}`,
    ]);
  }
  if (/^(U|G|TV-Y|TV-G)$/.test(c)) {
    return pickVariant(item, [
      `you want something with an edge to it — this is certified ${item.cert}, pitched wide`,
      `you're after something harder. It's rated ${item.cert}`,
    ]);
  }
  return null;
}

// --- rating confidence --------------------------------------------------------
// The site already refuses to show a verdict on a film too new to judge. This says the
// same thing from the reader's side: if you want a sure thing tonight, this is not it.
// It is the most on-brand line in the module — the whole product gates on this.
function confidenceReason(item) {
  const votes = Number(item.imdbVotes || item.votes) || 0;
  if (item.rating == null) return null;           // page already says "verdict soon" — rule 3
  if (votes >= 100) return null;                  // enough signal to stand behind
  // Fires only in the genuinely additive case: a rating IS displayed, but it rests on too
  // few votes to lean on. Without the vote-count guard this line would land on nearly every
  // film — it is a this-week site, almost everything is new — and a reason that appears
  // everywhere stops being read. Wide variant set for the same reason.
  return pickVariant(item, [
    `you want a safe bet — that rating is resting on ${votes} votes so far`,
    `you'd rather wait for a consensus. Only ${votes} ratings in so far`,
    `you take the score at face value — it's early, and ${votes} votes can still move it`,
    `you want a number you can lean on. This one is still settling`,
  ]);
}

// --- critical split -----------------------------------------------------------
// Only fires when the take we already generated says critics are divided. Reuses that
// signal rather than recomputing it, and phrases it as a preference, not a verdict.
const SPLIT_RE = /split|divisive|down the middle|can't settle|divided|cut both ways|all over the map/i;
function divisiveReason(item) {
  if (!SPLIT_RE.test(String(item.take || ""))) return null;
  return pickVariant(item, [
    `you want something everyone agrees on — critics genuinely don't, on this one`,
    `you're not in the mood to gamble. Reactions to this are split`,
  ]);
}

// --- series commitment --------------------------------------------------------
function seasonsReason(item) {
  const s = Number(item.seasons) || 0;
  if (item.kind !== "tv" || s < 3) return null;
  return pickVariant(item, [
    `you want something that ends tonight — there are ${s} seasons of it`,
    `you're not starting a ${s}-season show this week`,
  ]);
}

// --- cost on top of a subscription -------------------------------------------
// A film available only to rent or buy is a different decision from one included in a
// subscription the reader already pays for. That is a fact we hold and rarely surfaced.
function payReason(item) {
  const flat = Array.isArray(item.providers) ? item.providers.length : 0;
  const rb = Array.isArray(item.rentBuy) ? item.rentBuy.length : 0;
  if (flat > 0 || rb === 0) return null;
  return pickVariant(item, [
    `you're only watching what your subscriptions already cover — this is rent-or-buy only`,
    `you don't want to pay per film. No subscription carries it yet`,
  ]);
}

// --- genre, only in combination (rule 2) --------------------------------------
// Horror on a film labelled Horror is not information. Horror at an adults-only
// certificate, or a 150-minute documentary, tells you something the genre chip did not.
function genreCombinationReason(item) {
  const g = String(item.genre || "").toLowerCase();
  const m = Number(item.runtime) || 0;
  const c = String(item.cert || "").toUpperCase();
  if (/horror/.test(g) && /^(A|R|18|NC-17|TV-MA)/.test(c)) {
    return pickVariant(item, [
      `you want horror you can watch half-distracted — this one is certified ${item.cert} and means it`,
      `you're after a gentle scare. It's rated ${item.cert}`,
    ]);
  }
  if (/documentary/.test(g) && m >= 120) {
    return `you're looking for a story to get lost in rather than ${fmtRuntime(m)} of argument`;
  }
  return null;
}

// ============================================================================
// Compose. Order matters: the reasons most likely to actually stop someone come first,
// because the list is capped and the tail gets trimmed.
// ============================================================================
function skipIf(item) {
  if (!item || !item.title) return null;
  const reasons = [
    confidenceReason(item),
    runtimeReason(item),
    payReason(item),
    seasonsReason(item),
    certReason(item),
    divisiveReason(item),
    genreCombinationReason(item),
  ].filter(Boolean);

  // Deduplicate on the leading clause so two rules can't say the same thing twice.
  const seen = new Set();
  const out = [];
  for (const r of reasons) {
    const key = r.slice(0, 18).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= MAX_REASONS) break;
  }
  return out.length >= MIN_REASONS ? out : null;   // rule 4
}

module.exports = { skipIf, MIN_REASONS, MAX_REASONS };
