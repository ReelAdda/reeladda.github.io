// The streaming finder (/streaming/, 13 Nov 2026; lib/evergreen.js writeStreamingFinder).
// Three menus (service, genre, language) over every title FilmyChill has confirmed streaming in
// this edition. The rows come from one data file, fetched on this page only, and are filtered
// here in the browser. Rows are drawn as the list pages draw them (same classes), in the order
// the build gave them: verdict first, then audience rank. The last choice is kept on this device.
(function () {
  "use strict";
  var box = document.getElementById("finder");
  if (!box) return;
  var $ = function (id) { return document.getElementById(id); };
  var sel = { svc: $("fSvc"), gen: $("fGen"), lang: $("fLang") };
  var rowsEl = $("fRows"), countEl = $("fCount"), whatEl = $("fWhat"), clearEl = $("fClear"), moreEl = $("fMore");
  if (!sel.svc || !sel.gen || !sel.lang || !rowsEl) return;
  var PAGE = 40, shown = PAGE, data = null;
  var base = box.getAttribute("data-base") || "";
  var LABEL = ["", "Skip", "Worth a watch", "Must watch", "Too early", "Not enough ratings", "Critics split", "Not out yet"];
  var LEVEL = ["early", "skip", "worth", "must", "early", "early", "early", "early"];
  var MARK = '<svg class="vmark" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="37" fill="none" stroke="currentColor" stroke-opacity=".3" stroke-width="13"/><circle cx="50" cy="50" r="37" fill="none" stroke="currentColor" stroke-width="13" stroke-linecap="round" stroke-dasharray="176 300" transform="rotate(38 50 50)"/><path d="M42 33 Q40 32 40 35 L40 65 Q40 68 42 67 L66 52.5 Q68 50 66 47.5 Z" fill="currentColor"/></svg>';
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var KEY = "filmychill-finder:" + (base || "/in");
  // The choice also sits in the address (#s=Netflix&g=Comedy&l=Hindi), so a filtered list can be
  // sent to someone; an address with a choice in it wins over the one kept on this device.
  var fromHash = function () {
    var out = {}, h = String(location.hash || "").replace(/^#/, "");
    if (!h) return null;
    h.split("&").forEach(function (kv) { var i = kv.indexOf("="); if (i > 0) { try { out[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, " ")); } catch (e) { /* a broken link: ignored */ } } });
    return (out.s || out.g || out.l) ? { svc: out.s || "", gen: out.g || "", lang: out.l || "" } : null;
  };
  var load = function () { var h = fromHash(); if (h) return h; try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } };
  var save = function () {
    var st = { svc: sel.svc.value, gen: sel.gen.value, lang: sel.lang.value };
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* storage blocked */ }
    var parts = [["s", st.svc], ["g", st.gen], ["l", st.lang]].filter(function (p) { return p[1]; }).map(function (p) { return p[0] + "=" + encodeURIComponent(p[1]); });
    try { history.replaceState(null, "", location.pathname + (parts.length ? "#" + parts.join("&") : "")); } catch (e) { /* not allowed here */ }
  };
  var has = function (select, v) { for (var i = 0; i < select.options.length; i++) if (select.options[i].value === v) return true; return false; };

  // One row: [slug, title, year, tv, language, genre, verdict, rating, poster, [service index]].
  function row(r, svcName) {
    var names = svcName ? [svcName] : r[9].slice(0, 2).map(function (i) { return data.services[i]; });
    var meta = [names.join(", "), r[5], r[4], r[2] || "", r[3] ? "Series" : "Film"].filter(Boolean).map(esc).join(" · ");
    var img = r[8] ? '<img src="https://image.tmdb.org/t/p/w185/' + esc(r[8]) + '" alt="' + esc(r[1]) + ' poster" width="92" height="138" loading="lazy">' : '<div class="nop"></div>';
    var pill = r[6] ? '<div class="rm"><span class="vpill vp-' + LEVEL[r[6]] + '">' + MARK + esc(LABEL[r[6]]) + "</span></div>" : "";
    var ring = r[7] ? '<div class="hring"><span class="hey">TMDB</span><div class="hd" style="--p:' + Math.round(r[7] * 10) + '%" role="img" aria-label="TMDB audience rating ' + r[7].toFixed(1) + ' out of 10"><span>' + r[7].toFixed(1) + "</span></div></div>" : "";
    return '<a class="row" href="' + base + "/movie/" + esc(r[0]) + '.html">' + img + '<div><div class="rt"><h3>' + esc(r[1]) + '</h3></div><div class="rm">' + meta + "</div>" + pill + "</div>" + ring + "</a>";
  }

  function draw() {
    if (!data) return;
    var s = sel.svc.value, g = sel.gen.value, l = sel.lang.value;
    var si = s ? data.services.indexOf(s) : -1;
    var list = data.rows.filter(function (r) {
      return (!s || r[9].indexOf(si) >= 0) && (!g || r[5] === g) && (!l || r[4] === l);
    });
    countEl.textContent = list.length.toLocaleString("en-IN") + (list.length === 1 ? " title" : " titles");
    var what = [s ? "on " + s : "on all services", g, l].filter(Boolean).join(" · ");
    whatEl.textContent = what;
    clearEl.hidden = !(s || g || l);
    rowsEl.innerHTML = list.length
      ? list.slice(0, shown).map(function (r) { return row(r, s); }).join("")
      : '<p class="rm">Nothing matches. Try one filter fewer.</p>';
    moreEl.hidden = list.length <= shown;
    if (!moreEl.hidden) moreEl.textContent = "Show more (" + (list.length - shown).toLocaleString("en-IN") + " left)";
  }
  function changed() { shown = PAGE; save(); draw(); }
  sel.svc.addEventListener("change", changed);
  sel.gen.addEventListener("change", changed);
  sel.lang.addEventListener("change", changed);
  clearEl.addEventListener("click", function () { sel.svc.value = ""; sel.gen.value = ""; sel.lang.value = ""; changed(); });
  moreEl.addEventListener("click", function () { shown += PAGE; draw(); });

  fetch(box.getAttribute("data-src")).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (j) {
    if (!j || !Array.isArray(j.rows) || !Array.isArray(j.services)) throw new Error("shape");
    data = j;
    var was = load();
    if (was.svc && has(sel.svc, was.svc)) sel.svc.value = was.svc;
    if (was.gen && has(sel.gen, was.gen)) sel.gen.value = was.gen;
    if (was.lang && has(sel.lang, was.lang)) sel.lang.value = was.lang;
    draw();
  }).catch(function () {
    rowsEl.innerHTML = '<p class="rm">The list didn&#39;t load. Refresh the page to try again, or use the service pages linked above.</p>';
  });
})();
