/* FilmyChill homepage script (every edition's homepage).
 *
 * It lived inline in index.html until Oct 2026. Moved here so the homepage's
 * Content-Security-Policy can refuse inline scripts, as every other page already does: a script
 * slipped into any text on the page can then never run. For the same reason no element carries
 * an inline handler (onclick="..."): each names its action in data-click / data-change /
 * data-enter, and the listeners at the end of this file run the innermost one.
 *
 * Per-page settings come from <meta name="fc-page"> and <meta name="fc-stream-word"> (FC_PAGE,
 * FC_STREAM below), never from the script itself, so this file is the same on every page.
 */
"use strict";

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Paste your WhatsApp Channel invite link here (https://whatsapp.com/channel/...).
// The Follow button stays hidden until this is filled in.
const WHATSAPP_CHANNEL_URL = 'https://whatsapp.com/channel/0029Vb81Fe8C6ZvdMR2oxH3j';

let DATA = { theatres: [], ott: [], comingSoon: [] };
let dataReady = false; // set once this country's data file has loaded
let activeLang = 'All';
let sortMode = 'default';
let myListOnly = false;

// ---- Watchlist (stored on this device) ----
function loadWL() { try { const v = localStorage.getItem('filmychill-wl') || localStorage.getItem('reeladda-wl') || '[]'; return JSON.parse(v); } catch { return []; } }
function saveWL(wl) { try { localStorage.setItem('filmychill-wl', JSON.stringify(wl)); } catch {} updateWLCount(); }
function wlKey(item) { return item.tmdbId || item.title; }
function isSaved(item) { return loadWL().some(x => wlKey(x) === wlKey(item)); }
function toggleSave(listKey, i) {
  const item = listKey === 'wl' ? loadWL()[i] : DATA[listKey][i];
  if (!item) return;
  let wl = loadWL();
  const wasEmpty = wl.length === 0;
  if (wl.some(x => wlKey(x) === wlKey(item))) wl = wl.filter(x => wlKey(x) !== wlKey(item));
  else wl.push(item);
  saveWL(wl);
  render();
  if (wasEmpty && wl.length === 1) showInstallNudge('personalBar', 'Saved — we\'ll show its ' + FC_STREAM.word + ' status in My List the day it lands', ' · add FilmyChill to your home screen so the alert finds you');
}
function updateWLCount() { document.getElementById('wlCount').textContent = loadWL().length; }
function toggleMyList() {
  myListOnly = !myListOnly;
  document.getElementById('mylistBtn').classList.toggle('active', myListOnly);
  render();
  if (myListOnly) document.getElementById('mylistSection').scrollIntoView({ behavior: 'smooth' });
}

// Dates in the PAGE'S OWN locale (US reads "Jun 19", India reads "19 Jun"). FC_PAGE is
// declared later in this script but resolved before any render call, so lookup is safe.
// The market's date/number locale, injected by the build beside fc-page (single source:
// COUNTRY_LOCALE in scripts/lib/core.js). It used to be a hardcoded map here, so a new
// country silently formatted its dates as India's until someone noticed.
function pageLocale() {
  const m = document.querySelector('meta[name="fc-locale"]');
  const loc = m && m.getAttribute('content');
  return loc || 'en-IN';
}
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const opts = { day: 'numeric', month: 'short' };
  if (dt.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric'; // disambiguate cross-year dates
  return dt.toLocaleDateString(pageLocale(), opts);
}

// Visible freshness line for card meta: "Released 12 Jun" for movies, "Latest season 21 Jun"
// for TV (whose `released` field is the series' ORIGINAL launch — 2022 for a returning hit —
// and would mislead). Mirrors freshLabel() in scripts/update.js; keep the two in sync.
function freshLabel(item) {
  // TV needs freshDate (latest season, not the series launch). Movies prefer `released`
  // (region-localized) over freshDate (TMDB's global primary date) — matches the modal.
  const d = item.kind === 'tv' ? (item.freshDate || item.released) : (item.released || item.freshDate);
  if (!d) return '';
  if (item.kind === 'tv' && (Date.now() - new Date(d)) > 400 * 864e5) return ''; // years-old season date reads as a bug next to a "New on ..." badge
  // Tense from the date, as on the server (scripts/lib/freshness.js): never "Released" ahead of time.
  const day = String(d).slice(0, 10), today = new Date().toISOString().slice(0, 10);
  if (day === today) return item.kind === 'tv' ? 'New season today' : 'Releases today';
  if (day > today) return (item.kind === 'tv' ? 'New season ' : 'Releases ') + fmtDate(d);
  return (item.kind === 'tv' ? 'Latest season ' : 'Released ') + fmtDate(d);
}

// Badge text from the data (server computes it off freshDate, so returning TV seasons badge
// correctly). Falls back to the legacy isRecent flag for older data files.
function cardBadge(item) {
  return item.badge || (item.isRecent ? 'New release' : '');
}

// Trailer view count as social proof ("▶ 52M trailer views"); only from 1M up — below
// that a view count reads as anti-proof. Mirrors fmtViews/trailerViewsLabel in update.js.
function fmtViews(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n >= 1e9) return (n / 1e9 >= 10 ? Math.round(n / 1e9) : +(n / 1e9).toFixed(1)) + 'B';
  if (n >= 1e6) return (n / 1e6 >= 10 ? Math.round(n / 1e6) : +(n / 1e6).toFixed(1)) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}
// "145 min" reads like metadata; "2h 25m" answers "do I have time tonight?".
// Mirrors fmtRuntime in update.js so SSR and hydrated cards format identically.
function fmtRuntime(mins) {
  const n = Number(mins);
  if (!Number.isFinite(n) || n <= 0) return '';
  const h = Math.floor(n / 60), m = Math.round(n % 60);
  if (!h) return m + 'm';
  return m ? h + 'h ' + m + 'm' : h + 'h';
}
function trailerViewsLabel(n) {
  return Number.isFinite(n) && n >= 1e6 ? '▶ ' + fmtViews(n) + ' trailer views' : null;
}
// This week's Wikipedia page views, once notable (10,000 a day). Mirrors wikiViewsLabel in
// scripts/lib/editorial.js. Page views, not people: one reader can view an article twice.
function wikiViewsLabel(n) {
  return Number.isFinite(n) && n >= 70000 ? fmtViews(n) + ' Wikipedia views this week' : null;
}

// Status of a SAVED film against this run's live data: the "when is it coming on
// OTT?" job, answered on every visit. Saved snapshots go stale; live DATA doesn't —
// so we look the film up fresh by slug and fall back to the snapshot only if it has
// left the lists entirely.
function trackStatus(saved) {
  const slug = saved.slug || slugify(saved.title);
  const bySlug = (list) => (list || []).find(x => (x.slug || slugify(x.title)) === slug);
  const live = bySlug(DATA.ott) || bySlug(DATA.theatres) || bySlug(DATA.comingSoon) || saved;
  const today = new Date().toISOString().slice(0, 10);
  if (live.platform && live.platform !== 'Theatres') {
    const since = live.kind === 'tv' ? live.freshDate : (live.ottFreshDate || live.freshDate);
    return { cls: 'ts-live', label: '✅ Streaming on ' + esc(live.platform) + (since ? ' · since ' + esc(fmtDate(since)) : '') };
  }
  if (live.released && live.released > today) {
    return { cls: 'ts-soon', label: '<svg class="ic" aria-hidden="true"><use href="#icCal"/></svg> Releases ' + esc(fmtDate(live.released)) + ' — tracking for you' };
  }
  return { cls: 'ts-wait', label: '⏳ Awaiting ' + FC_STREAM.Word + ' — you\u2019ll see it here the day it lands' };
}

// FilmyChill Score (scripts/lib/fcscore.js): FilmyChill's own verdict from audiences +
// critics, computed every build. No score = "too early", never a guess. Mirrors the SSR
// panel in scripts/lib/weekly.js — keep the two in step.
// Mirrors noScoreText() in scripts/lib/fcscore.js: "Too early" only for something just out;
// otherwise say what's missing, with the real vote count.
function noScoreText(item) {
  const d = String(item.freshDate || item.released || '').slice(0, 10);
  const rel = String(item.released || item.freshDate || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(rel) && rel > new Date().toISOString().slice(0, 10)) return { label: 'Not out yet', why: "It hasn't opened yet — the score comes once people have seen it." };
  const recent = /^\d{4}-\d{2}-\d{2}$/.test(d) && Date.parse(d) > Date.now() - 28 * 864e5;
  const votes = Number(item.votes || 0), who = votes === 1 ? '1 person has' : votes.toLocaleString('en-IN') + ' people have';
  const need = /^\d{4}-\d{2}-\d{2}$/.test(d) && Date.parse(d) <= Date.now() - 60 * 864e5 ? 15 : 50; // older films: early read from 15
  if (item.criticsTone === 'mixed') return { label: 'Critics split', why: recent ? 'Critics are split; audience ratings are still coming in.' : 'Critics are split, and ' + (votes ? 'only ' + who : 'nobody has') + ' rated it — the score needs ' + need + ' ratings to decide.' };
  if (recent) return { label: 'Too early', why: 'Just released — not enough ratings or reviews yet.' };
  if (votes >= need) return { label: 'Not enough ratings', why: "There's no usable audience rating for it on TMDB yet, and no settled critics' reception." };
  if (votes > 0) return { label: 'Not enough ratings', why: 'Only ' + who + ' rated it — the score needs at least ' + need + '.' };
  return { label: 'Not enough ratings', why: "Nobody has rated it yet, and there's no settled critics' reception." };
}
function fcSignals(item) {
  const s = item.fcScore, bits = [];
  // With a score, the line under the card (scoreLineHtml) says the audience and critics parts;
  // this only adds the buzz figures for a title that has no score yet.
  if (s) return '';
  if (item.rating != null && item.votes) bits.push('Audience ★ ' + Number(item.rating).toFixed(1) + ' (' + Number(item.votes).toLocaleString() + ' ratings)');
  [wikiViewsLabel(item.wikiWeeklyViews), trailerViewsLabel(item.trailerViews)].forEach(b => { if (b) bits.push(b); });
  return bits.length ? `<div class="fcs-sig">${esc(bits.join(' · '))}</div>` : '';
}
// The score's two halves as one line under the card, with the critics' figures the build read
// from Wikipedia (twin of receptionLine / toneFromFigure in scripts/lib/reception.js: at most two
// figures with their scales, a figure that argues with the label withheld, the label following
// the figure when the page's own reading has no settled tone).
function contradicts(value, tone) {
  if (value == null || !tone) return false;
  if (/^(positive|acclaim)$/i.test(tone) && value < 50) return true;
  if (/^negative$/i.test(tone) && value >= 70) return true;
  return false;
}
function receptionLine(rec, fmt, tone) {
  if (!rec) return '';
  const parts = [];
  const paren = (bits) => (bits.filter(Boolean).length ? ` (${bits.filter(Boolean).join(', ')})` : '');
  const rt = rec.rt && !contradicts(rec.rt.pct, tone) ? rec.rt : null;
  const mc = rec.mc && !contradicts(rec.mc.score, tone) ? rec.mc : null;
  if (rt) parts.push(`${rt.pct}% on Rotten Tomatoes${paren([rt.n ? `${rt.n} reviews` : '', rt.season ? `season ${rt.season}` : ''])}`);
  else if (mc) parts.push(`Metacritic ${mc.score}/100${paren([mc.n ? `${mc.n} critics` : '', mc.season ? `season ${mc.season}` : ''])}`);
  if (rec.ratings && rec.ratings.n) parts.push(`${rec.ratings.n} published rating${rec.ratings.n === 1 ? '' : 's'}${rec.ratings.median != null && rec.ratings.n >= 3 ? `, median ${rec.ratings.median}/5` : ''}`);
  if (!parts.length) return '';
  return `${parts.join(' · ')} — per Wikipedia${rec.asOf ? `, ${fmt(rec.asOf)}` : ''}`;
}
function toneFromFigure(rec) {
  const v = rec && rec.rt ? rec.rt.pct : rec && rec.mc ? rec.mc.score : null;
  if (v == null) return null;
  return v >= 70 ? 'positive' : v >= 50 ? 'mixed' : 'negative';
}
// One fact once: the audience number is in the pill row above; the line carries only the
// critics' side, and only when there is a tone or a cited figure.
function scoreLineHtml(item) {
  const s = item.fcScore;
  const votes = Number(item.votes || 0);
  const aud = item.rating != null && votes ? `<b>Audience:</b> ${votes.toLocaleString('en-IN')} ratings on TMDB` : votes ? `<b>Audience:</b> ${votes.toLocaleString('en-IN')} ratings on TMDB, no average yet` : '<b>Audience:</b> not rated on TMDB yet';
  const tone = s && s.critics ? s.critics : null;
  const cited = item.reception ? receptionLine(item.reception, fmtDate, tone) : '';
  const label = tone || (cited ? toneFromFigure(item.reception) : null);
  const cri = label ? ` · <b>Critics:</b> ${esc(label)}${cited ? ' — ' + esc(cited) : ''}` : '';
  return `<div class="fcs-line">${aud}${cri}</div>`;
}
function fcScoreHtml(item) {
  const s = item.fcScore;
  const none = noScoreText(item);
  if (!s) return `<div class="fcs fcs-early"><div class="fcs-head"><span class="fcs-label">FilmyChill score</span><span class="fcs-v">${ratingDial(item)}${verdictPill(none.label, 'early')}</span></div><div class="fcs-why">${esc(none.why)}</div></div>` + fcSignals(item);
  return `<div class="fcs"><div class="fcs-head"><span class="fcs-label">FilmyChill score</span><span class="fcs-v">${ratingDial(item)}${verdictPill(s.verdict)}</span></div><div class="fcs-why">${esc(s.reason)}${s.early ? ' <span class="fcs-tag">Based on ' + Number(s.votes || 0).toLocaleString('en-IN') + ' ratings</span>' : ''}</div></div>` + fcSignals(item);
}

// CLEANER CARDS (Oct 2026). One card used to stack a coloured badge for everything, a boxed
// "FILMYCHILL SCORE" panel, a second ratings line and a long details line — 17 times over.
// Now: a bigger poster with the rank on it, title, a short details line, at most one status
// chip (plus the platform on streaming titles), and the score as one line. The detail view
// (tap a card) still has everything. Server twin: ssrCard in scripts/lib/weekly.js.
const BOOKMARK_PATH = 'M18 21l-6-4-6 4V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16z';
function cardMeta(item) {
  const genre = item.genre ? String(item.genre).split(' / ')[0] : '';
  const tail = item.kind === 'tv' ? (item.seasons ? 'Season ' + item.seasons : 'Series') : (item.runtime ? fmtRuntime(item.runtime) : '');
  return [item.language, genre, tail].filter(Boolean).map(esc).join(' · ');
}
function cardChips(item) {
  const out = [];
  if (item.platform && item.platform !== 'Theatres') out.push(`<span class="cchip">${esc(item.platform)}</span>`);
  // One status at most, in order of what's most useful to know.
  if (item.trending) out.push('<span class="cchip trend">Trending</span>');
  else if (cardBadge(item)) out.push(`<span class="cchip new">${esc(cardBadge(item))}</span>`);
  else if (newForUser.has(item.slug || slugify(item.title))) out.push('<span class="cchip foryou">New for you</span>');
  return out.length ? `<div class="cchips">${out.join('')}</div>` : '';
}
// Verdict pills and audience-rating dials (Oct 2026 redesign). Twins of verdictPill,
// dialRating, ratingDial and heroDialInner in scripts/lib/meter.js: same markup, so the page
// doesn't change when it re-renders the server's cards. The dial's number is the audience
// rating (out of 10), shown where the card used to print "★ 7.5" — not the FilmyChill Score,
// which is a verdict.
function verdictLevel(v) { return /^must/i.test(v || '') ? 'must' : /^skip/i.test(v || '') ? 'skip' : /^worth/i.test(v || '') ? 'worth' : 'early'; }
function verdictPill(label, level) { return `<span class="vpill vp-${level || verdictLevel(label)}">${esc(label)}</span>`; }
function dialRating(item) {
  const s = item && item.fcScore;
  if (!s || !s.audience || item.rating == null || !item.votes) return null;
  const r = Number(item.rating);
  return Number.isFinite(r) ? r : null;
}
function evidenceLabel(item) {
  const s = item && item.fcScore;
  if (s && s.basis === 'critics') {
    const n = Number(item.criticsCount) || 0;
    return n > 0 ? n + ' critic review' + (n === 1 ? '' : 's') : "Critics' verdict";
  }
  if (s) return '';
  if (noScoreText(item).label === 'Not out yet') return '';
  const votes = Number((item && item.votes) || 0);
  if (votes >= 50 && item.rating == null) return 'No rating yet';
  return votes > 0 ? 'Few ratings' : 'Not rated yet';
}
function ratingDial(item) {
  const r = dialRating(item);
  if (r == null) { const t = evidenceLabel(item); return t ? '<div class="dial-note">' + esc(t) + '</div>' : ''; }
  const v = r.toFixed(1);
  return `<div class="dial dial-${verdictLevel(item.fcScore.verdict)}" style="--p:${Math.round(r * 10)}%" role="img" aria-label="Audience rating ${v} out of 10"><span>${v}</span></div>`;
}
function heroDialInner(item) {
  const r = dialRating(item);
  if (r == null) { const t = evidenceLabel(item); return t ? '<div class="hero-note">' + esc(t) + '</div>' : ''; }
  const v = r.toFixed(1);
  return `<div class="dial dial-hero" style="--p:${Math.round(r * 10)}%" role="img" aria-label="Audience rating ${v} out of 10"><span>${v}</span></div><div class="hero-dial-label">Audience</div>`;
}
function cardScore(item) {
  const s = item.fcScore;
  const reason = (text) => (text ? `<div class="sreason">${text}</div>` : '');
  if (s) {
    const bits = [esc(String(s.reason || '').replace(/\.$/, ''))];
    if (s.early) bits.push('Based on ' + Number(s.votes || 0).toLocaleString('en-IN') + ' ratings');
    return verdictPill(s.verdict) + reason(bits.filter(Boolean).join(' · '));
  }
  const none = noScoreText(item);
  if (none.label === 'Critics split') {
    const n = Number(item.criticsCount) || 0;
    return verdictPill('Critics split', 'early') + reason(n ? n + ' critic review' + (n === 1 ? '' : 's') + ', divided' : '');
  }
  if (none.label === 'Not out yet') return verdictPill('Not out yet', 'early');
  if (none.label === 'Too early') {
    const tv = trailerViewsLabel(item.trailerViews);
    const when = freshLabel(item);
    const buzz = wikiViewsLabel(item.wikiWeeklyViews) || (tv ? tv.replace(/^▶\s*/, '') : '');
    const extra = buzz || when || '';
    return verdictPill('Too early', 'early') + reason(esc(extra.charAt(0).toUpperCase() + extra.slice(1)));
  }
  const votes = Number(item.votes || 0);
  return verdictPill('Not enough ratings', 'early')
    + reason(votes ? 'Only ' + votes.toLocaleString('en-IN') + ' rating' + (votes === 1 ? '' : 's') : '');
}
function card(item, i, listKey) {
  const track = listKey === 'wl' ? trackStatus(item) : null;
  const saved = isSaved(item);
  const art = item.poster
    ? `<img class="poster" src="${esc(item.poster)}" alt="${esc(item.title)} poster" width="150" height="200" loading="lazy">`
    : `<div class="poster ph" aria-hidden="true">${esc((item.title || '?').charAt(0).toUpperCase())}</div>`;
  return `<div class="card" data-click="openDetail" data-enter="openDetail" data-list="${listKey}" data-i="${i}" tabindex="0">
    <button class="save-btn${saved ? ' saved' : ''}" data-click="toggleSave" data-list="${listKey}" data-i="${i}" aria-label="${saved ? 'Remove from' : 'Add to'} My List"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${BOOKMARK_PATH}"/></svg></button>
    <div class="pw">${art}<span class="rank">${i + 1}</span></div>
    <div class="cb">
      <h3>${esc(item.title)}</h3>
      <div class="meta">${cardMeta(item)}</div>
      ${cardChips(item)}
      ${track ? `<div class="track-status ${track.cls}">${track.label}</div>` : ''}
      ${cardScore(item)}
    </div>
    ${ratingDial(item)}
  </div>`;
}

// Mirrors releaseState() in scripts/update.js, but against the VISITOR'S calendar day.
// This is the layer that matters most: the HTML and data.json a browser is holding can be
// hours or days old, so a card built for a Tuesday release is still in cache on Wednesday.
// 'released' items are dropped from Coming Soon here rather than shown with a passed date.
function releaseState(dateStr) {
  if (!dateStr) return 'unknown';
  const d = String(dateStr).slice(0, 10);
  const n = new Date();
  const today = new Date(n.getTime() - n.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return d > today ? 'upcoming' : d === today ? 'today' : 'released';
}
// Mirrors normalizeUpcoming() in scripts/lib/release.js. The regional date (`released`) wins
// whenever it hasn't passed; freshDate is TMDB's GLOBAL date and is only a fallback for a
// regional date that has already gone by. Picking the earlier of the two showed India visitors
// the US date (Digger 30 Sept instead of 2 Oct) and silently overwrote the server-rendered
// cards, which had it right — the page contradicted its own HTML a second after load.
function upcomingOnly(list) {
  return (list || []).map(function (it) {
    if (!it) return null;
    if (it.released && releaseState(it.released) !== 'released') return it;
    var fallback = [it.freshDate].filter(Boolean)
      .map(function (d) { return String(d).slice(0, 10); })
      .find(function (d) { return releaseState(d) !== 'released'; });
    return fallback ? Object.assign({}, it, { released: fallback }) : null;
  }).filter(Boolean);
}
function daysAway(dateStr) {
  const st = releaseState(dateStr);
  if (st === 'unknown' || st === 'released') return null;
  if (st === 'today') return 'Today';
  // Count calendar days in the VISITOR's zone. new Date('YYYY-MM-DD') parses as UTC midnight,
  // so everywhere east of UTC (India, UAE, Singapore, Australia, Germany) read a day high:
  // 25 Sept showed "In 10 days" on the 16th.
  const p = String(dateStr).slice(0, 10).split('-').map(Number);
  const diff = Math.round((new Date(p[0], p[1] - 1, p[2]) - new Date().setHours(0,0,0,0)) / 86400000);
  if (diff === 1) return 'Tomorrow';
  return 'In ' + diff + ' days';
}
// Coming-soon cards are real links (Oct 2026), like the server-rendered ones they replace:
// crawlers and new-tab clicks reach the film's own page, which exists for every upcoming
// title. A plain click still opens the detail sheet. A title without a slug keeps the button.
function soonClick(ev, i) {
  if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return true;
  ev.preventDefault();
  openDetail('comingSoon', i);
  return false;
}
function soonCard(item, i) {
  const dd = daysAway(item.released);
  const open = item.slug
    ? `<a class="soon-card" href="${esc(filmPagePath(item.slug))}" style="text-decoration:none;color:inherit" data-click="soonClick" data-i="${i}">`
    : `<div class="soon-card" data-click="openDetail" data-enter="openDetail" data-list="comingSoon" data-i="${i}" tabindex="0" role="button" aria-label="${esc(item.title)} details">`;
  return `${open}
    ${item.poster ? `<img src="${esc(item.poster)}" alt="${esc(item.title)} poster" width="150" height="200" loading="lazy">` : `<div class="soon-ph" aria-hidden="true"><span class="soon-ph-letter">${esc((item.title || '?').charAt(0).toUpperCase())}</span><span class="soon-ph-note">Poster on the way</span></div>`}
    <div class="soon-body">
      <div class="soon-date">${esc(releaseState(item.released) === 'today' ? 'Today' : fmtDate(item.released))}${dd ? `<span class="soon-days">${esc(dd)}</span>` : ''}</div>
      <div class="soon-title">${esc(item.title)}</div>
      <div class="soon-meta">${esc(item.language || '')}${item.genre ? ' · ' + esc(item.genre) : ''}</div>
      <div class="soon-hint">${item.trailer ? '▶ Trailer →' : 'Details →'}</div>
    </div>
  </${item.slug ? 'a' : 'div'}>`;
}

function applyFilters(list) {
  let out = list;
  if (activeLang !== 'All') out = out.filter(x => x.language === activeLang);
  if (sortMode === 'rating') out = [...out].sort((a, b) => (b.rating || 0) - (a.rating || 0));
  if (sortMode === 'date') out = [...out].sort((a, b) => (b.released || '').localeCompare(a.released || ''));
  return out;
}

function render() {
  // Before the data is in, the lists on screen are the server-rendered ones: a filter or sort
  // chosen now is remembered (activeLang, sortMode) and applied when the data lands, instead of
  // redrawing the page from empty lists (Oct 2026).
  if (!dataReady) { if (hydrateNow) hydrateNow(); return; }
  const wl = loadWL();
  const mySec = document.getElementById('mylistSection');
  mySec.style.display = wl.length ? 'block' : 'none';
  document.getElementById('mylistGrid').innerHTML = wl.map((it, i) => card(it, i, 'wl')).join('');
  const t = myListOnly ? [] : applyFilters(DATA.theatres);
  const o = myListOnly ? [] : applyFilters(DATA.ott);
  const hideMsg = myListOnly ? '<div class="error-box">Showing only My List above — tap My List again to see everything.</div>' : '<div class="error-box">No releases match this filter.</div>';
  document.getElementById('moviesGrid').innerHTML = t.map((it) => card(it, DATA.theatres.indexOf(it), 'theatres')).join('') || hideMsg;
  let ottHtml = '', ottDivided = false;
  o.forEach((it, idx) => {
    if (!ottDivided && sortMode === 'default' && it.stillGood && idx > 0) {
      ottHtml += '<div class="ott-divider">Still worth it — standouts from earlier weeks</div>';
      ottDivided = true;
    }
    ottHtml += card(it, DATA.ott.indexOf(it), 'ott');
  });
  document.getElementById('ottGrid').innerHTML = ottHtml || hideMsg;
  const cs = upcomingOnly(DATA.comingSoon);
  const csShown = activeLang === 'All' ? cs : cs.filter(x => x.language === activeLang);
  document.getElementById('soonStrip').innerHTML = csShown.map((it) => soonCard(it, cs.indexOf(it))).join('') ||
    '<div class="error-box" style="flex:1">' + (cs.length ? 'No upcoming ' + esc(activeLang) + ' releases in the next scan.' : 'Upcoming releases will appear after the next scan.') + '</div>';
  const tc = document.getElementById('theatreCount');
  if (tc && DATA.theatres.length) tc.textContent = 'TOP ' + DATA.theatres.length;
  // "TOP 10" overstated a list where only three titles were new this week and the rest were
  // carried over. Count the fresh ones separately — the divider already tells the truth
  // further down the list, so the header should agree with it.
  const oc = document.getElementById('ottCount');
  if (oc && DATA.ott.length) oc.textContent = 'TOP ' + DATA.ott.length;
  updateWLCount();
}

function slugify(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

// Per-film page path for the CURRENT country. India is flat (/movie/<slug>.html); other
// countries are namespaced (/<code>/movie/<slug>.html). FC_PAGE is set below from the DOM.
function filmPagePath(slug) {
  return (typeof FC_PAGE !== 'undefined' && FC_PAGE !== 'in')
    ? '/' + FC_PAGE + '/movie/' + slug + '.html'
    : '/movie/' + slug + '.html';
}

function findBySlug(slug) {
  for (const k of ['theatres', 'ott', 'comingSoon']) {
    const i = (DATA[k] || []).findIndex(x => slugify(x.title) === slug);
    if (i !== -1) return { k, i };
  }
  return null;
}

function ytId(url) {
  const m = /youtube\.com\/watch\?v=([\w-]{6,})/.exec(url || '');
  return m ? m[1] : null;
}

function playTrailer(id) {
  const box = document.getElementById('trailerBox');
  if (!box) return;
  box.outerHTML = `<div class="trailer-frame"><iframe src="https://www.youtube-nocookie.com/embed/${esc(id)}?autoplay=1&rel=0" title="Trailer" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`;
}

function shareFilm(listKey, i) {
  const item = listKey === 'wl' ? loadWL()[i] : DATA[listKey][i];
  if (!item) return;
  const link = location.origin + location.pathname + '#' + slugify(item.title);
  const when = item.released ? (item.released > new Date().toISOString().slice(0, 10) ? 'Releases ' : 'Released ') + fmtDate(item.released) : '';
  const bits = [item.platform, item.language, when].filter(Boolean).join(' · ');
  const text = `🎬 *${item.title}*${bits ? '\n' + bits : ''}${(item.fcScore && item.fcScore.verdict) || item.verdict ? '\n▸ ' + ((item.fcScore && item.fcScore.verdict) || item.verdict) : ''}\n\nTrailer & details:\n${link}`;
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
}

// ---- Personal retention: what changed for YOU since last time ----
let newForUser = new Set();
let isReturningVisitor = false;

function computePersonal() {
  const all = [...DATA.theatres, ...DATA.ott, ...(DATA.comingSoon || [])];
  const slugOf = x => x.slug || slugify(x.title);
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem('filmychill-seen') || '[]'); } catch {}
  const seenSet = new Set(seen);
  const firstVisit = seen.length === 0;
  isReturningVisitor = !firstVisit;
  if (!firstVisit) {
    all.forEach(x => { if (!seenSet.has(slugOf(x))) newForUser.add(slugOf(x)); });
  }
  try {
    localStorage.setItem('filmychill-seen', JSON.stringify(all.map(slugOf)));
    localStorage.setItem('filmychill-lastvisit', new Date().toISOString());
  } catch {}

  // Watchlist alerts, STAGED: a saved film alerts once for its theatrical release and —
  // separately — once more when it lands on OTT. The OTT-arrival moment is the alert
  // people actually save films for ("when will X come on Netflix?"), and it's exactly
  // what the pipeline's first-seen tracking detects. Old dismissals stored bare slugs;
  // those count as the theatre stage, so the OTT alert can still fire for them later.
  const today = new Date().toISOString().slice(0, 10);
  let alerted = [];
  try { alerted = JSON.parse(localStorage.getItem('filmychill-alerted') || '[]'); } catch {}
  const alertedSet = new Set(alerted);
  const releases = [];
  for (const saved of loadWL()) {
    const sslug = slugOf(saved);
    // OTT first: if a saved film is streaming now, that's the headline regardless of history.
    for (const k of ['ott', 'theatres']) {
      const i = DATA[k].findIndex(x => slugOf(x) === sslug);
      if (i === -1) continue;
      const it = DATA[k][i];
      const stage = (k === 'ott' && it.platform && it.platform !== 'Theatres') ? 'ott' : 'theatre';
      if (stage === 'theatre' && !(it.released && it.released <= today)) break; // not out yet
      const key = sslug + ':' + stage;
      const done = alertedSet.has(key) || (stage === 'theatre' && alertedSet.has(sslug));
      if (!done) releases.push({ k, i, item: it, slug: sslug, stage, key });
      break;
    }
  }

  const bar = document.getElementById('personalBar');
  let html = '';

  // "New since your last visit" — the dormant half of the seen-tracking above, now rendered.
  // Capped so a long absence (everything new) doesn't produce a pointless banner.
  if (isReturningVisitor && newForUser.size >= 1 && newForUser.size <= 15) {
    html += `<div class="personal-note" id="pn-newforyou"><svg class="ic" aria-hidden="true"><use href="#icSpark"/></svg> <span><b>${newForUser.size} new</b> since your last visit — look for the "New for you" tags</span>
      <button class="pn-x" data-click="removeById" data-arg="pn-newforyou" aria-label="Dismiss">×</button></div>`;
  }

  for (const r of releases.slice(0, 2)) {
    const line = r.stage === 'ott'
      ? `🎉 <span>From your list: <b>${esc(r.item.title)}</b> just landed on ${esc(r.item.platform || FC_STREAM.word)}${r.item.rating ? ' — ★ ' + Number(r.item.rating).toFixed(1) : ''}</span>`
      : `🎬 <span>From your list: <b>${esc(r.item.title)}</b> is out now in theatres${r.item.rating ? ' — ★ ' + Number(r.item.rating).toFixed(1) : ''}</span>`;
    html += `<div class="personal-note" id="pn-${esc(r.key.replace(/:/g, '-'))}">${line}
      <span class="pn-cta" data-click="openDetail" data-list="${r.k}" data-i="${r.i}" data-via="note">View →</span>
      <button class="pn-x" data-click="dismissAlert" data-arg="${esc(r.key)}" aria-label="Dismiss">×</button></div>`;
  }
  bar.innerHTML = html;
}

function dismissAlert(key) {
  try {
    const a = JSON.parse(localStorage.getItem('filmychill-alerted') || '[]');
    if (!a.includes(key)) a.push(key);
    localStorage.setItem('filmychill-alerted', JSON.stringify(a));
  } catch {}
  const el = document.getElementById('pn-' + key.replace(/:/g, '-'));
  if (el) el.remove();
}

// ---- Calendar reminder (.ics, generated client-side) ----
function icsEscape(t) { return String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,'); }
function remindMe(listKey, i) {
  const item = listKey === 'wl' ? loadWL()[i] : DATA[listKey][i];
  if (!item || !item.released) return;
  const d = item.released.replace(/-/g, '');
  const next = new Date(item.released); next.setDate(next.getDate() + 1);
  const dEnd = next.toISOString().slice(0, 10).replace(/-/g, '');
  const slug = item.slug || slugify(item.title);
  const link = `https://filmychill.com/#${slug}`;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FilmyChill//EN', 'BEGIN:VEVENT',
    `UID:${slug}-${d}@filmychill.com`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${dEnd}`,
    `SUMMARY:🍿 ${icsEscape(item.title)} releases today`,
    `DESCRIPTION:Trailer & verdict on FilmyChill: ${icsEscape(link)}`,
    `URL:${icsEscape(link)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = `${slug}-release.ics`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// CARD-CLICK EVENTS (Oct 2026). Which section and which position people actually open is the
// raw material for ranking better later. Sent as Google Analytics events (the site's counter
// since 19 Oct 2026; GoatCounter before) — e.g. item "card/in/ott/3", name "Slow Horses". If
// analytics is blocked or switched off, this does nothing.
function fcTrack(path, title) {
  try {
    // Google Analytics (scripts/lib/ga.js): one "select_content" event per opened card.
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'select_content', { content_type: String(path).split('/')[0], item_id: path, content_name: String(title || '').slice(0, 100) });
    }
  } catch (e) { /* analytics must never break the page */ }
}
const SECTION_NAME = { theatres: 'theatres', ott: 'ott', comingSoon: 'soon', wl: 'mylist' };
function openDetail(listKey, i, via) {
  const item = listKey === 'wl' ? loadWL()[i] : DATA[listKey][i];
  if (!item) return;
  fcTrack(`card/${FC_PAGE || 'in'}/${via || SECTION_NAME[listKey] || listKey}/${i + 1}`, item.title);
  const provs = (item.providers || []).map(p => `<span class="pill prov">${esc(p)}</span>`).join('')
    // Subscription vs pay-per-title is the most common unanswered question on OTT
    // listings — one pill answers it. rentBuy only exists where TMDB lists rent/buy
    // platforms not already covered by a subscription above.
    + ((item.rentBuy || []).length ? `<span class="pill">💳 Rent or buy: ${esc(item.rentBuy.slice(0, 3).join(', '))}</span>` : '');
  const facts = [
    item.runtime ? `<span class="pill">⏱ ${esc(item.kind === 'tv' ? item.runtime + ' min/ep' : fmtRuntime(item.runtime))}</span>` : '',
    item.cert ? `<span class="pill">🔖 ${esc(item.cert)}</span>` : '',
  ].join('');
  const relLabel = item.released && item.released > new Date().toISOString().slice(0, 10) ? 'Releases' : 'Released';
  // TV: show the LATEST season's date (freshDate), not the series' original launch — a 2022
  // launch date under a show whose new season dropped last week reads as stale/wrong.
  const whenLine = item.kind === 'tv' && item.freshDate ? 'Latest season ' + fmtDate(item.freshDate)
                 : item.released ? relLabel + ' ' + fmtDate(item.released) : '';
  document.getElementById('modal').innerHTML = `
    ${item.backdrop ? `<img class="modal-backdrop" src="${esc(item.backdrop)}" alt="">` : ''}
    <button class="modal-close" data-click="closeDetail" aria-label="Close">×</button>
    <div class="modal-inner">
      <h2>${esc(item.title)} ${cardBadge(item) ? `<span class="fresh-badge">${esc(cardBadge(item))}</span>` : ''} ${item.trending ? '<span class="fresh-badge trend"><svg class="ic" aria-hidden="true"><use href="#icTrend"/></svg> Trending</span>' : ''}</h2>
      <div class="meta">${esc(item.genre || '')}${item.language ? ' · ' + esc(item.language) : ''}${whenLine ? ' · ' + esc(whenLine) : ''}${trailerViewsLabel(item.trailerViews) ? ' · ' + trailerViewsLabel(item.trailerViews) : ''}</div>
      <div class="pill-row">${facts}${provs}</div>
      ${fcScoreHtml(item)}
      ${scoreLineHtml(item)}
      <div class="review">${esc(item.fullReview || item.review || 'No description available.')}</div>
      <div class="credits">
        ${item.director ? `<b>Director:</b> ${esc(item.director)}` : ''}
      </div>
      ${(item.castPics && item.castPics.length) ? `<div class="cast-strip">${item.castPics.map(c => `<div class="cast-card"><img src="${esc(c.photo)}" alt="${esc(c.name)}" width="64" height="64" loading="lazy"><div class="cast-name">${esc(c.name)}</div>${c.character ? `<div class="cast-role">${esc(c.character)}</div>` : ''}</div>`).join('')}</div>`
        : (item.cast && item.cast.length) ? `<div class="credits"><b>Cast:</b> ${esc(item.cast.join(', '))}</div>` : ''}
      ${item.hook ? `<div class="meta hook" style="margin-top:10px">${esc(item.hook)}</div>` : ''}
      ${item.take ? `<div class="take">${esc(item.take)}${item.takeCounter ? ` <span class="tcounter">${esc(item.takeCounter)}</span>` : ''}</div>` : ''}
      ${(() => {
        const id = ytId(item.trailer);
        if (id) return `<button class="trailer-btn" id="trailerBox" data-click="playTrailer" data-arg="${esc(id)}">▶ Watch trailer</button>`;
        if (item.trailer) return `<a class="trailer-btn" href="${esc(item.trailer)}" target="_blank" rel="noopener">▶ Find trailer</a>`;
        return '';
      })()}
      <button class="share-film-btn" data-click="shareFilm" data-list="${listKey}" data-i="${i}"><svg class="ic" aria-hidden="true"><use href="#icShare"/></svg> Share<span class="wa-chip" aria-hidden="true"><svg class="wa-ic"><use href="#waIcon"/></svg></span></button>
      ${item.released && item.released > new Date().toISOString().slice(0, 10) ? `<button class="trailer-btn" style="background:var(--marigold);color:var(--ink);margin-left:8px" data-click="remindMe" data-list="${listKey}" data-i="${i}"><svg class="ic" aria-hidden="true"><use href="#icCal"/></svg> Remind me</button>` : ''}
      ${item.slug ? `<a class="trailer-btn" style="background:transparent;color:var(--indigo);border:1.5px solid var(--indigo);margin-left:8px" href="${filmPagePath(item.slug)}" data-click="trackFullPage" data-arg="${esc(item.title)}">📄 Full page</a>` : ''}
      <a class="trailer-btn" style="background:var(--marigold);color:var(--ink);margin-left:8px" href="#" data-click="saveFromDetail" data-list="${listKey}" data-i="${i}">${isSaved(item) ? '★ Remove from My List' : '☆ Add to My List'}</a>
    </div>`;
  history.replaceState(null, '', '#' + slugify(item.title));
  document.getElementById('overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeDetail() {
  history.replaceState(null, '', location.pathname + location.search);
  document.getElementById('overlay').classList.remove('open');
  document.body.style.overflow = '';
}
document.getElementById('overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeDetail(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });
document.getElementById('sortSel').addEventListener('change', e => { sortMode = e.target.value; render(); });

// Language filter: one dropdown (Sept 2026) — the row of chips crowded the toolbar, most of
// all on phones. Same filter, same remembered choice.
function setLang(l) {
  activeLang = l || 'All';
  try { localStorage.setItem('filmychill-lang', activeLang); } catch {}
  const sel = document.getElementById('langSel');
  if (sel && sel.value !== activeLang) sel.value = activeLang;
  render();
}

// ---- Tonight mood shuffle ----
const MOODS = {
  light:  ['Comedy', 'Romance', 'Animation', 'Family', 'Music'],
  thrill: ['Thriller', 'Action', 'Crime', 'Horror', 'Mystery', 'Science Fiction'],
  feels:  ['Drama', 'Romance', 'History', 'War'],
  family: ['Family', 'Animation', 'Adventure', 'Fantasy'],
};
function openMood() { document.getElementById('moodOverlay').classList.add('open'); document.body.style.overflow = 'hidden'; }
function closeMood() { document.getElementById('moodOverlay').classList.remove('open'); document.body.style.overflow = ''; }
let moodTime = 'any';
function setMoodTime(t, el) {
  moodTime = t;
  document.querySelectorAll('.time-chip').forEach(c => c.classList.remove('on'));
  if (el) el.classList.add('on');
}
function moodPick(mood) {
  const all = [...DATA.theatres.map((x, i) => ({ x, k: 'theatres', i })), ...DATA.ott.map((x, i) => ({ x, k: 'ott', i }))];
  const wanted = MOODS[mood] || [];
  let pool = all.filter(e => wanted.some(g => (e.x.genre || '').includes(g)));
  if (!pool.length) pool = all;
  // Respect the evening: TV episodes always fit; movies must fit the chosen window.
  if (moodTime !== 'any') {
    const fits = pool.filter(e => e.x.kind === 'tv' || (e.x.runtime && e.x.runtime <= Number(moodTime)));
    if (fits.length) pool = fits;
  }
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  closeMood();
  if (chosen) {
    openDetail(chosen.k, chosen.i);
    showInstallNudge('modal', "Tonight's sorted 🍿", " — want tomorrow's pick one tap away?");
  }
}
document.getElementById('moodOverlay').addEventListener('click', e => { if (e.target.id === 'moodOverlay') closeMood(); });



// ---- Friday ritual: recurring weekly calendar event, generated client-side ----
function addFridayRitual(btn) {
  const now = new Date();
  const next = new Date(now);
  next.setDate(now.getDate() + ((5 - now.getDay() + 7) % 7 || 7));
  const d = next.toISOString().slice(0, 10).replace(/-/g, '');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FilmyChill//EN', 'BEGIN:VEVENT',
    `UID:friday-ritual@filmychill.com`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART:${d}T190000`, `DTEND:${d}T220000`,
    'RRULE:FREQ=WEEKLY;BYDAY=FR',
    'SUMMARY:🍿 FilmyChill Friday — movie night',
    "DESCRIPTION:This week's verdicts\\, trailers & where to watch: https://filmychill.com",
    'URL:https://filmychill.com', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = 'filmychill-friday.ics'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  if (btn) { btn.textContent = '✓ Added'; btn.disabled = true; }
}

// ---- Earned install prompt: appears only after a moment of value ----
let deferredInstall = null;
// The "Install app" pill in the toolbar (29 Oct 2026): shown only when the browser says the site
// can be installed (Android/desktop Chrome fire beforeinstallprompt), or on iPhone/iPad from the
// second visit, where it opens the Share → Add to Home Screen tip. Hidden once installed or
// dismissed; never on the first visit.
// Install analytics (Google Analytics, the site's counter): pwa_install_prompt (the pill was
// shown), pwa_install (the browser confirmed an install — Android/desktop; iOS gives no signal),
// pwa_install_tip (an iPhone user opened the Share tip), pwa_launch (opened as the installed app:
// standalone display, or the manifest's start URL ?source=pwa). Nothing goes anywhere else.
function pwaTrack(name, params) {
  try { if (typeof window.gtag === 'function') window.gtag('event', name, Object.assign({ platform: /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'desktop' }, params || {})); } catch (e) { /* analytics must never break the page */ }
}
function installPill(show, label) {
  const b = document.getElementById('installBtn');
  if (!b) return;
  if (label) b.querySelector('span').textContent = label;
  if (show && b.hidden) pwaTrack('pwa_install_prompt', { kind: label === 'Install app' ? 'native' : 'tip' });
  b.hidden = !show;
}
function isStandalone() { return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true; }
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (installEligible({ ignoreVisit: true })) installPill(true, 'Install app'); });
window.addEventListener('appinstalled', () => { deferredInstall = null; installPill(false); removeNudge(); pwaTrack('pwa_install'); });
if (isStandalone() || /[?&]source=pwa\b/.test(location.search)) pwaTrack('pwa_launch');
function installFromPill() {
  if (deferredInstall) { triggerInstall(); return; }
  // iOS (and any browser without a prompt): the one-line tip, dismissible, in the notes bar.
  pwaTrack('pwa_install_tip');
  const bar = document.getElementById('personalBar');
  if (bar && !document.getElementById('installNudge')) bar.insertAdjacentHTML('afterbegin', installNudgeHtml('Add FilmyChill to your Home Screen', ''));
  triggerInstall();
}
let nudgeShownThisSession = false;

function installEligible({ ignoreVisit = false } = {}) {
  try {
    if (localStorage.getItem('filmychill-install-dismissed')) return false;
  } catch { return false; }
  if (!ignoreVisit && !isReturningVisitor) return false;
  if (isStandalone()) return false;
  if (!ignoreVisit && nudgeShownThisSession) return false;
  return true;
}

function installNudgeHtml(title, sub) {
  return `<div class="install-nudge" id="installNudge">📱 <span><b>${esc(title)}</b>${esc(sub)}</span>
    <button class="in-btn" data-click="triggerInstall">Add to home</button>
    <button class="in-x" data-click="dismissInstall" aria-label="Dismiss">×</button></div>`;
}

function showInstallNudge(where, title, sub) {
  if (!installEligible()) return;
  nudgeShownThisSession = true;
  const host = document.getElementById(where);
  if (host) host.insertAdjacentHTML('beforeend', installNudgeHtml(title, sub));
}

function triggerInstall() {
  if (deferredInstall) {
    deferredInstall.prompt();
    deferredInstall.userChoice.then(() => { deferredInstall = null; removeNudge(); });
  } else {
    const el = document.getElementById('installNudge');
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (el) el.innerHTML = `📱 <span style="font-size:12.5px">${ios
      ? 'In Safari: tap <b>Share</b> → <b>Add to Home Screen</b>'
      : 'In your browser menu (⋮): tap <b>Add to Home screen</b>'}</span>
      <button class="in-x" data-click="dismissInstall" aria-label="Dismiss">×</button>`;
  }
}

function removeNudge() { const el = document.getElementById('installNudge'); if (el) el.remove(); }
function dismissInstall() {
  installPill(false);
  try { localStorage.setItem('filmychill-install-dismissed', '1'); } catch {}
  removeNudge();
}




function shareWeek() {
  const top = DATA.theatres.slice(0, 3).map((x, i) => `${i + 1}. ${x.title} (${x.platform})`).join('\n');
  const ott = DATA.ott.slice(0, 3).map((x, i) => `${i + 1}. ${x.title} (${x.platform})`).join('\n');
  const channel = WHATSAPP_CHANNEL_URL ? `\n\nFollow for weekly picks:\n${WHATSAPP_CHANNEL_URL}` : '';
  const text = `🎬 *This week on FilmyChill*\n\n*In Theatres:*\n${top}\n\n*Streaming:*\n${ott}\n\nFull list with trailers & verdicts:\n${location.href}${channel}`;
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
}

if (WHATSAPP_CHANNEL_URL) {
  const cb = document.getElementById('channelBtn');
  cb.href = WHATSAPP_CHANNEL_URL;
  cb.style.display = '';
}

// ---------- PER-COUNTRY PAGE LOGIC ----------
// Each country has its own page: India at "/", others at "/us/", "/uk/", "/au/", "/de/".
// FC_PAGE is injected per-page by the build (the country this page was generated for).
// Both maps are read from the country switcher, which the build renders from COUNTRIES
// (see renderCountryPage). SSR markers can't live inside a <script> — HTML comments break
// JS there — and a hardcoded copy went stale every time a country was added, so the rendered
// DOM is the single source. Falls back to India alone if the list is ever missing.
// Since the Oct 2026 redesign the switcher is the "India ▾" pill's list of links.
const COUNTRY_OPTS = [...document.querySelectorAll('#countryPill a[data-code]')]
  .map(a => [a.dataset.code, a.textContent.trim()]).filter(([v]) => /^[a-z]{2}$/.test(v));
const COUNTRY_LABELS = Object.fromEntries(COUNTRY_OPTS.length ? COUNTRY_OPTS : [['in', '🇮🇳 India']]);
// Which countries this build actually has pages for. Read from the same rendered list: when
// this was a separate hardcoded map, six new countries appeared in the switcher, were rejected
// here, and selecting one silently did nothing — while their own pages fell back to FC_PAGE
// 'in' and rendered India's data under a /kr/ URL.
const SUPPORTED_COUNTRIES = COUNTRY_LABELS;
// Path each country page lives at (relative to site root).
const COUNTRY_PATH = Object.fromEntries(Object.keys(COUNTRY_LABELS).map(c => [c, c === 'in' ? '/' : '/' + c + '/']));
// FC_PAGE is injected per-page by the build via a <meta name="fc-page"> tag (read from the
// DOM — NOT an inline-script global, because HTML comment markers inside a <script> would
// break the assignment). Defaults to India if missing/unknown.
const FC_PAGE = (() => {
  const m = document.querySelector('meta[name="fc-page"]');
  const code = m && m.getAttribute('content');
  return (code && SUPPORTED_COUNTRIES[code]) ? code : 'in';
})();

// The word this market uses for streaming, injected by the build alongside fc-page
// (single source of truth: streamVocab() in scripts/update.js). "OTT" is everyday
// language in India and the UAE and is what people there search; everywhere else it
// is industry jargon, so those pages say "streaming". Every runtime-rendered string
// that names the concept reads from here. Defaults to OTT (India = the root page).
const FC_STREAM = (() => {
  const m = document.querySelector('meta[name="fc-stream-word"]');
  const w = (m && m.getAttribute('content')) || 'OTT';
  const isOtt = w === 'OTT';
  return { word: w, Word: isOtt ? 'OTT' : 'Streaming' };
})();

// Switcher: navigate to the chosen country's page (links, not a JS reload — so each country
// is a real indexable URL). Remember the manual choice so the root won't re-redirect away.
function setCountry(code) {
  if (!SUPPORTED_COUNTRIES[code]) return;
  try { localStorage.setItem('fc_country', code); } catch (e) {}
  if (code === FC_PAGE) return; // already here
  location.href = COUNTRY_PATH[code];
}

// Starts the data download now instead of waiting for the hero (set by afterHero).
let hydrateNow = null;
// Pick of the Week: openPick is set once the data is in; a tap before then is held in
// heroTapped and answered the moment it arrives (or by the film's page if it never does).
let openPick = null, heroTapped = false;
document.addEventListener('pointerdown', () => { if (hydrateNow) hydrateNow(); }, { once: true, capture: true, passive: true });
function heroTap(el) {
  if (openPick) return openPick();
  if (heroTapped) return;
  heroTapped = true;
  el.classList.add('hero-loading');
  if (hydrateNow) hydrateNow();
  // Still nothing after 4 s (a stalled connection): the film's own page has it all.
  setTimeout(() => { if (heroTapped && !openPick && el.dataset.href) location.href = el.dataset.href; }, 4000);
}
function answerHeroTap(ok) {
  if (!heroTapped) return;
  heroTapped = false;
  const card = document.getElementById('heroCard');
  if (card) card.classList.remove('hero-loading');
  if (ok && openPick) openPick();
  else if (card && card.dataset.href) location.href = card.dataset.href;
}

// Reflect this page's country in the switcher + tagline, then load its data.
function initCountryPage() {
  const lbl = document.getElementById('countryLabel');
  if (lbl) lbl.textContent = COUNTRY_LABELS[FC_PAGE] || '🌐';
  afterHero(() => loadCountryData(FC_PAGE));
}

// The data file (35–70 KB) starts downloading once the hero backdrop — the homepage's LCP
// image — is on screen, or at once when there's no hero. Fetched straight away it shared a
// phone's bandwidth with that image; started the moment the image arrived, its re-render of
// every list ran in the frame that should have painted it. Either way LCP stayed past 2.5 s
// (Oct 2026). So hydration waits for the browser's own record that the hero has been painted
// (largest-contentful-paint, kept by Chromium and Firefox); elsewhere, for the page's load event.
// Nothing waits on it to be read: the page is already rendered from its HTML and its links work.
// A 3-second cap keeps a slow image (or a background tab) from holding the rest back.
// The backdrop is checked on the element's own style, never getComputedStyle: that forced a
// full style pass before the first paint and pushed it back ~150 ms.
function afterHero(fn) {
  let done = false;
  const go = () => { if (!done) { done = true; fn(); } };
  // A visitor who touches the page wants it now: start at once (Oct 2026). The browser stops
  // recording LCP at the first input anyway, so this can't cost the hero anything.
  hydrateNow = go;
  const bg = document.getElementById('heroBg');
  if (!bg || !bg.style.getPropertyValue('--hero-lg')) return go();
  setTimeout(go, 3000);
  if (typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes || []).includes('largest-contentful-paint')) {
    new PerformanceObserver((list, obs) => {
      if (list.getEntries().some((e) => e.element === bg)) { obs.disconnect(); setTimeout(go, 0); }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } else {
    addEventListener('load', () => requestAnimationFrame(() => setTimeout(go, 0)));
  }
}

// Each country has its own page (India at "/", others at "/<code>/"), so there is no
// geo-detection or redirect — the page simply renders the country it was built for. Visitors
// reach the right country via search (each page is indexed for its market) or the switcher.
initCountryPage();

// Both backdrop sizes as custom properties; the CSS picks one by screen width. Mirrors ssrHero
// in scripts/lib/surfaces.js, with the same URLs, so hydrating downloads nothing twice.
function setHeroBackdrop(url) {
  const lg = String(url).replace(/["'()\\]/g, '');
  const bg = document.getElementById('heroBg');
  if (!bg) return;
  bg.style.setProperty('--hero-lg', `url("${lg}")`);
  bg.style.setProperty('--hero-sm', `url("${lg.replace('/t/p/w780/', '/t/p/w300/')}")`);
}

function loadCountryData(code) {
// Data files live at the site ROOT. Use an absolute path ("/data-us.json") so it resolves
// correctly from any country subfolder (e.g. /us/) regardless of trailing-slash quirks —
// a relative "../" path can mis-resolve on some static hosts. Fall back to canonical data.json.
// Called once the hero backdrop has loaded (afterHero), so it no longer competes with it.
fetch('/data-' + code + '.json?v=' + Date.now())
  .then(r => r.ok ? r : fetch('/data.json?v=' + Date.now())) // fall back to canonical (India) file
  .then(r => r.json())
  .then(data => {
    DATA = data;
    DATA.theatres = data.theatres || [];
    DATA.ott = data.ott || [];

    // Hero — Pick of the Week
    const all = [...DATA.theatres, ...DATA.ott];
    const pick = all.find(x => x.title === data.pick);
    if (pick) {
      document.getElementById('hero').style.display = 'block';
      if (pick.backdrop) setHeroBackdrop(pick.backdrop);
      document.getElementById('heroTitle').textContent = pick.title;
      document.getElementById('heroMeta').textContent = [pick.platform, pick.genre, pick.language].filter(Boolean).join(' · ');
      const verdict = (pick.fcScore && pick.fcScore.verdict) || pick.verdict || '';
      document.getElementById('heroVerdict').innerHTML = verdict ? `<span class="vpill vp-hero">${esc(verdict)}</span>` : '';
      const heroDial = document.getElementById('heroDial');
      if (heroDial) heroDial.innerHTML = heroDialInner(pick);
      openPick = () => {
        const listKey = DATA.theatres.includes(pick) ? 'theatres' : 'ott';
        openDetail(listKey, DATA[listKey].indexOf(pick), 'pick');
      };
    }

    // Language dropdown: counts shown, ordered by this week's volume, choice remembered.
    // The build writes the same list (langOptions in scripts/lib/surfaces.js), so it is there
    // from the first paint; this rewrites it identically and restores the saved choice.
    const allCS = [...all, ...(data.comingSoon || [])];
    const counts = {};
    allCS.forEach(x => { if (x.language) counts[x.language] = (counts[x.language] || 0) + 1; });
    const langs = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    let savedLang = 'All';
    try { savedLang = localStorage.getItem('filmychill-lang') || 'All'; } catch {}
    activeLang = langs.includes(savedLang) ? savedLang : 'All';
    const total = allCS.length;
    const langSel = document.getElementById('langSel');
    langSel.innerHTML = [`<option value="All">All languages (${total})</option>`,
      ...langs.map(l => `<option value="${esc(l)}">${esc(l)} (${counts[l]})</option>`)].join('');
    langSel.value = activeLang;

    computePersonal();
    // iPhone/iPad have no install prompt: from the second visit the pill offers the tip instead.
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !deferredInstall && installEligible()) installPill(true, 'Add to Home Screen');
    dataReady = true;
    render();

    const d = new Date(data.generatedAt);
    const days = Math.floor((new Date() - d) / 86400000);
    document.getElementById('lastScan').textContent = days <= 0 ? 'Updated today' : days === 1 ? 'Updated yesterday' : 'Updated ' + days + ' days ago';

    // Deep link: open the film if the URL has a #slug (e.g. /#carry-on-jatta-4)
    const openFromHash = () => {
      const slug = decodeURIComponent(location.hash.slice(1));
      if (!slug) return;
      const hit = findBySlug(slug);
      if (hit) openDetail(hit.k, hit.i);
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    answerHeroTap(true);
  })
  .catch(() => {
    answerHeroTap(false);
    document.getElementById('lastScan').textContent = 'Fresh picks arriving soon';
    document.getElementById('moviesGrid').innerHTML = '<div class="error-box">No data yet — run the workflow in the Actions tab.</div>';
    document.getElementById('ottGrid').innerHTML = '<div class="error-box">No data yet.</div>';
  });
} // end loadCountryData

// ---- Event wiring (Oct 2026): one listener per event type, actions named in data attributes.
// The innermost element with the attribute wins, so a button inside a card runs its own action
// and not the card's (what event.stopPropagation() did inline).
const ACTIONS = {
  setCountry: (el) => setCountry(el.value || el.dataset.code),
  setLang: (el) => setLang(el.value),
  openMood: () => openMood(),
  toggleMyList: () => toggleMyList(),
  shareWeek: () => shareWeek(),
  addFridayRitual: (el) => addFridayRitual(el),
  closeMood: () => closeMood(),
  setMoodTime: (el) => setMoodTime(el.dataset.arg, el),
  moodPick: (el) => moodPick(el.dataset.arg),
  openDetail: (el) => openDetail(el.dataset.list, Number(el.dataset.i), el.dataset.via),
  toggleSave: (el) => toggleSave(el.dataset.list, Number(el.dataset.i)),
  soonClick: (el, ev) => soonClick(ev, Number(el.dataset.i)),
  removeById: (el) => { const n = document.getElementById(el.dataset.arg); if (n) n.remove(); },
  dismissAlert: (el) => dismissAlert(el.dataset.arg),
  closeDetail: () => closeDetail(),
  playTrailer: (el) => playTrailer(el.dataset.arg),
  shareFilm: (el) => shareFilm(el.dataset.list, Number(el.dataset.i)),
  remindMe: (el) => remindMe(el.dataset.list, Number(el.dataset.i)),
  trackFullPage: (el) => fcTrack('fullpage/' + (FC_PAGE || 'in'), el.dataset.arg),
  saveFromDetail: (el, ev) => { ev.preventDefault(); toggleSave(el.dataset.list, Number(el.dataset.i)); closeDetail(); },
  triggerInstall: () => triggerInstall(),
  installFromPill: () => installFromPill(),
  dismissInstall: () => dismissInstall(),
  heroTap: (el) => heroTap(el),
};
function runAction(attr, ev) {
  const el = ev.target && ev.target.closest ? ev.target.closest('[' + attr + ']') : null;
  if (!el) return;
  const fn = ACTIONS[el.getAttribute(attr)];
  if (fn) fn(el, ev);
}
document.addEventListener('click', (ev) => runAction('data-click', ev));
document.addEventListener('click', (ev) => { const d = document.getElementById('countryPill'); if (d && d.open && !d.contains(ev.target)) d.open = false; });
document.addEventListener('keydown', (ev) => { const d = document.getElementById('countryPill'); if (ev.key === 'Escape' && d && d.open) { d.open = false; d.querySelector('summary').focus(); } });
document.addEventListener('change', (ev) => runAction('data-change', ev));
document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') runAction('data-enter', ev); });

// The site's service worker (/sw.js): pages network-first, this week's data and posters cached,
// so the homepage and a saved list open offline. Registered after load, clear of the first paint.
if ('serviceWorker' in navigator) addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
