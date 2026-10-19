"use strict";
// Mediavine Grow (grow.me): bookmarks, recommendations and email sign-up. Loaded from a site file
// rather than Grow's inline snippet (the pages' security policy refuses inline scripts), and only
// once the page has loaded and the browser is idle, so it never competes with the first paint.
// The page's policy allows exactly Grow's origins (scripts/lib/grow.js); the build adds this
// file to every page and can take it off again in one setting (GROW_SITE_ID="").
(function () {
  var SITE_ID = "U2l0ZToxZTkwZjRlNS1kNTZiLTQ1M2UtOTA4Yy00NmYxNmIyNTZhOWE=";
  var started = false;
  function start() {
    if (started) return;
    started = true;
    window.growMe || ((window.growMe = function (e) { window.growMe._.push(e); }), (window.growMe._ = []));
    var s = document.createElement("script");
    s.src = "https://faves.grow.me/main.js";
    s.defer = true;
    s.setAttribute("data-grow-faves-site-id", SITE_ID);
    document.head.appendChild(s);
  }
  function whenIdle() {
    if (window.requestIdleCallback) window.requestIdleCallback(start, { timeout: 4000 });
    else setTimeout(start, 1500);
  }
  if (document.readyState === "complete") whenIdle();
  else window.addEventListener("load", whenIdle, { once: true });
})();
