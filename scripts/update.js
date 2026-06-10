// ReelAdda weekly updater v2 — runs automatically via GitHub Actions.
// Fetches theatre + OTT releases with full details (trailer, cast, runtime,
// certificate, all streaming platforms), upcoming releases, and marks
// what's new since last week's scan. Writes data.json for the website.

const API_KEY = process.env.TMDB_API_KEY;
const BASE = "https://api.themoviedb.org/3";

if (!API_KEY) {
  console.error("Missing TMDB_API_KEY. Add it in GitHub repo Settings → Secrets.");
  process.exit(1);
}

async function tmdb(path, params = {}) {
  const url = new URL(BASE + path);
  url.searchParams.set("api_key", API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${path} failed: ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LANG = { en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", ml: "Malayalam", kn: "Kannada", ko: "Korean", ja: "Japanese", es: "Spanish", fr: "French", mr: "Marathi", bn: "Bengali", pa: "Punjabi", gu: "Gujarati" };

function verdict(rating, votes) {
  if (!votes || votes < 10) return "Too new for a verdict";
  if (rating >= 7.5) return "Must watch";
  if (rating >= 6.5) return "Worth a watch";
  if (rating >= 5.5) return "Decent one-time watch";
  return "Skip unless curious";
}

function trim(text, n = 160) {
  if (!text) return "";
  return text.length <= n ? text : text.slice(0, n).replace(/\s+\S*$/, "") + "…";
}

function img(path, size = "w342") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

async function enrich(kind, id) {
  const extra = kind === "movie" ? "release_dates" : "content_ratings";
  const d = await tmdb(`/${kind}/${id}`, { append_to_response: `videos,credits,watch/providers,${extra}` });

  // Certificate (India)
  let cert = null;
  if (kind === "movie") {
    const inRel = d.release_dates?.results?.find((r) => r.iso_3166_1 === "IN");
    cert = inRel?.release_dates?.find((x) => x.certification)?.certification || null;
  } else {
    cert = d.content_ratings?.results?.find((r) => r.iso_3166_1 === "IN")?.rating || null;
  }

  // Trailer
  const vids = d.videos?.results || [];
  const t = vids.find((v) => v.site === "YouTube" && v.type === "Trailer") || vids.find((v) => v.site === "YouTube");
  const trailer = t ? `https://www.youtube.com/watch?v=${t.key}` : null;

  // Streaming platforms in India
  const inProv = d["watch/providers"]?.results?.IN;
  const providers = (inProv?.flatrate || []).slice(0, 4).map((p) => p.provider_name);

  // Cast & director
  const cast = (d.credits?.cast || []).slice(0, 4).map((c) => c.name);
  let director = null;
  if (kind === "movie") director = (d.credits?.crew || []).find((c) => c.job === "Director")?.name || null;
  else director = d.created_by?.[0]?.name || null;

  const runtime = kind === "movie" ? d.runtime : (d.episode_run_time?.[0] || null);

  return {
    cert, trailer, providers, cast, director, runtime,
    backdrop: img(d.backdrop_path, "w780"),
    fullReview: trim(d.overview, 600),
  };
}

async function main() {
  // Load last week's data to detect what's new
  const fs = await import("fs");
  let prevTitles = new Set();
  try {
    const prev = JSON.parse(fs.readFileSync("data.json", "utf8"));
    for (const x of [...(prev.theatres || []), ...(prev.ott || [])]) prevTitles.add(x.title);
  } catch { /* first run */ }

  const [movieGenres, tvGenres] = await Promise.all([tmdb("/genre/movie/list"), tmdb("/genre/tv/list")]);
  const gmap = {};
  for (const g of [...movieGenres.genres, ...tvGenres.genres]) gmap[g.id] = g.name;
  const genres = (ids) => (ids || []).slice(0, 2).map((i) => gmap[i]).filter(Boolean).join(" / ");

  function baseItem(m, kind) {
    return {
      title: m.title || m.name,
      genre: genres(m.genre_ids),
      language: LANG[m.original_language] || m.original_language,
      released: m.release_date || m.first_air_date,
      review: trim(m.overview),
      rating: m.vote_count >= 10 ? Number(m.vote_average.toFixed(1)) : null,
      scores: [{ source: "TMDB", score: m.vote_count >= 10 ? `${m.vote_average.toFixed(1)}/10` : "New release" }],
      votes: m.vote_count,
      verdict: verdict(m.vote_average, m.vote_count),
      poster: img(m.poster_path),
      isNew: !prevTitles.has(m.title || m.name),
      kind,
      tmdbId: m.id,
    };
  }

  // ---------- TOP 5 IN THEATRES ----------
  const nowPlaying = await tmdb("/movie/now_playing", { region: "IN", page: "1" });
  const theatreRaw = nowPlaying.results.sort((a, b) => b.popularity - a.popularity).slice(0, 5);
  const theatres = [];
  for (const m of theatreRaw) {
    const item = { ...baseItem(m, "movie"), platform: "Theatres" };
    try { Object.assign(item, await enrich("movie", m.id)); } catch (e) { console.warn(`enrich movie ${m.id}: ${e.message}`); }
    theatres.push(item);
    await sleep(150);
  }

  // ---------- TOP 10 ON OTT ----------
  const [trMovies, trTv] = await Promise.all([tmdb("/trending/movie/week"), tmdb("/trending/tv/week")]);
  const candidates = [
    ...trMovies.results.map((m) => ({ ...m, kind: "movie" })),
    ...trTv.results.map((t) => ({ ...t, kind: "tv" })),
  ].sort((a, b) => b.popularity - a.popularity);

  const ott = [];
  for (const c of candidates) {
    if (ott.length >= 10) break;
    try {
      const item = baseItem(c, c.kind);
      const extra = await enrich(c.kind, c.id);
      if (!extra.providers || extra.providers.length === 0) continue; // not streaming in India
      Object.assign(item, extra, { platform: extra.providers[0] });
      ott.push(item);
    } catch (e) { console.warn(`ott ${c.id}: ${e.message}`); }
    await sleep(150);
  }

  // ---------- COMING SOON (next releases in India) ----------
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = await tmdb("/movie/upcoming", { region: "IN", page: "1" });
  const soonBase = upcoming.results
    .filter((m) => m.release_date && m.release_date > today)
    .sort((a, b) => a.release_date.localeCompare(b.release_date))
    .slice(0, 8);

  const comingSoon = [];
  for (const m of soonBase) {
    const item = {
      title: m.title,
      released: m.release_date,
      genre: genres(m.genre_ids),
      language: LANG[m.original_language] || m.original_language,
      review: trim(m.overview, 120),
      poster: img(m.poster_path),
      kind: "movie",
      tmdbId: m.id,
    };
    // Full details so the modal can show trailer, backdrop, cast, runtime
    try { Object.assign(item, await enrich("movie", m.id)); } catch (e) { console.warn(`soon ${m.id}: ${e.message}`); }
    comingSoon.push(item);
    await sleep(150);
  }

  // ---------- PICK OF THE WEEK ----------
  const all = [...theatres, ...ott];
  const pickPool = all.filter((x) => x.rating != null && x.votes >= 20);
  const pick = (pickPool.filter((x) => x.isNew).sort((a, b) => b.rating - a.rating)[0]) ||
               (pickPool.sort((a, b) => b.rating - a.rating)[0]) || all[0] || null;

  const data = { generatedAt: new Date().toISOString(), pick: pick ? pick.title : null, theatres, ott, comingSoon };
  fs.writeFileSync("data.json", JSON.stringify(data, null, 1));
  console.log(`Done. ${theatres.length} theatre, ${ott.length} OTT, ${comingSoon.length} upcoming. Pick: ${data.pick}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
