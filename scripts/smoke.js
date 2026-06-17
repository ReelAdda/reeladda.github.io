// FilmyChill data smoke test — validates the SHAPE and integrity of generated data files.
// Run after the build: node scripts/smoke.js          (checks data.json)
//                      node scripts/smoke.js us uk au de   (checks data-<code>.json too)
// In CI, pass all country codes so a malformed/empty build fails loudly instead of shipping.

const fs = require("fs");
const assert = require("assert");

const VERDICTS = new Set([
  "Must watch", "Worth a watch", "Decent one-time watch",
  "Skip unless curious", "Not enough ratings yet",
]);

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}\n      ${e.message}`); }
}

function validateItem(it, where) {
  assert.ok(it.title && typeof it.title === "string", `${where}: item missing title`);
  assert.ok(it.slug && /^[a-z0-9-]+$/.test(it.slug), `${where}: "${it.title}" bad/missing slug`);
  // rating, when present, must be in range
  if (it.rating != null) {
    assert.ok(it.rating >= 0 && it.rating <= 10, `${where}: "${it.title}" rating out of range (${it.rating})`);
  }
  // verdict, when present, should be a known string. Wording can evolve over releases, so a
  // mismatch is a WARNING (not a hard fail) — structural integrity is what must hold.
  if (it.verdict && !VERDICTS.has(it.verdict)) {
    console.warn(`      \u26a0 ${where}: "${it.title}" unfamiliar verdict "${it.verdict}" (wording drift?)`);
  }
  // poster, when present, must be a TMDB image url
  if (it.poster) {
    assert.ok(/^https:\/\/image\.tmdb\.org\//.test(it.poster), `${where}: "${it.title}" non-TMDB poster`);
  }
}

function validateFile(path, label) {
  console.log(`\n${label} (${path})`);

  check("file exists & is valid JSON", () => {
    const raw = fs.readFileSync(path, "utf8");
    JSON.parse(raw);
  });

  let data;
  try { data = JSON.parse(fs.readFileSync(path, "utf8")); }
  catch { return; } // already reported above

  check("has theatres + ott arrays", () => {
    assert.ok(Array.isArray(data.theatres), "theatres must be an array");
    assert.ok(Array.isArray(data.ott), "ott must be an array");
  });

  check("theatres is non-empty (build actually produced content)", () => {
    assert.ok(data.theatres.length > 0, "theatres is empty — build likely failed/partial");
  });

  check("ott is non-empty", () => {
    assert.ok(data.ott.length > 0, "ott is empty — build likely failed/partial");
  });

  check("generatedAt is a recent valid timestamp", () => {
    const t = new Date(data.generatedAt).getTime();
    assert.ok(Number.isFinite(t), "generatedAt not a valid date");
    const ageHours = (Date.now() - t) / 3.6e6;
    assert.ok(ageHours < 48, `data is stale (${ageHours.toFixed(1)}h old)`);
  });

  check("every theatre item is well-formed", () => {
    data.theatres.forEach((it) => validateItem(it, "theatres"));
  });

  check("every ott item is well-formed", () => {
    data.ott.forEach((it) => validateItem(it, "ott"));
  });

  check("comingSoon (if present) is well-formed", () => {
    (data.comingSoon || []).forEach((it) => {
      assert.ok(it.title, "comingSoon item missing title");
      assert.ok(it.slug && /^[a-z0-9-]+$/.test(it.slug), `comingSoon "${it.title}" bad slug`);
    });
  });

  check("pick (if present) refers to a real listed title", () => {
    if (!data.pick) return;
    const titles = new Set([...data.theatres, ...data.ott].map((x) => x.title));
    assert.ok(titles.has(data.pick), `pick "${data.pick}" not in theatres/ott`);
  });

  check("no duplicate slugs within theatres", () => {
    const slugs = data.theatres.map((x) => x.slug);
    assert.strictEqual(new Set(slugs).size, slugs.length, "duplicate slugs in theatres");
  });
}

// India canonical file is always checked.
validateFile("data.json", "India (canonical)");

// Extra country codes from CLI args -> data-<code>.json
const extra = process.argv.slice(2);
for (const code of extra) {
  const path = `data-${code}.json`;
  if (fs.existsSync(path)) validateFile(path, `Country: ${code.toUpperCase()}`);
  else { failed++; console.error(`\nCountry: ${code.toUpperCase()}\n  \u2717 ${path} does not exist`); }
}

console.log(`\n${"=".repeat(40)}`);
if (failed > 0) { console.error(`SMOKE FAIL: ${failed} check(s) failed`); process.exit(1); }
console.log("SMOKE PASS");
