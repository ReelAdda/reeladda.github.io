// ============================================================================
// reception.js — what the page cites for the critics' side (28 Oct 2026).
//
// The takes cache (lib/editorial.js) reads a film's Wikipedia reception section and keeps the
// Rotten Tomatoes and Metacritic figures with their review counts, and the count and median of
// the individual critics' ratings it lists. This module turns that record into the one line the
// score card's "Critics" row shows, and into the HTML comment the facts reader (lib/facts.js)
// reads it back from, so a frozen page keeps its figures and the sitemap date moves only when a
// figure changes. Pure: no fetching here.
//
// Honesty rules: every figure is dated to the day the article was read ("per Wikipedia, 10 Oct
// 2026") and never presented as live; no critic's or publication's name is stored or shown; a
// median is given only from the count the cache holds (three or more, lib/editorial.js
// RATINGS_MIN), never computed here from fewer.
// ============================================================================
"use strict";

const RECEPTION_FEATURE = "wiki-reception";
const MARK_RE = /<!--FC:reception=([^>]*)-->/;

// Pure: the record as an HTML comment, or "" without one.
function receptionMark(rec) {
  return rec && (rec.rt || rec.mc || rec.ratings) ? `<!--FC:reception=${encodeURIComponent(JSON.stringify(rec))}-->` : "";
}
// Pure: the record read back from a page, or null.
function readReceptionMark(html) {
  const m = MARK_RE.exec(String(html || ""));
  if (!m) return null;
  try { const r = JSON.parse(decodeURIComponent(m[1])); return r && (r.rt || r.mc || r.ratings) ? r : null; } catch { return null; }
}
// Pure: the facts key — values and counts, which are the facts; nothing else.
function receptionKey(rec) {
  if (!rec) return "";
  return [rec.rt ? `rt${rec.rt.pct}${rec.rt.n ? `/${rec.rt.n}` : ""}` : "", rec.mc ? `mc${rec.mc.score}${rec.mc.n ? `/${rec.mc.n}` : ""}` : "",
    rec.ratings ? `cr${rec.ratings.n}@${rec.ratings.median}` : ""].filter(Boolean).join("|");
}
// Pure: does an aggregator figure (0–100) contradict the row's own verdict? A "Positive" row
// beside a 39% figure, or "Negative" beside 100%, happens when Wikipedia's consensus sentence
// is about one season or era and the figure about another (The Orville, Scarface): 22 of 1,796
// cached entries, 28 Oct 2026. The figure is then withheld rather than shown against the label.
function contradicts(value, tone) {
  if (value == null || !tone) return false;
  if (/^(positive|acclaim)$/i.test(tone) && value < 50) return true;
  if (/^negative$/i.test(tone) && value >= 70) return true;
  return false;
}
// Pure: the one line. `fmt(iso)` formats the read date for the edition; `tone` is the Critics
// row's label (lib/fcscore.js), so no cited figure argues with it. At most two figures, each
// with its scale: one aggregator (Rotten Tomatoes first, else Metacritic) and the published
// ratings, so the row never stacks three numbers on three scales beside the audience ring.
function receptionLine(rec, fmt = (d) => d, { tone = null } = {}) {
  if (!rec) return "";
  const parts = [];
  // A series figure names its season: Wikipedia gives them per season.
  const paren = (bits) => (bits.filter(Boolean).length ? ` (${bits.filter(Boolean).join(", ")})` : "");
  const rt = rec.rt && !contradicts(rec.rt.pct, tone) ? rec.rt : null;
  const mc = rec.mc && !contradicts(rec.mc.score, tone) ? rec.mc : null;
  if (rt) parts.push(`${rt.pct}% on Rotten Tomatoes${paren([rt.n ? `${rt.n} reviews` : "", rt.season ? `season ${rt.season}` : ""])}`);
  else if (mc) parts.push(`Metacritic ${mc.score}/100${paren([mc.n ? `${mc.n} critics` : "", mc.season ? `season ${mc.season}` : ""])}`);
  if (rec.ratings && rec.ratings.n) parts.push(`${rec.ratings.n} published rating${rec.ratings.n === 1 ? "" : "s"}${rec.ratings.median != null && rec.ratings.n >= 3 ? `, median ${rec.ratings.median}/5` : ""}`);
  if (!parts.length) return "";
  return `${parts.join(" · ")} — per Wikipedia${rec.asOf ? `, ${fmt(rec.asOf)}` : ""}`;
}

// Pure: the critics' tone a cited figure implies, for a page whose own reading has no settled
// tone yet: 70%+ positive, 50–69 mixed, under 50 negative (Rotten Tomatoes first, else
// Metacritic). null without a figure. A label beside a figure must never argue with it.
function toneFromFigure(rec) {
  const v = rec && rec.rt ? rec.rt.pct : rec && rec.mc ? rec.mc.score : null;
  if (v == null) return null;
  return v >= 70 ? "positive" : v >= 50 ? "mixed" : "negative";
}

// Pure: the verdict's one-line reason with its evidence in it. The table's sentence ("Audiences
// and critics agree.") is the same on every page; with the page's own numbers after each word
// it is different on every page by construction, and the reader sees what it rests on:
// "Audiences (8.6 from 198 ratings) and critics (91% positive on Rotten Tomatoes) agree."
// A figure that argues with the critics' label is left out (contradicts), as on the line.
function reasonWithEvidence(reason, item) {
  let out = String(reason || "");
  if (!out) return out;
  const votes = Number((item && item.votes) || 0);
  if (item && item.rating != null && votes) out = out.replace(/\b(audiences?)\b/i, (m) => `${m} (${Number(item.rating).toFixed(1)} from ${votes.toLocaleString("en-IN")} ratings)`);
  const rec = item && item.reception, tone = item && item.fcScore && item.fcScore.critics;
  let ev = null;
  if (rec && rec.rt && !contradicts(rec.rt.pct, tone)) ev = `${rec.rt.pct}% positive on Rotten Tomatoes`;
  else if (rec && rec.mc && !contradicts(rec.mc.score, tone)) ev = `Metacritic ${rec.mc.score}/100`;
  else if (rec && rec.ratings && rec.ratings.n >= 3 && rec.ratings.median != null) ev = `median ${rec.ratings.median}/5 from ${rec.ratings.n} reviews`;
  if (ev) out = out.replace(/\b(critics)\b/i, (m) => `${m} (${ev})`);
  return out;
}

module.exports = { RECEPTION_FEATURE, contradicts, readReceptionMark, reasonWithEvidence, receptionKey, receptionLine, receptionMark, toneFromFigure };
