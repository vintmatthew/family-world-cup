# Putting the tracker online (free, auto-updating)

This publishes the page to **GitHub Pages** and rebuilds it **every hour** on
GitHub's machines — so it's always live at a free URL, your laptop can be off,
and there's nothing to pay for. One-time setup, ~10 minutes.

Everything in this folder is already committed to a local git repo, so you only
need to (1) make an empty GitHub repo, (2) push, (3) flip Pages on.

---

## 1. Create an empty repo on GitHub

1. Sign in (or sign up — free) at <https://github.com>.
2. Go to <https://github.com/new>.
3. **Repository name:** `family-world-cup` (anything you like).
4. Leave it **Public**. *(The page only shows first names and football scores,
   and it carries a "don't index me" tag so it won't appear in Google. Public
   repos get unlimited free auto-updates, which is why we use one.)*
5. **Do NOT** tick "Add a README / .gitignore / licence" — we already have files.
6. Click **Create repository**.

## 2. Push this folder to it

GitHub will show you a URL like `https://github.com/YOURNAME/family-world-cup.git`.
In a terminal **in this folder**, run (swap in your URL):

```powershell
git remote add origin https://github.com/YOURNAME/family-world-cup.git
git push -u origin main
```

The first push will ask you to sign in to GitHub (a browser window pops up) —
approve it.

## 3. Turn on Pages

1. On your repo page: **Settings** → **Pages** (left sidebar).
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. That's it — no other settings.

## 4. Watch it go live

1. Open the **Actions** tab. You'll see "Update World Cup tracker" running.
   (If it hasn't started, click it → **Run workflow** to kick it off now.)
2. When it finishes (green tick), your site is live at:

   **`https://YOURNAME.github.io/family-world-cup/`**

   Share that link with the family. It refreshes itself every hour.

---

## Day-to-day

- **Nothing to do.** It updates hourly on its own, picking up scores as the data
  feed publishes them.
- **Force an update now:** Actions tab → "Update World Cup tracker" → **Run
  workflow**.
- **Change someone's teams / a name:** edit `owners.json`, then:
  ```powershell
  git add owners.json
  git commit -m "Update teams"
  git push
  ```
  The push triggers a rebuild automatically.

## Notes

- You can still run it locally (`refresh.bat`) anytime — that's also how you get
  the **PDF** for WhatsApp (the online version is the live web page, not a PDF).
- GitHub pauses the hourly schedule only after 60 days of *no activity at all* —
  irrelevant for a one-month tournament, but if it ever pauses, one push or one
  manual "Run workflow" wakes it back up.
- Scheduled runs can occasionally be a few minutes late when GitHub is busy —
  fine for football scores.
