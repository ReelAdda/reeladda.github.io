"use strict";

// ============================================================================
// reviews.js: published reviews for new titles, from the outlets' own RSS feeds (31 Oct 2026).
//
// Why: the critics' half of a page comes from English Wikipedia's reception section, and most
// Indian OTT titles never get one. Chaar Yaar was eight days old, reviewed by half a dozen outlets,
// and the page said "too early". The reviews existed; the pipeline couldn't see them.
//
// What: every build reads the review feeds below (headline, link and date only: never the
// description, nothing fetched from the articles), keeps the items whose headline is a review, and matches
// them to titles released in the last REVIEW_WINDOW_DAYS by title, date and language. A film's
// page then lists the outlets, linking out, with a star rating only when the feed itself states
// one (few do: 26 of 527 review items on 31 Oct 2026). The result lives in reviews.json, keyed by
// kind:tmdbId so every edition's page for a film shares it; entries older than the window are
// pruned. The score is not changed by this: stars are too rare to carry a verdict, and a review's
// presence is information, not a judgement.
//
// Honesty rules: an outlet is named only when its own feed named the title in a review headline;
// nothing is paraphrased; a star rating is shown only as the feed printed it; a title shared by
// two films in the window needs the outlet's language to agree before a match counts.
// ============================================================================
const fs = require("fs");

const REVIEWS_FILE = "reviews.json";
const REVIEW_WINDOW_DAYS = 60;    // reviews are matched to titles released this recently (or 14 days ahead)
const REVIEW_LEAD_DAYS = 14;      // a review may run before the release date
const FEED_TIMEOUT_MS = 15000;
const UA = "Mozilla/5.0 (compatible; FilmyChillBot/1.0; +https://filmychill.com/about/; filmychill.contact@gmail.com)";
// Not read, by the outlets' own feed terms (owner's call, 31 Oct 2026): Onmanorama ("personal use",
// "no commercial use without express consent", onmanorama.com/rss.html) and Rediff ("free for
// individuals and non-profit organisations", rediff.com/rss). An outlet that asks to be removed
// comes off the list above; its stored links are dropped at the next build (refreshReviews).
// Only the headline, link and date are used; the description field is never read for anything.

// The feeds. `langs`: the film languages an outlet's reviews are about; "any" for national press.
// Every address answered with items on 31 Oct 2026; one that stops answering is skipped that run
// and its last items kept (see refreshReviews).
const FEEDS = [
  { name: "The Hindu", url: "https://www.thehindu.com/entertainment/reviews/feeder/default.rss", langs: "any" },
  { name: "Indian Express", url: "https://indianexpress.com/section/entertainment/movie-review/feed/", langs: "any" },
  { name: "Indian Express", url: "https://indianexpress.com/section/entertainment/tamil/feed/", langs: ["Tamil"] },
  { name: "Indian Express", url: "https://indianexpress.com/section/entertainment/telugu/feed/", langs: ["Telugu"] },
  { name: "Indian Express", url: "https://indianexpress.com/section/entertainment/malayalam/feed/", langs: ["Malayalam"] },
  { name: "Hindustan Times", url: "https://www.hindustantimes.com/feeds/rss/entertainment/rssfeed.xml", langs: "any" },
  { name: "NDTV", url: "https://feeds.feedburner.com/ndtvmovies-latest", langs: "any" },
  { name: "Firstpost", url: "https://www.firstpost.com/commonfeeds/v1/mfp/rss/entertainment.xml", langs: "any" },
  { name: "News18", url: "https://www.news18.com/rss/movies.xml", langs: "any" },
  { name: "Scroll", url: "https://feeds.feedburner.com/ScrollinArticles.rss", langs: "any" },
  { name: "Koimoi", url: "https://www.koimoi.com/feed/", langs: "any" },
  { name: "Times of India", url: "https://timesofindia.indiatimes.com/rssfeeds/2886704.cms", langs: "any" },
  { name: "India Today", url: "https://www.indiatoday.in/rss/1206611", langs: "any" },
  { name: "DNA", url: "https://www.dnaindia.com/feeds/entertainment.xml", langs: "any" },
  { name: "Free Press Journal", url: "https://www.freepressjournal.in/stories.rss?section=entertainment", langs: "any" },
  { name: "123telugu", url: "https://www.123telugu.com/category/reviews/feed", langs: ["Telugu"] },
  { name: "Telugu360", url: "https://www.telugu360.com/feed/", langs: ["Telugu"] },
  { name: "Cinema Express", url: "https://www.cinemaexpress.com/feed", langs: ["Tamil", "Telugu", "Malayalam", "Kannada", "Hindi", "English"] },
  { name: "Vikatan", url: "https://www.vikatan.com/feed", langs: ["Tamil"] },
  { name: "Prajavani", url: "https://www.prajavani.net/feed", langs: ["Kannada"] },
  { name: "Amar Ujala", url: "https://www.amarujala.com/rss/entertainment.xml", langs: ["Hindi"] },
  { name: "Sangbad Pratidin", url: "https://www.sangbadpratidin.in/feed/", langs: ["Bengali"] },
];

// "review" in the languages the outlets write in. The title itself must still match in Latin
// script, which the regional feeds mostly keep ("Meethe Mein Kya Hai Movie Review: …").
const REVIEW_WORD = /\breview\b|रिव्यू|समीक्षा|समीक्षण|విమర్శ|రివ్యూ|సమీక్ష|விமர்சனம்|ரிவ்யூ|ವಿಮರ್ಶೆ|റിവ്യൂ|നിരൂപണം|রিভিউ|সমালোচনা/i;

const dec = (s) => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#8217;|&#x2019;|&apos;|&#0?39;/g, "'").replace(/&#8216;|&#x2018;/g, "'").replace(/&#8220;|&#8221;|&#x201c;|&#x201d;|&quot;/g, '"')
  .replace(/&#8211;|&#8212;|&#x2013;|&#x2014;/g, "-").replace(/&#038;|&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// Pure: a feed's items. RSS 2.0, RDF and Atom; a bad item is skipped, never the feed.
function parseFeed(xml, feed) {
  const out = [];
  for (const m of String(xml || "").matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)) {
    const it = m[0];
    const title = dec((/<title[^>]*>([\s\S]*?)<\/title>/.exec(it) || [])[1]);
    const link = dec(((/<link[^>]*>([\s\S]*?)<\/link>/.exec(it) || [])[1] || (/<link[^>]*href="([^"]+)"/.exec(it) || [])[1] || ""));
    const when = dec((/<(?:pubDate|published|updated|dc:date)>([\s\S]*?)<\//.exec(it) || [])[1]);
    const t = Date.parse(when);
    if (!title || !/^https?:\/\//.test(link) || !Number.isFinite(t)) continue;
    out.push({ outlet: feed.name, langs: feed.langs, title, link, date: new Date(t).toISOString().slice(0, 10) });
  }
  return out;
}

const isReview = (title) => REVIEW_WORD.test(title);

// Pure: a star rating the feed itself states, out of 5, or null. "Rating : 2.75/5", "3/5",
// "3.5 stars", "★★★☆☆". Ten-point scales are converted; anything odd is left out.
function parseStars(text) {
  const s = String(text || "");
  let m = /(?:rating|rated|stars?)\s*[:\-]?\s*(\d(?:\.\d{1,2})?)\s*(?:\/|out of|on)\s*(5|10)\b/i.exec(s) || /(?<![\d.])(\d(?:\.\d{1,2})?)\s*(?:\/|out of)\s*(5|10)\s*(?:stars?|rating)?(?![\d.])/i.exec(s);
  if (m) { const v = Number(m[1]), scale = Number(m[2]); const n = scale === 10 ? v / 2 : v; return n >= 0 && n <= 5 ? Math.round(n * 4) / 4 : null; }
  m = /(?<![\d.])(\d(?:\.\d)?)\s*stars?\b/i.exec(s);
  if (m) { const n = Number(m[1]); return n >= 0 && n <= 5 ? Math.round(n * 4) / 4 : null; }
  m = /([★⭐]{1,5})(☆*)/.exec(s);
  if (m && (m[1].length + m[2].length === 5 || !m[2])) return m[1].length;
  return null;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[‘’“”'"]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9ऀ-෿]+/gu, " ").trim();

// Pure: does this headline review this title? The title appears as whole words, and "review"
// follows within a few words ("Jailer 2 review: …", "Review: Aadarsha Kutumbam - …" also counts,
// with the title right after). Short titles (under 4 letters, or a single common word) need the
// headline to start with them, or the match is refused.
function headlineMatches(headline, title) {
  const h = norm(headline), t = norm(title);
  if (t.length < 3) return false;
  const re = new RegExp(`(^|\\s)${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(\\s|$)`);
  const m = re.exec(h);
  if (!m) return false;
  const at = m.index + m[1].length, end = at + t.length;
  const after = h.slice(end).trim().split(/\s+/).slice(0, 5).join(" ");
  const before = h.slice(0, at).trim().split(/\s+/).slice(-3).join(" ");
  const nearReview = REVIEW_WORD.test(after) || REVIEW_WORD.test(before);
  if (!nearReview) return false;
  // A one-word title ("Hope", "Carrie", "Officials") is a common word too: it counts only in the
  // review-headline convention, "<Title> [movie|series|…] review:" at the start, or "Review: <Title>".
  if (t.split(" ").length === 1) {
    // norm() drops punctuation, so the convention is read off the raw headline: the colon or dash is the tell.
    const raw = String(headline || "").toLowerCase();
    // "#Love", "M3GAN": a mark the normaliser drops must still be there in the headline.
    const lit = String(title || "").toLowerCase().trim();
    if (/^[#@]/.test(lit) && !raw.includes(lit)) return false;
    const Q = "[‘’“”'\"]?", T = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), W = REVIEW_WORD.source.replace(/\\b/g, ""), K = "(?:(?:movie|film|series|ott|web series|web|show)\\s+)?";
    const startForm = new RegExp(`^\\W*${T}${Q}\\W+${K}(?:${W})\\s*[:\\-–|]`, "iu").test(raw);
    // "Review: Hope" counts only when the title is the whole segment: "Review: Love Always" is another film.
    const afterReviewForm = new RegExp(`(?:^|\\W)${K}(?:${W})\\s*[:\\-–]?\\s*\\W*${T}${Q}\\s*(?:[:\\-–|!?.,]|$)`, "iu").test(raw);
    return startForm || afterReviewForm;
  }
  return true;
}

// Pure: reviews for each film. `films`: [{ key, title, language, released }]; the key is kind:tmdbId.
function matchReviews(items, films, today = new Date().toISOString().slice(0, 10)) {
  const t0 = Date.parse(`${today}T00:00:00Z`);
  const out = new Map();
  const windowOk = (rel) => { const d = (t0 - Date.parse(`${rel}T00:00:00Z`)) / 864e5; return Number.isFinite(d) && d <= REVIEW_WINDOW_DAYS && d >= -REVIEW_LEAD_DAYS; };
  const inWindow = films.filter((f) => f && f.key && f.title && /^\d{4}-\d{2}-\d{2}/.test(f.released || "") && windowOk(f.released.slice(0, 10)));
  // Titles shared by two films in the window: the outlet's language must name one of them.
  const byTitle = new Map();
  for (const f of inWindow) { const k = norm(f.title); byTitle.set(k, (byTitle.get(k) || []).concat(f)); }
  // TMDB often carries a long form ("Aadarsha Kutumbam House No: 47 - AK47") where outlets write
  // the short one ("Aadarsha Kutumbam"): the part before a colon, dash or bracket counts too, when
  // it is long enough to be the title and not a word.
  const names = (title) => {
    const t = String(title || "").trim();
    const head = t.split(/\s*[:(\-–—]\s+|\s+-\s+|\s*\(/)[0].trim();
    return head && head !== t && (head.split(/\s+/).length >= 2 || head.length >= 8) ? [t, head] : [t];
  };
  for (const it of items) {
    if (!isReview(it.title)) continue;
    for (const f of inWindow) {
      if (!names(f.title).some((n) => headlineMatches(it.title, n))) continue;
      const rel = f.released.slice(0, 10);
      const dd = (Date.parse(it.date) - Date.parse(rel)) / 864e5;
      if (!(dd >= -REVIEW_LEAD_DAYS && dd <= REVIEW_WINDOW_DAYS)) continue;
      const langOk = it.langs === "any" || (Array.isArray(it.langs) && it.langs.includes(f.language));
      const ambiguous = (byTitle.get(norm(f.title)) || []).length > 1;
      if (!langOk && (ambiguous || Array.isArray(it.langs))) continue;   // a regional outlet reviewing another language's film: not this one
      const list = out.get(f.key) || [];
      if (list.some((x) => x.u === it.link)) continue;
      const stars = parseStars(it.title);           // headline only, never the description
      list.push({ o: it.outlet, u: it.link, h: it.title.slice(0, 160), d: it.date, ...(stars != null ? { s: stars } : {}) });
      out.set(f.key, list);
    }
  }
  for (const [k, list] of out) out.set(k, list.sort((a, b) => a.d.localeCompare(b.d) || a.o.localeCompare(b.o)));
  return out;
}

async function fetchFeed(feed, fetchImpl = fetch) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetchImpl(feed.url, { headers: { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" }, signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    if (!/<rss|<feed|<rdf/i.test(xml.slice(0, 2000))) throw new Error("not a feed");
    return parseFeed(xml, feed);
  } finally { clearTimeout(timer); }
}

function loadReviews(file = REVIEWS_FILE) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { films: {}, feeds: {} }; }
}

// The build step: fetch every feed, match, merge into the file (a feed that fails keeps its last
// matches), prune films older than the window. Returns what the run summary prints.
async function refreshReviews({ films, file = REVIEWS_FILE, fetchImpl = fetch, now = Date.now(), feeds = FEEDS } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const cur = loadReviews(file);
  const items = []; const feedState = { ...(cur.feeds || {}) }; let ok = 0, failed = [];
  // All feeds at once: one slow outlet must not hold the build for its full timeout per feed.
  const results = await Promise.allSettled(feeds.map((feed) => fetchFeed(feed, fetchImpl)));
  results.forEach((r, i) => {
    const feed = feeds[i];
    if (r.status === "fulfilled") { items.push(...r.value); ok++; feedState[feed.url] = { ok: today, items: r.value.length }; }
    else { const msg = String((r.reason && r.reason.message) || r.reason); failed.push(`${feed.name}: ${msg}`); feedState[feed.url] = { ...(feedState[feed.url] || {}), failed: today, error: msg.slice(0, 80) }; }
  });
  const matched = matchReviews(items, films, today);
  const next = { ...(cur.films || {}) };
  const titleOf = new Map(films.map((f) => [f.key, f]));
  // A stored link is kept once its feed has rotated it off (feeds hold 20–50 items) or its feed
  // failed today; one the feed still carries is judged again, so a matcher fix also cleans the file.
  const live = new Set(items.map((i) => i.link)), outlets = new Set(feeds.map((f) => f.name));
  for (const key of new Set([...Object.keys(next), ...matched.keys()])) {
    const list = matched.get(key) || [];
    const prev = ((next[key] && next[key].items) || []).filter((x) => outlets.has(x.o) && (!live.has(x.u) || list.some((r) => r.u === x.u)));
    const merged = [...prev];
    for (const r of list) if (!merged.some((x) => x.u === r.u)) merged.push(r);
    const f = titleOf.get(key);
    if (!f) continue;                                   // a title no edition lists any more: pruned below or kept as is
    if (!merged.length) { delete next[key]; continue; }
    next[key] = { title: f.title, released: f.released.slice(0, 10), items: merged.sort((a, b) => a.d.localeCompare(b.d) || a.o.localeCompare(b.o)), updated: list.length ? today : next[key].updated };
  }
  // Prune: a film past the window keeps nothing here (its page keeps what it rendered last).
  for (const [key, v] of Object.entries(next)) {
    const d = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${v.released}T00:00:00Z`)) / 864e5;
    if (!(d <= REVIEW_WINDOW_DAYS + 30)) delete next[key];
  }
  const out = { _about: `Published reviews of recent titles, from the outlets' RSS feeds (lib/reviews.js): outlet, link, headline, date, and a star rating only when the feed states one. Keyed by kind:tmdbId; pruned ${REVIEW_WINDOW_DAYS + 30} days after release.`, fetched: today, feeds: feedState, films: next };
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  cache = null;
  const films_ = Object.keys(next).length, links = Object.values(next).reduce((n, v) => n + v.items.length, 0);
  return { feedsOk: ok, feedsFailed: failed, reviewItems: items.filter((i) => isReview(i.title)).length, filmsMatched: matched.size, filmsStored: films_, links };
}

// For page builders: the reviews of one film, newest last, or []. Cached for the run.
let cache = null;
function reviewsFor(kind, tmdbId, file = REVIEWS_FILE) {
  if (!tmdbId) return [];
  if (!cache) cache = loadReviews(file);
  const v = cache.films && cache.films[`${kind === "tv" ? "tv" : "movie"}:${tmdbId}`];
  return v && Array.isArray(v.items) ? v.items : [];
}
function useReviews(obj) { cache = obj || null; }   // tests

// Pure: the average star rating when at least `min` reviews state one, else null.
function starAverage(items, min = 3) {
  const s = (items || []).map((x) => x.s).filter((x) => typeof x === "number");
  if (s.length < min) return null;
  return { avg: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10, n: s.length };
}

// Where the links belong (owner, 31 Oct 2026): only where the score card has no critics' reading
// of its own — no FilmyChill score yet, or a score from audience ratings alone with nothing cited
// from Wikipedia. A page with a verdict and the critics' figures already answers the question.
function wantsReviews(item, citedCritics = false) {
  const s = item && item.fcScore;
  return !s || (!s.critics && !citedCritics);
}
// One entry per outlet, oldest first: [{ o, u }], what the data files carry as item.rv.
function outlets(items) {
  const seen = new Set(), out = [];
  for (const r of items || []) { if (r && r.o && r.u && !seen.has(r.o)) { seen.add(r.o); out.push({ o: r.o, u: r.u }); } }
  return out;
}
// The card's line, names only (a card is one link, so the outlets' links wait for the detail
// sheet or the film page): "Read the reviews: Indian Express, The Hindu →"; three outlets or
// more: "Indian Express, The Hindu and 2 more". Twin: reviewsCardText in js/app.js.
function reviewsCardText(rv) {
  const names = outlets(rv).map((x) => x.o);
  if (!names.length) return "";
  const shown = names.slice(0, 2).join(", ");
  const more = names.length - 2;
  return `Read the reviews: ${shown}${more > 0 ? ` and ${more} more` : ""} →`;
}

module.exports = { FEEDS, REVIEWS_FILE, REVIEW_WINDOW_DAYS, fetchFeed, headlineMatches, isReview, loadReviews, matchReviews, outlets, parseFeed, parseStars, refreshReviews, reviewsCardText, reviewsFor, starAverage, useReviews, wantsReviews };
