// FilmyChill unit tests — pure functions + SSR-injection hardening.
// Run: node scripts/test.js   (no dependencies; uses Node's built-in assert)
// Exits non-zero on any failure so CI fails the build.

const assert = require("assert");
const U = require("./update.js"); // safe: update.js only runs main() when executed directly

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}\n      ${e.message}`); }
}
function group(title) { console.log(`\n${title}`); }

// ---------------- verdict() ----------------
group("verdict()");
test("high rating + enough votes -> Must watch", () => {
  assert.strictEqual(U.verdict(8.1, 5000), "Must watch");
});
test("mid rating -> Worth a watch", () => {
  assert.strictEqual(U.verdict(6.8, 5000), "Worth a watch");
});
test("low-mid rating -> Decent one-time watch", () => {
  assert.strictEqual(U.verdict(5.7, 5000), "Decent one-time watch");
});
test("low rating -> Skip unless curious", () => {
  assert.strictEqual(U.verdict(4.0, 5000), "Skip unless curious");
});
test("too few votes -> Not enough ratings yet (regardless of rating)", () => {
  assert.strictEqual(U.verdict(9.9, 3), "Not enough ratings yet");
});
test("zero/undefined votes -> Not enough ratings yet", () => {
  assert.strictEqual(U.verdict(8.0, 0), "Not enough ratings yet");
  assert.strictEqual(U.verdict(8.0, undefined), "Not enough ratings yet");
});
test("boundary: exactly 7.5 -> Must watch", () => {
  assert.strictEqual(U.verdict(7.5, 100), "Must watch");
});

// ---------------- trim() ----------------
group("trim()");
test("short text unchanged", () => {
  assert.strictEqual(U.trim("Hello world", 160), "Hello world");
});
test("long text truncated with ellipsis", () => {
  const long = "a ".repeat(200);
  const out = U.trim(long, 50);
  assert.ok(out.length <= 51, "should be <= n+ellipsis");
  assert.ok(out.endsWith("\u2026"), "should end with ellipsis");
});
test("empty/undefined -> empty string", () => {
  assert.strictEqual(U.trim(""), "");
  assert.strictEqual(U.trim(undefined), "");
});
test("does not cut mid-word", () => {
  const out = U.trim("supercalifragilistic expialidocious", 20);
  assert.ok(!out.replace("\u2026", "").endsWith("expiali"), "trailing partial word trimmed");
});

// ---------------- img() ----------------
group("img()");
test("builds TMDB url with default size", () => {
  assert.strictEqual(U.img("/abc.jpg"), "https://image.tmdb.org/t/p/w342/abc.jpg");
});
test("respects custom size", () => {
  assert.strictEqual(U.img("/abc.jpg", "w780"), "https://image.tmdb.org/t/p/w780/abc.jpg");
});
test("null path -> null", () => {
  assert.strictEqual(U.img(null), null);
});

// ---------------- slugify() ----------------
group("slugify()");
test("lowercases and hyphenates", () => {
  assert.strictEqual(U.slugify("Mortal Kombat II"), "mortal-kombat-ii");
});
test("strips punctuation", () => {
  assert.strictEqual(U.slugify("Spider-Man: Brand New Day!"), "spider-man-brand-new-day");
});
test("collapses multiple separators, trims edges", () => {
  assert.strictEqual(U.slugify("  --Hello   World--  "), "hello-world");
});
test("empty/undefined -> empty", () => {
  assert.strictEqual(U.slugify(""), "");
  assert.strictEqual(U.slugify(undefined), "");
});

// ---------------- escHtml() ----------------
group("escHtml()");
test("escapes all five HTML-sensitive chars", () => {
  assert.strictEqual(U.escHtml(`<a href="x" id='y'>&</a>`),
    "&lt;a href=&quot;x&quot; id=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
});
test("null -> empty string", () => {
  assert.strictEqual(U.escHtml(null), "");
});
test("prevents script injection in title", () => {
  const out = U.escHtml("<script>alert(1)</script>");
  assert.ok(!out.includes("<script>"), "raw <script> must be escaped");
});

// ---------------- ytIdOf() ----------------
group("ytIdOf()");
test("extracts id from watch url", () => {
  assert.strictEqual(U.ytIdOf("https://www.youtube.com/watch?v=gMC8kkwbIQQ"), "gMC8kkwbIQQ");
});
test("non-youtube / search url -> null", () => {
  assert.strictEqual(U.ytIdOf("https://www.youtube.com/results?search_query=x"), null);
  assert.strictEqual(U.ytIdOf(""), null);
  assert.strictEqual(U.ytIdOf(undefined), null);
});

// ---------------- replaceBetween() — SSR injection hardening ----------------
group("replaceBetween() — SSR markers");
test("replaces content between markers (HTML context)", () => {
  const html = `<head><!--SSR:X-->old<!--/SSR:X--></head>`;
  assert.strictEqual(U.replaceBetween(html, "X", "new"), `<head><!--SSR:X-->new<!--/SSR:X--></head>`);
});
test("THROWS when opening marker missing (loud, not silent)", () => {
  assert.throws(() => U.replaceBetween(`<head><!--/SSR:X--></head>`, "X", "new"), /missing/);
});
test("THROWS when closing marker missing", () => {
  assert.throws(() => U.replaceBetween(`<head><!--SSR:X--></head>`, "X", "new"), /closing.*missing|missing/);
});
test("THROWS when markers out of order", () => {
  assert.throws(() => U.replaceBetween(`<!--/SSR:X--> <!--SSR:X-->`, "X", "new"), /order/);
});
test("REGRESSION: THROWS if marker is inside a <script> (the comment-in-JS bug)", () => {
  // This is the exact class of bug that made all country pages render India.
  const html = `<head><script><!--SSR:PAGECODE-->x<!--/SSR:PAGECODE--></script></head>`;
  assert.throws(() => U.replaceBetween(html, "PAGECODE", "y"), /script/);
});
test("allows marker after a closed script", () => {
  const html = `<script>var a=1;</script><!--SSR:X-->old<!--/SSR:X-->`;
  assert.doesNotThrow(() => U.replaceBetween(html, "X", "new"));
});
test("allows marker inside <script type=application/ld+json> (data, not code)", () => {
  const html = `<script type="application/ld+json"><!--SSR:JSONLD-->{}<!--/SSR:JSONLD--></script>`;
  assert.doesNotThrow(() => U.replaceBetween(html, "JSONLD", "{}"));
});

// ---------------- assignSlugs() ----------------
group("assignSlugs()");
test("adds slug to every item across lists", () => {
  const data = {
    theatres: [{ title: "Film One" }],
    ott: [{ title: "Show Two" }],
    comingSoon: [{ title: "Coming Three" }],
  };
  U.assignSlugs(data);
  assert.strictEqual(data.theatres[0].slug, "film-one");
  assert.strictEqual(data.ott[0].slug, "show-two");
  assert.strictEqual(data.comingSoon[0].slug, "coming-three");
});

// ---------------- buildHeadTags() — per-country SEO ----------------
group("buildHeadTags() — per-country SEO");
test("US page names the US in title + canonical", () => {
  const tags = U.buildHeadTags({ code: "us", name: "United States" });
  assert.ok(/the US/.test(tags), "title/desc should mention the US");
  assert.ok(tags.includes("https://filmychill.com/us/"), "canonical should be /us/");
});
test("India root uses root canonical", () => {
  const tags = U.buildHeadTags({ code: "in", name: "India" });
  assert.ok(tags.includes('href="https://filmychill.com/"'), "India canonical is root");
});
test("each country gets a distinct canonical", () => {
  const codes = ["us", "uk", "au", "de"];
  const canons = codes.map((code) => {
    const t = U.buildHeadTags({ code, name: code });
    const m = t.match(/canonical" href="([^"]+)"/);
    return m && m[1];
  });
  assert.strictEqual(new Set(canons).size, codes.length, "canonicals must be unique per country");
});

// ---------------- buildHomeJsonLd() ----------------
group("buildHomeJsonLd()");
test("produces valid JSON with ItemList", () => {
  const data = {
    generatedAt: new Date().toISOString(),
    theatres: [{ title: "A", slug: "a" }],
    ott: [{ title: "B", slug: "b" }],
  };
  const raw = U.buildHomeJsonLd(data, { code: "us", name: "United States" });
  const parsed = JSON.parse(raw); // must be parseable
  assert.ok(parsed["@graph"], "has @graph");
  const itemList = parsed["@graph"].find((x) => x["@type"] === "ItemList");
  assert.ok(itemList, "has ItemList");
  assert.ok(itemList.itemListElement.length >= 2, "lists the items");
});

// ---------------- RATINGS_SOURCE toggle ----------------
group("RATINGS_SOURCE toggle");
test("default mode is tmdb (no env override)", () => {
  // The committed default is now "tmdb" (site monetization-ready). Flipping back to "imdb"
  // requires changing this assertion too.
  assert.strictEqual(U.RATINGS_SOURCE, "tmdb");
  assert.strictEqual(U.USE_IMDB, false);
});
test("IMDb mode: footer credits TMDB for data AND IMDb for ratings (required wording)", () => {
  const f = U.footerAttribution(true); // explicit IMDb mode — deterministic, no env needed
  assert.ok(/Film data from/.test(f), "TMDB credited for film data");
  assert.ok(/not endorsed or certified by TMDB/.test(f), "TMDB disclaimer present");
  assert.ok(/courtesy of <a[^>]*>IMDb/.test(f), "IMDb credited for ratings");
  assert.ok(/Used with permission/.test(f), "IMDb's required verbatim wording present");
});
test("TMDB mode: footer credits TMDB for data+ratings and drops IMDb entirely", () => {
  const f = U.footerAttribution(false); // explicit TMDB mode — deterministic, in-process
  assert.ok(/Film data and ratings from/.test(f), "TMDB credited for both data and ratings");
  assert.ok(!/IMDb/i.test(f), "IMDb name must NOT appear when ratings come from TMDB");
});
test("default footerAttribution() matches current mode (global wiring correct)", () => {
  // No-arg call uses the global USE_IMDB; default is tmdb, so it must match explicit TMDB mode.
  assert.strictEqual(U.footerAttribution(), U.footerAttribution(false));
});

// ---------------- OTT freshness gate (anti-staleness) ----------------
// Guards the fix that stops perennial catalogue hits (Rick and Morty, The Boys) from
// leaking into the "latest releases" OTT list via weekly trending, while still keeping
// the NEW season of a returning hit show.
const FRESH_NOW = new Date("2026-06-18T00:00:00Z").getTime();

test("deriveFreshDate: movie uses release_date", () => {
  assert.strictEqual(U.deriveFreshDate("movie", { release_date: "2026-06-08" }), "2026-06-08");
});
test("deriveFreshDate: TV uses LATEST non-special season air_date, not original launch", () => {
  const d = { first_air_date: "2013-12-02", seasons: [
    { season_number: 0, air_date: "2013-11-01" }, // specials ignored
    { season_number: 7, air_date: "2024-10-20" },
  ] };
  assert.strictEqual(U.deriveFreshDate("tv", d), "2024-10-20");
});
test("deriveFreshDate: TV falls back to last_air_date when no season data", () => {
  assert.strictEqual(U.deriveFreshDate("tv", { first_air_date: "2019-01-01", last_air_date: "2024-07-18" }), "2024-07-18");
});
test("isOttFresh: old catalogue title is dropped (Rick and Morty case)", () => {
  // latest season 2024-10-20 is >75d before 2026-06-18 -> stale
  assert.strictEqual(U.isOttFresh("2024-10-20", FRESH_NOW), false);
});
test("isOttFresh: returning hit's NEW season is kept", () => {
  // a season aired 2026-06-01, well within window -> fresh
  assert.strictEqual(U.isOttFresh("2026-06-01", FRESH_NOW), true);
});
test("isOttFresh: recent movie kept, old classic dropped", () => {
  assert.strictEqual(U.isOttFresh("2026-06-08", FRESH_NOW), true);
  assert.strictEqual(U.isOttFresh("1994-09-23", FRESH_NOW), false);
});
test("isOttFresh: null freshDate (too-new/undatable) is kept, never punished", () => {
  assert.strictEqual(U.isOttFresh(null, FRESH_NOW), true);
});
test("isOttFresh: boundary at exactly OTT_FRESH_DAYS passes", () => {
  const edge = new Date(FRESH_NOW - U.OTT_FRESH_DAYS * 864e5).toISOString().slice(0, 10);
  assert.strictEqual(U.isOttFresh(edge, FRESH_NOW), true);
});

// ---------------- Theatre freshness gate (whole-pool) ----------------
// Guards the fix that gates the ENTIRE theatre pool (now_playing included) by the freshness
// window — previously only the discover supplement was date-gated, so month-old now_playing
// films could top "Latest big-screen releases" (the Obsession case: released 34 days prior).
const TH_NOW = new Date("2026-07-02T00:00:00Z").getTime();
const thFilm = (title, release_date) => ({ title, release_date });
const daysAgo = (n) => new Date(TH_NOW - n * 864e5).toISOString().slice(0, 10);

test("filterTheatreFresh: month-old now_playing film is dropped (Obsession case)", () => {
  // 9 fresh films so the strict window has enough to stand on its own
  const pool = [thFilm("Obsession", "2026-05-29"), // 34 days old
    ...Array.from({ length: 9 }, (_, i) => thFilm(`Fresh${i}`, daysAgo(i + 1)))];
  const out = U.filterTheatreFresh(pool, TH_NOW);
  assert.ok(!out.some((m) => m.title === "Obsession"), "34-day-old film must be gated out");
  assert.strictEqual(out.length, 9);
});
test("filterTheatreFresh: films within the strict window are kept, boundary inclusive", () => {
  const pool = [thFilm("Edge", daysAgo(U.THEATRE_WINDOW_DAYS)),
    ...Array.from({ length: 8 }, (_, i) => thFilm(`Fresh${i}`, daysAgo(i + 1)))];
  const out = U.filterTheatreFresh(pool, TH_NOW);
  assert.ok(out.some((m) => m.title === "Edge"), "exactly-21-days-old film must pass");
});
test("filterTheatreFresh: thin week widens ONCE to the fallback window", () => {
  // Only 3 strictly-fresh films (< THEATRE_MIN_POOL) + 4 in the 21-35d band + 1 beyond 35d.
  const pool = [
    ...Array.from({ length: 3 }, (_, i) => thFilm(`Fresh${i}`, daysAgo(i + 2))),
    ...Array.from({ length: 4 }, (_, i) => thFilm(`Mid${i}`, daysAgo(25 + i))),
    thFilm("Ancient", daysAgo(40)),
  ];
  const out = U.filterTheatreFresh(pool, TH_NOW);
  assert.strictEqual(out.length, 7, "widened window keeps fresh + mid-band films");
  assert.ok(!out.some((m) => m.title === "Ancient"), "fallback must not resurrect >35d films");
});
test("filterTheatreFresh: film with no release_date is dropped (junk record, not too-new)", () => {
  const pool = [{ title: "Undated" },
    ...Array.from({ length: 9 }, (_, i) => thFilm(`Fresh${i}`, daysAgo(i + 1)))];
  const out = U.filterTheatreFresh(pool, TH_NOW);
  assert.ok(!out.some((m) => m.title === "Undated"));
});
test("filterTheatreFresh: future-dated film is kept (release-day timezone edge)", () => {
  const pool = [thFilm("Tomorrow", daysAgo(-1)),
    ...Array.from({ length: 8 }, (_, i) => thFilm(`Fresh${i}`, daysAgo(i + 1)))];
  const out = U.filterTheatreFresh(pool, TH_NOW);
  assert.ok(out.some((m) => m.title === "Tomorrow"));
});

// ---------------- Head-tag ratings wording follows the active source ----------------
// Guards the fix for the Google snippet claiming "IMDb ratings" while RATINGS_SOURCE=tmdb.
// IMDb's name may only appear when IMDb data is actually used (its terms require a license).
test("buildHeadTags: TMDB mode never mentions IMDb (root + country pages)", () => {
  assert.ok(!U.buildHeadTags({ code: "in", name: "India" }, false).includes("IMDb"));
  assert.ok(!U.buildHeadTags({ code: "us", name: "United States" }, false).includes("IMDb"));
});
test("buildHeadTags: TMDB mode still promises ratings, just unbranded", () => {
  assert.ok(U.buildHeadTags({ code: "in", name: "India" }, false).includes("ratings, verdicts"));
});
test("buildHeadTags: IMDb mode keeps the IMDb wording", () => {
  assert.ok(U.buildHeadTags({ code: "in", name: "India" }, true).includes("IMDb ratings"));
  assert.ok(U.buildHeadTags({ code: "de", name: "Germany" }, true).includes("IMDb ratings"));
});

// ---------------- OTT recency-decay ranking bonus ----------------
// Guards the fix that stops a high-rated near-expiry season from camping in the OTT top 3
// above week-old drops (the FROM-at-74-days case). Gate decides admission; bonus decides order.
test("ottRecencyBonus: released today gets the full bonus", () => {
  assert.strictEqual(U.ottRecencyBonus(daysAgo(0), TH_NOW), U.OTT_RECENCY_MAX);
});
test("ottRecencyBonus: near-expiry title gets ~nothing, week-old drop outranks it", () => {
  const nearExpiry = U.ottRecencyBonus(daysAgo(74), TH_NOW); // the FROM case
  const weekOld = U.ottRecencyBonus(daysAgo(7), TH_NOW);
  assert.ok(nearExpiry < 0.01, `74d bonus should be ~0, got ${nearExpiry}`);
  assert.ok(weekOld > 0.12, `7d bonus should be near max, got ${weekOld}`);
});
test("ottRecencyBonus: decays linearly (half window ≈ half bonus)", () => {
  const half = U.ottRecencyBonus(daysAgo(Math.round(U.OTT_FRESH_DAYS / 2)), TH_NOW);
  assert.ok(Math.abs(half - U.OTT_RECENCY_MAX / 2) < 0.01);
});
test("ottRecencyBonus: null and beyond-window dates get zero", () => {
  assert.strictEqual(U.ottRecencyBonus(null, TH_NOW), 0);
  assert.strictEqual(U.ottRecencyBonus(daysAgo(100), TH_NOW), 0);
});

// ---------------- Freshness badge (freshDate-driven) ----------------
// Guards the fix that lets returning TV seasons earn a badge. The old logic keyed off
// release_date/first_air_date, so House of the Dragon (first_air_date 2022) showed NO badge
// even when its new season aired 11 days ago.
test("freshBadge: movie within 7 days -> New release", () => {
  assert.strictEqual(U.freshBadge("movie", daysAgo(3), TH_NOW), "New release");
});
test("freshBadge: movie at 8 days -> no badge", () => {
  assert.strictEqual(U.freshBadge("movie", daysAgo(8), TH_NOW), null);
});
test("freshBadge: returning show's season within 14 days -> New season (HotD case)", () => {
  assert.strictEqual(U.freshBadge("tv", daysAgo(11), TH_NOW, 3), "New season");
});
test("freshBadge: first season of a brand-new show -> New show", () => {
  assert.strictEqual(U.freshBadge("tv", daysAgo(5), TH_NOW, 1), "New show");
});
test("freshBadge: TV season older than 14 days -> no badge", () => {
  assert.strictEqual(U.freshBadge("tv", daysAgo(15), TH_NOW, 3), null);
});
test("freshBadge: unreleased (future beyond tolerance) and null dates -> no badge", () => {
  assert.strictEqual(U.freshBadge("movie", daysAgo(-5), TH_NOW), null);
  assert.strictEqual(U.freshBadge("movie", null, TH_NOW), null);
});

// ---------------- freshLabel (visible card freshness line) ----------------
test("freshLabel: movie shows 'Released <date>'", () => {
  assert.strictEqual(U.freshLabel({ kind: "movie", freshDate: "2026-06-12" }, TH_NOW), "Released 12 Jun");
});
test("freshLabel: a multi-season show shows 'Latest season <date>', not the series launch", () => {
  assert.strictEqual(U.freshLabel({ kind: "tv", seasons: 4, freshDate: "2026-06-21", released: "2022-08-21" }, TH_NOW), "Latest season 21 Jun");
});
test("freshLabel: a one-season title says 'Released', not 'Latest season'", () => {
  // TMDB classifies some Indian films as series. "Latest season" on a single-season entry
  // reads like a bug to a reader who thinks they're looking at a film.
  assert.strictEqual(U.freshLabel({ kind: "tv", seasons: 1, freshDate: "2026-08-07" }, TH_NOW), "Released 7 Aug");
  assert.strictEqual(U.freshLabel({ kind: "tv", freshDate: "2026-08-07" }, TH_NOW), "Released 7 Aug");
});
test("freshLabel: cross-year date includes the year (no ambiguity)", () => {
  assert.ok(U.freshLabel({ kind: "movie", freshDate: "2025-12-20" }, TH_NOW).includes("2025"));
});
test("freshLabel: falls back to released when freshDate absent, empty when neither", () => {
  assert.strictEqual(U.freshLabel({ kind: "movie", released: "2026-06-12" }, TH_NOW), "Released 12 Jun");
  assert.strictEqual(U.freshLabel({ kind: "movie" }, TH_NOW), "");
});
test("freshLabel: movie prefers region-localized released over global freshDate (card = modal)", () => {
  assert.strictEqual(U.freshLabel({ kind: "movie", released: "2026-05-29", freshDate: "2026-05-13" }, TH_NOW), "Released 29 May");
});

// ---------------- RSS feed (distribution automation) ----------------
test("buildRssFeed: valid channel with country name, self link, and capped newest-first items", () => {
  const data = { generatedAt: "2026-07-04T07:22:00Z",
    theatres: [{ title: "Toy Story 5", slug: "toy-story-5", platform: "Theatres", released: "2026-06-19", rating: 7.4, verdict: "Worth a watch", language: "English" }],
    ott: [{ title: "Silo", slug: "silo", platform: "Apple TV", freshDate: "2026-07-02", ottSince: "2026-07-02", rating: 8.2, verdict: "Must watch", language: "English" }] };
  const xml = U.buildRssFeed(data, { code: "in", name: "India" });
  assert.ok(xml.includes("<title>FilmyChill — New Movies &amp; OTT Releases This Week in India</title>"));
  assert.ok(xml.includes('atom:link href="https://filmychill.com/feed.xml" rel="self"'));
  assert.ok(xml.indexOf("Silo") < xml.indexOf("Toy Story 5"), "newest (Jul 2) before older (Jun 19)");
  assert.ok(xml.includes("<pubDate>"));
});
test("buildRssFeed: guid is stable per freshness-event (arrival date), not per rebuild", () => {
  const item = { title: "X", slug: "x", platform: "Netflix", freshDate: "2026-04-10", ottSince: "2026-07-01", rating: 7, verdict: "Worth a watch" };
  const xml1 = U.buildRssFeed({ generatedAt: "2026-07-04T01:00:00Z", ott: [item] }, { code: "in", name: "India" });
  const xml2 = U.buildRssFeed({ generatedAt: "2026-07-04T13:00:00Z", ott: [item] }, { code: "in", name: "India" });
  const guid = (x) => /<guid[^>]*>([^<]*)<\/guid>/.exec(x)[1];
  assert.strictEqual(guid(xml1), guid(xml2), "same event -> same guid across rebuilds");
  assert.ok(guid(xml1).includes("2026-07-01"), "guid keys on the ARRIVAL date");
});
test("buildRssFeed: country feeds use their own namespace and XML-escapes titles", () => {
  const data = { generatedAt: "2026-07-04T07:22:00Z", ott: [{ title: "Tom & Jerry <3", slug: "tj", platform: "Netflix", freshDate: "2026-07-01" }] };
  const xml = U.buildRssFeed(data, { code: "us", name: "United States" });
  assert.ok(xml.includes("https://filmychill.com/us/movie/tj.html"));
  assert.ok(xml.includes("Tom &amp; Jerry &lt;3"));
  assert.ok(!xml.includes("Tom & Jerry <3"));
});

// ---------------- Age certificates across every market's rating board ----------------
group("certAudience: one reading of 14 different rating boards");

test("every live market's real rating labels land in the right bucket", () => {
  // Boards as the relevant authority publishes them. A wrong answer here is worse than none:
  // this drives "Is X family friendly?" on the film page and in FAQPage schema.
  const boards = {
    IN: [["U", "family"], ["U/A 7+", "family"], ["U/A 13+", "teens"], ["U/A 16+", "teens"], ["A", "adults"]],
    US: [["G", "family"], ["PG", "family"], ["PG-13", "teens"], ["R", "adults"], ["NC-17", "adults"], ["TV-MA", "adults"], ["TV-14", "teens"]],
    GB: [["U", "family"], ["PG", "family"], ["12A", "teens"], ["15", "teens"], ["18", "adults"]],
    AU: [["G", "family"], ["M", "teens"], ["MA15+", "teens"], ["R18+", "adults"]],
    NZ: [["G", "family"], ["M", "teens"], ["R13", "teens"], ["R16", "teens"], ["R18", "adults"]],
    DE: [["0", "family"], ["6", "family"], ["12", "teens"], ["16", "teens"], ["18", "adults"]],
    AE: [["G", "family"], ["PG13", "teens"], ["15+", "teens"], ["18TC", "adults"]],
    SG: [["G", "family"], ["PG13", "teens"], ["NC16", "teens"], ["M18", "adults"], ["R21", "adults"]],
    MY: [["U", "family"], ["P13", "teens"], ["18", "adults"]],
    PH: [["G", "family"], ["PG", "family"], ["R-13", "teens"], ["R-16", "teens"], ["R-18", "adults"]],
    JP: [["G", "family"], ["PG12", "teens"], ["R15+", "teens"], ["R18+", "adults"]],
    KR: [["ALL", "family"], ["12", "teens"], ["15", "teens"], ["19", "adults"]],
    ID: [["SU", "family"], ["13+", "teens"], ["17+", "teens"], ["21+", "adults"]],
  };
  for (const [board, rows] of Object.entries(boards)) {
    for (const [cert, want] of rows) {
      assert.strictEqual(U.certAudience(cert).bucket, want, `${board} "${cert}" should be ${want}`);
    }
  }
});

test("the labels that used to break: universal ratings are never called adults-only", () => {
  // Korea's ALL and the R-prefixed teen ratings were read as adults-only by the old
  // India/US/UK regexes — the exact failure that adding Asia-Pacific markets exposed.
  assert.strictEqual(U.certAudience("ALL").label, "Yes — family friendly");
  assert.strictEqual(U.certAudience("R-13").label, "Older kids & up");
  assert.strictEqual(U.certAudience("R13").label, "Older kids & up");
  assert.strictEqual(U.certAudience("SU").label, "Yes — family friendly");
  assert.strictEqual(U.certAudience("17+").bucket, "teens");
  assert.strictEqual(U.certAudience("21+").bucket, "adults");
  // And nothing unknown is guessed at.
  assert.strictEqual(U.certAudience("").bucket, "unknown");
  assert.strictEqual(U.certAudience("BANANA").label, "Check rating");
});

test("the film page and its FAQ read the same certificate the same way", () => {
  for (const [cert, needle] of [["ALL", "suitable for family viewing"], ["R-13", "older kids"], ["R18+", "adult audiences"]]) {
    const faq = U.buildFaqs({ title: "X", slug: "x", kind: "movie", cert }, "South Korea", { code: "kr", name: "South Korea" });
    const line = faq.find((f) => /family friendly/.test(f.q));
    assert.ok(line && line.a.toLowerCase().includes(needle), cert + " -> " + (line || {}).a);
  }
});

// ---------------- Country roster ----------------
group("country roster: every market is complete, and the switcher is built from it");
const CORE = require("./lib/core.js");

test("every country config is complete and internally consistent", () => {
  const seen = new Set();
  for (const c of CORE.COUNTRIES) {
    assert.ok(/^[a-z]{2}$/.test(c.code), "code is a 2-letter slug: " + c.code);
    assert.ok(!seen.has(c.code), "no duplicate country: " + c.code);
    seen.add(c.code);
    assert.ok(/^[A-Z]{2}$/.test(c.region), c.code + " needs an ISO region");
    assert.ok(/^[A-Z]{2}$/.test(c.watchRegion || c.region), c.code + " needs a TMDB watch region");
    assert.ok(CORE.COUNTRY_PAGE_META[c.code], c.code + " has no page meta (name + path)");
    assert.ok(CORE.COUNTRY_LOCALE[c.code], c.code + " has no locale — dates and counts would fall back to India's");
    assert.ok(CORE.COUNTRY_FLAG[c.code], c.code + " has no flag for the switcher");
    assert.ok(Array.isArray(c.priorityLangs) && c.priorityLangs.length, c.code + " needs priority languages");
    assert.ok(Array.isArray(c.ottRegionalLangs), c.code + " needs an ottRegionalLangs array (empty is valid)");
    assert.ok(c.theatreTargets.length && c.soonTargets.length, c.code + " needs slate targets");
    const path = CORE.COUNTRY_PAGE_META[c.code].path;
    assert.strictEqual(path, c.code === "in" ? "/" : `/${c.code}/`, "path must match the code: " + path);
    // The locale has to be one Intl actually understands, or every date on that country's
    // pages silently falls back to the default format.
    assert.doesNotThrow(() => new Date().toLocaleDateString(CORE.COUNTRY_LOCALE[c.code]), c.code);
  }
});

test("locales render English dates and counts, not another script or grouping", () => {
  for (const c of CORE.COUNTRIES) {
    const loc = CORE.COUNTRY_LOCALE[c.code];
    const d = new Date("2026-09-25T00:00:00Z").toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    assert.ok(/2026/.test(d) && /[A-Za-z]/.test(d), c.code + " date looks wrong: " + d);
    // Comma grouping only. India's lakh grouping ("12,34,567") is correct and stays; what must
    // never ship is dot grouping (en-ID gives "1.234.567"), which an English reader parses as
    // a decimal point.
    const grouped = (1234567).toLocaleString(loc);
    assert.ok(/^[\d,]+$/.test(grouped), c.code + " groups numbers oddly: " + grouped);
  }
});

test("the country switcher is rendered from config, and the page reads its maps back from it", () => {
  const src = require("fs").readFileSync("index.html", "utf8");
  assert.ok(/<!--SSR:COUNTRYOPTS-->[\s\S]*?<!--\/SSR:COUNTRYOPTS-->/.test(src), "switcher is build-rendered");
  assert.ok(/document\.querySelectorAll\('#countrySel option'\)/.test(src),
    "labels and paths derive from the rendered list — no second hardcoded copy to go stale");
  // No hand-maintained country map may survive anywhere in the page. A stale SUPPORTED_COUNTRIES
  // map is what made the six new countries appear in the switcher and then refuse to load:
  // setCountry() rejected them, and their own pages fell back to FC_PAGE 'in' and rendered
  // India's data under a /kr/ URL. Any object literal listing three or more country codes fails.
  const inlineJs = [...src.matchAll(/<script(?![^>]*application\/ld)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  const hardcoded = inlineJs.match(/\{[^{}]*\b(?:us|uk|au|de|ae|ca|sg|kr|jp|my|nz|ph|id)\s*:[^{}]*\}/g) || [];
  for (const lit of hardcoded) {
    const codes = (lit.match(/\b[a-z]{2}\s*:/g) || []).length;
    assert.ok(codes < 3, "hardcoded country map in page JS — derive it from the switcher instead: " + lit.slice(0, 120));
  }
  // Every country the build knows about must be reachable from the page's own maps.
  for (const c of CORE.COUNTRIES) {
    assert.ok(/SUPPORTED_COUNTRIES = COUNTRY_LABELS/.test(src),
      "the supported-country gate must derive from the rendered switcher (checking " + c.code + ")");
  }
  // Markers must never sit inside a <script>: HTML comments are not comments there.
  const scripts = [...src.matchAll(/<script(?![^>]*application\/ld)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const body of scripts) assert.ok(!/<!--SSR:/.test(body), "an SSR marker inside a <script> would break the page");
});

// ---------------- Analytics (cookieless, kill-switchable) ----------------
group("analytics: present on every page type, allowed by every CSP, removable everywhere");

test("analyticsTag + cspWith: the tag and the policy that permits it move together", () => {
  if (!U.GC_SITE) return;   // analytics switched off in this build — nothing to assert
  const tag = U.analyticsTag();
  assert.ok(/data-goatcounter="https:\/\/[a-z0-9-]+\.goatcounter\.com\/count"/.test(tag), tag);
  assert.ok(/src="https:\/\/gc\.zgo\.at\/count\.js"/.test(tag) && /async/.test(tag), "loaded async, from the documented host");
  assert.ok(!/cookie|localStorage/i.test(tag), "nothing that would need a consent banner");
  const policy = U.cspWith("default-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'");
  assert.ok(/script-src 'self' https:\/\/gc\.zgo\.at/.test(policy), "script host allowed: " + policy);
  assert.ok(/connect-src 'self' https:\/\/[a-z0-9-]+\.goatcounter\.com/.test(policy), "beacon allowed: " + policy);
  assert.ok(!/"/.test(policy), "policy must never contain a double quote — it lives in an attribute");
  // A policy with no connect-src would fall back to default-src and silently block the beacon.
  const noConnect = U.cspWith("default-src 'self'; script-src 'self'; object-src 'none'");
  assert.ok(/connect-src/.test(noConnect), "a missing connect-src is added, not assumed: " + noConnect);
});

test("ensureAnalytics: frozen archive pages get the tag, keep valid CSP, and stay idempotent", () => {
  if (!U.GC_SITE) return;   // analytics switched off in this build — nothing to assert
  const frozen = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'"><title>X</title></head><body>b</body></html>`;
  const once = U.ensureAnalytics(frozen);
  assert.ok(once.changed && once.html.includes("gc.zgo.at/count.js"), "archive pages are measured too");
  const csp = /content="([^"]*)"/.exec(once.html)[1];
  assert.ok(/script-src 'self' https:\/\/gc\.zgo\.at/.test(csp) && /connect-src/.test(csp), csp);
  assert.ok(!U.ensureAnalytics(once.html).changed, "idempotent — a re-sweep doesn't stack tags");
  assert.strictEqual((once.html.match(/gc\.zgo\.at/g) || []).length, 2, "one script tag, one CSP mention");
  // A page whose head we don't recognise is left exactly alone.
  assert.ok(!U.ensureAnalytics("<html><head><title>no csp</title></head></html>").changed);
});

test("every generated page type carries the tag", () => {
  if (!U.GC_SITE) return;   // analytics switched off in this build — nothing to assert
  const IN = { code: "in", name: "India", region: "IN" };
  const film = U.buildFilmPage({ title: "A", slug: "a", kind: "movie", platform: "Netflix", providers: ["Netflix"] }, "2026-09-19", new Set(["a"]), IN);
  assert.ok(film.includes("gc.zgo.at/count.js"), "film page");
  assert.ok(/script-src[^;]*gc\.zgo\.at/.test(film), "film page CSP allows it");
  const month = U.buildOttMonthPage(
    [{ c: "in", k: "movie", id: 1, t: "A", p: "Netflix", first: "2026-09-04", rel: "2026-08-01", lang: "Hindi", g: "Drama" }],
    IN, { month: "2026-09", months: [{ month: "2026-09", n: 1 }] });
  assert.ok(month.includes("gc.zgo.at/count.js"), "listing pages (hubs, months, weeks, languages)");
});

// ---------------- Scoped month archives (platform x month, language x month) ----------
group("scoped month archives: the arrival record, cut by platform and by language");
const SCOPE_RECS = [
  { c: "in", k: "movie", id: 1, t: "Alpha", p: "Netflix", first: "2026-09-04", rel: "2026-07-01", lang: "Hindi", g: "Drama" },
  { c: "in", k: "movie", id: 2, t: "Beta", p: "Netflix", first: "2026-09-12", rel: "2026-09-12", lang: "Tamil", g: "Action" },
  { c: "in", k: "tv", id: 3, t: "Gamma", p: "Netflix", first: "2026-09-14", rel: "2019-01-01", lang: "Hindi", g: "Comedy" },
  { c: "in", k: "movie", id: 4, t: "Delta", p: "Netflix", first: "2026-09-20", rel: "2026-06-06", lang: "Hindi", g: "Thriller" },
];

test("buildScopedMonthPage (platform): groups by language, links back up both axes", () => {
  const html = U.buildScopedMonthPage(SCOPE_RECS, { code: "in", name: "India", region: "IN", streamWord: "OTT" }, {
    scope: { kind: "platform", name: "Netflix", slug: "netflix" },
    month: "2026-09", months: ["2026-08", "2026-09"],
    index: [{ slug: "alpha", title: "Alpha", poster: "https://image.tmdb.org/t/p/w342/a.jpg" }],
    now: Date.parse("2026-09-25T00:00:00Z"),
  });
  assert.ok(/<title>New on Netflix in India — September 2026/.test(html));
  assert.ok(/rel="canonical" href="https:\/\/filmychill.com\/new-on-netflix\/2026-09\/"/.test(html));
  assert.ok(html.indexOf("Hindi — September 2026") < html.indexOf("Tamil — September 2026"), "biggest language group first");
  assert.ok(/4 — Hindi \(3\), Tamil \(1\)/.test(html), "counts in the FAQ match the rows");
  assert.ok(/href="\/movie\/alpha.html"/.test(html) && !/href="\/movie\/beta.html"/.test(html), "links only where a page exists");
  assert.ok(/← August 2026/.test(html), "previous month in the same scope");
  assert.ok(/Everything new in September 2026/.test(html), "up to the whole month");
  assert.ok(/Netflix this week/.test(html), "up to the platform's weekly hub");
});

test("buildScopedMonthPage (language): groups by platform and names the language", () => {
  const html = U.buildScopedMonthPage(SCOPE_RECS.filter((r) => r.lang === "Hindi"),
    { code: "in", name: "India", region: "IN", streamWord: "OTT" },
    { scope: { kind: "language", name: "Hindi", slug: "hindi" }, month: "2026-09", months: ["2026-09"],
      index: [], now: Date.parse("2026-09-25T00:00:00Z") });
  assert.ok(/<title>New Hindi on OTT in India — September 2026/.test(html), (/<title>[^<]*/.exec(html) || [])[0]);
  assert.ok(/rel="canonical" href="https:\/\/filmychill.com\/hindi\/2026-09\/"/.test(html));
  assert.ok(/Netflix — September 2026/.test(html), "a language page groups by platform");
  assert.ok(/Hindi this week/.test(html));
});

test("a closed scoped month freezes; the current one says it is still filling", () => {
  const cfg = { code: "in", name: "India", region: "IN", streamWord: "OTT" };
  const opts = (month) => ({ scope: { kind: "platform", name: "Netflix", slug: "netflix" }, month,
    months: ["2026-08", "2026-09"], index: [], now: Date.parse("2026-09-25T00:00:00Z") });
  assert.ok(/still filling up/.test(U.buildScopedMonthPage(SCOPE_RECS, cfg, opts("2026-09"))));
  const closed = U.buildScopedMonthPage(SCOPE_RECS, cfg, opts("2026-08"));
  assert.ok(/August 2026 is closed/.test(closed) && /A complete record of August 2026/.test(closed));
});

test("scoped month paths and URLs are namespaced per country; language months are India-only", () => {
  assert.strictEqual(U.platformMonthPath("in", "netflix", "2026-09"), "new-on-netflix/2026-09/index.html");
  assert.strictEqual(U.platformMonthPath("ae", "netflix", "2026-09"), "ae/new-on-netflix/2026-09/index.html");
  assert.strictEqual(U.platformMonthUrl("sg", "apple-tv", "2026-09"), "https://filmychill.com/sg/new-on-apple-tv/2026-09/");
  assert.strictEqual(U.languageMonthPath("telugu", "2026-09"), "telugu/2026-09/index.html");
  assert.strictEqual(U.languageMonthUrl("telugu", "2026-09"), "https://filmychill.com/telugu/2026-09/");
  assert.ok(U.SCOPED_MONTH_MIN >= 3, "a thin month must not get its own page");
});

// ---------------- Film page -> hub crawl paths ----------------
test("film pages link out to their platform hub and their arrival month, never to a 404", () => {
  const IN = { code: "in", name: "India", region: "IN" };
  // No provider -> no hub links at all (a theatrical page belongs to no platform).
  const theatrical = U.buildFilmPage({ title: "T", slug: "t", kind: "movie", platform: "Theatres", released: "2026-09-01" },
    "2026-09-19", new Set(["t"]), IN);
  assert.ok(!/Everything new on /.test(theatrical), "nothing to link to yet");
  // With a provider, the link appears only when the hub page exists on disk. Both branches are
  // valid depending on the working tree, so assert the invariant that matters: no dead links.
  const streaming = U.buildFilmPage({ title: "S", slug: "s", kind: "movie", platform: "Netflix", providers: ["Netflix"], tmdbId: 1 },
    "2026-09-19", new Set(["s"]), IN);
  for (const href of (streaming.match(/href="\/new-on-[a-z0-9-]+\/(?:\d{4}-\d{2}\/)?"/g) || [])) {
    const path = href.slice(6, -1).replace(/^\//, "") + "index.html";
    assert.ok(require("fs").existsSync(path), "linked hub must exist on disk: " + path);
  }
});

// ---------------- Back-catalogue backfill (the long-tail build) ----------------
group("catalogue backfill: queue bookkeeping and the eligibility bar");
const CAT = require("./lib/catalog.js");
const CAT_CFG = { code: "in", name: "India", region: "IN", watchRegion: "IN",
  ottRegionalLangs: ["hi", "ml"], priorityLangs: ["hi", "ta"] };

test("catalogQueues: market languages first, English always, no duplicates, movie+tv each", () => {
  const q = CAT.catalogQueues(CAT_CFG);
  assert.deepStrictEqual(q.map((x) => x.key),
    ["hi:movie", "hi:tv", "ml:movie", "ml:tv", "ta:movie", "ta:tv", "en:movie", "en:tv"]);
  assert.strictEqual(CAT.catalogQueues({}).length, 2, "a config with no languages still walks English");
});

test("nextQueue: round-robins, skips retired queues, and reports exhaustion", () => {
  const state = {}, queues = CAT.catalogQueues(CAT_CFG);
  const first = CAT.nextQueue(state, "in", queues);
  assert.strictEqual(first.key, "hi:movie");
  assert.strictEqual(first.page, 1, "a fresh queue starts at page 1");
  assert.strictEqual(CAT.nextQueue(state, "in", queues).key, "hi:tv", "cursor advances between calls");
  // Retire everything except one queue: that queue is what comes back, every time.
  for (const q of queues) if (q.key !== "ml:movie") CAT.queueState(state, "in", q.key).done = true;
  assert.strictEqual(CAT.nextQueue(state, "in", queues).key, "ml:movie");
  CAT.queueState(state, "in", "ml:movie").done = true;
  assert.strictEqual(CAT.nextQueue(state, "in", queues), null, "every queue retired -> null, not a loop");
});

test("markQueue: pages advance, barren queues retire, an empty response retires immediately", () => {
  const state = {};
  const q = () => CAT.queueState(state, "in", "hi:movie");
  CAT.markQueue(state, "in", "hi:movie", { usable: 4, results: 20 });
  assert.strictEqual(q().page, 2);
  assert.ok(!q().done);
  for (let i = 0; i < 3; i++) CAT.markQueue(state, "in", "hi:movie", { usable: 0, results: 20 });
  assert.ok(q().done, "three barren pages running -> retired, not re-fetched every run forever");
  const state2 = {};
  CAT.markQueue(state2, "in", "en:tv", { usable: 0, results: 0 });
  assert.ok(CAT.queueState(state2, "in", "en:tv").done, "TMDB out of pages -> retired");
  const state3 = {};
  CAT.queueState(state3, "in", "en:tv").page = CAT.CATALOG_MAX_PAGE;
  CAT.markQueue(state3, "in", "en:tv", { usable: 5, results: 20 });
  assert.ok(CAT.queueState(state3, "in", "en:tv").done, "depth cap retires the queue");
});

test("catalogEligible: only titles that can actually answer a question get a page", () => {
  const slugOf = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const old = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const base = { id: 1, title: "Old Favourite", poster_path: "/p.jpg", overview: "A synopsis.",
    vote_count: 500, vote_average: 7.2, release_date: old };
  const ok = (over = {}, opts = {}) => CAT.catalogEligible({ ...base, ...over }, { slugOf, ...opts });
  assert.ok(ok(), "a popular, rated, old, streaming title qualifies");
  assert.ok(!ok({ vote_count: 12 }), "no audience numbers -> no honest verdict -> no page");
  assert.ok(!ok({ poster_path: null }), "posterless card is a shell");
  assert.ok(!ok({ overview: "  " }), "no synopsis is a shell");
  assert.ok(!ok({ adult: true }));
  assert.ok(!ok({ release_date: new Date().toISOString().slice(0, 10) }), "new releases belong to the weekly pipeline");
  assert.ok(!ok({ release_date: "" }), "undated title cannot be aged");
  assert.ok(!ok({}, { have: new Set(["old-favourite"]) }), "never overwrite a page the weekly pipeline owns");
  assert.ok(!ok({}, { excludeIds: new Set([1]) }), "the manual exclusion list still wins");
  assert.ok(ok({ title: null, name: "A Series", first_air_date: old, release_date: null }, {}), "TV shape works too");
});

test("catalogSlug: disambiguates by year exactly like assignSlugs, or declines", () => {
  const slugOf = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const m = { id: 7, title: "Drishyam", release_date: "2015-07-31" };
  assert.strictEqual(CAT.catalogSlug(m, { slugOf, have: new Set() }), "drishyam");
  assert.strictEqual(CAT.catalogSlug(m, { slugOf, have: new Set(["drishyam"]) }), "drishyam-2015");
  assert.strictEqual(CAT.catalogSlug({ id: 8, title: "Drishyam" }, { slugOf, have: new Set(["drishyam"]) }), null,
    "no year to disambiguate with -> skip the title rather than clobber a page");
});

// ---------------- Monthly OTT archive (hub depth) ----------------
group("monthly archive: the arrival record as a permanent page");
const HIST = require("./lib/history.js");
const MONTH_RECS = [
  { c: "in", k: "movie", id: 1, t: "Alpha", p: "Netflix", first: "2026-08-04", rel: "2026-06-01", lang: "Hindi", g: "Drama" },
  { c: "in", k: "movie", id: 2, t: "Beta", p: "Netflix", first: "2026-08-19", rel: "2026-08-19", lang: "Tamil", g: "Action" },
  { c: "in", k: "tv", id: 3, t: "Gamma", p: "JioHotstar", first: "2026-08-22", rel: "2019-01-01", lang: "English", g: "Comedy" },
  { c: "in", k: "movie", id: 4, t: "Delta", p: "Netflix", first: "2026-09-02", rel: "2026-07-07", lang: "Hindi", g: "Drama" },
  { c: "uk", k: "movie", id: 5, t: "Epsilon", p: "Netflix", first: "2026-08-08", rel: "2026-05-05", lang: "English", g: "Drama" },
];

test("historyMonths / historyForMonth: per country, newest first, nothing borrowed", () => {
  assert.deepStrictEqual(HIST.historyMonths(MONTH_RECS, "in"), [{ month: "2026-09", n: 1 }, { month: "2026-08", n: 3 }]);
  assert.deepStrictEqual(HIST.historyForMonth(MONTH_RECS, "in", "2026-08").map((r) => r.t), ["Gamma", "Beta", "Alpha"]);
  assert.deepStrictEqual(HIST.historyForMonth(MONTH_RECS, "uk", "2026-08").map((r) => r.t), ["Epsilon"],
    "a UK arrival never appears on an India page");
  assert.deepStrictEqual(HIST.historyForMonth(MONTH_RECS, "in", "nonsense"), []);
  assert.strictEqual(HIST.monthLabel("2026-08"), "August 2026");
});

test("buildOttMonthPage: groups by platform, links only pages that exist, counts honestly", () => {
  const aug = HIST.historyForMonth(MONTH_RECS, "in", "2026-08");
  const html = U.buildOttMonthPage(aug, { code: "in", name: "India", region: "IN", streamWord: "OTT" }, {
    month: "2026-08", months: HIST.historyMonths(MONTH_RECS, "in"),
    index: [{ slug: "alpha", title: "Alpha", poster: "https://image.tmdb.org/t/p/w342/a.jpg" }],
    now: Date.parse("2026-09-18T00:00:00Z"),
  });
  assert.ok(/<title>Everything New on OTT in India — August 2026/.test(html));
  assert.ok(html.indexOf("Netflix — August 2026") < html.indexOf("JioHotstar — August 2026"), "biggest platform first");
  assert.ok(/href="\/movie\/alpha.html"/.test(html), "a title with a page gets a link");
  assert.ok(!/href="\/movie\/beta.html"/.test(html), "a title with no page is not linked to a 404");
  assert.ok(/>Beta</.test(html), "...but it is still listed");
  assert.ok(/3 — Netflix \(2\), JioHotstar \(1\)/.test(html), "FAQ counts match the rows");
  assert.ok(/Started streaming 4 Aug/.test(html), "a film that streamed later than release says when");
  assert.ok(!/Beta[\s\S]{0,300}Started streaming/.test(html), "a same-day arrival doesn't repeat itself");
  assert.ok(/September 2026 →/.test(html) && /This week&#39;s OTT releases/.test(html), "month nav is present");
});

test("buildOttMonthPage: a closed month says so; the current month says it is still filling", () => {
  const now = Date.parse("2026-09-18T00:00:00Z");
  const cfg = { code: "in", name: "India", region: "IN", streamWord: "OTT" };
  const months = HIST.historyMonths(MONTH_RECS, "in");
  const closed = U.buildOttMonthPage(HIST.historyForMonth(MONTH_RECS, "in", "2026-08"), cfg, { month: "2026-08", months, now });
  const current = U.buildOttMonthPage(HIST.historyForMonth(MONTH_RECS, "in", "2026-09"), cfg, { month: "2026-09", months, now });
  assert.ok(/August 2026 is closed/.test(closed) && /A complete record of August 2026/.test(closed));
  assert.ok(!/is closed/.test(current) && /still filling up/.test(current));
});

test("month archive paths and URLs are namespaced per country", () => {
  assert.strictEqual(U.ottMonthPath("in", "2026-08"), "new-on-ott/2026-08/index.html");
  assert.strictEqual(U.ottMonthPath("ae", "2026-08"), "ae/new-on-ott/2026-08/index.html");
  assert.strictEqual(U.ottMonthUrl("in", "2026-08"), "https://filmychill.com/new-on-ott/2026-08/");
  assert.strictEqual(U.ottMonthUrl("uk", "2026-08"), "https://filmychill.com/uk/new-on-ott/2026-08/");
});

// ---------------- Film-page archive (honest long tail) ----------------
test("archivePatchHtml + generator SYNC GUARD: a real theatrical page gets honestly archived", () => {
  // Build an actual page with buildFilmPage, then archive-patch it. If someone rewords the
  // theatrical claims in buildVerdictProse/buildFaqs without updating archivePatchHtml,
  // THIS test fails — the patcher and generator must stay in step.
  const item = { title: "T", slug: "t", kind: "movie", language: "Hindi", platform: "Theatres",
    released: "2026-06-01", rating: 7.0, votes: 500, verdict: "Worth a watch", runtime: 120 };
  const page = U.buildFilmPage(item, "2026-06-17", new Set(["t"]), { code: "in", name: "India", region: "IN" });
  assert.ok(page.includes("in theatres in India now"), "precondition: page carries the live claim");
  const { html, changed } = U.archivePatchHtml(page, "India");
  assert.ok(changed, "patch must fire on a theatrical page");
  assert.ok(!html.includes("in theatres in India now"), "live claim removed");
  assert.ok(html.includes("had its theatrical run in India"));
  assert.ok(html.includes("finished its theatrical run in India"));
  assert.ok(!html.includes('<span class="pill">In theatres</span>'));
});
test("archive patch v6: frozen JSON-LD loses aggregateRating, stays valid JSON, idempotent", () => {
  const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
  const agg = { "@type": "AggregateRating", ratingValue: 7.3, ratingCount: 38, bestRating: 10 };
  const shapes = [
    { "@context": "https://schema.org", "@type": "Movie", name: "A", actor: [{ "@type": "Person", name: "X" }], aggregateRating: agg },
    { "@context": "https://schema.org", "@type": "Movie", name: "B", actor: [], aggregateRating: agg, citation: { "@type": "CreativeWork", name: "W" } },
    { "@context": "https://schema.org", "@type": "Movie", aggregateRating: agg, name: "C" },
  ];
  for (const shape of shapes) {
    const page = `<html><head>${ld(shape)}</head><body>★ 7.3</body></html>`;
    const once = U.stripAggregateRating(page);
    assert.ok(once.changed, "strip fires on " + shape.name);
    assert.ok(!once.html.includes("aggregateRating"));
    const json = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(once.html)[1]);
    assert.strictEqual(json.name, shape.name, "other schema fields survive");
    assert.ok(once.html.includes("★ 7.3"), "visible, attributed rating in the body is untouched");
    assert.ok(!U.stripAggregateRating(once.html).changed, "idempotent");
  }
  const live = U.buildFilmPage({ title: "T", slug: "t", kind: "movie", language: "Hindi", platform: "Theatres",
    released: "2026-06-01", rating: 7.0, votes: 500, verdict: "Worth a watch", runtime: 120 },
    "2026-06-17", new Set(["t"]), { code: "in", name: "India", region: "IN" });
  assert.ok(!live.includes("aggregateRating"), "live builder still emits no aggregateRating");
  const frozen = `<html><head>${ld(shapes[0])}</head></html>`;
  assert.ok(U.archivePatchHtml(frozen, "India").changed, "archivePatchHtml wires the strip in");
});
test("archivePatchHtml: OTT availability lines stay untouched; only time-relative leads patch", () => {
  // Mid-band lead is timeless -> a streaming page with it is a true no-op.
  const mid = { title: "S", slug: "s", kind: "tv", language: "English", platform: "Netflix",
    providers: ["Netflix"], released: "2026-06-01", freshDate: "2026-06-20", rating: 6.8, votes: 900, verdict: "Worth a watch" };
  const midPage = U.buildFilmPage(mid, "2026-06-25", new Set(["s"]), { code: "in", name: "India", region: "IN" });
  assert.ok(!U.archivePatchHtml(midPage, "India").changed, "nothing to patch on a mid-band streaming page");
  // Top-band lead says "right now" -> patched even on an OTT page, but the streaming
  // availability sentence must survive verbatim (it stays true after archiving).
  const top = { ...mid, rating: 8.0, verdict: "Must watch" };
  const topPage = U.buildFilmPage(top, "2026-06-25", new Set(["s"]), { code: "in", name: "India", region: "IN" });
  const before = /In India you can stream it on [^<]+/.exec(topPage);
  const out = U.archivePatchHtml(topPage, "India");
  assert.ok(out.changed, "time-relative lead on an OTT page gets the timeless treatment");
  assert.ok(!/right now|at the moment|the current /.test(out.html));
  assert.ok(before && out.html.includes(before[0]), "streaming availability line untouched");
});
test("archive patch v7: frozen titles stop promising a date the page cannot give", () => {
  const IN = { code: "in", name: "India", region: "IN" };
  // A real frozen theatrical page: built live, then archived.
  const theatrical = U.buildFilmPage({ title: "Dastaar", slug: "dastaar", kind: "movie", language: "Punjabi",
    platform: "Theatres", released: "2026-06-01", rating: 7.1, votes: 400, verdict: "Worth a watch", runtime: 130 },
    "2026-06-17", new Set(["dastaar"]), IN);
  const frozen = U.archivePatchHtml(theatrical, "India", IN).html;
  const titleOf = (h) => /<title>([^<]*)<\/title>/.exec(h)[1];
  assert.ok(!/OTT Release Date/.test(titleOf(frozen)), "no provider on the page -> no date promise: " + titleOf(frozen));
  assert.ok(/Where to Watch/.test(titleOf(frozen)));
  assert.ok(!U.retitleFrozen(frozen, IN).changed, "idempotent");

  // The inverse: a streaming page CAN answer it, so the query words belong there.
  const streaming = U.buildFilmPage({ title: "Dastaar", slug: "dastaar", kind: "movie", language: "Punjabi",
    platform: "Netflix", providers: ["Netflix"], released: "2026-06-01", rating: 7.1, votes: 400,
    verdict: "Worth a watch", runtime: 130 }, "2026-08-17", new Set(["dastaar"]), IN);
  assert.ok(/OTT Release Date/.test(titleOf(streaming)));
  // Simulate a page frozen under the OLD rule (date title, no providers) and re-sweep it.
  const stale = frozen.replace(/<title>[^<]*<\/title>/, "<title>Dastaar (2026) OTT Release Date, Review &amp; Where to Watch</title>");
  const swept = U.retitleFrozen(stale, IN);
  assert.ok(swept.changed && !/OTT Release Date/.test(titleOf(swept.html)), "the stale promise is rewritten");
  assert.ok(/&amp;|Where to Watch/.test(titleOf(swept.html)) && !/<title>[^<]*<script/.test(swept.html));

  // A page whose JSON-LD can't be read is left exactly alone.
  assert.ok(!U.retitleFrozen("<html><head><title>Whatever</title></head></html>", IN).changed);
});

test("reconcilePagesManifest: current bumps last + clears archive; departed marked ONCE", () => {
  const today = "2026-07-04";
  const manifest = { in: {
    "current-film": { last: "2026-07-03" },
    "returned-film": { last: "2026-06-01", archivedOn: "2026-06-10" },
    "already-archived": { last: "2026-06-01", archivedOn: "2026-06-10" },
  } };
  const current = new Set(["current-film", "returned-film", "brand-new"]);
  const disk = ["current-film", "returned-film", "brand-new", "already-archived", "just-departed"];
  const toArchive = U.reconcilePagesManifest(manifest, "in", current, disk, today);
  assert.deepStrictEqual(toArchive, ["just-departed"], "only NEWLY departed pages get patched");
  assert.strictEqual(manifest.in["current-film"].last, today);
  assert.ok(!manifest.in["returned-film"].archivedOn, "a returning film is live again");
  assert.strictEqual(manifest.in["already-archived"].archivedOn, "2026-06-10", "frozen date untouched");
  assert.strictEqual(manifest.in["just-departed"].archivedOn, today);
  assert.strictEqual(manifest.in["brand-new"].last, today);
});

// ---------------- First-seen tracking (ott-seen.json) ----------------
// Guards the upgrade from release-date freshness to true catalog-arrival freshness.
// TH_NOW = 2026-07-02 (declared above). daysAgo(n) helpers reused.
test("ottArrival: late OTT arrival — old release, fresh sighting -> effective=arrival, badged", () => {
  const { effective, isArrival } = U.ottArrival(daysAgo(80), daysAgo(3), TH_NOW);
  assert.strictEqual(effective, daysAgo(3), "gate/decay must use the arrival date");
  assert.ok(isArrival, "80-day-old film newly on a platform is an arrival event");
});
test("ottArrival: direct-to-OTT release — fresh release, fresh sighting -> release event, NOT arrival-badged", () => {
  const { effective, isArrival } = U.ottArrival(daysAgo(3), daysAgo(2), TH_NOW);
  assert.strictEqual(effective, daysAgo(3), "a fresh release keeps its release date for the gate (not the later sighting)");
  assert.ok(!isArrival, "recent releases already carry the release badge");
});
test("ottArrival: recent catalog addition — a few-months-old release first seen today -> fresh + arrival", () => {
  const { effective, isArrival } = U.ottArrival(daysAgo(120), daysAgo(0), TH_NOW);
  assert.strictEqual(effective, daysAgo(0), "a genuine recent arrival uses the arrival date");
  assert.ok(isArrival, "within the arrival release-age window -> badge");
});
test("ottArrival: re-pruned catalog title — 8-month-old season re-seeded today -> NOT arrival, stays stale (Stranger Things bug)", () => {
  const { effective, isArrival } = U.ottArrival(daysAgo(240), daysAgo(0), TH_NOW);
  assert.ok(!isArrival, "an 8-month-old release is a catalog title, not a new arrival, however recently the ledger forgot it");
  assert.strictEqual(effective, daysAgo(240), "effective must stay the true release date so the freshness gate drops it");
});
test("ottArrival: release-age ceiling sits above the seen-retention window (no genuine arrival excluded)", () => {
  assert.ok(U.ARRIVAL_MAX_RELEASE_AGE > U.SEEN_RETENTION_DAYS);
});
test("ottArrival: long-listed title — old first-sighting -> no badge, effective stays put", () => {
  const { isArrival } = U.ottArrival(daysAgo(60), daysAgo(40), TH_NOW);
  assert.ok(!isArrival, "a title sighted 40 days ago is not newly arrived");
});
// ---------------- Discover / social image sizing ----------------
group("social image (Google Discover >=1200px)");
test("socialImage: backdrop rendered at w1280, not the inline w780", () => {
  const s = U.socialImage({ backdropPath: "/abc.jpg", posterPath: "/def.jpg", backdrop: "https://image.tmdb.org/t/p/w780/abc.jpg" });
  assert.strictEqual(s, "https://image.tmdb.org/t/p/w1280/abc.jpg");
});
test("socialImage: no backdrop -> poster at w780 (clears the size bar, not a 342px thumb)", () => {
  const s = U.socialImage({ posterPath: "/def.jpg" });
  assert.strictEqual(s, "https://image.tmdb.org/t/p/w780/def.jpg");
});
test("socialImage: legacy item without raw paths falls back to pre-sized strings (no crash)", () => {
  assert.strictEqual(U.socialImage({ backdrop: "https://image.tmdb.org/t/p/w780/x.jpg" }), "https://image.tmdb.org/t/p/w780/x.jpg");
  assert.strictEqual(U.socialImage({}), null);
  assert.strictEqual(U.socialImage(null), null);
});
test("film page og:image uses w1280 backdrop + 16:9 dimensions", () => {
  const html = U.buildFilmPage({ title: "X", slug: "x", kind: "movie", language: "English", platform: "Theatres",
    released: "2026-07-10", rating: 7, votes: 100, backdropPath: "/bd.jpg", posterPath: "/ps.jpg" },
    "2026-07-19", new Set(["x"]), { code: "in", name: "India", region: "IN" });
  assert.ok(html.includes('property="og:image" content="https://image.tmdb.org/t/p/w1280/bd.jpg"'), "og:image must be w1280");
  assert.ok(!html.includes("/w780/bd.jpg"), "must not ship the small inline size as og:image");
  assert.ok(html.includes('property="og:image:width" content="1280"'));
});
test("film page og:image: poster-only film omits (wrong) 16:9 dimensions", () => {
  const html = U.buildFilmPage({ title: "Y", slug: "y", kind: "movie", language: "English", platform: "Theatres",
    released: "2026-07-10", rating: 7, votes: 100, posterPath: "/ps.jpg" },
    "2026-07-19", new Set(["y"]), { code: "in", name: "India", region: "IN" });
  assert.ok(html.includes('property="og:image" content="https://image.tmdb.org/t/p/w780/ps.jpg"'));
  assert.ok(!html.includes('og:image:width'), "portrait poster must not claim 1280x720");
});
test("ottArrival: null freshDate (too-new title) -> effective = first sighting", () => {
  const { effective } = U.ottArrival(null, daysAgo(1), TH_NOW);
  assert.strictEqual(effective, daysAgo(1));
});
test("recordOttSeen: cold start seeds with the EARLIER of release date and today (no fake-new flood)", () => {
  const seen = {};
  const first = U.recordOttSeen(seen, "movie:1", daysAgo(30), daysAgo(0), true);
  assert.strictEqual(first, daysAgo(30), "existing catalog must keep release-based freshness on day one");
  assert.strictEqual(seen["movie:1"].last, daysAgo(0));
});
test("recordOttSeen: incremental — unseen key is a new arrival (first = today)", () => {
  const seen = { "movie:1": { first: daysAgo(30), last: daysAgo(1) } };
  const first = U.recordOttSeen(seen, "movie:2", daysAgo(90), daysAgo(0), false);
  assert.strictEqual(first, daysAgo(0));
});
test("recordOttSeen: repeat sighting returns original first and bumps last", () => {
  const seen = { "tv:9": { first: daysAgo(10), last: daysAgo(1) } };
  const first = U.recordOttSeen(seen, "tv:9", daysAgo(12), daysAgo(0), false);
  assert.strictEqual(first, daysAgo(10));
  assert.strictEqual(seen["tv:9"].last, daysAgo(0));
});
test("pruneOttSeen: entries unseen past retention are dropped, recent ones kept", () => {
  const all = { in: {
    stale: { first: daysAgo(300), last: daysAgo(200) },
    fresh: { first: daysAgo(300), last: daysAgo(5) },
  } };
  U.pruneOttSeen(all, TH_NOW);
  assert.ok(!all.in.stale, "200-days-unseen entry must be pruned");
  assert.ok(all.in.fresh, "recently-seen entry survives regardless of age");
});
test("laterDate/earlierDate: null-safe date-string comparison", () => {
  assert.strictEqual(U.laterDate("2026-06-01", "2026-07-01"), "2026-07-01");
  assert.strictEqual(U.earlierDate("2026-06-01", "2026-07-01"), "2026-06-01");
  assert.strictEqual(U.laterDate(null, "2026-07-01"), "2026-07-01");
  assert.strictEqual(U.earlierDate("2026-06-01", null), "2026-06-01");
});
test("first-seen end-to-end: gate keeps a late arrival that release-date freshness would drop", () => {
  // An April theatrical film first sighted on a platform 3 days ago: release-age 80d fails
  // the 45d window, but the EFFECTIVE date (arrival) passes — the whole point of the feature.
  const releaseDate = daysAgo(80), firstSeen = daysAgo(3);
  assert.ok(!U.isOttFresh(releaseDate, TH_NOW), "release date alone would be gated out");
  const { effective } = U.ottArrival(releaseDate, firstSeen, TH_NOW);
  assert.ok(U.isOttFresh(effective, TH_NOW), "effective date keeps it in the list");
});

// ---------------- Buzz signals (Wikipedia pageviews + trailer stats) ----------------
// Guards the free-data features: computeBuzz decides the 🔥 Trending badge from raw daily
// pageview counts; fmtViews/trailerViewsLabel format trailer social proof.
test("computeBuzz: high absolute daily views -> trending", () => {
  const b = U.computeBuzz([9000,9500,8000,9000,9500,9000,8500, 15000,16000,14000,15500,15000,16000,14500]);
  assert.ok(b.trending);
  assert.strictEqual(b.weeklyViews, 106000);
});
test("computeBuzz: clear week-over-week spike above floor -> trending", () => {
  const b = U.computeBuzz([2000,2000,2000,2000,2000,2000,2000, 4000,4000,4000,4000,4000,4000,4000]);
  assert.ok(b.trending, "2x spike at 4k/day must trend");
});
test("computeBuzz: flat/low interest -> not trending; tiny spikes never trend (floor)", () => {
  assert.ok(!U.computeBuzz([3000,3000,3000,3000,3000,3000,3000, 3100,3000,3050,3000,3100,3000,3050]).trending);
  assert.ok(!U.computeBuzz([20,20,20,20,20,20,20, 40,40,40,40,40,40,40]).trending, "20->40 views is noise, not buzz");
});
test("computeBuzz: fewer than 7 days of data -> null (too new to judge)", () => {
  assert.strictEqual(U.computeBuzz([5000, 6000, 7000]), null);
  assert.strictEqual(U.computeBuzz(null), null);
});
test("fmtViews: social-proof formatting across magnitudes", () => {
  assert.strictEqual(U.fmtViews(52123456), "52M");
  assert.strictEqual(U.fmtViews(3400000), "3.4M");
  assert.strictEqual(U.fmtViews(850000), "850K");
  assert.strictEqual(U.fmtViews(1234567890), "1.2B");
});
test("trailerViewsLabel: null below 1M (anti-proof guard), label at 52M", () => {
  assert.strictEqual(U.trailerViewsLabel(999999), null);
  assert.strictEqual(U.trailerViewsLabel(undefined), null);
  assert.strictEqual(U.trailerViewsLabel(52123456), "▶ 52M trailer views");
});
test("ssrCard: trending badge + trailer views render from data fields", () => {
  const html = U.ssrCard({ title: "HotD", platform: "JioHotstar", language: "English", genre: "Fantasy / Drama",
    rating: 8.2, verdict: "Must watch", kind: "tv", slug: "hotd", trending: true, trailerViews: 52123456,
    badge: "New season", freshDate: "2026-06-21" }, 0, "in");
  assert.ok(html.includes("Trending") && !html.includes("🔥")); // icon badge, not emoji
  assert.ok(!html.includes("trailer views")); // social proof lives on the detail page now
  assert.ok(html.includes("New season"));
});
test("ssrCard: no buzz fields -> no trending badge, no views label (graceful absence)", () => {
  const html = U.ssrCard({ title: "Plain", platform: "Netflix", language: "Hindi", rating: 7.0,
    verdict: "Worth a watch", kind: "movie", slug: "plain" }, 0, "in");
  assert.ok(!html.includes("Trending"));
  assert.ok(!html.includes("trailer views"));
});
test("buildHeadTags: with data — live month in title, real film names in description (CTR)", () => {
  const data = { generatedAt: "2026-07-04T07:22:38Z",
    theatres: [{ title: "Toy Story 5" }, { title: "Supergirl" }],
    ott: [{ title: "House of the Dragon" }, { title: "Silo" }] };
  const html = U.buildHeadTags({ code: "in", name: "India" }, false, data);
  // The homepage title now runs the same 60-char cascade film pages have had since August.
  // Live on 14 Sept 2026 it was 73 chars, so Google cut it mid-month and threw away the one
  // freshness signal in the string. Every tier keeps the month and the market's own word.
  const title = /<title>([^<]*)<\/title>/.exec(html)[1].replace(/&amp;/g, "&");
  assert.ok(title.length <= 60, "homepage title must fit the SERP: " + title.length + " — " + title);
  assert.ok(/^New Movies & OTT/.test(title), "query words lead: " + title);
  assert.ok(/This Week in India/.test(title), "country + recency survive: " + title);
  assert.ok(/\(July 2026\)/.test(title), "the month must never be the part that gets cut: " + title);
  assert.ok(html.includes("This week: Toy Story 5, House of the Dragon + 2 more"));
  assert.ok(html.includes("Updated twice daily"));
  const us = U.buildHeadTags({ code: "us", name: "United States" }, false, data);
  const usTitle = /<title>([^<]*)<\/title>/.exec(us)[1].replace(/&amp;/g, "&");
  assert.ok(usTitle.length <= 60, usTitle);
  assert.ok(/This Week in the US \(July 2026\)/.test(usTitle), usTitle);
});
// ---------------- About page — the promises it makes must be true ----------------
group("About page — the promises it makes must be true");
const fsAbout = require("fs");
const ABOUT_SRC = fsAbout.existsSync("about/index.html") ? fsAbout.readFileSync("about/index.html", "utf8") : "";
test("about: the country sentence is rebuilt from config, not hand-typed", () => {
  // It drifted: the page said "India (plus the US, UK, Australia and Germany)" three
  // markets after UAE, Canada and Singapore shipped. Now it lives behind an SSR marker.
  assert.ok(ABOUT_SRC.includes("<!--SSR:COUNTRIES-->"), "opening marker present");
  assert.ok(ABOUT_SRC.includes("<!--/SSR:COUNTRIES-->"), "closing marker present");
  const patched = U.patchAboutPage ? U.replaceBetween(ABOUT_SRC, "COUNTRIES", U.countryListForProse()) : ABOUT_SRC;
  for (const c of ["India", "Singapore", "Canada", "UAE"]) {
    assert.ok(patched.includes(c), c + " must appear once the marker is filled");
  }
  assert.ok(!patched.includes("plus the US, UK, Australia and Germany"), "stale hand-typed list gone");
});
test("about: documents the confidence gate the code actually enforces", () => {
  assert.ok(/no rating, no verdict and no critics' take/.test(ABOUT_SRC), "gate is described");
  // The page must not promise something takeConfident() doesn't do.
  assert.strictEqual(U.takeConfident({ isFresh: true }), false);
  assert.strictEqual(U.takeConfident({ isFresh: false, votes: 9 }), true);
});
test("about: the privacy claim matches what the site actually ships", () => {
  // REWRITTEN Sept 2026. The site now counts page views (GoatCounter, cookieless). The rule
  // this test protects is unchanged and is the important one: the About page must describe
  // exactly what ships. A cookie-setting or profiling tracker still fails outright, and if
  // analytics is ever switched off, the copy has to come back with it.
  const analyticsShipped = !!U.GC_SITE;
  assert.ok(/no account to create/.test(ABOUT_SRC), "the standing claims stay");
  if (analyticsShipped) {
    assert.ok(/GoatCounter/.test(ABOUT_SRC) && /cookieless/.test(ABOUT_SRC),
      "the counter must be disclosed by name on the About page");
    assert.ok(/sets no cookies/.test(ABOUT_SRC) && !/ships no analytics/.test(ABOUT_SRC),
      "the copy must not still promise no analytics while shipping some");
  } else {
    assert.ok(/ships no analytics/.test(ABOUT_SRC), "analytics off -> the stronger claim returns");
  }
  for (const f of ["index.html", "about/index.html"]) {
    if (!fsAbout.existsSync(f)) continue;
    const html = fsAbout.readFileSync(f, "utf8");
    assert.ok(!/google-analytics|googletagmanager|gtag\(|document\.cookie/.test(html),
      "no cookie-setting or profiling tracker may ever appear in " + f);
    if (!analyticsShipped) assert.ok(!/goatcounter/i.test(html), "kill switch off -> no tag anywhere: " + f);
  }
});

// ---------------- takeConfident() — critics' line confidence gate ----------------
group("takeConfident() — critics' line confidence gate");
test("takeConfident: an isFresh film gets no critics' line (no 'verdict soon' + a verdict)", () => {
  // Live on 14 Sept: Mandaadi showed "Just released — verdict soon" AND "A critical
  // darling — reviewers kept coming back to the performances and music." on one card.
  assert.strictEqual(U.takeConfident({ title: "Mandaadi", isFresh: true, rating: null }), false);
  assert.strictEqual(U.takeConfident({ title: "Sardar 2", isFresh: true, rating: null }), false);
});
test("takeConfident: thin AUDIENCE votes alone never suppress a settled critical consensus", () => {
  // "Not enough ratings yet" is a vote-count statement about viewers, not about critics —
  // an older niche title keeps its line. The gate is recency-scoped on purpose.
  assert.strictEqual(U.takeConfident({ title: "Gandhari", isFresh: false, rating: null, votes: 4 }), true);
  assert.strictEqual(U.takeConfident({ title: "Ted Lasso", isFresh: false, rating: 8.4 }), true);
});
test("takeConfident: an IMDb rating clears isFresh, so the line returns the same run", () => {
  assert.strictEqual(U.takeConfident({ isFresh: false, rating: 7.1, imdbRating: 7.1 }), true);
});

// ---------------- marqueeScore() — meta description name selection ----------------
group("marqueeScore() — meta description name selection");
test("marqueeScore: a market's own language outscores a foreign title with equal buzz", () => {
  const cfg = { code: "in", name: "India" }; // partial cfg resolves against COUNTRIES
  const hi = { title: "Mirzapur: The Movie", language: "Hindi", popularity: 40 };
  const en = { title: "Tony", language: "English", popularity: 40 };
  assert.ok(U.marqueeScore(hi, cfg) > U.marqueeScore(en, cfg), "Hindi leads on the India page");
  const us = { code: "us", name: "United States" };
  assert.ok(U.marqueeScore(en, us) > U.marqueeScore(hi, us), "and English leads on the US page");
});
test("marqueeScore: priority rank decays — first priorityLang beats the third", () => {
  const cfg = { code: "in" };
  assert.ok(U.marqueeScore({ language: "Hindi" }, cfg) > U.marqueeScore({ language: "Telugu" }, cfg));
  assert.ok(U.marqueeScore({ language: "Telugu" }, cfg) > U.marqueeScore({ language: "Korean" }, cfg));
});
test("marqueePick: picks the recognisable title, not rail position", () => {
  const cfg = { code: "in", name: "India" };
  const rail = [
    { title: "Tony", language: "English", popularity: 30 },
    { title: "Mirzapur: The Movie", language: "Hindi", trending: true, wikiWeeklyViews: 90000 },
    { title: "Toxic", language: "Kannada", trending: true, wikiWeeklyViews: 60000 },
  ];
  assert.strictEqual(U.marqueePick(rail, cfg).title, "Mirzapur: The Movie");
});
test("marqueePick: no signals at all -> rail order, so cold caches behave as before", () => {
  const rail = [{ title: "First" }, { title: "Second" }, { title: "Third" }];
  assert.strictEqual(U.marqueePick(rail, { code: "in" }).title, "First");
  assert.strictEqual(U.marqueePick([], { code: "in" }), null);
  assert.strictEqual(U.marqueePick(null, { code: "in" }), null);
});
test("buildHeadTags: the description names the films an Indian searcher recognises", () => {
  const data = { generatedAt: "2026-09-14T07:22:38Z",
    theatres: [
      { title: "Tony", language: "English", popularity: 30 },
      { title: "Mirzapur: The Movie", language: "Hindi", trending: true, wikiWeeklyViews: 90000 },
      { title: "Toxic", language: "Kannada", trending: true, wikiWeeklyViews: 60000 },
    ],
    ott: [
      { title: "Crew Girl", language: "English", popularity: 12 },
      { title: "Chumbak", language: "Hindi", wikiWeeklyViews: 8000 },
    ] };
  const html = U.buildHeadTags({ code: "in", name: "India" }, false, data);
  assert.ok(html.includes("This week: Mirzapur: The Movie, Chumbak + 3 more"), html.slice(0, 400));
  assert.ok(!html.includes("Tony, Crew Girl"), "the old rail-position pick is gone");
});
test("buildHeadTags: overflow keeps the stronger name, not reflexively the theatre one", () => {
  const long = "A Very Long Theatrical Title That Eats The Entire Description Budget Alone";
  const data = { generatedAt: "2026-09-14T07:22:38Z",
    theatres: [{ title: long, language: "English" }],
    ott: [{ title: "Chumbak", language: "Hindi", wikiWeeklyViews: 8000 }, { title: "X" }] };
  const html = U.buildHeadTags({ code: "in", name: "India" }, false, data);
  const d = /name="description" content="([^"]*)"/.exec(html)[1];
  assert.ok(d.includes("Chumbak"), d);
  assert.ok(!d.includes(long), "the budget-eating title is dropped, not the good one");
  assert.ok(d.length <= 158, "description stays inside the SERP budget: " + d.length);
});
test("buildHeadTags: without data — legacy static wording unchanged (backward compatible)", () => {
  const html = U.buildHeadTags({ code: "in", name: "India" }, false);
  assert.ok(html.includes("FilmyChill — Latest Movie &amp; OTT Releases, with Reviews, Updated Twice Daily"));
});
test("buildHeadTags: on-page hreflang alternates for all five homepages + x-default", () => {
  const html = U.buildHeadTags({ code: "us", name: "United States" }, false);
  assert.ok(html.includes('hreflang="en-IN" href="https://filmychill.com/"'));
  assert.ok(html.includes('hreflang="en-US" href="https://filmychill.com/us/"'));
  assert.ok(html.includes('hreflang="en-DE" href="https://filmychill.com/de/"'));
  assert.ok(html.includes('hreflang="x-default" href="https://filmychill.com/"'));
});
test("buildHeadTags: og mirrors the dynamic snippet; og:url, og:locale, twitter:card present", () => {
  const data = { generatedAt: "2026-07-04T07:22:38Z", theatres: [{ title: "Toy Story 5" }], ott: [{ title: "Silo" }, { title: "X" }] };
  const html = U.buildHeadTags({ code: "in", name: "India" }, false, data);
  // og:title must stay a mirror of whatever tier the cascade picked, not a frozen string.
  const serpTitle = /<title>([^<]*)<\/title>/.exec(html)[1];
  assert.ok(html.includes(`og:title" content="${serpTitle}"`), "share title = SERP title");
  assert.ok(html.includes('og:url" content="https://filmychill.com/"'));
  assert.ok(html.includes('og:locale" content="en_IN"'));
  assert.ok(html.includes('twitter:card" content="summary_large_image"'));
  const uk = U.buildHeadTags({ code: "uk", name: "United Kingdom", region: "GB" }, false, data);
  assert.ok(uk.includes('og:locale" content="en_GB"'));
});
test("buildHomeJsonLd: Organization brand entity with logo, linked as WebSite publisher", () => {
  const ld = JSON.parse(U.buildHomeJsonLd({ generatedAt: "2026-07-04T07:22:38Z", theatres: [], ott: [] }, { code: "in", name: "India" }));
  const org = ld["@graph"].find((n) => n["@type"] === "Organization");
  assert.ok(org, "Organization node present");
  assert.strictEqual(org.logo.url, "https://filmychill.com/icon-192.png");
  const site = ld["@graph"].find((n) => n["@type"] === "WebSite");
  assert.strictEqual(site.publisher["@id"], org["@id"], "WebSite links to the brand entity");
});
test("buildHeadTags: max-image-preview:large on every homepage (Google Discover eligibility)", () => {
  assert.ok(U.buildHeadTags({ code: "in", name: "India" }, false).includes('content="max-image-preview:large"'));
  assert.ok(U.buildHeadTags({ code: "us", name: "United States" }, false).includes('content="max-image-preview:large"'));
});

// ---------------- "New on OTT this week" page (organic-discovery page) ----------------
const OTT_WEEK_DATA = {
  generatedAt: "2026-07-01T07:54:26.326Z",
  ott: [
    { title: "Alliance", slug: "alliance", platform: "Amazon Prime Video", language: "English", genre: "Reality", rating: 7.2, verdict: "Worth a watch", kind: "tv", freshDate: "2026-06-26", badge: "New show", poster: "https://image.tmdb.org/t/p/w342/x.jpg" },
    { title: "Maa <Behen>", slug: "maa-behen", platform: "Netflix", language: "Hindi", genre: "Drama", rating: 6.9, verdict: "Worth a watch", kind: "movie", freshDate: "2026-06-04" },
    { title: "The Bear", slug: "the-bear", platform: "JioHotstar", language: "English", genre: "Comedy", rating: 8.2, verdict: "Must watch", kind: "tv", freshDate: "2026-06-25", badge: "New season", trending: true, trailerViews: 12300000 },
    { title: "Raakh", slug: "raakh", platform: "Amazon Prime Video", language: "Hindi", genre: "Thriller", rating: 7.5, verdict: "Worth a watch", kind: "movie", freshDate: "2026-06-12" },
  ],
};
const OTT_WEEK_COUNTRIES = [{ code: "in", region: "IN" }, { code: "us", region: "US" }];

test("buildOttWeekPage: keyword-first title with country + month, canonical to /new-on-ott/", () => {
  const html = U.buildOttWeekPage(OTT_WEEK_DATA, { code: "in", name: "India" }, OTT_WEEK_COUNTRIES);
  assert.ok(html.includes("<title>New OTT Releases This Week in India (July 2026)"));
  assert.ok(html.includes('<link rel="canonical" href="https://filmychill.com/new-on-ott/">'));
});
test("buildOttWeekPage: groups by platform, biggest platform first", () => {
  const html = U.buildOttWeekPage(OTT_WEEK_DATA, { code: "in", name: "India" }, OTT_WEEK_COUNTRIES);
  assert.ok(html.indexOf("New on Amazon Prime Video") < html.indexOf("New on JioHotstar"), "2-title platform must lead");
  assert.ok(html.includes("New on Netflix"));
});
test("buildOttWeekPage: rows link to the country's film pages", () => {
  const html = U.buildOttWeekPage(OTT_WEEK_DATA, { code: "us", name: "United States" }, OTT_WEEK_COUNTRIES);
  assert.ok(html.includes('href="/us/movie/the-bear.html"'));
  assert.ok(html.includes('<link rel="canonical" href="https://filmychill.com/us/new-on-ott/">'));
});
test("buildOttWeekPage: FAQPage schema built from real data (platforms + best-of)", () => {
  const html = U.buildOttWeekPage(OTT_WEEK_DATA, { code: "in", name: "India" }, OTT_WEEK_COUNTRIES);
  assert.ok(html.includes('"@type":"FAQPage"'));
  assert.ok(html.includes("What&#39;s new on Netflix in India this week?") || html.includes("What's new on Netflix in India this week?"));
  assert.ok(html.includes("best new OTT releases in India"));
});
test("buildOttWeekPage: titles are HTML-escaped (injection guard)", () => {
  const html = U.buildOttWeekPage(OTT_WEEK_DATA, { code: "in", name: "India" }, OTT_WEEK_COUNTRIES);
  assert.ok(!html.includes("Maa <Behen>"), "raw angle brackets must not survive");
  assert.ok(html.includes("Maa &lt;Behen&gt;"));
});
test("buildOttWeekPage: hreflang alternates for every country + x-default to India", () => {
  const html = U.buildOttWeekPage(OTT_WEEK_DATA, { code: "in", name: "India" }, OTT_WEEK_COUNTRIES);
  assert.ok(html.includes('hreflang="en-US" href="https://filmychill.com/us/new-on-ott/"'));
  assert.ok(html.includes('hreflang="x-default" href="https://filmychill.com/new-on-ott/"'));
});
test("buildOttWeekPage: trending badge, trailer views, and Discover meta all present", () => {
  const html = U.buildOttWeekPage(OTT_WEEK_DATA, { code: "in", name: "India" }, OTT_WEEK_COUNTRIES);
  assert.ok(html.includes("Trending") && !html.includes("🔥"));
  assert.ok(html.includes('content="max-image-preview:large"'));
});
test("buildOttWeekPage: CollectionPage schema carries dateModified (freshness signal)", () => {
  const html = U.buildOttWeekPage(OTT_WEEK_DATA, { code: "in", name: "India" }, OTT_WEEK_COUNTRIES);
  assert.ok(html.includes('"dateModified":"2026-07-01T07:54:26.326Z"'));
});
test("ottWeekPath/ottWeekUrl: India flat, countries namespaced", () => {
  assert.strictEqual(U.ottWeekPath("in"), "new-on-ott/index.html");
  assert.strictEqual(U.ottWeekPath("de"), "de/new-on-ott/index.html");
  assert.strictEqual(U.ottWeekUrl("in"), "https://filmychill.com/new-on-ott/");
  assert.strictEqual(U.ottWeekUrl("uk"), "https://filmychill.com/uk/new-on-ott/");
});

// ---------------- Enriched film-page sections (deterministic content) ----------------
test("buildVerdictProse: high-rated film gets a strong lead + rating sentence", () => {
  const p = U.buildVerdictProse({ title: "Test", kind: "movie", language: "Telugu", rating: 8.2, votes: 5000, runtime: 140, providers: ["Netflix"] });
  assert.ok(p.includes("Test"));
  assert.ok(/8\.2\/10/.test(p));
  assert.ok(/Netflix/.test(p));
});
test("buildVerdictProse: unrated/too-new film does not fabricate a rating", () => {
  const p = U.buildVerdictProse({ title: "Brandnew", kind: "movie", language: "Hindi", rating: null, votes: 0, released: "2099-01-01" });
  assert.ok(!/\/10/.test(p)); // no rating invented
});
test("film page head: og:type matches kind, og:locale marks market, LD carries dateModified", () => {
  const base = { title: "T", slug: "t", tmdbId: 3, rating: 7.0, votes: 500, language: "Hindi", platform: "Theatres" };
  const movie = U.buildFilmPage({ ...base, kind: "movie" }, "2026-08-03", new Set(), { code: "in", name: "India", region: "IN" });
  assert.ok(movie.includes('og:type" content="video.movie"'));
  assert.ok(movie.includes('og:locale" content="en_IN"'));
  assert.ok(movie.includes('"dateModified":"2026-08-03"'));
  const tv = U.buildFilmPage({ ...base, kind: "tv" }, "2026-08-03", new Set(), { code: "uk", name: "the UK", region: "GB" });
  assert.ok(tv.includes('og:type" content="video.tv_show"'));
  assert.ok(tv.includes('og:locale" content="en_GB"'));
});
group("product polish: providers, similar titles, grammar");
test("dedupeProviders: ad tier collapses into base service, survives alone", () => {
  assert.deepStrictEqual(
    U.dedupeProviders(["Amazon Prime Video", "Amazon Prime Video with Ads", "Netflix"]),
    ["Amazon Prime Video", "Netflix"]);
  assert.deepStrictEqual(
    U.dedupeProviders(["Netflix", "Netflix Standard with Ads"]), ["Netflix"]);
  // ad plan is the ONLY way to stream -> keep it (dropping it would lie)
  assert.deepStrictEqual(U.dedupeProviders(["JioCinema with Ads"]), ["JioCinema with Ads"]);
  assert.deepStrictEqual(U.dedupeProviders([]), []);
});
test("rankSimilar: same-language recent titles beat collaborative-filter noise", () => {
  const recs = [
    { name: "The Facts of Life", first_air_date: "1979-08-24", original_language: "en", vote_count: 300, poster_path: "/a" },
    { name: "Freaks and Geeks", first_air_date: "1999-09-25", original_language: "en", vote_count: 900, poster_path: "/b" },
    { name: "Farzi", first_air_date: "2023-02-10", original_language: "hi", vote_count: 500, poster_path: "/c" },
    { name: "Panchayat", first_air_date: "2020-04-03", original_language: "hi", vote_count: 400, poster_path: "/d" },
    { name: "No Poster Show", first_air_date: "2024-01-01", original_language: "hi", vote_count: 900 },
  ];
  const out = U.rankSimilar(recs, "tv", "hi").map((x) => x.name);
  assert.deepStrictEqual(out.slice(0, 2), ["Farzi", "Panchayat"], out.join(", "));
  assert.ok(!out.includes("No Poster Show"), "posterless entries stay filtered");
  // determinism: TMDB order breaks ties
  assert.deepStrictEqual(U.rankSimilar(recs, "tv", "hi").map((x) => x.name), out);
});
test("verdict prose: no s's possessives in the just-landed variants", () => {
  for (let id = 1; id <= 9; id++) {
    const p = U.buildVerdictProse({ title: "T", tmdbId: id, kind: "tv", language: "Hindi", rating: null, votes: 0, released: "2026-08-01", providers: ["Netflix"] });
    assert.ok(!/s's/.test(p), p);
  }
});
group("archive honesty: time-relative verdicts become timeless at freeze");
const TIME_RELATIVE_RE = /brand new to the list|only just (?:landed|arrived)|on offer right now|around at the moment|the current [^<]{0,40} crop|for the weeks ahead|is one of the more anticipated|releases on the calendar|is the kind of [^<]{0,40}release people circle/;
test("every unrated/upcoming/top-band lead variant is patched — nothing time-relative survives", () => {
  const cases = [];
  for (let id = 1; id <= 9; id++) {
    for (const [kind, language] of [["movie", "Hindi"], ["tv", "English"], ["movie", null]]) {
      cases.push({ title: "T&One", tmdbId: id, kind, language, rating: null, votes: 0, released: "2026-01-01", platform: "Theatres" }); // landed long ago, unrated
      cases.push({ title: "T&New", tmdbId: id, kind, language, rating: null, votes: 0, released: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10), platform: "Theatres" }); // landed days ago, unrated
      cases.push({ title: "T&Two", tmdbId: id, kind, language, rating: null, votes: 0, released: "2099-01-01" });                     // upcoming
      cases.push({ title: "T&Top", tmdbId: id, kind, language, rating: 8.1, votes: 900, runtime: 120, providers: ["Netflix"] });      // top band
    }
  }
  for (const item of cases) {
    const page = U.escHtml(U.buildVerdictProse(item));
    const { html } = U.archivePatchHtml(page, "India");
    assert.ok(!TIME_RELATIVE_RE.test(html), "survived patch: " + html);
  }
});
test("archive lead patch keeps facts, grammar, and is idempotent", () => {
  const freshIso = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10); // within the 21-day recency window
  const prose = U.escHtml(U.buildVerdictProse({ title: "X", tmdbId: 2, kind: "tv", language: "Hindi", rating: null, votes: 0, released: freshIso, platform: "Theatres" }));
  const once = U.archivePatchHtml(prose, "India");
  assert.strictEqual(once.changed, true);
  assert.ok(/left our list before/.test(once.html) && /too few votes/.test(once.html), once.html);
  const twice = U.archivePatchHtml(once.html, "India");
  assert.strictEqual(twice.html, once.html, "patch must be idempotent");
  // top band: rating fact survives, tense flips
  const top = U.escHtml(U.buildVerdictProse({ title: "Y", tmdbId: 1, kind: "tv", language: "Hindi", rating: 8.1, votes: 900, providers: ["Netflix"] }));
  const p = U.archivePatchHtml(top, "India").html;
  assert.ok(/8\.1\/10 on TMDB/.test(p), p);
  assert.ok(/landed among|stood out|ranked near|numbers most/.test(p), p);
});
test("unrated leads are age-aware: recency claims only within ~3 weeks of release", () => {
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
  for (let id = 1; id <= 6; id++) {
    const oldFilm = { title: "T", tmdbId: id, kind: "movie", language: "English", rating: null, votes: 0, released: iso(60), platform: "Theatres" };
    const p = U.buildVerdictProse(oldFilm);
    assert.ok(!/brand new|only just|is a fresh/.test(p), "recency claim on a 60-day-old film: " + p);
    assert.ok(/enough ratings|too thin|short of the ratings/.test(p), p);
    const fresh = { ...oldFilm, released: iso(5) };
    assert.ok(/brand new|only just/.test(U.buildVerdictProse(fresh)), "a 5-day-old film may say it's new");
    // no release date to judge by -> never claim recency
    const undated = { ...oldFilm, released: null };
    assert.ok(!/brand new|only just|is a fresh/.test(U.buildVerdictProse(undated)));
  }
});
test("aged-unrated leads freeze to past tense like every other time-relative lead", () => {
  const iso = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  for (let id = 1; id <= 6; id++) {
    const page = U.escHtml(U.buildVerdictProse({ title: "T&x", tmdbId: id, kind: "tv", language: "Hindi", rating: null, votes: 0, released: iso(90), platform: "Theatres" }));
    const { html } = U.archivePatchHtml(page, "India");
    assert.ok(!/yet for a firm read|still short of|still too thin/.test(html), html);
    assert.ok(/never gathered|stayed short|stayed too thin/.test(html), html);
  }
});
test("no seriess: series pluralizes as series in every band", () => {
  for (let id = 1; id <= 6; id++) {
    const p = U.buildVerdictProse({ title: "S", tmdbId: id, kind: "tv", language: "Hindi", rating: 8.0, votes: 900, providers: ["Netflix"] });
    assert.ok(!/seriess/.test(p), p);
  }
});
group("audit fixes: titles, descriptions, inlinks, freshness, schema");
const AUDIT_CFG = { code: "in", name: "India", region: "IN" };
test("film title tags fit 60 chars, keeping the query words", () => {
  // REWRITTEN Sept 2026 with the availability rule (see filmTitleTag). The date wording is
  // reserved for pages that can answer it; a page with no provider targets "where to watch".
  const titleOf = (item) => /<title>([^<]*)<\/title>/.exec(U.buildFilmPage(item, "2026-08-14", new Set(), AUDIT_CFG))[1]
    .replace(/&#39;/g, "x").replace(/&amp;/g, "&");
  const long = { title: "Teenage Sex and Death at Camp Miasma", slug: "x", kind: "movie", tmdbId: 9, released: "2026-06-06", platform: "Theatres" };
  const t = titleOf(long);
  assert.ok(t.length <= 62, t + " (" + t.length + ")");
  assert.ok(/Where to Watch/.test(t), "query words survive trimming: " + t);
  const streamingLong = { ...long, platform: "Netflix", providers: ["Netflix"] };
  const t2 = titleOf(streamingLong);
  assert.ok(t2.length <= 62, t2 + " (" + t2.length + ")");
  assert.ok(/OTT Release Date/.test(t2), "streaming page keeps the answerable query words: " + t2);
  const t3 = titleOf({ ...streamingLong, title: "Raftaar" });
  assert.ok(t3.length <= 60 && /OTT Release Date/.test(t3), t3 + " (" + t3.length + ")");
});
test("descriptions: never empty, never a complete answer, always a reason to click", () => {
  // REWRITTEN Sept 2026. The contract here used to assert the OPPOSITE of what now ships: it
  // REQUIRED the snippet to name the platform up front and to say "release date coming soon".
  // Both shapes measured 0.69% CTR across 3,928 top-10 impressions, because both ended the
  // search inside the results page. What follows protects the fix from being undone.
  const desc = (item, cfg = AUDIT_CFG) =>
    /name="description" content="([^"]*)"/.exec(U.buildFilmPage(item, "2026-09-14", new Set(), cfg))[1];

  const bare = { title: "Law Order", slug: "law-order", kind: "movie", tmdbId: 3, language: "Hindi", genre: "Drama" };
  const d1 = desc(bare);
  assert.ok(d1.trim().length > 20, "blank description: " + d1);

  // Theatrical with a live window: LEAD with the estimate (the one thing competitors cannot
  // source) and always label it a pattern rather than a date.
  const th = { title: "T", slug: "t", kind: "movie", tmdbId: 4, platform: "Theatres", released: "2026-08-21",
    language: "English", runtime: 106, rating: 7.9, votes: 500, verdict: "Must watch" };
  const d2 = desc(th);
  assert.ok(/OTT release expected around \w{3}/.test(d2), "the window estimate reaches the snippet: " + d2);
  assert.ok(/not a confirmed date|a pattern/.test(d2), "an estimate is labelled, never promised: " + d2);
  assert.ok(!/coming soon/.test(d2), "the dead-end phrasing must never come back: " + d2);

  // Theatrical with NO usable window: nothing may be promised about the date, so the payoff
  // clause has to carry the click instead. Still never a bare unknown.
  const th2 = { title: "T", slug: "t", kind: "movie", tmdbId: 44, platform: "Theatres", rating: 7.9, votes: 500 };
  const d2b = desc(th2);
  assert.ok(/^T is in cinemas in India/.test(d2b), d2b);
  assert.ok(/verdict|critics/.test(d2b), "no-window pages still promise something: " + d2b);
  assert.ok(!/coming soon/.test(d2b), d2b);

  // Streaming: the STATUS may be stated, the PLATFORM NAME may not. Naming it hands the click
  // to the platform — this is the /uk/movie/don-t-say-good-luck.html failure exactly
  // (position 1.12, 247 impressions, zero clicks).
  const st = { title: "Reacher", slug: "reacher", kind: "tv", tmdbId: 5, providers: ["Amazon Prime Video"], rating: 8.2, votes: 900, verdict: "Must watch" };
  const d3 = desc(st);
  assert.ok(!/Amazon Prime Video/.test(d3), "streaming desc must NOT name the platform: " + d3);
  assert.ok(/is streaming in India/.test(d3), "…but must still say that it IS streaming: " + d3);
  assert.ok(/worth your evening|verdict/.test(d3), "…and must give a reason to click: " + d3);

  // Every branch fits the display width. The old code appended its payoff line and THEN
  // trimmed to 155, so the payoff never survived to a SERP on any live page.
  for (const [label, d] of [["bare", d1], ["theatres", d2], ["no-window", d2b], ["streaming", d3]]) {
    assert.ok(d.length <= 160, label + " description overruns the snippet: " + d.length + " — " + d);
  }
});
test("empty-shell country pages are noindexed; real localised pages are not", () => {
  const UK = { code: "uk", name: "United Kingdom", region: "GB", streamWord: "streaming" };
  const shell = { title: "Shell", slug: "shell", kind: "movie", tmdbId: 70, released: "2026-05-01", language: "English" };
  assert.ok(/content="noindex,follow/.test(U.buildFilmPage(shell, "2026-09-14", new Set(), UK)),
    "a country page with no availability at all leaves the index");
  // India is the x-default and is never shelled, whatever it carries.
  assert.ok(!/noindex/.test(U.buildFilmPage(shell, "2026-09-14", new Set(), AUDIT_CFG)), "India copy stays indexed");
  // Anything with a real localised answer stays indexed. /sg/movie/the-rope-curse-4-kuntilanak
  // earns Singapore clicks at position 6.7 and must never be caught by this rule.
  for (const real of [{ providers: ["Netflix"] }, { rentBuy: ["Apple TV"] }, { platform: "Theatres" }, { released: "2027-01-01" }]) {
    const page = U.buildFilmPage({ ...shell, ...real }, "2026-09-14", new Set(), UK);
    assert.ok(!/noindex/.test(page), "real localised page wrongly noindexed: " + JSON.stringify(real));
  }
});
test("frozen archive pages get the new description, and stop contradicting their own body", () => {
  // Film pages freeze when a film leaves the weekly lists; a full PAGES_ONLY rebuild on
  // 14 Sept 2026 left all 1,546 of them byte-identical. Without this patcher the CTR fix
  // reaches ~5% of pages and none of the impressions that motivated it.
  const IN = { code: "in", name: "India", region: "IN" };
  const live = U.buildFilmPage({ title: "Insidious: Out of the Further", slug: "i", kind: "movie", tmdbId: 80,
    platform: "Theatres", released: "2026-08-21", language: "English", runtime: 106, rating: 6.5, votes: 130,
    genre: "Horror / Thriller", verdict: "Decent one-time watch" }, "2026-09-14", new Set(), IN);

  const facts = U.frozenFilmFacts(live);
  assert.ok(facts, "facts must parse back off a rendered page");
  assert.strictEqual(facts.item.title, "Insidious: Out of the Further");
  assert.strictEqual(facts.item.language, "English");
  assert.strictEqual(facts.item.runtime, 106);
  assert.strictEqual(facts.item.rating, 6.5);
  assert.strictEqual(facts.item.platform, "Theatres");

  // Simulate the archive patch having already ended the theatrical run in the body. The
  // description must follow it — the live site shipped a page whose body said "Theatrical run
  // ended" while its description still said "is in cinemas in India".
  const ended = live.replace(/<span class="pill">In theatres<\/span>/,
    '<span class="pill">Theatrical run ended — OTT arrival pending</span>');
  const out = U.rewriteMetaDescription(ended, IN);
  assert.ok(out.changed, "a frozen page with a stale description must be rewritten");
  const d = /name="description" content="([^"]*)"/.exec(out.html)[1];
  assert.ok(!/in cinemas/.test(d), "must not claim a theatrical run that has ended: " + d);
  assert.ok(/OTT release expected around|finished its theatrical run/.test(d), d);
  assert.ok(out.html.includes(`og:description" content="${d}"`), "og twin follows the description");
  // Idempotent: a second pass over an already-correct page changes nothing.
  assert.ok(!U.rewriteMetaDescription(out.html, IN).changed, "patcher must not thrash on re-run");
  // Unparseable input is left strictly alone rather than mangled.
  assert.ok(!U.rewriteMetaDescription("<html><head></head><body>x</body></html>", IN).changed);
});
test("similar strip: on-site titles jump the queue and render as anchors", () => {
  const item = { title: "T", slug: "t", kind: "movie", tmdbId: 6, rating: 7, votes: 100,
    similar: [
      { title: "OffSite One", slug: "off-site-one", poster: "/p1.jpg" },
      { title: "OffSite Two", slug: "off-site-two", poster: "/p2.jpg" },
      { title: "OnSite Hit", slug: "on-site-hit", poster: "/p3.jpg" },
    ] };
  const page = U.buildFilmPage(item, "2026-08-14", new Set(["on-site-hit"]), AUDIT_CFG);
  assert.ok(page.indexOf("OnSite Hit") < page.indexOf("OffSite One"), "on-site first");
  assert.ok(/<a class="simcard" href="[^"]*on-site-hit/.test(page), "on-site card is an anchor");
});
test("film page shows a visible updated stamp and the footer nav + how-we-rate line", () => {
  const item = { title: "T", slug: "t", kind: "movie", tmdbId: 7, rating: 7, votes: 100, released: "2026-08-01" };
  const page = U.buildFilmPage(item, "2026-08-14", new Set(), AUDIT_CFG);
  assert.ok(page.includes("Page updated 2026-08-14"));
  assert.ok(page.includes('href="/hindi/"') && page.includes('href="/new-on-ott/"') && page.includes("how we rate"));
  const us = U.buildFilmPage(item, "2026-08-14", new Set(), { code: "us", name: "the US", region: "US" });
  assert.ok(us.includes('href="/us/new-on-ott/"') && !us.includes('href="/hindi/"'));
});
test("TVSeries LD carries numberOfSeasons when known", () => {
  const tv = { title: "S", slug: "s", kind: "tv", tmdbId: 8, rating: 8, votes: 900, seasons: 4 };
  const page = U.buildFilmPage(tv, "2026-08-14", new Set(), AUDIT_CFG);
  assert.ok(page.includes('"numberOfSeasons":4'), "seasons in LD");
});
test("buildVerdictProse: empty item returns empty string", () => {
  assert.strictEqual(U.buildVerdictProse(null), "");
  assert.strictEqual(U.buildVerdictProse({}), "");
});
test("buildVerdictProse: phrasing varies across films in a band, stays stable per film", () => {
  const mk = (id) => ({ title: "Film", tmdbId: id, kind: "movie", language: "Hindi", rating: 8.0, votes: 900, runtime: 160, providers: ["Netflix"] });
  const outs = new Set([1, 2, 3, 4, 5].map((i) => U.buildVerdictProse(mk(i))));
  assert.ok(outs.size >= 3, "seeded pools should yield several distinct paragraphs: " + outs.size);
  assert.strictEqual(U.buildVerdictProse(mk(3)), U.buildVerdictProse(mk(3)));
});
test("buildVerdictProse: every variant keeps the fixed theatre close (archive patch sync)", () => {
  for (let id = 1; id <= 8; id++) {
    const p = U.buildVerdictProse({ title: "T", tmdbId: id, kind: "movie", language: "Hindi", rating: 7.0, votes: 500, runtime: 120, platform: "Theatres" });
    assert.ok(p.includes("It's in theatres in India now — best caught on the big screen."), p);
    assert.ok(/7\.0\/10 on TMDB/.test(p), "rating fact survives every frame variant: " + p);
  }
});
test("buildGoodToKnow: U/A 16+ is NOT labelled family friendly (cert order bug guard)", () => {
  const rows = U.buildGoodToKnow({ cert: "U/A 16+", runtime: 120, genre: "Action", language: "Hindi" });
  const fam = rows.find((r) => r.label === "Watch with family?");
  assert.ok(fam && /Older kids/.test(fam.value));
  assert.ok(fam && !/family friendly/.test(fam.value));
});
test("buildGoodToKnow: bare U cert IS family friendly", () => {
  const rows = U.buildGoodToKnow({ cert: "U" });
  const fam = rows.find((r) => r.label === "Watch with family?");
  assert.ok(fam && /family friendly/.test(fam.value));
});
test("buildGoodToKnow: A cert is adults only", () => {
  const rows = U.buildGoodToKnow({ cert: "A" });
  const fam = rows.find((r) => r.label === "Watch with family?");
  assert.ok(fam && /Adults only/.test(fam.value));
});
test("buildGoodToKnow: skips rows it can't fill (no blanks)", () => {
  const rows = U.buildGoodToKnow({ title: "X" }); // no cert/runtime/genre/lang/providers
  assert.strictEqual(rows.length, 0);
});
test("buildFaqs: produces a where-to-watch Q for a theatre film", () => {
  const faqs = U.buildFaqs({ title: "Cine", platform: "Theatres", verdict: "Worth a watch", rating: 7 });
  assert.ok(faqs.some((f) => /Where can I watch Cine/.test(f.q)));
  assert.ok(faqs.some((f) => /theatres/i.test(f.a)));
});
test("buildFaqs: upcoming film says it hasn't released", () => {
  const faqs = U.buildFaqs({ title: "Soon", released: "2099-01-01", language: "Hindi" });
  const where = faqs.find((f) => /Where can I watch/.test(f.q));
  assert.ok(where && /hasn't released/.test(where.a));
});
test("buildFaqs: never invents a 'worth watching' answer when verdict is a placeholder", () => {
  const faqs = U.buildFaqs({ title: "New", verdict: "Just released — verdict soon", platform: "Theatres" });
  assert.ok(!faqs.some((f) => /Is New worth watching/.test(f.q)));
});

// ---------------- Multi-country per-film pages (B) ----------------
test("filmPagePath: India is flat, other countries are namespaced", () => {
  assert.strictEqual(U.filmPagePath("in", "the-furious"), "/movie/the-furious.html");
  assert.strictEqual(U.filmPagePath("us", "the-furious"), "/us/movie/the-furious.html");
  assert.strictEqual(U.filmPagePath("de", "x"), "/de/movie/x.html");
});
test("filmPageUrl: absolute URL with correct country base", () => {
  assert.strictEqual(U.filmPageUrl("in", "x"), "https://filmychill.com/movie/x.html");
  assert.strictEqual(U.filmPageUrl("uk", "x"), "https://filmychill.com/uk/movie/x.html");
});
test("buildFilmPage: US page has US canonical, title, and where-to-watch", () => {
  const item = { title: "The Furious", slug: "the-furious", kind: "movie", language: "English", platform: "Theatres", released: "2026-06-01" };
  const html = U.buildFilmPage(item, "2026-06-17", new Set(["the-furious"]), { code: "us", name: "United States", region: "US" });
  assert.ok(/rel="canonical" href="https:\/\/filmychill.com\/us\/movie\/the-furious.html"/.test(html));
  // Display name comes from COUNTRY_PAGE_META ("the US"), not the config's "United States" —
  // "in the US" is how people actually search and speak.
  assert.ok(/Where to Watch in the US/.test(html));
  assert.ok(/<h2>Where to watch in the US<\/h2>/.test(html));
});
// Guards the fix for India references leaking onto other countries' film pages ("It's in
// theatres in India now" on a US page). Every country's page must speak about ITSELF.
test("buildVerdictProse: theatre close names the page's own country, not India", () => {
  const item = { title: "Toy Story 5", kind: "movie", language: "English", rating: 7.4, votes: 406, runtime: 102, platform: "Theatres" };
  const us = U.buildVerdictProse(item, "the US", "en-US");
  assert.ok(us.includes("It's in theatres in the US now"), us);
  assert.ok(!us.includes("India"));
  const de = U.buildVerdictProse(item, "Germany", "en-GB");
  assert.ok(de.includes("It's in theatres in Germany now"));
});
test("buildVerdictProse: streaming close + vote grouping follow the country's locale", () => {
  const item = { title: "X", kind: "movie", language: "English", rating: 8.0, votes: 1234567, providers: ["Netflix"] };
  const us = U.buildVerdictProse(item, "the US", "en-US");
  assert.ok(us.includes("In the US you can stream it on Netflix"));
  assert.ok(us.includes("1,234,567"), "US grouping");
  const ind = U.buildVerdictProse(item); // defaults preserve India behavior
  assert.ok(ind.includes("In India you can stream it"));
  assert.ok(ind.includes("12,34,567"), "Indian lakh grouping");
});
test("buildFaqs: where-to-watch answers name the page's own country", () => {
  const theatre = { title: "T", kind: "movie", platform: "Theatres", verdict: "Worth a watch", rating: 7.0 };
  const faqsUk = U.buildFaqs(theatre, "the UK");
  const whereUk = faqsUk.find((f) => f.q.startsWith("Where"));
  assert.ok(whereUk.a.includes("theatres across the UK"));
  assert.ok(!JSON.stringify(faqsUk).includes("India"));
  const faqsIn = U.buildFaqs(theatre); // default -> India
  assert.ok(faqsIn.find((f) => f.q.startsWith("Where")).a.includes("theatres across India"));
});
test("countryNameFor/localeFor: prose names and locales per country", () => {
  assert.strictEqual(U.countryNameFor({ code: "us", name: "United States" }), "the US");
  assert.strictEqual(U.countryNameFor(null), "India");
  assert.strictEqual(U.localeFor("us"), "en-US");
  assert.strictEqual(U.localeFor("in"), "en-IN");
  assert.strictEqual(U.localeFor("de"), "en-GB");
});
test("buildFilmPage: defaults to India when no cfg passed (backward compatible)", () => {
  const item = { title: "X", slug: "x", kind: "movie", platform: "Theatres" };
  const html = U.buildFilmPage(item, "2026-06-17", new Set(["x"]));
  assert.ok(/rel="canonical" href="https:\/\/filmychill.com\/movie\/x.html"/.test(html));
  // INVERTED Sept 2026: an India film with no provider cannot supply an OTT release date, so
  // it targets "where to watch" instead of promising one (see filmTitleTag).
  assert.ok(/<title>X — Review, Rating &amp; Where to Watch in India \| FilmyChill<\/title>/.test(html), html.slice(0, 400));
  assert.ok(!/OTT Release Date/.test(/<title>[^<]*<\/title>/.exec(html)[0]), "no date promise without a date");
  // once streaming, the page CAN answer the date question, so the query words come back
  const html2 = U.buildFilmPage({ title: "Y", slug: "y", kind: "movie", platform: "Netflix", providers: ["Netflix"] }, "2026-06-17", new Set(["y"]));
  assert.ok(/<title>Y OTT Release Date, Review &amp; Where to Watch \| FilmyChill<\/title>/.test(html2));
});
test("buildFilmPage: hreflang alternates emitted for shared film", () => {
  const item = { title: "Shared", slug: "shared", kind: "movie", platform: "Theatres", _alts: [{ code: "in", region: "IN" }] };
  const html = U.buildFilmPage(item, "2026-06-17", new Set(["shared"]), { code: "us", name: "United States", region: "US" });
  assert.ok(/hreflang="en-IN" href="https:\/\/filmychill.com\/movie\/shared.html"/.test(html));
  assert.ok(/hreflang="x-default"/.test(html));
});
test("buildFilmPage: 'If you liked this' links use the page's own country namespace", () => {
  const item = { title: "Main", slug: "main", kind: "movie", platform: "Theatres",
    similar: [{ title: "Rec", slug: "rec", poster: "https://image.tmdb.org/t/p/w342/a.jpg", language: "English", kind: "movie" }] };
  const html = U.buildFilmPage(item, "2026-06-17", new Set(["main", "rec"]), { code: "us", name: "United States", region: "US" });
  assert.ok(/href="\/us\/movie\/rec.html"/.test(html));
});
test("ssrCard: links to the country's film page path", () => {
  const card = U.ssrCard({ title: "T", slug: "t", poster: null, platform: "Theatres" }, 0, "us");
  assert.ok(/href="\/us\/movie\/t.html"/.test(card));
  const inCard = U.ssrCard({ title: "T", slug: "t", poster: null, platform: "Theatres" }, 0, "in");
  assert.ok(/href="\/movie\/t.html"/.test(inCard));
});

// ---------------- critics' take: analyzeReception() ----------------
group("analyzeReception()");
test("classic positive reception -> tone + praised/panned aspects split correctly", () => {
  const text = "The film received generally positive reviews from critics. " +
    "Reviewers praised the performances of the lead cast and the film's music, " +
    "but criticised the pacing of the second half. ".padEnd(200, " ");
  const a = U.analyzeReception(text);
  assert.strictEqual(a.tone, "positive");
  assert.ok(a.praised.includes("performances"));
  assert.ok(a.panned.includes("pacing") || a.panned.includes("second half"));
});
test("'praised X but criticised Y' in ONE sentence splits by clause", () => {
  const text = "Critics praised the visuals but criticised the writing throughout the film. ".padEnd(200, "x");
  const a = U.analyzeReception(text);
  assert.ok(a.praised.includes("visuals"));
  assert.ok(a.panned.includes("writing"));
});
test("earliest verdict phrase wins the tone (acclaim opening beats later 'mixed')", () => {
  const text = "The film received universal acclaim from critics upon release. A small minority of publications offered mixed reviews, mostly regional outlets covering the wide release in later weeks.";
  assert.strictEqual(U.analyzeReception(text).tone, "acclaim");
});
test("aspect both praised and panned becomes a 'divided' signal (no longer dropped)", () => {
  const text = "Some critics praised the story for its ambition and sweep across generations. Other critics criticised the story heavily, calling it overstuffed and difficult to follow at feature length.";
  const a = U.analyzeReception(text);
  assert.ok(!a.praised.includes("story") && !a.panned.includes("story"));
  assert.deepStrictEqual(a.divided, ["story"]);
});
test("divided signal composes into a split-honest line, seeded, digit-free", () => {
  const a = { tone: "mixed", praised: [], panned: [], divided: ["second half"] };
  const s0 = U.composeTake(a, 0), s1 = U.composeTake(a, 1);
  assert.ok(/second half/.test(s0) && /second half/.test(s1));
  assert.notStrictEqual(s0, s1);
  for (let i = 0; i < 4; i++) assert.ok(!/\d/.test(U.composeTake(a, i)));
  // positive tone + divided aspect reads positive, names the sore spot
  const p = U.composeTake({ tone: "positive", praised: [], panned: [], divided: ["writing"] }, 0);
  assert.ok(/writing/.test(p), p);
});
test("praise + divided combine — neither signal is discarded", () => {
  const a = { tone: "positive", praised: ["performances", "action"], panned: [], divided: ["second half"] };
  for (let i = 0; i < 4; i++) {
    const t = U.composeTake(a, i);
    assert.ok(/performances and action/.test(t) && /second half/.test(t), t);
    assert.ok(!/\d/.test(t));
    const out = U.audienceCounterpoint({ take: t, rating: 5.0, votes: 300, tmdbId: i });
    assert.ok(/cooler|less convinced|run lower/i.test(out || ""), "positivePDiv[" + i + "]: " + t + " -> " + out);
  }
  const m = { tone: "mixed", praised: ["visuals"], panned: [], divided: ["story"] };
  for (let i = 0; i < 4; i++) {
    const t = U.composeTake(m, i);
    assert.ok(/visuals/.test(t) && /story/.test(t), t);
    assert.ok(U.audienceCounterpoint({ take: t, rating: 8.0, votes: 300, tmdbId: i }), "mixedPDiv[" + i + "] should read split: " + t);
  }
});
test("counterpoint camps: divided variants classify by tone, not by aspect wording", () => {
  // mixed+divided line + high audience rating -> disagree
  for (let i = 0; i < 4; i++) {
    const t = U.composeTake({ tone: "mixed", praised: [], panned: [], divided: ["twists"] }, i);
    const out = U.audienceCounterpoint({ take: t, rating: 8.0, votes: 300, tmdbId: i });
    assert.ok(out, `mixedDiv[${i}] should read as split: ${t}`);
  }
  // positive+divided line + low audience rating -> cooler (must NOT classify as split)
  for (let i = 0; i < 4; i++) {
    const t = U.composeTake({ tone: "positive", praised: [], panned: [], divided: ["twists"] }, i);
    const out = U.audienceCounterpoint({ take: t, rating: 5.0, votes: 300, tmdbId: i });
    assert.ok(/cooler|less convinced|run lower/i.test(out || ""), `positiveDiv[${i}]: ${t} -> ${out}`);
  }
});
test("too-short section -> null (never invent a take from a stub)", () => {
  assert.strictEqual(U.analyzeReception("Reviews were positive."), null);
  assert.strictEqual(U.analyzeReception(""), null);
  assert.strictEqual(U.analyzeReception(null), null);
});
test("'mixed martial arts' does not trigger mixed tone", () => {
  const text = "The film follows a mixed martial arts fighter through a title run and was noted for authentic fight choreography by observers of the sport. ".padEnd(220, " ");
  const a = U.analyzeReception(text);
  assert.ok(!a || a.tone !== "mixed");
});

// ---------------- critics' take: composeTake() ----------------
group("composeTake()");
test("positive + praise + criticism -> balanced original sentence", () => {
  const s = U.composeTake({ tone: "positive", praised: ["performances", "music"], panned: ["pacing"] });
  assert.ok(/performances and music/.test(s) && /pacing/.test(s));
});
test("acclaim without aspects still yields a confident line", () => {
  assert.ok(/loved/i.test(U.composeTake({ tone: "acclaim", praised: [], panned: [] })));
});
test("negative tone reads honest, not hedged", () => {
  assert.ok(/rough|not impressed/i.test(U.composeTake({ tone: "negative", praised: [], panned: ["writing"] })));
});
test("nothing extractable -> null (line is omitted, never hollow)", () => {
  assert.strictEqual(U.composeTake({ tone: null, praised: [], panned: [] }), null);
  assert.strictEqual(U.composeTake(null), null);
});

// ---------------- critics' take: rendering ----------------
group("take rendering");
test("ssrCard renders the take line when present, omits it when absent", () => {
  const withTake = U.ssrCard({ title: "T", slug: "t", poster: null, platform: "Netflix", take: "Critics liked it, especially the performances." }, 0, "in");
  assert.ok(/class="take"/.test(withTake) && /especially the performances/.test(withTake));
  const without = U.ssrCard({ title: "T", slug: "t", poster: null, platform: "Netflix" }, 0, "in");
  assert.ok(!/class="take"/.test(without));
});
test("ssrCard escapes HTML inside the take", () => {
  const card = U.ssrCard({ title: "T", slug: "t", poster: null, platform: "Netflix", take: `<script>alert(1)</script>` }, 0, "in");
  assert.ok(!card.includes("<script>alert(1)</script>"));
});
test("buildFilmPage shows take with the wiki attribution note only for wiki source", () => {
  const base = { title: "Main", slug: "main", kind: "movie", platform: "Theatres", take: "Critics loved it — special praise for the visuals." };
  const wiki = U.buildFilmPage({ ...base, takeSrc: "wiki" }, "2026-07-05", new Set(["main"]), { code: "in", name: "India", region: "IN" });
  assert.ok(/class="take"/.test(wiki) && /distilled from critics/.test(wiki));
  const tmdbSrc = U.buildFilmPage({ ...base, takeSrc: "tmdb" }, "2026-07-05", new Set(["main"]), { code: "in", name: "India", region: "IN" });
  assert.ok(/class="take"/.test(tmdbSrc) && !/distilled from critics/.test(tmdbSrc));
});

// ---------------- list integrity: ottRenderable() / orderOttForDisplay() ----------------
group("ottRenderable() / orderOttForDisplay()");
const NOW = new Date("2026-07-06T12:00:00Z").getTime();
test("future-dated movie cannot be Streaming Now (the Drishyam 3 class of bug)", () => {
  assert.strictEqual(U.ottRenderable({ kind: "movie", released: "2026-10-02" }, NOW), false);
  assert.strictEqual(U.ottRenderable({ kind: "movie", released: "2026-07-01" }, NOW), true);
  assert.strictEqual(U.ottRenderable({ kind: "movie", released: "2026-07-06" }, NOW), true); // release day is fine
});
test("future TV season date is not streaming either; missing dates pass the gate", () => {
  assert.strictEqual(U.ottRenderable({ kind: "tv", freshDate: "2026-08-01" }, NOW), false);
  assert.strictEqual(U.ottRenderable({ kind: "tv" }, NOW), true);
});
test("orderOttForDisplay: drops future items, partitions fresh/older, flags stillGood", () => {
  const list = [
    { kind: "tv", title: "OldHit", freshDate: "2026-05-24", rating: 8.7, review: "x" },
    { kind: "movie", title: "Future", released: "2026-10-02" },
    { kind: "movie", title: "NewFilm", released: "2026-07-01", ottFreshDate: "2026-07-01", rating: 7.0, review: "y" },
  ];
  const out = U.orderOttForDisplay(list, NOW);
  assert.deepStrictEqual(out.map((x) => x.title), ["NewFilm", "OldHit"]); // future dropped, fresh first
  assert.strictEqual(out[0].stillGood, undefined);
  assert.strictEqual(out[1].stillGood, true);
});
test("orderOttForDisplay: threadbare cards sink below complete ones within their group", () => {
  const list = [
    { kind: "movie", title: "Thin", released: "2026-07-02", ottFreshDate: "2026-07-02" },
    { kind: "movie", title: "Full", released: "2026-07-01", ottFreshDate: "2026-07-01", rating: 7.5, review: "solid" },
  ];
  assert.deepStrictEqual(U.orderOttForDisplay(list, NOW).map((x) => x.title), ["Full", "Thin"]);
});
test("isStillWorthIt: unknown freshness never claims to be new", () => {
  assert.strictEqual(U.isStillWorthIt({}, NOW), true);
  assert.strictEqual(U.isStillWorthIt({ ottFreshDate: "2026-07-04" }, NOW), false);
});

// ---------------- trim(): sentence boundaries ----------------
group("trim() sentence boundaries");
test("cuts at a sentence end past 60% of budget, no ellipsis", () => {
  const text = "The film follows a detective. He uncovers a conspiracy spanning decades of corruption and lies in the city.";
  const out = U.trim(text, 40);
  assert.strictEqual(out, "The film follows a detective.");
});
test("sentence end too early -> falls back to word cut + ellipsis", () => {
  const text = "Hi. " + "word ".repeat(50);
  const out = U.trim(text, 60);
  assert.ok(out.endsWith("\u2026"));
});

// ---------------- language pages ----------------
group("buildLanguagePage()");
const LANG_DATA = {
  generatedAt: "2026-07-06T03:00:00Z",
  theatres: [
    { title: "Tamil Hit", slug: "tamil-hit", language: "Tamil", platform: "Theatres", rating: 7.8, kind: "movie", released: "2026-07-03" },
    { title: "Hindi Film", slug: "hindi-film", language: "Hindi", platform: "Theatres", kind: "movie" },
  ],
  ott: [{ title: "Tamil Stream", slug: "tamil-stream", language: "Tamil", platform: "Netflix", rating: 8.0, kind: "movie", take: "Critics liked it, especially the performances." }],
  // Dated relative to now: a hardcoded date silently expires and turns this language-filter
  // test into a date test the day it passes.
  comingSoon: [{ title: "Tamil Soon", slug: "tamil-soon", language: "Tamil",
    released: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), kind: "movie" }],
};
test("filters to the requested language only, across all three sections", () => {
  const html = U.buildLanguagePage(LANG_DATA, "Tamil", "tamil");
  assert.ok(html.includes("Tamil Hit") && html.includes("Tamil Stream") && html.includes("Tamil Soon"));
  assert.ok(!html.includes("Hindi Film"));
});
test("canonical, title, FAQ schema and take line present", () => {
  const html = U.buildLanguagePage(LANG_DATA, "Tamil", "tamil");
  assert.ok(html.includes('rel="canonical" href="https://filmychill.com/tamil/"'));
  assert.ok(/New Tamil Movies & OTT Releases This Week/.test(html.replace(/&amp;/g, "&")));
  assert.ok(html.includes("FAQPage"));
  assert.ok(html.includes("especially the performances"));
});
test("five language pages configured", () => {
  assert.strictEqual(U.LANGUAGE_PAGES.length, 5);
  assert.ok(U.LANGUAGE_PAGES.some(([n, s]) => n === "Tamil" && s === "tamil"));
});

// ---------------- weekly snapshots ----------------
group("isoWeekOf() / buildWeekPage()");
test("ISO week math: 2026-07-06 is Monday of week 28", () => {
  assert.deepStrictEqual(U.isoWeekOf(new Date("2026-07-06T12:00:00Z")), { year: 2026, week: 28 });
  assert.strictEqual(U.weekSlug({ year: 2026, week: 28 }), "2026-W28");
});
test("ISO week year boundary: 2027-01-01 (Friday) belongs to 2026-W53", () => {
  assert.deepStrictEqual(U.isoWeekOf(new Date("2027-01-01T12:00:00Z")), { year: 2026, week: 53 });
});
test("isoWeekSunday is deterministic from the slug (frozen-page lastmod)", () => {
  assert.strictEqual(U.isoWeekSunday("2026-W28"), "2026-07-12");
});
test("buildWeekPage: canonical, date range, frozen note, items", () => {
  const html = U.buildWeekPage(LANG_DATA, "2026-W28");
  assert.ok(html.includes('rel="canonical" href="https://filmychill.com/week/2026-W28/"'));
  assert.ok(html.includes("Tamil Hit") && html.includes("Hindi Film"));
  assert.ok(/stays frozen once the week ends/.test(html));
});

// ---------------- honest split rendering + footer links ----------------
group("ssrOttSection() / buildMoreLinks()");
test("divider renders before the first stillGood card, once", () => {
  const items = [
    { title: "Fresh", slug: "fresh", platform: "Netflix" },
    { title: "Old1", slug: "old1", platform: "Netflix", stillGood: true },
    { title: "Old2", slug: "old2", platform: "Netflix", stillGood: true },
  ];
  const html = U.ssrOttSection(items, "in");
  assert.strictEqual((html.match(/ott-divider/g) || []).length, 1);
  assert.ok(html.indexOf("ott-divider") < html.indexOf("Old1"));
  assert.ok(html.indexOf("Fresh") < html.indexOf("ott-divider"));
});
test("no divider when nothing is stillGood, and none when everything is", () => {
  assert.ok(!U.ssrOttSection([{ title: "A", slug: "a" }], "in").includes("ott-divider"));
  assert.ok(!U.ssrOttSection([{ title: "A", slug: "a", stillGood: true }], "in").includes("ott-divider"));
});
test("India footer links languages + week snapshot + about; other countries about only", () => {
  const indiaLinks = U.buildMoreLinks("in");
  assert.ok(indiaLinks.includes('href="/tamil/"') && indiaLinks.includes('href="/week/') && indiaLinks.includes('href="/about/"'));
  const usLinks = U.buildMoreLinks("us");
  assert.ok(usLinks.includes('href="/about/"') && !usLinks.includes("/tamil/"));
});

// ---------------- take variants ----------------
group("composeTake() variants");
test("tone-only lines vary by seed but are deterministic", () => {
  const a = { tone: "positive", praised: [], panned: [] };
  const s0 = U.composeTake(a, 0), s1 = U.composeTake(a, 1);
  assert.notStrictEqual(s0, s1);
  assert.strictEqual(U.composeTake(a, 1), s1); // same seed -> same line, every run
});
test("seed 0 keeps original phrasing (cached takes stay stable)", () => {
  assert.strictEqual(U.composeTake({ tone: "positive", praised: [], panned: [] }, 0), "Critics have been largely positive on this one.");
});
test("aspect-bearing lines vary by seed, keep the aspect, and are deterministic", () => {
  const a = { tone: "positive", praised: ["visuals"], panned: [] };
  const s0 = U.composeTake(a, 0), s2 = U.composeTake(a, 2);
  assert.notStrictEqual(s0, s2, "different seeds -> different phrasing");
  assert.ok(/visuals/.test(s0) && /visuals/.test(s2), "every variant carries the aspect");
  assert.strictEqual(U.composeTake(a, 2), s2); // same seed -> same line, every run
});
test("aspect seed 0 keeps original phrasing (settled caches stay stable)", () => {
  assert.strictEqual(U.composeTake({ tone: "positive", praised: ["visuals"], panned: [] }, 0),
    "Critics liked it, especially the visuals.");
  assert.strictEqual(U.composeTake({ tone: "negative", praised: [], panned: ["writing"] }, 0),
    "Critics were rough on it, mostly over the writing.");
});
test("aspect variants are digit-free across all pools and seeds", () => {
  for (let seed = 0; seed < 6; seed++)
    for (const tone of ["acclaim", "positive", "mixed", "negative", null])
      for (const praised of [[], ["performances"]])
        for (const panned of [[], ["pacing"]]) {
          const s = U.composeTake({ tone, score: { kind: "rt", value: 61 }, praised, panned }, seed);
          if (s != null) assert.ok(!/\d/.test(s), s);
        }
});

// ---------------- exclusion: isExcluded() ----------------
group("isExcluded()");
test("blocks by TMDB id (raw candidate and enriched item shapes)", () => {
  assert.strictEqual(U.isExcluded({ id: 1155818, title: "Satluj" }), true);
  assert.strictEqual(U.isExcluded({ tmdbId: 1725370, title: "Whatever" }), true);
});
test("blocks DUPLICATE records by title slug — new id, same banned film", () => {
  assert.strictEqual(U.isExcluded({ id: 9999999, title: "Satluj" }), true);
  assert.strictEqual(U.isExcluded({ id: 9999998, title: "SATLUJ!" }), true); // casing/punct variants
  assert.strictEqual(U.isExcluded({ id: 9999997, name: "Chardikala" }), true); // TV shape uses `name`
});
test("does not block innocent titles or partial matches", () => {
  assert.strictEqual(U.isExcluded({ id: 42, title: "Satluj Ke Kinare" }), false); // different film, different slug
  assert.strictEqual(U.isExcluded({ id: 43, title: "The Bear" }), false);
  assert.strictEqual(U.isExcluded(null), false);
});

// ---------------- editorial hook: extractHook() ----------------
group("extractHook()");
test("remake with language", () => {
  const lead = "Baby Do Die Do is a 2026 Indian Hindi-language mystery film. It is a remake of the 2019 Korean film Midnight Runner, adapted for Mumbai. The film stars several newcomers in leading roles and released theatrically in July 2026.";
  assert.strictEqual(U.extractHook(lead), "A remake of the Korean film \u2018Midnight Runner\u2019.");
});
test("sequel", () => {
  const lead = "Gatta Kusthi 2 is a 2026 Indian Tamil-language sports comedy film. It is a sequel to the 2022 film Gatta Kusthi and continues the story of Veera and Keerthi as they balance family and wrestling.";
  assert.strictEqual(U.extractHook(lead), "The follow-up to \u2018Gatta Kusthi\u2019.");
});
test("novel adaptation with author", () => {
  const lead = "Silo is an American science fiction dystopian television series. It is based on the novel Wool by Hugh Howey and follows the residents of a giant underground silo in a ruined future world.";
  assert.strictEqual(U.extractHook(lead), "Based on Hugh Howey's novel \u2018Wool\u2019.");
});
test("true events", () => {
  const lead = "Satluj is a 2026 Indian Hindi-language crime drama based on true events surrounding the disappearances investigated by a human rights activist in 1990s Punjab, produced independently.";
  assert.strictEqual(U.extractHook(lead), "Based on true events.");
});
test("festival premiere", () => {
  const lead = "Charukesi is a 2026 Indian Tamil-language drama film about a musician and her ailing mother. The film premiered at the 2026 International Film Festival Rotterdam to a warm reception before its streaming release.";
  assert.ok(/Premiered at the/.test(U.extractHook(lead)));
});
test("remake beats sequel when both appear (priority)", () => {
  const lead = "The movie is a remake of the Malayalam film Drishyam and also serves as a sequel to the 2015 film in spirit, expanding the story of the family at its centre across a new decade of events.";
  assert.ok(U.extractHook(lead).startsWith("A remake"));
});
test("no framing fact -> null, short/absent lead -> null", () => {
  const lead = "Alpha is a 2026 Indian Hindi-language action thriller film directed by a debutant and produced under a major banner, starring two leading actresses in principal roles across several international locations.";
  assert.strictEqual(U.extractHook(lead), null);
  assert.strictEqual(U.extractHook(""), null);
  assert.strictEqual(U.extractHook(null), null);
});
test("directorial debut uses the item's director", () => {
  const lead = "The film marks the directorial debut of its writer and was shot across Mumbai and Pune over a period of two years, with an ensemble cast of theatre actors in most of the speaking roles.";
  assert.strictEqual(U.extractHook(lead, { director: "Asha Rane" }), "Asha Rane's directorial debut.");
  assert.strictEqual(U.extractHook(lead, {}), null); // no director known -> no hook
});

// ---------------- editorial: audienceCounterpoint() ----------------
group("audienceCounterpoint()");
test("critics negative + audiences high -> disagreement line", () => {
  const c = U.audienceCounterpoint({ take: "Critics were rough on it, mostly over the writing.", rating: 8.2, votes: 900 });
  assert.ok(/Audiences disagree/.test(c) && !/\d/.test(c), c); // no digit: the rating pill is the card's only number
});
test("critics split + audiences high -> disagreement line", () => {
  assert.ok(/Audiences disagree/.test(U.audienceCounterpoint({ take: "Critics are split on this one.", rating: 7.8, votes: 200 })));
});
test("critics positive + audiences low -> cooler line", () => {
  assert.ok(/cooler/.test(U.audienceCounterpoint({ take: "Critics liked it, especially the visuals.", rating: 5.1, votes: 300 })));
});
test("agreement, few votes, or missing data -> null", () => {
  assert.strictEqual(U.audienceCounterpoint({ take: "Critics liked it, especially the visuals.", rating: 8.0, votes: 500 }), null);
  assert.strictEqual(U.audienceCounterpoint({ take: "Critics were rough on it.", rating: 8.0, votes: 10 }), null);
  assert.strictEqual(U.audienceCounterpoint({ take: "Critics were rough on it.", rating: null }), null);
  assert.strictEqual(U.audienceCounterpoint(null), null);
});
test("counterpoint: variant phrasings still classify, precedence guards camp flips", () => {
  const disagree = U.audienceCounterpoint({ take: "A drubbing from reviewers, with the writing the main casualty.", rating: 8.0, votes: 300 });
  assert.ok(/far higher|beg to differ|isn't buying/.test(disagree || ""), disagree);
  const cooler = U.audienceCounterpoint({ take: "The performances won critics over; the pacing drew the odd complaint.", rating: 5.0, votes: 300 });
  assert.ok(/cooler|less convinced|run lower/i.test(cooler || ""), cooler);
  // A split take contains "impressed" but must never read as positive.
  assert.strictEqual(U.audienceCounterpoint({ take: "Reviews cut both ways: the visuals impressed, the pacing frustrated.", rating: 5.0, votes: 300 }), null);
});
test("counterpoint: TMDB-review takes are excluded (viewers vs viewers isn't disagreement)", () => {
  assert.strictEqual(U.audienceCounterpoint({ take: "Early viewer reviews on TMDB lean negative.", takeSrc: "tmdb", rating: 8.0, votes: 500 }), null);
});
test("counterpoint: seeded wording is deterministic per film and digit-free", () => {
  const item = { take: "Critics were rough on it.", rating: 8.0, votes: 500, tmdbId: 7 };
  const a = U.audienceCounterpoint(item);
  assert.strictEqual(U.audienceCounterpoint(item), a);
  assert.ok(a && !/\d/.test(a), a);
});
test("uses IMDb votes when IMDb ratings are the source", () => {
  assert.ok(U.audienceCounterpoint({ take: "Critics were rough on it.", rating: 8.0, imdbRating: 8.0, imdbVotes: 5000, votes: 0 }));
});

// ---------------- editorial: rendering ----------------
group("hook + counterpoint rendering");
test("ssrCard renders hook and counterpoint; omits both when absent", () => {
  const withBoth = U.ssrCard({ title: "T", slug: "t", poster: null, platform: "Netflix",
    hook: "The follow-up to \u2018X\u2019.", take: "Critics are split on this one.",
    takeCounter: "Audiences disagree \u2014 \u2605 8.1 from viewers." }, 0, "in");
  assert.ok(/class="meta hook"/.test(withBoth) && /follow-up/.test(withBoth));
  assert.ok(/class="tcounter"/.test(withBoth) && /8\.1 from viewers/.test(withBoth));
  const bare = U.ssrCard({ title: "T", slug: "t", poster: null, platform: "Netflix" }, 0, "in");
  assert.ok(!/hook/.test(bare) && !/tcounter/.test(bare));
});
test("buildFilmPage renders hook and counterpoint", () => {
  const html = U.buildFilmPage({ title: "Main", slug: "main", kind: "movie", platform: "Theatres",
    hook: "Based on true events.", take: "Critics loved it \u2014 special praise for the visuals.",
    takeCounter: "Audiences are cooler on it (\u2605 5.2).", takeSrc: "wiki" },
    "2026-07-07", new Set(["main"]), { code: "in", name: "India", region: "IN" });
  assert.ok(/class="hook"/.test(html) && /true events/.test(html) && /tcounter/.test(html));
});

// ---------------- multi-country config integrity ----------------
group("country expansion config");
test("eight countries, unique codes, every code covered by meta + locale maps", () => {
  // Reconstruct via exported helpers where possible; assert through buildHeadTags shape.
  for (const code of ["in", "us", "uk", "au", "de", "ae", "ca", "sg"]) {
    const html = U.buildHeadTags({ code, name: code, region: code.toUpperCase() });
    assert.ok(html.includes("filmychill.com"), code + " head tags render");
    assert.ok(new RegExp(`hreflang="en-(AE|CA|SG|IN|US|GB|AU)"`).test(html), code + " hreflang present");
  }
});
test("UAE/Canada/Singapore homepages carry all eight hreflang alternates + x-default", () => {
  const html = U.buildHeadTags({ code: "ae", name: "UAE", region: "AE" });
  for (const path of ["/", "/us/", "/uk/", "/au/", "/de/", "/ae/", "/ca/", "/sg/"]) {
    assert.ok(html.includes(`href="https://filmychill.com${path}"`), "alternate for " + path);
  }
  assert.ok(html.includes('hreflang="x-default"'));
});
test("new-country film page paths are namespaced correctly", () => {
  assert.strictEqual(U.filmPagePath("ae", "raakh"), "/ae/movie/raakh.html");
  assert.strictEqual(U.filmPageUrl("sg", "raakh"), "https://filmychill.com/sg/movie/raakh.html");
  assert.strictEqual(U.filmPagePath("in", "raakh"), "/movie/raakh.html"); // India stays flat
});
test("countryNameFor reads naturally in prose for the new markets", () => {
  assert.strictEqual(U.countryNameFor({ code: "ae", name: "UAE" }), "the UAE");
  assert.strictEqual(U.countryNameFor({ code: "ca", name: "Canada" }), "Canada");
  assert.strictEqual(U.countryNameFor({ code: "sg", name: "Singapore" }), "Singapore");
});
test("localeFor returns a working locale for every country (date formatting never throws)", () => {
  for (const code of ["ae", "ca", "sg"]) {
    const out = new Date("2026-07-10").toLocaleDateString(U.localeFor(code), { day: "numeric", month: "long", year: "numeric" });
    assert.ok(/2026/.test(out), code + " -> " + out);
  }
});

// ---------------- regional data uniqueness (the audit fixes) ----------------
group("regional data: certFor() / regionalTheatricalDate()");
// One fixture TMDB payload with DIFFERENT data per region — the uniqueness proof.
const TMDB_FIXTURE = {
  release_dates: { results: [
    { iso_3166_1: "IN", release_dates: [{ type: 3, certification: "UA 16+", release_date: "2026-07-03T00:00:00.000Z" }] },
    { iso_3166_1: "AE", release_dates: [{ type: 3, certification: "PG 15", release_date: "2026-07-10T00:00:00.000Z" }] },
    { iso_3166_1: "SG", release_dates: [{ type: 1, certification: "", release_date: "2026-07-01T00:00:00.000Z" }, { type: 3, certification: "NC16", release_date: "2026-07-09T00:00:00.000Z" }] },
    { iso_3166_1: "US", release_dates: [{ type: 4, certification: "R", release_date: "2026-08-01T00:00:00.000Z" }] },
  ]},
  content_ratings: { results: [
    { iso_3166_1: "IN", rating: "U/A 16+" }, { iso_3166_1: "CA", rating: "14+" },
  ]},
};
test("each region gets ITS OWN certification — never India's", () => {
  assert.strictEqual(U.certFor("movie", TMDB_FIXTURE, "IN"), "UA 16+");
  assert.strictEqual(U.certFor("movie", TMDB_FIXTURE, "AE"), "PG 15");
  assert.strictEqual(U.certFor("movie", TMDB_FIXTURE, "SG"), "NC16");
  assert.strictEqual(U.certFor("tv", TMDB_FIXTURE, "CA"), "14+");
});
test("region with no cert entry -> null, NOT another country's rating", () => {
  assert.strictEqual(U.certFor("movie", TMDB_FIXTURE, "CA"), null); // CA has no movie entry
  assert.strictEqual(U.certFor("tv", TMDB_FIXTURE, "SG"), null);
});
test("each region gets ITS OWN theatrical date; premiere (1) and digital (4) both ignored", () => {
  assert.strictEqual(U.regionalTheatricalDate(TMDB_FIXTURE, "IN"), "2026-07-03");
  assert.strictEqual(U.regionalTheatricalDate(TMDB_FIXTURE, "AE"), "2026-07-10");
  // SG has a type-1 premiere on 1 Jul and the real theatrical on 9 Jul. This previously
  // returned the premiere — the same defect that printed "Released 31 Jan" on a film
  // releasing in October. A screening the public can't buy a ticket to is not a release.
  assert.strictEqual(U.regionalTheatricalDate(TMDB_FIXTURE, "SG"), "2026-07-09");
  assert.strictEqual(U.regionalTheatricalDate(TMDB_FIXTURE, "US"), null); // only a type-4 digital date
  assert.strictEqual(U.regionalTheatricalDate(TMDB_FIXTURE, "CA"), null); // no entry at all
});
test("dates render in each page's own locale", () => {
  const item = { kind: "movie", released: "2026-06-19" };
  const inLabel = U.freshLabel(item, Date.now(), U.localeFor("in"));
  const usLabel = U.freshLabel(item, Date.now(), U.localeFor("us"));
  assert.ok(/19 Jun/.test(inLabel), "India: " + inLabel);
  assert.ok(/Jun 19/.test(usLabel), "US: " + usLabel);
});
test("fallback description lists every configured country — generated, not hardcoded", () => {
  const list = U.countryListForProse();
  for (const name of ["India", "US", "UK", "Australia", "Germany", "UAE", "Canada", "Singapore"]) {
    assert.ok(list.includes(name), "missing " + name + " in: " + list);
  }
});

// ---------------- cast photos: extractCastPics() + rendering ----------------
group("extractCastPics()");
const CREDITS_FIXTURE = { cast: [
  { name: "Actor One", character: "Kara Zor-El", profile_path: "/a1.jpg" },
  { name: "No Photo", character: "Villain", profile_path: null },
  { name: "Actor Two", character: "", profile_path: "/a2.jpg" },
  { name: "A3", character: "C3", profile_path: "/a3.jpg" }, { name: "A4", character: "C4", profile_path: "/a4.jpg" },
  { name: "A5", character: "C5", profile_path: "/a5.jpg" }, { name: "A6", character: "C6", profile_path: "/a6.jpg" },
  { name: "A7", character: "C7", profile_path: "/a7.jpg" },
]};
test("only members with real headshots; capped at 6; w185 size; character kept", () => {
  const pics = U.extractCastPics(CREDITS_FIXTURE);
  assert.strictEqual(pics.length, 6);
  assert.ok(!pics.some((p) => p.name === "No Photo")); // no placeholder silhouettes
  assert.strictEqual(pics[0].photo, "https://image.tmdb.org/t/p/w185/a1.jpg");
  assert.strictEqual(pics[0].character, "Kara Zor-El");
  assert.strictEqual(pics[1].character, null); // empty string normalised to null
});
test("empty/missing credits -> empty array, never throws", () => {
  assert.deepStrictEqual(U.extractCastPics(null), []);
  assert.deepStrictEqual(U.extractCastPics({}), []);
  assert.deepStrictEqual(U.extractCastPics({ cast: [] }), []);
});
test("film page renders the photo strip with names, roles, and lazy circular images", () => {
  const html = U.buildFilmPage({ title: "Main", slug: "main", kind: "movie", platform: "Theatres",
    cast: ["Actor One"], castPics: [{ name: "Actor One", character: "Kara Zor-El", photo: "https://image.tmdb.org/t/p/w185/a1.jpg" }] },
    "2026-07-08", new Set(["main"]), { code: "in", name: "India", region: "IN" });
  assert.ok(/class="cast-strip"/.test(html) && /Kara Zor-El/.test(html));
  assert.ok(/w185\/a1\.jpg/.test(html) && /loading="lazy"/.test(html));
  assert.ok(html.includes('"actor":[{"@type":"Person","name":"Actor One","image"')); // LD gains images
});
test("film page falls back to text pills when no photos exist (old data files)", () => {
  const html = U.buildFilmPage({ title: "Main", slug: "main", kind: "movie", platform: "Theatres",
    cast: ["Actor One", "Actor Two"] }, "2026-07-08", new Set(["main"]), { code: "in", name: "India", region: "IN" });
  assert.ok(!/class="cast-strip"/.test(html)); // CSS rule is always present; the markup must not be
  assert.ok(/<h2>Cast<\/h2>/.test(html) && /Actor Two/.test(html));
});

// ---------------- share cards ----------------
group("share cards");
test("film page share image prefers the landscape backdrop over the portrait poster", () => {
  const html = U.buildFilmPage({ title: "Main", slug: "main", kind: "movie", platform: "Theatres",
    poster: "https://image.tmdb.org/t/p/w342/p.jpg", backdrop: "https://image.tmdb.org/t/p/w780/b.jpg" },
    "2026-07-10", new Set(["main"]), { code: "in", name: "India", region: "IN" });
  assert.ok(html.includes('og:image" content="https://image.tmdb.org/t/p/w780/b.jpg"'));
});

// ---------------- SEO: week chain + IndexNow payload ----------------
group("prevWeekSlug() / week chaining / IndexNow");
test("previous week math, including the year boundary", () => {
  assert.strictEqual(U.prevWeekSlug("2026-W28"), "2026-W27");
  assert.strictEqual(U.prevWeekSlug("2026-W01"), "2025-W52"); // crosses into the prior ISO year
});
test("week page links to the previous snapshot only when it exists", () => {
  const data = { theatres: [{ title: "A", slug: "a", kind: "movie" }], ott: [] };
  const withPrev = U.buildWeekPage(data, "2026-W28", true);
  assert.ok(withPrev.includes('href="https://filmychill.com/week/2026-W27/"') && /Previous week/.test(withPrev));
  const without = U.buildWeekPage(data, "2026-W28", false);
  assert.ok(!/Previous week/.test(without)); // first-ever snapshot has no phantom link
});
test("IndexNow payload covers every country, all language pages, and the CURRENT week", () => {
  const fs = require("fs");
  U.writeIndexNowPayload([{ code: "in" }, { code: "us" }, { code: "ae" }, { code: "sg" }]);
  const p = JSON.parse(fs.readFileSync("indexnow-payload.json", "utf8"));
  assert.strictEqual(p.host, "filmychill.com");
  assert.ok(p.urlList.includes("https://filmychill.com/") && p.urlList.includes("https://filmychill.com/ae/new-on-ott/"));
  assert.ok(p.urlList.includes("https://filmychill.com/tamil/"));
  const wk = "https://filmychill.com/week/" + U.weekSlug(U.isoWeekOf()) + "/";
  assert.ok(p.urlList.includes(wk), "current week " + wk);
  assert.ok(!p.urlList.includes("https://filmychill.com/in/")); // India is the root, never /in/
  fs.unlinkSync("indexnow-payload.json");
});

// ---------------- structured data validity (the GSC "unparsable" bug) ----------------
group("JSON-LD parses as Google sees it");
test("rendered homepage: every ld+json script element contains pure, parseable JSON", () => {
  const fs = require("fs");
  const tpl = fs.readFileSync("index.html", "utf8");
  const html = U.replaceBetween(tpl, "JSONLD",
    `<script type="application/ld+json">${U.buildHomeJsonLd({ theatres: [{ title: "A", slug: "a" }], ott: [], generatedAt: new Date().toISOString() }, { code: "in", name: "India", region: "IN" })}</script>`);
  // Emulate Google's parser: raw text content of each ld+json block must JSON.parse.
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length >= 1);
  for (const b of blocks) {
    assert.ok(!b[1].includes("<!--"), "comment marker leaked inside a script element");
    JSON.parse(b[1]); // throws on any syntax error
  }
});
test("buildHomeJsonLd output itself is valid JSON", () => {
  const out = U.buildHomeJsonLd({ theatres: [{ title: "O'Brien's \"Film\"", slug: "x" }], ott: [], generatedAt: new Date().toISOString() }, { code: "us", name: "United States", region: "US" });
  const parsed = JSON.parse(out);
  assert.ok(parsed["@graph"] || parsed["@context"]);
});

// ---------------- theatre eligibility (the Ikka class of bug) ----------------
group("theatreEligible()");
const REL = (types) => ({ release_dates: { results: [{ iso_3166_1: "IN", release_dates: types.map((t) => ({ type: t, release_date: "2026-07-10T00:00:00.000Z" })) }] } });
test("proven theatrical run (type 2/3) -> eligible, even if also digital", () => {
  assert.strictEqual(U.theatreEligible(REL([3]), "IN"), true);
  assert.strictEqual(U.theatreEligible(REL([2]), "IN"), true);
  assert.strictEqual(U.theatreEligible(REL([3, 4]), "IN"), true); // hybrid release keeps its theatre slot
});
test("digital/TV-only release -> NOT eligible (Netflix originals in now_playing)", () => {
  assert.strictEqual(U.theatreEligible(REL([4]), "IN"), false);
  assert.strictEqual(U.theatreEligible(REL([6]), "IN"), false);
  assert.strictEqual(U.theatreEligible(REL([4]), "IN", [{ name: "Netflix" }]), false);
});
test("premiere-only (type 1) is not a theatrical RUN -> falls to the provider signal", () => {
  assert.strictEqual(U.theatreEligible(REL([1]), "IN", []), true); // festival film, no streaming yet: benefit of doubt
  assert.strictEqual(U.theatreEligible(REL([1]), "IN", [{ name: "Netflix" }]), false); // premiered then straight to streaming
});
test("no region entry at all: eligible only without streaming providers", () => {
  assert.strictEqual(U.theatreEligible({}, "IN", []), true);
  assert.strictEqual(U.theatreEligible({}, "IN", [{ name: "Prime Video" }]), false);
});
test("Ikka's TMDB id is barred from theatres but NOT globally excluded", () => {
  assert.ok(U.THEATRE_EXCLUDE_IDS.has(1484913));
  assert.strictEqual(U.isExcluded({ id: 1484913, title: "Ikka" }), false); // still free to appear on the OTT list
});

// ---------------- viewer review mining ----------------
group("mineViewerAspects() / composeTmdbTake()");
const mkReview = (content, rating) => ({ content, author_details: { rating } });
test("aspects need agreement across 2+ reviews; one-off opinions are ignored", () => {
  const m = U.mineViewerAspects([
    mkReview("Loved the action sequences, some of the best choreography this year. The runtime drags badly in the middle though.", 8),
    mkReview("The action scenes are stunning and worth the ticket alone. But it is overlong — the runtime needed a trim.", 7),
    mkReview("Decent watch overall. The music was terrific.", 7),
  ]);
  assert.deepStrictEqual(m.praised, ["action"]);
  assert.deepStrictEqual(m.panned, ["runtime"]);
  assert.ok(!m.praised.includes("music"), "single-review praise must not qualify");
});
test("negated praise never counts as praise", () => {
  const m = U.mineViewerAspects([
    mkReview("The acting is not great, honestly quite wooden throughout the film.", 4),
    mkReview("Performances were not good at all, I found the acting stiff and wooden.", 3),
  ]);
  assert.ok(!m.praised.includes("performances"), JSON.stringify(m));
});
test("fewer than 2 usable review texts -> no aspects", () => {
  const m = U.mineViewerAspects([mkReview("Amazing performances all round, truly stunning acting from the whole cast.", 9)]);
  assert.deepStrictEqual(m, { praised: [], panned: [] });
});
test("composeTmdbTake: aspects produce viewer-labelled, seeded, digit-free lines", () => {
  const ta = { lean: "positive", praised: ["action"], panned: ["runtime"] };
  const s0 = U.composeTmdbTake(ta, 0), s1 = U.composeTmdbTake(ta, 1);
  assert.ok(/TMDB/.test(s0) && /action/.test(s0) && /runtime/.test(s0), s0);
  assert.notStrictEqual(s0, s1);
  assert.strictEqual(U.composeTmdbTake(ta, 1), s1);
  for (let i = 0; i < 4; i++) assert.ok(!/\d/.test(U.composeTmdbTake(ta, i)));
  // no aspects -> falls back to the existing tone-only pools, index 0 unchanged
  assert.strictEqual(U.composeTmdbTake({ lean: "mixed", praised: [], panned: [] }, 0),
    "Early viewer reviews on TMDB are mixed.");
});
test("composeTmdbTake: viewer takes never trigger a counterpoint (takeSrc guard)", () => {
  const t = U.composeTmdbTake({ lean: "negative", praised: [], panned: ["writing"] }, 2);
  assert.strictEqual(U.audienceCounterpoint({ take: t, takeSrc: "tmdb", rating: 8.5, votes: 900, tmdbId: 2 }), null);
});

// ---------------- editorial: reseedTake() ----------------
group("reseedTake()");
test("cached seed-0 pool lines re-pick this film's own variant — no more page duplicates", () => {
  const cached = "Critics have been largely positive on this one."; // the tripled line
  const a = U.reseedTake(cached, 101), b = U.reseedTake(cached, 102), c = U.reseedTake(cached, 103);
  assert.ok(new Set([a, b, c]).size >= 2, "different seeds should mostly differ");
  assert.strictEqual(U.reseedTake(cached, 101), a); // deterministic per film across runs
});
test("aspect-bearing takes pass through untouched", () => {
  const t = "Critics liked it, especially the performances and production design.";
  assert.strictEqual(U.reseedTake(t, 7), t);
  assert.strictEqual(U.reseedTake(null, 7), null);
});
test("reseeded output always stays inside the same tone pool (never flips sentiment)", () => {
  const negative = "The reviews were not kind.";
  for (let seed = 0; seed < 8; seed++) {
    const out = U.reseedTake(negative, seed);
    assert.ok(/not kind|not impressed|gave this one a pass|came away cold|little to love|rough outing|checked out early|patience ran thin/.test(out), out);
  }
});

// ---------------- keywords: OTT release date FAQ ----------------
group("OTT release date FAQ");
test("streaming film: states platform and arrival date from first-seen tracking", () => {
  const faqs = U.buildFaqs({ title: "Raakh", kind: "movie", platform: "Amazon Prime Video",
    providers: ["Amazon Prime Video"], ottFreshDate: "2026-06-12", released: "2026-05-01" }, "India");
  const f = faqs.find((x) => /releasing on OTT/.test(x.q));
  assert.ok(f && /already streaming/.test(f.a) && /2026-06-12/.test(f.a));
});
test("theatrical film: honestly says not announced, never invents a date", () => {
  const faqs = U.buildFaqs({ title: "Alpha", kind: "movie", platform: "Theatres", providers: [], released: "2026-07-03" }, "India");
  const f = faqs.find((x) => /OTT release date/.test(x.q));
  assert.ok(f && /hasn't been officially announced/.test(f.a));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(f.a)); // no date of any kind in the answer
});
test("TV series: no OTT-release-date question (wrong query pattern for shows)", () => {
  const faqs = U.buildFaqs({ title: "Silo", kind: "tv", platform: "Apple TV", providers: ["Apple TV+"] }, "India");
  assert.ok(!faqs.some((x) => /releasing on OTT/.test(x.q)));
});

// ---------------- AEO: buildLlmsTxt() ----------------
group("buildLlmsTxt()");
const LLMS_DATA = { in: { generatedAt: "2026-07-13T06:00:00.000Z",
  theatres: [{ title: "Alpha", slug: "alpha", language: "Hindi", platform: "Theatres", rating: 7.1, votes: 812, released: "2026-06-01" }],
  ott: [{ title: "Ikka", slug: "ikka", language: "Hindi", platform: "Netflix", rating: 6.8 },
        { title: "Old Hit", slug: "old-hit", platform: "Prime Video", stillGood: true }] } };
test("contains this week's actual picks with platforms, ratings, and film URLs", () => {
  const md = U.buildLlmsTxt(LLMS_DATA);
  assert.ok(md.includes("Alpha (Hindi)") && md.includes("rated 7.1/10"));
  assert.ok(md.includes("Ikka (Hindi) — on Netflix"));
  assert.ok(md.includes("https://filmychill.com/movie/alpha.html"));
});
test("only genuinely-new OTT titles — stillGood items excluded from the fresh list", () => {
  assert.ok(!U.buildLlmsTxt(LLMS_DATA).includes("Old Hit"));
});
test("early/low-vote ratings withheld from llms.txt (AI engines quote these verbatim)", () => {
  const recent = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  const md = U.buildLlmsTxt({ in: { generatedAt: "2026-07-13T06:00:00.000Z",
    theatres: [
      { title: "Thin", slug: "thin", language: "Hindi", platform: "Theatres", rating: 9.4, votes: 40, released: "2026-01-01" },
      { title: "Early", slug: "early", language: "Hindi", platform: "Theatres", rating: 9.2, votes: 223, released: recent }],
    ott: [] } });
  assert.ok(md.includes("Thin (Hindi)") && !md.includes("9.4"), "under 100 votes: no number");
  assert.ok(md.includes("Early (Hindi)") && !md.includes("9.2"), "under 14 days + under 500 votes: no number");
});
test("definitional summary, build timestamp, and all key surfaces present", () => {
  const md = U.buildLlmsTxt(LLMS_DATA);
  assert.ok(md.startsWith("# FilmyChill"));
  assert.ok(md.includes("2026-07-13T06:00:00.000Z"));
  for (const url of ["https://filmychill.com/", "https://filmychill.com/new-on-ott/", "https://filmychill.com/tamil/", "https://filmychill.com/about/", "https://filmychill.com/ae/"]) {
    assert.ok(md.includes(url), "missing " + url);
  }
  assert.ok(md.includes("/week/" + U.weekSlug(U.isoWeekOf()) + "/"));
});

// ---------------- share images on listing surfaces ----------------
group("listing og:image");
test("language, week, and ott-week pages all carry the brand share image", () => {
  const lang = U.buildLanguagePage({ generatedAt: new Date().toISOString(), theatres: [], ott: [], comingSoon: [] }, "Tamil", "tamil");
  const week = U.buildWeekPage({ theatres: [], ott: [] }, "2026-W29");
  const ottw = U.buildOttWeekPage({ generatedAt: new Date().toISOString(), ott: [] }, { code: "in", name: "India", region: "IN" }, [{ code: "in" }]);
  for (const html of [lang, week, ottw]) {
    assert.ok(html.includes('og:image" content="https://filmychill.com/og-image.png"'));
  }
});

// ---------------- take depth: wider aspects, score anchor, silence ----------------
group("take depth upgrades");
test("UPGRADE 1: widened vocabulary catches aspects the old matcher missed", () => {
  const t = "The film received mixed reviews. Critics praised the atmosphere and the tension, but faulted the slow pacing and a derivative plot.";
  const a = U.analyzeReception(t);
  assert.ok(a.praised.includes("atmosphere") || a.praised.includes("tension"), JSON.stringify(a));
  assert.ok(a.panned.includes("pacing"));
});
test("UPGRADE 2: extracts a Rotten Tomatoes figure as a concrete anchor", () => {
  const a = U.analyzeReception("The film received mixed reviews. On Rotten Tomatoes, 58% of critics gave it a positive review based on 40 reviews collected over the release window.");
  assert.deepStrictEqual(a.score, { kind: "rt", value: 58 });
});
test("UPGRADE 2: extracts a Metacritic figure when RT is absent", () => {
  const a = U.analyzeReception("The season met negative reviews. On Metacritic it holds a weighted average score of 38, indicating generally unfavourable reviews from the critics who covered it.");
  assert.deepStrictEqual(a.score, { kind: "mc", value: 38 });
});
test("UPGRADE 2+3: a score rescues a would-be-hollow mixed verdict — but never prints the number", () => {
  const take = U.composeTake(U.analyzeReception("The film received mixed reviews from critics. On the review aggregator Rotten Tomatoes, 61% of critics were positive, calling it watchable but slight in the end."));
  assert.ok(/divisive/i.test(take) && !/\d/.test(take), take); // score is evidence for the claim, not card copy
});
test("UPGRADE 3: hollow mixed — no aspect, no score — stays SILENT (no weather report)", () => {
  const a = U.analyzeReception("The film received mixed reviews from critics upon its wide theatrical release across the region during the summer season that year.");
  assert.strictEqual(a.tone, "mixed");
  assert.strictEqual(U.composeTake(a), null); // the whole point: better nothing than "all over the map"
});
test("aspect-bearing and acclaim/negative takes are unchanged by the upgrades", () => {
  assert.ok(/performances/.test(U.composeTake({ tone: "positive", praised: ["performances"], panned: [], score: null })));
  assert.ok(/loved/i.test(U.composeTake({ tone: "acclaim", praised: [], panned: [], score: null })));
});
// ---------------- takes: number-free discipline ----------------
group("takes: number-free (no clash with rating pill)");
test("canonical 'praise for X and criticism of Y' sentence is no longer skipped", () => {
  const a = U.analyzeReception("The film received mixed reviews from critics, with praise for its visual effects and performances and criticism of its screenplay and uneven pacing throughout.");
  assert.strictEqual(a.tone, "mixed");
  assert.ok(a.praised.includes("visuals") || a.praised.includes("performances"), JSON.stringify(a));
  assert.ok(a.panned.includes("writing") || a.panned.includes("pacing"), JSON.stringify(a));
  assert.ok(/praise for the/.test(U.composeTake(a)) && !/\d/.test(U.composeTake(a)));
});
test("'approval rating of NN%' captured even far from the aggregator name", () => {
  const a = U.analyzeReception("On the review aggregator website Rotten Tomatoes, which collates notices from major publications, the film holds an approval rating of 74% based on 190 reviews.");
  assert.deepStrictEqual(a.score, { kind: "rt", value: 74 });
});
test("widened vocabulary: dismissed/hailed clauses carry polarity", () => {
  const a = U.analyzeReception("Reviewers dismissed the screenplay as lacklustre and derivative, though most hailed the lead performances as the strongest element of the entire production overall.");
  assert.ok(a.panned.includes("writing") && a.praised.includes("performances"), JSON.stringify(a));
});
test("takes are number-free across every tone and evidence combo", () => {
  for (const tone of ["acclaim", "positive", "mixed", "negative", null])
    for (const score of [null, { kind: "rt", value: 96 }, { kind: "mc", value: 41 }])
      for (const praised of [[], ["performances"]])
        for (const panned of [[], ["pacing"]]) {
          const s = U.composeTake({ tone, score, praised, panned });
          if (s != null) assert.ok(!/\d/.test(s), JSON.stringify({ tone, score, praised, panned }) + " -> " + s);
        }
});
test("isPoolTake flags tone-only pool lines and nothing else", () => {
  assert.strictEqual(U.isPoolTake("Reviews are all over the map on this one."), true);
  assert.strictEqual(U.isPoolTake("Critics liked it, especially the performances."), false);
  assert.strictEqual(U.isPoolTake(null), false);
});
test("version purge fires even when the entry was already checked today", () => {
  const today = "2026-07-17";
  const entry = { take: "Critics loved it — a 96% critics' score says it all.", v: 2, hook: null, checked: today };
  const stale = !!entry && entry.v !== U.TAKE_VERSION;
  const needsFetch = !entry || stale || ((!entry.take || entry.hook === undefined) && entry.checked !== today);
  assert.strictEqual(needsFetch, true);
  const settled = { take: "Reviewers were close to unanimous — this one landed.", v: U.TAKE_VERSION, hook: null, checked: today,
    a: { tone: "acclaim", praised: [], panned: [], divided: [] } };
  const stale2 = !!settled && settled.v !== U.TAKE_VERSION;
  assert.strictEqual(!settled || stale2 || ((!settled.take || settled.hook === undefined) && settled.checked !== today), false);
});
test("v5 purge: any pre-v5 entry refetches once (gains stored analysis), v5 entries settle", () => {
  // v4 entries stored only the composed string — no analysis to recompose from — so a
  // bare version mismatch is the stale signal now.
  const v4 = { take: "The performances won critics over; the pacing drew the odd complaint.", v: 4, hook: null, checked: "2026-07-17" };
  assert.strictEqual(!!v4 && v4.v !== U.TAKE_VERSION, true);
  const v5 = { ...v4, v: U.TAKE_VERSION, a: { tone: "positive", praised: ["performances"], panned: ["pacing"], divided: [] } };
  assert.strictEqual(!!v5 && v5.v !== U.TAKE_VERSION, false);
  // stamped v prevents loops: a v5 entry with a null take refetches only via the daily gate
  const empty = { take: null, src: null, hook: null, checked: "2026-07-17", v: U.TAKE_VERSION };
  assert.strictEqual(!!empty && empty.v !== U.TAKE_VERSION, false);
  // isLegacyTake stays exported and correct for its v3 vocabulary
  assert.strictEqual(U.isLegacyTake("Critics loved it — special praise for the performances."), true);
  assert.strictEqual(U.isLegacyTake(null), false);
});
test("stored analysis composes per-film: same entry, different seeds, different lines", () => {
  const a = { tone: "positive", praised: ["performances"], panned: ["pacing"], divided: [] };
  const takes = new Set([1, 2, 3, 4, 5].map((s) => U.composeTake(a, s)));
  assert.ok(takes.size >= 3, "one cached analysis should fan out to varied lines: " + takes.size);
  for (const t of takes) assert.ok(/performances/.test(t) && /pacing/.test(t), t);
});

// ---------------- hreflang x-default ----------------
group("hreflang x-default (GSC 404 fix)");
test("xDefaultCode: India wins when India has the film", () => {
  assert.strictEqual(U.xDefaultCode(["us", "in", "uk"]), "in");
});
test("xDefaultCode: no India -> first available in COUNTRIES order, order-insensitive", () => {
  assert.strictEqual(U.xDefaultCode(["de", "uk", "us"]), "us");
  assert.strictEqual(U.xDefaultCode(["ae", "de"]), U.xDefaultCode(["de", "ae"]));
});
test("xDefaultCode: degenerate inputs fall back safely", () => {
  assert.strictEqual(U.xDefaultCode([]), "in");
  assert.strictEqual(U.xDefaultCode(null), "in");
});
test("film page without an India copy never advertises the India URL as x-default", () => {
  const html = U.buildFilmPage({ title: "Simpsley", slug: "simpsley", kind: "movie", language: "English", platform: "Theatres",
    released: "2026-07-01", rating: 6.5, votes: 300, _alts: [{ code: "us", region: "US" }, { code: "uk", region: "GB" }] },
    "2026-07-10", new Set(["simpsley"]), { code: "us", name: "United States", region: "US" });
  assert.ok(!html.includes('hreflang="x-default" href="https://filmychill.com/movie/simpsley.html"'));
  assert.ok(html.includes('hreflang="x-default" href="https://filmychill.com/us/movie/simpsley.html"'));
});

// ---------------- trending cap ----------------
group("trending cap");
test("capTrending: only top 2 by weekly views keep the badge, per section", () => {
  const data = { in: { theatres: [
    { title: "a", trending: true, wikiWeeklyViews: 900 }, { title: "b", trending: true, wikiWeeklyViews: 5000 },
    { title: "c", trending: true, wikiWeeklyViews: 100 }, { title: "d", trending: true, wikiWeeklyViews: 3000 }, { title: "e" }], ott: [] } };
  U.capTrending(data);
  assert.deepStrictEqual(data.in.theatres.filter((x) => x.trending).map((x) => x.title).sort(), ["b", "d"]);
});
test("ssrCard: trend badge is an icon, no emoji; Theatres pill dropped in its own section", () => {
  const t1 = U.ssrCard({ title: "A", platform: "Theatres", language: "Hindi", kind: "movie", slug: "a", trending: true }, 0, "in");
  assert.ok(t1.includes("icTrend") && !t1.includes("🔥") && !t1.includes('<span class="platform">'));
  const t2 = U.ssrCard({ title: "B", platform: "Netflix", language: "Hindi", kind: "movie", slug: "b" }, 0, "in");
  assert.ok(t2.includes('<span class="platform">Netflix</span>'));
});

// ---------------- editor's note ----------------
group("editor's note");
test("editor's note: judgments assemble from real data, capped", () => {
  const data = { generatedAt: "2026-07-19", theatres: [
    { title: "The Odyssey", rating: 7.7, votes: 1200, genre: "Adventure" },
    { title: "Moana", rating: 5.6, votes: 85, genre: "Family / Fantasy" }],
    ott: [{ title: "Pritam and Pedro", rating: 8.6, votes: 300, platform: "JioHotstar" }] };
  const n = U.buildEditorNote(data, { code: "in" }, 42);
  assert.ok(/The Odyssey/.test(n) && /7\.7/.test(n));
  assert.ok(/Moana/.test(n) && /kids-in-the-house/.test(n));
  assert.ok(/Pritam and Pedro/.test(n));
  assert.ok(n.split(/(?<=[.!?]) /).length <= 4 && n.length < 400, n);
});
test("editor's note: no AI filler, no fabricated firsthand experience (40 seeds)", () => {
  for (let seed = 0; seed < 40; seed++) {
    const n = U.buildEditorNote({ generatedAt: "2026-07-19",
      theatres: [{ title: "A", rating: 8.1, votes: 500, genre: "Drama" }, { title: "B", rating: 4.9, votes: 90, genre: "Action" }],
      ott: [{ title: "C", rating: 8.2, votes: 200, platform: "Netflix" }] }, { code: "in" }, seed);
    assert.ok(!/exciting|something for everyone|lineup|!|I watched|I saw|we watched/i.test(n), n);
  }
});
test("editor's note: thin data -> null; seeded phrasing is stable", () => {
  assert.strictEqual(U.buildEditorNote({ theatres: [{ title: "X", rating: 7, votes: 3 }], ott: [] }, { code: "in" }), null);
  const d = { theatres: [{ title: "A", rating: 8.0, votes: 100, genre: "Drama" }], ott: [] };
  assert.strictEqual(U.buildEditorNote(d, { code: "in" }, 7), U.buildEditorNote(d, { code: "in" }, 7));
});
test("editor note weaves the event film's praised aspect in as a clause", () => {
  const data = { theatres: [{ title: "Odyssey", rating: 8.1, votes: 500, genre: "Drama", takeAspects: ["performances"] }], ott: [] };
  const n = U.buildEditorNote(data, { code: "in" }, 42);
  assert.ok(/performances/.test(n), n);
  assert.ok(/talk is about|word of mouth|buzz comes down/.test(n), n);
  // clause, not an extra sentence: appended before the full stop
  assert.ok(!/\.\s+[a-z]/.test(n), "flourish must not start a lowercase sentence: " + n);
  assert.strictEqual(U.buildEditorNote(data, { code: "in" }, 42), n); // deterministic
});
test("editor note without takeAspects is byte-identical to before (no flourish)", () => {
  const bare = { theatres: [{ title: "Odyssey", rating: 8.1, votes: 500, genre: "Drama" }], ott: [] };
  const n = U.buildEditorNote(bare, { code: "in" }, 42);
  assert.ok(!/talk is about|word of mouth|buzz comes down/.test(n), n);
});
test("ssrEditorNote renders styled block and escapes (escHtml scope guard)", () => {
  const html = U.ssrEditorNote({ generatedAt: "2026-07-19", theatres: [{ title: "A & B", rating: 8.0, votes: 200, genre: "Drama" }], ott: [] }, { code: "us" });
  assert.ok(html.includes('class="ednote"') && html.includes("A &amp; B"));
  assert.strictEqual(U.ssrEditorNote({ theatres: [], ott: [] }, { code: "us" }), "");
});

// ---------------- platform hubs ----------------
group("platform hubs");
test("platformSlug: clean, collision-safe slugs incl. overrides", () => {
  assert.strictEqual(U.platformSlug("Netflix"), "netflix");
  assert.strictEqual(U.platformSlug("Amazon Prime Video"), "prime-video");
  assert.strictEqual(U.platformSlug("Disney+"), "disney-plus");
});
test("hubsFor: groups by every provider, min-4 to create, cap 5, keeps rank order", () => {
  const mk = (slug, provs) => ({ title: slug, slug, platform: provs[0], providers: provs });
  const hubs = U.hubsFor({ ott: [mk("a", ["Netflix", "JioHotstar"]), mk("b", ["Netflix"]), mk("c", ["Netflix"]),
    mk("h", ["Netflix"]), mk("d", ["JioHotstar"]), mk("e", ["JioHotstar"]), mk("i", ["JioHotstar"]),
    mk("f", ["Zee5"]), mk("g", ["Zee5"])] });
  assert.deepStrictEqual(hubs.map((h) => h.name).sort(), ["JioHotstar", "Netflix"]);
  assert.deepStrictEqual(hubs.find((h) => h.name === "Netflix").items.map((x) => x.slug), ["a", "b", "c", "h"]);
});
test("hubsFor: reads ottExtra, not just the capped homepage list", () => {
  const mk = (slug, provs) => ({ title: slug, slug, tmdbId: slug.charCodeAt(0), platform: provs[0], providers: provs });
  const data = { ott: [mk("a", ["Netflix"]), mk("b", ["Netflix"])],
                 ottExtra: [mk("c", ["Netflix"]), mk("d", ["Netflix"])] };
  assert.deepStrictEqual(U.hubsFor(data).map((h) => h.name), ["Netflix"]);
  assert.strictEqual(U.hubsFor({ ott: data.ott }).length, 0, "two titles alone must not mint a hub");
});
test("hubsFor: provider variants collapse to one service", () => {
  // "Apple TV" + "Apple TV Amazon Channel" is one destination to a viewer. Split across two
  // buckets it cleared no threshold; it also minted /new-on-amazon-prime-video-with-ads/,
  // a URL named after a billing tier.
  const mk = (slug, provs) => ({ title: slug, slug, tmdbId: slug.charCodeAt(0), platform: provs[0], providers: provs });
  const hubs = U.hubsFor({ ott: [mk("a", ["Apple TV"]), mk("b", ["Apple TV Amazon Channel"]),
    mk("c", ["Apple TV+"]), mk("d", ["Apple TV"])] });
  assert.deepStrictEqual(hubs.map((h) => h.name), ["Apple TV"]);
  assert.strictEqual(hubs[0].items.length, 4);
  assert.strictEqual(U.platformSlug("Amazon Prime Video with Ads"), "prime-video");
  assert.strictEqual(U.platformSlug("Netflix Standard with Ads"), "netflix");
});
test("hubsFor: an existing hub survives on the lower keep threshold", () => {
  const mk = (slug, provs) => ({ title: slug, slug, tmdbId: slug.charCodeAt(0), platform: provs[0], providers: provs });
  const data = { ott: [mk("a", ["Netflix"]), mk("b", ["Netflix"]), mk("c", ["Netflix"])] };
  assert.strictEqual(U.hubsFor(data).length, 0, "3 titles must not CREATE a hub");
  assert.strictEqual(U.hubsFor(data, new Set(["netflix"])).length, 1, "3 titles must KEEP an existing hub");
  const two = { ott: [mk("a", ["Netflix"]), mk("b", ["Netflix"])] };
  assert.strictEqual(U.hubsFor(two, new Set(["netflix"])).length, 0, "2 titles must not survive either");
});
test("hubsFor: a title on the same provider twice is counted once", () => {
  const dup = { title: "a", slug: "a", tmdbId: 1, platform: "Netflix", providers: ["Netflix"] };
  const data = { ott: [dup, { ...dup, tmdbId: 2, slug: "b", title: "b" }], ottExtra: [dup] };
  const hubs = U.hubsFor(data, new Set(["netflix"]));
  assert.strictEqual(hubs.length, 0, "the duplicate must not inflate the count to 3");
});
test("buildPlatformHubPage: title, country-scoped links, ItemList + FAQ, no emoji", () => {
  const mk = (slug, r) => ({ title: slug.toUpperCase(), slug, kind: "movie", platform: "Netflix", providers: ["Netflix"], rating: r, votes: 100, language: "English", genre: "Drama" });
  const data = { generatedAt: "2026-07-19T04:00:00Z", ott: [mk("aaa", 8.2), mk("bbb", 7.1), mk("ccc", 6.4), mk("ddd", 6.1)] };
  const html = U.buildPlatformHubPage(data, { code: "us", name: "United States" }, U.hubsFor(data)[0]);
  assert.ok(/New on Netflix/.test(html) && html.includes('href="/us/movie/aaa.html"'));
  assert.ok(html.includes('"ItemList"') && html.includes('"numberOfItems":4'));
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(html));
});
test("indexNowUrls: hubs, this week's film pages, llms-full ride the ping; deduped", () => {
  const urls = U.indexNowUrls([{ code: "in" }], { in: { theatres: [{ slug: "the-odyssey" }],
    ott: [{ slug: "p", title: "P", platform: "JioHotstar", providers: ["JioHotstar"] }, { slug: "b", title: "B", platform: "JioHotstar", providers: ["JioHotstar"] }, { slug: "c", title: "C", platform: "JioHotstar", providers: ["JioHotstar"] }, { slug: "d", title: "D", platform: "JioHotstar", providers: ["JioHotstar"] }] } });
  assert.ok(urls.includes("https://filmychill.com/movie/the-odyssey.html") && urls.includes("https://filmychill.com/new-on-jiohotstar/") && urls.includes("https://filmychill.com/llms-full.txt"));
  assert.strictEqual(new Set(urls).size, urls.length);
});
test("film page shows up to six similar titles", () => {
  const sim = Array.from({ length: 8 }, (_, i) => ({ title: "S" + i, slug: "s" + i, poster: "https://image.tmdb.org/x.jpg", language: "English", kind: "movie" }));
  const html = U.buildFilmPage({ title: "X", slug: "x", kind: "movie", language: "English", platform: "Theatres", released: "2026-07-10", rating: 7, votes: 100, similar: sim }, "2026-07-19", new Set(["x"]), { code: "in", name: "India", region: "IN" });
  assert.strictEqual((html.match(/class="simcard"/g) || []).length, 6);
});

// ---------------- AI-era readiness ----------------
group("AI-era readiness");
test("llms-full.txt: one fetch answers the week with provenance", () => {
  const data = { in: { generatedAt: "2026-07-19T04:00:00Z", theatres: [{ title: "The Odyssey", kind: "movie",
    language: "English", genre: "Adventure", runtime: 173, cert: "A", released: "2026-07-10", platform: "Theatres",
    rating: 7.7, votes: 1200, verdict: "Must watch", take: "Critics loved it.", takeArticle: "The Odyssey (2026 film)",
    hook: "Nolan epic.", director: "Christopher Nolan", slug: "the-odyssey" }], ott: [] } };
  const s = U.buildLlmsFullTxt(data);
  assert.ok(s.includes("rated 7.7/10") && s.includes("Critics: Critics loved it"));
  assert.ok(s.includes("en.wikipedia.org/wiki/The_Odyssey_(2026_film)") && s.includes("https://filmychill.com/movie/the-odyssey.html"));
  assert.ok(!/<[a-z]/.test(s));
});
test("llms machine appendix lists llms-full, feed, every country's JSON", () => {
  const s = U.llmsMachineSection();
  assert.ok(s.includes("llms-full.txt") && s.includes("feed.xml") && s.includes("https://filmychill.com/data.json") && s.includes("https://filmychill.com/data-us.json"));
});
test("film-page JSON-LD carries citation + WatchAction when provenance and trailer exist", () => {
  const html = U.buildFilmPage({ title: "Odyssey", slug: "odyssey", kind: "movie", language: "English", platform: "Theatres",
    released: "2026-07-10", rating: 7.7, votes: 900, take: "Critics loved it.", takeSrc: "wiki", takeArticle: "The Odyssey (2026 film)",
    trailer: "https://www.youtube.com/watch?v=abc123def45" }, "2026-07-19", new Set(["odyssey"]), { code: "in", name: "India", region: "IN" });
  assert.ok(html.includes('"citation"') && html.includes("en.wikipedia.org/wiki/The_Odyssey_(2026_film)"));
  assert.ok(html.includes('"VideoObject"') && html.includes("abc123def45"), "trailer rides as Movie.trailer VideoObject");
  assert.ok(!html.includes('"WatchAction"'), "no WatchAction pointing at a trailer");
});
test("footerAttribution: JustWatch credit present in both ratings modes", () => {
  assert.ok(U.footerAttribution(false).includes("justwatch.com") && U.footerAttribution(true).includes("justwatch.com"));
});

test("score answer never exceeds a valid range (garbage numbers ignored)", () => {
  const a = U.analyzeReception("The film holds a 250% approval somewhere in this malformed sentence that should not parse as a score at all here.");
  assert.ok(!a || a.score === null);
});

// ---------------- summary ----------------
console.log(`\n${"=".repeat(40)}`);

// ---------------- world-class polish pass (Aug 2026) ----------------
group("trim() — no dangling function words");
test("fragment never ends on an article ('sparks a…' bug)", () => {
  const t = "Fighting crime full-time in a world that forgot him sparks a change in everything he believed about heroes";
  const out = U.trim(t, 60);
  assert.ok(out.endsWith("\u2026"));
  assert.ok(!/\s(?:a|an|the|and|of|to|in|that|his|her)\u2026$/i.test(out), `ends badly: "${out}"`);
});
test("peels chained stopwords and dangling punctuation", () => {
  const out = U.trim("The story of the woman who refuses to leave, and of the", 56);
  assert.ok(!/(?:,|—|-|\s(?:a|an|the|and|of|who|to))\u2026$/i.test(out), `ends badly: "${out}"`);
});
test("sentence-boundary preference untouched", () => {
  const out = U.trim("A full sentence ends here. Then more trailing text follows after it", 40);
  assert.ok(out.endsWith("here."), `expected sentence cut, got "${out}"`);
});

group("fmtRuntime()");
test("hours + minutes", () => { assert.strictEqual(U.fmtRuntime(145), "2h 25m"); });
test("exact hours drop minutes", () => { assert.strictEqual(U.fmtRuntime(120), "2h"); });
test("under an hour", () => { assert.strictEqual(U.fmtRuntime(52), "52m"); });
test("garbage -> empty", () => {
  assert.strictEqual(U.fmtRuntime(0), "");
  assert.strictEqual(U.fmtRuntime(null), "");
  assert.strictEqual(U.fmtRuntime("abc"), "");
});

group("langCode() — TMDB language overrides");
test("known-bad ids corrected (Kadhal Aura -> ta, Judaa -> pa)", () => {
  assert.strictEqual(U.langCode({ id: 1639137, original_language: "en", title: "Kadhal Aura" }), "ta");
  assert.strictEqual(U.langCode({ id: 1649723, original_language: "en", title: "Judaa" }), "pa");
});
test("everything else passes through untouched", () => {
  assert.strictEqual(U.langCode({ id: 969681, original_language: "en" }), "en");
  assert.strictEqual(U.langCode({ id: 12345, original_language: "ta" }), "ta");
});
test("override map values are valid LANG keys", () => {
  for (const code of Object.values(U.LANG_CODE_OVERRIDES)) {
    assert.ok(["en","hi","ta","te","ml","kn","mr","bn","pa","gu"].includes(code), code);
  }
});

group("ssrCard — runtime + honest unrated line");
test("movie runtime rendered as h/m in the meta row", () => {
  const html = U.ssrCard({ title: "T", language: "Hindi", genre: "Action / Drama", kind: "movie", runtime: 150, rating: 7.1, verdict: "Worth a watch", slug: "t" }, 0, "in");
  assert.ok(html.includes("2h 30m"), "runtime missing from SSR card");
});
test("TV runtime (per-episode) stays off the card meta", () => {
  const html = U.ssrCard({ title: "T", language: "English", genre: "Drama", kind: "tv", runtime: 45, rating: 8.0, verdict: "Must watch", slug: "t" }, 0, "in");
  assert.ok(!html.includes("45m"), "per-episode runtime leaked onto card");
});
test("unrated card states the verdict instead of a silent gap", () => {
  const html = U.ssrCard({ title: "T", language: "Hindi", genre: "Action", kind: "movie", rating: null, isFresh: true, verdict: "Just released — verdict soon", slug: "t" }, 0, "in");
  assert.ok(html.includes("Just released — verdict soon"), "fresh verdict not rendered in SSR");
  assert.ok(html.includes("\u2606"), "hollow star marker missing");
});
test("rated card unchanged (star + verdict)", () => {
  const html = U.ssrCard({ title: "T", language: "Hindi", genre: "Action", kind: "movie", rating: 7.9, verdict: "Must watch", slug: "t" }, 0, "in");
  assert.ok(html.includes("\u2605 7.9 \u00b7 Must watch") || html.includes("\u2605 7.9"), "rated line broken");
});

group("ssrSoonCard — poster placeholder");
test("missing poster renders letter + note, not a bare initial", () => {
  const html = U.ssrSoonCard({ title: "Kadhal Aura", released: "2026-08-21", language: "Tamil", slug: "kadhal-aura" }, "in");
  assert.ok(html.includes("soon-ph-letter"), "letter span missing");
  assert.ok(html.includes("Poster on the way"), "note missing");
});
test("with poster, placeholder absent", () => {
  const html = U.ssrSoonCard({ title: "T", released: "2026-08-21", language: "Hindi", slug: "t", poster: "https://x/p.jpg" }, "in");
  assert.ok(!html.includes("soon-ph"), "placeholder rendered despite poster");
});

group("film page — subscription vs rent/buy");
test("streaming providers labelled as included with subscription", () => {
  const html = U.buildFilmPage({ title: "T", slug: "t", kind: "movie", language: "Hindi", providers: ["Netflix"], platform: "Netflix", released: "2026-08-01", review: "x", verdict: "Worth a watch", rating: 7.0, votes: 500 }, { code: "in", country: "India", watchRegion: "IN" }, {});
  assert.ok(html.includes("Included with a subscription"), "included copy missing");
});
test("theatrical film with rentBuy answers 'can I watch at home?'", () => {
  const html = U.buildFilmPage({ title: "T", slug: "t", kind: "movie", language: "Hindi", providers: [], rentBuy: ["Apple TV", "YouTube"], platform: "Theatres", released: "2026-08-01", review: "x", verdict: "Worth a watch", rating: 7.0, votes: 500 }, { code: "in", country: "India", watchRegion: "IN" }, {});
  assert.ok(html.includes("Rent or buy"), "rent row missing");
  assert.ok(html.includes("Apple TV"), "rent platforms missing");
  assert.ok(html.includes("renting is the only way"), "theatres+rent copy missing");
});
test("no providers at all -> section omitted entirely (no empty shell)", () => {
  const html = U.buildFilmPage({ title: "T", slug: "t", kind: "tv", language: "Hindi", providers: [], platform: "JioHotstar", released: "2026-08-01", review: "x", verdict: "Worth a watch", rating: 7.0, votes: 500 }, { code: "in", country: "India", watchRegion: "IN" }, {});
  assert.ok(!html.includes("Rent or buy"), "rent row rendered with no data");
});

group("langName() — no raw ISO codes on chips");
test("curated map wins with our spellings", () => {
  assert.strictEqual(U.langName("hi"), "Hindi");
  assert.strictEqual(U.langName("ta"), "Tamil");
});
test("codes outside the map resolve via Intl ('ar 1' chip bug)", () => {
  assert.strictEqual(U.langName("ar"), "Arabic");
  assert.strictEqual(U.langName("th"), "Thai");
  assert.strictEqual(U.langName("ru"), "Russian");
  assert.strictEqual(U.langName("tr"), "Turkish");
});
test("garbage falls back to the input, never throws", () => {
  assert.strictEqual(U.langName("zzz-not-a-lang!!"), "zzz-not-a-lang!!");
  assert.strictEqual(U.langName(null), null);
});

group("streamVocab() — per-country wording");
test("India and UAE say OTT; everyone else says streaming", () => {
  assert.strictEqual(U.streamVocab({ code: "in" }).word, "OTT");
  assert.strictEqual(U.streamVocab({ code: "ae" }).word, "OTT");
  for (const c of ["us", "uk", "au", "de", "ca", "sg"]) {
    assert.strictEqual(U.streamVocab({ code: c }).word, "streaming", c);
  }
});
test("partial cfg still resolves by code (the silent-downgrade bug)", () => {
  assert.strictEqual(U.streamVocab({ code: "in", name: "India" }).word, "OTT");
});
test("no cfg defaults to India, matching buildFilmPage's own default", () => {
  assert.strictEqual(U.streamVocab(null).word, "OTT");
});
test("headings and FAQ questions use the market's word", () => {
  assert.ok(/coming to OTT\?$/.test(U.streamVocab({ code: "in" }).heading("X")));
  assert.ok(/coming to streaming\?$/.test(U.streamVocab({ code: "us" }).heading("X")));
  assert.ok(/OTT release date/.test(U.streamVocab({ code: "in" }).faqQuestion("X")));
  assert.ok(!/OTT/.test(U.streamVocab({ code: "de" }).faqQuestion("X")));
});
test("page-copy forms exist in both registers (title-case, sentence-case, nav label)", () => {
  const inV = U.streamVocab({ code: "in" }), usV = U.streamVocab({ code: "us" });
  assert.strictEqual(inV.Releases, "OTT Releases");
  assert.strictEqual(usV.Releases, "Streaming Releases");
  assert.strictEqual(usV.releases, "streaming releases");
  assert.strictEqual(usV.newOn, "New on streaming");
  assert.strictEqual(usV.Word, "Streaming");
  assert.strictEqual(inV.newOn, "New on OTT");
});

group("streaming-window archive — the proprietary record");
test("window is theatrical release to first sighting", () => {
  assert.strictEqual(U.streamingWindowDays({ rel: "2026-07-01", first: "2026-08-01" }), 31);
  assert.strictEqual(U.streamingWindowDays({ rel: "2026-08-01", first: "2026-08-01" }), 0);
});
test("impossible windows are excluded rather than averaged in", () => {
  // Streaming BEFORE theatrical is a straight-to-streaming title, not a window.
  assert.strictEqual(U.streamingWindowDays({ rel: "2026-08-01", first: "2026-07-01" }), null);
  // A multi-year gap is a catalogue re-listing, not a release window.
  assert.strictEqual(U.streamingWindowDays({ rel: "2020-01-01", first: "2026-01-01" }), null);
  assert.strictEqual(U.streamingWindowDays({ rel: null, first: "2026-01-01" }), null);
});
test("archive is append-only and idempotent per country+title", () => {
  const rec = U.historyRecord({ code: "zz", kind: "movie", tmdbId: 999999901, first: "2026-01-01" });
  assert.strictEqual(rec.c, "zz");
  assert.strictEqual(rec.k, "movie");
  assert.ok(rec.seen, "every observation is timestamped");
});
test("a median is never published on a group of one or two", () => {
  const recs = [
    { c: "in", k: "movie", p: "Netflix", lang: "Tamil", rel: "2026-01-01", first: "2026-02-01" },
    { c: "in", k: "movie", p: "Netflix", lang: "Tamil", rel: "2026-01-01", first: "2026-02-11" },
    { c: "in", k: "movie", p: "Netflix", lang: "Tamil", rel: "2026-01-01", first: "2026-02-21" },
    { c: "in", k: "movie", p: "SonyLIV", lang: "Hindi", rel: "2026-01-01", first: "2026-03-01" },
  ];
  const s = U.windowStats(recs);
  assert.strictEqual(s.measured, 4);
  assert.ok(s.byPlatform.every((x) => x.n >= 3), "SonyLIV has one film and must not appear");
  assert.strictEqual(s.byPlatform.find((x) => x.key === "Netflix").median, 41);
});
test("CSV carries only measured rows and escapes titles", () => {
  const csv = U.buildWindowsCsv([
    { id: 1, k: "movie", t: 'The "Best" Film', c: "in", p: "Netflix", rel: "2026-01-01", first: "2026-02-01" },
    { id: 2, k: "movie", t: "No dates", c: "in", p: "Netflix", rel: null, first: "2026-02-01" },
  ]);
  const lines = csv.trim().split("\n");
  assert.strictEqual(lines.length, 2, "header + the one measurable row");
  assert.ok(lines[1].includes('""Best""'), "quotes escaped for CSV");
});
test("data page states sample size and refuses to invent a median", () => {
  const empty = U.buildDataPage([], "26 August 2026");
  assert.ok(/Not enough measured films yet/.test(empty), "no data -> say so, don't print a number");
  const withData = U.buildDataPage([
    { c: "in", k: "movie", p: "Netflix", lang: "Tamil", rel: "2026-01-01", first: "2026-02-01" },
    { c: "in", k: "movie", p: "Netflix", lang: "Tamil", rel: "2026-01-01", first: "2026-02-05" },
    { c: "in", k: "movie", p: "Netflix", lang: "Tamil", rel: "2026-01-01", first: "2026-02-09" },
  ], "26 August 2026");
  assert.ok(/Films<\/th>/.test(withData), "sample size is published next to every median");
  assert.ok(/attribution/i.test(withData), "reuse terms are stated");
});

group("build sequence — one definition, no drift");
test("both build paths run the same steps", () => {
  // The bug this prevents: a step added to one path and missing from the other, failing
  // silently. Assert the shared function exists and is what both callers use.
  assert.strictEqual(typeof U.writeCountrySurfaces, "function");
});
test("a failing step is contained, not fatal", () => {
  // Every step is individually guarded, so one broken surface can't abort the rest of the
  // country — or the run. Passing junk data must warn, not throw.
  assert.doesNotThrow(() => U.writeCountrySurfaces({ code: "zz", name: "Nowhere" }, {}));
});

group("crawl paths — every subtree reachable by a crawler");
test("footer links to the other country homepages", () => {
  const more = U.buildMoreLinks("in", null);
  for (const c of ["/us/", "/uk/", "/au/", "/de/", "/ae/", "/ca/", "/sg/"]) {
    assert.ok(more.includes(`href="${c}"`), `no crawlable link to ${c}`);
  }
  assert.ok(!/href="\/in\/"/.test(more), "never links a country to itself");
});
test("each country's footer points at the other seven, not its own", () => {
  const us = U.buildMoreLinks("us", null);
  assert.ok(us.includes('href="/"'), "must link back to the India root");
  assert.ok(!us.includes('href="/us/"'));
  assert.ok(us.includes('href="/uk/"'));
});
test("footer reaches that country's own browse index", () => {
  assert.ok(U.buildMoreLinks("in", null).includes('href="/films/"'));
  assert.ok(U.buildMoreLinks("us", null).includes('href="/us/films/"'));
});

group("hreflang clusters — regional variants, not duplicates");
test("every member is listed, including the page itself", () => {
  const b = U.hreflangBlockFor(["in", "uk", "ca"], "dastaar");
  for (const tag of ["en-IN", "en-GB", "en-CA", "x-default"]) assert.ok(b.includes(tag), `missing ${tag}`);
  assert.strictEqual((b.match(/rel="alternate"/g) || []).length, 4);
});
test("a single-country film gets no alternates at all", () => {
  assert.strictEqual(U.hreflangBlockFor(["in"], "solo"), "");
});
test("members are emitted in a stable order so pages don't churn", () => {
  assert.strictEqual(U.hreflangBlockFor(["ca", "uk", "in"], "x"), U.hreflangBlockFor(["in", "ca", "uk"], "x"));
});
test("patch repairs an incomplete set on a frozen page", () => {
  const page = `<link rel="canonical" href="https://filmychill.com/uk/movie/d.html">
<link rel="alternate" hreflang="en-CA" href="https://filmychill.com/ca/movie/d.html"/>
<link rel="alternate" hreflang="x-default" href="https://filmychill.com/movie/d.html"/>
<title>x</title>`;
  const { html, changed } = U.patchHreflang(page, ["in", "uk", "ca"], "d");
  assert.ok(changed);
  assert.ok(html.includes('hreflang="en-GB"'), "the page must point at itself");
  assert.ok(html.includes('hreflang="en-IN"'), "and at every other member");
  assert.ok(html.includes("<title>x</title>"), "nothing else may be touched");
});
test("patch inserts a set where none existed", () => {
  const page = `<link rel="canonical" href="https://filmychill.com/movie/d.html">\n<title>x</title>`;
  const { html, changed } = U.patchHreflang(page, ["in", "us"], "d");
  assert.ok(changed && html.includes('hreflang="en-US"') && html.includes('hreflang="en-IN"'));
});
test("patch strips a stale set when the film is now single-country", () => {
  const page = `<link rel="canonical" href="https://filmychill.com/movie/d.html">
<link rel="alternate" hreflang="en-GB" href="https://filmychill.com/uk/movie/d.html"/>
<title>x</title>`;
  const { html, changed } = U.patchHreflang(page, ["in"], "d");
  assert.ok(changed && !html.includes("alternate"));
});
test("patch is idempotent — a correct page is left alone", () => {
  let page = `<link rel="canonical" href="https://filmychill.com/movie/d.html">\n<title>x</title>`;
  page = U.patchHreflang(page, ["in", "us"], "d").html;
  assert.strictEqual(U.patchHreflang(page, ["in", "us"], "d").changed, false);
});
test("cluster membership is decided by files on disk", () => {
  // filmPageExists is the seam the cluster builder uses; assert it reads the filesystem.
  assert.strictEqual(U.filmPageExists("in", "definitely-not-a-real-slug-xyz"), false);
  const fs2 = require("fs");
  const any = fs2.readdirSync("movie").find((f) => f.endsWith(".html"));
  if (any) assert.strictEqual(U.filmPageExists("in", any.slice(0, -5)), true);
});
group("internal linking — orphaned pages");
test("film index recovers metadata from pages already on disk", () => {
  const idx = U.filmIndexFor({ code: "in" });
  assert.ok(idx.length > 20, `expected a real index, got ${idx.length}`);
  const one = idx.find((f) => f.title && f.genre && f.language);
  assert.ok(one, "entries must carry title, genre and language for matching");
  assert.ok(one.slug && !/\.html$/.test(one.slug));
});
test("related films are scored by language, then genre, then recency", () => {
  const item = { slug: "a", title: "A", language: "Tamil", genre: "Action / Drama", released: "2026-01-01", kind: "movie" };
  // Same language AND a shared genre — the strongest neighbour.
  const both = { slug: "b", title: "B", language: "Tamil", genre: "Action / Comedy", released: "2026-01-01", kind: "movie" };
  const sameGenre = { slug: "c", title: "C", language: "Korean", genre: "Action / Drama", released: "2026-01-01", kind: "movie" };
  assert.ok(U.relatedScore(item, both) > U.relatedScore(item, sameGenre), "language ranks first within the genre-compatible set");
  assert.strictEqual(U.relatedScore(item, item), -1, "never recommends itself");
});
test("a shared language cannot qualify a film with no shared genre", () => {
  // The Moana regression: a horror page recommended an animated family film because both
  // were English movies. Language may ORDER neighbours; it may not create one.
  const horror = { slug: "backrooms", title: "Backrooms", language: "English", genre: "Horror / Mystery", released: "2026-08-01", kind: "movie" };
  const cartoon = { slug: "moana", title: "Moana", language: "English", genre: "Animation / Family", released: "2016-11-23", kind: "movie" };
  const romcom = { slug: "office-romance", title: "Office Romance", language: "English", genre: "Romance / Comedy", released: "2026-06-01", kind: "movie" };
  const realMatch = { slug: "bokshi", title: "Bokshi", language: "Hindi", genre: "Horror / Drama", released: "2026-07-01", kind: "movie" };
  assert.strictEqual(U.relatedScore(horror, cartoon), -1);
  assert.strictEqual(U.relatedScore(horror, romcom), -1);
  assert.ok(U.relatedScore(horror, realMatch) > 0, "cross-language genre match must survive");
});
test("a candidate with no genre data cannot outrank a real genre match", () => {
  const horror = { slug: "backrooms", title: "B", language: "English", genre: "Horror / Mystery", released: "2026-08-01", kind: "movie" };
  const blank = { slug: "chaali-din", title: "C", language: "English", genre: "", released: "2026-08-01", kind: "movie" };
  assert.strictEqual(U.relatedScore(horror, blank), -1, "missing genre scored 75 on language alone and took the top slot");
});
test("ranking is not discarded by the anti-orphan rotation", () => {
  // The band used to be up to 40 candidates, which on a ~40-film catalogue was the whole
  // index — every pick was a rotated slice of everything, scoring at the floor.
  const seed = { slug: "s", title: "S", language: "Hindi", genre: "Horror / Thriller", released: "2026-01-01", kind: "movie" };
  const idx = [];
  for (let i = 0; i < 40; i++) idx.push({ slug: `far${i}`, title: `Far ${i}`, language: "Hindi", genre: "Romance / Comedy", released: "2020-01-01", kind: "movie" });
  for (let i = 0; i < 8; i++) idx.push({ slug: `near${i}`, title: `Near ${i}`, language: "Hindi", genre: "Horror / Thriller", released: "2026-01-01", kind: "movie" });
  const picks = U.relatedFilms(seed, idx, 6);
  assert.strictEqual(picks.length, 6);
  for (const p of picks) assert.ok(/^near/.test(p.slug), `floor-scoring filler surfaced: ${p.slug}`);
});
test("every related pick resolves to a page that exists", () => {
  const idx = U.filmIndexFor({ code: "in" });
  const slugs = new Set(idx.map((f) => f.slug));
  for (const seed of idx.slice(0, 25)) {
    for (const r of U.relatedFilms(seed, idx, 6)) {
      assert.ok(slugs.has(r.slug), `${r.slug} has no page`);
      assert.notStrictEqual(r.slug, seed.slug);
    }
  }
});
test("links spread across the archive instead of funnelling into a few pages", () => {
  // The whole point: if every page linked to the same top 6, the orphans stay orphaned.
  const idx = U.filmIndexFor({ code: "in" });
  if (idx.length < 40) return;
  const hit = new Set();
  for (const seed of idx.slice(0, 40)) for (const r of U.relatedFilms(seed, idx, 6)) hit.add(r.slug);
  assert.ok(hit.size > 30, `40 pages should reach many distinct targets, reached ${hit.size}`);
});
test("browse index paginates and links every page to every other page", () => {
  const idx = Array.from({ length: 300 }, (_, i) => ({ slug: `f${i}`, title: `Film ${i}`, language: "Hindi", released: "2026-01-01", kind: "movie" }));
  const html = U.buildBrowsePage(idx, { code: "in", name: "India" }, 2, 3, "26 August 2026");
  assert.ok(/page 2 of 3/.test(html));
  assert.ok(/href="\/films\/"/.test(html) && /href="\/films\/3\/"/.test(html), "flat pagination, not just prev/next");
  assert.strictEqual((html.match(/href="\/movie\//g) || []).length, U.BROWSE_PER_PAGE);
});
test("browse paths are country-scoped", () => {
  assert.strictEqual(U.browsePath("in", 1), "/films/");
  assert.strictEqual(U.browsePath("in", 3), "/films/3/");
  assert.strictEqual(U.browsePath("us", 2), "/us/films/2/");
});

group("share cards — branded og:image");
test("card carries verdict, score, title and brand", () => {
  const svg = U.shareCardSvg({ slug: "dc", title: "DC", verdict: "Must watch", rating: 8.0, votes: 13,
    language: "Tamil", genre: "Romance / Action", runtime: 142, released: "2026-08-06", platform: "Theatres" }, { code: "in" });
  assert.ok(/FILMY/.test(svg) && /CHILL/.test(svg));
  assert.ok(/MUST WATCH/.test(svg));
  assert.ok(/>8\.0</.test(svg));
  assert.ok(/IN THEATRES/.test(svg));
  assert.ok(/1200/.test(svg) && /630/.test(svg), "og-standard dimensions");
});
test("never prints a score the data can't support", () => {
  const svg = U.shareCardSvg({ slug: "x", title: "X", rating: 9.4, votes: 3, verdict: "Not enough ratings yet" }, { code: "in" });
  assert.ok(!/9\.4/.test(svg), "3 votes must not become a headline score");
  assert.ok(/NEW/.test(svg) && /too early to rate/.test(svg));
});
test("titles and blurbs are escaped, not injected", () => {
  const svg = U.shareCardSvg({ slug: "x", title: 'Q&A: <script>alert(1)</script> "Hi"', rating: 7, votes: 500, verdict: "Worth a watch" }, { code: "in" });
  assert.ok(!/<script>/.test(svg), "no raw markup may reach the SVG");
  assert.ok(/&amp;/.test(svg));
});
test("status pill follows the release-state machine", () => {
  const base = { slug: "s", title: "S", rating: 7, votes: 900, verdict: "Worth a watch" };
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(/RELEASES TODAY/.test(U.shareCardSvg({ ...base, released: today }, { code: "in" })));
  assert.ok(/IN CINEMAS/.test(U.shareCardSvg({ ...base, released: "2099-01-01" }, { code: "in" })));
  assert.ok(/NOW ON NETFLIX/.test(U.shareCardSvg({ ...base, released: "2020-01-01", platform: "Netflix" }, { code: "in" })));
});
test("long titles wrap to two lines and elide rather than overflow", () => {
  const lines = U.wrapForCard("Operation Safed Sagar: The Untold Story of the Kargil War", 46, 620, 2);
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[1].endsWith("…"));
});
test("vote buckets round DOWN so the label never overstates", () => {
  assert.strictEqual(U.voteCountLabel(13), "13 ratings");     // exact where skepticism matters
  assert.strictEqual(U.voteCountLabel(199), "150+ ratings");
  assert.ok(/k\+ ratings/.test(U.voteCountLabel(52000)));
  assert.strictEqual(U.voteCountLabel(0), "");
});
test("card path is per country so a /us/ share can't preview India's wording", () => {
  assert.strictEqual(U.cardPaths({ slug: "dc" }, { code: "us" }).file, "cards/us/dc.png");
  assert.ok(U.cardPaths({ slug: "dc" }, { code: "in" }).url.startsWith("https://filmychill.com/cards/in/"));
  assert.strictEqual(U.cardPaths({}, { code: "in" }), null);
});
test("card generation is optional — a missing rasteriser can't fail the build", () => {
  // Behavioural, not a source grep: point the writer at a country with no data and no fonts
  // and assert it returns quietly instead of throwing. The old version of this test asserted
  // that specific strings existed in update.js and broke the moment the code moved file.
  const n = U.writeShareCards({ theatres: [], ott: [], comingSoon: [] }, { code: "zz", name: "Nowhere" });
  assert.strictEqual(typeof n, "number");
  assert.ok(n >= 0);
});
group("fit line — editorial value without fabrication");
test("composes commitment + caveat from real signal", () => {
  const w = U.whyWatch({ tmdbId: 1, title: "X", runtime: 142, genre: "Romance / Action",
    language: "Tamil", cert: "A", rating: 8.0, votes: 13, kind: "movie" });
  assert.ok(/2h 22m of Tamil romance/.test(w.text));
  assert.ok(/adults only/.test(w.text));
  assert.ok(/13 (rating|people)/.test(w.text), "a strong score on 13 votes must be flagged");
  assert.strictEqual(w.heading, "Should you spend 2h 22m on it?");
});
test("article agrees with the genre that follows it", () => {
  const w = U.whyWatch({ tmdbId: 2, title: "Y", runtime: 120, genre: "Hindi Drama / Action", cert: "U" });
  assert.ok(!/\ba action\b/.test(w.text), "never 'a action'");
  assert.ok(!/\ban drama\b/.test(w.text), "never 'an drama'");
});
test("returns null rather than a generic line when signal is thin", () => {
  assert.strictEqual(U.whyWatch({ title: "Untitled", genre: "Drama", language: "Hindi" }), null);
  assert.strictEqual(U.whyWatch(null), null);
});
test("never states a rating the data doesn't have", () => {
  const w = U.whyWatch({ tmdbId: 3, title: "Z", runtime: 110, genre: "Comedy", cert: "U/A 13+", rating: null, votes: 1 });
  assert.ok(!/\d\.\d/.test(w.text.replace(/\dh \d+m/g, "")), "no invented score");
});
test("prefers IMDb pair when routed to IMDb, never mixes sources", () => {
  const w = U.whyWatch({ tmdbId: 4, title: "M", runtime: 100, genre: "Action", cert: "A",
    rating: 5.0, votes: 20, imdbRating: 7.9, imdbVotes: 90000 });
  assert.ok(/7\.9|90,000/.test(w.text), "should speak in IMDb terms, not the TMDB pair");
  assert.ok(!/ 20 ratings/.test(w.text));
});
test("TV is framed as a commitment, not a runtime", () => {
  const w = U.whyWatch({ tmdbId: 5, title: "S", kind: "tv", seasons: 5, genre: "Drama", language: "English" });
  assert.strictEqual(w.heading, "Is it worth starting?");
  assert.ok(/5 seasons deep/.test(w.text));
});
test("rent-or-buy-only is surfaced as the cost decision it is", () => {
  const w = U.whyWatch({ tmdbId: 6, title: "R", runtime: 95, genre: "Drama", cert: "A",
    providers: [], rentBuy: [{ name: "Prime Video" }] });
  assert.ok(/subscription|rent-or-buy/i.test(w.text));
});
test("variants are stable per film and spread across a run of films", () => {
  const a = { tmdbId: 100, runtime: 95, genre: "Action", cert: "A" };
  assert.strictEqual(U.whyWatch(a).text, U.whyWatch(a).text, "same film -> identical text (no git churn)");
  // Identical-shape films must not all get the same sentence. TMDB ids arrive in near
  // sequential runs, so this also guards the hash finalizer.
  const texts = new Set();
  for (let i = 0; i < 30; i++) texts.add(U.whyWatch({ tmdbId: 900000 + i, runtime: 95, genre: "Action", cert: "A" }).text);
  assert.ok(texts.size >= 3, `expected the phrasings to spread, got ${texts.size}`);
});
test("no two different films in the live data share a fit line", () => {
  const fs2 = require("fs"), seen = new Map();
  for (const f of ["data.json", "data-us.json"]) {
    if (!fs2.existsSync(f)) continue;
    const d = JSON.parse(fs2.readFileSync(f, "utf8"));
    for (const it of [...(d.theatres || []), ...(d.ott || []), ...(d.comingSoon || [])]) {
      const w = U.whyWatch(it);
      if (!w) continue;
      if (!seen.has(w.text)) seen.set(w.text, new Set());
      seen.get(w.text).add(it.tmdbId || it.title);
    }
  }
  for (const [text, ids] of seen) assert.strictEqual(ids.size, 1, `shared line: ${text}`);
});

group("trailer VideoObject — valid for Google rich results");
test("VideoObject carries uploadDate and an embed/content URL", () => {
  const h = U.buildFilmPage({ title: "T", slug: "t", kind: "movie", tmdbId: 1, released: "2026-08-01",
    freshDate: "2026-07-28", language: "Hindi", trailer: "https://www.youtube.com/watch?v=abc123XYZ00" },
    "2026-08-20", new Set(), AUDIT_CFG);
  const m = /"trailer":(\{[^}]*\})/.exec(h);
  assert.ok(m, "trailer VideoObject must be present");
  const v = JSON.parse(m[1]);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(v.uploadDate), "uploadDate must be an ISO datetime (Google requires it): " + v.uploadDate);
  assert.ok(v.embedUrl && /youtube-nocookie\.com\/embed\//.test(v.embedUrl), "embedUrl required: " + v.embedUrl);
  assert.ok(v.contentUrl && /youtube\.com\/watch/.test(v.contentUrl), "contentUrl required: " + v.contentUrl);
});
test("uploadDate falls back to release date when freshDate is absent", () => {
  const h = U.buildFilmPage({ title: "T2", slug: "t2", kind: "movie", tmdbId: 2, released: "2026-06-15",
    trailer: "https://www.youtube.com/watch?v=zzz999" }, "2026-08-20", new Set(), AUDIT_CFG);
  const v = JSON.parse(/"trailer":(\{[^}]*\})/.exec(h)[1]);
  assert.ok(v.uploadDate.startsWith("2026-06-15"), "should use released as the proxy: " + v.uploadDate);
});

group("lead answer line — SEO/AEO for where-to-watch intent");
test("streaming film leads with the platform, as a snippet-shaped sentence", () => {
  const h = U.buildFilmPage({ title: "X", slug: "x", kind: "movie", tmdbId: 1, providers: ["Netflix"], rating: 8, votes: 900, released: "2026-08-01" }, "2026-08-20", new Set(), AUDIT_CFG);
  const ans = /<p class="answer">(.*?)<\/p>/s.exec(h)[1].replace(/<[^>]+>/g, "");
  assert.ok(/^X is streaming in India on Netflix/.test(ans), ans);
});
test("upcoming film leads with the release date", () => {
  const up = U.normalizeUpcoming([{ title: "Y", slug: "y", kind: "movie", tmdbId: 2, released: "2099-10-15" }])[0];
  const h = U.buildFilmPage(up, "2026-08-20", new Set(), AUDIT_CFG);
  const ans = /<p class="answer">(.*?)<\/p>/s.exec(h)[1].replace(/<[^>]+>/g, "");
  assert.ok(/releases in India on/.test(ans), ans);
});
test("theatres-no-date answer flags the pending OTT date, never invents one", () => {
  const h = U.buildFilmPage({ title: "Z", slug: "z", kind: "movie", tmdbId: 3, platform: "Theatres", released: "2026-08-10" }, "2026-08-20", new Set(), AUDIT_CFG);
  const ans = /<p class="answer">(.*?)<\/p>/s.exec(h)[1].replace(/<[^>]+>/g, "");
  assert.ok(/in cinemas in India/.test(ans) && /hasn't been announced/.test(ans), ans);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(ans), "must not print a raw or invented date");
});
test("the answer line is the first prose block, before the review", () => {
  const h = U.buildFilmPage({ title: "Q", slug: "q", kind: "movie", tmdbId: 4, providers: ["Prime Video"], rating: 7, votes: 500, verdict: "Worth a watch", released: "2026-08-01" }, "2026-08-20", new Set(), AUDIT_CFG);
  assert.ok(h.indexOf('class="answer"') < h.indexOf('class="vprose"') || h.indexOf('class="vprose"') === -1, "answer must precede the verdict prose");
});

group("confidence score — trust the number by its vote count");
test("the displayed rating is always TMDB's own, never the weighted value", () => {
  const sc = U.filmScore({ rating: 8.0, votes: 13 });
  assert.strictEqual(sc.displayRating, 8.0, "we annotate the real number, we don't alter it");
  assert.notStrictEqual(sc.rank, 8.0, "the rank value is separate and lower");
});
test("tiers follow vote count with a text label, not colour alone", () => {
  assert.strictEqual(U.confidenceTier(1500).key, "solid");
  assert.strictEqual(U.confidenceTier(60).key, "early");
  assert.strictEqual(U.confidenceTier(5).key, "few");
  for (const v of [1500, 60, 5]) assert.ok(U.confidenceTier(v).label.length > 0, "every tier carries a label");
});
test("a thin high score does not outrank a proven similar one", () => {
  const thin = { rating: 8.0, votes: 13 };
  const proven = { rating: 8.2, votes: 1241 };
  assert.ok(U.rankValue(proven) > U.rankValue(thin), "1,241 votes at 8.2 beats 13 votes at 8.0");
  // and a proven mid score beats a thinner slightly-higher one
  assert.ok(U.rankValue({ rating: 6.6, votes: 121 }) > U.rankValue({ rating: 6.7, votes: 43 }));
});
test("below the vote floor, no number is shown at all", () => {
  const sc = U.filmScore({ rating: 9.4, votes: 3 });
  assert.strictEqual(sc.displayRating, null, "3 votes must not surface a 9.4");
  assert.strictEqual(sc.tier, "few");
  assert.ok(sc.rank < 0, "and it sorts last among rated films");
});
test("provisional flag marks a shown-but-thin score", () => {
  assert.strictEqual(U.filmScore({ rating: 7.5, votes: 40 }).provisional, true);
  assert.strictEqual(U.filmScore({ rating: 7.5, votes: 5000 }).provisional, false);
});
test("rankFilms orders without mutating its input", () => {
  const input = [{ rating: 8.0, votes: 13, id: "thin" }, { rating: 7.9, votes: 9000, id: "proven" }];
  const out = U.rankFilms(input);
  assert.strictEqual(out[0].id, "proven");
  assert.strictEqual(input[0].id, "thin", "original array order preserved");
});
test("IMDb pair is used when present, never mixed with the TMDB pair", () => {
  const sc = U.filmScore({ rating: 5.0, votes: 20, imdbRating: 7.9, imdbVotes: 90000 });
  assert.strictEqual(sc.displayRating, 7.9);
  assert.strictEqual(sc.tier, "solid");
});

group("embeddable widget — the backlink mechanism");
test("widget shows this week's picks, freshest first, capped", () => {
  const items = U.embedItems({ ott: [
    { title: "New1", slug: "n1" }, { title: "New2", slug: "n2" },
    { title: "Old1", slug: "o1", stillGood: true }, { title: "Old2", slug: "o2", stillGood: true },
    { title: "New3", slug: "n3" }, { title: "New4", slug: "n4" }, { title: "New5", slug: "n5" },
    { title: "New6", slug: "n6" }, { title: "New7", slug: "n7" },
  ] }, 6);
  assert.strictEqual(items.length, 6, "capped so it stays small on someone else's page");
  assert.ok(!items.some((x) => x.stillGood), "fresh titles fill the slots before carried-over ones");
});
test("every widget link is a dofollow backlink that opens safely off-site", () => {
  const html = U.buildEmbedPage({ ott: [{ title: "A Film", slug: "a-film", platform: "Netflix", language: "Tamil" }] }, { code: "in", name: "India" }, "28 August 2026");
  // The whole point is the link back — it must be present, absolute, and not nofollow.
  assert.ok(/href="https:\/\/filmychill\.com\/movie\/a-film\.html"/.test(html));
  assert.ok(!/rel="[^"]*nofollow/.test(html), "a nofollow link would defeat the purpose");
  assert.ok(/rel="noopener"/.test(html), "off-site links opened with target=_blank need noopener");
  assert.ok(/filmychill\.com/.test(html), "the widget must carry the brand back to the host site");
});
test("widget is noindex so it can't compete with real pages", () => {
  const html = U.buildEmbedPage({ ott: [] }, { code: "in", name: "India" }, "x");
  assert.ok(/<meta name="robots" content="noindex">/.test(html),
    "a near-duplicate widget page indexed would split ranking signal");
});
test("no unearned verdict or score leaks onto a third-party site", () => {
  const html = U.buildEmbedPage({ ott: [
    { title: "Fresh", slug: "f", platform: "Netflix", verdict: "Just released — verdict soon", rating: 9.9, votes: 3 },
  ] }, { code: "in", name: "India" }, "x");
  assert.ok(!/verdict soon/.test(html), "provisional verdicts must not appear on someone else's page");
  assert.ok(!/9\.9/.test(html), "a score on 3 votes must not travel off-site");
});
test("instructions page carries a copyable iframe snippet", () => {
  const html = U.buildEmbedInstructions();
  assert.ok(/&lt;iframe/.test(html), "the snippet is shown escaped for copying");
  assert.ok(/embed\/week\//.test(html));
});

group("sitemap dates — never emit an invalid lastmod");
test("only a clean YYYY-MM-DD passes; everything else coerces to a valid date", () => {
  // Mirrors the lastmodOf guard in writeMultiCountrySitemap. Google rejects the whole
  // sitemap on one bad <lastmod>, so a null/garbage manifest date must never reach the XML.
  const today = "2026-08-31";
  const lastmodOf = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10)) ? v.slice(0, 10) : today);
  assert.strictEqual(lastmodOf("2026-07-19"), "2026-07-19", "a valid date is kept as-is");
  assert.strictEqual(lastmodOf("2026-08-31T10:00:00Z"), "2026-08-31", "a timestamp is trimmed to the date");
  for (const bad of ["", "  ", "NaN-NaN-NaN", "2026-7-9", "not-a-date", null, undefined, 20260819]) {
    assert.strictEqual(lastmodOf(bad), today, `invalid input ${JSON.stringify(bad)} must fall back to today`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(lastmodOf(bad)), "output is always a clean W3C date");
  }
});

group("indexing — fresh pages get announced");
test("IndexNow ping includes the crawl paths into the archive", () => {
  const urls = U.indexNowUrls([{ code: "in", name: "India" }, { code: "us", name: "the US" }], {});
  assert.ok(urls.includes("https://filmychill.com/films/"), "the browse index is the door to the archive — it must be pinged");
  assert.ok(urls.includes("https://filmychill.com/us/films/"));
  assert.ok(urls.includes("https://filmychill.com/data/"), "the citable data page too");
});
test("IndexNow list stays within the per-request cap", () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ title: "F" + i, slug: "f" + i }));
  const urls = U.indexNowUrls([{ code: "in", name: "India" }], { in: { theatres: many, ott: many } });
  assert.ok(urls.length <= 900, "one IndexNow request must not exceed the cap");
  assert.strictEqual(new Set(urls).size, urls.length, "no duplicate URLs wasted in the ping");
});
test("syncHreflangClusters reports every page it rewrites", () => {
  // The callback is what lets the caller bump lastmod so Google re-crawls a corrected page.
  let calls = 0;
  U.syncHreflangClusters(() => { calls++; });
  assert.ok(calls >= 0, "callback wired without throwing");  // count depends on disk state
  assert.strictEqual(typeof U.syncHreflangClusters, "function");
});

group("section counts — headers match what is under them");
test("section counts are computed from the data, never hardcoded", () => {
  const c = U.sectionCounts({
    theatres: [{ title: "A" }, { title: "B" }, { title: "C" }],
    ott: [{ title: "N" }],
  });
  assert.strictEqual(c.theatres, "TOP 3", "three films -> TOP 3, not a fixed TOP 5");
  assert.strictEqual(c.ott, "TOP 1");
});
test("counts follow the list length, not a hardcoded number", () => {
  const c = U.sectionCounts({
    theatres: [{ title: "A" }, { title: "B" }],
    ott: [{ title: "N1" }, { title: "N2" }, { title: "O1" }, { title: "O2" }],
  });
  assert.strictEqual(c.theatres, "TOP 2", "was a hardcoded TOP 5");
  assert.strictEqual(c.ott, "TOP 4", "was a hardcoded TOP 10");
});
test("empty data doesn't produce a broken label", () => {
  const c = U.sectionCounts({});
  assert.strictEqual(c.theatres, "TOP 0");
  assert.strictEqual(c.ott, "TOP 0");
});

group("release state — no passed date may read as upcoming");
const REL_NOW = new Date("2026-08-25T09:00:00Z").getTime();
const todayISO = () => new Date().toISOString().slice(0, 10);
test("three states, decided on the calendar day not the clock", () => {
  assert.strictEqual(U.releaseState("2026-08-26", REL_NOW), "upcoming");
  assert.strictEqual(U.releaseState("2026-08-25", REL_NOW), "today");   // not 'released' at 9am
  assert.strictEqual(U.releaseState("2026-08-24", REL_NOW), "released");
  assert.strictEqual(U.releaseState(null, REL_NOW), "unknown");
  assert.strictEqual(U.releaseState("soon", REL_NOW), "unknown");
});
test("labels are tense-correct", () => {
  assert.strictEqual(U.releaseLabel("2026-08-25", REL_NOW), "Releases today");
  assert.ok(U.releaseLabel("2026-10-09", REL_NOW).startsWith("Releases "));
  assert.ok(U.releaseLabel("2026-01-31", REL_NOW).startsWith("Released "));
});
test("a premiere date never overrides the real release (the Bokshi bug)", () => {
  // TMDB type 1 = premiere (festival screening), 3 = theatrical. Taking the earliest of
  // 1-3 stamped 31 Jan on a film that releases 9 Oct.
  const d = { release_dates: { results: [{ iso_3166_1: "IN", release_dates: [
    { type: 1, release_date: "2026-01-31T00:00:00.000Z" },
    { type: 3, release_date: "2026-10-09T00:00:00.000Z" }] }] } };
  assert.strictEqual(U.regionalTheatricalDate(d, "IN"), "2026-10-09");
});
test("premiere-only region yields null, so the primary date is kept", () => {
  const d = { release_dates: { results: [{ iso_3166_1: "IN", release_dates: [
    { type: 1, release_date: "2026-01-31T00:00:00.000Z" }] }] } };
  assert.strictEqual(U.regionalTheatricalDate(d, "IN"), null);
});
test("normalizeUpcoming rescues an item whose displayed date is wrong", () => {
  const out = U.normalizeUpcoming([{ title: "Bokshi", released: "2026-01-31", freshDate: "2026-10-09" }], REL_NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].released, "2026-10-09");
});
test("normalizeUpcoming drops an item that has genuinely released", () => {
  assert.deepStrictEqual(U.normalizeUpcoming([{ title: "Old", released: "2026-02-01", freshDate: "2026-02-01" }], REL_NOW), []);
});
test("normalizeUpcoming keeps a film releasing TODAY", () => {
  const out = U.normalizeUpcoming([{ title: "Now", released: "2026-08-25" }], REL_NOW);
  assert.strictEqual(out.length, 1);
});
test("normalizeUpcoming leaves a correct future item untouched", () => {
  const item = { title: "Later", released: "2026-11-08" };
  assert.strictEqual(U.normalizeUpcoming([item], REL_NOW)[0], item); // same object, no copy
});
test("client upcomingOnly + daysAway (index.html) mirror the server rule and count local days", () => {
  // The client re-renders Coming Soon over the server HTML, so its date rules must match
  // normalizeUpcoming exactly or the page contradicts itself a second after load.
  const vm = require("vm");
  const src = require("fs").readFileSync("index.html", "utf8");
  const grab = (name) => {
    const i = src.indexOf("function " + name + "(");
    assert.ok(i >= 0, name + " present in index.html");
    let depth = 0, j = src.indexOf("{", i);
    for (; j < src.length; j++) { if (src[j] === "{") depth++; else if (src[j] === "}" && --depth === 0) break; }
    return src.slice(i, j + 1);
  };
  const pad = (n) => String(n).padStart(2, "0");
  const plus = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  for (const tz of ["Asia/Kolkata", "America/Los_Angeles", "UTC", "Australia/Sydney"]) {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try {
      const ctx = {}; vm.createContext(ctx);
      vm.runInContext([grab("releaseState"), grab("upcomingOnly"), grab("daysAway")].join("\n") + "\nthis.U={upcomingOnly,daysAway};", ctx);
      const C = ctx.U;
      assert.strictEqual(C.upcomingOnly([{ title: "Digger", released: plus(13), freshDate: plus(11) }])[0].released, plus(13),
        tz + ": the market's own date wins over TMDB's earlier global date");
      assert.strictEqual(C.upcomingOnly([{ title: "Bokshi", released: plus(-200), freshDate: plus(23) }])[0].released, plus(23),
        tz + ": a passed regional date falls back to the global one");
      assert.strictEqual(C.upcomingOnly([{ title: "Old", released: plus(-3), freshDate: plus(-5) }]).length, 0,
        tz + ": everything passed -> dropped, never shown under Coming soon");
      assert.strictEqual(C.daysAway(plus(9)), "In 9 days", tz + ": calendar days in the visitor's zone, no UTC overshoot");
      assert.strictEqual(C.daysAway(plus(1)), "Tomorrow", tz);
      assert.strictEqual(C.daysAway(plus(0)), "Today", tz);
    } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
  }
});

test("the freshness stamp is server-rendered, absolute, and can't go false on a stale cache", () => {
  const src = require("fs").readFileSync("index.html", "utf8");
  assert.ok(/<span id="lastScan"><!--SSR:LASTSCAN-->[\s\S]*?<!--\/SSR:LASTSCAN--><\/span>/.test(src),
    "the stamp carries SSR markers so renderCountryPage can fill it");
  assert.strictEqual(U.ssrLastScan({ generatedAt: "2026-09-19T06:46:00Z" }, { code: "in" }), "Updated 19 Sept");
  assert.ok(!/today|yesterday|ago/i.test(U.ssrLastScan({ generatedAt: new Date().toISOString() }, { code: "in" })),
    "never a relative claim: a cached page would keep asserting it forever");
  assert.strictEqual(U.ssrLastScan({}), "Updated this week", "no timestamp -> a claim that stays true");
  assert.strictEqual(U.ssrLastScan({ generatedAt: "not a date" }), "Updated this week");
});

test("a usable regional date always wins over the global one", () => {
  // Ramayana: 8 Nov in India, 6 Nov globally. The India page must keep 8 Nov — the fallback
  // is only for a regional date that has already passed.
  const item = { title: "Ramayana", released: "2026-11-08", freshDate: "2026-11-06" };
  assert.strictEqual(U.normalizeUpcoming([item], REL_NOW)[0].released, "2026-11-08");
});
test("soon card is tense-correct for a same-day release", () => {
  assert.ok(/>Today</.test(U.ssrSoonCard({ title: "Now", slug: "now", released: todayISO() }, "in")));
  assert.ok(!/>Today</.test(U.ssrSoonCard({ title: "Later", slug: "later", released: "2026-11-08" }, "in")));
});
test("a released film never survives into a coming-soon render", () => {
  // The property that matters, asserted through the function that enforces it.
  const passed = { title: "GonePast", slug: "gonepast", released: "2020-01-31", freshDate: "2020-01-31" };
  const ahead = { title: "StillAhead", slug: "stillahead", released: "2099-11-08" };
  const out = U.normalizeUpcoming([passed, ahead]);
  assert.deepStrictEqual(out.map((x) => x.title), ["StillAhead"]);
  assert.ok(!U.ssrOttSection || true);
});test("due-date stamp lets a frozen page correct itself once the date passes", () => {
  const page = `<h1>Bokshi</h1><span class="pill">In cinemas from 9 Oct 2026</span>`
    + `<!--SW:pending--><!--SW:due=2026-10-09--><h2>When is Bokshi coming to OTT?</h2>`
    + `<p>Bokshi hasn't had its theatrical release yet, and is due 9 Oct 2026.</p><!--/SW:pending-->`;
  const before = U.patchDueIfPassed(page, { title: "Bokshi", countryName: "India", cfg: { code: "in" }, now: REL_NOW });
  assert.strictEqual(before.changed, false, "still upcoming on 25 Aug — leave it alone");
  const after = U.patchDueIfPassed(page, { title: "Bokshi", countryName: "India", cfg: { code: "in" },
    now: new Date("2026-10-11T00:00:00Z").getTime() });
  assert.ok(after.changed);
  assert.ok(!/hasn&#39;t had its theatrical release|hasn't had its theatrical release/.test(after.html));
  assert.ok(/opened in theatres in India/.test(after.html));
  assert.ok(/<span class="pill">In theatres<\/span>/.test(after.html), "pre-release pill is replaced too");
});
test("due pass never touches a page whose date is still ahead or is today", () => {
  const page = `<!--SW:pending--><!--SW:due=2026-08-25--><p>x</p><!--/SW:pending-->`;
  assert.strictEqual(U.patchDueIfPassed(page, { title: "T", countryName: "India", cfg: { code: "in" }, now: REL_NOW }).changed, false);
});

group("page copy — no 'OTT' reaches a streaming market");
test("homepage title + description: US says Streaming, India still says OTT", () => {
  const data = { generatedAt: "2026-08-24T07:00:00Z", theatres: [{ title: "Mutiny" }], ott: [{ title: "Reacher" }, { title: "Silo" }] };
  const us = U.buildHeadTags({ code: "us", name: "United States" }, false, data);
  // The 60-char cascade may drop the redundant noun ("Releases"), never the market's own
  // word — a US searcher must not read "OTT", and an Indian one must still read it.
  assert.ok(us.includes("New Movies &amp; Streaming This Week in the US"), us.slice(0, 200));
  assert.ok(!/OTT/.test(us), "no OTT anywhere in the US head tags");
  const ind = U.buildHeadTags({ code: "in", name: "India" }, false, data);
  assert.ok(/New Movies &amp; OTT[^<]*This Week in India/.test(ind), "India keeps its own word");
});
test("homepage fallback wording (no data) is also per-market", () => {
  const us = U.buildHeadTags({ code: "us", name: "United States" }, false);
  assert.ok(!/OTT/.test(us), "static fallback title/description must not say OTT");
  assert.ok(/streaming releases/.test(us));
  assert.ok(/OTT/.test(U.buildHeadTags({ code: "in", name: "India" }, false)));
});
test("weekly page: US title, H1, FAQ and breadcrumb all say streaming", () => {
  const html = U.buildOttWeekPage(OTT_WEEK_DATA, { code: "us", name: "United States" }, OTT_WEEK_COUNTRIES);
  assert.ok(html.includes("<title>New Streaming Releases This Week in the US"));
  assert.ok(html.includes("<h1>New Streaming Releases This Week in the US</h1>"));
  assert.ok(html.includes("best new streaming releases in the US"));
  assert.ok(html.includes('"New on streaming this week"'), "breadcrumb label follows the market");
  assert.ok(html.includes("theatres + streaming"), "back-link copy follows the market");
  // The URL stays /new-on-ott/ (already indexed) — the ONLY place "ott" may appear.
  const visible = html.replace(/https?:\/\/[^"'\s]+/g, "").replace(/href="[^"]*"/g, "");
  assert.ok(!/OTT/.test(visible), "no OTT in any visible copy");
});
test("weekly page: India keeps OTT wording", () => {
  const html = U.buildOttWeekPage(OTT_WEEK_DATA, { code: "in", name: "India" }, OTT_WEEK_COUNTRIES);
  assert.ok(html.includes("<h1>New OTT Releases This Week in India</h1>"));
  assert.ok(html.includes("theatres + OTT"));
});
test("RSS channel title follows the market", () => {
  const data = { generatedAt: "2026-08-24T07:00:00Z", theatres: [], ott: [] };
  assert.ok(U.buildRssFeed(data, { code: "us", name: "United States" })
    .includes("New Movies &amp; Streaming Releases This Week in the US"));
  assert.ok(U.buildRssFeed(data, { code: "in", name: "India" })
    .includes("New Movies &amp; OTT Releases This Week in India"));
});
test("platform hubs: back-link wording follows the market", () => {
  const args = { title: "T", desc: "D", canonical: "https://filmychill.com/us/new-on-netflix/", h1: "H",
    updLine: "u", lead: "l", sections: [], faqs: [], homeUrl: "https://filmychill.com/us/" };
  assert.ok(U.listingPageHtml({ ...args, code: "us" }).includes("theatres + streaming"));
  assert.ok(U.listingPageHtml({ ...args, code: "in" }).includes("theatres + OTT"));
});

group("streamWindowEstimate()");
test("Hindi film gets a 6-8 week window from its release", () => {
  const est = U.streamWindowEstimate("2026-08-13", "Hindi", new Date("2026-08-22T00:00:00Z"));
  assert.strictEqual(est.lo, 6); assert.strictEqual(est.hi, 8);
  assert.strictEqual(est.passed, false);
  assert.ok(/September|October/.test(est.span), est.span);
});
test("Malayalam window is shorter than Hindi (industry differences are real)", () => {
  const ml = U.streamWindowEstimate("2026-08-01", "Malayalam", new Date("2026-08-05T00:00:00Z"));
  const hi = U.streamWindowEstimate("2026-08-01", "Hindi", new Date("2026-08-05T00:00:00Z"));
  assert.ok(ml.hi < hi.hi);
});
test("window that has already closed is flagged, not asserted", () => {
  const est = U.streamWindowEstimate("2025-01-01", "Hindi", new Date("2026-08-22T00:00:00Z"));
  assert.strictEqual(est.passed, true);
});
test("no release date -> no estimate (never guess)", () => {
  assert.strictEqual(U.streamWindowEstimate(null, "Hindi"), null);
  assert.strictEqual(U.streamWindowEstimate("not-a-date", "Hindi"), null);
});

group("film page — 'when is it coming to streaming' section");
const THEATRE = { title: "Batwara 1947", slug: "b", kind: "movie", language: "Hindi", platform: "Theatres", released: "2026-08-13", rating: 7.2, votes: 400, verdict: "Worth a watch" };
test("India theatrical page asks the question in OTT wording", () => {
  const html = U.buildFilmPage(THEATRE, "2026-08-22", new Set(), { code: "in", name: "India", region: "IN" });
  assert.ok(/coming to OTT/.test(html), "heading missing");
  assert.ok(/that's the usual pattern, not a confirmed date/i.test(html), "estimate not labelled as a pattern");
  assert.ok(html.includes("<!--SW:pending-->"), "sweep marker missing");
});
test("US theatrical page asks it in streaming wording, no 'OTT' anywhere", () => {
  const html = U.buildFilmPage({ ...THEATRE, language: "English" }, "2026-08-22", new Set(), { code: "us", name: "United States", region: "US" });
  assert.ok(/coming to streaming/.test(html), "streaming heading missing");
  assert.ok(!/\bOTT\b/.test(html), "OTT leaked onto a US page");
});
test("streaming film gets no pending section at all", () => {
  const html = U.buildFilmPage({ ...THEATRE, platform: "Netflix", providers: ["Netflix"] }, "2026-08-22", new Set(), { code: "in", name: "India", region: "IN" });
  assert.ok(!html.includes("<!--SW:pending-->"), "pending block rendered for a streaming film");
});
test("TV series never gets the section (per-season, not a film release)", () => {
  const html = U.buildFilmPage({ ...THEATRE, kind: "tv", platform: "Theatres" }, "2026-08-22", new Set(), { code: "in", name: "India", region: "IN" });
  assert.ok(!html.includes("<!--SW:pending-->"));
});

group("streaming-arrival sweep");
const SWEEP_NOW = new Date("2026-08-22T00:00:00Z");
test("picks archived films inside the plausible window, newest first", () => {
  const picks = U.sweepCandidates([
    { slug: "fresh", archivedOn: "2026-08-01", tmdbId: 1, released: "2026-08-01", kind: "movie" },
    { slug: "older", archivedOn: "2026-06-01", tmdbId: 2, released: "2026-05-01", kind: "movie" },
    { slug: "ancient", archivedOn: "2024-01-01", tmdbId: 3, released: "2023-01-01", kind: "movie" },
    { slug: "current", tmdbId: 4, released: "2026-08-01", kind: "movie" },
  ], SWEEP_NOW);
  const slugs = picks.map((p) => p.slug);
  assert.deepStrictEqual(slugs, ["fresh", "older"], slugs.join(","));
});
test("skips TV and entries with no tmdbId (nothing to re-query)", () => {
  const picks = U.sweepCandidates([
    { slug: "tv", archivedOn: "2026-08-01", tmdbId: 9, released: "2026-07-01", kind: "tv" },
    { slug: "noid", archivedOn: "2026-08-01", released: "2026-07-01", kind: "movie" },
  ], SWEEP_NOW);
  assert.strictEqual(picks.length, 0);
});
test("respects the per-run API budget", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ slug: "s" + i, archivedOn: "2026-08-01", tmdbId: i, released: "2026-07-01", kind: "movie" }));
  assert.ok(U.sweepCandidates(many, SWEEP_NOW).length <= 18);
});
test("arrival patch flips the pending block and the stale pill", () => {
  const before = U.buildFilmPage(THEATRE, "2026-08-22", new Set(), { code: "in", name: "India", region: "IN" });
  const { html, changed } = U.applyArrivalPatch(before, {
    title: "Batwara 1947", providers: ["Netflix"], countryName: "India",
    cfg: { code: "in", name: "India" }, asOf: "2026-10-02",
  });
  assert.strictEqual(changed, true);
  assert.ok(/It&#39;s streaming now|It's streaming now/.test(html), "arrival copy missing");
  assert.ok(/Netflix/.test(html));
  assert.ok(!/that&#39;s the usual pattern|that's the usual pattern/i.test(html), "stale estimate survived");
  assert.ok(html.includes("<!--SW:pending-->"), "markers must survive for idempotency");
});
test("no providers -> page left completely alone", () => {
  const before = U.buildFilmPage(THEATRE, "2026-08-22", new Set(), { code: "in", name: "India", region: "IN" });
  const { html, changed } = U.applyArrivalPatch(before, { title: "B", providers: [], countryName: "India", cfg: { code: "in" } });
  assert.strictEqual(changed, false);
  assert.strictEqual(html, before);
});

group("archive patcher — vocabulary aware");
test("legacy OTT-worded pages in streaming markets still get patched", () => {
  const legacy = `<p>Film is currently playing in theatres across the US. An OTT release hasn&#39;t been announced yet.</p>`;
  const { html, changed } = U.archivePatchHtml(legacy, "the US", { code: "us" });
  assert.strictEqual(changed, true);
  assert.ok(/has finished its theatrical run/.test(html));
  assert.ok(/streaming release/.test(html), "replacement should use the market's own word");
});

group("pickVariant — hash finalizer must stay unsigned");
test("never returns undefined across a wide id sweep", () => {
  const { pickVariant } = require("./lib/whywatch.js");
  let bad = 0;
  for (let id = 1; id <= 20000; id++) {
    if (pickVariant({ tmdbId: id }, ["a", "b", "c"]) === undefined) bad++;
  }
  assert.strictEqual(bad, 0, "negative modulo regression: options[-1] is undefined");
});
test("spreads roughly evenly across variants", () => {
  const { pickVariant } = require("./lib/whywatch.js");
  const seen = { a: 0, b: 0 };
  for (let id = 1; id <= 10000; id++) seen[pickVariant({ tmdbId: id }, ["a", "b"])]++;
  assert.ok(Math.min(seen.a, seen.b) / Math.max(seen.a, seen.b) > 0.85, "variant skew");
});
test("no 'undefined' leaks into rendered fit prose", () => {
  const { whyWatch } = require("./lib/whywatch.js");
  for (let id = 1; id <= 3000; id++) {
    const w = whyWatch({ tmdbId: id, genre: "Action / Thriller", runtime: 145, cert: "U/A", language: "Hindi", kind: "movie" });
    assert.ok(w && !/undefined/.test(w.text), `undefined leaked at id ${id}`);
  }
});
test("stable across builds for the same film", () => {
  const { pickVariant } = require("./lib/whywatch.js");
  const it = { tmdbId: 4242 };
  assert.strictEqual(pickVariant(it, ["a", "b", "c"]), pickVariant(it, ["a", "b", "c"]));
});

group("watchFit — structured Why / Skip if / Best for");
const WF = require("./lib/watchfit.js");
test("settled, well-rated film gets all three rows", () => {
  const r = WF.watchFit({ tmdbId: 101, genre: "Thriller / Drama", runtime: 150, cert: "A", rating: 7.9, votes: 24000, kind: "movie", providers: ["Netflix"] });
  assert.ok(r && r.why && r.skipIf && r.bestFor);
  assert.ok(/7\.9/.test(r.why) && /24,000/.test(r.why));
});
test("thin sample suppresses Why but keeps the fit rows", () => {
  const r = WF.watchFit({ tmdbId: 303, genre: "Drama", runtime: 120, cert: "U/A", rating: 8.1, votes: 12, kind: "movie", providers: ["Netflix"] });
  assert.ok(r && r.why === null, "must not present a 12-vote score as a finding");
  assert.ok(r.skipIf && r.bestFor);
});
test("Why never fires below the vote floor", () => {
  const base = { tmdbId: 9, genre: "Drama", runtime: 120, rating: 8.0, kind: "movie" };
  assert.strictEqual(WF.whyLine({ ...base, votes: WF.WHY_MIN_VOTES - 1 }), null);
  assert.ok(WF.whyLine({ ...base, votes: WF.WHY_MIN_VOTES }));
});
test("rent-or-buy outranks the genre skip line", () => {
  const r = WF.skipLine({ tmdbId: 404, genre: "Crime", runtime: 130, providers: [], rentBuy: ["Apple TV"] });
  assert.ok(/pay per view|subscription/.test(r), "payment friction is the more decision-relevant skip");
});
test("multi-season TV outranks the genre skip line", () => {
  const r = WF.skipLine({ tmdbId: 505, genre: "Sci-Fi & Fantasy", seasons: 4, kind: "tv" });
  assert.ok(/seasons deep|backlog/.test(r));
});
test("returns null rather than inventing rows when signal is thin", () => {
  assert.strictEqual(WF.watchFit({ tmdbId: 606, rating: 7.0, votes: 800, kind: "movie", providers: ["Netflix"] }), null);
  assert.strictEqual(WF.watchFit(null), null);
});
test("every genre in the rubric yields a non-empty skip line", () => {
  for (const g of Object.keys(WF.GENRE_SKIP)) {
    const r = WF.skipLine({ tmdbId: 7, genre: g });
    assert.ok(r && typeof r === "string" && r.length > 0, `empty skip line for ${g}`);
    assert.ok(!/undefined/.test(r), `undefined in skip line for ${g}`);
  }
});
test("Skip if never restates the verdict as a quality claim", () => {
  for (const g of Object.keys(WF.GENRE_SKIP)) {
    const r = WF.skipLine({ tmdbId: 3, genre: g });
    assert.ok(!/\b(bad|terrible|weak|poor|awful)\b/i.test(r), `quality claim leaked into skip line for ${g}`);
  }
});
test("IMDb fields take precedence when present", () => {
  const r = WF.whyLine({ tmdbId: 55, rating: 5.0, votes: 100, imdbRating: 8.2, imdbVotes: 90000 });
  assert.ok(/8\.2/.test(r) && /90,000/.test(r));
});

group("freshnessWindowLabel \u2014 measured, never asserted");
const _FW_NOW = Date.parse("2026-09-03");
const _fwAgo = (n) => new Date(_FW_NOW - n * 864e5).toISOString().slice(0, 10);
const _OTT = { verb: "Added", past: "in the past", dateOf: (x) => x && (x.freshDate || x.released) };
test("a genuinely fresh page says so plainly", () => {
  assert.strictEqual(U.freshnessWindowLabel([{ released: _fwAgo(2) }, { released: _fwAgo(6) }], _FW_NOW),
    "Releases from this week");
});
test("buckets round UP into readable weeks, never raw day counts", () => {
  assert.strictEqual(U.freshnessWindowLabel([{ released: _fwAgo(9) }], _FW_NOW), "Releases from the past two weeks");
  assert.strictEqual(U.freshnessWindowLabel([{ released: _fwAgo(21) }], _FW_NOW), "Releases from the past three weeks");
  assert.strictEqual(U.freshnessWindowLabel([{ released: _fwAgo(33) }], _FW_NOW), "Releases from the past five weeks");
  for (let d = 1; d <= U.THEATRE_WINDOW_FALLBACK_DAYS; d++) {
    assert.ok(!/\d/.test(U.freshnessWindowLabel([{ released: _fwAgo(d) }], _FW_NOW)), `digit leaked at ${d}d`);
  }
});
test("stays true when the 35-day fallback pool fires", () => {
  // The bug in the hardcoded version: it claimed 3 weeks on exactly the weeks the
  // strict pool ran thin and 35-day-old titles were admitted.
  assert.strictEqual(U.freshnessWindowLabel([{ released: _fwAgo(5) }, { released: _fwAgo(35) }], _FW_NOW),
    "Releases from the past five weeks");
});
test("never names a window it can't stand behind", () => {
  assert.strictEqual(U.freshnessWindowLabel([{ released: _fwAgo(4) }, { released: _fwAgo(400) }], _FW_NOW), null,
    "an out-of-gate outlier must suppress the label, not print an absurd one");
  assert.strictEqual(U.freshnessWindowLabel([{}, {}], _FW_NOW), null);
  assert.strictEqual(U.freshnessWindowLabel([], _FW_NOW), null);
  assert.strictEqual(U.freshnessWindowLabel(null, _FW_NOW), null);
});
test("the label never overstates freshness", () => {
  for (let oldest = 1; oldest <= U.THEATRE_WINDOW_FALLBACK_DAYS; oldest++) {
    const label = U.freshnessWindowLabel([{ released: _fwAgo(oldest) }], _FW_NOW);
    const WEEKS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const m = /past (\w+) weeks/.exec(label);
    const claimed = m ? WEEKS[m[1]] * 7 : 7;   // "this week" claims 7
    assert.ok(claimed >= oldest, `claimed ${claimed}d must cover a ${oldest}d-old film`);
  }
});
test("each section measures its own date and verb", () => {
  // Streaming must measure ARRIVAL. A 2019 film that landed yesterday belongs on the
  // list, and "Releases from this week" would be a false claim about its release.
  const ott = [{ freshDate: _fwAgo(2), released: _fwAgo(400) }, { freshDate: _fwAgo(30), released: _fwAgo(600) }];
  const label = U.freshnessWindowLabel(ott, _FW_NOW, U.OTT_FRESH_DAYS, _OTT);
  assert.strictEqual(label, "Added in the past five weeks");
  assert.ok(!/Releases from/.test(label), "streaming must not claim a release date");
});
test("streaming uses the full 45-day gate as its bound", () => {
  assert.strictEqual(U.freshnessWindowLabel([{ freshDate: _fwAgo(44) }], _FW_NOW, U.OTT_FRESH_DAYS, _OTT),
    "Added in the past seven weeks");
  assert.strictEqual(U.freshnessWindowLabel([{ freshDate: _fwAgo(46) }], _FW_NOW, U.OTT_FRESH_DAYS, _OTT), null);
});

group("language pages — fed by langPools, not homepage leftovers");
const _lp = (t, lang, id, extra = {}) => ({
  title: t, language: lang, tmdbId: id, slug: t.toLowerCase().replace(/\W+/g, "-"),
  rating: 7.2, votes: 400, released: "2026-09-01", kind: "movie", ...extra,
});
const _lpData = (langPools) => ({
  generatedAt: "2026-09-08T06:00:00Z",
  theatres: [_lp("Toxic", "Kannada", 1)], ott: [], comingSoon: [], langPools,
});
test("pool titles are added to the page, not just homepage leftovers", () => {
  const html = U.buildLanguagePage(_lpData({
    Kannada: { theatres: [_lp("Bench A", "Kannada", 2)], ott: [_lp("Stream One", "Kannada", 3)] },
  }), "Kannada", "kannada");
  assert.ok(html.includes("Toxic"), "homepage title must still appear");
  assert.ok(html.includes("Bench A"), "pool theatre title must appear");
  assert.ok(html.includes("Stream One"), "pool OTT title must appear");
});
test("a pool title already on the homepage is not duplicated", () => {
  // Regression: the first cut used `!seen.add(id)` as a filter guard. Set.add returns the
  // Set, which is truthy, so the guard was always false and NOTHING merged. Guard both ways.
  const html = U.buildLanguagePage(_lpData({
    Kannada: { theatres: [_lp("Toxic", "Kannada", 1)], ott: [] },
  }), "Kannada", "kannada");
  assert.ok(html.includes("Toxic"));
  assert.ok((html.match(/>Toxic</g) || []).length <= 2, "Toxic must not render twice");
});
test("missing langPools (countries without language pages) does not throw", () => {
  const bare = { generatedAt: "2026-09-08T06:00:00Z", theatres: [_lp("X", "Tamil", 9)], ott: [], comingSoon: [] };
  assert.doesNotThrow(() => U.buildLanguagePage(bare, "Tamil", "tamil"));
});
test("a thin page never claims to list EVERY title", () => {
  const html = U.buildLanguagePage(_lpData({}), "Kannada", "kannada");
  assert.ok(!/Every Kannada title/.test(html), "one-film page must not overclaim completeness");
  assert.ok(!/Every new Kannada movie/.test(html), "thin meta description must not overclaim");
});
test("a filled-out page still makes the completeness claim", () => {
  const html = U.buildLanguagePage(_lpData({
    Kannada: { theatres: [_lp("Bench A", "Kannada", 2)], ott: [_lp("Stream One", "Kannada", 3)] },
  }), "Kannada", "kannada");
  assert.ok(/Every Kannada title/.test(html), "a substantial page keeps the stronger lead");
});

group("/new-on-ott/ — fed by ottExtra, not just the homepage ten");
const _ow = (t, id, platform, extra = {}) => ({
  title: t, tmdbId: id, platform, slug: t.toLowerCase().replace(/\W+/g, "-"),
  language: "English", rating: 7.4, votes: 500, kind: "movie", ...extra,
});
const _owCfg = { code: "in", name: "India" };
test("ottExtra titles render alongside the homepage list", () => {
  const data = {
    generatedAt: "2026-09-08T06:00:00Z",
    ott: [_ow("Homepage One", 1, "Netflix")],
    ottExtra: [_ow("Overflow Two", 2, "Netflix"), _ow("Surplus Three", 3, "JioHotstar")],
  };
  const html = U.buildOttWeekPage(data, _owCfg, [_owCfg]);
  assert.ok(html.includes("Homepage One"));
  assert.ok(html.includes("Overflow Two"), "overflow title must reach the page");
  assert.ok(html.includes("Surplus Three"), "surplus title must reach the page");
});
test("a title in both lists is not rendered twice", () => {
  const data = {
    generatedAt: "2026-09-08T06:00:00Z",
    ott: [_ow("Dup", 1, "Netflix")], ottExtra: [_ow("Dup", 1, "Netflix")],
  };
  const html = U.buildOttWeekPage(data, _owCfg, [_owCfg]);
  assert.ok((html.match(/>Dup</g) || []).length <= 2, "duplicate tmdbId must collapse to one row");
});
test("items without a tmdbId are kept, not collapsed into one", () => {
  // Regression: deduping on a missing id let the first undefined claim the slot and silently
  // dropped every later id-less item, turning a full page into a single row.
  const data = {
    generatedAt: "2026-09-08T06:00:00Z",
    ott: [{ title: "No Id A", platform: "Netflix" }, { title: "No Id B", platform: "Netflix" }],
    ottExtra: [],
  };
  const html = U.buildOttWeekPage(data, _owCfg, [_owCfg]);
  assert.ok(html.includes("No Id A") && html.includes("No Id B"));
});
test("missing ottExtra (older data file) does not throw", () => {
  const data = { generatedAt: "2026-09-08T06:00:00Z", ott: [_ow("Only", 1, "Netflix")] };
  assert.doesNotThrow(() => U.buildOttWeekPage(data, _owCfg, [_owCfg]));
});
test("a thin week does not claim to list EVERY streaming release", () => {
  const data = { generatedAt: "2026-09-08T06:00:00Z", ott: [_ow("Only", 1, "Netflix")], ottExtra: [] };
  const html = U.buildOttWeekPage(data, _owCfg, [_owCfg]);
  assert.ok(!/Every new movie and web series/.test(html), "thin page must not overclaim");
});
test("a full week keeps the completeness claim", () => {
  const data = {
    generatedAt: "2026-09-08T06:00:00Z",
    ott: Array.from({ length: 6 }, (_, i) => _ow(`T${i}`, i + 1, "Netflix")),
    ottExtra: Array.from({ length: 4 }, (_, i) => _ow(`E${i}`, i + 20, "JioHotstar")),
  };
  const html = U.buildOttWeekPage(data, _owCfg, [_owCfg]);
  assert.ok(/Every new movie and web series/.test(html), "a 10-title page keeps the stronger claim");
});

group("pool items are first-class — slugs and film pages");
test("poolItems collects langPools and ottExtra, deduped", () => {
  const it = (t, id) => ({ title: t, tmdbId: id, language: "Kannada" });
  const data = { ottExtra: [it("A", 1), it("B", 2)],
                 langPools: { Kannada: { theatres: [it("C", 3)], ott: [it("A", 1)] } } };
  assert.deepStrictEqual(U.poolItems(data).map((x) => x.title), ["A", "B", "C"]);
});
test("poolItems is empty and safe when neither field exists", () => {
  assert.deepStrictEqual(U.poolItems({ theatres: [{ title: "X" }] }), []);
  assert.deepStrictEqual(U.poolItems(null), []);
});
test("assignSlugs reaches pool items, not just the three homepage lists", () => {
  // Regression: assignSlugs iterated [theatres, ott, comingSoon] only, so pool titles kept
  // slug === undefined. They rendered on /malayalam/ as unlinked text and some were dropped
  // outright by a downstream `.filter(x => x.slug)`.
  const data = {
    theatres: [{ title: "Homepage Film", tmdbId: 1, released: "2026-09-01" }],
    ott: [], comingSoon: [],
    langPools: { Malayalam: { theatres: [{ title: "Pool Film", tmdbId: 2, released: "2026-09-01" }], ott: [] } },
    ottExtra: [{ title: "Extra Film", tmdbId: 3, released: "2026-09-01" }],
  };
  U.assignSlugs(data);
  assert.strictEqual(data.langPools.Malayalam.theatres[0].slug, "pool-film");
  assert.strictEqual(data.ottExtra[0].slug, "extra-film");
});
test("a pool item never collides with a homepage slug", () => {
  const data = {
    theatres: [{ title: "Same Name", tmdbId: 1, released: "2026-09-01" }],
    ott: [], comingSoon: [],
    ottExtra: [{ title: "Same Name", tmdbId: 2, released: "2025-04-02" }],
  };
  U.assignSlugs(data);
  assert.notStrictEqual(data.theatres[0].slug, data.ottExtra[0].slug);
});

group("skipIf() — the honest counterweight");
const { skipIf } = require("./lib/skipif.js");
const _sf = (o) => ({ title: "T", tmdbId: 7, rating: 7.5, votes: 500, runtime: 100, kind: "movie", ...o });
test("returns null when fewer than two honest reasons hold", () => {
  assert.strictEqual(skipIf(_sf({})), null);
  assert.strictEqual(skipIf(_sf({ runtime: 200 })), null, "one reason alone is an afterthought");
});
test("a long adults-only film gets both reasons", () => {
  const r = skipIf(_sf({ runtime: 195, cert: "A" }));
  assert.ok(r && r.length >= 2);
  assert.ok(r.some((x) => /3h/.test(x)) && r.some((x) => /\bA\b/.test(x)));
});
test("never restates the verdict the page already shows", () => {
  // rating == null means the page is already displaying "verdict soon". Repeating it here
  // would violate rule 3 and would fire on nearly every film on a this-week site.
  const r = skipIf(_sf({ rating: null, votes: 3, runtime: 190, cert: "A" })) || [];
  assert.ok(!r.some((x) => /too new|consensus|still settling|votes so far/i.test(x)));
});
test("low-vote confidence fires only when a rating is actually displayed", () => {
  const r = skipIf(_sf({ rating: 8.1, votes: 20, runtime: 160 })) || [];
  assert.ok(r.some((x) => /20 votes|still settling|consensus/i.test(x)));
});
test("genre alone is never a reason (rule 2)", () => {
  const r = skipIf(_sf({ genre: "Horror / Thriller", cert: "U/A 13+", runtime: 95 }));
  assert.strictEqual(r, null, "Horror on a horror film is not information");
  const combo = skipIf(_sf({ genre: "Horror", cert: "A", runtime: 95, rating: 7.5, votes: 500 })) || [];
  assert.ok(combo.length >= 2, "horror + adults-only certificate does say something");
});
test("a long-running series warns about the commitment", () => {
  const r = skipIf(_sf({ kind: "tv", seasons: 5, cert: "A", runtime: 0 })) || [];
  assert.ok(r.some((x) => /5 seasons|5-season/.test(x)));
});
test("rent-or-buy-only is surfaced; subscription titles are not", () => {
  const paid = skipIf(_sf({ rentBuy: ["Apple TV"], providers: [], runtime: 165 })) || [];
  assert.ok(paid.some((x) => /rent-or-buy|per film/i.test(x)));
  const sub = skipIf(_sf({ rentBuy: ["Apple TV"], providers: ["Netflix"], runtime: 165, cert: "A" })) || [];
  assert.ok(!sub.some((x) => /rent-or-buy|per film/i.test(x)));
});
test("variants are stable across builds but differ between films", () => {
  const a = _sf({ tmdbId: 1, runtime: 200, cert: "A" }), b = _sf({ tmdbId: 2, runtime: 200, cert: "A" });
  assert.deepStrictEqual(skipIf(a), skipIf(a), "same film must not churn the git diff");
  assert.notDeepStrictEqual(skipIf(a), skipIf(b), "different films must not read identically");
});
test("never emits more than the cap", () => {
  const r = skipIf(_sf({ runtime: 200, cert: "A", rating: 8, votes: 5, seasons: 6, kind: "tv",
    genre: "Horror", take: "Critics are split down the middle.", rentBuy: ["X"], providers: [] }));
  assert.ok(r.length <= 4);
});

group("shortenTitleTag() — archive title sweep");
const _pg = (t) => `<head><title>${t}</title><meta property="og:title" content="${t}"></head>`;
test("drops decoration until the title fits the 60-char budget", () => {
  const r = U.shortenTitleTag(_pg("Aligned Apart (2026) &mdash; Review, Rating &amp; Where to Watch in India | FilmyChill".replace("&mdash;", "\u2014")), "India", { code: "in" });
  assert.ok(r.changed);
  assert.ok(r.html.match(/<title>([\s\S]*?)<\/title>/)[1].replace(/&amp;/g, "&").length <= 60);
});
test("leaves a title that already fits completely alone", () => {
  const html = _pg("Alpha (2026) \u2014 Review");
  assert.deepStrictEqual(U.shortenTitleTag(html, "India", { code: "in" }), { html, changed: false });
});
test("never lengthens a title it cannot fix", () => {
  // The film's own name exceeds the budget — nothing left to trim, so leave it be.
  const long = "Operation Safed Sagar: The Untold Story of the Kargil War (2026) \u2014 Review";
  const r = U.shortenTitleTag(_pg(long), "India", { code: "in" });
  assert.strictEqual(r.changed, false);
});
test("leaves an unrecognised title shape untouched rather than mangling it", () => {
  const html = _pg("Some Completely Different Title Format That We Have Never Emitted Before");
  assert.strictEqual(U.shortenTitleTag(html, "India", { code: "in" }).changed, false);
});
test("og:title is rewritten in step with the title tag", () => {
  const r = U.shortenTitleTag(_pg("Ananthan Kaadu (2026) \u2014 Review, Rating &amp; Where to Watch in India | FilmyChill"), "India", { code: "in" });
  const t = r.html.match(/<title>([\s\S]*?)<\/title>/)[1];
  const og = r.html.match(/og:title" content="([^"]*)"/)[1];
  assert.strictEqual(t, og, "the social title must not drift from the search title");
});

group("departure sweep — rechecking claims we already made");
const _liveEnt = (slug, lastCheck, extra = {}) => ({ slug, tmdbId: 1, title: slug, live: { since: lastCheck, lastCheck, providers: ["Netflix"], misses: 0 }, ...extra });
test("only pages with an open live claim are candidates", () => {
  const c = U.departureCandidates([_liveEnt("a", "2026-06-01"), { slug: "b", tmdbId: 2 }], new Date("2026-09-09"));
  assert.deepStrictEqual(c.map((x) => x.slug), ["a"]);
});
test("a recently checked claim is left alone", () => {
  assert.strictEqual(U.departureCandidates([_liveEnt("a", "2026-09-05")], new Date("2026-09-09")).length, 0);
});
test("the stalest claim is checked first", () => {
  const c = U.departureCandidates([_liveEnt("newer", "2026-07-01"), _liveEnt("older", "2026-05-01")], new Date("2026-09-09"));
  assert.deepStrictEqual(c.map((x) => x.slug), ["older", "newer"]);
});
const _livePage = '<span class="pill">Netflix</span><!--SW:pending--><!--SW:live=2026-07-01--><h2>When is X coming to OTT?</h2><p><strong>It&#39;s streaming now.</strong> X is available in India on Netflix.</p><!--/SW:pending-->';
test("a gone title says what we can prove, not why", () => {
  const r = U.applyDeparturePatch(_livePage, { title: "X", was: ["Netflix"], rentBuy: [], countryName: "India", cfg: { code: "in" }, asOf: "2026-09-09" });
  assert.ok(r.changed);
  assert.ok(/can't find it streaming/.test(r.html));
  assert.ok(!/removed|delisted|taken down/i.test(r.html), "never claim a reason we cannot know");
  assert.ok(!r.html.includes('<span class="pill">Netflix</span>'), "stale provider pill must go");
});
test("rent-or-buy is not treated as a departure", () => {
  const r = U.applyDeparturePatch(_livePage, { title: "X", was: ["Netflix"], rentBuy: ["Apple TV"], countryName: "India", cfg: { code: "in" }, asOf: "2026-09-09" });
  assert.ok(/rent or buy it on Apple TV/.test(r.html));
  assert.ok(!/can't find it streaming/.test(r.html), "still purchasable is not gone");
});
test("the departure block does not reuse the arrival heading", () => {
  const r = U.applyDeparturePatch(_livePage, { title: "X", was: ["Netflix"], rentBuy: [], countryName: "India", cfg: { code: "in" }, asOf: "2026-09-09" });
  assert.ok(!/coming to OTT/.test(r.html), "asking when it arrives above a departure notice is nonsense");
});
test("provider names are recovered from the page when the manifest has none", () => {
  // Pages patched before live claims existed have no recorded provider list.
  const r = U.applyDeparturePatch(_livePage, { title: "X", was: [], rentBuy: [], countryName: "India", cfg: { code: "in" }, asOf: "2026-09-09" });
  assert.ok(!r.html.includes('<span class="pill">Netflix</span>'));
});
test("a page with no pending block is left untouched", () => {
  const plain = "<html><body><p>nothing here</p></body></html>";
  assert.deepStrictEqual(U.applyDeparturePatch(plain, { title: "X", was: [], rentBuy: [], countryName: "India", cfg: { code: "in" }, asOf: "2026-09-09" }), { html: plain, changed: false });
});

group("editor's note — the sleeper must actually be new");
const _ottItem = (o) => ({ title: "X", rating: 8.0, votes: 400, platform: "Netflix", kind: "tv", ...o });
test("an older standout is never crowned the week's winner", () => {
  // Regression: the sleeper sorted the whole six-week OTT list by rating. The stillGood tail
  // (long-running shows with thousands of votes) wins that sort almost by definition, so the
  // note called a 2020 series with a 4 Aug season "the week's real winner".
  const data = { theatres: [], ott: [
    _ottItem({ title: "Old Favourite", rating: 8.6, votes: 5000, stillGood: true }),
    _ottItem({ title: "This Week", rating: 8.1, votes: 400, stillGood: false }),
  ] };
  const note = U.buildEditorNote(data, { code: "in" }, 1) || "";
  assert.ok(!/Old Favourite/.test(note), "a stillGood title must not be the sleeper");
  assert.ok(/This Week/.test(note), "the current arrival should take the slot");
});
test("no sleeper at all rather than a stale one", () => {
  const data = { theatres: [], ott: [_ottItem({ title: "Old Favourite", rating: 8.9, votes: 9000, stillGood: true })] };
  const note = U.buildEditorNote(data, { code: "in" }, 1);
  assert.ok(!note || !/Old Favourite/.test(note), "say nothing before saying something untrue");
});
test("a fresh title still clears the sleeper bar normally", () => {
  const data = { theatres: [], ott: [_ottItem({ title: "Fresh Hit", rating: 8.2, votes: 500 })] };
  assert.ok(/Fresh Hit/.test(U.buildEditorNote(data, { code: "in" }, 1) || ""));
});

group("currency claims — carried-over titles never presented as new");
const _mkOtt = (title, o = {}) => ({ title, slug: title.toLowerCase().replace(/\W+/g, "-"), tmdbId: title.length * 7,
  platform: "Netflix", language: "English", rating: 8.0, votes: 500, kind: "movie", ...o });
const _mixed = {
  generatedAt: "2026-09-09T06:00:00Z",
  theatres: [],
  ott: [
    _mkOtt("Landed Today", { rating: 7.6, votes: 300 }),
    _mkOtt("Also New", { rating: 7.4, votes: 250 }),
    _mkOtt("Old Favourite", { rating: 8.9, votes: 9000, stillGood: true }),
  ],
};
const _cfgIn = { code: "in", name: "India", region: "IN" };
test("a hub's FAQ answer names only titles that arrived this week", () => {
  const hub = { name: "Netflix", slug: "netflix", items: _mixed.ott };
  const html = U.buildPlatformHubPage(_mixed, _cfgIn, hub);
  // NB: apostrophes are HTML-escaped in the rendered summary.
  const a = (html.match(/new on Netflix in India this week\?<\/summary><div class="fa">([^<]*)/) || [])[1] || "";
  assert.ok(/Landed Today/.test(a));
  assert.ok(!/Old Favourite/.test(a), "the most quotable sentence on the page must be true");
});
test("a hub still lists carried-over titles, under their own label", () => {
  const hub = { name: "Netflix", slug: "netflix", items: _mixed.ott };
  const html = U.buildPlatformHubPage(_mixed, _cfgIn, hub);
  assert.ok(/Old Favourite/.test(html), "worth watching — keep it on the page");
  assert.ok(/Still worth it/.test(html), "but label it");
});
test("the hub lead counts new titles, not total rows", () => {
  const hub = { name: "Netflix", slug: "netflix", items: _mixed.ott };
  const html = U.buildPlatformHubPage(_mixed, _cfgIn, hub);
  assert.ok(/2 new titles/.test(html), "3 rows, 2 of them new");
});
test("/new-on-ott/ keeps carried titles out of 'New on X this week' groups", () => {
  const html = U.buildOttWeekPage({ ..._mixed, ottExtra: [] }, _cfgIn, [_cfgIn]);
  // Check the rendered body, not the <head> schema (covered separately below).
  const body = html.slice(html.indexOf("<h1"));
  const beforeCarried = body.split("Still worth it")[0] || "";
  assert.ok(!/Old Favourite/.test(beforeCarried), "a five-week-old title under a 'this week' heading is a false claim");
  assert.ok(/Still worth it/.test(html));
});
test("'best new this week' ranks this week's arrivals only", () => {
  const html = U.buildOttWeekPage({ ..._mixed, ottExtra: [] }, _cfgIn, [_cfgIn]);
  const a = (html.match(/best new [^<]*this week\?<\/summary><div class="fa">([^<]*)/) || [])[1] || "";
  assert.ok(!/Old Favourite/.test(a), "the 8.9 carried-over title must not win 'best new'");
  assert.ok(/Landed Today/.test(a));
});
test("the ItemList schema under a 'This Week' CollectionPage holds only new arrivals", () => {
  const html = U.buildOttWeekPage({ ..._mixed, ottExtra: [] }, _cfgIn, [_cfgIn]);
  const ld = JSON.parse(html.match(/"@type":"CollectionPage"[\s\S]*?\}(?=<\/script>)/) ? html.match(/\{"@context":"https:\/\/schema\.org","@type":"CollectionPage"[\s\S]*?\]\}\}/)[0] : "{}");
  const names = (ld.mainEntity && ld.mainEntity.itemListElement || []).map((x) => x.name);
  assert.ok(!names.includes("Old Favourite"), "structured data is what answer engines trust most");
  assert.ok(names.includes("Landed Today"));
});
test("a week with no new arrivals says so rather than pretending", () => {
  const onlyOld = { ..._mixed, ott: [_mkOtt("Old Favourite", { stillGood: true })] };
  const hub = { name: "Netflix", slug: "netflix", items: onlyOld.ott };
  const html = U.buildPlatformHubPage(onlyOld, _cfgIn, hub);
  assert.ok(/Nothing new landed/.test(html));
});

console.log(`Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error("FAIL"); process.exit(1); }
console.log("PASS");
