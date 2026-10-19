// ============================================================================
// ga.js — Google Analytics 4 on every page, in place of GoatCounter (Oct 2026).
//
// The tag is Google's: gtag.js from www.googletagmanager.com, plus the setup script, in each
// page's <head>. The setup script is inline, so the page's policy allows it by its SHA-256 hash —
// the browser runs exactly that code and still refuses every other inline script. Applied in one
// pass after the last page writer (addGaToPages), like Grow (lib/grow.js), so rebuilt, frozen and
// hand-written pages all carry it; the same pass removes GoatCounter's tag and sources.
//
// Privacy settings, set in the setup script before any measurement:
//   - Consent Mode by region: in the EEA, the UK and Switzerland analytics storage is denied, so
//     Google Analytics runs there without cookies (anonymous, cookieless pings); elsewhere it is
//     granted. Google applies the region list from each visitor's location.
//   - Advertising storage, ad user data and ad personalisation are denied everywhere, and Google
//     signals and ad-personalisation signals are off: the site measures visits, nothing more.
// The Privacy and About pages say exactly this (a test keeps them in step).
//
// Sources, from Google's Content-Security-Policy guidance for GA4: scripts from
// www.googletagmanager.com; measurement requests to *.google-analytics.com,
// *.analytics.google.com and *.googletagmanager.com (regional endpoints vary, hence the wildcards
// Google prescribes); its fallback pixels from the same hosts.
//
// Kill switch: GA_ID="" in the workflow strips the tag and the sources from every page on the
// next build.
// ============================================================================
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { mapPolicy, placeInHead, removeTag, withSources } = require("./csp.js");

const GA_ID = process.env.GA_ID === undefined ? "G-FX2MXM2DR0" : String(process.env.GA_ID).trim();
const GA_ON = !!GA_ID;
// EEA (EU + Iceland, Liechtenstein, Norway), the UK and Switzerland.
const CONSENT_REGIONS = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU",
  "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO", "GB", "CH"];
const ADS_OFF = 'ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied"';
const GA_CODE = "window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}"
  + `gtag("consent","default",{${ADS_OFF},analytics_storage:"denied",region:${JSON.stringify(CONSENT_REGIONS)}});`
  + `gtag("consent","default",{${ADS_OFF},analytics_storage:"granted"});`
  + 'gtag("js",new Date());'
  + `gtag("config","${GA_ID}",{allow_google_signals:false,allow_ad_personalization_signals:false});`;
const GA_TAG = `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>\n<script>${GA_CODE}</script>`;
const GA_HASH = `'sha256-${crypto.createHash("sha256").update(GA_CODE, "utf8").digest("base64")}'`;
const GA_SOURCES = {
  "script-src": [GA_HASH, "https://www.googletagmanager.com"],
  "connect-src": ["https://*.google-analytics.com", "https://*.analytics.google.com", "https://*.googletagmanager.com"],
  "img-src": ["https://*.google-analytics.com", "https://*.googletagmanager.com"],
};

// GoatCounter, which GA replaces: its tag and every source it was allowed.
function withoutGoatCounter(html) {
  let s = String(html).replace(/<script data-goatcounter="[^"]*"[^>]*><\/script>\n?/g, "");
  s = mapPolicy(s, (p) => p.replace(/ https:\/\/gc\.zgo\.at/g, "").replace(/ https:\/\/[a-z0-9-]+\.goatcounter\.com/g, ""));
  return s;
}

// Pure: one page with GA on (tag in <head> + sources) or off (neither); GoatCounter removed either
// way. Idempotent.
function ensureGa(html, on = GA_ON) {
  let s = withoutGoatCounter(html);
  s = mapPolicy(s, (p) => withSources(p, GA_SOURCES, on));
  return on ? placeInHead(s, GA_TAG) : removeTag(s, GA_TAG);
}

// The pass over every page, after the last page writer of the run. The embed widget renders
// inside other people's sites and post.html is a hand-kept draft: both are skipped.
function addGaToPages(files, { root = ".", on = GA_ON } = {}) {
  const res = { pages: 0, changed: 0 };
  for (const rel of files) {
    const r = String(rel).replace(/\\/g, "/");
    if (/(?:^|\/)embed\//.test(r) || r === "post.html") continue;
    const file = path.join(root, rel);
    let html;
    try { html = fs.readFileSync(file, "utf8"); } catch { continue; }
    res.pages++;
    const next = ensureGa(html, on);
    if (next !== html) { fs.writeFileSync(file, next); res.changed++; }
  }
  return res;
}

module.exports = { CONSENT_REGIONS, GA_CODE, GA_HASH, GA_ID, GA_ON, GA_SOURCES, GA_TAG, addGaToPages, ensureGa, withoutGoatCounter };
