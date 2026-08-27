
// ============================================================================
// core.js — primitives shared by every other module: the country table, HTML
// escaping, date/runtime formatting and film URL construction.
//
// Nothing here reaches out to another module, which is what keeps the dependency
// graph acyclic: core has no imports, everything else imports core.
// ============================================================================
"use strict";

// Per-country configuration. Each country runs the SAME pipeline parameterised by region,
// watch_region, priority languages, and soft quotas. INDIA IS FIRST and reproduces the
// existing single-country behaviour EXACTLY — its regionalLangs order, targets, and soon
// quota match the previous hardcoded values, so its output stays byte-for-byte identical.
const COUNTRIES = [
  {
    code: "in", name: "India", region: "IN", watchRegion: "IN", streamWord: "OTT",
    priorityLangs: ["hi", "ta", "te"],
    regionalLangs: ["hi", "ta", "te", "ml", "kn", "pa", "mr", "bn"], // order = India's regionalOrder
    ottRegionalLangs: ["hi", "ta", "te", "ml", "kn", "pa", "mr", "bn"], // OTT regional pool langs
    theatreTargets: [["hi", 3], ["en", 2], ["ta", 1], ["te", 1]],
    soonTargets: [["en", 3], ["hi", 3], ["__regional__", 2]],
  },
  {
    code: "us", name: "United States", region: "US", watchRegion: "US",
    priorityLangs: ["en", "es"],
    regionalLangs: ["es"],
    ottRegionalLangs: ["es"],
    theatreTargets: [["en", 5], ["es", 1]],
    soonTargets: [["en", 5], ["es", 1], ["__regional__", 2]],
  },
  {
    code: "uk", name: "United Kingdom", region: "GB", watchRegion: "GB",
    priorityLangs: ["en"],
    regionalLangs: ["hi", "pa"],
    ottRegionalLangs: [], // English-only OTT: fill all slots from international (English) trending
    theatreTargets: [["en", 6]],
    soonTargets: [["en", 6], ["__regional__", 2]],
  },
  {
    code: "au", name: "Australia", region: "AU", watchRegion: "AU",
    priorityLangs: ["en"],
    regionalLangs: ["hi", "zh", "ko"],
    ottRegionalLangs: [], // English-only OTT: fill all slots from international (English) trending
    theatreTargets: [["en", 6]],
    soonTargets: [["en", 6], ["__regional__", 2]],
  },
  {
    code: "de", name: "Germany", region: "DE", watchRegion: "DE",
    priorityLangs: ["de", "en"],
    regionalLangs: ["de"],
    ottRegionalLangs: ["de"],
    theatreTargets: [["de", 5], ["en", 2]],
    soonTargets: [["de", 5], ["en", 2], ["__regional__", 1]],
  },
  // ---- Diaspora markets: countries where FilmyChill's India strength IS the edge. ----
  // UAE: ~3.5M Indian expats; Indian films routinely top the UAE box office, with
  // Malayalam cinema disproportionately huge (Kerala diaspora) alongside Hindi/Tamil.
  {
    code: "ae", name: "UAE", region: "AE", watchRegion: "AE", streamWord: "OTT",
    priorityLangs: ["hi", "en", "ml"],
    regionalLangs: ["hi", "ml", "ta", "te", "ar"],
    ottRegionalLangs: ["hi", "ml", "ta", "te"],
    theatreTargets: [["hi", 2], ["en", 2], ["ml", 1], ["ta", 1]],
    soonTargets: [["en", 2], ["hi", 2], ["__regional__", 2]],
  },
  // Canada: the Punjabi-cinema capital outside India (Brampton/Surrey) plus a large
  // Hindi audience; French included for Quebec theatrical coverage.
  {
    code: "ca", name: "Canada", region: "CA", watchRegion: "CA",
    priorityLangs: ["en", "pa", "hi"],
    regionalLangs: ["pa", "hi", "fr", "ta"],
    ottRegionalLangs: ["pa", "hi"],
    theatreTargets: [["en", 4], ["pa", 1], ["hi", 1]],
    soonTargets: [["en", 4], ["__regional__", 3]],
  },
  // Singapore: Tamil is an official language; strong Mandarin-language box office too.
  {
    code: "sg", name: "Singapore", region: "SG", watchRegion: "SG",
    priorityLangs: ["en", "ta", "zh"],
    regionalLangs: ["ta", "zh", "hi", "ms"],
    ottRegionalLangs: ["ta", "zh"],
    theatreTargets: [["en", 4], ["ta", 1], ["zh", 1]],
    soonTargets: [["en", 4], ["ta", 1], ["__regional__", 2]],
  },
];

// "145 min" reads like metadata; "2h 25m" reads like an answer to "do I have time
// tonight?". Used on cards, modal, and film pages so runtime formats identically
// everywhere. Under an hour stays "52m".
function fmtRuntime(mins) {
  const n = Number(mins);
  if (!Number.isFinite(n) || n <= 0) return "";
  const h = Math.floor(n / 60), m = Math.round(n % 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function trim(text, n = 160) {
  if (!text) return "";
  if (text.length <= n) return text;
  // Prefer ending at a sentence boundary when one exists past 60% of the budget — a
  // complete sentence reads finished; a mid-thought "…" reads broken. Fall back to the
  // old word-boundary cut when the last sentence end is too early (or absent).
  const slice = text.slice(0, n);
  let cut = -1;
  for (const m of slice.matchAll(/[.!?](?:\s|$)/g)) cut = m.index;
  if (cut >= Math.floor(n * 0.6)) return slice.slice(0, cut + 1);
  // Word-boundary cut alone still ends on articles and connectives ("sparks a…",
  // "the story of the…") which reads broken. Peel trailing function words and any
  // dangling punctuation so the fragment ends on a content word before the ellipsis.
  let w = slice.replace(/\s+\S*$/, "");
  const TAIL = /\s+(?:a|an|the|and|or|but|nor|of|to|in|on|at|by|for|with|from|as|into|onto|over|under|after|before|between|during|through|that|which|who|whom|whose|his|her|their|its|is|are|was|were|be|been|has|have|had|will|would|can|could|should|must|may|might|when|while|where|whom|so|than|then)$/i;
  while (TAIL.test(w)) w = w.replace(TAIL, "");
  w = w.replace(/[\s,;:—–\-]+$/, "");
  return w + "…";
}

// Human-readable freshness line for a card's meta row, so recency is VISIBLE, not implied:
// "Released 12 Jun" for movies, "Latest season 21 Jun" for TV (whose `released` field is
// the series' original launch and would mislead). Year is appended only when it differs
// from the current year, so a Dec title shown in Jan still reads unambiguously. Must stay
// in sync with the client-side freshLabel()/fmtDate() in index.html. Pure -> unit-testable.
function fmtDateShort(dateStr, now = Date.now(), locale = "en-IN") {
  const dt = new Date(dateStr);
  const opts = { day: "numeric", month: "short" };
  if (dt.getFullYear() !== new Date(now).getFullYear()) opts.year = "numeric";
  return dt.toLocaleDateString(locale, opts);
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function slugify(t) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Page path for a film in a given country. India keeps the legacy flat path /movie/<slug>.html
// (preserves already-indexed URLs + the existing archive); other countries are namespaced under
// /<code>/movie/<slug>.html so the same title in different markets never collides and each has
// its own region-correct "where to watch". Used everywhere a film page is linked or written.
// x-default for hreflang must point to a page that EXISTS. India is the canonical default
// only when India actually has the film; otherwise a foreign-market film (never listed in
// India) would advertise a dead India URL as its default — Google follows hreflang alternates
// as discovery URLs and files the miss as a 404. Fallback: first available copy in COUNTRIES
// order (deterministic; stable across runs).
function xDefaultCode(codes) {
  if (!codes || !codes.length) return "in";
  if (codes.includes("in")) return "in";
  for (const c of COUNTRIES) if (codes.includes(c.code)) return c.code;
  return codes[0];
}

function filmPagePath(code, slug) {
  return code === "in" ? `/movie/${slug}.html` : `/${code}/movie/${slug}.html`;
}

function filmPageUrl(code, slug) {
  return `https://filmychill.com${filmPagePath(code, slug)}`;
}

// ============================================================================
// LANGUAGE LANDING PAGES (India) — the query surface India actually uses.
// Nobody searches "new movies India"; they search "new tamil movies on OTT".
// One page per major language at /<language>/, filtered from India's data,
// refreshed every run. Same licence-clean sources, same take lines, own
// canonical + FAQ schema. Pure builder -> unit-testable; writer is thin.
// ============================================================================
const LANGUAGE_PAGES = [
  ["Hindi", "hindi"], ["Tamil", "tamil"], ["Telugu", "telugu"],
  ["Malayalam", "malayalam"], ["Kannada", "kannada"],
];

const COUNTRY_PAGE_META = {
  in: { name: "India", path: "/" },
  us: { name: "the US", path: "/us/" },
  uk: { name: "the UK", path: "/uk/" },
  au: { name: "Australia", path: "/au/" },
  de: { name: "Germany", path: "/de/" },
  ae: { name: "the UAE", path: "/ae/" },
  ca: { name: "Canada", path: "/ca/" },
  sg: { name: "Singapore", path: "/sg/" },
};

const COUNTRY_LOCALE = { in: "en-IN", us: "en-US", uk: "en-GB", au: "en-AU", de: "en-GB", ae: "en-AE", ca: "en-CA", sg: "en-SG" };
const localeFor = (code) => COUNTRY_LOCALE[code] || "en-IN";

module.exports = {
  COUNTRY_LOCALE,
  localeFor,
  COUNTRIES,
  COUNTRY_PAGE_META,
  LANGUAGE_PAGES,
  escHtml,
  filmPagePath,
  filmPageUrl,
  fmtDateShort,
  fmtRuntime,
  slugify,
  trim,
  xDefaultCode,
};
