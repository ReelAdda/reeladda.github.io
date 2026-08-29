// ============================================================================
// embed.js — the weekly widget other sites embed.
//
// WHY THIS EXISTS: backlinks are the one thing the site can't generate for itself, because
// nobody links to a database. This gives another site a REASON to link — a compact
// "what's new on OTT this week" box they drop into their page once and never touch again,
// because it self-updates every time our build runs. Each embed is a dofollow link back to
// specific film pages, which is the kind that actually builds domain authority (unlike a
// nofollow Reddit/Product Hunt mention).
//
// Constraints that shape it:
//   - It renders INSIDE someone else's page, so it must be fully self-contained: inline CSS
//     scoped under one class, no external fonts, nothing that can fight the host's styles.
//   - It must be lightweight — a heavy widget gets removed. Text-only, no poster images
//     (which would also be studio IP on a third party's page).
//   - Every title links out with target=_blank, and the whole thing carries our name, so the
//     embed advertises FilmyChill on the host site.
// ============================================================================
"use strict";

const fs = require("fs");
const { escHtml, COUNTRY_PAGE_META, filmPageUrl } = require("./core.js");

// The films the widget shows: this week's top streaming picks for the market, freshest first,
// capped so the box stays small on someone else's page.
function embedItems(data, max = 6) {
  const ott = (data && data.ott) || [];
  const fresh = ott.filter((x) => !x.stillGood);
  const rest = ott.filter((x) => x.stillGood);
  return [...fresh, ...rest].filter((x) => x.slug && x.title).slice(0, max);
}

function embedRow(item, code) {
  const e = escHtml;
  const url = filmPageUrl(code, item.slug);
  const meta = [item.language, item.platform].filter(Boolean).join(" · ");
  // A verdict only when it's a real one — never "verdict soon" on a third party's site.
  const verdict = item.verdict && !/soon|enough ratings/i.test(item.verdict) ? item.verdict : "";
  const score = item.rating != null && item.votes && item.votes >= 10 ? Number(item.rating).toFixed(1) : "";
  return `<a class="fcw-row" href="${e(url)}" target="_blank" rel="noopener">
<span class="fcw-t">${e(item.title)}</span>
<span class="fcw-m">${e(meta)}${verdict ? ` — ${e(verdict)}` : ""}</span>
${score ? `<span class="fcw-s">${e(score)}</span>` : ""}
</a>`;
}

// The widget is served as a standalone HTML page meant to be loaded in an <iframe>. Scoped
// styles, brand colours inline, sized to sit in a sidebar.
function buildEmbedPage(data, cfg, updatedHuman) {
  const e = escHtml;
  const code = (cfg && cfg.code) || "in";
  const m = COUNTRY_PAGE_META[code] || { name: (cfg && cfg.name) || "India", path: `/${code}/` };
  const items = embedItems(data, 6);
  const home = `https://filmychill.com${m.path}`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>New on OTT this week in ${e(m.name)} — FilmyChill</title>
<meta name="robots" content="noindex">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; }
  .fcw { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 340px;
         background: #FFF7EC; border: 1px solid #EADFCE; border-radius: 12px; overflow: hidden;
         color: #241D52; }
  .fcw-h { display: flex; align-items: center; justify-content: space-between;
           padding: 11px 14px; background: #4038C7; }
  .fcw-h b { color: #fff; font-size: 15px; font-weight: 800; letter-spacing: .3px; }
  .fcw-h b i { color: #FFAD1F; font-style: normal; }
  .fcw-h span { color: #C9C5F0; font-size: 10px; text-transform: uppercase; letter-spacing: .6px; }
  .fcw-row { display: block; padding: 10px 14px; text-decoration: none; color: #241D52;
             border-top: 1px solid #EADFCE; transition: background .12s; }
  .fcw-row:first-of-type { border-top: none; }
  .fcw-row:hover { background: #fff; }
  .fcw-t { display: block; font-size: 14px; font-weight: 600; color: #4038C7; }
  .fcw-m { display: block; font-size: 12px; color: #837C9B; margin-top: 1px; }
  .fcw-s { float: right; margin-top: -30px; font-size: 13px; font-weight: 700; color: #FFAD1F; }
  .fcw-f { display: block; padding: 9px 14px; text-align: center; font-size: 11px;
           text-decoration: none; color: #837C9B; border-top: 1px solid #EADFCE; background: #fff; }
  .fcw-f b { color: #4038C7; }
</style></head><body>
<div class="fcw">
  <div class="fcw-h"><b>FILMY<i>CHILL</i></b><span>New on OTT · ${e(m.name)}</span></div>
  ${items.map((it) => embedRow(it, code)).join("\n")}
  <a class="fcw-f" href="${e(home)}" target="_blank" rel="noopener">Updated ${e(updatedHuman)} · see all on <b>filmychill.com</b> →</a>
</div>
</body></html>`;
}

// The copy-paste snippet we show people, plus a tiny explainer page at /embed/.
function buildEmbedInstructions() {
  const snippet = `<iframe src="https://filmychill.com/embed/week/" width="340" height="420" style="border:0;max-width:100%" loading="lazy" title="New on OTT this week — FilmyChill"></iframe>`;
  const e = escHtml;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Embed the weekly OTT widget — FilmyChill</title>
<meta name="description" content="Add a free, self-updating 'new on OTT this week' widget to your site. One line of code, updates itself every week.">
<link rel="canonical" href="https://filmychill.com/embed/">
<style>
  body { font-family: system-ui,-apple-system,sans-serif; max-width: 720px; margin: 0 auto;
         padding: 26px 18px 70px; background: #FFF7EC; color: #241D52; line-height: 1.65; }
  h1 { font-size: 26px; } code, pre { background: #fff; border: 1px solid #EADFCE; border-radius: 8px; }
  pre { padding: 14px; overflow-x: auto; font-size: 13px; margin: 16px 0; }
  .prev { margin: 22px 0; }
  a { color: #4038C7; } footer { margin-top: 34px; border-top: 1px solid #EADFCE; padding-top: 16px; font-size: 13px; color: #837C9B; }
</style></head><body>
  <h1>Put this week's OTT picks on your site</h1>
  <p>A compact, self-updating widget showing what's new on streaming in India each week. Paste
  one line of code — it refreshes on its own every week, no maintenance. Free to use; it links
  back to FilmyChill.</p>
  <pre>${e('<iframe src="https://filmychill.com/embed/week/" width="340" height="420" style="border:0;max-width:100%" loading="lazy" title="New on OTT this week — FilmyChill"></iframe>')}</pre>
  <h2>Preview</h2>
  <div class="prev">${e('<iframe src="/embed/week/" width="340" height="420" style="border:0" loading="lazy"></iframe>').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')}</div>
  <p style="font-size:14px;color:#837C9B;">Other countries: swap <code>/embed/week/</code> for
  <code>/us/embed/week/</code>, <code>/uk/embed/week/</code>, and so on.</p>
  <footer><a href="/">← FilmyChill</a></footer>
</body></html>`;
}

function writeEmbed(data, cfg, updatedHuman) {
  const code = (cfg && cfg.code) || "in";
  const dir = code === "in" ? "embed/week" : `${code}/embed/week`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/index.html`, buildEmbedPage(data, cfg, updatedHuman));
  if (code === "in") {
    fs.mkdirSync("embed", { recursive: true });
    fs.writeFileSync("embed/index.html", buildEmbedInstructions());
  }
}

module.exports = { buildEmbedPage, buildEmbedInstructions, embedItems, writeEmbed };
