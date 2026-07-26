# RentIQ Server-Ready Rebuild

A self-contained web application for triggering rental-property scraping from a browser.

## What changed

The previous project combined a Node API, a separate static web server, PostgreSQL/PostGIS, Python Playwright, Docker, hardcoded localhost URLs, and an HTTP-cookie pagination pipeline. On the new Amazon Linux 2 server this created several independent failure points:

- MagicBricks returned CAPTCHA/bot-check pages to the server's outbound network.
- Docker Chromium and the advertised browser identity could differ.
- The old native Node runtime required a newer GLIBC than Amazon Linux 2 provides.
- Frontend and backend ports were hardcoded in multiple files.
- PostgreSQL/PostGIS setup was required before the scrape button could complete the pipeline.
- Switching from the real browser to `httpx` increased session inconsistency.

This rebuild uses:

- one Python web process;
- one host/port;
- SQLite storage;
- no Node.js;
- no PostgreSQL;
- no Docker;
- dynamic host resolution;
- a managed scraping mode for reliable datacenter execution;
- an optional direct Chrome mode for environments MagicBricks permits.

## Important limitation

No source-code change can guarantee that MagicBricks will accept requests from every datacenter IP. Its anti-bot system runs on MagicBricks infrastructure. The `direct` mode is included, but it may still be rejected. For reliable execution on arbitrary servers, use the managed provider mode.

## Recommended deployment on `10.3.8.174`

```bash
cd /home/pimadmin/Abhishek_FTE
git clone -b agent/server-ready-rebuild https://github.com/Abhishek5317/Rent_Scrapper.git RentIQ_Server_Ready
cd RentIQ_Server_Ready/server_ready_app
chmod +x setup.sh start.sh
./setup.sh
nano .env
```

Set:

```dotenv
HOST=0.0.0.0
PORT=8771
SCRAPE_PROVIDER=apify
APIFY_TOKEN=your_apify_token
```

Start:

```bash
./start.sh
```

Open:

```text
http://10.3.8.174:8771
```

Allow TCP port `8771` in the server security group/firewall.

## Direct-browser mode

Install the optional browser dependencies:

```bash
./setup.sh direct
```

Then configure:

```dotenv
SCRAPE_PROVIDER=direct
CHROME_PATH=/path/to/google-chrome
HEADLESS=true
```

Direct mode keeps a persistent browser profile, opens the MagicBricks homepage first, uses one browser for navigation and parsing, and saves rejected/empty responses under `debug/`.

## API

- `GET /health`
- `POST /api/scrape`
- `GET /api/status`
- `GET /api/runs`
- `GET /api/listings`
- `GET /api/listings.csv`

Example:

```bash
curl -X POST http://127.0.0.1:8771/api/scrape \
  -H 'Content-Type: application/json' \
  -d '{"city":"Noida","locality":"Sector 98","provider":"auto","max_results":50,"max_pages":3}'
```
