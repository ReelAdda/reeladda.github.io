// ============================================================================
// editorial.js — the lines a human editor would write on a card: Wikipedia and YouTube
// buzz, critics' takes (takes.json), the hook, the audience counterpoint.
// ============================================================================
"use strict";

const fs = require("fs");
const { capTrending } = require("./freshness.js");
const { ytIdOf } = require("./pagekit.js");
const { takeConfident } = require("./rules.js");
const { sleep, tmdb } = require("./tmdb.js");

// ============================================================================
// BUZZ SIGNALS — two free, licence-clean sources that TMDB can't provide:
//   1. Wikipedia pageviews (keyless): how many people are READING about a title
//      this week -> "Trending" badge. Article resolved precisely via Wikidata's
//      IMDb-ID property (P345) — never by title search, so no wrong-article risk.
//   2. YouTube Data API (optional YT_API_KEY secret): trailer view counts ->
//      "▶ 52M trailer views" social proof. Skipped silently when the key is absent.
// Both attach BEFORE data files are written (client cards read data.json) and both
// degrade gracefully: any failure means a missing badge, never a failed build.
// ============================================================================
const YT_API_KEY = process.env.YT_API_KEY || "";
const WIKI_HEADERS = { "User-Agent": "FilmyChillBot/1.0 (https://filmychill.com; vikramksharma87@gmail.com)" };
const BUZZ_TREND_MIN_DAILY = 10000; // avg daily en-wiki views that always count as trending
const BUZZ_TREND_SPIKE = 1.5;       // ...or recent week >= 1.5x the prior week
const BUZZ_SPIKE_FLOOR = 3000;      //    (with a floor, so 20 -> 40 views never "trends")

// Pure: daily view counts (oldest -> newest, ideally 14 entries) -> buzz verdict.
// Trending = big in absolute terms OR clearly accelerating. < 7 days of data -> null
// (brand-new articles can't prove a trend yet).
function computeBuzz(daily) {
  if (!Array.isArray(daily) || daily.length < 7) return null;
  const recent = daily.slice(-7);
  const prior = daily.slice(0, -7);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const recentAvg = avg(recent);
  const priorAvg = prior.length ? avg(prior) : 0;
  const trending = recentAvg >= BUZZ_TREND_MIN_DAILY
    || (priorAvg > 0 && recentAvg >= BUZZ_SPIKE_FLOOR && recentAvg >= BUZZ_TREND_SPIKE * priorAvg);
  return { weeklyViews: Math.round(recent.reduce((x, y) => x + y, 0)), trending };
}

// Pure: social-proof number formatting ("52M", "3.4M", "850K"). Label only from 1M up —
// below that, a view count reads as ANTI-proof, so we show nothing.
function fmtViews(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n >= 1e9) return (n / 1e9 >= 10 ? Math.round(n / 1e9) : +(n / 1e9).toFixed(1)) + "B";
  if (n >= 1e6) return (n / 1e6 >= 10 ? Math.round(n / 1e6) : +(n / 1e6).toFixed(1)) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}
function trailerViewsLabel(n) {
  return Number.isFinite(n) && n >= 1e6 ? `▶ ${fmtViews(n)} trailer views` : null;
}

// Keyless JSON fetch with one retry — for Wikimedia + YouTube endpoints.
async function fetchJsonKeyless(url, headers = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return res.json();
      lastErr = new Error(`HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) break; // permanent -> don't retry
    } catch (e) { lastErr = e; }
    await sleep(600);
  }
  throw lastErr;
}

// IMDb ID -> English Wikipedia article title, via Wikidata's P345 (IMDb ID) property.
// Two keyless calls; returns null when the title has no Wikidata item or no enwiki article.
async function wikiArticleForImdb(imdbId) {
  const search = await fetchJsonKeyless(
    `https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`haswbstatement:"P345=${imdbId}"`)}&srlimit=1&format=json`,
    WIKI_HEADERS);
  const qid = search?.query?.search?.[0]?.title;
  if (!qid) return null;
  const ent = await fetchJsonKeyless(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json`,
    WIKI_HEADERS);
  return ent?.entities?.[qid]?.sitelinks?.enwiki?.title || null;
}

// Last 14 full days of pageviews for an article (ends yesterday — today is incomplete).
async function wikiDailyViews(article) {
  const day = (offset) => {
    const d = new Date(Date.now() - offset * 864e5);
    return d.toISOString().slice(0, 10).replace(/-/g, "") + "00";
  };
  const slug = encodeURIComponent(article.replace(/ /g, "_"));
  const j = await fetchJsonKeyless(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${slug}/daily/${day(14)}/${day(1)}`,
    WIKI_HEADERS);
  return (j?.items || []).map((x) => x.views);
}

// Attach Wikipedia buzz to every theatre + OTT item across all countries. Same film
// appears in several countries' lists and pageviews are en-wiki-global, so each unique
// IMDb ID is fetched ONCE and fanned out. No imdbId -> no badge (never guess articles).
async function attachBuzz(dataByCode) {
  const byImdb = new Map();
  for (const data of Object.values(dataByCode)) {
    for (const it of [...(data.theatres || []), ...(data.ott || [])]) {
      if (!it.imdbId) continue;
      if (!byImdb.has(it.imdbId)) byImdb.set(it.imdbId, []);
      byImdb.get(it.imdbId).push(it);
    }
  }
  let resolved = 0, trendingCount = 0;
  for (const [imdbId, items] of byImdb) {
    try {
      const article = await wikiArticleForImdb(imdbId);
      if (article) {
        const buzz = computeBuzz(await wikiDailyViews(article));
        if (buzz) {
          resolved++;
          if (buzz.trending) trendingCount++;
          for (const it of items) {
            it.wikiWeeklyViews = buzz.weeklyViews;
            if (buzz.trending) it.trending = true;
          }
        }
      }
    } catch (e) {
      console.warn(`  buzz: ${items[0].title} skipped (${e.message})`);
    }
    await sleep(120); // polite pace against Wikimedia (well under their guidance)
  }
  console.log(`Buzz: ${resolved}/${byImdb.size} titles resolved via Wikipedia, ${trendingCount} trending`);
  capTrending(dataByCode);
}

// ============================================================================
// CRITICS' TAKE — one opinionated line per film, sourced from people who have
// already done the research. Primary source: the "Reception" section of the
// film's English Wikipedia article (a human-written summary of real critic
// consensus), located precisely via the buzz module's Wikidata P345 lookup —
// never by title search. Fallback: TMDB user reviews — the rating average sets the
// lean and the review BODIES are mined for repeated aspect mentions (signals only).
// The printed sentence is SYNTHESISED in our own words from extracted signals
// (overall tone + praised/criticised aspects) — never copied text — so it is
// licence-clean. Results are cached in takes.json (committed by the workflow):
//   { "<imdbId | kind:tmdbId>": { take, src, article, checked } }
// A title WITH a take is never re-fetched; a title WITHOUT one is re-checked
// each run (reception sections appear days after release) until it ages out of
// this week's lists. Everything degrades gracefully: no take -> no line shown,
// never a failed build.
// ============================================================================
const TAKES_FILE = "takes.json";
const TAKES_RETENTION_DAYS = 180; // prune cache entries not touched for this long
let TAKES = null;
function loadTakes() {
  if (TAKES) return TAKES;
  try { TAKES = JSON.parse(fs.readFileSync(TAKES_FILE, "utf8")); }
  catch { TAKES = {}; } // first ever run -> empty cache
  const cutoff = new Date(Date.now() - TAKES_RETENTION_DAYS * 864e5).toISOString().slice(0, 10);
  for (const k of Object.keys(TAKES)) if ((TAKES[k].checked || "") < cutoff) delete TAKES[k];
  return TAKES;
}

// The critics half of the FilmyChill Score for a title NOT on this week's lists (back-catalogue
// and frozen pages): whatever reception tone the takes cache already holds. Cache only — no
// network — and published critics only (Wikipedia), never TMDB viewer reviews.
function cachedCriticsTone(imdbId) {
  if (!imdbId) return null;
  const e = loadTakes()[imdbId];
  return e && e.src === "wiki" && e.a && e.a.tone ? e.a.tone : null;
}

// Aspect vocabulary: pattern found in reception prose -> the plain noun we print.
// Order matters only for readability; matches are deduped by printed noun.
const TAKE_ASPECTS = [
  [/performances?|acting|\bcast\b|portrayals?|lead role/i, "performances"],
  [/screenplay|script\b|writing|dialogues?|\bwritten\b/i, "writing"],
  [/direction|filmmaking|direct(?:ed|orial)/i, "direction"],
  [/pacing|\bpace\b|slow(?:ly|-moving|-paced| burn)?|dragg?(?:ed|y|ing)|meander|plodding/i, "pacing"],
  [/humou?r|comedy|comedic|jokes|laughs?|funny/i, "humour"],
  [/action (?:sequences|scenes|set.?pieces)|stunts|\baction\b|fight (?:scenes|choreography)/i, "action"],
  [/soundtrack|\bmusic\b|\bscore\b|songs|background score|composer/i, "music"],
  [/visual effects|\bvfx\b|\bcgi\b|visuals|cinematography|camerawork|photography/i, "visuals"],
  [/animation|animated/i, "animation"],
  [/chemistry/i, "lead chemistry"],
  [/emotional (?:depth|core|weight|resonance|impact)|poignan|moving|heart(?:felt|warming|breaking)|tear/i, "emotional weight"],
  [/second half|climax|ending|final act|third act|\bfinale\b|last (?:act|half|hour)/i, "second half"],
  [/first half|opening|\bsetup\b|slow start|initial/i, "first half"],
  [/runtime|\blength\b|overlong|bloated|too long|tight(?:ly)?|lean\b/i, "runtime"],
  [/editing|edited|cuts?\b/i, "editing"],
  [/world.?building|production design|\bsets?\b|set (?:design|pieces)|art direction/i, "production design"],
  [/twists?|unpredictable|predictab/i, "twists"],
  [/original(?:ity)?|fresh(?:ness)?|inventive|derivative|formulaic|clich[eé]/i, "originality"],
  [/tension|suspense|thrill(?:ing|er)|gripping|edge.of.(?:your|the).seat/i, "tension"],
  [/tone\b|tonal/i, "tone"],
  [/character (?:development|arcs?|work)|characteri[sz]ation|well.drawn/i, "characters"],
  [/themes?|thematic|message|commentary|allegory/i, "themes"],
  [/ambitio(?:n|us)|scope|scale|epic|grand/i, "ambition"],
  [/costumes?|\bmakeup\b|prosthetic/i, "costumes"],
  [/atmosphere|mood| atmospheric|immersive/i, "atmosphere"],
  [/story|plot|narrative|storyline/i, "story"],
];
const TAKE_PRAISE_RE = /prais\w+|laud\w+|acclaim\w+|applaud\w+|compliment\w+|appreciat\w+|celebrated|singled out|won praise|drew praise|impressed|highlights?|stand.?out|well.?received|hail\w+|commend\w+|plaudits|admir\w+/i;
const TAKE_PAN_RE = /criticis\w+|criticiz\w+|panned|faulted|drew criticism|flak|bemoaned|lamented|complain\w+|weakest|disappoint\w+|letdown|drag(?:ged|s)?\b|uneven|flaws?|shortcomings?|derid\w+|dismiss\w+|lambast\w+|slam(?:med|s)\b|underwhelm\w+|lackluste?r\w*|reservations/i;
// Splits a sentence into single-polarity clauses. The extra alternation splits BEFORE
// praise/criticism noun groups — Wikipedia's single most common reception sentence is
// "mixed reviews, with praise for X and criticism of Y", which the old splitter kept as
// one clause; both polarity regexes fired on it and the whole thing was thrown away as
// ambiguous. That one skip is why so many films fell back to hollow tone-only lines.
const TAKE_CLAUSE_SPLIT_RE = /\bbut\b|\bhowever\b|\bwhile\b|\balthough\b|\bthough\b|;|,\s+(?=(?:and\s+)?(?:the|several|some|critics|reviewers|others|many)\b)|,?\s+(?:and|but|with)\s+(?=(?:some\s+|particular\s+|widespread\s+|general\s+)?(?:praise|criticism|acclaim|complaints?|reservations|plaudits)\b)/i;

// Pure: reception-section plain text -> { tone, praised[], panned[] } | null.
// Tone is decided by whichever verdict phrase appears EARLIEST (reception sections
// open with the overall consensus — usually the RT/Metacritic sentence). Aspects
// are assigned polarity per clause, so "praised X but criticised Y" splits right.
function analyzeReception(text) {
  if (!text || text.trim().length < 120) return null; // too thin to trust
  const t = text.slice(0, 6000);
  const tones = [
    ["acclaim", /universal acclaim|critical acclaim|widespread acclaim|rave reviews|overwhelmingly positive/i],
    ["positive", /generally (?:positive|favou?rable)|positive (?:reviews|response|reception)|mostly positive|favou?rable reviews|well received by critics/i],
    ["mixed", /mixed(?:[- ]to[- ](?:positive|negative))? (?:reviews|response|reception|critical)|mixed or average|polari[sz]ed|divided (?:critics|reviews|opinion)/i],
    ["negative", /generally (?:negative|unfavou?rable)|negative (?:reviews|response|reception)|critically panned|\bpanned\b|overwhelming dislike|unfavou?rable reviews/i],
  ];
  let tone = null, toneAt = Infinity;
  for (const [name, re] of tones) {
    const m = t.match(re);
    if (m && m.index < toneAt) { tone = name; toneAt = m.index; }
  }
  // Concrete anchor: a Rotten Tomatoes / Metacritic figure from the prose. A NUMBER
  // is the strongest substance a tone-only line can carry — "a 58% critics' score"
  // beats "all over the map". Captured as a fact, printed verbatim, never invented.
  let score = null;
  let sm = t.match(/(\d{1,3})%\s*(?:of critics|on (?:the )?review aggregator|approval)/i)
        || t.match(/approval rating of (\d{1,3})%/i)
        || t.match(/Rotten Tomatoes[^.]{0,40}?(\d{1,3})%/i)
        || t.match(/(\d{1,3})%[^.]{0,30}?Rotten Tomatoes/i);
  if (sm) { const n = +sm[1]; if (n >= 0 && n <= 100) score = { kind: "rt", value: n }; }
  if (!score) {
    const mc = t.match(/Metacritic[^.]{0,60}?(?:score of |weighted average (?:score )?of )?(\d{1,3})(?:\s*(?:out of|\/)\s*100)?/i);
    if (mc) { const n = +mc[1]; if (n >= 0 && n <= 100) score = { kind: "mc", value: n }; }
  }
  const praised = new Set(), panned = new Set();
  for (const sentence of t.split(/(?<=[.!?])\s+/)) {
    for (const clause of sentence.split(TAKE_CLAUSE_SPLIT_RE)) {
      const isPraise = TAKE_PRAISE_RE.test(clause);
      const isPan = TAKE_PAN_RE.test(clause);
      if (isPraise === isPan) continue; // neither, or ambiguous clause -> skip
      for (const [re, noun] of TAKE_ASPECTS) {
        if (re.test(clause)) (isPraise ? praised : panned).add(noun);
      }
    }
  }
  // An aspect BOTH praised and panned used to be dropped as noise. It's the opposite —
  // "critics can't even agree about the second half" is the most human detail a
  // reception section offers. Keep it as a "divided" signal (max 1).
  const divided = [];
  for (const n of praised) if (panned.has(n)) { praised.delete(n); panned.delete(n); divided.push(n); }
  if (!tone && !praised.size && !panned.size && !divided.length && !score) return null;
  return { tone, praised: [...praised].slice(0, 2), panned: [...panned].slice(0, 1), divided: divided.slice(0, 1), score };
}

// Pure: analysis -> one original opinionated sentence (never source text). null when
// there is genuinely nothing to say — an absent line beats a hollow one.
// Tone-only variant pools: when the extractor finds a verdict but no aspects, several
// cards can share the same sentence and the human-voice illusion cracks. Each pool's
// variant is picked DETERMINISTICALLY by seed (the title's tmdbId), so a film keeps the
// same line across runs — variety across the page, stability across days. Index 0 keeps
// the original phrasing so a missing seed degrades to prior behaviour.
const TAKE_VARIANTS = {
  acclaim: [
    `Critics loved this one; reception has been close to universal acclaim.`,
    `Reviewers were close to unanimous — this one landed.`,
    `Almost nobody had a bad word for it.`,
    `The critical verdict is rare-air positive.`,
    `Wall-to-wall praise from the critics on this one.`,
    `Critics came away raving.`,
    `Reviews don't come much warmer than this.`,
    `Critics practically lined up to praise this one.`,
  ],
  positive: [
    `Critics have been largely positive on this one.`,
    `The reviews lean clearly positive.`,
    `Most critics came away happy.`,
    `Word from reviewers is solidly good.`,
    `The critical consensus tilts firmly positive.`,
    `Reviewers found plenty to like here.`,
    `Critics came away impressed, by and large.`,
    `Most reviews land firmly on the positive side.`,
  ],
  mixed: [
    `Critics are genuinely split on this one.`,
    `Reviews are all over the map on this one.`,
    `Critics couldn't agree — expect a love-it-or-hate-it watch.`,
    `Opinions split right down the middle on this one.`,
    `One critic's favourite, the next one's skip — that kind of film.`,
    `The reviews refuse to agree on this one.`,
    `A split decision — ask three critics, get three answers.`,
    `Genuinely divided — this is one that starts arguments.`,
  ],
  negative: [
    `Critics were not impressed with this one.`,
    `The reviews were not kind.`,
    `Critics largely gave this one a pass.`,
    `Reviewers came away cold on this one.`,
    `Critics found little to love here.`,
    `A rough outing with the reviewers.`,
    `Reviewers mostly checked out early on this one.`,
    `The critics' patience ran thin here.`,
  ],
};
// If a take is one of the tone-only pool lines, re-pick the variant for THIS film's
// seed. Cached entries from before the variant system all sit at index 0, which put
// the identical sentence on three cards of one page. Aspect-bearing takes (unique by
// construction) pass through untouched. Pure, deterministic, zero network.
function reseedTake(take, seed = 0) {
  if (!take) return take;
  for (const pool of Object.values(TAKE_VARIANTS)) {
    if (pool.includes(take)) return pool[Math.abs(Number(seed) || 0) % pool.length];
  }
  return take;
}

// TAKE_VERSION stamps every cache entry with the extractor generation that wrote it.
// v3 made takes number-free (a printed RT%/Metacritic figure clashed with the card's
// TMDB rating pill). v4 replaces the single fixed aspect templates (and the fixed TMDB
// fallback line) with seeded variant pools, so same-shaped takes stop repeating one
// sentence across a page. Bumping it re-analyses stale entries ONCE with the current
// extractor; entries already stamped with the current version are never re-flagged, so
// a film whose seed maps to index 0 (the old wording) can't enter a refetch loop.
const TAKE_VERSION = 5; // v5: entries store mined analysis (a/ta); pre-v5 refetch once
function isPoolTake(take) {
  if (!take) return false;
  return Object.values(TAKE_VARIANTS).some((pool) => pool.includes(take));
}
// The v3 single-template shapes (aspect slots as wildcards) plus the v3 TMDB fallback
// line. A cached take matching one of these under an older version stamp gets recomposed
// once with the seeded pools — same one-time purge mechanism as the v3 number purge.
const LEGACY_TAKE_RES = [
  /^Critics loved it — special praise for the .+\.$/,
  /^Critics liked it: the .+ won praise, though the .+ drew some flak\.$/,
  /^Critics liked it, especially the .+\.$/,
  /^Critics were broadly positive, with reservations about the .+\.$/,
  /^Critics are split — praise for the .+, pushback on the .+\.$/,
  /^Critics are split, though the .+ found admirers\.$/,
  /^Critics are split, with the .+ drawing most complaints\.$/,
  /^Genuinely divisive — critics can't settle this one\.$/,
  /^Critics were rough on it, mostly over the .+\.$/,
  /^Reviewers praised the .+ but flagged the .+\.$/,
  /^Reviewers singled out the .+ for praise\.$/,
  /^Reviewers' main gripe: the .+\.$/,
  /^Early viewer reviews on TMDB (?:are mixed|lean .+)\.$/,
];
function isLegacyTake(take) {
  return !!take && LEGACY_TAKE_RES.some((re) => re.test(take));
}

// Aspect-bearing template pools: one fixed sentence per tone/aspect shape meant every
// "acclaimed, performances praised" film on a page read identically once several shared a
// shape. Each shape is now a seeded pool with the same contract as TAKE_VARIANTS: index 0
// preserves the previous phrasing (settled caches and default-seed calls are unchanged),
// the variant is picked deterministically by the film's tmdbId, and every line stays
// digit-free. Wording is chosen so audienceCounterpoint's camp regexes still classify it.
const ASPECT_VARIANTS = {
  acclaimP: [
    (p) => `Critics loved it — special praise for the ${p}.`,
    (p) => `Near-universal acclaim, with the ${p} singled out most often.`,
    (p) => `Critics loved this one, and the ${p} drew the loudest praise.`,
    (p) => `A critical darling — reviewers kept coming back to the ${p}.`,
    (p) => `Rave reviews across the board, especially for the ${p}.`,
  ],
  positivePC: [
    (p, c) => `Critics liked it: the ${p} won praise, though the ${c} drew some flak.`,
    (p, c) => `Mostly good reviews — the ${p} impressed, even if the ${c} didn't.`,
    (p, c) => `Critics came away positive, praising the ${p} while docking points for the ${c}.`,
    (p, c) => `The ${p} won critics over; the ${c} drew the odd complaint.`,
    (p, c) => `Reviews lean positive: strong marks for the ${p}, quibbles about the ${c}.`,
  ],
  positiveP: [
    (p) => `Critics liked it, especially the ${p}.`,
    (p) => `Good word from critics, with the ${p} earning most of the praise.`,
    (p) => `Reviewers responded well — the ${p} came in for particular praise.`,
    (p) => `Critics were won over, largely on the strength of the ${p}.`,
    (p) => `A well-reviewed outing; the ${p} stood out for critics.`,
  ],
  positiveC: [
    (c) => `Critics were broadly positive, with reservations about the ${c}.`,
    (c) => `Broadly positive reviews, though the ${c} drew grumbles.`,
    (c) => `Critics mostly approved — the ${c} was the common complaint.`,
    (c) => `A positive reception on balance, with the ${c} taking the knocks.`,
    (c) => `Reviewers liked it more than not, save for gripes about the ${c}.`,
  ],
  mixedPC: [
    (p, c) => `Critics are split — praise for the ${p}, pushback on the ${c}.`,
    (p, c) => `A divided reception: the ${p} won praise, the ${c} took the heat.`,
    (p, c) => `Critics can't agree — high marks for the ${p}, complaints about the ${c}.`,
    (p, c) => `Reviews cut both ways: the ${p} impressed, the ${c} frustrated.`,
    (p, c) => `Half the critics point to the ${p}, the other half to the ${c}.`,
  ],
  mixedP: [
    (p) => `Critics are split, though the ${p} found admirers.`,
    (p) => `A divided verdict, with the ${p} the one thing most critics agreed on.`,
    (p) => `Reviews swing both ways; the ${p} earns praise even from the doubters.`,
    (p) => `Critics can't settle on this one, but the ${p} gets its due.`,
    (p) => `Opinion is split — the ${p} is the bright spot either way.`,
  ],
  mixedC: [
    (c) => `Critics are split, with the ${c} drawing most complaints.`,
    (c) => `A divided response, and the ${c} carries most of the blame.`,
    (c) => `Reviews swing both ways, with the ${c} the sticking point.`,
    (c) => `Critics can't agree, though the ${c} bothered nearly everyone.`,
    (c) => `Opinion is split, and the ${c} is where it splits hardest.`,
  ],
  positivePDiv: [
    (p, d) => `Critics liked it — high marks for the ${p}, though the ${d} kept them arguing.`,
    (p, d) => `Mostly good reviews: praise for the ${p}, real debate over the ${d}.`,
    (p, d) => `Critics came away positive on the ${p}; on the ${d}, they part ways.`,
    (p, d) => `A well-reviewed outing, strongest on the ${p} — only the ${d} drew real argument.`,
  ],
  mixedPDiv: [
    (p, d) => `Critics are split — the ${p} won praise, the ${d} is the fault line.`,
    (p, d) => `A divided verdict: credit for the ${p}, a genuine rift over the ${d}.`,
    (p, d) => `Reviews swing both ways — kind to the ${p}, at war over the ${d}.`,
    (p, d) => `Critics can't agree here; the ${p} earns praise, the ${d} starts the arguing.`,
  ],
  positiveDiv: [
    (d) => `Critics are mostly positive — except when it comes to the ${d}.`,
    (d) => `Mostly good reviews, with real disagreement only about the ${d}.`,
    (d) => `Positive on balance, but ask two critics about the ${d} and you'll get two answers.`,
    (d) => `Most critics approved — just don't ask them about the ${d}.`,
  ],
  mixedDiv: [
    (d) => `Critics are split, nowhere more than over the ${d}.`,
    (d) => `A divided verdict, with the ${d} right on the fault line.`,
    (d) => `Reviews swing both ways here, most sharply over the ${d}.`,
    (d) => `Critics can't agree on this one — least of all about the ${d}.`,
  ],
  mixedScore: [
    () => `Genuinely divisive — critics can't settle this one.`,
    () => `Truly divisive — for every critic who bought in, one checked out.`,
    () => `A love-it-or-hate-it reception, right down the middle.`,
    () => `Critics are split clean down the middle on this one.`,
  ],
  negativeC: [
    (c) => `Critics were rough on it, mostly over the ${c}.`,
    (c) => `The reviews were not kind, and the ${c} took the worst of it.`,
    (c) => `Critics came away cold, pointing mainly at the ${c}.`,
    (c) => `A drubbing from reviewers, with the ${c} the main casualty.`,
    (c) => `Critics found little to love, least of all the ${c}.`,
  ],
  nonePC: [
    (p, c) => `Reviewers praised the ${p} but flagged the ${c}.`,
    (p, c) => `The ${p} earned praise; the ${c} caught flak.`,
    (p, c) => `Critics highlighted the ${p}, with the ${c} the weak link.`,
    (p, c) => `Strong marks for the ${p}, less love for the ${c}.`,
    (p, c) => `The ${p} works, per reviewers — the ${c} less so.`,
  ],
  noneP: [
    (p) => `Reviewers singled out the ${p} for praise.`,
    (p) => `If critics agreed on one thing, it was the ${p}.`,
    (p) => `The ${p} drew the most notice from reviewers.`,
    (p) => `Critics kept circling back to the ${p} — in a good way.`,
    (p) => `The ${p} is what reviewers walked away talking about.`,
  ],
  noneC: [
    (c) => `Reviewers' main gripe: the ${c}.`,
    (c) => `The ${c} came in for the most criticism.`,
    (c) => `If reviewers dinged anything, it was the ${c}.`,
    (c) => `The ${c} drew the bulk of the complaints.`,
    (c) => `Critics' sore spot here is the ${c}.`,
  ],
};

function composeTake(a, seed = 0) {
  if (!a) return null;
  const list = (arr) => (arr.length === 2 ? `${arr[0]} and ${arr[1]}` : arr[0]);
  const p = (a.praised || []).length ? list(a.praised) : null;
  const c = (a.panned || []).length ? a.panned[0] : null;
  const d = (a.divided || []).length ? a.divided[0] : null;
  const vary = (pool) => pool[Math.abs(Number(seed) || 0) % pool.length];
  const varyA = (pool, ...args) => vary(pool)(...args);
  // NO NUMBERS in the take text — an RT% or Metacritic figure next to the card's TMDB
  // rating pill reads as the site contradicting itself (96% vs 6.9/10 are different
  // scales, but the reader can't know that). The extracted score still informs WHICH
  // sentence we pick (hard evidence of division/acclaim); it just never gets printed.
  switch (a.tone) {
    case "acclaim":
      if (p) return varyA(ASPECT_VARIANTS.acclaimP, p);
      return vary(TAKE_VARIANTS.acclaim);
    case "positive":
      if (p && c) return varyA(ASPECT_VARIANTS.positivePC, p, c);
      if (p && d) return varyA(ASPECT_VARIANTS.positivePDiv, p, d);
      if (d) return varyA(ASPECT_VARIANTS.positiveDiv, d);
      if (p) return varyA(ASPECT_VARIANTS.positiveP, p);
      if (c) return varyA(ASPECT_VARIANTS.positiveC, c);
      return vary(TAKE_VARIANTS.positive);
    case "mixed":
      if (p && c) return varyA(ASPECT_VARIANTS.mixedPC, p, c);
      if (p && d) return varyA(ASPECT_VARIANTS.mixedPDiv, p, d);
      if (d) return varyA(ASPECT_VARIANTS.mixedDiv, d);
      if (p) return varyA(ASPECT_VARIANTS.mixedP, p);
      if (c) return varyA(ASPECT_VARIANTS.mixedC, c);
      if (a.score) return varyA(ASPECT_VARIANTS.mixedScore); // aggregator-backed -> firm claim is honest
      return null; // no aspect, no evidence -> stay silent, don't say "all over the map"
    case "negative":
      if (c) return varyA(ASPECT_VARIANTS.negativeC, c);
      return vary(TAKE_VARIANTS.negative);
    default:
      if (p && c) return varyA(ASPECT_VARIANTS.nonePC, p, c);
      if (p) return varyA(ASPECT_VARIANTS.noneP, p);
      if (c) return varyA(ASPECT_VARIANTS.noneC, c);
      return null;
  }
}

// English-Wikipedia reception section as plain text, or null if the article has none.
// Uses TextExtracts (keyless); sub-headings inside the section are stripped, their
// prose kept, so "=== Critical response ===" under "== Reception ==" still counts.
// One extract fetch now serves TWO editorial features: the article LEAD (framing facts —
// remake/sequel/adaptation/festival, extracted by extractHook) and the RECEPTION section
// (critic consensus, analysed by analyzeReception). Same single keyless call as before.
async function wikiExtract(article) {
  const j = await fetchJsonKeyless(
    `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(article)}`,
    WIKI_HEADERS);
  const page = Object.values(j?.query?.pages || {})[0];
  const text = page?.extract || "";
  const lead = text.split(/\n==[^=]/)[0].slice(0, 2500); // everything before the first section
  const m = text.match(/\n==+\s*(?:Critical (?:response|reception)|Reception|Reviews|Critical and audience response)\s*==+\n([\s\S]*?)(?=\n==[^=]|$)/i);
  const reception = m ? m[1].replace(/\n==+[^=\n]+==+\n/g, "\n") : null;
  return { lead, reception };
}

// ============================================================================
// THE HOOK — one framing fact per film, the line every human editor leads
// with: "A remake of the Malayalam film X" / "The follow-up to Y" / "Based on
// Hugh Howey's novels" / "Premiered at Cannes". Extracted from the Wikipedia
// lead paragraph (facts, composed in our own words — licence-clean), cached in
// takes.json next to the take. Pure -> unit-testable. One hook max, by
// priority: remake > sequel/spin-off > adaptation > festival > debut. Absent
// beats invented: no pattern, no hook.
// ============================================================================
function extractHook(lead, item = {}) {
  if (!lead || lead.length < 60) return null;
  const t = lead.replace(/\s+/g, " ");
  const clean = (x) => x.trim().replace(/["'\u2018\u2019\u201c\u201d]/g, "").replace(/\s+/g, " ").slice(0, 48);
  // Titles/names in lead prose end at a clause boundary: punctuation, a parenthetical
  // (usually the year), or " and/which/that " followed by a lowercase word — the
  // lowercase requirement keeps titles like "Rick and Morty" intact while stopping
  // "Gatta Kusthi and continues the story". Lazy captures + this lookahead.
  const B = String.raw`(?=,|\.|;|:|\(| and [a-z]| which | that |$)`;
  let m;
  if ((m = t.match(new RegExp(String.raw`remake of (?:the )?(?:\d{4} )?(?:([A-Z]\w+)(?:-language)? )?film ["'\u2018\u201c]?([A-Z][^.;,("'\u2019\u201d]{1,45}?)${B}`))))
    return `A remake of the ${m[1] ? m[1] + " " : ""}film \u2018${clean(m[2])}\u2019.`;
  if ((m = t.match(new RegExp(String.raw`(?:a |the )?sequel to (?:the \d{4} film |the film )?["'\u2018\u201c]?([A-Z][^.;,("'\u2019\u201d]{1,45}?)${B}`))))
    return `The follow-up to \u2018${clean(m[1])}\u2019.`;
  if ((m = t.match(new RegExp(String.raw`spin-?off (?:of|from) (?:the )?([A-Z][^.;,("]{1,45}?)${B}`))))
    return `A spin-off of ${clean(m[1])}.`;
  if (/based on (?:a )?true (?:events|story)|based on real events/i.test(t))
    return `Based on true events.`;
  if ((m = t.match(new RegExp(String.raw`based on the (novel|book|manga|play|short story|webtoon|comic book series|comics)(?: series)? ["'\u2018\u201c]?([A-Z][^.;,("'\u2019\u201d]{1,45}?)["'\u2019\u201d]? by ([A-Z][\w. -]{1,32}?)${B}`))))
    return `Based on ${clean(m[3])}'s ${m[1]} \u2018${clean(m[2])}\u2019.`;
  if ((m = t.match(new RegExp(String.raw`based on the (novel|book|manga|play|short story|webtoon|comics)(?: series)? (?:of the same name )?by ([A-Z][\w. -]{1,32}?)${B}`))))
    return `Based on the ${m[1]} by ${clean(m[2])}.`;
  if ((m = t.match(new RegExp(String.raw`premiered at the (?:\d{4} )?(?:\d+(?:st|nd|rd|th) )?([A-Z][^.;,(]{1,45}?(?:Film Festival|Festival de Cannes))`))))
    return `Premiered at the ${clean(m[1])}.`;
  if (/directorial debut/.test(t) && item.director)
    return `${item.director}'s directorial debut.`;
  return null;
}

// ============================================================================
// AUDIENCE COUNTERPOINT — the most interesting editorial fact is DISAGREEMENT.
// When the critics' take and the audience rating point opposite ways, say so.
// Computed fresh each run from data already on the item (ratings move; cached
// take text doesn't), so it stays current without any network. Pure.
// ============================================================================
const COUNTER_DISAGREE = [
  `Audiences disagree \u2014 viewers rate it far higher.`,
  `Viewers beg to differ \u2014 audience scores run well above the critics' line.`,
  `The audience isn't buying the reviews \u2014 they rate it far higher.`,
];
const COUNTER_COOLER = [
  `Audiences are cooler on it than the critics were.`,
  `Viewers haven't matched the critics' enthusiasm \u2014 audience scores run lower.`,
  `The audience is less convinced than the critics were.`,
];
function audienceCounterpoint(item) {
  if (!item || !item.take || item.rating == null) return null;
  // TMDB-review fallback takes vs the TMDB rating is viewers vs viewers — there's no
  // critic/audience disagreement to report, so those takes never get a counterpoint.
  if (item.takeSrc === "tmdb") return null;
  const votes = item.imdbRating != null ? (item.imdbVotes || 0) : (item.votes || 0);
  if (votes < 50) return null; // too few voters to call it an audience
  const t = item.take;
  // Camp classification is PRECEDENCE-ORDERED (split > negative > positive) so a variant
  // that carries a positive word inside a split or negative sentence ("the visuals
  // impressed, the pacing frustrated") can never flip camps. Keyword lists cover every
  // pool and aspect-template variant above.
  const splitTake = /split|all over the map|(?:can't|couldn't|refuse to) agree|down the middle|divisive|can't settle|divided|cut both ways|half the critics|swing both ways|one critic's favourite|next one's skip|three answers|starts arguments/i.test(t);
  const negTake = !splitTake && /rough|not impressed|not kind|gave this one a pass|came away cold|little to love|drubbing|checked out early|patience ran thin/i.test(t);
  const posTake = !splitTake && !negTake && /loved|liked it|positive|came away (?:happy|impressed)|solidly good|rare-air|plenty to like|good word|well-reviewed|responded well|won (?:critics )?over|acclaim|rav(?:e|ing)|darling|unanimous|this one landed|bad word for it|much warmer|lined up to praise|approved|mostly good reviews|wall-to-wall praise|impressed/i.test(t);
  // The counterpoint sentence itself is seeded per film so a page with two disagreements
  // doesn't print the same disagreement line twice. Index 0 keeps the original wording.
  const seed = Math.abs(Number(item.tmdbId) || 0);
  if ((negTake || splitTake) && item.rating >= 7.5)
    return COUNTER_DISAGREE[seed % COUNTER_DISAGREE.length];
  if (posTake && item.rating <= 5.5)
    return COUNTER_COOLER[seed % COUNTER_COOLER.length];
  return null;
}

// Fallback: TMDB user reviews, used only when at least 2 rated reviews exist — one
// opinion is an anecdote, not a lean. Tone-only pools below (index 0 = the original
// wording); aspect-bearing viewer pools follow the miner further down.
const TMDB_TAKE_VARIANTS = {
  "strongly positive": [
    `Early viewer reviews on TMDB lean strongly positive.`,
    `First viewer reviews on TMDB are strongly positive.`,
    `Early word from viewers on TMDB is emphatically good.`,
  ],
  positive: [
    `Early viewer reviews on TMDB lean positive.`,
    `First viewer reviews on TMDB tilt positive.`,
    `Early word from viewers on TMDB runs positive.`,
  ],
  mixed: [
    `Early viewer reviews on TMDB are mixed.`,
    `First viewer reviews on TMDB are split.`,
    `Early word from viewers on TMDB is mixed.`,
  ],
  negative: [
    `Early viewer reviews on TMDB lean negative.`,
    `First viewer reviews on TMDB tilt negative.`,
    `Early word from viewers on TMDB runs negative.`,
  ],
};
// Viewer-register sentiment cues (user reviews don't say "lauded"; they say "loved it"
// or "waste of time"). Same TAKE_ASPECTS vocabulary maps mentions to printable nouns.
const VIEWER_POS_RE = /\blov(?:e|ed|es)\b|amazing|brilliant|fantastic|excellent|superb|stunning|gorgeous|\bgreat\b|wonderful|terrific|masterpiece|gripping|riveting|engaging|hilarious|impress\w*|outstanding|phenomenal|beautifully|top.?notch|worth (?:a )?watch|blown away|stole the show|stand.?out|shines?\b|enjoy(?:ed|able)|\bfun\b|highlight/i;
const VIEWER_NEG_RE = /boring|waste|terrible|awful|horrible|disappoint\w*|\bmess\b|\bdull\b|\bbland\b|\bweak\b|predictable|clich[eé]|cringe|overlong|dragg?(?:ed|s|y)?\b|sloppy|\blazy\b|f(?:e|a)ll(?:s)? flat|fails?\b|worst|annoying|tedious|forgettable|underwhelm\w*|mediocre|cheesy|wooden|pointless|unwatchable|letdown|ruined/i;
// "not great", "wasn't worth watching": a negator shortly before a positive cue means
// the clause is NOT praise. Conservative: such clauses are skipped entirely.
const VIEWER_NEGATION_RE = /\b(?:not|never|no|hardly|barely|isn'?t|wasn'?t|don'?t|didn'?t|doesn'?t|far from|nothing)\s+(?:\w+\s+){0,2}(?:amazing|brilliant|fantastic|excellent|great|good|worth|impressive|enjoyable|fun|engaging|gripping|special|memorable)\b/i;

// Pure: TMDB review objects -> { praised[], panned[] }. An aspect counts only when at
// least TWO separate reviews agree on its polarity — one person's opinion is an
// anecdote, a repeated one is a pattern. Contested aspects (2+ each way) are dropped:
// with a handful of user reviews that's noise, not a story.
function mineViewerAspects(results) {
  const texts = (results || []).map((r) => String(r?.content || "")).filter((s) => s.trim().length >= 40).slice(0, 8);
  const praiseCount = {}, panCount = {};
  if (texts.length >= 2) {
    for (const raw of texts) {
      const text = raw.replace(/[*_#>`~\[\]]/g, " ").replace(/\s+/g, " ").slice(0, 1800);
      const pr = new Set(), pa = new Set(); // per-review sets: one review = one vote per aspect
      for (const sentence of text.split(/(?<=[.!?])\s+/)) {
        for (const clause of sentence.split(TAKE_CLAUSE_SPLIT_RE)) {
          if (!clause) continue;
          const pos = VIEWER_POS_RE.test(clause), neg = VIEWER_NEG_RE.test(clause);
          if (pos === neg) continue; // neither, or ambiguous clause -> skip
          if (pos && VIEWER_NEGATION_RE.test(clause)) continue; // negated praise
          for (const [re, noun] of TAKE_ASPECTS) if (re.test(clause)) (pos ? pr : pa).add(noun);
        }
      }
      for (const n of pr) praiseCount[n] = (praiseCount[n] || 0) + 1;
      for (const n of pa) panCount[n] = (panCount[n] || 0) + 1;
    }
  }
  const top = (mine, theirs) => Object.keys(mine)
    .filter((n) => mine[n] >= 2 && mine[n] > (theirs[n] || 0))
    .sort((x, y) => mine[y] - mine[x]);
  return { praised: top(praiseCount, panCount).slice(0, 2), panned: top(panCount, praiseCount).slice(0, 1) };
}

// Aspect-bearing viewer pools. Clearly viewer-labelled ("on TMDB") so a reader never
// mistakes them for critic consensus; digit-free; agreement-free phrasing (plural nouns
// like "performances" fit every slot). takeSrc stays "tmdb", so these never trigger an
// audience counterpoint (viewers vs viewers isn't a disagreement).
const TMDB_ASPECT_VARIANTS = {
  P: [
    (lw, p) => `Early viewer reviews on TMDB skew ${lw}, with the ${p} getting most of the love.`,
    (lw, p) => `Viewer word on TMDB runs ${lw} — reviews keep coming back to the ${p}.`,
    (lw, p) => `Early TMDB reviews skew ${lw}; viewers keep mentioning the ${p}.`,
    (lw, p) => `First viewer reviews on TMDB run ${lw}, with the warmest words for the ${p}.`,
  ],
  PC: [
    (lw, p, c) => `Early viewer reviews on TMDB skew ${lw} — love for the ${p}, gripes about the ${c}.`,
    (lw, p, c) => `Viewer word on TMDB runs ${lw}: praise for the ${p}, knocks on the ${c}.`,
    (lw, p, c) => `Early TMDB reviews skew ${lw}, cheering the ${p} while flagging the ${c}.`,
    (lw, p, c) => `First viewer reviews on TMDB run ${lw} — viewers rate the ${p} far above the ${c}.`,
  ],
  C: [
    (lw, c) => `Early viewer reviews on TMDB skew ${lw}, with the ${c} the common complaint.`,
    (lw, c) => `Viewer word on TMDB runs ${lw} — most gripes point at the ${c}.`,
    (lw, c) => `Early TMDB reviews skew ${lw}; the main complaint is about the ${c}.`,
    (lw, c) => `First viewer reviews on TMDB run ${lw}, and the loudest complaints are about the ${c}.`,
  ],
};

// Pure: mined viewer analysis -> one sentence, seeded like composeTake. No aspects ->
// the existing tone-only pools (index 0 unchanged since v4).
function composeTmdbTake(ta, seed = 0) {
  if (!ta || !ta.lean || !TMDB_TAKE_VARIANTS[ta.lean]) return null;
  const list = (arr) => (arr.length === 2 ? `${arr[0]} and ${arr[1]}` : arr[0]);
  const p = (ta.praised || []).length ? list(ta.praised) : null;
  const c = (ta.panned || []).length ? ta.panned[0] : null;
  const vary = (pool) => pool[Math.abs(Number(seed) || 0) % pool.length];
  if (p && c) return vary(TMDB_ASPECT_VARIANTS.PC)(ta.lean, p, c);
  if (p) return vary(TMDB_ASPECT_VARIANTS.P)(ta.lean, p);
  if (c) return vary(TMDB_ASPECT_VARIANTS.C)(ta.lean, c);
  return vary(TMDB_TAKE_VARIANTS[ta.lean]);
}

// Network: one reviews call (same endpoint as before — the bodies were already in the
// response, previously discarded) -> { lean, praised, panned } | null.
async function tmdbReviewMine(item) {
  if (!item.tmdbId) return null;
  const j = await tmdb(`/${item.kind === "tv" ? "tv" : "movie"}/${item.tmdbId}/reviews`, {});
  const results = j?.results || [];
  const ratings = results.map((r) => r?.author_details?.rating).filter((n) => Number.isFinite(n));
  if (ratings.length < 2) return null;
  const avg = ratings.reduce((x, y) => x + y, 0) / ratings.length;
  const lean = avg >= 7.5 ? "strongly positive" : avg >= 6 ? "positive" : avg >= 4.5 ? "mixed" : "negative";
  const mined = mineViewerAspects(results);
  return { lean, praised: mined.praised, panned: mined.panned };
}

async function tmdbReviewTake(item) { // kept for compatibility: mine + compose in one step
  const ta = await tmdbReviewMine(item);
  return ta ? composeTmdbTake(ta, Number(item.tmdbId) || 0) : null;
}

// Attach a critics' take to every theatre + OTT item across all countries. Same
// dedupe-and-fan-out shape as attachBuzz: each unique title is researched ONCE.
async function attachTakes(dataByCode) {
  const takes = loadTakes();
  const today = new Date().toISOString().slice(0, 10);
  const byKey = new Map();
  for (const data of Object.values(dataByCode)) {
    for (const it of [...(data.theatres || []), ...(data.ott || [])]) {
      const key = it.imdbId || (it.tmdbId ? `${it.kind}:${it.tmdbId}` : null);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(it);
    }
  }
  let found = 0;
  for (const [key, items] of byKey) {
    try {
      let entry = takes[key];
      // Refetch when: never seen; no take yet (reception sections appear late); a LEGACY
      // entry predating hooks (hook === undefined); OR a stale take from an older extractor
      // version — a tone-only pool line, a v3 single-template aspect/TMDB-fallback line
      // (isLegacyTake), or any take containing a digit (v3 made takes number-free so they
      // can't clash with the rating pill). Version purges BYPASS the checked-today gate:
      // they run exactly once per entry (v gets stamped), so there's no re-fetch loop, and
      // waiting a day just leaves known-stale lines on the live site.
      // v5 entries carry the mined analysis; anything older lacks it, so a version
      // mismatch alone marks the entry stale — one refetch per entry (v gets stamped,
      // no loop), and every cached title gains aspect data in a single sweep.
      const stale = !!entry && entry.v !== TAKE_VERSION;
      const needsFetch = !entry || stale || ((!entry.take || entry.hook === undefined) && entry.checked !== today);
      if (needsFetch) {
        let take = stale ? null : entry?.take || null, src = stale ? null : entry?.src || null, hook = null;
        let a = stale ? null : entry?.a || null, ta = stale ? null : entry?.ta || null;
        let article = entry?.article || null; // the article LOCATION is a stable fact — survives purges
        if (key.startsWith("tt")) { // real IMDb id -> precise Wikipedia route
          if (!article) article = await wikiArticleForImdb(key);
          if (article) {
            const { lead, reception } = await wikiExtract(article);
            hook = extractHook(lead, items[0]);
            if (!take) {
              a = analyzeReception(reception);
              const composed = composeTake(a, Number(items[0].tmdbId) || 0);
              if (composed) { take = composed; src = "wiki"; } else a = null;
            }
          }
        }
        if (!take) {
          ta = await tmdbReviewMine(items[0]);
          const t = ta ? composeTmdbTake(ta, Number(items[0].tmdbId) || 0) : null;
          if (t) { take = t; src = "tmdb"; } else ta = null;
        }
        entry = { take, src, hook, article: article || undefined, a: a || undefined, ta: ta || undefined, checked: today, v: TAKE_VERSION };
        takes[key] = entry;
        await sleep(150); // polite pace against Wikimedia
      } else {
        entry.checked = today; // touch so retention pruning keeps live titles
      }
      if (entry.take || entry.hook) {
        if (entry.take) found++;
        const seed = Number(items[0].tmdbId) || 0;
        // Compose from stored analysis when we have it (exact per-film seeding, and pool
        // growth reaches cached titles instantly); string-level reseed only for entries
        // still mid-purge.
        const seededTake = entry.a ? composeTake(entry.a, seed) || entry.take
          : entry.ta ? composeTmdbTake(entry.ta, seed) || entry.take
          : reseedTake(entry.take, seed);
        const takeAspects = entry.a?.praised?.length ? entry.a.praised
          : entry.ta?.praised?.length ? entry.ta.praised : null;
        for (const it of items) {
          // CONFIDENCE GATE — mirrors the one already on the rating. An isFresh item
          // (released within 7 days AND under 20 votes) renders "Just released — verdict
          // soon" on its pill. Every take template asserts a SETTLED consensus ("a critical
          // darling", "critics can't agree", "the ambition drew the bulk of the complaints")
          // and that is exactly the claim a three-day-old Wikipedia reception stub cannot
          // support. Printing both put "verdict soon" and a verdict on the same card —
          // Mandaadi, Sardar 2 and The Revolutionaries all shipped that contradiction.
          // Same principle as llmsRatingConfident() and audienceCounterpoint's rating!=null
          // guard: low-confidence commentary is WITHHELD, not softened.
          // Scoped to RECENCY, not vote count: an older niche film sitting on "Not enough
          // ratings yet" can have a perfectly settled critical consensus, and keeps its line.
          // The take stays CACHED in takes.json either way — only the attach is gated — so
          // the line appears on its own once the film ages out, with no refetch.
          if (entry.take && takeConfident(it)) {
            it.take = seededTake;
            it.takeSrc = entry.src;
            if (takeAspects) it.takeAspects = takeAspects; // feeds the editor's note flourish
            if (entry.src === "wiki" && entry.article) it.takeArticle = entry.article; // provenance -> JSON-LD citation
            // The critics half of the FilmyChill Score (lib/fcscore.js): only published
            // critics count, so only a Wikipedia reception tone — never TMDB viewer reviews.
            if (entry.src === "wiki" && entry.a && entry.a.tone) it.criticsTone = entry.a.tone;
            // Disagreement is computed FRESH each run — ratings move, cached text doesn't.
            const counter = audienceCounterpoint(it);
            if (counter) it.takeCounter = counter;
          }
          if (entry.hook) it.hook = entry.hook;
        }
      }
    } catch (e) {
      console.warn(`  take: ${items[0].title} skipped (${e.message})`);
    }
  }
  fs.writeFileSync(TAKES_FILE, JSON.stringify(takes, null, 1));
  console.log(`Takes: ${found}/${byKey.size} titles have a critics' line`);
}

// Attach YouTube trailer view counts (theatres + OTT + coming soon — pre-release trailer
// hype is buzz too). One videos.list call per 50 unique trailers; ~2 calls/run total,
// costing ~2 of the 10,000 free daily quota units.
async function attachTrailerStats(dataByCode) {
  if (!YT_API_KEY) { console.log("Trailer stats: YT_API_KEY not set — skipping (optional feature)."); return; }
  const byYt = new Map();
  for (const data of Object.values(dataByCode)) {
    for (const it of [...(data.theatres || []), ...(data.ott || []), ...(data.comingSoon || [])]) {
      const id = ytIdOf(it.trailer);
      if (!id) continue; // search-URL fallback trailers have no video id
      if (!byYt.has(id)) byYt.set(id, []);
      byYt.get(id).push(it);
    }
  }
  const ids = [...byYt.keys()];
  let attached = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const j = await fetchJsonKeyless(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${chunk.join(",")}&key=${YT_API_KEY}`);
      for (const v of j?.items || []) {
        const n = Number(v?.statistics?.viewCount);
        if (!Number.isFinite(n)) continue;
        attached++;
        for (const it of byYt.get(v.id) || []) it.trailerViews = n;
      }
    } catch (e) { console.warn(`  trailer stats: chunk skipped (${e.message})`); }
  }
  console.log(`Trailer stats: views attached for ${attached}/${ids.length} trailers`);
}

module.exports = {
  cachedCriticsTone,
  analyzeReception,
  attachBuzz,
  attachTakes,
  attachTrailerStats,
  audienceCounterpoint,
  composeTake,
  composeTmdbTake,
  computeBuzz,
  extractHook,
  fmtViews,
  isLegacyTake,
  isPoolTake,
  mineViewerAspects,
  reseedTake,
  TAKE_VERSION,
  TAKES_RETENTION_DAYS,
  trailerViewsLabel,
};
