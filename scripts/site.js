// FilmyChill — the built site lives on its own branch (Oct 2026).
//
// main holds code, data files and the homepage template. Every page the build generates lives
// only on the `site` branch: one commit with no parent, replaced on every build, which GitHub
// Pages serves. main's history used to grow by every new and rebuilt page (~16 MB a day in
// early October); now it grows only with code and data.
//
//   node scripts/site.js restore   bring the built pages from `site` into the working tree
//                                  (the build reads and patches the frozen pages, so it needs
//                                  them before it starts; run this locally too)
//   node scripts/site.js publish   commit main's tree plus the built pages as the new `site`
//                                  (the outgoing one is kept as `site-prev`)
//   node scripts/site.js rollback  put `site-prev` back as the live site
//
// Safety: `restore` refuses to continue if far fewer film pages arrive than the manifest
// knows about, so a broken branch can never be rebuilt into a site missing most of its pages.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

// Top-level paths the build generates. Everything else belongs to main.
const GENERATED = [
  /^(ae|au|br|ca|de|es|fr|id|jp|kr|mx|my|nz|ph|sg|uk|us)$/,   // edition folders
  /^movie$/, /^new-on-[a-z0-9-]+$/, /^(hindi|tamil|telugu|malayalam|kannada)$/,
  /^(week|films|data|embed|streaming|people|coming-to-ott|released-last-week|cards|css|search)$/,
  /^(feed\.xml|llms\.txt|llms-full\.txt|sitemap\.xml|sitemap-[a-z0-9-]+\.xml)$/,
];
const isGenerated = (name) => GENERATED.some((re) => re.test(name));
// Files on main that only the build uses: never published. The site fetches data*.json and
// search/ at runtime; nothing on the site reads these. facts/ alone was 23 MB of the 1 GB
// GitHub Pages allowance (Oct 2026), pages-manifest.json another 7 MB. CNAME, robots.txt,
// manifest.json (the web-app manifest) and the verification files stay published.
const MAIN_ONLY = [
  /^\.(github|gitignore|gitattributes|assetsignore)$/, /^(scripts|cloudflare|facts)$/,
  /^(pages-manifest|catalog-manifest|page-lastmods|ott-seen|ott-watch|takes|votes-agg|votes-state|merges|ott-census|ott-digital|facts-mode|search-top|rollout|google-hidden|site-health|hidden-urls|indexnow-hidden)\.json$/,
  /^(ott-history|accuracy-history)\.jsonl$/, /^accuracy-latest\.json$/, /^(firestore\.rules|wrangler\.jsonc|package\.json|package-lock\.json|MIGRATION-STEPS\.md)$/,
];
const isMainOnly = (name) => MAIN_ONLY.some((re) => re.test(name));
const BRANCH = "site";
// The site published before this one (review, Oct 2026): each publish replaced the branch with
// no parent, so a bad build could not be undone. `rollback` puts it back; `restore` falls back
// to it when the current branch is missing most of its pages.
const PREV = "site-prev";
const MIN_SHARE = 0.9;   // of the manifest's film pages that must arrive on restore

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30, ...opts }).trim();

function siteRef(branch = BRANCH) {
  // Quiet: a branch that doesn't exist yet (state, before its first publish) is not an error.
  const quiet = { stdio: ["ignore", "pipe", "pipe"] };
  try { git(["fetch", "--quiet", "--depth=1", "origin", `${branch}:refs/remotes/origin/${branch}`], quiet); } catch { /* offline: use what we have */ }
  try { git(["rev-parse", "--verify", `refs/remotes/origin/${branch}`], quiet); return `refs/remotes/origin/${branch}`; } catch { return null; }
}

function expectedFilmPages() {
  try {
    const m = JSON.parse(fs.readFileSync("pages-manifest.json", "utf8"));
    return Object.values(m).reduce((n, c) => n + Object.keys(c || {}).length, 0);
  } catch { return 0; }
}
function filmPagesOnDisk() {
  let n = 0;
  for (const d of fs.readdirSync(".")) {
    const dir = d === "movie" ? "movie" : /^[a-z]{2}$/.test(d) ? `${d}/movie` : null;
    if (!dir || !fs.existsSync(dir)) continue;
    n += fs.readdirSync(dir).filter((f) => f.endsWith(".html")).length;
  }
  return n;
}

function restore() {
  try { restoreFrom(siteRef()); }
  catch (e) {
    const prev = siteRef(PREV);
    if (!prev) throw e;
    console.warn(`::warning title=site branch::${e.message} — restoring the previous publish (${PREV}) instead`);
    restoreFrom(prev);
  }
}

function restoreFrom(ref) {
  if (!ref) throw new Error(`no "${BRANCH}" branch to restore from`);
  const paths = git(["ls-tree", "--name-only", ref]).split("\n").filter(isGenerated);
  // git archive | tar, without a shell: archive to a file, then extract it. A relative name in
  // the working folder: GNU tar reads "C:\…" as a remote host.
  const tarFile = `.site-restore-${process.pid}.tar`;
  try {
    execFileSync("git", ["archive", "--format=tar", "-o", tarFile, ref, "--", ...paths], { maxBuffer: 1 << 30 });
    execFileSync("tar", ["-xf", tarFile], { stdio: "inherit" });
  } finally { fs.rmSync(tarFile, { force: true }); }
  const have = filmPagesOnDisk(), want = expectedFilmPages();
  console.log(`site restored from ${git(["rev-parse", "--short", ref])}: ${paths.length} paths, ${have} film pages (manifest knows ${want})`);
  if (want && have < want * MIN_SHARE) {
    throw new Error(`only ${have} of ${want} film pages restored — refusing to build a site missing its archive`);
  }
}

function publish() {
  const ref = siteRef();
  const indexFile = path.join(os.tmpdir(), `filmychill-site-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  fs.rmSync(indexFile, { force: true });
  git(["read-tree", "HEAD"], { env });
  const mainOnly = git(["ls-tree", "--name-only", "HEAD"]).split("\n").filter(isMainOnly);
  if (mainOnly.length) git(["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ...mainOnly], { env });
  const present = fs.readdirSync(".").filter(isGenerated);
  // -f: these paths are in .gitignore on main, which is the point.
  if (present.length) git(["add", "-f", "-A", "--", ...present], { env });
  const tree = git(["write-tree"], { env });
  fs.rmSync(indexFile, { force: true });
  if (ref && git(["rev-parse", `${ref}^{tree}`]) === tree) {
    console.log(`site unchanged (tree ${tree.slice(0, 10)})`);
    report({ changed: "false", commit: git(["rev-parse", ref]) });
    return;
  }
  const head = git(["rev-parse", "--short", "HEAD"]);
  const commit = git(["commit-tree", tree, "-m", `Site build ${new Date().toISOString().slice(0, 16)}Z from ${head}`]);
  if (process.env.SITE_DRY_RUN) { console.log(`dry run: would publish ${commit.slice(0, 10)} (tree ${tree.slice(0, 10)})`); report({ changed: "dry-run", commit }); return; }
  // Keep the outgoing site reachable as site-prev before replacing it.
  if (ref) { try { git(["push", "--force", "--quiet", "origin", `${git(["rev-parse", ref])}:refs/heads/${PREV}`]); } catch (e) { console.warn(`could not keep the previous site as ${PREV}: ${e.message}`); } }
  git(["push", "--force", "--quiet", "origin", `${commit}:refs/heads/${BRANCH}`]);
  console.log(`site published: ${commit.slice(0, 10)} (main ${head}, ${present.length} generated paths)`);
  report({ changed: "true", commit });
}

// Put the previous publish back as the live site (manual: node scripts/site.js rollback).
function rollback() {
  const prev = siteRef(PREV);
  if (!prev) throw new Error(`no "${PREV}" branch to roll back to`);
  const commit = git(["rev-parse", prev]);
  git(["push", "--force", "--quiet", "origin", `${commit}:refs/heads/${BRANCH}`]);
  console.log(`site rolled back to ${commit.slice(0, 10)} (${PREV})`);
}

// ============================================================================
// THE BUILD'S STATE ON ITS OWN BRANCH (15 Nov 2026).
//
// facts/ and pages-manifest.json are the build's memory of every film page. The build rewrites
// them twice a day, and on main each rewrite became history: 158 of the 173 MB main grew by in
// the first two weeks of November (facts 147 MB, manifest 10 MB; the site reads neither). They
// move to `state`: one commit with no parent, replaced on every build, the outgoing one kept as
// `state-prev`, exactly as the built pages are kept on `site`.
//
// Two stages, told apart by whether main still tracks the files:
//   tracked (shadow)   main's copies are the ones the build uses. The branch is published after
//                      every build and compared on the next restore, so the round trip is
//                      proven before anything depends on it.
//   untracked (live)   the working copies come from the branch on restore and go back to it
//                      after the build. main no longer carries them (.gitignore).
//
//   node scripts/site.js restore-state    bring facts/ and the manifest from `state`
//                                         (`restore` does this first, then the pages)
//   node scripts/site.js publish-state    commit the working copies as the new `state`
//   node scripts/site.js rollback-state   put `state-prev` back as `state`
// ============================================================================
const STATE = "state";
const STATE_PREV = "state-prev";
const STATE_PATHS = ["pages-manifest.json", "facts"];
const stateOnMain = () => { try { return git(["ls-files", "--", ...STATE_PATHS]).length > 0; } catch { return true; } };
const manifestPages = (text) => { try { return Object.values(JSON.parse(text)).reduce((n, c) => n + Object.keys(c || {}).length, 0); } catch { return 0; } };

function restoreState() {
  const tracked = stateOnMain();
  let ref = siteRef(STATE);
  if (tracked) {
    // Shadow stage: nothing is restored; the branch is only checked against main's copies.
    if (!ref) { console.log("state: no branch yet (it is created by the first publish-state)"); return; }
    const differ = STATE_PATHS.filter((p) => { try { return git(["rev-parse", `${ref}:${p}`]) !== git(["rev-parse", `HEAD:${p}`]); } catch { return true; } });
    if (differ.length) console.warn(`::warning title=state branch::differs from main in ${differ.join(", ")} (expected only if main's data changed since the last build)`);
    else console.log(`state: branch ${git(["rev-parse", "--short", ref])} matches main (shadow stage)`);
    return;
  }
  const extract = (from) => {
    const tarFile = `.state-restore-${process.pid}.tar`;
    try {
      execFileSync("git", ["archive", "--format=tar", "-o", tarFile, from, "--", ...STATE_PATHS], { maxBuffer: 1 << 30 });
      // The branch is the whole truth: a facts file it doesn't hold must not survive from before.
      fs.rmSync("facts", { recursive: true, force: true });
      execFileSync("tar", ["-xf", tarFile], { stdio: "inherit" });
    } finally { fs.rmSync(tarFile, { force: true }); }
    console.log(`state restored from ${git(["rev-parse", "--short", from])}: ${expectedFilmPages()} film pages in the manifest`);
  };
  try {
    if (!ref) throw new Error(`no "${STATE}" branch to restore from`);
    extract(ref);
  } catch (e) {
    ref = siteRef(STATE_PREV);
    if (!ref) throw new Error(`${e.message}, and no "${STATE_PREV}" either — the build cannot run without its facts and manifest`);
    console.warn(`::warning title=state branch::${e.message} — restoring the previous state (${STATE_PREV}) instead`);
    extract(ref);
  }
}

function publishState() {
  if (!fs.existsSync("pages-manifest.json") || !fs.existsSync("facts") || !fs.readdirSync("facts").some((f) => f.endsWith(".jsonl"))) {
    throw new Error("pages-manifest.json or facts/ is missing — refusing to publish an empty state");
  }
  const ref = siteRef(STATE);
  // Never replace the state with one that has lost most of its pages (same rule as restore).
  const now = manifestPages(fs.readFileSync("pages-manifest.json", "utf8"));
  let before = 0;
  if (ref) { try { before = manifestPages(git(["show", `${ref}:pages-manifest.json`])); } catch { before = 0; } }
  if (!now || (before && now < before * MIN_SHARE)) throw new Error(`the manifest has ${now} film pages, the published state ${before} — refusing to replace it`);
  const indexFile = path.join(os.tmpdir(), `filmychill-state-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  fs.rmSync(indexFile, { force: true });
  // -f: in the live stage these paths are in .gitignore on main.
  git(["add", "-f", "-A", "--", ...STATE_PATHS], { env });
  const tree = git(["write-tree"], { env });
  fs.rmSync(indexFile, { force: true });
  if (ref && git(["rev-parse", `${ref}^{tree}`]) === tree) { console.log(`state unchanged (tree ${tree.slice(0, 10)})`); return; }
  const head = git(["rev-parse", "--short", "HEAD"]);
  const commit = git(["commit-tree", tree, "-m", `State ${new Date().toISOString().slice(0, 16)}Z from ${head}`]);
  if (process.env.SITE_DRY_RUN) { console.log(`dry run: would publish state ${commit.slice(0, 10)} (tree ${tree.slice(0, 10)}, ${now} film pages)`); return; }
  if (ref) { try { git(["push", "--force", "--quiet", "origin", `${git(["rev-parse", ref])}:refs/heads/${STATE_PREV}`]); } catch (e) { console.warn(`could not keep the previous state as ${STATE_PREV}: ${e.message}`); } }
  git(["push", "--force", "--quiet", "origin", `${commit}:refs/heads/${STATE}`]);
  console.log(`state published: ${commit.slice(0, 10)} (main ${head}, ${now} film pages)`);
}

function rollbackState() {
  const prev = siteRef(STATE_PREV);
  if (!prev) throw new Error(`no "${STATE_PREV}" branch to roll back to`);
  const commit = git(["rev-parse", prev]);
  git(["push", "--force", "--quiet", "origin", `${commit}:refs/heads/${STATE}`]);
  console.log(`state rolled back to ${commit.slice(0, 10)} (${STATE_PREV})`);
}

function report(o) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(o).map(([k, v]) => `${k}=${v}\n`).join(""));
}

module.exports = { GENERATED, isGenerated, isMainOnly, STATE, STATE_PATHS, manifestPages, restoreState, publishState, stateOnMain };

if (require.main === module) {
  const cmd = process.argv[2];
  try {
    // The manifest comes first: restoring the pages checks their number against it.
    if (cmd === "restore") { restoreState(); restore(); }
    else if (cmd === "publish") publish();
    else if (cmd === "rollback") rollback();
    else if (cmd === "restore-state") restoreState();
    else if (cmd === "publish-state") {
      // Shadow stage: main still holds the files, so a failed publish costs nothing. Say so
      // and let the run go on (a red run would skip the arrival alerts).
      try { publishState(); }
      catch (e) { if (!stateOnMain()) throw e; console.warn(`::warning title=state branch::${e.message} (shadow stage: main still holds the files)`); }
    }
    else if (cmd === "rollback-state") rollbackState();
    else { console.error("usage: node scripts/site.js restore|publish|rollback|restore-state|publish-state|rollback-state"); process.exit(2); }
  } catch (e) {
    console.error(`::error title=site branch::${e.message}`);
    process.exit(1);
  }
}
