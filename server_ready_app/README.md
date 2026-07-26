# RentIQ Browser-Assisted MagicBricks Capture

This project uses a manual, browser-assisted workflow:

1. The RentIQ server opens the MagicBricks search URL.
2. You browse MagicBricks from your own desktop Chrome.
3. You complete any CAPTCHA manually.
4. You scroll until the property cards you want are loaded.
5. The included Chrome extension extracts only the visible/loaded listing cards.
6. The extension sends those listings to the RentIQ Flask backend.
7. RentIQ stores the data in SQLite, displays it, records capture history, and exports CSV.

It does **not** solve, bypass, automate, or hide CAPTCHA challenges.

## Architecture

- One Python Flask/Waitress process
- One configurable host and port
- SQLite database created automatically
- Complete web frontend
- Chrome extension for user-triggered capture
- No Node.js
- No PostgreSQL/PostGIS
- No Docker
- No Playwright on the server
- No Apify or API token

## Server installation

```bash
cd /home/pimadmin/Abhishek_FTE/RentIQ_Server_Ready/server_ready_app
chmod +x setup.sh start.sh
PYTHON_BIN=/home/pimadmin/anaconda3/bin/python ./setup.sh
```

Edit `.env`:

```dotenv
HOST=0.0.0.0
PORT=8771
CAPTURE_KEY=
DATABASE_PATH=data/rentiq.sqlite3
```

`CAPTURE_KEY` is optional. When you set one, enter the same value in the extension popup.

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

Allow inbound TCP port `8771` in your server security group/firewall.

## Install the browser extension

1. Open the RentIQ web page.
2. Click **Download the Chrome extension**.
3. Extract `rentiq-browser-extension.zip`.
4. Open `chrome://extensions`.
5. Enable **Developer mode**.
6. Click **Load unpacked**.
7. Select the extracted `browser_extension` folder.
8. Pin **RentIQ MagicBricks Capture**.

## Use it

1. Enter a city and optional locality in RentIQ.
2. Click **Open MagicBricks**.
3. Complete any CAPTCHA manually.
4. Wait for listings to load.
5. Scroll the page to load more cards.
6. Click the RentIQ extension.
7. Confirm:
   - server URL: `http://10.3.8.174:8771`
   - city
   - optional locality
   - optional capture key
8. Click **Capture visible listings**.
9. Return to RentIQ; the table refreshes every five seconds.
10. Download the latest capture as CSV.

Each extension click captures the listing cards currently loaded in that tab. It does not automatically change pages. Navigate to another results page and capture again when needed.

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
