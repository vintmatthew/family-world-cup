# 🌍 Family World Cup 2026 Tracker

A tiny, zero-setup tracker for the family World Cup game. It pulls the real
2026 fixtures and results, works out the group tables and knockout bracket
itself, and builds a single nice-looking web page you can screenshot and send
round the family.

- **No sign-ups, no API key, no `npm install`.** Just Node.js (you have it).
- **Data source:** the public-domain [openfootball/worldcup.json](https://github.com/openfootball/worldcup.json) dataset.
- **Robust to occasional refreshing:** every refresh is merged with a local
  snapshot, so past results are never lost — even if you only update once a week
  or the network hiccups while you do.

## How to use it

1. **Set who owns which teams.** Open `owners.json` and fill in each family
   member with their two teams. Matthew is already set to **Australia** and
   **Algeria**. Use the exact names listed in `_valid_team_names` (copy/paste).

2. **Refresh.** Double-click **`refresh.bat`** (Windows). It updates the data,
   rebuilds the page **and a PDF**, then opens `index.html` in your browser.
   - Prefer the terminal? Run: `node refresh.mjs`

3. **Share it.** Either screenshot `index.html`, or attach the generated
   **`Family-World-Cup.pdf`** to WhatsApp (the whole thing in one file).
   Refresh whenever you want fresh scores — daily, weekly, whatever.

## What you'll see

- 👪 **Family standings** — everyone's teams ranked by how many are still in.
- 📅 **Next 7 days** — upcoming kickoffs in your local time, with owner tags.
- ✅ **Recent results** · 📊 **Group standings** · 🏆 **Knockout bracket**
  (fills in automatically as the tournament progresses).

Real flag images are embedded into the page, so flags show correctly on
Windows (where flag emoji otherwise appear as two letters like "AU") and in
the PDF/screenshots.

## Good to know

- Kickoff times show in your computer's timezone (currently Europe/London).
  To force another, set `WC_TZ`, e.g. `WC_TZ=Australia/Sydney node refresh.mjs`.
- Group tie-breakers use points → goal difference → goals scored (a slight
  simplification of FIFA's full rules). The 8 "best third-placed" knockout
  spots resolve once the group stage finishes.
- The PDF is made with headless Microsoft Edge (already on Windows) — no extra
  install. If Edge/Chrome can't be found it's skipped and you can still use
  the browser's own Print → Save as PDF on `index.html`.
- Everything lives in this folder. The `data/` folder is the local cache /
  snapshot (and downloaded flags) — leave it be; it's what keeps your history
  intact and the page working offline.
