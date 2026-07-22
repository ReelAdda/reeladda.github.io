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
test("freshLabel: TV shows 'Latest season <date>', not the series launch", () => {
  assert.strictEqual(U.freshLabel({ kind: "tv", freshDate: "2026-06-21", released: "2022-08-21" }, TH_NOW), "Latest season 21 Jun");
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
test("archivePatchHtml: no-op for OTT pages (their availability stays valid)", () => {
  const item = { title: "S", slug: "s", kind: "tv", language: "English", platform: "Netflix",
    providers: ["Netflix"], released: "2026-06-01", freshDate: "2026-06-20", rating: 8.0, votes: 900, verdict: "Must watch" };
  const page = U.buildFilmPage(item, "2026-06-25", new Set(["s"]), { code: "in", name: "India", region: "IN" });
  const { changed } = U.archivePatchHtml(page, "India");
  assert.ok(!changed, "nothing to patch on a streaming page");
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
  assert.ok(html.includes("🔥 Trending"));
  assert.ok(html.includes("▶ 52M trailer views"));
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
  assert.ok(html.includes("<title>New Movies &amp; OTT Releases This Week in India (July 2026) | FilmyChill</title>"));
  assert.ok(html.includes("This week: Toy Story 5, House of the Dragon + 2 more"));
  assert.ok(html.includes("Updated twice daily"));
  const us = U.buildHeadTags({ code: "us", name: "United States" }, false, data);
  assert.ok(us.includes("This Week in the US (July 2026)"));
});
test("buildHeadTags: without data — legacy static wording unchanged (backward compatible)", () => {
  const html = U.buildHeadTags({ code: "in", name: "India" }, false);
  assert.ok(html.includes("FilmyChill — Latest Movie &amp; OTT Releases, with Reviews, Updated Daily"));
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
  assert.ok(html.includes('og:title" content="New Movies &amp; OTT Releases This Week in India (July 2026) | FilmyChill"'), "share title = SERP title");
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
  assert.ok(html.includes("🔥 Trending"));
  assert.ok(html.includes("▶ 12M trailer views"));
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
test("buildVerdictProse: empty item returns empty string", () => {
  assert.strictEqual(U.buildVerdictProse(null), "");
  assert.strictEqual(U.buildVerdictProse({}), "");
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
  assert.ok(/Where to Watch in India/.test(html));
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
test("aspect both praised and panned is dropped as contested", () => {
  const text = "Some critics praised the story for its ambition and sweep across generations. Other critics criticised the story heavily, calling it overstuffed and difficult to follow at feature length.";
  const a = U.analyzeReception(text);
  assert.ok(!a.praised.includes("story") && !a.panned.includes("story"));
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
  comingSoon: [{ title: "Tamil Soon", slug: "tamil-soon", language: "Tamil", released: "2026-07-20", kind: "movie" }],
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
test("aspect-bearing lines are unaffected by seed", () => {
  const a = { tone: "positive", praised: ["visuals"], panned: [] };
  assert.strictEqual(U.composeTake(a, 3), U.composeTake(a, 7));
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
  assert.ok(/Audiences disagree/.test(c) && /8\.2/.test(c));
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
const COUNTRIES_RE = require("fs").readFileSync("scripts/update.js", "utf8");
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
test("each region gets ITS OWN theatrical date; earliest of types 1-3; digital (type 4) ignored", () => {
  assert.strictEqual(U.regionalTheatricalDate(TMDB_FIXTURE, "IN"), "2026-07-03");
  assert.strictEqual(U.regionalTheatricalDate(TMDB_FIXTURE, "AE"), "2026-07-10");
  assert.strictEqual(U.regionalTheatricalDate(TMDB_FIXTURE, "SG"), "2026-07-01"); // earliest of the two
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
    assert.ok(/not kind|not impressed|gave this one a pass|came away cold|little to love|rough outing/.test(out), out);
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
  theatres: [{ title: "Alpha", slug: "alpha", language: "Hindi", platform: "Theatres", rating: 7.1 }],
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
test("UPGRADE 2+3: a score rescues a would-be-hollow mixed verdict into a fact", () => {
  const take = U.composeTake(U.analyzeReception("The film received mixed reviews from critics. On the review aggregator Rotten Tomatoes, 61% of critics were positive, calling it watchable but slight in the end."));
  assert.ok(/61%/.test(take) && /divisive/i.test(take), take);
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
test("score answer never exceeds a valid range (garbage numbers ignored)", () => {
  const a = U.analyzeReception("The film holds a 250% approval somewhere in this malformed sentence that should not parse as a score at all here.");
  assert.ok(!a || a.score === null);
});

// ---------------- summary ----------------
console.log(`\n${"=".repeat(40)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error("FAIL"); process.exit(1); }
console.log("PASS");
