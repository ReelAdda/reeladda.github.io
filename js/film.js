// Film page behaviour (redesign v2, Oct 2026). Loaded only by v2 pages; everything here is
// optional polish over a page that reads fully without it. No network, no storage.
(function () {
  "use strict";
  var d = document;

  // Days until a date: the page says "in N days" as of its build; keep it right afterwards.
  function dayWord(iso) {
    var a = new Date(); var today = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    var n = Math.round((Date.parse(iso + "T00:00:00Z") - today) / 864e5);
    return n <= 0 ? "today" : n === 1 ? "tomorrow" : "in " + n + " days";
  }
  Array.prototype.forEach.call(d.querySelectorAll("[data-countdown]"), function (el) { el.textContent = dayWord(el.getAttribute("data-countdown")); });

  // Episode progress: width from 0 to its share (300ms, see the stylesheet).
  var bar = d.querySelector(".epbar i");
  if (bar) requestAnimationFrame(function () { bar.style.width = bar.getAttribute("data-pct") + "%"; });

  // Share: the native sheet where there is one, else the link is copied.
  var share = d.querySelector('[data-act="share"]');
  if (share) share.addEventListener("click", function () {
    var data = { title: share.getAttribute("data-title"), url: location.href.split("#")[0] };
    if (navigator.share) { navigator.share(data).catch(function () {}); return; }
    var done = function () { share.textContent = "Link copied"; setTimeout(function () { share.textContent = "Share"; }, 2000); };
    if (navigator.clipboard) navigator.clipboard.writeText(data.url).then(done, done); else done();
  });

  // Remind me: a calendar file for the date the page shows (an all-day event — no time is known).
  var remind = d.querySelector('[data-act="remind"]');
  if (remind) remind.addEventListener("click", function () {
    var iso = remind.getAttribute("data-date").replace(/-/g, ""), title = remind.getAttribute("data-title");
    var next = new Date(Date.parse(remind.getAttribute("data-date") + "T00:00:00Z") + 864e5).toISOString().slice(0, 10).replace(/-/g, "");
    var ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//FilmyChill//EN", "BEGIN:VEVENT",
      "UID:" + iso + "-" + location.pathname.replace(/[^a-z0-9]/gi, "") + "@filmychill.com",
      "DTSTART;VALUE=DATE:" + iso, "DTEND;VALUE=DATE:" + next,
      "SUMMARY:" + title.replace(/[,;\\]/g, "\\$&") + " — out today",
      "URL:" + location.href.split("#")[0], "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    var a = d.createElement("a");
    a.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
    a.download = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".ics";
    d.body.appendChild(a); a.click(); a.remove();
  });

  // Trailer: the embed loads on tap, not with the page.
  var yt = d.querySelector(".frame.yt");
  if (yt) {
    var play = function () {
      var id = yt.getAttribute("data-yt");
      var f = d.createElement("iframe");
      f.src = "https://www.youtube-nocookie.com/embed/" + id + "?rel=0&autoplay=1";
      f.title = "Trailer"; f.allow = "autoplay; encrypted-media; picture-in-picture"; f.allowFullscreen = true;
      yt.innerHTML = ""; yt.appendChild(f); yt.classList.remove("yt");
    };
    yt.addEventListener("click", play);
    yt.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); play(); } });
  }

  // Sticky bar: on once the call to action has scrolled away, off while the footer shows.
  var sticky = d.getElementById("sticky"), cta = d.querySelector(".cta"), foot = d.querySelector("footer");
  if (sticky && cta && "IntersectionObserver" in window) {
    var ctaOut = false, footIn = false;
    var apply = function () { var on = ctaOut && !footIn; sticky.classList.toggle("on", on); sticky.setAttribute("aria-hidden", on ? "false" : "true"); d.body.classList.toggle("sticky-on", on); };
    new IntersectionObserver(function (es) { ctaOut = !es[0].isIntersecting && es[0].boundingClientRect.top < 0; apply(); }).observe(cta);
    if (foot) new IntersectionObserver(function (es) { footIn = es[0].isIntersecting; apply(); }).observe(foot);
  }
})();
