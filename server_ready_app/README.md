# RentIQ Automatic MagicBricks Capture

RentIQ runs its backend, SQLite database, frontend, and CSV export on the host server. The only browser-side component is the Chrome extension.

## Workflow

1. Enter a city and optional locality on RentIQ.
2. Click **Open MagicBricks & Start Automatic Capture**.
3. Complete a CAPTCHA manually if MagicBricks displays one.
4. The extension automatically scrolls the current search-results page.
5. It reads latitude/longitude from each listing card's embedded JSON-LD, matching the coordinate source used by the original scraper.
6. For listings whose coordinates are still missing, it automatically reuses one background property-detail tab, extracts coordinates, and moves to the next listing.
7. The detail tab is closed after enrichment.
8. Listings, latitude, longitude, and property links are sent to the Flask server and stored in SQLite.
9. The data is displayed in RentIQ and exported to CSV.

RentIQ does **not** solve, skip, bypass, automate, or hide CAPTCHA challenges. If a CAPTCHA appears on a detail page, the extension brings that tab forward, waits for you to complete it, and resumes automatically.

## Architecture

- Flask + Waitress backend on the host server
- SQLite database created automatically
- HTML/CSS/JavaScript frontend
- Chrome extension for browser access and coordinate enrichment
- No Node.js
- No PostgreSQL/PostGIS
- No Docker
- No Playwright on the server
- No Apify or API token
- No localhost application

## Server installation

```bash
cd /home/pimadmin/Abhishek_FTE/RentIQ_Server_Ready/server_ready_app
chmod +x setup.sh start.sh
PYTHON_BIN=/home/pimadmin/anaconda3/bin/python ./setup.sh
```

Create or edit `.env`:

```dotenv
HOST=0.0.0.0
PORT=8771
CAPTURE_KEY=
DATABASE_PATH=data/rentiq.sqlite3
```

`CAPTURE_KEY` is optional. When it is set, the same value must be saved in the extension popup.

Run tests:

```bash
source .venv/bin/activate
python -m unittest -v test_smoke.py
```

Start:

```bash
./start.sh
```

Open:

```text
http://10.3.8.174:8771
```

Allow inbound TCP port `8771` in the server security group/firewall.

## Install or update the extension

1. Open RentIQ.
2. Download the Chrome extension ZIP.
3. Extract the ZIP.
4. Open `chrome://extensions`.
5. Enable **Developer mode**.
6. Choose **Load unpacked** and select the extracted `browser_extension` folder.
7. After an extension code update, replace the extracted folder and click **Reload** on the extension card.

## Automatic use

1. Enter the city and locality.
2. Click **Open MagicBricks & Start Automatic Capture**.
3. Complete any CAPTCHA manually.
4. Leave the MagicBricks search page open while RentIQ scrolls and enriches the listings.
5. The on-page RentIQ status box shows progress.
6. Return to the RentIQ page to view latitude/longitude and download CSV.

The current implementation processes listings dynamically loaded on the current search-results page. It does not automatically traverse separate numbered result pages.

## Coordinate extraction order

1. Search-card data attributes.
2. Search-card JSON-LD or application JSON.
3. Property-detail DOM attributes.
4. Property-detail metadata.
5. Property-detail JSON-LD, application JSON, or `__NEXT_DATA__`.
6. Embedded latitude/longitude JavaScript values.
7. Map links containing coordinates.

Coordinates are validated against a broad India bounding range to reduce false matches.

## Files created at runtime

```text
data/rentiq.sqlite3
.env
.venv/
```

## API endpoints

- `GET /health`
- `GET /api/search-url?city=Noida&locality=Sector%2098`
- `POST /api/browser-capture`
- `GET /api/status`
- `GET /api/runs`
- `GET /api/listings`
- `GET /api/listings.csv`
- `GET /browser-extension.zip`
