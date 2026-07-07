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
  assert.ok(xml.includes("<title>FilmyChill — New Movies &amp; OTT This Week in India</title>"));
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
  assert.strictEqual(effective, daysAgo(2));
  assert.ok(!isArrival, "recent releases already carry the release badge");
});
test("ottArrival: catalog addition — years-old title first seen today -> fresh + arrival", () => {
  const { effective, isArrival } = U.ottArrival("2024-03-01", daysAgo(0), TH_NOW);
  assert.strictEqual(effective, daysAgo(0));
  assert.ok(isArrival);
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
  assert.ok(html.includes("<title>New Movies &amp; OTT This Week in India (July 2026) | FilmyChill</title>"));
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
  assert.ok(html.includes('og:title" content="New Movies &amp; OTT This Week in India (July 2026) | FilmyChill"'), "share title = SERP title");
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

// ---------------- summary ----------------
console.log(`\n${"=".repeat(40)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error("FAIL"); process.exit(1); }
console.log("PASS");
