// ============================================================================
// lifecycle.js — keeping streaming claims true over time: the arrival sweep, announced
// digital dates, the departure sweep (with its outage breaker), stream claims, due dates,
// TMDB id recovery, and the archive pass that freezes pages leaving the weekly lists.
// ============================================================================
"use strict";

const fs = require("fs");
const { escHtml, fmtDateFull, localeFor } = require("./core.js");
const { releaseState, todayStr } = require("./release.js");
const {
  ARCHIVE_PATCH_VERSION,
  archivePatchHtml,
  frozenFilmFacts,
  PAGES_MANIFEST_FILE,
  reconcilePagesManifest,
  reEsc,
  retitleFrozen,
  rewriteMetaDescription,
  visibleText,
} = require("./archive.js");
const { digitalReleaseFor } = require("./enrich.js");
const { digitalAnnounceText, OPEN_PILL_RE, settleReleasedCopy } = require("./pagekit.js");
const { countryNameFor, dedupeProviders, streamVocab } = require("./rules.js");
const { healthNote, loadStateFile } = require("./runhealth.js");
const { sleep, tmdb } = require("./tmdb.js");

// ============================================================================
// STREAMING-ARRIVAL SWEEP — what turns the "coming to streaming" block into an
// evergreen asset instead of a page that goes stale.
//
// Frozen archived pages get no new provider data, so a film that left the weekly
// lists during its theatrical run and then landed quietly on a platform (never
// making the "new this week" cut) would sit forever saying "not streaming yet"
// — on precisely the query it spent weeks earning rank for. This sweep re-checks
// those pages against TMDB's watch-providers and, when one has arrived, replaces
// the pending block in place. In place, not a re-render: the page's verdict,
// critics' take, cast and prose came from a full pipeline run and re-deriving
// them here would make the page worse.
//
// Budget: only pages whose block is still "pending", whose release sits inside a
// plausible window (SWEEP_MIN_WEEKS..SWEEP_MAX_WEEKS after release), capped at
// SWEEP_MAX_CHECKS API calls per country per run. Newest-first, so the films
// most likely to be about to land are checked before older stragglers.
// ============================================================================
const SWEEP_MIN_WEEKS = 2;
const SWEEP_MAX_WEEKS = 30;
// 60, not 18 (Sept 2026): with 1,000+ frozen release pages the youngest 18 were rechecked
// every run and everything older never was. Now rotated by last check (see sweepCandidates).
const SWEEP_MAX_CHECKS = 60;

// Pure: which archived slugs are worth an API call this run, newest release first.
function sweepCandidates(entries, now = new Date(), max = SWEEP_MAX_CHECKS) {
  const MS_WEEK = 7 * 86400000;
  return entries
    .filter((x) => x.archivedOn && x.tmdbId && x.released && x.kind !== "tv")
    .map((x) => ({ ...x, ageWeeks: (now.getTime() - new Date(x.released + "T00:00:00Z").getTime()) / MS_WEEK }))
    .filter((x) => Number.isFinite(x.ageWeeks) && x.ageWeeks >= SWEEP_MIN_WEEKS && x.ageWeeks <= SWEEP_MAX_WEEKS)
    // Least recently checked first (never-checked before all), youngest first within that:
    // every eligible page gets its turn instead of the same newest pages every run.
    .sort((a, b) => String(a.swept || "").localeCompare(String(b.swept || "")) || a.ageWeeks - b.ageWeeks)
    .slice(0, max);
}

// Frozen pending page -> "streaming from <date> on <platform>". Replaces the pending block's
// body (keeps the markers, so the arrival sweep still finds and replaces it on the day) and
// the OTT-date FAQ answer, in both escapings. Title and description are rebuilt by the caller
// from the stamped marker (frozenFilmFacts reads it).
function applyDigitalDatePatch(html, { title, date, note = "", countryName, cfg }) {
  const start = "<!--SW:pending-->", end = "<!--/SW:pending-->";
  const a = html.indexOf(start), b = html.indexOf(end);
  if (a === -1 || b === -1 || b < a || !date) return { html, changed: false };
  const V = streamVocab(cfg);
  const e = escHtml;
  const text = digitalAnnounceText(title, date, note, countryName, cfg);
  const block = `${start}<!--SW:digital=${e(date)}|${e(note || "")}--><h2>${e(V.heading(title))}</h2>`
    + `<p><strong>Streaming from ${e(fmtDateFull(date, localeFor((cfg && cfg.code) || "in")))}${note ? ` on ${e(note)}` : ""}.</strong> ${e(text)} This page switches to \u201cstreaming now\u201d the day it lands.</p>${end}`;
  let out = html.slice(0, a) + block + html.slice(b + end.length);
  const A = "(?:'|&#39;)";
  out = out.replace(new RegExp(`\\bAn? (?:OTT|streaming|Streaming) release date for [^<"]*? hasn${A}t been officially announced yet\\.[^<"]*?This page updates automatically the day it starts streaming\\.`, "g"),
    (m) => (m.includes("&#39;") ? e(text) : text) + " This page updates automatically the day it starts streaming.");
  return { html: out, changed: out !== html };
}

function applyArrivalPatch(html, { title, providers, countryName, cfg, asOf, now = Date.now() }) {
  if (!providers || !providers.length) return { html, changed: false };
  const V = streamVocab(cfg);
  const e = escHtml;
  const start = "<!--SW:pending-->", end = "<!--/SW:pending-->";
  const a = html.indexOf(start), b = html.indexOf(end);
  if (a === -1 || b === -1 || b < a) return { html, changed: false };
  const list = providers.join(", ");
  // The <!--SW:live--> stamp is what makes departures detectable. Without it, a page that
  // has been patched to "streaming on X" is indistinguishable from any other frozen page,
  // and the claim can never be rechecked. It carries the date so the sweep can pace itself.
  const block = `${start}<!--SW:live=${e(asOf || "")}--><h2>${e(V.heading(title))}</h2><p><strong>It's streaming now.</strong> ${e(title)} is available in ${e(countryName)} on ${e(list)}.</p><p style="color:var(--mute);font-size:13px">Spotted by our daily availability check${asOf ? ` on ${e(asOf)}` : ""}. We recheck periodically — platforms do drop titles.</p>${end}`;
  let out = html.slice(0, a) + block + html.slice(b + end.length);
  // The archived page still advertises a finished theatrical run in its pills.
  const pills = providers.map((pv) => `<span class="pill">${e(pv)}</span>`).join("");
  for (const stale of [
    `<span class="pill">Theatrical run ended — ${V.arrival} pending</span>`,
    `<span class="pill">Theatrical run ended — OTT arrival pending</span>`,
    `<span class="pill">Theatrical run ended — streaming arrival pending</span>`,
    `<span class="pill">In theatres</span>`,
  ]) {
    if (out.includes(stale)) { out = out.split(stale).join(pills); break; }
  }
  out = out.replace(OPEN_PILL_RE, pills);
  // The FAQ and the "not on any service" lines still describe the page before arrival.
  out = settleReleasedCopy(out, { countryName, cfg, now }).html;
  return { html: out, changed: true };
}

// ============================================================================
// DEPARTURE SWEEP — the missing half of the availability lifecycle.
//
// The arrival sweep polls frozen pages until a film REACHES a platform, patches the page,
// and stops. Nothing ever polled it again, so "Streaming on Netflix" was a permanent claim.
// Licences expire; a page frozen in August still asserting Netflix in March is precisely
// the failure this site's whole gating philosophy exists to avoid, and it is the one a
// reader discovers personally — they open the app, it isn't there, and every other verdict
// on the site is retroactively suspect.
//
// Design, and the reasoning behind each choice:
//
//   CONFIRMATION BEFORE REWRITE. TMDB's provider data is occasionally empty for a title
//   that has not moved — a bad response, a regional blip. Rewriting on a single miss would
//   introduce exactly the wrong claim we are removing. A page is only rewritten after
//   DEPART_CONFIRM_MISSES consecutive empty checks on separate runs. One miss is noise;
//   two, days apart, is a signal.
//
//   RENT/BUY IS NOT A DEPARTURE. A film that leaves a subscription tier but is still
//   purchasable has not vanished — saying "no longer available" there would be its own
//   false claim. That case gets its own honest wording.
//
//   SLOW CADENCE, HARD CAP. Arrivals are urgent (being first is the point); departures are
//   not (a week late is a non-event). Each page is rechecked at most every
//   DEPART_RECHECK_DAYS, oldest first, capped per country per run, so the cost stays flat
//   as the archive grows without bound.
//
//   NEVER GUESS WHY. The page says what we can prove — we could not find it, on this date,
//   on any subscription service in this country. It does not claim the film "was removed",
//   which we cannot know.
// ============================================================================
const DEPART_RECHECK_DAYS = 30;    // how stale a live claim gets before we recheck it
// 60, not 15 (Sept 2026): catalogue pages now carry live claims too, ~25 new per country per
// run. At 15 the recheck queue could never catch up and claims would age past the window.
// One watch/providers call each — 60 x 14 countries x 2 runs is ~1,700 light calls a day.
const DEPART_MAX_CHECKS = 60;      // per country per run
const DEPART_CONFIRM_MISSES = 2;   // consecutive empty checks before we touch the page

// Pure: does a recheck batch look like an upstream outage rather than real departures?
// Normal churn is a small share of any batch; most of a sizeable batch vanishing at once is
// the provider feed failing, not the catalogue emptying.
const DEPART_OUTAGE_MIN_CHECKS = 15;
const DEPART_OUTAGE_SHARE = 0.6;
function departureOutage(checked, empty) {
  return checked >= DEPART_OUTAGE_MIN_CHECKS && empty / checked >= DEPART_OUTAGE_SHARE;
}

// Pure: pick which live-claim pages are due a recheck. Oldest claim first, so the most
// likely to be wrong is always checked before the budget runs out.
function departureCandidates(entries, now = new Date(), max = DEPART_MAX_CHECKS) {
  const MS_DAY = 86400000;
  return entries
    .filter((x) => x.tmdbId && x.live && x.live.since)
    .map((x) => {
      const last = x.live.lastCheck || x.live.since;
      const daysSince = (now.getTime() - new Date(last + "T00:00:00Z").getTime()) / MS_DAY;
      return { ...x, daysSince };
    })
    .filter((x) => Number.isFinite(x.daysSince) && x.daysSince >= DEPART_RECHECK_DAYS)
    .sort((a, b) => b.daysSince - a.daysSince)
    .slice(0, max);
}

// Pure: rewrite a live claim into an honest "we could not find it" block. Mirrors
// applyArrivalPatch — same markers, same shape, opposite direction.
function applyDeparturePatch(html, { title, was, rentBuy, countryName, cfg, asOf }) {
  const V = streamVocab(cfg);
  const e = escHtml;
  const start = "<!--SW:pending-->", end = "<!--/SW:pending-->";
  // A page born streaming has an SW:stream block instead (see buildFilmPage). On departure it
  // becomes an ordinary pending block, so the arrival sweep can bring it back if it returns.
  const sa = html.indexOf("<!--SW:stream-->"), sb = html.indexOf("<!--/SW:stream-->");
  if (html.indexOf(start) === -1 && sa !== -1 && sb > sa) {
    html = html.slice(0, sa) + `${start}${html.slice(sa + "<!--SW:stream-->".length, sb)}${end}` + html.slice(sb + "<!--/SW:stream-->".length);
  }
  const a = html.indexOf(start), b = html.indexOf(end);
  if (a === -1 || b === -1 || b < a) return { html, changed: false };
  const wasList = (was || []).join(", ");
  const rb = (rentBuy || []).filter(Boolean);

  // Two genuinely different situations, and conflating them would be a false claim either
  // way: still purchasable is not the same as gone.
  const body = rb.length
    ? `<p><strong>Not on subscription any more.</strong> ${e(title)} is no longer included with a subscription in ${e(countryName)}${wasList ? ` — it was on ${e(wasList)}` : ""}. You can still rent or buy it on ${e(rb.slice(0, 3).join(", "))}.</p>`
    : `<p><strong>We can't find it streaming right now.</strong> ${e(title)} isn't on any subscription service we track in ${e(countryName)}${wasList ? ` — it was on ${e(wasList)}` : ""}. Rights move around, so it may return.</p>`;

  // NOT V.heading() — that asks "when is it coming to OTT", which is the arrival question
  // and reads as nonsense above a departure notice.
  const heading = `Where to watch ${title}`;
  const block = `${start}<!--SW:gone=${e(asOf || "")}--><h2>${e(heading)}</h2>${body}`
    + `<p style="color:var(--mute);font-size:13px">Checked ${e(asOf || "recently")}. We keep looking — if it comes back, this page updates.</p>${end}`;
  let out = html.slice(0, a) + block + html.slice(b + end.length);

  // Strip the stale provider pills. `was` comes from the manifest claim, but a page patched
  // before live-claims existed has no manifest record — so fall back to the provider names
  // written into the page's own streaming sentence rather than leaving pills that contradict
  // the notice directly above them.
  const names = new Set(was || []);
  if (!names.size) {
    const m2 = html.match(/is available in [^<]*? on ([^<.]+)\./);
    if (m2) m2[1].split(/,| & /).map((x) => x.trim()).filter(Boolean).forEach((x) => names.add(x));
  }
  for (const pv of names) {
    const stale = `<span class="pill">${e(pv)}</span>`;
    if (out.includes(stale)) out = out.split(stale).join("");
  }
  const pill = rb.length
    ? `<span class="pill">Rent or buy only</span>`
    : `<span class="pill">Not currently streaming</span>`;
  out = out.replace(`<h2>${e(heading)}</h2>`, `${pill}<h2>${e(heading)}</h2>`);
  // The notice is right; the rest of the page still said it was streaming.
  out = settleDepartedCopy(out, { title, was, countryName });
  return { html: out, changed: true };
}

// Every "it's streaming" sentence the builder, the arrival patch and the settle pass write,
// turned into "it isn't streaming right now". Both escapings, same as settleReleasedCopy.
function settleDepartedCopy(html, { title, was = [], countryName }) {
  const A = "(?:'|&#39;)";
  const ap = (m) => (m.includes("&#39;") ? "&#39;" : "'");
  const esc = (m, t) => (m.includes("&#39;") || m.includes("&amp;") ? escHtml(t) : t);
  const wasList = (was || []).slice(0, 3).join(", ");
  const T = reEsc(escHtml(title)) + "|" + reEsc(title);
  const C = reEsc(escHtml(countryName)) + "|" + reEsc(countryName);
  let out = html;
  out = out.replace(new RegExp(` In (?:${C}) you can stream it on [^.<"]+\\.`, "g"),
    (m) => ` It isn${ap(m)}t on a subscription service in ${esc(m, countryName)} right now${wasList ? ` — it was on ${esc(m, wasList)}` : ""}.`);
  out = out.replace(new RegExp(`You can stream (${T}) in (?:${C}) on [^.<"]+\\.`, "g"),
    (m, t) => `${t} isn${ap(m)}t on a subscription service in ${esc(m, countryName)} right now${wasList ? ` — it was on ${esc(m, wasList)}` : ""}. This page updates if it returns.`);
  out = out.replace(new RegExp(`, and it${A}s streaming there now — see where to watch above\\.`, "g"),
    (m) => `. It isn${ap(m)}t streaming there right now — this page updates if it returns.`);
  out = out.replace(new RegExp(`It${A}s streaming in (${C}) now — see where to watch above\\.`, "g"),
    (m, c) => `It isn${ap(m)}t streaming in ${c} right now — this page updates if it returns.`);
  out = out.replace(new RegExp(`and is streaming there now(?: — see where to watch above)?\\.`, "g"),
    (m) => `, and isn${ap(m)}t streaming there right now.`);
  // The streaming-date FAQ: "<film> is already streaming in <country> on X — it arrived on …".
  out = out.replace(new RegExp(`(${T}) is already streaming in (?:${C}) on [^.<"]+?(?: — it arrived on [^.<"]+)?\\.`, "g"),
    (m, t) => `${t} was on ${esc(m, wasList || "a subscription service")} in ${esc(m, countryName)}, but isn${ap(m)}t streaming there right now. This page updates if it returns.`);
  return out.replace(/ ,/g, ",");
}

// ============================================================================
// STREAM CLAIMS FOR PAGES BORN STREAMING.
//
// Sept 2026: 5,530 catalogue pages asserted "you can stream it on <platform>" with no
// SW marker and no manifest claim, so the departure sweep could never recheck one of them.
// Rights expire; some of those claims are already wrong and none would ever be corrected.
// This gives every such page what an arrived page already has: a marked block the sweep can
// rewrite, and a dated claim (since = the day the page was built, when TMDB last confirmed
// it) that enters the recheck queue oldest-first. Idempotent: a page with a claim is skipped.
// ============================================================================
function backfillStreamClaims(manifest, cfg) {
  const code = cfg.code;
  const dir = code === "in" ? "movie" : `${code}/movie`;
  const m = manifest[code] || {};
  let n = 0;
  for (const [slug, e] of Object.entries(m)) {
    if (!e || e.live || !e.archivedOn || !e.tmdbId) continue;
    const p = `${dir}/${slug}.html`;
    let html;
    try { html = fs.readFileSync(p, "utf8"); } catch { continue; }
    if (html.includes("<!--SW:")) continue;               // already on a lifecycle track
    const facts = frozenFilmFacts(html);
    const providers = facts ? facts.item.providers : [];
    if (!providers.length) continue;                     // no claim to check
    const a = html.indexOf("<h2>Where to watch in ");
    if (a === -1) continue;
    let b = html.indexOf("<h2>", a + 5);
    if (b === -1) b = html.indexOf("<footer", a);
    if (b === -1) continue;
    const since = e.archivedOn;
    const out = html.slice(0, a) + `<!--SW:stream--><!--SW:live=${escHtml(since)}-->` + html.slice(a, b).replace(/\s+$/, "")
      + `<!--/SW:stream-->\n  ` + html.slice(b);
    fs.writeFileSync(p, out);
    e.live = { since, providers, lastCheck: since, misses: 0 };
    n++;
  }
  if (n) console.log(`  stream claims [${code}]: ${n} born-streaming page(s) joined the recheck queue`);
  return n;
}

// Live pass: recheck live claims for one country. Network-bound and strictly budgeted;
// failures are logged and skipped, because a claim that stays one more month is survivable
// and a wrong rewrite is not.
// Pages patched to "streaming now" BEFORE live claims existed carry no <!--SW:live--> stamp
// and no manifest claim, so the departure sweep would skip them forever — and those are
// exactly the oldest, most likely to be wrong. Stamp them once, dating the claim from
// whenever the page was last touched so they enter the normal recheck rotation.
function backfillLiveClaims(manifest, cfg) {
  const m = manifest[cfg.code] || {};
  const dir = cfg.code === "in" ? "movie" : `${cfg.code}/movie`;
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const [slug, v] of Object.entries(m)) {
    if (!v || v.live || !v.tmdbId) continue;
    const p = `${dir}/${slug}.html`;
    let html;
    try { html = fs.readFileSync(p, "utf8"); } catch { continue; }
    if (html.includes("<!--SW:live=") || !html.includes("It&#39;s streaming now.")) continue;
    const since = v.last || v.archivedOn;
    if (!since) continue;
    const m2 = html.match(/is available in [^<]*? on ([^<.]+)\./);
    const provs = m2 ? m2[1].split(/,| & /).map((x) => x.trim()).filter(Boolean) : [];
    m[slug].live = { since, providers: provs, lastCheck: since, misses: 0 };
    try { fs.writeFileSync(p, html.replace("<!--SW:pending-->", `<!--SW:pending--><!--SW:live=${escHtml(since)}-->`)); }
    catch { continue; }
    n++;
  }
  if (n) console.log(`  live-claim backfill [${cfg.code}]: ${n} page(s) brought into the recheck rotation`);
  return n;
}

async function sweepStreamingDepartures(manifest, cfg, asOf) {
  const m = manifest[cfg.code] || {};
  const dir = cfg.code === "in" ? "movie" : `${cfg.code}/movie`;
  if (!fs.existsSync(dir)) return;
  backfillLiveClaims(manifest, cfg);
  const entries = Object.entries(m).map(([slug, v]) => ({ slug, ...v }));
  const candidates = departureCandidates(entries).filter((x) => {
    try { return fs.readFileSync(`${dir}/${x.slug}.html`, "utf8").includes("<!--SW:live="); }
    catch { return false; }
  });
  if (!candidates.length) return;
  // Phase 1: ask TMDB about every candidate before touching anything. TMDB's provider data
  // comes from JustWatch, and when that feed breaks every title comes back empty at once —
  // which, checked one at a time, looks exactly like hundreds of films leaving streaming.
  const checks = [];
  for (const c of candidates) {
    try {
      const kind = c.kind === "tv" ? "tv" : "movie";
      const d = await tmdb(`/${kind}/${c.tmdbId}/watch/providers`);
      const region = d?.results?.[cfg.watchRegion] || {};
      checks.push({ c,
        provs: dedupeProviders((region.flatrate || []).map((x) => x.provider_name)).slice(0, 4),
        rentBuy: dedupeProviders([...(region.rent || []), ...(region.buy || [])].map((x) => x.provider_name)).slice(0, 3) });
    } catch (e) { console.warn(`  departure ${c.slug}: ${e.message}`); }
  }
  const empties = checks.filter((x) => !x.provs.length).length;
  const outage = departureOutage(checks.length, empties);
  if (outage) {
    console.warn(`  departure sweep [${cfg.code}]: ${empties}/${checks.length} came back empty — treating as a provider-data outage; no page touched, no miss counted`);
    healthNote(`departure sweep [${cfg.code}]: ${empties}/${checks.length} rechecks empty — looked like a TMDB/JustWatch outage, so nothing was retired`);
  }
  // Phase 2: apply.
  let confirmed = 0, stillThere = 0, pending = 0;
  for (const { c, provs, rentBuy } of checks) {
    try {
      const live = m[c.slug].live || {};

      if (provs.length) {
        // Still streaming. Record the check and refresh the provider list if it moved.
        m[c.slug].live = { ...live, providers: provs, lastCheck: asOf, misses: 0 };
        stillThere++;
        continue;
      }
      if (outage) { pending++; continue; }   // not evidence of anything; recheck next run
      // Empty result. One miss is noise — count it and wait for the next pass.
      const misses = (live.misses || 0) + 1;
      m[c.slug].live = { ...live, lastCheck: asOf, misses, rentBuy };
      if (misses < DEPART_CONFIRM_MISSES) { pending++; continue; }

      const p = `${dir}/${c.slug}.html`;
      const { html, changed } = applyDeparturePatch(fs.readFileSync(p, "utf8"), {
        title: c.title || c.slug, was: live.providers || [], rentBuy,
        countryName: countryNameFor(cfg), cfg, asOf,
      });
      if (changed) {
        // Description and title were written for a streaming page; rebuild both from what the
        // page now says (no providers), so the search listing stops claiming a platform too.
        let out = rewriteMetaDescription(html, cfg).html;
        out = retitleFrozen(out, cfg).html;
        fs.writeFileSync(p, out);
        m[c.slug].last = asOf;
        delete m[c.slug].live;      // claim retired; the page no longer asserts a platform
        confirmed++;
      }
    } catch (e) { console.warn(`  departure ${c.slug}: ${e.message}`); }
  }
  console.log(`  departure sweep [${cfg.code}]: ${candidates.length} rechecked, ${stillThere} still streaming, ${pending} awaiting confirmation, ${confirmed} retired`);
}

function patchDueIfPassed(html, { title, countryName, cfg, now = Date.now() }) {
  const m = html.match(/<!--SW:due=(\d{4}-\d{2}-\d{2})-->/);
  if (!m) return { html, changed: false };
  if (releaseState(m[1], now) !== "released") return { html, changed: false }; // still ahead, or today
  const V = streamVocab(cfg);
  const e = escHtml;
  const start = "<!--SW:pending-->", end = "<!--/SW:pending-->";
  const a = html.indexOf(start), b = html.indexOf(end);
  if (a === -1 || b === -1 || b < a) return { html, changed: false };
  const opened = fmtDateFull(m[1], localeFor(cfg && cfg.code));
  const block = `${start}<h2>${e(V.heading(title))}</h2>`
    + `<p>${e(title)} opened in theatres in ${e(countryName)} on ${e(opened)}. ${e(V.article)} ${e(V.releaseDate)} hasn't been announced yet.</p>`
    + `<p style="color:var(--mute);font-size:13px">We re-check every day and this page updates the moment it lands.</p>${end}`;
  let out = html.slice(0, a) + block + html.slice(b + end.length);
  // The pre-release pill is now wrong too.
  out = out.replace(/<span class="pill">In cinemas (?:from [^<]*|today)<\/span>/,
                    `<span class="pill">In theatres</span>`);
  // ...and so is every other pre-release sentence on the page (see settleReleasedCopy).
  out = settleReleasedCopy(out, { countryName, cfg, now }).html;
  // ...and the title, which promised a release date until today (see filmTitleTag).
  out = retitleFrozen(out, cfg).html;
  return { html: out, changed: true };
}

// Live pass: walk one country's film pages and apply the due-date patch. Local only.
function refreshDuePages(cfg, countryName, manifest = null) {
  const dir = cfg.code === "in" ? "movie" : `${cfg.code}/movie`;
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".html"))) {
    const path = `${dir}/${f}`;
    let html;
    try { html = fs.readFileSync(path, "utf8"); } catch { continue; }
    let out = html, changed = false;
    if (html.includes("<!--SW:due=")) {
      ({ html: out, changed } = patchDueIfPassed(html, { title: titleFromPage(html) || f.replace(/\.html$/, ""), countryName, cfg }));
    } else if (OPEN_PILL_RE.test(html)) {
      // Open run: re-settle so it flips to "most likely ended" on the day it crosses the
      // window, and rebuild the description, which states the same thing.
      const st = settleReleasedCopy(html, { countryName, cfg });
      if (st.changed) {
        out = rewriteMetaDescription(st.html, cfg).html;
        changed = true;
      }
    } else continue;
    if (changed) {
      fs.writeFileSync(path, out); n++;
      const e = manifest && manifest[cfg.code] && manifest[cfg.code][f.replace(/\.html$/, "")];
      if (e) e.last = todayStr();   // the page now says something different — recrawl it
    }
  }
  if (n) console.log(`[${cfg.code}] due-date pass: ${n} page(s) moved past their release date`);
  return n;
}

// Best-effort title recovery from a built page (used only for the due-date rewrite).
function titleFromPage(html) {
  const m = html.match(/<h1[^>]*>([^<]{1,120})<\/h1>/);
  return m ? m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim() : null;
}

// Live pass: run the sweep for one country. Network-bound, so failures are logged
// and skipped — a page that stays pending one more day is a non-event.
// ============================================================================
// TMDB ID RECOVERY — the pages the arrival sweep could never see.
//
// Sept 2026: 1,025 of 1,678 frozen release pages had no tmdbId (and many no release date)
// in their manifest entry, written before those fields existed. The arrival sweep skips any
// entry without both, so these pages could never flip to "streaming now". The week this was
// found, Hi! (the site's biggest page: 7,220 impressions a month, mostly "hi ott release
// date") had been on ZEE5 for two days while its page said "not streaming yet" — and so did
// Toxic, Awarapan 2 and Baby Do Die Do.
//
// Release date, language, kind and title come free from the page's own JSON-LD. The TMDB id
// takes one search: title + year, and a result is accepted ONLY if its poster or backdrop is
// an image already on the page. A title match alone is never enough (there are many films
// called "Hi"). Two failed attempts and the page is left alone rather than retried forever.
// ============================================================================
const ID_RECOVERY_BUDGET = 40;   // searches per country per run; the backlog clears in ~2 runs

async function recoverTmdbIds(cfg, manifest, { budget = ID_RECOVERY_BUDGET, api = { tmdb, pause: sleep } } = {}) {
  const code = cfg.code;
  const dir = code === "in" ? "movie" : `${code}/movie`;
  const m = manifest[code] || {};
  let recovered = 0, filled = 0, tried = 0;
  // Newest releases first: those are the pages still inside the arrival window, where a
  // recovered id pays off the same run (Hi!, 28 Aug, before a 2019 film nobody is waiting on).
  const order = Object.entries(m).sort((a, b) =>
    String((b[1] && (b[1].released || b[1].archivedOn)) || "").localeCompare(String((a[1] && (a[1].released || a[1].archivedOn)) || "")));
  for (const [slug, e] of order) {
    if (!e || !e.archivedOn || e.catalog || (e.tmdbId && e.released)) continue;
    let html;
    try { html = fs.readFileSync(`${dir}/${slug}.html`, "utf8"); } catch { continue; }
    const facts = frozenFilmFacts(html);
    if (facts) {
      const it = facts.item;
      if (!e.released && it.released) { e.released = it.released; filled++; }
      if (!e.lang && it.language) e.lang = it.language;
      if (!e.kind && it.kind) e.kind = it.kind;
      if (!e.title && it.title) e.title = it.title;
    }
    if (e.tmdbId || (e.noMatch || 0) >= 2 || tried >= budget) continue;
    const title = (facts && facts.item.title) || "";
    if (!title) continue;
    const kind = e.kind === "tv" ? "tv" : "movie";
    const images = new Set([...html.matchAll(/image\.tmdb\.org\/t\/p\/w\d+(\/[A-Za-z0-9_-]+\.(?:jpg|png))/g)].map((x) => x[1]));
    if (!images.size) continue;
    const year = String(e.released || "").slice(0, 4);
    tried++;
    let hit = null;
    try {
      for (const q of year ? [{ [kind === "tv" ? "first_air_date_year" : "year"]: year }, {}] : [{}]) {
        const r = await api.tmdb(`/search/${kind}`, { query: title, include_adult: "false", ...q });
        await api.pause(120);
        hit = (r.results || []).find((x) => images.has(x.poster_path) || images.has(x.backdrop_path)) || null;
        if (hit) break;
      }
    } catch (err) { console.warn(`  id recovery ${code}/${slug}: ${err.message}`); continue; }
    if (hit) { e.tmdbId = hit.id; e.kind = kind; recovered++; }
    else e.noMatch = (e.noMatch || 0) + 1;
  }
  if (recovered || filled) console.log(`  id recovery [${code}]: ${recovered} TMDB id(s) recovered from ${tried} search(es), ${filled} release date(s) filled from the page`);
  return recovered;
}

async function sweepStreamingArrivals(manifest, cfg, asOf) {
  const m = manifest[cfg.code] || {};
  const dir = cfg.code === "in" ? "movie" : `${cfg.code}/movie`;
  if (!fs.existsSync(dir)) return;
  const entries = Object.entries(m).map(([slug, v]) => ({ slug, ...v }));
  const candidates = sweepCandidates(entries).filter((x) => {
    try { return fs.readFileSync(`${dir}/${x.slug}.html`, "utf8").includes("<!--SW:pending-->"); }
    catch { return false; }
  });
  if (!candidates.length) return;
  let found = 0, announced = 0;
  for (const c of candidates) {
    try {
      // One call returns both answers: is it streaming, and if not, has a date been announced.
      const d = await tmdb(`/movie/${c.tmdbId}`, { append_to_response: "watch/providers,release_dates" });
      m[c.slug].swept = asOf;
      const provs = dedupeProviders((d?.["watch/providers"]?.results?.[cfg.watchRegion]?.flatrate || []).map((x) => x.provider_name)).slice(0, 4);
      if (!provs.length) {
        const dig = digitalReleaseFor(d, cfg.watchRegion);
        const prev = m[c.slug].digital || {};
        if (dig && dig.date >= asOf && (dig.date !== prev.date || dig.note !== prev.note)) {
          const p = `${dir}/${c.slug}.html`;
          const r = applyDigitalDatePatch(fs.readFileSync(p, "utf8"), {
            title: c.title || c.slug, date: dig.date, note: dig.note, countryName: countryNameFor(cfg), cfg,
          });
          if (r.changed) {
            let out = rewriteMetaDescription(r.html, cfg).html;
            out = retitleFrozen(out, cfg).html;
            fs.writeFileSync(p, out);
            m[c.slug].digital = { date: dig.date, note: dig.note || "" };
            m[c.slug].last = asOf;
            announced++;
          }
        }
        continue;
      }
      const p = `${dir}/${c.slug}.html`;
      const { html, changed } = applyArrivalPatch(fs.readFileSync(p, "utf8"), {
        title: c.title || c.slug, providers: provs, countryName: countryNameFor(cfg), cfg, asOf,
      });
      if (changed) {
        fs.writeFileSync(p, html);
        m[c.slug].last = asOf;
        // Open a live claim. This is what the departure sweep later rechecks — without it
        // the assertion we just wrote onto the page could never be revisited.
        m[c.slug].live = { since: asOf, providers: provs, lastCheck: asOf, misses: 0 };
        found++;
      }
    } catch (e) { console.warn(`  sweep ${c.slug}: ${e.message}`); }
  }
  console.log(`  streaming sweep [${cfg.code}]: ${candidates.length} checked, ${found} newly streaming, ${announced} streaming date(s) announced`);
}

function loadPagesManifest() {
  return loadStateFile(PAGES_MANIFEST_FILE, {});
}

// Run the archive pass for one country: patch newly-departed pages in place.
function archiveDepartedPages(manifest, cfg, currentSlugs, meta = null) {
  const dir = cfg.code === "in" ? "movie" : `${cfg.code}/movie`;
  if (!fs.existsSync(dir)) return;
  const diskSlugs = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5));
  const todayStr = new Date().toISOString().slice(0, 10);
  const toArchive = reconcilePagesManifest(manifest, cfg.code, currentSlugs, diskSlugs, todayStr, meta);
  const countryName = countryNameFor(cfg);
  // Newly-departed pages, plus a one-time re-sweep of pages archived under an older
  // patch version (their frozen text predates newer patterns). pv stamps make it once.
  const m = manifest[cfg.code] || {};
  const sweep = new Set(toArchive);
  for (const slug of diskSlugs) {
    if (currentSlugs.has(slug)) continue;
    if (m[slug] && m[slug].archivedOn && m[slug].pv !== ARCHIVE_PATCH_VERSION) sweep.add(slug);
  }
  let patched = 0;
  for (const slug of sweep) {
    const p = `${dir}/${slug}.html`;
    try {
      const before = fs.readFileSync(p, "utf8");
      const { html, changed } = archivePatchHtml(before, countryName, cfg);
      if (changed) { fs.writeFileSync(p, html); patched++; }
      if (m[slug]) {
        m[slug].pv = ARCHIVE_PATCH_VERSION;
        // Corrected text is new content: let the sitemap say so, so the fix gets recrawled.
        // todayStr is the local date string above (it shadows the todayStr() helper): calling
        // it threw, so every honesty-patched page lost its lastmod bump (fixed Sept 2026).
        if (changed && visibleText(before) !== visibleText(html)) m[slug].last = todayStr;
      }
    } catch (e) { console.warn(`  archive: ${p} skipped (${e.message})`); }
  }
  if (sweep.size) console.log(`  archive [${cfg.code}]: ${sweep.size} pages archived or re-swept, ${patched} honesty-patched`);
}

module.exports = {
  applyArrivalPatch,
  applyDeparturePatch,
  applyDigitalDatePatch,
  archiveDepartedPages,
  backfillLiveClaims,
  backfillStreamClaims,
  departureCandidates,
  departureOutage,
  loadPagesManifest,
  patchDueIfPassed,
  recoverTmdbIds,
  refreshDuePages,
  settleDepartedCopy,
  sweepCandidates,
  sweepStreamingArrivals,
  sweepStreamingDepartures,
};
