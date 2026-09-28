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
const { whyWatch } = require("./whywatch.js");
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
          const days = item.released ? Math.floor((Date.parse(today) - Date.parse(item.released)) / 86400000) : null;
          // "just landed" is only true for ~3 weeks; past that (or with no release date
          // to judge by), say what's actually true: the ratings never showed up.
          return days != null && days <= 21
            ? pick([
                `${item.title} is a fresh ${lang}${noun} that's only just landed, so ratings are still settling`,
                `${item.title} has only just arrived, so ratings for the ${lang}${noun} are still finding their level`,
                `${item.title} is brand new to the list — too early for the numbers on this ${lang}${noun} to mean much yet`,
              ])
            : pick([
                `${item.title} hasn't gathered enough ratings yet for a firm read on this ${lang}${noun}`,
                `${item.title} is still short of the ratings needed to call this ${lang}${noun} either way`,
                `Ratings on ${item.title} are still too thin to say where this ${lang}${noun} lands`,
              ]);
        })();
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
    const tail = r >= 7
      ? pick([`, which puts it comfortably above average.`, ` — comfortably clear of the pack.`, `, well above the typical run of new releases.`], 2)
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

// "Good to know" quick-scan facts. Returns an array of {label, value} pairs, each derived
// deterministically. Skips any fact it can't fill so the table never shows blanks.
function buildGoodToKnow(item) {
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
    const c = String(item.cert).toUpperCase();
    // Order matters: check restrictive/age-gated patterns BEFORE bare "U", because "U/A 16+"
    // starts with "U" but is NOT a universal rating.
    const family = certAudience(item.cert).label;   // one rule for 14 rating boards
    rows.push({ label: "Watch with family?", value: `${item.cert} · ${family}` });
  }
  if (item.genre) rows.push({ label: "Genre", value: item.genre });
  if (item.language) rows.push({ label: "Language", value: item.language });
  const provs = Array.isArray(item.providers) ? item.providers : [];
  if (provs.length) rows.push({ label: "Best screen", value: "Stream at home" });
  else if (item.platform === "Theatres") rows.push({ label: "Best screen", value: "Theatre / big screen" });

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
  const verdictLabel = item.verdict || "";

  // Q1: worth watching. Verdict + reception + the fit line (see whyWatch) — the last part
  // is what stops this answer reading like every other page's answer, and it's the bit an
  // answer engine can't get from a ratings feed.
  const fit = whyWatch(item);
  if (verdictLabel && !/verdict soon|enough ratings/i.test(verdictLabel)) {
    faqs.push({
      q: `Is ${item.title} worth watching?`,
      // Self-contained on purpose: featured snippets and AI answer engines quote this text
      // out of context, so "see above" is a dead reference the moment it leaves the page.
      a: trim(`${verdictLabel}.${item.rating != null ? ` It rates ${Number(item.rating).toFixed(1)}/10 on audience ratings.` : ""}${item.take ? ` ${item.take}` : ""}${fit ? ` ${fit.text}` : ""}`, 420),
    });
  } else if (fit) {
    // Previously an unrated or brand-new title got NO answer to the site's central question.
    // We still won't invent a verdict — we answer with what we can defend.
    faqs.push({
      q: `Is ${item.title} worth watching?`,
      a: trim(`It's too early for a verdict — ${item.title} doesn't have enough ratings yet. ${fit.text}`, 420),
    });
  }
  // Q2: where to watch
  let whereA;
  if (upcoming) whereA = `${item.title} hasn't released yet${item.released ? ` — it's due ${fmtDateFull(item.released, localeFor(cfg && cfg.code))}` : ""}. We'll list where to watch once it's out.`;
  else if (provs.length) whereA = `You can stream ${item.title} in ${countryName} on ${provs.join(", ")}.`;
  else if (item.platform === "Theatres") whereA = `${item.title} is currently playing in theatres across ${countryName}. ${V.article} ${V.release} hasn't been announced yet.`;
  else whereA = `Streaming availability for ${item.title} in ${countryName} isn't confirmed yet — check back as platforms update.`;
  faqs.push({ q: `Where can I watch ${item.title}?`, a: whereA });

  // Q2b: streaming release date — the highest-volume non-brand query shape in every
  // market, asked in that market's own words (India/UAE say "OTT", everyone else says
  // "streaming"; see streamVocab). Answers are state-aware: streaming -> platform (+
  // arrival date when first-seen tracking has one); theatrical -> honestly "not
  // announced", plus the typical window as a labelled pattern, plus the true promise
  // that this page updates the day it lands.
  if (item.kind !== "tv") {
    let ottA;
    const arrival = item.ottFreshDate || null;
    if (provs.length) {
      ottA = `${item.title} is already streaming in ${countryName} on ${provs.join(", ")}${arrival ? ` — it arrived on ${arrival}` : ""}.`;
    } else if (digitalUpcoming(item)) {
      ottA = `${digitalAnnounceText(item.title, item.digitalDate, item.digitalNote, countryName, cfg)} This page updates automatically the day it starts streaming.`;
    } else {
      const est = item.platform === "Theatres" ? streamWindowEstimate(item.released, item.language) : null;
      const hint = est && !est.passed
        ? ` ${item.language || "These"} releases typically reach streaming about ${est.lo}–${est.hi} weeks after their theatrical run, which would put it around ${est.span} — that's a pattern, not a confirmed date.`
        : "";
      ottA = `${V.article} ${V.releaseDate} for ${item.title} hasn't been officially announced yet.${hint} This page updates automatically the day it starts streaming.`;
    }
    faqs.push({ q: V.faqQuestion(item.title), a: ottA });
  }

  // Q3: family friendly (only if we have a cert)
  if (item.cert) {
    const bucket = certAudience(item.cert).bucket;
    const a =
      bucket === "adults" ? `${item.title} is rated ${item.cert} — aimed at adult audiences.`
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
  return faqs;
}

module.exports = {
  buildFaqs,
  buildGoodToKnow,
  buildVerdictProse,
};
