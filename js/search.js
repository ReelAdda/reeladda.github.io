/* FilmyChill search — films, series and people in the reader's edition.
 *
 * Runs entirely in the browser over /search/<code>.json (written each build by
 * scripts/lib/search.js), fetched the first time the search box opens. The edition comes from
 * the address: /us/... searches the US edition, anything without a country prefix searches India.
 * Places its own button: in the purple top bar on most pages, under the homepage header,
 * above the first heading elsewhere. Open with the button or the "/" key; Esc closes.
 */
(function () {
  "use strict";
  if (!window.fetch || !document.querySelector || window.__fcSearch) return;
  window.__fcSearch = true;

  var COUNTRY = { "in": "India", us: "the US", uk: "the UK", au: "Australia", de: "Germany", ae: "the UAE",
    ca: "Canada", sg: "Singapore", my: "Malaysia", ph: "the Philippines", nz: "New Zealand", kr: "South Korea",
    jp: "Japan", id: "Indonesia", br: "Brazil", mx: "Mexico", es: "Spain", fr: "France" };
  var seg = (location.pathname.match(/^\/([a-z]{2})\//) || [])[1];
  var code = seg && COUNTRY[seg] ? seg : "in";
  var base = code === "in" ? "" : "/" + code;
  var MAX = 20;

  var CSS = ""
    + ".fcs-btn{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.12);color:#FFF7EC;border:1px solid rgba(255,255,255,.25);border-radius:999px;padding:5px 11px;margin:-5px 0;font:600 13px/1 system-ui,-apple-system,'Segoe UI',sans-serif;cursor:pointer}"
    // Pages without the purple bar: a floating button in the top-right corner. It takes no space,
    // so nothing on the page moves when it appears.
    + ".fcs-btn.fcs-float{position:absolute;top:12px;right:12px;z-index:50;margin:0;min-height:44px;min-width:44px;justify-content:center;background:#4038C7;color:#fff;border-color:#4038C7;padding:8px 13px;box-shadow:0 4px 14px rgba(64,56,199,.25)}"
    + ".fcs-btn.fcs-float:hover,.fcs-btn.fcs-float:focus-visible{background:#2F28A8}"
    + ".fcs-btn:hover,.fcs-btn:focus-visible{background:rgba(255,255,255,.22)}"
    + ".fcs-btn svg,.fcs-field svg{width:16px;height:16px;flex:none}"
    + ".fcs-top{display:flex;align-items:center;justify-content:space-between;gap:12px}"
    + ".fcs-field{display:flex;align-items:center;gap:10px;width:100%;max-width:520px;margin:14px auto 4px;box-sizing:border-box;background:#fff;color:#6B6890;border:1.5px solid #E7DFD0;border-radius:12px;padding:11px 14px;font:15px/1.2 system-ui,-apple-system,'Segoe UI',sans-serif;text-align:left;cursor:text}"
    + ".fcs-field:hover,.fcs-field:focus-visible{border-color:#4038C7}"
    + ".fcs-ov{position:fixed;inset:0;z-index:1000;background:rgba(26,22,51,.55);display:flex;justify-content:center;align-items:flex-start;padding:max(6vh,env(safe-area-inset-top)) 12px 12px}"
    + ".fcs-ov[hidden]{display:none}"
    + ".fcs-panel{width:100%;max-width:560px;max-height:84vh;display:flex;flex-direction:column;background:#FFF7EC;color:#1A1633;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.3);overflow:hidden;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}"
    + ".fcs-bar{display:flex;align-items:center;gap:8px;padding:12px;border-bottom:1px solid #E7DFD0;background:#fff}"
    + ".fcs-bar svg{width:18px;height:18px;color:#6B6890;flex:none;margin-left:4px}"
    + ".fcs-in{flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:17px;color:#1A1633;padding:6px 2px}"
    + ".fcs-in::-webkit-search-cancel-button{display:none}"
    + ".fcs-x{border:0;background:#F4F1EA;color:#5A5470;border-radius:8px;padding:7px 10px;font-size:13px;font-weight:600;cursor:pointer}"
    + ".fcs-list{list-style:none;margin:0;padding:6px;overflow-y:auto}"
    + ".fcs-list a{display:block;padding:10px 12px;border-radius:10px;color:#1A1633;text-decoration:none}"
    + ".fcs-list a b{display:block;font-size:15px;font-weight:700;line-height:1.3}"
    + ".fcs-list a small{display:block;font-size:12.5px;color:#6B6890;margin-top:2px}"
    + ".fcs-list a.on,.fcs-list a:hover{background:#ECE8FB}"
    + ".fcs-msg{padding:16px;font-size:14px;color:#5A5470;line-height:1.5}"
    + ".fcs-msg a{color:#4038C7;font-weight:600}"
    + "@media (max-width:380px){.fcs-btn span{display:none}}"
    + "@media (max-width:520px){.fcs-btn.fcs-float span{display:none}.fcs-btn.fcs-float{padding:9px}}";
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>';

  // Lower case, accents off, punctuation to spaces: "Amélie" and "amelie" match, as do
  // "Spider-Man" and "spider man".
  function norm(s) {
    s = String(s).toLowerCase();
    if (s.normalize) s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
    return s.replace(/&/g, " and ").replace(/['’`.]/g, "").replace(/[^0-9a-z\u0080-￿]+/g, " ").trim();
  }

  var items = null, loading = null;
  function load() {
    if (loading) return loading;
    loading = fetch("/search/" + code + ".json").then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (d) {
      items = [];
      (d.films || []).forEach(function (f) {
        var n = norm(f[0]);
        items.push({ t: f[0], u: base + "/movie/" + f[1] + ".html", y: f[2], tv: f[3], l: f[4], v: f[5], n: n, w: n.split(" ") });
      });
      (d.people || []).forEach(function (p) {
        var n = norm(p[0]);
        items.push({ t: p[0], u: base + "/people/" + p[1] + "/", p: 1, n: n, w: n.split(" ") });
      });
      return items;
    });
    loading.catch(function () { loading = null; });
    return loading;
  }

  // Edit distance, for short words only.
  function dist(a, b) {
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  // The typed word is one slip (wrong, missing or extra letter) from the start of a title word.
  // Only for words of four letters or more: shorter ones match too much.
  function near(a, w) {
    if (a.length < 4) return false;
    if (w.indexOf(a) === 0) return true;
    for (var n = a.length - 1; n <= a.length + 1; n++) if (n <= w.length && dist(a, w.slice(0, n)) <= 1) return true;
    return false;
  }

  function score(it, q, toks, fuzzy) {
    if (it.n === q) return 100;
    if (it.n.indexOf(q) === 0) return 80;
    var all = true, k, j, hit;
    for (k = 0; k < toks.length && all; k++) {
      hit = /^\d{4}$/.test(toks[k]) && it.y === Number(toks[k]);
      for (j = 0; j < it.w.length && !hit; j++) hit = it.w[j].indexOf(toks[k]) === 0;
      all = hit;
    }
    if (all) return it.w[0].indexOf(toks[0]) === 0 ? 65 : 60;
    // Spaces ignored, from the start of a word: "spiderman" finds Spider-Man, "kgf" K.G.F, but
    // "leo" doesn't find "Tale of".
    var cq = q.replace(/ /g, "");
    if (cq.length >= 3) for (j = 0; j < it.w.length; j++) if (it.w.slice(j).join("").indexOf(cq) === 0) return 45;
    if (!fuzzy) return 0;
    // Every typed word near some title word; closer to the start of the title ranks higher,
    // so "rajni" puts Rajinikanth above Rocky Aur Rani.
    var at = 0;
    for (k = 0, all = true; k < toks.length && all; k++) {
      hit = -1;
      for (j = 0; j < it.w.length && hit < 0; j++) if (it.w[j].indexOf(toks[k]) === 0 || near(toks[k], it.w[j])) hit = j;
      all = hit >= 0;
      at += Math.max(hit, 0);
    }
    return all ? 20 - Math.min(at, 5) * 2 : 0;
  }

  function find(query) {
    var q = norm(query);
    if (!q || !items) return [];
    var toks = q.split(" "), out = [];
    for (var pass = 0; pass < 2 && !out.length; pass++) {
      for (var i = 0; i < items.length; i++) {
        var s = score(items[i], q, toks, pass === 1);
        if (s) out.push({ it: items[i], s: s + (items[i].v ? 0.5 : 0) - (items[i].p ? 0.25 : 0) + (items[i].y || 0) / 1e5 });
      }
    }
    out.sort(function (a, b) { return b.s - a.s || (a.it.t < b.it.t ? -1 : 1); });
    return out.slice(0, MAX).map(function (o) { return o.it; });
  }

  var VERDICT = { M: "Must watch", W: "Worth a watch", S: "Skip" };
  function meta(it) {
    if (it.p) return "Actor or film-maker";
    var bits = [];
    if (it.y) bits.push(it.y);
    bits.push((it.l ? it.l + " " : "") + (it.tv ? "series" : "film"));
    if (it.v) bits.push(VERDICT[it.v]);
    return bits.join(" · ");
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }

  // ---- the panel ------------------------------------------------------------------------
  var ov, input, list, msg, opener, active = -1, shown = [];
  function build() {
    ov =document.createElement("div");
    ov.className = "fcs-ov";
    ov.hidden = true;
    ov.innerHTML = '<div class="fcs-panel" role="dialog" aria-modal="true" aria-label="Search FilmyChill">'
      + '<div class="fcs-bar">' + ICON
      + '<input class="fcs-in" type="search" autocomplete="off" spellcheck="false" enterkeyhint="go" role="combobox" aria-expanded="true" aria-controls="fcs-list" aria-autocomplete="list" placeholder="Films, series or people in ' + esc(COUNTRY[code]) + '" aria-label="Search films, series and people">'
      + '<button class="fcs-x" type="button">Close</button></div>'
      + '<div class="fcs-msg" aria-live="polite"></div>'
      + '<ul class="fcs-list" id="fcs-list" role="listbox" aria-label="Results"></ul></div>';
    document.body.appendChild(ov);
    input = ov.querySelector(".fcs-in");
    list = ov.querySelector(".fcs-list");
    msg = ov.querySelector(".fcs-msg");
    ov.querySelector(".fcs-x").addEventListener("click", close);
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    input.addEventListener("input", render);
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!shown.length) return;
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
        mark();
      } else if (e.key === "Enter") {
        var a = list.querySelectorAll("a")[active < 0 ? 0 : active];
        if (a) { e.preventDefault(); location.href = a.href; }
      }
    });
    ov.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Tab") {   // keep focus inside the dialog
        var f = ov.querySelectorAll("input,button,a[href]");
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }

  function mark() {
    var links = list.querySelectorAll("a");
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle("on", i === active);
      links[i].setAttribute("aria-selected", i === active ? "true" : "false");
    }
    if (links[active]) {
      input.setAttribute("aria-activedescendant", links[active].id);
      links[active].scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function render() {
    var q = input.value;
    list.innerHTML = "";
    shown = [];
    active = -1;
    input.removeAttribute("aria-activedescendant");
    if (!norm(q)) { msg.textContent = "Type a film, series or person."; msg.hidden = false; return; }
    if (!items) { msg.textContent = "Loading…"; msg.hidden = false; return; }
    shown = find(q);
    if (!shown.length) {
      msg.innerHTML = "Nothing matches “" + esc(q.trim()) + "” in " + esc(COUNTRY[code]) + ". Try fewer letters, or <a href=\"" + base + "/films/\">browse every film we've covered</a>.";
      msg.hidden = false;
      return;
    }
    msg.textContent = shown.length === 1 ? "1 result" : (shown.length >= MAX ? "Top " + MAX + " results" : shown.length + " results");
    msg.hidden = true;
    var html = "";
    for (var i = 0; i < shown.length; i++) {
      html += '<li role="presentation"><a id="fcs-o' + i + '" role="option" aria-selected="false" href="' + esc(shown[i].u) + '"><b>' + esc(shown[i].t) + "</b><small>" + esc(meta(shown[i])) + "</small></a></li>";
    }
    list.innerHTML = html;
  }

  function open() {
    if (!ov) build();
    opener = document.activeElement;
    ov.hidden = false;
    document.documentElement.style.overflow = "hidden";
    input.focus();
    input.select();
    render();
    load().then(function () { if (!ov.hidden) render(); }, function () {
      msg.textContent = "Search isn't available right now. Please try again in a moment.";
      msg.hidden = false;
    });
  }
  function close() {
    ov.hidden = true;
    document.documentElement.style.overflow = "";
    if (opener && opener.focus) opener.focus();
  }

  // ---- the button -------------------------------------------------------------------------
  function place() {
    var style = document.createElement("style");
    style.textContent = CSS;
    var btn = document.createElement("button");
    btn.type = "button";
    var top = document.querySelector("body > .top");
    var header = document.querySelector("body > header");
    var logo = document.querySelector("body > .box > .logo");
    btn.setAttribute("aria-label", "Search films, series and people");
    if (top) {                       // most pages: in the purple bar, within its height
      btn.className = "fcs-btn";
      btn.innerHTML = ICON + "<span>Search</span>";
      top.classList.add("fcs-top");
      top.appendChild(btn);
    } else if (logo && !header) {    // 404: a full search field, the page's way back in
      btn.className = "fcs-field";
      btn.innerHTML = ICON + "<span>Search films, series or people…</span>";
      logo.parentNode.insertBefore(btn, logo.nextSibling);
    } else {                         // homepage, browse pages: floating, top right
      btn.className = "fcs-btn fcs-float";
      btn.innerHTML = ICON + "<span>Search</span>";
      document.body.appendChild(btn);
    }
    document.head.appendChild(style);
    btn.addEventListener("click", open);
    // Start the download as soon as a reader shows intent, so results are ready on open.
    btn.addEventListener("pointerenter", load, { once: true });
    btn.addEventListener("focus", load, { once: true });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target, tag = t && t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
      if (ov && !ov.hidden) return;
      e.preventDefault();
      open();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", place);
  else place();
})();
