// "Tell me when it's streaming" on a film page that is waiting for streaming (10 Nov 2026).
// The button sits in the page's OTT section, so it goes when the film arrives and the section is
// replaced. It uses the arrival alerts the homepage already offers (js/app.js, scripts/lib/
// alerts.js): the film joins this browser's My List, and the alert record in Firestore
// (alerts/<anonymous uid>) is written with every saved film, exactly as the homepage writes it,
// so saving here never drops a film saved there. The daily build sends the one ping.
// Shown only where web push works; the page reads fully without it.
(function () {
  "use strict";
  var box = document.querySelector(".fcalert");
  if (!box) return;
  var KEY = box.getAttribute("data-key") || "";
  var btn = box.querySelector("button"), status = box.querySelector("[role=status]");
  if (!/^[A-Za-z0-9_-]{86,88}$/.test(KEY) || !btn || !window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  if (Notification.permission === "denied") return;

  var FB_KEY = "AIzaSyBtwIPmt1uONvkZ8pmnhcZK6E6pRjd3yk0", FB_PROJECT = "filmychill-ca2b3";
  var COMMIT = "https://firestore.googleapis.com/v1/projects/" + FB_PROJECT + "/databases/(default)/documents:commit";
  var film = box.getAttribute("data-film") || "";
  var m = /^(movie|tv)-(\d{1,9})$/.exec(film);
  if (!m) return;
  var item = { tmdbId: Number(m[2]), kind: m[1], title: box.getAttribute("data-title") || "", slug: box.getAttribute("data-slug") || "",
    poster: box.getAttribute("data-poster") || "", language: box.getAttribute("data-lang") || "" };
  var today = function () { return new Date().toISOString().slice(0, 10); };
  var get = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var set = function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } };
  var loadWL = function () { try { return JSON.parse(get("filmychill-wl") || get("reeladda-wl") || "[]"); } catch (e) { return []; } };
  var saved = function () { return loadWL().some(function (x) { return String(x.tmdbId) === String(item.tmdbId); }); };
  var say = function (msg) { if (status) status.textContent = msg; };
  var done = function () { btn.disabled = true; btn.textContent = box.getAttribute("data-on") || "Alert on"; };

  box.hidden = false;
  if (get("filmychill-alerts") === "on" && saved()) done();

  function post(url, body, headers, form) {
    return fetch(url, { method: "POST", headers: Object.assign({ "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" }, headers || {}), body: form ? body : JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j.error && j.error.message) || r.status); return j; }); });
  }
  // The same anonymous identity the vote button and the homepage use (fcvote:auth).
  function identity() {
    var a = null;
    try { a = JSON.parse(get("fcvote:auth") || "null"); } catch (e) { a = null; }
    if (a && a.idToken && a.exp > Date.now() + 60000) return Promise.resolve(a);
    var keep = function (id, rt, uid, secs) { var v = { idToken: id, rt: rt, uid: uid, exp: Date.now() + Number(secs || 3600) * 1000 }; set("fcvote:auth", JSON.stringify(v)); return v; };
    if (a && a.rt) return post("https://securetoken.googleapis.com/v1/token?key=" + FB_KEY, "grant_type=refresh_token&refresh_token=" + encodeURIComponent(a.rt), null, true)
      .then(function (j) { return keep(j.id_token, j.refresh_token, j.user_id, j.expires_in); });
    return post("https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + FB_KEY, { returnSecureToken: true })
      .then(function (j) { return keep(j.idToken, j.refreshToken, j.localId, j.expiresIn); });
  }
  function keyBytes(s) {
    var b = atob((s + "===".slice(0, (4 - s.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(b, function (c) { return c.charCodeAt(0); });
  }
  function subscription() {
    return navigator.serviceWorker.register("/sw.js").then(function () { return navigator.serviceWorker.ready; }).then(function (reg) {
      return reg.pushManager.getSubscription().then(function (s) {
        var want = keyBytes(KEY);
        var had = s && s.options && s.options.applicationServerKey ? new Uint8Array(s.options.applicationServerKey) : null;
        var same = !had || (had.length === want.length && had.every(function (x, i) { return x === want[i]; }));
        if (s && same) return s;
        return (s ? s.unsubscribe() : Promise.resolve()).then(function () { return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want }); });
      });
    });
  }
  // The films map as the homepage builds it (js/app.js alertFilms): every saved film with the day
  // it was saved, at most 199, plus the digest key when the digest is on.
  function films() {
    var since = get("filmychill-alerts-since") || today(), out = {}, n = 0;
    loadWL().forEach(function (it) {
      if (!/^\d{1,9}$/.test(String(it.tmdbId || "")) || n >= 199) return;
      out[(it.kind === "tv" ? "tv-" : "movie-") + it.tmdbId] = { stringValue: /^\d{4}-\d{2}-\d{2}$/.test(it.savedAt || "") ? it.savedAt : since };
      n++;
    });
    if (get("filmychill-digest") === "on") out.digest = { stringValue: get("filmychill-digest-since") || since };
    return out;
  }

  btn.addEventListener("click", function () {
    btn.disabled = true;
    Notification.requestPermission().then(function (p) {
      if (p !== "granted") { btn.disabled = false; say("Notifications are blocked for this site, so we can't send the alert."); return; }
      if (!saved()) { var wl = loadWL(); wl.push(Object.assign({}, item, { savedAt: today() })); set("filmychill-wl", JSON.stringify(wl)); }
      if (!get("filmychill-alerts-since")) set("filmychill-alerts-since", today());
      return subscription().then(function (sub) {
        return identity().then(function (a) {
          return post(COMMIT, { writes: [{
            update: { name: "projects/" + FB_PROJECT + "/databases/(default)/documents/alerts/" + a.uid,
              fields: { sub: { stringValue: JSON.stringify(sub.toJSON()) }, films: { mapValue: { fields: films() } }, c: { stringValue: box.getAttribute("data-c") || "in" } } },
            updateTransforms: [{ fieldPath: "t", setToServerValue: "REQUEST_TIME" }]
          }] }, { Authorization: "Bearer " + a.idToken });
        });
      }).then(function () {
        set("filmychill-alerts", "on");
        set("filmychill-alerts-sync", today());
        done();
        say(box.getAttribute("data-done") || "Done. One alert when it arrives, and it's in My List.");
      });
    }).catch(function () { btn.disabled = false; say("That didn't work just now. Try again in a minute."); });
  });
})();
