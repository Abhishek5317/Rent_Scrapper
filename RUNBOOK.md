# RentIQ — How To Run Everything

A complete reference for running the project, from a cold start 

---

## Every time you sit down to work on this (do this first, always)

Postgres runs automatically in the background — you never start/stop it manually.

**You need TWO things running at once, in two separate terminals:**

**Terminal 1 — the API server** (leave running the whole time):
```powershell
cd C:\Users\riddh\OneDrive\Desktop\skymark-grid-project
node src\api\server.js
```
Should print: `RentIQ API listening on http://localhost:3001`

**Terminal 2 — the file server for the map** (leave running the whole time):
```powershell
cd C:\Users\riddh\OneDrive\Desktop\skymark-grid-project
python -m http.server 8080
```

Then open your browser to: **http://localhost:8080**

Your `PGPASSWORD` etc. are already saved permanently in your PowerShell profile — you won't need to re-enter them.

> **Using VS Code?** All commands in this doc are plain PowerShell — they work exactly the same in VS Code's built-in terminal (`` Ctrl+` ``) as in a standalone PowerShell window. A common setup: open two (or three) integrated terminal panels side by side (the split-terminal icon, top-right of the terminal panel) — one for the API server, one for the file server, and a third free for one-off commands like the scraper or scripts below. Your PowerShell profile (and saved `PGPASSWORD`) loads the same way there, since VS Code just launches your normal PowerShell.

---

## The web UI — four pages, one shared nav bar

Once both servers are running and you're at **http://localhost:8080**, every page has a nav bar (`🗺️ Grid Map` / `📤 Upload & Extract` / `📋 Listings` / `🕘 Run History`) at the top for jumping between them:

| Page | File | What it's for |
|---|---|---|
| Grid Map | `index.html` | The main map — search a scraped city by name or lat/lng, draw the grid, click a cell for rent analytics |
| Upload & Extract | `upload.html` | Run the full scrape → seed → ingest → aggregate pipeline for a batch of stores **from the browser, no terminal needed** — see Option C below |
| Listings | `listings.html` | Browse/filter every scraped listing across all stores (by store, BHK, furnishing, property type, rent range, society name) |
| Run History | `history.html` | Every extraction batch ever run — live/past status, per-store results, log viewing, and JSONL downloads |

On the Grid Map page, the location box now also has a **"🔎 Search a scraped city..."** autocomplete as an alternative to typing raw lat/lng — it suggests from cities you've already processed.

---

## Option A — Process ONE store manually

Use this when you want full visibility/control over each step, or you're debugging something.

**1. Edit `config.json`** at the project root — replace it entirely with just the new store's coordinates:
```json
{
  "center_lat": 19.0760,
  "center_lng": 72.8777,
  "cell_size_m": 200,
  "radius_m": 5000,
  "max_pages": 5,
  "api_base_url": "http://localhost:3001/api"
}
```
(Don't leave old fields like `city_name` or `magicbricks_locality` from a previous store — start clean.)

**2. Run the scraper** (in a third terminal, separate from the two servers above):
```powershell
python scraper\magicbricks_scraper.py
```
Watch for a line like `Resolved city: Pune, state: Maharashtra` — **note that exact city name**, you need it for the next steps.

**3. Seed the grid** (no arguments needed — reads straight from `config.json`):
```powershell
node src\scripts\seedCity.js
```

**4. Ingest** (use the exact resolved city name from step 2):
```powershell
node src\ingestion\ingest.js --city=Pune --input=scraped_listings.jsonl
```

**5. Aggregate**:
```powershell
node src\aggregation\computeStats.js --city=Pune
```

**6. Verify it worked**:
```powershell
node src\scripts\verify.js --city=Pune --scraped=scraped_listings.jsonl
```

---

## Option B — Process MANY stores automatically (batch mode)

Use this when you have a list of store locations to process in one go.

**1. Edit `stores.json`** at the project root — list every store:
```json
{
  "defaults": { "cell_size_m": 200, "radius_m": 5000, "max_pages": 5, "api_base_url": "http://localhost:3001/api" },
  "stores": [
    { "label": "Store 1", "center_lat": 19.0760, "center_lng": 72.8777 },
    { "label": "Store 2", "center_lat": 12.9716, "center_lng": 77.5946 }
  ]
}
```

**2. Run the batch processor** (one command handles everything — scrape, seed, ingest, aggregate — for every store in the list):
```powershell
node src\scripts\batchProcessStores.js
```

**3. Read the summary** it prints at the end — shows exactly which stores succeeded (with listing counts) and which failed (with why). Nothing gets silently lost even if one store has a problem.

**Heads up on time**: budget a few minutes per store. A 10-store batch could take 30-60+ minutes — fine to let it run in the background.

---

## Option C — Process MANY stores from the browser (no terminal)

The **Upload & Extract** page (`upload.html`) is the point-and-click version of Option B — it drives the exact same scrape → seed → ingest → aggregate pipeline, just via the API instead of hand-editing `stores.json` and running `batchProcessStores.js` yourself.

1. Go to **http://localhost:8080/upload.html** (or click "📤 Upload & Extract" in the nav bar). Both servers from the top of this doc still need to be running.
2. Set the **batch defaults** (cell size, radius, max pages, cooldown between stores) — these apply to any CSV row that doesn't override them.
3. Prepare a CSV with columns `label, center_lat, center_lng` (required), plus optional `cell_size_m`, `radius_m`, `max_pages`, `magicbricks_locality`, `magicbricks_city_name` per row — click "❓ Expected CSV format" on the page for the exact spec and an example.
4. Choose the file and click **"🔍 Validate"** — it parses the CSV and shows you exactly which rows are valid and which were skipped (with the reason), before anything runs.
5. Review the preview, then click **"▶️ Start Extraction"** — this spawns the same background worker as Option B and queues the batch.
6. Watch live progress on the same page: per-store status and a streaming log console, no need to keep the browser tab open (progress is also visible any time from Run History).

**Only one batch can run at a time** — starting a new one while another is `queued`/`running` returns a 409 with a link to watch the active batch in Run History instead.

---

## Viewing results

**On the map:** once ANY store has been processed (via Option A, B, or C), you can view it live:

1. Make sure both servers from the top of this doc are running
2. Go to **http://localhost:8080**
3. Type that store's lat/long into the two input boxes at the top, or use the **"🔎 Search a scraped city..."** box to find it by name
4. Click **"📍 Go to Location"** — the map recenters, redraws the grid, and shows real data
5. Click a teal-shaded cell to see the full rent breakdown

This works for **any store you've already processed**, going back and forth between them freely — no file editing needed just to look at results you already have.

**Browsing raw listings:** go to **📋 Listings** (`listings.html`) to see every scraped listing across every store in one filterable, paginated table — filter by store, BHK type, furnishing, property type, rent range, or society name.

**Checking batch history:** go to **🕘 Run History** (`history.html`) to see every extraction batch you've ever run (whether started via Option B's CLI or Option C's upload page) — status, per-store results, the full run log, and a download link for each store's raw scraped JSONL.

---

## Quick troubleshooting

| Symptom | Likely cause |
|---|---|
| `password authentication failed` | You're in a brand-new terminal that hasn't loaded your profile yet — close it and open a truly fresh one |
| API calls fail / "City not found" | The API server (Terminal 1) isn't actually running, or was restarted after a code change but you're looking at browser cache — hard refresh (Ctrl+Shift+R) |
| Map shows wrong location or old data | Hard refresh the browser — it may be using a cached `config.json` |
| `psql`/`node`/`python` not recognized | You're in a terminal opened before a PATH fix took effect — open a completely fresh one (in VS Code: close and reopen the integrated terminal panel, or start a new one) |
| Scraper says "Zero listing containers found" on a page | Usually just means you reached the end of results — not an error unless it happens on page 1 |
| Upload & Extract's "Start Extraction" returns "A batch is already running" (409) | Only one batch runs at a time across the whole app, whether started via Option B's CLI or Option C's upload page — follow the link to watch the active one in Run History, or wait for it to finish |
| CSV validate step skips rows | Check the "row_errors" reasons shown under the preview — usually a missing `label`, an out-of-range `center_lat`/`center_lng`, or a duplicate `label` within the same file |
| Run History shows a run stuck on "running" with no new log lines | The detached worker process may have died — check `logs\` in the project root for the batch's log file, or start a fresh batch once you've confirmed the old one isn't actually still active |