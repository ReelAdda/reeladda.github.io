/* FilmyChill votes — "Watched it? Was it worth it?"
 *
 * Talks to Firebase's REST endpoints directly (no SDK download): an anonymous identity from
 * Identity Toolkit, then one Firestore document per person per film, votes/<film>__<uid>.
 * firestore.rules decides what may be written; nothing here can read anyone's votes.
 * The public config below is meant to be public — access is governed by the rules.
 */
(function () {
  "use strict";
  var API_KEY = "AIzaSyBtwIPmt1uONvkZ8pmnhcZK6E6pRjd3yk0";
  var PROJECT = "filmychill-ca2b3";

  var box = document.querySelector(".fcvote");
  if (!box || !window.fetch || !window.JSON) return;
  var film = box.getAttribute("data-film") || "";
  var country = box.getAttribute("data-c") || "in";
  if (!/^(movie|tv)-\d{1,9}$/.test(film) || !/^[a-z]{2}$/.test(country)) return;

  var buttons = box.querySelectorAll("button[data-v]");
  var done = box.querySelector(".fcvote-done");
  var KEY = "fcvote:" + film, AUTH = "fcvote:auth";
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  function show(v, msg) {
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute("data-v") === String(v);
      buttons[i].classList.toggle("on", on);
      buttons[i].setAttribute("aria-pressed", on ? "true" : "false");
      buttons[i].disabled = false;
    }
    done.hidden = false;
    done.textContent = msg || ("Thanks — you said " + (String(v) === "1" ? "worth it" : "not worth it") + ". Tap again to change.");
  }

  function post(url, body, headers, form) {
    return fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" }, headers || {}),
      body: form ? body : JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j.error && j.error.message) || r.status); return j; }); });
  }

  // Anonymous identity, kept in this browser: signed up once, refreshed when the token expires.
  function identity() {
    var saved = null;
    try { saved = JSON.parse(store.get(AUTH) || "null"); } catch (e) {}
    if (saved && saved.idToken && saved.exp > Date.now() + 60000) return Promise.resolve(saved);
    var keep = function (id, rt, uid, secs) {
      var a = { idToken: id, rt: rt, uid: uid, exp: Date.now() + Number(secs || 3600) * 1000 };
      store.set(AUTH, JSON.stringify(a));
      return a;
    };
    if (saved && saved.rt) {
      return post("https://securetoken.googleapis.com/v1/token?key=" + API_KEY,
        "grant_type=refresh_token&refresh_token=" + encodeURIComponent(saved.rt), null, true)
        .then(function (j) { return keep(j.id_token, j.refresh_token, j.user_id, j.expires_in); });
    }
    return post("https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + API_KEY, { returnSecureToken: true })
      .then(function (j) { return keep(j.idToken, j.refreshToken, j.localId, j.expiresIn); });
  }

  function vote(v) {
    return identity().then(function (a) {
      var name = "projects/" + PROJECT + "/databases/(default)/documents/votes/" + film + "__" + a.uid;
      return post("https://firestore.googleapis.com/v1/projects/" + PROJECT + "/databases/(default)/documents:commit", {
        writes: [{
          update: { name: name, fields: { film: { stringValue: film }, v: { integerValue: String(v) }, c: { stringValue: country } } },
          updateTransforms: [{ fieldPath: "t", setToServerValue: "REQUEST_TIME" }]
        }]
      }, { Authorization: "Bearer " + a.idToken });
    });
  }

  box.hidden = false;
  var prev = store.get(KEY);
  if (prev === "1" || prev === "-1") show(prev);

  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function (ev) {
      var v = ev.currentTarget.getAttribute("data-v");
      if (v === store.get(KEY)) return;
      for (var j = 0; j < buttons.length; j++) buttons[j].disabled = true;
      vote(Number(v)).then(function () {
        store.set(KEY, v);
        show(v);
      }).catch(function () {
        var was = store.get(KEY);
        show(was || "", "Couldn't save your vote just now — please try again.");
        if (!was) for (var k = 0; k < buttons.length; k++) buttons[k].classList.remove("on");
      });
    });
  }
})();
