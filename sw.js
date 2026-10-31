/* FilmyChill service worker (28 Oct 2026).
 *
 * What it does, and only this:
 *   - Pages (navigations): network first, so a visitor always gets the latest build; the last
 *     copy from the cache when the network fails; the offline page when there is no copy.
 *   - This week's data files (/data*.json): network first, cache fallback, keyed without the
 *     cache-busting query the homepage adds.
 *   - Stylesheets, scripts, fonts, icons: stale-while-revalidate (instant, refreshed behind).
 *   - TMDB posters and backdrops: cache first, capped, so a saved list opens offline.
 * Everything else (analytics, YouTube, Firestore votes) passes straight through and is never
 * cached. No push, no background sync, nothing that runs when the site isn't open.
 *
 * Pages are rebuilt twice a day; the network-first rule keeps "Page updated" honest. CACHE is
 * bumped by hand when the rules here change, which drops every old cache on activate.
 */
"use strict";
const CACHE = "fc-2026-10-28";
const SHELL = ["/", "/offline/", "/manifest.json", "/icon-192.png", "/fonts/anton-latin.woff2"];
const IMG_MAX = 160;          // posters kept
const NET_TIMEOUT_MS = 4000;  // a page waits this long for the network before the cache answers

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const sameOrigin = (u) => u.origin === self.location.origin;
const isStatic = (u) => sameOrigin(u) && /^\/(?:css|js|fonts)\/|^\/icon-\d+\.png$|^\/manifest\.json$/.test(u.pathname);
const isData = (u) => sameOrigin(u) && /^\/data(?:-[a-z]{2})?\.json$/.test(u.pathname);
const isPoster = (u) => u.hostname === "image.tmdb.org";

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("timeout")), ms); p.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); }); });
}
async function networkFirst(req, key, { timeout = NET_TIMEOUT_MS, fallback = null } = {}) {
  const cache = await caches.open(CACHE);
  try {
    const res = await withTimeout(fetch(req), timeout);
    if (res && res.ok) cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    if (fallback) { const f = await cache.match(fallback); if (f) return f; }
    throw err;
  }
}
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const refresh = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || refresh.then((r) => r || Response.error());
}
async function cacheFirstCapped(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === "opaque")) {
    cache.put(req, res.clone());
    // Oldest first out: keys() returns insertion order.
    const keys = (await cache.keys()).filter((k) => isPoster(new URL(k.url)));
    for (const k of keys.slice(0, Math.max(0, keys.length - IMG_MAX))) await cache.delete(k);
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    if (!sameOrigin(url)) return;
    e.respondWith(networkFirst(req, new Request(url.origin + url.pathname), { fallback: "/offline/" }));
    return;
  }
  if (isData(url)) { e.respondWith(networkFirst(req, new Request(url.origin + url.pathname), { timeout: 6000 })); return; }
  if (isStatic(url)) { e.respondWith(staleWhileRevalidate(req)); return; }
  if (isPoster(url)) { e.respondWith(cacheFirstCapped(req)); return; }
});
