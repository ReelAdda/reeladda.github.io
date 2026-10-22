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
const SETUP = `gtag("consent","default",{${ADS_OFF},analytics_storage:"denied",region:${JSON.stringify(CONSENT_REGIONS)}});`
  + `gtag("consent","default",{${ADS_OFF},analytics_storage:"granted"});`
  + 'gtag("js",new Date());'
  + `gtag("config","${GA_ID}",{allow_google_signals:false,allow_ad_personalization_signals:false});`;
// Automated browsers aren't measured (Oct 2026). A cluster of sessions from one city with ~0s
// engagement was much of the property's traffic. Browsers driven by plain automation (Puppeteer,
// Playwright, Selenium as they come) set navigator.webdriver, and for them Google's script isn't
// loaded at all. Scrapers built to hide it still get through — nothing on the page can catch those
// reliably — and crawlers that don't run JavaScript never reached GA4 anyway. The setup script
// loads gtag.js itself, so one inline script does both.
// Second check, the cluster's own signature (GA4, Oct 2026): every session Windows + Chrome with a
// 1280×1200 screen, from Singapore — a window size set in a script, not a monitor anyone owns
// (screens are 1280×1024, 1920×1080, 1920×1200…). Skipped too, whether or not it sets webdriver.
// If the operator changes the size, GA4 shows a new single odd resolution; add it here.
const BOT_SCREENS = [[1280, 1200]];
const GA_GATE = "!navigator.webdriver&&!(/Windows/.test(navigator.userAgent)&&("
  + BOT_SCREENS.map(([w, h]) => `screen.width===${w}&&screen.height===${h}`).join("||") + "))";
const tagCode = (gate) => `if(${gate}){window.dataLayer=window.dataLayer||[];window.gtag=function(){dataLayer.push(arguments);};`
  + SETUP
  + `var s=document.createElement("script");s.async=true;s.src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}";document.head.appendChild(s);}`;
const GA_CODE = tagCode(GA_GATE);
const GA_TAG = `<script>${GA_CODE}</script>`;
const hashOf = (code) => `'sha256-${crypto.createHash("sha256").update(code, "utf8").digest("base64")}'`;
const GA_HASH = hashOf(GA_CODE);
// Every earlier version of the tag, as [tag, inline code]. ensureGa takes each off every page with
// its hash, so a page never carries two tags or still allows a script it no longer has. When the
// tag changes again, add the outgoing version here (a test checks the current one isn't listed).
//   1. Google's two-tag snippet as given (Oct 2026, before the automation check).
//   2. The automation check alone (Oct 2026, before the 1280×1200 check).
const OLD_GA_CODES = ["window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}" + SETUP, tagCode("!navigator.webdriver")];
const OLD_GA_TAGS = [`<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>\n<script>${OLD_GA_CODES[0]}</script>`, `<script>${OLD_GA_CODES[1]}</script>`];
const OLD_GA_HASHES = OLD_GA_CODES.map(hashOf);
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
  for (const t of OLD_GA_TAGS) s = removeTag(s, t);
  s = mapPolicy(s, (p) => withSources(withSources(p, { "script-src": OLD_GA_HASHES }, false), GA_SOURCES, on));
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

module.exports = { CONSENT_REGIONS, GA_CODE, GA_HASH, GA_ID, GA_ON, GA_SOURCES, GA_TAG, OLD_GA_HASHES, OLD_GA_TAGS, addGaToPages, ensureGa, withoutGoatCounter };
