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

// ---------------- summary ----------------
console.log(`\n${"=".repeat(40)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error("FAIL"); process.exit(1); }
console.log("PASS");
