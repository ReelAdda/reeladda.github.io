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
  const desc = (/<meta name="description" content="([^"]*)"/.exec(h) || [])[1] || "";
  h = h.replace(/[\s\S]*?<body[^>]*>/, "");
  if (skipPending) h = h.replace(/<!--SW:pending-->[\s\S]*?<!--\/SW:pending-->/g, " ");
  h = h.replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<h1\b[\s\S]*?<\/h1>/gi, "\n")                                    // the title
    .replace(/<h2>Story<\/h2>\s*<p>[\s\S]*?<\/p>/g, "\n")                      // TMDB synopsis
    .replace(/<ol class="eplist">[\s\S]*?<\/ol>/g, "\n")                        // episode names
    .replace(/<div class="cast-strip">[\s\S]*?<\/div>\s*<\/div>/g, "\n")        // cast
    .replace(/<span class="pill">[^<]*<\/span>/g, " ")                          // status and platform pills
    .replace(/<(?:h3|b|strong)[^>]*class="[^"]*\b(?:t|title|ct)\b[^"]*"[^>]*>[\s\S]*?<\/(?:h3|b|strong)>/g, " ");
  const text = h.replace(/<\/?(?:p|div|li|ul|ol|h[1-6]|tr|td|th|table|section|details|summary|footer|nav|br)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;|&#\d+;/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*/g, "\n").trim();
  return [desc.replace(/&#39;/g, "'").replace(/&amp;/g, "&"), text].filter(Boolean).join("\n");
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
  { id: "hedge", re: /\bit(?:'|’)?s (?:important|worth) (?:to note|noting)\b|\bbased on (?:the )?available information\b|\bnot widely (?:available|documented)\b/gi, fix: "Say what is known and where it came from." },
  { id: "chatbot", re: /\bI hope this helps\b|\blet me know\b|\bas an AI\b|\bas of my last (?:knowledge|training)\b|\b(?:Certainly|Of course)!/gi, fix: "Remove: it's addressed to a chatbot user." },
  { id: "summary", re: /(?:^|[.!?]\s+)(?:In summary|In conclusion|Overall|Ultimately|In short)[,:]/gm, fix: "Delete the recap." },
  { id: "placeholder", re: /\[(?:insert|placeholder|your)[^\]]*\]|\{\{\s*\w+\s*\}\}|\bundefined\b|\bNaN\b|\bTODO\b|\bLorem ipsum\b/g, fix: "Fill in or remove." },
  { id: "markdown", re: /\*\*[^*\n]{2,60}\*\*|```|\[[^\]\n]{1,60}\]\(https?:/g, fix: "Render it, don't show raw Markdown." },
  { id: "retired", re: /worth your evening|verdict inside|nothing to plan around|threaded through|seasons deep|one-night sampler|scheduling gymnastics|you know what you(?:'|’)re getting|promising, not proven|early signal rather than|circling back|took the heat|fault line|drubbing|love-it-or-hate-it|the audience counterpoint|an honest word/gi, fix: "A retired flourish: write the fact." },
];

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

module.exports = { HUMAN_PROSE, RULES, plainOn, scanProse, siteProse };
