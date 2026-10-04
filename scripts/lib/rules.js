// ============================================================================
// rules.js — the site's shared vocabulary and editorial rules: the streaming word per
// market, theatrical->streaming windows, the exclusion list, language names and overrides,
// verdicts, OTT freshness, and country-name helpers. Depends on nothing but core.
// ============================================================================
"use strict";

const { COUNTRIES, COUNTRY_PAGE_META, slugify } = require("./core.js");

// ============================================================================
// STREAMING VOCABULARY — the word each market actually searches with.
// "OTT" went mainstream in India: viewers say it, papers print it, and "<film>
// OTT release date" is a normal query. Everywhere else it is industry jargon —
// a US or German viewer searches "streaming", never "OTT". UAE keeps OTT
// because its ~3.5M Indian expats search Indian-style for exactly the Hindi and
// Malayalam titles that market is here for. Set per country via streamWord;
// anything unset falls back to "streaming", which is the safe global default.
// One source of truth: page copy, title tags, FAQ questions, and the archive
// patcher all read from here, so a country's wording can never drift apart.
// ============================================================================
function streamVocab(cfg) {
  // A partial cfg ({ code: "in" }) must still get India's vocabulary, so the code is
  // resolved against COUNTRIES rather than trusting streamWord to be present.
  const code = (cfg && cfg.code) || "in"; // no cfg == India, matching buildFilmPage's own default
  const full = COUNTRIES.find((c) => c.code === code);
  const w = (cfg && cfg.streamWord) || (full && full.streamWord) || "streaming";
  const isOtt = w === "OTT";
  return {
    word: w,                                        // "OTT" | "streaming"
    // Title-tag fragment. Capitalised for the OTT markets ("OTT Release Date"),
    // sentence-shaped elsewhere ("Streaming Release Date").
    titleFragment: isOtt ? "OTT Release Date" : "Streaming Release Date",
    // The FAQ question. India gets the doubled phrasing that matches how the
    // query is actually typed; streaming markets get the plain question.
    faqQuestion: (t) => isOtt
      ? `When is ${t} releasing on OTT? (OTT release date)`
      : `When is ${t} coming to streaming?`,
    // Noun phrase inside sentences: "An OTT release date for X…" /
    // "A streaming release date for X…"
    article: isOtt ? "An" : "A",
    releaseDate: isOtt ? "OTT release date" : "streaming release date",
    release: isOtt ? "OTT release" : "streaming release",
    arrival: isOtt ? "OTT arrival" : "streaming arrival",
    // Heading over the new date block on film pages.
    heading: (t) => isOtt ? `When is ${t} coming to OTT?` : `When is ${t} coming to streaming?`,
    // ---- PAGE COPY (homepages, weekly page, hubs, RSS, headings) ----
    // Everything below exists so the SAME market word reaches title tags, H1s,
    // nav labels and body copy. A US visitor should never read "OTT" anywhere.
    // Title-case, for title tags and H1s: "New Movies & Streaming Releases…".
    Releases: isOtt ? "OTT Releases" : "Streaming Releases",
    // Sentence-case, for descriptions and body prose: "…theatre and streaming releases".
    releases: isOtt ? "OTT releases" : "streaming releases",
    // Nav/breadcrumb/footer label for the weekly aggregation page.
    newOn: isOtt ? "New on OTT" : "New on streaming",
    // Capitalised bare noun for UI labels that start with it ("Awaiting streaming").
    Word: isOtt ? "OTT" : "Streaming",
  };
}

// ============================================================================
// THEATRICAL -> STREAMING WINDOW. "<film> OTT release date" is searched hardest in
// the weeks AFTER a theatrical run, by people who missed it and are waiting. We
// cannot know the real date — no public feed carries unannounced windows — so we
// publish the honest thing: the typical gap for that industry, expressed as a
// RANGE and always labelled as a pattern, never a promise. Windows differ by
// industry (Hindi runs longer than Hollywood; Malayalam is famously quick), so
// they're keyed by language with a conservative default.
// If the film is already streaming, none of this is used — real data wins.
// ============================================================================
const STREAM_WINDOW_WEEKS = {
  hi: [6, 8], ta: [4, 7], te: [4, 7], ml: [3, 6], kn: [4, 7], pa: [5, 8],
  mr: [5, 8], bn: [5, 8], en: [5, 9], de: [5, 9],
};
const STREAM_WINDOW_DEFAULT = [5, 9];
// LANG maps code->name; we store windows by code, so invert for the name we carry on items.
function windowForLanguage(languageName) {
  if (!languageName) return STREAM_WINDOW_DEFAULT;
  for (const [code, name] of Object.entries(LANG)) {
    if (name === languageName && STREAM_WINDOW_WEEKS[code]) return STREAM_WINDOW_WEEKS[code];
  }
  return STREAM_WINDOW_DEFAULT;
}
// Whether the language above resolved to a REAL measured window or fell through to the
// default. Naming the language in a snippet ("the usual Arabic window") implies we have data
// for it; for anything outside STREAM_WINDOW_WEEKS we do not, and the copy must not pretend.
function hasLanguageWindow(languageName) {
  if (!languageName) return false;
  for (const [code, name] of Object.entries(LANG)) {
    if (name === languageName && STREAM_WINDOW_WEEKS[code]) return true;
  }
  return false;
}

// Pure: given a theatrical release date and language, describe the expected window.
// Returns null when we have no release date to anchor to (say nothing rather than guess),
// and a `passed` flag once the window has closed — at which point claiming "expected around
// October" for a date already gone would be worse than saying nothing useful.
// `now` is injectable for tests.
function streamWindowEstimate(releasedISO, languageName, now = new Date()) {
  if (!releasedISO) return null;
  const rel = new Date(releasedISO + "T00:00:00Z");
  if (Number.isNaN(rel.getTime())) return null;
  const [lo, hi] = windowForLanguage(languageName);
  const from = new Date(rel.getTime() + lo * 7 * 86400000);
  const to = new Date(rel.getTime() + hi * 7 * 86400000);
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const label = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const span = label(from) === label(to) ? label(from) : `${label(from)} and ${label(to)}`;
  return { lo, hi, span, passed: now.getTime() > to.getTime() };
}

// The same window, compacted for a meta description ("Sep–Oct 2026"). Body copy has room for
// "September 2026 and October 2026"; a 155-character snippet does not, and that span is the
// single most clickable thing we can put in one. Returns null when there is no live window to
// quote — never a vague placeholder, which is exactly what killed CTR in the first place.
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function streamWindowShort(releasedISO, languageName, now = new Date()) {
  const est = streamWindowEstimate(releasedISO, languageName, now);
  if (!est || est.passed) return null;
  const rel = new Date(releasedISO + "T00:00:00Z");
  const from = new Date(rel.getTime() + est.lo * 7 * 86400000);
  const to = new Date(rel.getTime() + est.hi * 7 * 86400000);
  const fm = from.getUTCMonth(), fy = from.getUTCFullYear();
  const tm = to.getUTCMonth(), ty = to.getUTCFullYear();
  const short = (fm === tm && fy === ty) ? `${MONTHS_ABBR[fm]} ${fy}`
    : fy === ty ? `${MONTHS_ABBR[fm]}\u2013${MONTHS_ABBR[tm]} ${ty}`
    : `${MONTHS_ABBR[fm]} ${fy}\u2013${MONTHS_ABBR[tm]} ${ty}`;
  return { ...est, short, known: hasLanguageWindow(languageName) };
}

// Manual exclusion list — films that should NEVER appear regardless of what TMDB returns
// (banned in India, pulled from release, festival-only, or otherwise mislisted as current
// theatrical). TMDB exposes no "banned"/"still in theatres" signal, so this is a human
// override. To block a film: find its TMDB ID (in data.json as tmdbId, or the TMDB URL,
// e.g. themoviedb.org/movie/1692948) and add it below with a short note.
const EXCLUDE_IDS = new Set([
  1692948, // Chardikala — banned in India / not in theatres
  1155818, // Satluj — banned in India
  1725370, // Satluj — DUPLICATE TMDB record of the banned film (new id, same movie)
]);
// TITLE-level exclusions: TMDB grows duplicate records for Indian releases (new id,
// same film), and an id blocklist can't see the next duplicate. Titles here are
// matched by slug, so casing/punctuation variants ("Satluj!", "SATLUJ") all die too.
// Keep entries lowercase-slug form. Removing a title re-admits every record of it.
const EXCLUDE_TITLES = new Set([
  "satluj",     // banned in India
  "chardikala", // banned in India
]);
// One predicate for every pool: blocked by id OR by slugified title (movies use
// `title`, TV uses `name`; enriched items use `title` — cover all three).
function isExcluded(c) {
  if (!c) return false;
  if (EXCLUDE_IDS.has(c.id) || EXCLUDE_IDS.has(c.tmdbId)) return true;
  const t = c.title || c.name;
  return t ? EXCLUDE_TITLES.has(slugify(t)) : false;
}

const LANG = { en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", ml: "Malayalam", kn: "Kannada", ko: "Korean", ja: "Japanese", es: "Spanish", fr: "French", mr: "Marathi", bn: "Bengali", pa: "Punjabi", gu: "Gujarati", de: "German", it: "Italian", pt: "Portuguese", zh: "Chinese" };

// TMDB's original_language is community-entered and occasionally WRONG for Indian
// releases (a Tamil film tagged "en"). Aggregators that trust it blindly then show
// "English" for a Tamil film — exactly the error a language-first Indian site cannot
// afford. Overrides are keyed by TMDB id and map to the CORRECT ISO code; langCode()
// wins over original_language everywhere (display labels AND language quotas), and
// logs when it fires so stale entries stay visible in the Action run.
// Verified against Moviebuff / official teasers, not other TMDB-fed aggregators.
const LANG_CODE_OVERRIDES = {
  1639137: "ta", // Kadhal Aura — Madness of Love (2026): Tamil; TMDB says "en"
  1649723: "pa", // Judaa (2026, Simerjit Singh / Gulab Sidhu): Punjabi; TMDB says "en"
};
const langOverridesFired = new Set(); // log each override once per run, not per country
function langCode(m) {
  if (!m || m.id == null) return m ? m.original_language : undefined;
  const fix = LANG_CODE_OVERRIDES[m.id];
  if (fix && fix !== m.original_language && !langOverridesFired.has(m.id)) {
    langOverridesFired.add(m.id);
    console.log(`lang override: ${m.title || m.name || m.id} — TMDB says "${m.original_language}", using "${fix}"`);
  }
  return fix || m.original_language;
}

// Language DISPLAY name. The curated LANG map wins (our preferred spellings), then
// Intl.DisplayNames resolves any other ISO 639 code ("ar" -> "Arabic", "th" -> "Thai")
// so a raw code can never leak onto a language chip again — that is exactly the bug
// this replaces: LANG[code] || code rendered an "ar 1" chip the day an Arabic title
// entered the list. Falls back to the code only if the runtime lacks DisplayNames.
let _langDN = null;
function langName(code) {
  if (!code) return code;
  if (LANG[code]) return LANG[code];
  try {
    _langDN = _langDN || new Intl.DisplayNames(["en"], { type: "language" });
    const n = _langDN.of(code);
    if (n && n !== code) return n;
  } catch { /* unknown/invalid code -> fall through */ }
  return code;
}


// May this item carry a critics' take? An isFresh item (released within 7 days AND under
// 20 votes) shows "Just released — verdict soon" on its rating pill, and every take template
// asserts a settled consensus — so the two lines contradicted each other on the same card.
// Pure and recency-scoped: an older niche film on "Not enough ratings yet" has thin AUDIENCE
// votes, not an unsettled critical consensus, and keeps its line.
function takeConfident(item) {
  return !!item && !item.isFresh;
}

function verdict(rating, votes) {
  if (!votes || votes < 10) return "Not enough ratings"; // age-neutral: also used for old films
  if (rating >= 7.5) return "Must watch";
  if (rating >= 6.5) return "Worth a watch";
  if (rating >= 5.5) return "Decent one-time watch";
  return "Skip unless curious";
}









const OTT_FRESH_DAYS = 45;

// Derive the freshness date for an OTT title from a TMDB detail object.
// MOVIE: its release_date. TV: the air date of the most recent NON-special season (season 0
// is specials) — NOT the series' original launch, which for a long-running show (Rick and
// Morty = 2013) is meaningless for "is it fresh now". Falls back to last_air_date /
// first_air_date when per-season data is absent. Pure function -> unit-testable.
function deriveFreshDate(kind, d) {
  if (!d) return null;
  if (kind === "movie") return d.release_date || null;
  const seasonDates = (d.seasons || [])
    .filter((s) => s.season_number > 0 && s.air_date)
    .map((s) => s.air_date);
  return seasonDates.length ? seasonDates.sort().pop() : (d.last_air_date || d.first_air_date || null);
}

// Is an OTT item fresh enough to list? A null freshDate means TMDB has no date yet (genuinely
// too new) -> kept, so we never punish brand-new titles. A future or within-window date passes;
// anything older than OTT_FRESH_DAYS is a rewatch/catalogue title and is dropped. `now` is
// injectable for deterministic tests. Pure function -> unit-testable.
function isOttFresh(freshDate, now = Date.now()) {
  if (!freshDate) return true;
  const age = (now - new Date(freshDate).getTime()) / 864e5;
  return age <= OTT_FRESH_DAYS;
}

// Manual/local regeneration from existing data.json: PAGES_ONLY=1 node scripts/update.js
// ============================================================
// PRE-RENDER — inject this week's films as static HTML into
// index.html between SSR markers, so crawlers (and visitors,
// pre-hydration) see real content and real links instead of
// "Loading fresh picks". The page JS replaces it on load.
// ============================================================

// "Netflix" + "Netflix Standard with Ads" (or "... with Ads") is one service to a
// reader — the ad tier is a plan, not a platform. Keep the ad-tier name only when the
// base service isn't itself in the list (some titles stream ONLY on the ad plan).
function dedupeProviders(names) {
  const stripAds = (n) => String(n).replace(/\s+(?:standard\s+|basic\s+)?with ads$/i, "");
  const plain = new Set(names.filter((n) => stripAds(n) === n));
  return names.filter((n) => stripAds(n) === n || !plain.has(stripAds(n)));
}

// TMDB's raw recommendation feed is collaborative-filter noise for Indian titles — a
// Hindi campus comedy gets 1980s American sitcoms. Re-rank by relevance to THIS film
// before taking six: same language dominates, then recency, kind, and a popularity
// floor. Reorder only — never drops below six, so the grid can't go empty.
function rankSimilar(results, kind, origLang) {
  const year = (s) => parseInt(String(s || "").slice(0, 4), 10) || 0;
  const nowY = new Date().getFullYear();
  return (results || [])
    .filter((x) => (x.title || x.name) && x.poster_path)
    .map((x, i) => {
      const xKind = x.media_type === "tv" || x.first_air_date ? "tv" : "movie";
      const score = (x.original_language === origLang ? 4 : 0)
        + (nowY - year(x.release_date || x.first_air_date) <= 6 ? 2 : 0)
        + (xKind === kind ? 1 : 0)
        + ((x.vote_count || 0) >= 100 ? 1 : 0);
      return { x, score, i };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i) // stable: TMDB order breaks ties
    .map((r) => r.x);
}

function replaceBetween(html, tag, inner) {
  const start = `<!--SSR:${tag}-->`, end = `<!--/SSR:${tag}-->`;
  const a = html.indexOf(start), b = html.indexOf(end);
  // Fail LOUD, not silent: a missing/malformed marker means the template is broken and the
  // page would render wrong (this is the class of bug that caused the PAGECODE issue). A
  // hard throw fails the build so it's caught in CI, not discovered live.
  if (a === -1) throw new Error(`SSR marker <!--SSR:${tag}--> missing in template`);
  if (b === -1) throw new Error(`SSR marker <!--/SSR:${tag}--> (closing) missing in template`);
  if (b < a) throw new Error(`SSR markers for ${tag} are out of order (closing before opening)`);
  // Guard against the comment-in-script trap: SSR markers must never sit inside an
  // EXECUTABLE <script> (HTML comments break JS there). Non-executable script blocks like
  // <script type="application/ld+json"> are data, not code, so comments are safe there.
  const before = html.slice(0, a);
  const lastOpen = before.lastIndexOf("<script");
  const lastClose = before.lastIndexOf("</script>");
  if (lastOpen > lastClose) {
    const openTag = before.slice(lastOpen, before.indexOf(">", lastOpen) + 1);
    const typeMatch = openTag.match(/type\s*=\s*["']([^"']+)["']/i);
    const scriptType = typeMatch ? typeMatch[1].toLowerCase() : "";
    // Executable if no type, or a JS MIME type / module. Data types (ld+json, etc.) are safe.
    const isExecutable = scriptType === "" || /javascript|ecmascript|module/.test(scriptType);
    if (isExecutable) {
      throw new Error(`SSR marker ${tag} is inside an executable <script> tag — HTML comments break JS there. Move it to HTML context.`);
    }
  }
  return html.slice(0, a + start.length) + inner + html.slice(b);
}


// English locale conventions per country — grouping ("12,34,567" lakh-style is correct ONLY
// for India; the US expects "1,234,567") and long-date order ("July 1, 2026" in the US vs
// "1 July 2026" elsewhere). Germany gets en-GB: the site's language is English, and en-GB's
// day-first order matches German convention for an English-language page.
// Prose-ready country name ("the US", not the config's "United States") for any cfg.
const countryNameFor = (cfg) => (COUNTRY_PAGE_META[(cfg && cfg.code) || "in"] || {}).name || (cfg && cfg.name) || "India";

// Every non-India edition names its country in its <title> (Oct 2026). 1,511 country pages
// didn't: the UAE, an "OTT" market, reused India's titles word for word, and long names fell
// to a country-less last tier elsewhere, so 434 titles were shared by 1,186 pages and the
// editions read as duplicates. Unescaped string in, string out; India is returned untouched.
// The country goes after "Where to Watch" or "Release/Streaming Date"; a bare "Film (Year)"
// gains "— Where to Watch in <country>". Past 60 characters the year goes, never the country.
function titleWithCountry(title, cfg) {
  const code = (cfg && cfg.code) || "in";
  if (code === "in" || !title) return title;
  const country = countryNameFor(cfg);
  if (String(title).includes(`in ${country}`)) return title;
  const t = String(title).replace(/\s+[|–—-]\s+FilmyChill$/, "");
  let out;
  if (/Where to Watch$/.test(t)) out = `${t} in ${country}`;
  else if (/\b(?:Release|Streaming) Date\b/.test(t)) out = t.replace(/\b((?:Release|Streaming) Date)\b/, `$1 in ${country}`);
  else out = `${t} — Where to Watch in ${country}`;
  return out.length > 60 ? out.replace(/ \(\d{4}\)/, "") : out;
}
// "India, US, UK, Australia, Germany, UAE, Canada &amp; Singapore" — generated from the
// config so a new country can never be missing from the fallback copy again.
function countryListForProse() {
  const short = { "United States": "US", "United Kingdom": "UK" };
  const names = COUNTRIES.map((c) => short[c.name] || c.name);
  return names.slice(0, -1).join(", ") + " &amp; " + names[names.length - 1];
}

// Reverse of the LANG display map ("Hindi" -> "hi"). Items carry a DISPLAY language
// (langName), country configs carry ISO codes (priorityLangs), so marquee selection needs
// the bridge. Every priorityLang across every market is in LANG, so this covers all of them.
const LANG_CODE_BY_NAME = Object.fromEntries(Object.entries(LANG).map(([c, n]) => [n, c]));

module.exports = {
  countryListForProse,
  countryNameFor,
  dedupeProviders,
  deriveFreshDate,
  EXCLUDE_IDS,
  EXCLUDE_TITLES,
  isExcluded,
  isOttFresh,
  LANG_CODE_BY_NAME,
  LANG_CODE_OVERRIDES,
  langCode,
  langName,
  OTT_FRESH_DAYS,
  rankSimilar,
  replaceBetween,
  streamVocab,
  streamWindowEstimate,
  streamWindowShort,
  hasLanguageWindow,
  takeConfident,
  titleWithCountry,
  verdict,
};
