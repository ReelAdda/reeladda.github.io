// ============================================================================
// csp.js — adding a third party's sources to a page's Content-Security-Policy, and taking them
// out again. Shared by the third-party passes (lib/grow.js, lib/ga.js): each lists exactly the
// sources its script needs, and nothing else on the page's policy changes.
// ============================================================================
"use strict";

function parsePolicy(policy) {
  return String(policy).split(";").map((p) => p.trim()).filter(Boolean)
    .map((p) => { const [name, ...vals] = p.split(/\s+/); return [name, vals]; });
}
const serialize = (dirs) => dirs.map(([n, v]) => [n, ...v].join(" ")).join("; ");

// Pure: the policy with the given sources ({ directive: [source, ...] }) added (on) or taken out
// (off). A directive the page doesn't have starts from its default-src, so adding never loosens
// anything else.
function withSources(policy, sources, on) {
  const dirs = parsePolicy(policy);
  const def = (dirs.find(([n]) => n === "default-src") || [null, ["'self'"]])[1];
  for (const [name, srcs] of Object.entries(sources)) {
    let d = dirs.find(([n]) => n === name);
    if (on) {
      if (!d) { d = [name, def.filter((x) => x !== "'none'")]; dirs.push(d); }
      for (const s of srcs) if (!d[1].includes(s)) d[1].push(s);
    } else if (d) {
      d[1] = d[1].filter((x) => !srcs.includes(x));
    }
  }
  return serialize(dirs);
}

const CSP_RE = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(">)/;

// Pure: a page with its policy passed through fn; unchanged when it has no policy.
function mapPolicy(html, fn) {
  const m = CSP_RE.exec(html);
  return m ? html.replace(m[0], m[1] + fn(m[2]) + m[3]) : html;
}

// Pure: a tag placed in <head> (after the policy meta, which must come first to apply to it), or
// before </body> on a page without one. Idempotent.
function placeInHead(html, tag) {
  if (html.includes(tag)) return html;
  const at = html.indexOf("</head>");
  if (at >= 0) return html.slice(0, at) + tag + "\n" + html.slice(at);
  const body = html.lastIndexOf("</body>");
  return body >= 0 ? html.slice(0, body) + tag + "\n" + html.slice(body) : html;
}
const removeTag = (html, tag) => html.split(tag + "\n").join("").split(tag).join("");

module.exports = { mapPolicy, parsePolicy, placeInHead, removeTag, serialize, withSources };
