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
  /^(week|films|data|embed|streaming|people|coming-to-ott|cards|css|search)$/,
  /^(feed\.xml|llms\.txt|llms-full\.txt|sitemap\.xml|sitemap-[a-z0-9-]+\.xml)$/,
];
const isGenerated = (name) => GENERATED.some((re) => re.test(name));
// Files on main that only the build uses: never published. The site fetches data*.json and
// search/ at runtime; nothing on the site reads these. facts/ alone was 23 MB of the 1 GB
// GitHub Pages allowance (Oct 2026), pages-manifest.json another 7 MB. CNAME, robots.txt,
// manifest.json (the web-app manifest) and the verification files stay published.
const MAIN_ONLY = [
  /^\.(github|gitignore|gitattributes|assetsignore)$/, /^(scripts|cloudflare|facts)$/,
  /^(pages-manifest|catalog-manifest|page-lastmods|ott-seen|ott-watch|takes|votes-agg|votes-state)\.json$/,
  /^ott-history\.jsonl$/, /^(firestore\.rules|wrangler\.jsonc|package\.json|package-lock\.json|MIGRATION-STEPS\.md)$/,
];
const isMainOnly = (name) => MAIN_ONLY.some((re) => re.test(name));
const BRANCH = "site";
const MIN_SHARE = 0.9;   // of the manifest's film pages that must arrive on restore

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30, ...opts }).trim();

function siteRef() {
  try { git(["fetch", "--quiet", "--depth=1", "origin", `${BRANCH}:refs/remotes/origin/${BRANCH}`]); } catch { /* offline: use what we have */ }
  try { git(["rev-parse", "--verify", `refs/remotes/origin/${BRANCH}`]); return `refs/remotes/origin/${BRANCH}`; } catch { return null; }
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
  const ref = siteRef();
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
  git(["push", "--force", "--quiet", "origin", `${commit}:refs/heads/${BRANCH}`]);
  console.log(`site published: ${commit.slice(0, 10)} (main ${head}, ${present.length} generated paths)`);
  report({ changed: "true", commit });
}

function report(o) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(o).map(([k, v]) => `${k}=${v}\n`).join(""));
}

module.exports = { GENERATED, isGenerated, isMainOnly };

if (require.main === module) {
  const cmd = process.argv[2];
  try {
    if (cmd === "restore") restore();
    else if (cmd === "publish") publish();
    else { console.error("usage: node scripts/site.js restore|publish"); process.exit(2); }
  } catch (e) {
    console.error(`::error title=site branch::${e.message}`);
    process.exit(1);
  }
}
