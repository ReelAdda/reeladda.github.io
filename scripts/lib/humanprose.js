"use strict";

// ============================================================================
// humanprose.js: the site's own sentences, said plainly (30 Oct 2026).
//
// Wikipedia's field guide to machine-written text (Wikipedia:Signs of AI writing) lists the
// patterns readers now recognise. FilmyChill's templates carried several of them on almost
// every page: spaced em dashes in nearly every sentence (17,141 of 21,153 pages), canned "fit"
// lines that suit any film ("Standard length — a normal evening's watch, nothing to plan
// around", 1,400 pages), a rhetorical hook in ~9,000 snippets ("— but is it worth your
// evening?"), "not X, Y" asides ("promising, not proven") and critics' summaries rotated
// through synonyms so no two cards matched ("A drubbing from reviewers", "the fault line"),
// which is the guide's "elegant variation" sign in its purest form.
//
// Rollout "human-prose" switches pages to plain wording: film pages by slug, list pages by
// their canonical URL, so each stage rewrites a share of the site and never all of it at once.
// scanProse() is what the tests run over every page shape, so new template text can't bring
// the patterns back. Third-party text (TMDB synopses, titles, episode names, cast) is not ours
// to rewrite: siteProse() leaves it out of the scan.
// ============================================================================
const { inRollout } = require("./rollout.js");

const HUMAN_PROSE = "human-prose";
const plainOn = (key) => !!key && inRollout(HUMAN_PROSE, String(key));

// The site's own prose on a rendered page: the meta description and the body, without scripts,
// styles, comments, the third-party text named above, and the few labels code reads back by
// their exact wording (status pills, lib/facts.js pageState). `skipPending` also drops the
// theatrical "when will it stream" block, whose wording the daily sweeps match (lib/pagekit.js).
function siteProse(html, { skipPending = false } = {}) {
  let h = String(html || "");
  const dec = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  // Names are not prose: the page's own title (its h1, without the year) and every title shown in
  // a link to a film page, wherever they are repeated ("Is Game Changer worth watching?").
  const names = new Set();
  const h1 = (/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(h) || [])[1];
  if (h1) names.add(dec(h1).replace(/\s*\(\d{4}\)$/, ""));
  for (const m of h.matchAll(/<a\b[^>]*href="[^"]*\/movie\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
    const t = (/<(?:h3|b|strong|span|div)[^>]*class="[^"]*\b(?:t|title|ct|name)\b[^"]*"[^>]*>([\s\S]*?)<\//.exec(m[1]) || [])[1];
    const name = dec(t || m[1]);
    if (name && name.length <= 90) names.add(name);
  }
  // Titles in "If you liked this" cards, linked or not (lib/filmpage.js simGridHtml).
  for (const m of h.matchAll(/<div class="st">([\s\S]*?)<\/div>/g)) { const name = dec(m[1]); if (name && name.length <= 90) names.add(name); }
  const desc = (/<meta name="description" content="([^"]*)"/.exec(h) || [])[1] || "";
  h = h.replace(/[\s\S]*?<body[^>]*>/, "").replace(/<a\b[^>]*href="[^"]*\/movie\/[^"]*"[^>]*>[\s\S]*?<\/a>/g, " ");
  if (skipPending) h = h.replace(/<!--SW:pending-->[\s\S]*?<!--\/SW:pending-->/g, " ");
  h = h.replace(/<(script|style|svg|noscript|pre|code|textarea)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")   // code samples aren't prose
    // The vote box asks the reader a real question for its buttons ("Watched it? Was it worth
    // it?"): a form, not prose. Same block lib/sitemap.js leaves out of the page's content.
    .replace(/<div class="fcvote"[\s\S]*?<div class="fcvote-done"[^>]*><\/div>\s*<\/div>/g, " ")
    .replace(/<h1\b[\s\S]*?<\/h1>/gi, "\n")                                    // the title
    .replace(/<h2>Story<\/h2>\s*<p>[\s\S]*?<\/p>/g, "\n")                      // TMDB synopsis
    .replace(/<ol class="eplist">[\s\S]*?<\/ol>/g, "\n")                        // episode names
    .replace(/<div class="cast-strip">[\s\S]*?<\/div>\s*<\/div>/g, "\n")        // cast
    // Platform pills are names; a status pill ("Opened in cinemas 2 Oct, not streaming yet") is ours.
    .replace(/<span class="pill">([^<]*)<\/span>/g, (m, t) => (/^(?:Opened in|Theatrical run|In (?:theatres|cinemas)|Releases?|Not out)/.test(t) ? `\n${t}\n` : " "))
    .replace(/<(?:h3|b|strong)[^>]*class="[^"]*\b(?:t|title|ct)\b[^"]*"[^>]*>[\s\S]*?<\/(?:h3|b|strong)>/g, " ");
  const text = h.replace(/<\/?(?:p|div|li|ul|ol|h[1-6]|tr|td|th|table|section|details|summary|footer|nav|br)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;|&#\d+;/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*/g, "\n").trim();
  let out = [desc.replace(/&#39;/g, "'").replace(/&amp;/g, "&"), text].filter(Boolean).join("\n");
  for (const n of [...names].filter((x) => x.length > 1).sort((a, b) => b.length - a.length)) out = out.split(n).join("{T}");
  return out;
}

// The patterns, strongest first. Each is a reason to rewrite the sentence, with what to do.
// The last group is this site's own retired flourishes, listed so they can't return.
const RULES = [
  { id: "em-dash", re: /—/g, fix: "Use a full stop, comma or colon." },
  { id: "significance", re: /\b(?:stands|serves) as (?:a|an|the) (?:testament|reminder|symbol)\b|\btestament to\b|\b(?:crucial|pivotal|vital|key) (?:role|moment)\b|\bevolving landscape\b|\bindelible mark\b|\bsetting the stage for\b/gi, fix: "State the plain fact." },
  { id: "ing-tail", re: /,\s+(?:highlighting|underscoring|emphasi[sz]ing|ensuring|reflecting|symboli[sz]ing|showcasing|fostering|cementing)\b/gi, fix: "End the sentence at the comma." },
  { id: "promo", re: /\b(?:boasts?|vibrant|nestled|in the heart of|groundbreaking|breathtaking|captivating|unparalleled|seamless(?:ly)?|must-see|game[- ]changer|rich tapestry)\b/gi, fix: "Say the fact behind the adjective." },
  { id: "not-just", re: /\bnot (?:only|just|merely)\b[^.!?]{0,90}?\bbut\b|\b(?:it(?:'|’)?s|it is|this is) not (?:just )?[^.!?,;]{1,40}[,;:]\s*it(?:'|’)?s\b|\b\w+, not \w+\.$/gim, fix: "State the positive fact once." },
  { id: "rather-than", re: /\brather than (?:a |an |the )?\w+/gi, fix: "Drop the contrast unless it is a real choice." },
  // A short question answered in the same breath ("Staying in? Put on…"): a hook, not a question
  // the reader asked. FAQ questions sit on their own line and never match.
  { id: "question-hook", re: /(?:^|[.!:][ \t]+)(?:[A-Z][\w'’]*)(?:[ \t]+[\w'’]+){0,4}\?[ \t]+[A-Z]/gm, fix: "State the answer; drop the question that sets it up." },
  { id: "hedge", re: /\bit(?:'|’)?s (?:important|worth) (?:to note|noting)\b|\bbased on (?:the )?available information\b|\bnot widely (?:available|documented)\b/gi, fix: "Say what is known and where it came from." },
  { id: "chatbot", re: /\bI hope this helps\b|\blet me know\b|\bas an AI\b|\bas of my last (?:knowledge|training)\b|\b(?:Certainly|Of course)!/gi, fix: "Remove: it's addressed to a chatbot user." },
  { id: "summary", re: /(?:^|[.!?]\s+)(?:In summary|In conclusion|Overall|Ultimately|In short)[,:]/gm, fix: "Delete the recap." },
  { id: "placeholder", re: /\[(?:insert|placeholder|your)[^\]]*\]|\{\{\s*\w+\s*\}\}|\bundefined\b|\bNaN\b|\bTODO\b|\bLorem ipsum\b/g, fix: "Fill in or remove." },
  { id: "markdown", re: /\*\*[^*\n]{2,60}\*\*|```|\[[^\]\n]{1,60}\]\(https?:/g, fix: "Render it, don't show raw Markdown." },
  { id: "retired", re: /worth your evening|verdict inside|nothing to plan around|threaded through|seasons deep|one-night sampler|scheduling gymnastics|you know what you(?:'|’)re getting|promising, not proven|early signal rather than|circling back|took the heat|fault line|drubbing|love-it-or-hate-it|the audience counterpoint|an honest word/gi, fix: "A retired flourish: write the fact." },
];

// ============================================================================
// THE LAST PASS (30 Oct 2026), the same design as lib/honest.js. The archive chain and the daily
// sweeps (lib/pagekit.js settleReleasedCopy, lib/lifecycle.js) write and later re-match certain
// sentences by their exact wording, dashes included. They keep doing so; this pass runs after the
// last writer and turns those sentences plain on pages in the rollout, and its exact inverse turns
// them back on the rest, so the share can grow or go back to 0. lib/writeif.js compares pages
// through humanWording, so a fresh render in the sweeps' wording isn't mistaken for a change.
// Each plain form is used nowhere else, which is what makes the inverse exact.
// ============================================================================
const A = "(?:'|&#39;)";
const ap = (m) => (m.includes("&#39;") ? "&#39;" : "'");
const HUMAN_RULES = [
  // Cinema run, in the "where to watch" answer: "…and may still be showing — check local cinema listings."
  { fwd: [/ and may still be showing — check local cinema listings/g, () => " and may still be showing, so check local cinema listings"],
    rev: [/ and may still be showing, so check local cinema listings/g, () => " and may still be showing — check local cinema listings"] },
  // "…release date yet — check back soon." (archive patch, honest wording or not)
  { fwd: [/ yet — check back soon\./g, () => " yet. Check back soon."],
    rev: [/ yet\. Check back soon\./g, () => " yet — check back soon."] },
  // The settled answer: "It isn't streaming yet — this page updates the day it is."
  { fwd: [new RegExp(`It isn${A}t streaming yet — this page updates the day it is\\.`, "g"), (m) => `It isn${ap(m)}t streaming yet. This page updates the day it is.`],
    rev: [new RegExp(`It isn${A}t streaming yet\\. This page updates the day it is\\.`, "g"), (m) => `It isn${ap(m)}t streaming yet — this page updates the day it is.`] },
  // "…streaming there now — see where to watch above." / "It's streaming in X now — see where…"
  { fwd: [/ now — see where to watch above\./g, () => " now. See where to watch above."],
    rev: [/ now\. See where to watch above\./g, () => " now — see where to watch above."] },
  // Archive run line: "It opened in theatres in X on D — check back here for its OTT arrival."
  { fwd: [/ — check back here for its (OTT|streaming) arrival\./g, (m, k) => `. Check back here for its ${k} arrival.`],
    rev: [/\. Check back here for its (OTT|streaming) arrival\./g, (m, k) => ` — check back here for its ${k} arrival.`] },
  // Answer box: "…hasn't been announced — this page updates the day it lands on streaming."
  { fwd: [/ — this page updates the day it lands on streaming\./g, () => ". This page updates the day it lands on streaming."],
    rev: [/\. This page updates the day it lands on streaming\./g, () => " — this page updates the day it lands on streaming."] },
  // The waiting block's estimate label, as the sweeps keep it current. "Not X but Y" plus a dash
  // becomes two plain statements of what the number is and what we haven't seen.
  { fwd: [new RegExp(`That${A}s the usual pattern, not a confirmed date — (we haven${A}t seen one announced|no platform has announced one)\\.`, "g"),
    (m, c) => `That${ap(m)}s an estimate from past releases. ${/^we/.test(c) ? `We haven${ap(m)}t seen a date announced` : "No platform has announced a date"}.`],
    rev: [new RegExp(`That${A}s an estimate from past releases\\. (We haven${A}t seen a date announced|No platform has announced a date)\\.`, "g"),
      (m, c) => `That${ap(m)}s the usual pattern, not a confirmed date — ${/^We/.test(c) ? `we haven${ap(m)}t seen one announced` : "no platform has announced one"}.`] },
  // Waiting block lead on pages the lean trim doesn't reach: "<p>Not streaming yet — X …"
  { fwd: [/<p>Not streaming yet — /g, () => "<p>Not streaming yet: "],
    rev: [/<p>Not streaming yet: /g, () => "<p>Not streaming yet — "] },
  // Status pills (lib/pagekit.js openPill, lib/lifecycle.js): lib/facts.js STATUS_PILL knows a
  // status pill by how it starts, and the sweeps match both forms (OPEN_PILL_RE, RUN_ENDED_PILL_RE).
  { fwd: [/(<span class="pill">Opened in cinemas [^<]*?) — not streaming yet<\/span>/g, (m, a) => `${a}, not streaming yet</span>`],
    rev: [/(<span class="pill">Opened in cinemas [^<]*?), not streaming yet<\/span>/g, (m, a) => `${a} — not streaming yet</span>`] },
  { fwd: [/<span class="pill">Theatrical run ended — (OTT|streaming) arrival pending<\/span>/g, (m, k) => `<span class="pill">Theatrical run ended, ${k} arrival pending</span>`],
    rev: [/<span class="pill">Theatrical run ended, (OTT|streaming) arrival pending<\/span>/g, (m, k) => `<span class="pill">Theatrical run ended — ${k} arrival pending</span>`] },
  // Arrival note on a page the arrival sweep patched in place (lib/lifecycle.js applyArrivalPatch).
  { fwd: [/We recheck periodically — platforms do drop titles\./g, () => "We recheck periodically, because platforms do drop titles."],
    rev: [/We recheck periodically, because platforms do drop titles\./g, () => "We recheck periodically — platforms do drop titles."] },
  // Departure notice (lib/lifecycle.js): "…we track in India — it was on Netflix." lib/facts.js reads
  // the platform back from either form.
  { fwd: [/ — it was on /g, () => ". It was on "],
    rev: [/\. It was on /g, () => " — it was on "] },
  // Departure notice (lib/lifecycle.js): "We keep looking — if it comes back, this page updates."
  { fwd: [/We keep looking — if it comes back, this page updates\./g, () => "We keep looking, and this page updates if it comes back."],
    rev: [/We keep looking, and this page updates if it comes back\./g, () => "We keep looking — if it comes back, this page updates."] },
  // …and its unconfirmed form: "We keep looking — this page updates the day it arrives."
  { fwd: [/We keep looking — this page updates the day it arrives\./g, () => "We keep looking, and this page updates the day it arrives."],
    rev: [/We keep looking, and this page updates the day it arrives\./g, () => "We keep looking — this page updates the day it arrives."] },
];
// Pure: the plain wording. Idempotent.
function humanWording(html) {
  let s = String(html);
  for (const r of HUMAN_RULES) s = s.replace(r.fwd[0], r.fwd[1]);
  return s;
}
// Pure: back to the sweeps' wording (pages outside the rollout). Idempotent.
function machineWording(html) {
  let s = String(html);
  for (const r of [...HUMAN_RULES].reverse()) s = s.replace(r.rev[0], r.rev[1]);
  return s;
}
// The pass over film pages, after the last page writer (scripts/update.js). `included(slug, rel)`:
// the build passes the rollout AND "drawn from its facts" (lib/migrate.js manifest .rendered).
// A page drawn from facts is rebuilt in the sweeps' wording every run before this pass; a page
// still patched in place is re-read by the sweeps, which must find their own wording there
// (the departure patch would otherwise miss "…streaming there now — see where to watch above").
function applyHumanWording(files, { root = ".", included = (slug) => plainOn(slug) } = {}) {
  const fs = require("fs"), path = require("path");
  const res = { pages: 0, plain: 0, changed: 0 };
  for (const rel of files) {
    const m = /(?:^|\/)movie\/([^/]+)\.html$/.exec(String(rel).replace(/\\/g, "/"));
    if (!m) continue;
    const file = path.join(root, rel);
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    res.pages++;
    const on = included(m[1], String(rel).replace(/\\/g, "/"));
    if (on) res.plain++;
    const next = on ? humanWording(html) : machineWording(html);
    if (next !== html) { fs.writeFileSync(file, next); res.changed++; }
  }
  return res;
}

// ============================================================================
// THE AUDIT (every build, scripts/update.js): every page the rollout has switched is scanned for
// the patterns above, after the last writer. Any hit makes the run red (lib/runhealth.js
// healthIssue), with the sentence and an example page, so nothing that slips past the template
// tests (scripts/test.js) or the commit check (scripts/prose-check.js) stays on the site unseen.
// Pages not yet switched are counted, not judged.
// ============================================================================
// The rollout key of a built page: a film page's slug, else its canonical URL.
function plainKeyOf(rel, html) {
  const m = /(?:^|\/)movie\/([^/]+)\.html$/.exec(String(rel).replace(/\\/g, "/"));
  if (m) return m[1];
  return (/<link rel="canonical" href="([^"]+)"/.exec(String(html || "")) || [])[1] || "";
}
function auditProse(files, { root = ".", included = plainOn, max = 8 } = {}) {
  const fs = require("fs"), path = require("path");
  const res = { pages: 0, switched: 0, withSigns: 0, hits: 0, shapes: new Map() };
  for (const rel of files) {
    let html;
    try { html = fs.readFileSync(path.join(root, rel), "utf8"); } catch { continue; }
    if (!/<body/i.test(html)) continue;
    res.pages++;
    if (!included(plainKeyOf(rel, html), String(rel).replace(/\\/g, "/"))) continue;
    res.switched++;
    const hits = scanProse(siteProse(html));
    if (!hits.length) continue;
    res.withSigns++; res.hits += hits.length;
    for (const h of hits) {
      const k = `${h.rule}: ${h.sentence.replace(/\d+/g, "#").slice(0, 140)}`;
      const r = res.shapes.get(k) || { n: 0, example: String(rel).replace(/\\/g, "/") };
      r.n++; res.shapes.set(k, r);
    }
  }
  res.top = [...res.shapes].sort((a, b) => b[1].n - a[1].n).slice(0, max).map(([k, v]) => `${k} (×${v.n}, e.g. /${v.example})`);
  delete res.shapes;
  return res;
}

// Pure: every hit in `text`, with the sentence it sits in. `allow` lists exact fragments that
// are labels other code reads by their wording, not prose.
function scanProse(text, { allow = [] } = {}) {
  let t = String(text || "");
  for (const a of allow) t = t.split(a).join(" ");
  const hits = [];
  for (const r of RULES) {
    r.re.lastIndex = 0;
    for (const m of t.matchAll(r.re)) {
      const from = Math.max(0, t.lastIndexOf("\n", m.index) + 1);
      const to = t.indexOf("\n", m.index);
      hits.push({ rule: r.id, match: m[0], sentence: t.slice(from, to < 0 ? t.length : to).trim().slice(0, 200), fix: r.fix });
    }
  }
  return hits;
}

module.exports = { HUMAN_PROSE, HUMAN_RULES, RULES, applyHumanWording, auditProse, humanWording, machineWording, plainKeyOf, plainOn, scanProse, siteProse };
