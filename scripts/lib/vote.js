// ============================================================================
// vote.js (server side) — the "Watched it? Was it worth it?" button on film pages.
//
// Visitors' votes go straight from the browser to Firestore (project filmychill-ca2b3) under
// an anonymous Firebase identity — no sign-up, one vote per person per film, enforced by
// firestore.rules. The browser half is /js/vote.js; it talks to Firebase's REST endpoints
// directly, so no Firebase SDK is loaded and film pages stay as light as they are.
// Votes are read back only by the build (lib/votes.js), never by visitors.
//
// Markup ships `hidden`: /js/vote.js reveals it, so a reader without JavaScript never sees
// buttons that can't work.
// ============================================================================
"use strict";

const { escHtml } = require("./core.js");

// The Google endpoints a voting page must be allowed to call (Content-Security-Policy).
const VOTE_CONNECT = [
  "https://identitytoolkit.googleapis.com",
  "https://securetoken.googleapis.com",
  "https://firestore.googleapis.com",
];

const THUMB = (down) => `<svg viewBox="0 0 24 24" aria-hidden="true"${down ? ' style="transform:rotate(180deg)"' : ""}><path d="M7 11v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3a4 4 0 0 0 4-4V6a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 3 0 0 1-2 2h-7a3 3 0 0 1-3-3"/></svg>`;

// The film's vote key: "movie-12345" / "tv-678". Null when the film can't take votes.
function voteKey(item) {
  if (!item || !item.tmdbId || !/^\d{1,9}$/.test(String(item.tmdbId))) return null;
  return `${item.kind === "tv" ? "tv" : "movie"}-${item.tmdbId}`;
}

// Only for films that are out — nobody can say whether an unreleased film was worth it.
function voteWidgetHtml(item, code, today = new Date().toISOString().slice(0, 10)) {
  const key = voteKey(item);
  if (!key) return "";
  if (item.released && String(item.released).slice(0, 10) > today) return "";
  const e = escHtml;
  return `<div class="fcvote" data-film="${e(key)}" data-c="${e(code || "in")}" hidden>
    <div class="fcvote-q">Watched it? Was it worth it?<small>Your vote helps the FilmyChill Score. No sign-up.</small></div>
    <div class="fcvote-b"><button type="button" data-v="1">${THUMB(false)}Worth it</button><button type="button" data-v="-1">${THUMB(true)}Not worth it</button></div>
    <div class="fcvote-done" hidden></div>
  </div>
  <script src="/js/vote.js" defer></script>`;
}

// Pure: allow the vote endpoints in a page's Content-Security-Policy (idempotent).
function cspAllowVotes(html) {
  return html.replace(/(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/, (m, a, policy, b) => {
    if (policy.includes("firestore.googleapis.com")) return m;
    const extra = VOTE_CONNECT.join(" ");
    const next = /connect-src /.test(policy)
      ? policy.replace(/connect-src ([^;]*)/, `connect-src $1 ${extra}`)
      : policy.replace(/(default-src 'self';)/, `$1 connect-src 'self' ${extra};`);
    return a + next + b;
  });
}

const VOTE_CSS = [
  "  .fcvote { margin:12px 0 4px; background:#fff; border:1px solid #E6E0D2; border-radius:14px; padding:12px 14px; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }",
  "  .fcvote-q { font-size:14px; font-weight:600; } .fcvote-q small { display:block; font-weight:400; font-size:12px; color:var(--mute); margin-top:2px; }",
  "  .fcvote-b { display:flex; gap:8px; flex-wrap:wrap; }",
  "  .fcvote-b button { display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding:8px 14px; font:700 13px/1 Inter,system-ui,sans-serif; border:1.5px solid #D9D4F2; background:#fff; color:var(--ink); cursor:pointer; }",
  "  .fcvote-b button svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }",
  "  .fcvote-b button.on { background:var(--indigo); border-color:var(--indigo); color:#fff; } .fcvote-b button[disabled] { opacity:.6; cursor:wait; }",
  "  .fcvote-done { flex-basis:100%; font-size:13px; color:var(--ink); }",
];

module.exports = { VOTE_CONNECT, VOTE_CSS, cspAllowVotes, voteKey, voteWidgetHtml };
