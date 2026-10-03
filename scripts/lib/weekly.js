// ============================================================================
// weekly.js — this week's surfaces: pre-rendered cards, the 'New on OTT this week' page,
// the editor's note, and the per-country RSS feed.
// ============================================================================
"use strict";

const fs = require("fs");
const {
  COUNTRY_PAGE_META,
  escHtml,
  filmPagePath,
  filmPageUrl,
  fmtDateShort,
  fmtRuntime,
  trim,
  localeFor,
} = require("./core.js");
const { rankValue } = require("./score.js");
const { releaseState } = require("./release.js");
const { trailerViewsLabel } = require("./editorial.js");
const { meterLevel } = require("./meter.js");
const { earlyReadLabel, noScoreText } = require("./fcscore.js");
const { freshLabel } = require("./freshness.js");
const {
  analyticsTag,
  cspWith,
  fitFirst,
  footerAttribution,
  hubOgImage,
  ogImageTag,
} = require("./pagekit.js");
const { streamVocab } = require("./rules.js");

// FilmyChill Score panel (lib/fcscore.js) — the card's verdict. Mirrors fcScoreHtml() in
// index.html so SSR and hydrated cards match; keep the two in step. No score = "too early"
// (the gate held it back), never a guess; the audience rating stays visible either way.
function fcScorePanel(item) {
  const e = escHtml;
  const s = item.fcScore;
  const bits = [];
  if (item.rating != null && item.votes) bits.push(`Audience ★ ${Number(item.rating).toFixed(1)} (${Number(item.votes).toLocaleString()} ratings)`);
  if (s && s.critics) bits.push(`Critics: ${s.critics}`);
  if (!s) { const b = trailerViewsLabel(item.trailerViews); if (b) bits.push(b); }
  const sig = bits.length ? `<div class="fcs-sig">${e(bits.join(" · "))}</div>` : "";
  const none = noScoreText(item);
  if (!s) return `<div class="fcs fcs-early"><div class="fcs-head"><span class="fcs-label">FilmyChill score</span><span class="fcs-v"><svg class="fcm" aria-hidden="true"><use href="#fcm-early"/></svg>${e(none.label)}</span></div><div class="fcs-why">${e(none.why)}</div></div>${sig}`;
  return `<div class="fcs"><div class="fcs-head"><span class="fcs-label">FilmyChill score</span><span class="fcs-v"><svg class="fcm" aria-hidden="true"><use href="#fcm-${meterLevel(s.verdict)}"/></svg>${e(s.verdict)}</span></div><div class="fcs-why">${e(s.reason)}${s.early ? ` <span class="fcs-tag">${e(earlyReadLabel(s))}</span>` : ""}</div></div>${sig}`;
}

// CLEANER CARDS (Oct 2026) — server twin of card() in index.html; same markup, so the page
// doesn't shift when the browser re-renders it. Poster with the rank on it, title, a short
// details line, at most one status chip (+ platform on streaming titles), the score as one
// line. The film page carries everything else.
function ssrCardMeta(item) {
  const genre = item.genre ? String(item.genre).split(" / ")[0] : "";
  const tail = item.kind === "tv" ? (item.seasons ? `Season ${item.seasons}` : "Series") : (item.runtime ? fmtRuntime(item.runtime) : "");
  return [item.language, genre, tail].filter(Boolean).map(escHtml).join(" · ");
}
function ssrCardChips(item) {
  const e = escHtml, out = [];
  const badge = item.badge || (item.isRecent ? "New release" : null);
  if (item.platform && item.platform !== "Theatres") out.push(`<span class="cchip">${e(item.platform)}</span>`);
  if (item.trending) out.push('<span class="cchip trend">Trending</span>');
  else if (badge) out.push(`<span class="cchip new">${e(badge)}</span>`);
  return out.length ? `<div class="cchips">${out.join("")}</div>` : "";
}
function ssrCardScore(item, code) {
  const e = escHtml, s = item.fcScore;
  if (s) {
    const bits = [e(String(s.reason || "").replace(/\.$/, ""))];
    if (item.rating != null && item.votes) bits.push(`★ ${Number(item.rating).toFixed(1)}`);
    if (s.early) bits.push(e(earlyReadLabel(s)));
    return `<div class="sline" aria-label="FilmyChill Score: ${e(s.verdict)}"><svg class="fcm" aria-hidden="true"><use href="#fcm-${meterLevel(s.verdict)}"/></svg><span class="sv">${e(s.verdict)}</span></div><div class="sreason">${bits.join(" · ")}</div>`;
  }
  const none = noScoreText(item);
  if (none.label === "Too early") {
    const tv = trailerViewsLabel(item.trailerViews);
    const when = freshLabel(item, Date.now(), localeFor(code));
    const extra = tv ? tv.replace(/^▶\s*/, "") : (when ? when.charAt(0).toLowerCase() + when.slice(1) : "");
    return `<div class="snone"><svg class="ic" aria-hidden="true"><use href="#icHourglass"/></svg>Too early to score${extra ? ` · ${e(extra)}` : ""}</div>`;
  }
  const votes = Number(item.votes || 0);
  return `<div class="snone"><svg class="ic" aria-hidden="true"><use href="#icBars"/></svg>Not enough ratings to score${votes ? ` · only ${votes.toLocaleString("en-IN")}` : ""}</div>`;
}
function ssrCard(item, i, code, { eager = false } = {}) {
  const e = escHtml;
  const art = item.poster
    ? `<img class="poster" src="${e(item.poster)}" alt="${e(item.title)} poster" width="150" height="200" ${eager ? 'loading="eager" decoding="async"' : 'loading="lazy"'}>`
    : `<div class="poster ph" aria-hidden="true">${e((item.title || "?").charAt(0).toUpperCase())}</div>`;
  const inner = `
    <div class="pw">${art}<span class="rank">${i + 1}</span></div>
    <div class="cb">
      <h3>${e(item.title)}</h3>
      <div class="meta">${ssrCardMeta(item)}</div>
      ${ssrCardChips(item)}
      ${ssrCardScore(item, code)}
    </div>`;
  // Every country now has its own per-film pages, so always link to this country's page.
  // (`code` defaults to India for safety if a caller omits it.)
  return item.slug
    ? `<a class="card" href="${e(filmPagePath(code || "in", item.slug))}">${inner}</a>`
    : `<div class="card">${inner}</div>`;
}

function ssrSoonCard(item, code) {
  const e = escHtml;
  return `<a class="soon-card" href="${e(filmPagePath(code || "in", item.slug))}" style="text-decoration:none;color:inherit">
    ${item.poster ? `<img src="${e(item.poster)}" alt="${e(item.title)} poster" width="150" height="200" loading="lazy">` : `<div class="soon-ph" aria-hidden="true"><span class="soon-ph-letter">${e((item.title || "?").charAt(0).toUpperCase())}</span><span class="soon-ph-note">Poster on the way</span></div>`}
    <div class="soon-body">
      <div class="soon-date">${e(releaseState(item.released) === "today" ? "Today" : (item.released ? fmtDateShort(item.released, Date.now(), localeFor(code)) : ""))}</div>
      <div class="soon-title">${e(item.title)}</div>
      <div class="soon-meta">${e(item.language || "")}</div>
    </div>
  </a>`;
}

// Per-country page metadata: title, description, canonical, OG — country-specific so each
// page ranks for its own market in search. India keeps the established global-but-India-first
// wording at the root; the others name their country explicitly.

// ============================================================================
// "NEW ON OTT THIS WEEK" PAGE — the organic-discovery page.
// The homepage + film pages target queries FilmyChill can't win (film names vs
// IMDb/Wikipedia) or that nobody types (the brand). The query space the site CAN
// win is the weekly aggregation query — "new OTT releases this week", "new on
// Netflix <country>", "what to watch this weekend" — which is high-volume,
// freshness-sensitive (Google favours recently-updated pages for it), and is
// EXACTLY what the pipeline already computes daily. One page per country at
// /new-on-ott/ (India) and /<code>/new-on-ott/, rebuilt every run, grouped by
// platform, with CollectionPage + ItemList + FAQPage schema and hreflang links.
// ============================================================================
function ottWeekPath(code) { return code === "in" ? "new-on-ott/index.html" : `${code}/new-on-ott/index.html`; }
function ottWeekUrl(code) { return code === "in" ? "https://filmychill.com/new-on-ott/" : `https://filmychill.com/${code}/new-on-ott/`; }

// ============================================================================
// EDITOR'S NOTE — a short weekly note in a human editorial register, assembled from
// judgments the pipeline can defend: which release is the event, what the ratings say to
// skip, what's quietly excellent on streaming. RULES: every claim traces to data on the
// items; NO fabricated firsthand experience ("I watched...") ever; better absent than
// hollow (returns null on thin data). Wording is seeded by ISO week + country so phrasing
// holds across a week's builds while facts stay live; each slot draws from a six-deep pool
// so the same sentence takes months to recur for a given country. If /editor-note.txt
// exists at the repo root, its text REPLACES the generated note for India — the owner's
// real opinion wins.
// ============================================================================
const EDNOTE_MIN_VOTES = 25;
function isoWeekNum(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil((((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5) + 1) / 7);
}
function buildEditorNote(data, cfg, seed = null) {
  const th = (data && data.theatres) || [], ott = (data && data.ott) || [];
  const s = seed != null ? seed : isoWeekNum() * 31 + ((cfg && cfg.code) || "in").charCodeAt(0);
  const pick = (pool, i) => pool[Math.abs(s + i * 7) % pool.length];
  const rated = (list) => list.filter((x) => x.rating != null && (x.votes || 0) >= EDNOTE_MIN_VOTES);
  const r1 = (x) => Number(x.rating).toFixed(1);

  const an = (x) => (/^8/.test(x) ? "an" : "a"); // "an 8.1 from early audiences", "a 7.7"
  // Confidence-weighted order (see lib/score.js): a high rating on a handful of votes must
  // not be crowned the pick over a proven one. Display still shows the true rating; only the
  // choice of WHICH film to highlight uses the weighted value.
  const rt = rated(th).sort((a, b) => rankValue(b) - rankValue(a));
  const event = rt[0] && rt[0].rating >= 6.5 ? rt[0] : null;
  const skip = rt.length > 1 && rt[rt.length - 1].rating <= 5.9 && rt[rt.length - 1] !== event ? rt[rt.length - 1] : null;
  // The sleeper must come from THIS WEEK'S arrivals, not the whole six-week window. The
  // OTT list deliberately carries a tail of older standouts (flagged stillGood, rendered
  // under "Still worth it — standouts from earlier weeks"), and those are the highest-rated
  // things on the page almost by definition — a long-running show with thousands of votes
  // beats anything that landed on Thursday. Without this filter the note crowned Ted Lasso
  // (season added 4 Aug, series from 2020, 8.4) "the week's real winner" five weeks running.
  // Every sleeper phrasing below claims currency — "this week", "the week's real winner" —
  // so the candidate set has to be current or the sentence is simply false.
  // llms.txt already filters on !stillGood for the same reason; this brings the note in line.
  const ro = rated(ott).filter((x) => !x.stillGood).sort((a, b) => rankValue(b) - rankValue(a));
  const sleeper = ro[0] && ro[0].rating >= 7.8 && ro[0].platform && ro[0].platform !== "Theatres" ? ro[0] : null;
  if (!event && !skip && !sleeper) return null; // thin data -> say nothing

  const parts = [];
  // The event film's most-praised aspect (mined from critic/viewer reception) turns
  // "book a ticket" into "book a ticket — here's why". Clause-appended, comma-led,
  // agreement-free, digit-free; absent data changes nothing.
  const flair = (line, it, off) => {
    const asp = it && Array.isArray(it.takeAspects) && it.takeAspects[0];
    if (!asp || line.length > 170) return line;
    return line.replace(/\.$/, pick([
      `, and most of the talk is about the ${asp}.`,
      `, with word of mouth centring on the ${asp}.`,
      `, and much of the buzz comes down to the ${asp}.`,
    ], off));
  };
  if (event && event.rating >= 7.5) {
    const ev = pick([
      `${event.title} is the obvious ticket this week, and for once the obvious call is the right one — ${an(r1(event))} ${r1(event)} from early audiences is rare air.`,
      `The week belongs to ${event.title}. ${an(r1(event)) === "an" ? "An" : "A"} ${r1(event)} with real votes behind it means people aren't just showing up, they're coming out happy.`,
      `Start with ${event.title} — ${r1(event)} and holding, which is about as safe as ticket money gets.`,
      `${event.title} is the one to book; ${an(r1(event))} ${r1(event)} from early audiences doesn't happen by accident.`,
      `${event.title} has the week to itself — early viewers have it at ${r1(event)}, which is properly rare.`,
      `If it's one trip to the cinema this week, make it ${event.title}; ${r1(event)} is as clear a signal as ratings give.`,
    ], 1);
    parts.push(flair(ev, event, 8));
  } else if (event) {
    const ev = pick([
      `${event.title} leads a middling week — ${r1(event)} says solid, not special.`,
      `${event.title} is the safest ticket around, though ${r1(event)} suggests keeping expectations in check.`,
      `Nothing unmissable in theatres; ${event.title} at ${r1(event)} is the best of it.`,
      `${event.title} tops a quiet week; ${r1(event)} means decent, not destination viewing.`,
      `${event.title} is the pick of an ordinary slate — ${r1(event)} says you'll leave satisfied, not stunned.`,
      `${an(r1(event)) === "an" ? "An" : "A"} ${r1(event)} makes ${event.title} the best bet around, with expectations kept sensible.`,
    ], 2);
    parts.push(flair(ev, event, 8));
  } else if (rt.length) {
    parts.push(pick([
      `No must-see in theatres this week — save the ticket money.`,
      `Thin week in theatres, honestly.`,
      `A quiet week on the big screen — nothing that demands a ticket.`,
    ], 3));
  }
  if (skip) {
    const fam = /family|animation/i.test(skip.genre || "");
    parts.push(fam
      ? pick([
          `${skip.title} at ${r1(skip)} is strictly a kids-in-the-house situation.`,
          `Unless it's a kids-in-the-house weekend, ${skip.title} at ${r1(skip)} can wait.`,
          `${skip.title} (${r1(skip)}) is a kids-in-the-house pick and not much more.`,
        ], 4)
      : pick([
          `${skip.title} at ${r1(skip)} is a skip — the number says what the trailer won't.`,
          `Give ${skip.title} a miss; ${r1(skip)} from the people who paid is warning enough.`,
          `${skip.title} (${r1(skip)}) can wait for streaming, if that.`,
          `${skip.title} sits at ${r1(skip)}, and there's no generous way to read that number.`,
          `The audience has scored ${skip.title} a ${r1(skip)}, which settles it.`,
          `${skip.title} at ${r1(skip)} is one to let pass; streaming will have it soon enough.`,
        ], 4));
  }
  if (sleeper) {
    parts.push(pick([
      `The sleeper is on ${sleeper.platform}: ${sleeper.title}, sitting at ${r1(sleeper)} and deserving more noise than it's getting.`,
      `Quietly, the best-rated thing in the country is ${sleeper.title} on ${sleeper.platform} — ${r1(sleeper)} from viewers.`,
      `Odd week when the strongest number around (${sleeper.title}, ${r1(sleeper)}) is included with a ${sleeper.platform} plan.`,
      `Skip the queue and open ${sleeper.platform}: ${sleeper.title} at ${r1(sleeper)} is the week's real winner.`,
      `The best number this week isn't in theatres — it's ${sleeper.title} on ${sleeper.platform}, holding ${r1(sleeper)}.`,
      `${sleeper.title} is putting up numbers on ${sleeper.platform} most theatrical releases would envy — ${r1(sleeper)} from viewers.`,
    ], 5));
  }
  if (event && event.takeCounter) parts.push(pick([
    `Critics and audiences are pulling in opposite directions on ${event.title}; side with whichever camp you usually trust.`,
    `On ${event.title}, the critics say one thing and the audience score says another — pick your camp.`,
    `${event.title} has critics and viewers at odds; trust whichever side has served you better.`,
  ], 6));
  return parts.slice(0, 3).join(" ");
}

function ssrEditorNote(data, cfg) {
  let note = null;
  if (cfg && cfg.code === "in" && fs.existsSync("editor-note.txt")) {
    const own = fs.readFileSync("editor-note.txt", "utf8").trim();
    if (own) note = own; // the human's line always wins
  }
  if (!note) note = buildEditorNote(data, cfg);
  if (!note) return "";
  const d = data && data.generatedAt ? fmtDateShort(String(data.generatedAt).slice(0, 10), Date.now(), localeFor(cfg.code)) : "";
  return `<div class="ednote"><div class="ednote-label">Editor's note${d ? ` · ${escHtml(d)}` : ""}</div><p>${escHtml(note)}</p></div>`;
}

function buildOttWeekPage(data, cfg, allCountries) {
  const e = escHtml;
  // JSON-LD-safe serializer: escapes "<" as \u003c inside the JSON so a title containing
  // "</script>" can never break out of the <script type="application/ld+json"> block.
  const ldJson = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
  const code = (cfg && cfg.code) || "in";
  const m = COUNTRY_PAGE_META[code] || { name: cfg && cfg.name || "India", path: `/${code}/` };
  const countryName = m.name; // "India", "the US", ...
  const homeUrl = `https://filmychill.com${m.path}`;
  const url = ottWeekUrl(code);
  // Market vocabulary. The URL stays /new-on-ott/ everywhere — it is already indexed and a
  // slug is not user-facing copy — but every word a visitor or a SERP snippet SEES comes
  // from V, so the US page reads "New Streaming Releases", never "New OTT Releases".
  const V = streamVocab(cfg && cfg.code ? cfg : { code });
  const gen = data.generatedAt || new Date().toISOString();
  const monthYear = new Date(gen).toLocaleDateString(localeFor(code), { month: "long", year: "numeric" });
  const updatedHuman = new Date(gen).toLocaleDateString(localeFor(code), { day: "numeric", month: "long", year: "numeric" });

  // The homepage ten PLUS everything the homepage's caps left behind (see ottExtra). This page
  // is linked from the homepage as "All new OTT releases this week" and its description says
  // "every" — until this pool existed it rendered the identical ten titles regrouped by
  // platform, so the reader clicked a promise of more and got the same set reshuffled.
  const extra = (data.ottExtra || []).filter((x) => x && x.title);
  const seenIds = new Set();
  const items = [...(data.ott || []), ...extra].filter((x) => {
    if (!x || !x.title) return false;
    if (x.tmdbId == null) return true;   // no id to dedup on — keep it rather than collapse the list
    if (seenIds.has(x.tmdbId)) return false;
    seenIds.add(x.tmdbId);
    return true;
  });
  // Carried-over titles are held out of the per-platform "New on X this week" groups and
  // given their own labelled section at the end. The section headings on this page are
  // literally "New on Netflix this week" — putting a title that arrived five weeks ago
  // under one is a false claim in a heading, which is the worst place to put one.
  const freshItems = items.filter((x) => !x.stillGood);
  const carriedItems = items.filter((x) => x.stillGood);
  // Group by platform, preserving the ranked order inside each group; biggest platforms first.
  const groups = new Map();
  for (const it of freshItems) {
    const p = it.platform || "More platforms";
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(it);
  }
  const platforms = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length || a.localeCompare(b));
  const platformNames = platforms.slice(0, 4).join(", ");

  // Titles ran past 100 characters once four platform names were appended, and descriptions
  // past 170 on 13 country pages. Both now degrade: platforms trimmed first, then dropped,
  // the query words ("New … Releases This Week in …") always kept.
  const two = platforms.slice(0, 2).join(", ");
  const base = `New ${V.Releases} This Week in ${countryName} (${monthYear})`;
  const title = fitFirst([
    `${base} — ${platformNames || "Streaming"} | FilmyChill`,
    `${base} — ${platformNames || "Streaming"}`,
    two ? `${base} — ${two}` : null,
    base,
  ], 60);
  // Same rule as the language pages: only claim completeness when the page can back it.
  const thin = freshItems.length < 8;
  const lead = thin ? "New movies and web series" : "Every new movie and web series";
  const desc = fitFirst([
    `${lead} streaming in ${countryName} this week${platformNames ? ` on ${platformNames}` : ""} — with ratings, verdicts and where to watch. Updated twice daily.`,
    `${lead} streaming in ${countryName} this week${two ? ` on ${two}` : ""} — with ratings, verdicts and where to watch. Updated twice daily.`,
    `${lead} streaming in ${countryName} this week — with ratings, verdicts and where to watch. Updated twice daily.`,
    `${lead} streaming in ${countryName} this week — ratings, verdicts and where to watch.`,
  ], 160);

  // FAQ per major platform + one "best of" — real answers from real data, mirrored in
  // FAQPage schema. Only platforms with titles get a question; schema only if >= 2 Q&As.
  const faqs = [];
  for (const p of platforms.slice(0, 3)) {
    const titles = groups.get(p).map((t) => `${t.title}${t.language ? ` (${t.language})` : ""}`).join(", ");
    faqs.push({ q: `What's new on ${p} in ${countryName} this week?`, a: `New on ${p} this week: ${titles}.` });
  }
  // "Best new ... this week" must rank THIS WEEK'S arrivals. Ranking the whole list by
  // rating hands the answer to whichever long-running series has the most votes, and this
  // string is the one an answer engine quotes.
  const bestPool = freshItems.length ? freshItems : items;
  const best = bestPool.filter((x) => x.rating != null).sort((a, b) => b.rating - a.rating).slice(0, 3);
  if (best.length >= 2) {
    faqs.push({
      q: `What are the best new ${V.releases} in ${countryName} this week?`,
      a: `Top-rated this week: ${best.map((x) => `${x.title} (${Number(x.rating).toFixed(1)}/10 on ${x.platform})`).join(", ")}.`,
    });
  }
  if (carriedItems.length >= 2) {
    faqs.push({
      q: `What else is worth watching right now in ${countryName}?`,
      a: `Not new this week, but still worth it: ${carriedItems.slice(0, 4).map((x) => `${x.title} (${x.platform})`).join(", ")}.`,
    });
  }
  const faqLd = faqs.length >= 2 ? {
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  } : null;

  const ld = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `New ${V.Releases} This Week in ${countryName}`,
    url,
    dateModified: gen,
    isPartOf: { "@type": "WebSite", "@id": "https://filmychill.com/#website" },
    // The ItemList sits under a CollectionPage named "New ... This Week", so it must contain
    // this week's arrivals only. Including carried-over titles made the structured data say
    // something the visible page (correctly) does not — and structured data is exactly what
    // an answer engine trusts over the prose.
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: freshItems.filter((x) => x.slug).length,
      itemListElement: freshItems.filter((x) => x.slug).map((x, i) => ({
        "@type": "ListItem", position: i + 1, name: x.title, url: filmPageUrl(code, x.slug),
      })),
    },
  };
  const breadcrumb = {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "FilmyChill", item: homeUrl },
      { "@type": "ListItem", position: 2, name: `${V.newOn} this week`, item: url },
    ],
  };

  // hreflang alternates: this page exists for every built country every run.
  const alts = (allCountries && allCountries.length ? allCountries : [{ code: "in", region: "IN" }])
    .map((c) => `<link rel="alternate" hreflang="${c.code === "in" ? "en-IN" : "en-" + (c.region || c.code.toUpperCase())}" href="${ottWeekUrl(c.code)}"/>`)
    .join("\n") + `\n<link rel="alternate" hreflang="x-default" href="${ottWeekUrl("in")}"/>`;

  const rowFor = (it) => {
    const badge = it.badge || (it.isRecent ? "New release" : null);
    const meta = [it.language, it.genre ? it.genre.split(" / ")[0] : null, freshLabel(it) || null].filter(Boolean).map(e).join(" · ");
    const inner = `
      ${it.poster ? `<img src="${e(it.poster)}" alt="${e(it.title)} poster" width="92" height="138" loading="lazy">` : "<div class=\"nop\"></div>"}
      <div>
        <div class="rt"><h3>${e(it.title)}</h3>${badge ? `<span class="badge">${e(badge)}</span>` : ""}${it.trending ? '<span class="badge trend">Trending</span>' : ""}</div>
        <div class="rm">${meta}</div>
        ${it.rating != null ? `<div class="rm"><b>★ ${Number(it.rating).toFixed(1)}</b>${it.fcScore ? " · " + e(it.fcScore.verdict) : ""}${trailerViewsLabel(it.trailerViews) ? " · " + trailerViewsLabel(it.trailerViews) : ""}</div>` : (it.fcScore ? `<div class="rm">${e(it.fcScore.verdict)}</div>` : it.verdict ? `<div class="rm">${e(it.verdict)}</div>` : "")}
      </div>`;
    return it.slug
      ? `<a class="row" href="${e(filmPagePath(code, it.slug))}">${inner}</a>`
      : `<div class="row">${inner}</div>`;
  };
  const sections = platforms.map((p) => `
  <section>
    <h2>New on ${e(p)} <span class="cnt">${groups.get(p).length}</span></h2>
    ${groups.get(p).map(rowFor).join("\n")}
  </section>`).join("\n")
  // Carried-over titles get one honest section at the end, mirroring the homepage's
  // "Still worth it" divider, rather than being folded into a "New on X this week" heading.
  + (carriedItems.length ? `
  <section>
    <h2>Still worth it <span class="cnt">${carriedItems.length}</span></h2>
    <p class="rm" style="margin:0 0 10px">Not new this week — added in earlier weeks and still worth your evening.</p>
    ${carriedItems.map(rowFor).join("\n")}
  </section>` : "");

  const faqHtml = faqs.length ? `
  <section>
    <h2>Quick answers</h2>
    <div class="faq">
      ${faqs.map((f) => `<details><summary>${e(f.q)}</summary><div class="fa">${e(f.a)}</div></details>`).join("\n      ")}
    </div>
  </section>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
<meta name="robots" content="max-image-preview:large">
<link rel="canonical" href="${e(url)}">
${alts}
<meta property="og:title" content="New ${e(V.Releases)} This Week in ${e(countryName)} (${e(monthYear)})">
<meta property="og:description" content="${e(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${e(url)}">
${ogImageTag(hubOgImage(freshItems, cfg))}
<meta name="twitter:card" content="summary">
<meta http-equiv="Content-Security-Policy" content="${cspWith("default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' https://image.tmdb.org data:; object-src 'none'; base-uri 'self'")}">${analyticsTag()}
<script type="application/ld+json">${ldJson(ld)}</script>
<script type="application/ld+json">${ldJson(breadcrumb)}</script>${faqLd ? `
<script type="application/ld+json">${ldJson(faqLd)}</script>` : ""}
<style>
  :root { --indigo:#4038C7; --marigold:#FFAD1F; --cream:#FFF7EC; --ink:#1A1633; --mute:#6B6890; --line:#E4E1F5; }
  * { box-sizing:border-box; } body { font-family:-apple-system,'Segoe UI',Roboto,sans-serif; background:#F7F5FF; color:var(--ink); margin:0; }
  .top { background:var(--indigo); padding:14px 16px; } .top a { color:var(--cream); text-decoration:none; font-weight:800; letter-spacing:1px; font-size:18px; }
  .top a span { color:var(--marigold); }
  .wrap { max-width:680px; margin:0 auto; padding:20px 16px 40px; }
  h1 { font-size:24px; margin:0 0 4px; line-height:1.3; }
  .upd { color:var(--mute); font-size:13px; margin-bottom:6px; }
  .lead { font-size:14.5px; line-height:1.6; color:var(--mute); margin:0 0 8px; }
  h2 { font-size:17px; margin:26px 0 10px; } .cnt { color:var(--marigold); }
  .row { display:grid; grid-template-columns:92px 1fr; gap:12px; background:#fff; border:1px solid var(--line); border-radius:12px; padding:10px; margin-bottom:10px; text-decoration:none; color:inherit; }
  .row img { border-radius:8px; display:block; width:92px; height:138px; object-fit:cover; background:var(--line); }
  .nop { width:92px; height:138px; border-radius:8px; background:var(--line); }
  .rt { display:flex; gap:8px; align-items:center; flex-wrap:wrap; } .rt h3 { font-size:16px; margin:2px 0; }
  .badge { font-size:10px; letter-spacing:1px; text-transform:uppercase; color:var(--ink); background:var(--marigold); border-radius:5px; padding:3px 7px; font-weight:800; }
  .badge.trend { background:#FF4E3A; color:#fff; }
  .rm { color:var(--mute); font-size:13px; margin-top:4px; } .rm b { color:var(--indigo); }
  .faq details { border-top:1px solid var(--line); padding:10px 0; }
  .faq summary { font-size:14.5px; font-weight:700; cursor:pointer; list-style:none; }
  .faq summary::-webkit-details-marker { display:none; }
  .faq summary::after { content:"+"; float:right; color:var(--indigo); font-weight:700; }
  .faq details[open] summary::after { content:"–"; }
  .faq .fa { font-size:14px; line-height:1.6; color:var(--mute); margin-top:8px; }
  .btn { display:inline-block; background:var(--indigo); color:#fff; font-weight:700; font-size:14px; padding:11px 20px; border-radius:10px; text-decoration:none; margin-top:20px; }
  footer { color:var(--mute); font-size:12px; text-align:center; padding:24px 16px; line-height:1.7; }
</style>
</head>
<body>
<div class="top"><a href="${e(homeUrl)}">FILMY<span>CHILL</span></a></div>
<div class="wrap">
  <h1>New ${e(V.Releases)} This Week in ${e(countryName)}</h1>
  <div class="upd">Updated ${e(updatedHuman)} · refreshed twice daily</div>
  <p class="lead">Every movie and web series that started streaming in ${e(countryName)} in the last 45 days, grouped by platform and ranked by rating — so you know what's actually worth your time.</p>
${sections}
${faqHtml}
  <a class="btn" href="${e(homeUrl)}">← This week's full picks (theatres + ${e(V.word)})</a>
</div>
<footer>
  ${footerAttribution()}© 2026 FilmyChill
</footer>
</body>
</html>`;
}

// ============================================================================
// RSS FEED — the distribution automation hook. One feed per country (root
// feed.xml for India, /<code>/feed.xml elsewhere) listing this run's theatre +
// OTT titles, newest first. GUIDs are stable per freshness-event (page URL +
// arrival/release date), so aggregators and automations (IFTTT/Zapier -> WhatsApp
// Channel, X) see a NEW entry exactly when a title newly arrives — not on every
// daily rebuild. Pure builder -> unit-testable; writer is a thin wrapper.
// ============================================================================
function buildRssFeed(data, cfg) {
  const e = escHtml; // & < > " ' — valid XML escaping too
  const code = (cfg && cfg.code) || "in";
  const m = COUNTRY_PAGE_META[code] || { name: (cfg && cfg.name) || "India", path: `/${code}/` };
  const home = `https://filmychill.com${m.path}`;
  const self = `${home}feed.xml`;
  const V = streamVocab(cfg && cfg.code ? cfg : { code }); // feed titles use the market's word
  const items = [...(data.theatres || []), ...(data.ott || [])]
    .filter((x) => x && x.title && x.slug)
    .map((x) => ({ x, when: x.ottSince || x.freshDate || x.released || "" }))
    .sort((a, b) => (b.when || "").localeCompare(a.when || ""))
    .slice(0, 30);
  const rfc822 = (d) => (d ? new Date(d) : new Date());
  const itemXml = items.map(({ x, when }) => {
    const url = filmPageUrl(code, x.slug);
    const bits = [x.platform, x.language, x.rating != null ? `★ ${Number(x.rating).toFixed(1)}` : null, x.verdict]
      .filter(Boolean).join(" · ");
    return `  <item>
    <title>${e(x.title)}${x.platform ? ` — ${e(x.platform)}` : ""}</title>
    <link>${e(url)}</link>
    <guid isPermaLink="false">${e(url)}::${e(when)}</guid>
    <pubDate>${rfc822(when).toUTCString()}</pubDate>
    <description>${e([bits, x.review].filter(Boolean).join(" — "))}</description>
  </item>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>FilmyChill — New Movies &amp; ${e(V.Releases)} This Week in ${e(m.name)}</title>
  <link>${e(home)}</link>
  <atom:link href="${e(self)}" rel="self" type="application/rss+xml"/>
  <description>What's worth watching this week in ${e(m.name)} — new theatre and ${e(V.releases)} with ratings and verdicts. Updated twice daily.</description>
  <language>en</language>
  <lastBuildDate>${new Date(data.generatedAt || Date.now()).toUTCString()}</lastBuildDate>
${itemXml}
</channel>
</rss>
`;
}

function writeRssFeed(data, cfg) {
  const p = cfg.code === "in" ? "feed.xml" : `${cfg.code}/feed.xml`;
  fs.writeFileSync(p, buildRssFeed(data, cfg));
  console.log(`  RSS feed: /${p}`);
}

module.exports = {
  buildEditorNote,
  buildOttWeekPage,
  buildRssFeed,
  ottWeekPath,
  ottWeekUrl,
  ssrCard,
  ssrEditorNote,
  ssrSoonCard,
  writeRssFeed,
};
