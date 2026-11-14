// check-providers.js — which of TMDB's watch-provider lists a title sits in, per country.
// Tests the 10 Nov 2026 audit's idea: the build reads only "flatrate" (subscription), so a title
// TMDB files under "free" or "ads" (JioHotstar, ZEE5 and MX Player do this) never shows as streaming.
//
//   TMDB_API_KEY=... node scripts/check-providers.js 1250502 [movie|tv] [IN]
//   (1250502 = I'm Game)
"use strict";

const key = process.env.TMDB_API_KEY;
const [id = "1250502", kind = "movie", country = "IN"] = process.argv.slice(2);
if (!key) { console.error("Set TMDB_API_KEY first."); process.exit(1); }

(async () => {
  const res = await fetch(`https://api.themoviedb.org/3/${kind}/${id}/watch/providers?api_key=${key}`);
  if (!res.ok) { console.error(`TMDB answered ${res.status}`); process.exit(1); }
  const r = ((await res.json()).results || {})[country.toUpperCase()];
  if (!r) { console.log(`${country}: no providers at all`); return; }
  for (const list of ["flatrate", "free", "ads", "rent", "buy"]) {
    const names = (r[list] || []).map((p) => p.provider_name);
    console.log(`${list.padEnd(8)} ${names.length ? names.join(", ") : "-"}${list === "flatrate" ? "   <- the only list the build reads" : ""}`);
  }
})();
