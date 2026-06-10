# ReelAdda Migration — reeladda.github.io (15 minutes, one time)

## 1. Create the organization (no new account needed)
- Profile picture → Settings → Organizations → New organization → Free plan
- Organization name: reeladda
- (If the name is taken, try reeladda-app / getreeladda and tell Claude — the files need a small URL update)

## 2. Create the repository
- Inside the reeladda organization: New repository
- Name it exactly: reeladda.github.io
- Keep it Public → Create

## 3. Upload the files
- Add file → Upload files → drag everything from this zip EXCEPT:
  - the .github folder (it is hidden and will not drag)
  - COPY-THIS-into-.github-workflows-update.yml.txt (used in step 4)
  - this MIGRATION-STEPS.md (optional, can skip)
- Make sure update.js ends up inside a "scripts" folder:
  easiest way — after uploading everything else, click Add file → Create new file,
  type "scripts/update.js" as the name, and paste the content of update.js into it.
  (Or drag the scripts folder itself — folders that are not hidden drag fine.)
- Commit changes

## 4. Create the workflow file
- Add file → Create new file
- Filename (type exactly, the slashes create folders): .github/workflows/update.yml
- Paste the content of COPY-THIS-into-.github-workflows-update.yml.txt
- Commit changes

## 5. Add the TMDB secret
- Repo Settings → Secrets and variables → Actions → New repository secret
- Name: TMDB_API_KEY — Value: your existing TMDB key (same one as before)

## 6. Enable the website
- Settings → Pages → Source: Deploy from a branch → Branch: main, / (root) → Save
- After 2–3 minutes the site is live at https://reeladda.github.io/

## 7. First scan
- Actions tab → Weekly ReelAdda Update → Run workflow → wait for green tick → refresh site

## 8. Google Search Console
- Add property → URL prefix → https://reeladda.github.io/
- Verify (the meta tag from your old site is already in index.html — verification may
  pass instantly; if not, follow the HTML file method)
- Sitemaps → submit: sitemap.xml

## 9. Retire the old site (after confirming the new one works)
- In the old ReelRadar repo: Settings → Pages → set Source to "None"
- This avoids Google seeing duplicate sites
