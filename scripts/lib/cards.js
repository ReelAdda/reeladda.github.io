"use strict";

const fs = require("fs");
const { escHtml, fmtDateShort, fmtRuntime, localeFor } = require("./core.js");
const { releaseState, normalizeUpcoming } = require("./release.js");
const { whyWatch } = require("./whywatch.js");

let _resvg = null, _resvgTried = false;

// ============================================================================
// SHARE CARDS — the branded og:image.
//
// Today every shared FilmyChill link previews as a TMDB backdrop: the film's art, none of
// our identity. This renders a card that is unmistakably ours — verdict ladder, rating,
// fit line, brand type — so a WhatsApp forward or an Instagram share advertises the site.
//
// Deliberately typographic, NO poster or backdrop art. Two reasons: studio key art in a
// standalone branded card is promotional use of someone else's IP, and a poster card looks
// like every other aggregator. Type is what makes a screenshot recognisable without a logo.
//
// Pure function -> SVG string, so it is fully testable without a rasteriser. PNG conversion
// is a separate, optional step (see writeShareCards).
// ============================================================================
const CARD_W = 1200, CARD_H = 630;

// SVG has no text wrapping. Estimate advance width per font (measured against the two
// faces we ship) and break on word boundaries. Conservative on purpose: a slightly short
// line is invisible, an overflowing one wrecks the card.
function wrapForCard(text, fontSize, maxWidth, maxLines, face = "inter") {
  const ratio = face === "anton" ? 0.44 : 0.52;
  const perChar = fontSize * ratio;
  const limit = Math.max(6, Math.floor(maxWidth / perChar));
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= limit) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w;
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[,;:]$/, "") + "…";
  }
  return lines.slice(0, maxLines);
}

// Status pill copy, reusing the release-state machine so a card can never contradict the
// page it represents.

// Status pill copy, reusing the release-state machine so a card can never contradict the
// page it represents.
function cardStatus(item, cfg) {
  const st = releaseState(item.released);
  if (st === "today") return "RELEASES TODAY";
  if (st === "upcoming") return item.released
    ? `IN CINEMAS ${fmtDateShort(item.released, Date.now(), localeFor(cfg && cfg.code)).toUpperCase()}`
    : "COMING SOON";
  if (item.platform === "Theatres") return "IN THEATRES";
  if (item.platform) return `NOW ON ${String(item.platform).toUpperCase()}`;
  return "OUT NOW";
}

// Vote counts are bucketed on the card, and that is a storage decision as much as a design
// one: an exact count changes every single day for an active title, and each change rewrites
// a PNG that lives in git history forever. Buckets round DOWN and are marked "+", so the
// label is never an overstatement. Under 50 stays exact — that is precisely the range where
// the reader needs to distrust the score.

// Vote counts are bucketed on the card, and that is a storage decision as much as a design
// one: an exact count changes every single day for an active title, and each change rewrites
// a PNG that lives in git history forever. Buckets round DOWN and are marked "+", so the
// label is never an overstatement. Under 50 stays exact — that is precisely the range where
// the reader needs to distrust the score.
function voteCountLabel(votes) {
  if (!votes) return "";
  if (votes < 50) return `${votes} rating${votes === 1 ? "" : "s"}`;
  if (votes < 1000) return `${Math.floor(votes / 50) * 50}+ ratings`;
  if (votes < 10000) return `${(Math.floor(votes / 500) * 500 / 1000).toFixed(1)}k+ ratings`;
  return `${Math.floor(votes / 5000) * 5}k+ ratings`;
}


function shareCardSvg(item, cfg) {
  if (!item || !item.title) return null;
  const e = escHtml;
  const useImdb = item.imdbRating != null;
  const rating = useImdb ? item.imdbRating : item.rating;
  const votes = useImdb ? item.imdbVotes : item.votes;
  // Never print a score the data doesn't support — the card is the most-copied surface on
  // the site, so an unearned number travels furthest.
  const showScore = rating != null && votes && votes >= 10;
  const verdict = (item.verdict || "").toUpperCase();
  const fit = whyWatch(item);
  const blurb = item.take || (fit ? fit.text : "");
  const status = cardStatus(item, cfg);
  const titleLines = wrapForCard(item.title, 46, 620, 2, "inter");
  const blurbLines = wrapForCard(blurb, 26, 660, 2, "inter");
  const year = item.released ? String(item.released).slice(0, 4) : "";
  const meta = [item.language, item.genre, item.runtime ? fmtRuntime(item.runtime) : null]
    .filter(Boolean).join("  ·  ");
  const scoreStr = showScore ? Number(rating).toFixed(1) : null;
  const pillW = status.length * 14 + 44;
  const titleTop = 322 - (titleLines.length - 1) * 28;
  const blurbTop = titleTop + titleLines.length * 56 + 66;

  // Flat fills only — no gradients. A smooth gradient costs ~110KB extra per PNG, and these
  // files live in the repo forever; flat colour keeps a card around 25KB.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
<rect width="${CARD_W}" height="${CARD_H}" fill="#1A1633"/>
<rect x="0" y="0" width="14" height="${CARD_H}" fill="#FFAD1F"/>
<rect x="784" y="0" width="416" height="${CARD_H}" fill="#221D47"/>
<text x="64" y="96" font-family="Anton" font-size="42" fill="#FFF7EC">FILMY<tspan fill="#FFAD1F">CHILL</tspan></text>
<rect x="64" y="132" width="${pillW}" height="48" rx="24" fill="#FFFFFF" fill-opacity="0.10"/>
<text x="${64 + pillW / 2}" y="164" text-anchor="middle" font-family="Inter" font-size="22" fill="#FFF7EC" letter-spacing="1.4">${e(status)}</text>
${titleLines.map((l, i) => `<text x="64" y="${titleTop + i * 56}" font-family="Inter" font-size="46" fill="#FFF7EC">${e(l)}</text>`).join("\n")}
<text x="64" y="${titleTop + titleLines.length * 56 - 4}" font-family="Inter" font-size="24" fill="#8F8BB8">${e(meta)}${year ? `  ·  ${e(year)}` : ""}</text>
${blurbLines.map((l, i) => `<text x="64" y="${blurbTop + i * 36}" font-family="Inter" font-size="26" fill="#C9C5E8">${e(l)}</text>`).join("\n")}
<text x="64" y="${CARD_H - 34}" font-family="Inter" font-size="23" fill="#6E6A96">filmychill.com</text>
${scoreStr
  ? `<text x="992" y="286" text-anchor="middle" font-family="Anton" font-size="168" fill="#FFAD1F">${scoreStr}</text>
<text x="992" y="330" text-anchor="middle" font-family="Inter" font-size="26" fill="#8F8BB8">${e(voteCountLabel(votes))}</text>`
  : `<text x="992" y="272" text-anchor="middle" font-family="Anton" font-size="104" fill="#FFAD1F">NEW</text>
<text x="992" y="322" text-anchor="middle" font-family="Inter" font-size="26" fill="#8F8BB8">too early to rate</text>`}
<rect x="864" y="378" width="256" height="4" fill="#FFAD1F" fill-opacity="0.5"/>
${wrapForCard(verdict || "FRESH RELEASE", 44, 360, 2, "anton").map((l, i) =>
  `<text x="992" y="${446 + i * 52}" text-anchor="middle" font-family="Anton" font-size="44" fill="#FFF7EC">${e(l)}</text>`).join("\n")}
</svg>`;
}

// Where a card lives on disk / on the web. One card per (country, film): the status pill
// and platform differ per market, so a shared /us/ link must not preview India's wording.

// Where a card lives on disk / on the web. One card per (country, film): the status pill
// and platform differ per market, so a shared /us/ link must not preview India's wording.
function cardPaths(item, cfg) {
  const code = (cfg && cfg.code) || "in";
  const slug = item && item.slug;
  if (!slug) return null;
  return { file: `cards/${code}/${slug}.png`, url: `https://filmychill.com/cards/${code}/${slug}.png` };
}

// PNG rendering is OPTIONAL. @resvg/resvg-js is a native module; if it is missing or fails
// to load, card generation is skipped, socialImage() falls back to the TMDB backdrop and
// the build completes exactly as it does today. A branding upgrade must never be able to
// take down the daily build.

function loadResvg() {
  if (_resvgTried) return _resvg;
  _resvgTried = true;
  try { _resvg = require("@resvg/resvg-js").Resvg; }
  catch { console.warn("  share cards: @resvg/resvg-js not installed — keeping TMDB backdrops"); }
  return _resvg;
}

// The rasteriser needs TTF/OTF. The .woff2 files the SITE uses will not do: resvg accepts
// a woff2 without error and then draws NOTHING, so a wrong font path yields blank cards
// rather than a failure. Both faces are therefore required, and each is looked up in the
// preferred location first, then the repo root — uploads land there more often than not.

// The rasteriser needs TTF/OTF. The .woff2 files the SITE uses will not do: resvg accepts
// a woff2 without error and then draws NOTHING, so a wrong font path yields blank cards
// rather than a failure. Both faces are therefore required, and each is looked up in the
// preferred location first, then the repo root — uploads land there more often than not.
const CARD_FONT_NAMES = ["anton-latin.ttf", "inter-var-latin.ttf"];

const CARD_FONT_DIRS = ["fonts/", ""];

function cardFontFiles() {
  const found = [];
  for (const name of CARD_FONT_NAMES) {
    const hit = CARD_FONT_DIRS.map((d) => `${d}${name}`).find((p) => fs.existsSync(p));
    if (hit) found.push(hit);
    else console.warn(`  share cards: ${name} not found in ${CARD_FONT_DIRS.map((d) => d || "repo root").join(" or ")}`);
  }
  return found;
}


function writeShareCards(data, cfg) {
  const Resvg = loadResvg();
  if (!Resvg) return 0;
  // Both faces or none: Anton carries the score and verdict, Inter the title and blurb, so
  // rendering with one of them produces a card with invisible text — worse than no card.
  const fonts = cardFontFiles();
  if (fonts.length !== CARD_FONT_NAMES.length) { console.warn("  share cards: skipped (brand fonts incomplete)"); return 0; }
  const code = (cfg && cfg.code) || "in";
  const dir = `cards/${code}`;
  fs.mkdirSync(dir, { recursive: true });
  const items = [...(data.theatres || []), ...(data.ott || []), ...normalizeUpcoming(data.comingSoon)];
  const keep = new Set();
  let written = 0;
  for (const item of items) {
    const paths = cardPaths(item, cfg);
    if (!paths) continue;
    keep.add(`${item.slug}.png`);
    let png;
    try {
      const svg = shareCardSvg(item, cfg);
      if (!svg) continue;
      png = Buffer.from(new Resvg(svg, { font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: "Inter" } }).render().asPng());
    } catch (e) { console.warn(`  card [${code}/${item.slug}] skipped: ${e.message}`); continue; }
    // Byte-compare before writing: an unchanged card must not produce a new git object.
    // Ratings move constantly; without this every build would commit the whole set again.
    if (fs.existsSync(paths.file) && fs.readFileSync(paths.file).equals(png)) continue;
    fs.writeFileSync(paths.file, png);
    written++;
  }
  // Films that left this week's lists lose their card: the directory tracks the live set
  // instead of growing without bound. Their pages fall back to the backdrop.
  let pruned = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".png") && !keep.has(f)) { fs.unlinkSync(`${dir}/${f}`); pruned++; }
  }
  console.log(`  share cards [${code}]: ${written} written, ${keep.size} live, ${pruned} pruned`);
  return written;
}


module.exports = {
  cardFontFiles,
  cardPaths,
  cardStatus,
  loadResvg,
  shareCardSvg,
  voteCountLabel,
  wrapForCard,
  writeShareCards,
};
