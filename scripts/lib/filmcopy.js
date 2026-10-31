// ============================================================================
// filmcopy.js — the prose blocks on a film page: verdict paragraph, good-to-know, FAQs,
// plus image URL and social-image helpers.
// ============================================================================
"use strict";

const {
  COUNTRIES,
  fmtDateFull,
  fmtRuntime,
  trim,
  localeFor,
} = require("./core.js");
const { isRecent } = require("./fcscore.js");
const { plainFit, whyWatch } = require("./whywatch.js");
const { plainOn } = require("./humanprose.js");
const { certAudience } = require("./enrich.js");
const { digitalAnnounceText, digitalUpcoming } = require("./pagekit.js");
const { streamVocab, streamWindowEstimate } = require("./rules.js");

// ---- Enriched film-page content (all DETERMINISTIC: derived from fields we already have,
// no LLM, no extra dependency). These produce ORIGINAL prose/structure so each /movie/*.html
// page is not just TMDB's synopsis reworded — which is what lifts it for SEO. Pure + tested.

// A multi-sentence verdict paragraph assembled from the item's own data. Distinct from the
// short `verdict` label ("Worth a watch"). Deterministic templating keyed on rating band,
// recency, runtime, and where-to-watch — no invented plot facts, so nothing can hallucinate.
function buildVerdictProse(item, countryName = "India", locale = "en-IN") {
  if (!item || !item.title) return "";
  const r = item.rating;
  const votes = item.imdbRating != null ? item.imdbVotes : item.votes;
  const isTv = item.kind === "tv";
  const noun = isTv ? "series" : "film";
  const nounPl = isTv ? "series" : "films"; // "series" is its own plural — never "seriess"
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = item.released && item.released > today;
  const recent = isRecent(item, Date.parse(today)); // time words ("right now", "new releases") only when true
  // Seeded variety: opening, rating commentary, and runtime aside are each picked from a
  // small pool keyed to the film (tmdbId, falling back to a title hash), so two pages in
  // the same rating band don't open with the same sentence. Index 0 of every pool keeps
  // the original wording. The where-to-watch close stays FIXED VERBATIM — archivePatchHtml
  // and the archive sync-guard test match those exact strings.
  let seed = Math.abs(Number(item.tmdbId) || 0);
  if (!seed) {
    const s = String(item.title);
    for (let i = 0; i < s.length; i++) seed = (seed * 31 + s.charCodeAt(i)) | 0;
    seed = Math.abs(seed);
  }
  const pick = (pool, i = 0) => pool[(seed + i * 13) % pool.length];
  const lang = item.language ? `${item.language} ` : "";

  // Opening clause keyed on rating band (or recency when unrated).
  let lead;
  if (r == null || !votes || votes < 10) {
    lead = upcoming
      ? pick([
          `${item.title} is one of the more anticipated ${lang}releases on the calendar`,
          `${item.title} sits high on the ${lang}watchlist for the weeks ahead`,
          `${item.title} is the kind of ${lang}release people circle on the calendar`,
        ])
      : (() => {
          // "just landed" is only true while the film is new (isRecent — the site-wide rule);
          // past that, or with no release date to judge by, say what's true about the count.
          return isRecent(item, Date.parse(today))
            ? pick([
                `${item.title} is a fresh ${lang}${noun} that's only just landed, so ratings are still settling`,
                `${item.title} has only just arrived, so ratings for the ${lang}${noun} are still finding their level`,
                `${item.title} is brand new to the list — too early for the numbers on this ${lang}${noun} to mean much yet`,
              ])
            : pick([
                `${item.title} has too few ratings for a firm read on this ${lang}${noun}`,
                `There aren't enough ratings on ${item.title} to call this ${lang}${noun} either way`,
                `Ratings on ${item.title} are too thin to say where this ${lang}${noun} lands`,
              ]);
        })();
  } else if (votes < 50) {
    // Few ratings (10–49): a strong-sounding lead would outrun the FilmyChill Score, which
    // treats this as a small sample. Say who rated it and how, and nothing more.
    lead = r >= 7.5 ? `The few people who have rated ${item.title} rate this ${lang}${noun} highly`
      : r >= 6.5 ? `The few people who have rated ${item.title} mostly like this ${lang}${noun}`
        : r >= 5.5 ? `The few people who have rated ${item.title} are lukewarm on this ${lang}${noun}`
          : `The few people who have rated ${item.title} don't rate this ${lang}${noun} well`;
  } else if (r >= 7.5 && !recent) {
    // An older film: no "right now" / "current crop" — it isn't new.
    lead = pick([
      `${item.title} is one of the better-rated ${lang}${nounPl} out there`,
      `${item.title} rates well above most ${lang}${nounPl}`,
      `${item.title} has pulled the kind of numbers most ${lang}${nounPl} never see`,
      `${item.title} sits near the top of ${lang}${nounPl} on audience ratings`,
    ]);
  } else if (r >= 7.5) {
    lead = pick([
      `${item.title} lands among the stronger ${lang}${nounPl} on offer right now`,
      `${item.title} stands out as one of the better-rated ${lang}${nounPl} around at the moment`,
      `${item.title} has pulled the kind of numbers most ${lang}${nounPl} never see`,
      `${item.title} ranks near the top of the current ${lang}${noun} crop`,
    ]);
  } else if (r >= 6.5) {
    lead = pick([
      `${item.title} is a solid, watchable ${lang}${noun} that mostly delivers on what it promises`,
      `${item.title} is a dependable ${lang}${noun} — it does what it sets out to do`,
      `${item.title} holds up as a perfectly decent ${lang}${noun}, if not a remarkable one`,
      `${item.title} earns its keep as a steady ${lang}${noun} that knows its audience`,
    ]);
  } else if (r >= 5.5) {
    lead = pick([
      `${item.title} is a middling ${lang}${noun} — fine for a one-time watch but unlikely to stay with you`,
      `${item.title} sits squarely in the middle of the pack — watchable, and just as easily forgettable`,
      `${item.title} is an average ${lang}${noun}; it passes the time without demanding more of you`,
      `${item.title} neither embarrasses itself nor gives you much reason to recommend it`,
    ]);
  } else {
    lead = pick([
      `${item.title} struggles to land, and the ratings reflect a ${noun} that misfires more than it works`,
      `${item.title} has landed badly with viewers, and the numbers back that up`,
      `${item.title} never quite comes together, going by how audiences have scored it`,
      `${item.title} is a hard ${noun} to make a case for on current ratings`,
    ]);
  }
  lead = lead.replace(/\s+/g, " ");

  // Rating sentence (only when we actually have one with enough votes). The figure and
  // source are fixed facts; only the frame and the judgment tail vary.
  let ratingBit = "";
  if (r != null && votes >= 10) {
    const src = item.imdbRating != null ? "IMDb" : "TMDB";
    const x = Number(r).toFixed(1), n = Number(votes).toLocaleString(locale);
    const an = /^8/.test(x) ? "an" : "a"; // "an 8.2", "a 7.0" — reads as spoken
    const frame = pick([
      ` It carries ${an} ${x}/10 on ${src} across ${n} ratings`,
      ` It holds ${an} ${x}/10 on ${src} from ${n} ratings`,
      ` It's sitting at ${x}/10 on ${src} across ${n} ratings`,
    ], 1);
    const tail = votes < 50
      ? ` — a small sample, so treat it with caution.`
      : r >= 7
      ? pick([`, which puts it comfortably above average.`, ` — comfortably clear of the pack.`, recent ? `, well above the typical run of new releases.` : `, well above what most films manage.`], 2)
      : r >= 6
        ? pick([`, which puts it around the middle of the pack.`, ` — squarely mid-table.`, `, right around average territory.`], 2)
        : pick([`, which puts it below the bar for most viewers.`, ` — under the line most people draw.`, `, short of where most viewers set the bar.`], 2);
    ratingBit = frame + tail;
  }

  // Runtime / format note.
  let formatBit = "";
  if (item.runtime) {
    const rt = item.runtime;
    formatBit = isTv
      ? pick([
          ` Episodes run about ${rt} minutes.`,
          ` Episode length hovers around ${rt} minutes.`,
          ` Episodes clock in around ${rt} minutes.`,
        ], 3)
      : rt >= 150
        ? pick([
            ` At ${rt} minutes it's a long sit, so save it for when you've got the evening.`,
            ` Budget a full evening — it runs a hefty ${rt} minutes.`,
            ` At ${rt} minutes, it asks for a real chunk of your night.`,
          ], 3)
        : rt <= 100
          ? pick([
              ` It's a tight ${rt}-minute watch — easy to fit into a busy night.`,
              ` At a brisk ${rt} minutes, it slots easily into a weeknight.`,
              ` It keeps things short at ${rt} minutes — no heavy commitment required.`,
            ], 3)
          : pick([
              ` It runs a manageable ${rt} minutes.`,
              ` The ${rt}-minute runtime sits in the comfortable middle.`,
              ` It clocks in at a standard ${rt} minutes.`,
            ], 3);
  }

  // Where-to-watch close.
  let whereBit = "";
  const provs = Array.isArray(item.providers) ? item.providers : [];
  if (upcoming && item.released) {
    whereBit = ` It releases on ${fmtDateFull(item.released, locale)}; mark your calendar if it's on your list.`;
  } else if (provs.length) {
    whereBit = ` In ${countryName} you can stream it on ${provs.slice(0, 3).join(", ")}.`;
  } else if (item.platform === "Theatres") {
    whereBit = ` It's in theatres in ${countryName} now — best caught on the big screen.`;
  }

  return (lead.replace(/\.$/, "") + "." + ratingBit + formatBit + whereBit).trim();
}

// The rating board a page's certificate comes from: its country's TMDB region. Some callers
// pass a bare { code }, so the region is looked up when it's missing.
function certRegion(cfg) {
  if (!cfg) return null;
  return cfg.region || (COUNTRIES.find((c) => c.code === cfg.code) || {}).region || null;
}

// "Good to know" quick-scan facts. Returns an array of {label, value} pairs, each derived
// deterministically. Skips any fact it can't fill so the table never shows blanks. `cfg` is the
// page's country: its region decides how a rating letter reads (Mexico's "A" is all ages).
function buildGoodToKnow(item, cfg = null) {
  if (!item) return [];
  const rows = [];
  const isTv = item.kind === "tv";

  if (item.runtime) {
    const v = isTv ? `~${item.runtime} min per episode`
      : item.runtime >= 150 ? `${fmtRuntime(item.runtime)} — long`
      : item.runtime <= 100 ? `${fmtRuntime(item.runtime)} — short`
      : fmtRuntime(item.runtime);
    rows.push({ label: "Runtime", value: v });
  }
  if (item.cert) {
    const family = certAudience(item.cert, certRegion(cfg)).label;   // one rule for 18 rating boards
    // lib/facts.js reads the certificate before the " · "; the label after it is wording only.
    const plainRow = !!(item._plain || plainOn(item.slug));
    rows.push({ label: "Watch with family?", value: `${item.cert} · ${plainRow ? family.replace(" — ", ", ") : family}` });
  }
  if (item.genre) rows.push({ label: "Genre", value: item.genre });
  if (item.language) rows.push({ label: "Language", value: item.language });
  const provs = Array.isArray(item.providers) ? item.providers : [];
  // "Best screen: Stream at home" said nothing a reader didn't know and repeated on every page
  // (27 Oct 2026 review): gone.

  return rows;
}

// FAQ entries (question + answer), deterministic, for both on-page display AND FAQPage
// schema. Only questions we can answer truthfully from data are emitted.
function buildFaqs(item, countryName = "India", cfg = null) {
  const V = streamVocab(cfg || COUNTRIES.find((c) => c.name === countryName) || null);
  if (!item || !item.title) return [];
  const faqs = [];
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = item.released && item.released > today;
  const provs = Array.isArray(item.providers) ? item.providers : [];
  // The FilmyChill Score (lib/fcscore.js) is the page's verdict when there is one, so the
  // FAQ answer agrees with the stamp at the top; the audience verdict is the fallback.
  // The plain reason: the page's reason carries its evidence (lib/reception.js) and the answer
  // gives the numbers in its own words, so they'd be said twice otherwise.
  // Plain wording (rollout "human-prose", lib/humanprose.js): full stops instead of spaced em
  // dashes, and no canned "fit" line after the facts.
  const plain = !!(item._plain || plainOn(item.slug));
  const verdictLabel = item.fcScore ? `FilmyChill Score: ${item.fcScore.verdict}${plain ? "." : " —"} ${require("./reception.js").plainReason(item.fcScore.reason).replace(/\.$/, "")}${item.fcScore.early ? ` (based on only ${Number(item.fcScore.votes).toLocaleString("en-IN")} ratings)` : ""}` : (item.verdict || "");

  // Q1: worth watching. Verdict + reception + the fit line (see whyWatch) — the last part
  // is what stops this answer reading like every other page's answer, and it's the bit an
  // answer engine can't get from a ratings feed.
  // Plain: no fit line after a verdict (it restated the runtime and rating count in a canned
  // sentence), and the facts sentence alone where there is no verdict yet.
  const fit = plain ? (plainFit(item) ? { text: plainFit(item) } : null) : whyWatch(item);
  const fitAfterVerdict = plain ? null : fit;
  if (verdictLabel && !/verdict soon|enough ratings/i.test(verdictLabel)) {
    faqs.push({
      q: `Is ${item.title} worth watching?`,
      // Self-contained on purpose: featured snippets and AI answer engines quote this text
      // out of context, so "see above" is a dead reference the moment it leaves the page.
      a: trim(`${verdictLabel}.${item.rating != null ? ` It rates ${Number(item.rating).toFixed(1)}/10${Number(item.votes) ? ` from ${Number(item.votes).toLocaleString("en-IN")} audience ratings on TMDB` : " on audience ratings"}.` : ""}${item.take ? ` ${item.take}` : ""}${fitAfterVerdict ? ` ${fitAfterVerdict.text}` : ""}`, 420),
    });
  } else if (fit) {
    // Previously an unrated or brand-new title got NO answer to the site's central question.
    // We still won't invent a verdict — we answer with what we can defend.
    faqs.push({
      q: `Is ${item.title} worth watching?`,
      a: trim(`${isRecent(item, Date.parse(today)) ? `It's too early for a verdict${plain ? "." : " —"} ${item.title} doesn't have enough ratings yet.` : `There aren't enough ratings for a verdict on ${item.title}.`} ${fit.text}`, 420),
    });
  }
  // Q1b: what critics say, with the figures the page cites (lib/reception.js, rollout
  // "wiki-reception"): the sourced sentence an answer engine can quote — "Positive — 91% on
  // Rotten Tomatoes (87 reviews) — per Wikipedia, 28 Oct 2026."
  {
    const RC = require("./reception.js");
    const { inRollout } = require("./rollout.js");
    const tone = item.fcScore && item.fcScore.critics ? item.fcScore.critics : null;
    const cited = item.reception && item.slug && inRollout(RC.RECEPTION_FEATURE, item.slug) ? RC.receptionLine(item.reception, (d) => fmtDateFull(d, localeFor(cfg && cfg.code)), { tone, plain }) : "";
    if (cited) {
      const label = tone || RC.toneFromFigure(item.reception);
      faqs.push({ q: `What do critics say about ${item.title}?`, a: `${label ? label.charAt(0).toUpperCase() + label.slice(1) + (plain ? ": " : " — ") : ""}${cited}.` });
    }
  }
  // Q1c: the published reviews (lib/reviews.js), named so an answer engine can send readers on.
  if (Array.isArray(item.reviews) && item.reviews.length) {
    const outlets = [...new Set(item.reviews.map((r) => r && r.o).filter(Boolean))];
    if (outlets.length) faqs.push({ q: `Where are the reviews of ${item.title}?`, a: `Published reviews so far: ${outlets.length > 1 ? `${outlets.slice(0, -1).join(", ")} and ${outlets[outlets.length - 1]}` : outlets[0]}. The links are in the FilmyChill score card on this page.` });
  }
  // Q2: where to watch
  let whereA;
  // The release-day settle pass (lib/pagekit.js) matches both forms of this answer.
  if (upcoming) whereA = `${item.title} hasn't released yet${item.released ? `${plain ? ". It's due" : " — it's due"} ${fmtDateFull(item.released, localeFor(cfg && cfg.code))}` : ""}. We'll list where to watch once it's out.`;
  else if (provs.length) whereA = `You can stream ${item.title} in ${countryName} on ${provs.join(", ")}.`;
  else if (item.platform === "Theatres") whereA = `${item.title} is currently playing in theatres across ${countryName}. ${V.article} ${V.release} hasn't been announced yet.`;
  else whereA = plain ? `Streaming availability for ${item.title} in ${countryName} isn't confirmed yet. This page updates when a platform lists it.`
    : `Streaming availability for ${item.title} in ${countryName} isn't confirmed yet — check back as platforms update.`;
  faqs.push({ q: `Where can I watch ${item.title}?`, a: whereA });

  // Q2b: streaming release date — the highest-volume non-brand query shape in every
  // market, asked in that market's own words (India/UAE say "OTT", everyone else says
  // "streaming"; see streamVocab). Answers are state-aware: streaming -> platform (+
  // arrival date when first-seen tracking has one); theatrical -> honestly "not
  // announced", plus the typical window as a labelled pattern, plus the true promise
  // that this page updates the day it lands.
  if (item.kind !== "tv") {
    let ottA;
    // Only a verified arrival date (lib/lifecycle.js arrivalDate). This used ottFreshDate, which
    // is a first sighting or the release date: neither is when the film reached the platform.
    const arrival = item.arrived ? fmtDateFull(item.arrived, localeFor(cfg && cfg.code)) : null;
    if (provs.length) {
      // One sentence either way: the departure patch (lib/lifecycle.js) rewrites it up to the full stop.
      ottA = `${item.title} is already streaming in ${countryName} on ${provs.join(", ")}${arrival ? (plain
        ? `, where it arrived on ${arrival}`
        : ` — it arrived${item.arrivedOn && provs.includes(item.arrivedOn) ? ` on ${item.arrivedOn}` : ""} on ${arrival}`) : ""}.`;
    } else if (digitalUpcoming(item)) {
      ottA = `${digitalAnnounceText(item.title, item.digitalDate, item.digitalNote, countryName, cfg)} This page updates automatically the day it starts streaming.`;
    } else {
      const est = item.platform === "Theatres" ? streamWindowEstimate(item.released, item.language) : null;
      const hint = est && !est.passed
        ? ` ${item.language || "These"} releases typically reach streaming about ${est.lo}–${est.hi} weeks after their theatrical run, which would put it around ${est.span}${plain ? ". That's an estimate based on past releases." : " — that's a pattern, not a confirmed date."}`
        : "";
      ottA = `${V.article} ${V.releaseDate} for ${item.title} hasn't been officially announced yet.${hint} This page updates automatically the day it starts streaming.`;
    }
    faqs.push({ q: V.faqQuestion(item.title), a: ottA });
  }

  // Q3: family friendly (only if we have a cert)
  if (item.cert) {
    const bucket = certAudience(item.cert, certRegion(cfg)).bucket;
    const a =
      bucket === "adults" ? `${item.title} is rated ${item.cert}${plain ? ", for adult audiences." : " — aimed at adult audiences."}`
      : bucket === "teens" ? `${item.title} is rated ${item.cert}. Fine for older kids with guidance.`
      : bucket === "family" ? `${item.title} is rated ${item.cert}, suitable for family viewing.`
      : `${item.title} is rated ${item.cert}.`;
    faqs.push({ q: `Is ${item.title} family friendly?`, a });
  }
  // Q4: language (helps regional long-tail search)
  if (item.language) {
    const art = /^[aeiou]/i.test(String(item.language)) ? "an" : "a"; // "an English film", "a Tamil film"
    faqs.push({ q: `What language is ${item.title} in?`, a: `${item.title} is ${art} ${item.language} ${item.kind === "tv" ? "series" : "film"}${item.genre ? ` (${item.genre})` : ""}.` });
  }
  faqs.push(...olderTitleFaqs(item, cfg, Date.parse(today)));
  return faqs;
}

// Older titles (out for OLDER_TITLE_DAYS or more — the back catalogue): the questions people
// search about a film they've already heard of. Oct 2026: Search Console listed ~1,200 such
// pages as "crawled, not indexed"; these answers are specific to the film, unlike the template
// around them. Each restates a fact the page already shows (seasons, runtime, cast, director,
// release date) — never a new claim — so it can't disagree with the page, and none mentions a
// platform, which the sweeps change. Appended after the existing questions, whose wording the
// sweeps and archive patches match on and which stay exactly as they were.
const OLDER_TITLE_DAYS = 120;
function olderTitleFaqs(item, cfg, nowMs) {
  const rel = /^\d{4}-\d{2}-\d{2}/.test(item.released || "") ? Date.parse(`${item.released.slice(0, 10)}T00:00:00Z`) : NaN;
  if (!Number.isFinite(rel) || (nowMs - rel) / 864e5 < OLDER_TITLE_DAYS) return [];
  const t = item.title, tv = item.kind === "tv", out = [];
  const mins = Number(item.runtime) > 0 ? Math.round(Number(item.runtime)) : 0;
  const seasons = Number(item.seasons) > 0 ? Math.round(Number(item.seasons)) : 0;
  if (tv && seasons) out.push({ q: `How many seasons does ${t} have?`, a: `${t} has ${seasons} season${seasons === 1 ? "" : "s"}${mins ? `, with episodes of about ${mins} minutes` : ""}.` });
  if (!tv && mins) out.push({ q: `How long is ${t}?`, a: `${t} runs ${fmtRuntime(mins)} (${mins} minutes).` });
  const cast = (Array.isArray(item.cast) ? item.cast : []).map((c) => (typeof c === "string" ? c : c && c.name)).filter(Boolean).slice(0, 4);
  if (cast.length) {
    const names = cast.length > 1 ? `${cast.slice(0, -1).join(", ")} and ${cast[cast.length - 1]}` : cast[0];
    out.push({ q: `Who is in the cast of ${t}?`, a: `${t} stars ${names}${item.director ? `, ${tv && item._fix30 ? "created" : "directed"} by ${item.director}` : ""}.` });
  }
  out.push({ q: tv ? `When did ${t} first air?` : `When did ${t} come out?`, a: `${t} ${tv ? "first aired" : "was released"} on ${fmtDateFull(item.released.slice(0, 10), localeFor(cfg && cfg.code))}.` });
  return out;
}

module.exports = {
  buildFaqs,
  buildGoodToKnow,
  buildVerdictProse,
};
