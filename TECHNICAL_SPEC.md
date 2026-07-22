# RentIQ — Technical Specification

## 1. Purpose

Given any lat/lng "store" location, produce a grid-based map of nearby rental
market data. The area around a center point is divided into a fixed lattice
of square cells (default 200m × 200m, out to a configurable radius). Rental
listings scraped from MagicBricks are geolocated, assigned to a cell, and
aggregated into per-cell statistics (rent by BHK type, dominant housing
type, most active societies). Results are browsable on a Leaflet map: click
a cell, see its analytics.

Originally scoped to a single store ("Skymark One", Noida) but designed
multi-city/multi-store from day one — `city_id` scopes every table, and
`batchProcessStores.js` can process an arbitrary list of locations
unattended.

## 2. Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| **Scraper** | Python 3 | No pinned interpreter version in-repo; developed/tested against Python 3.13. |
| | [Playwright](https://playwright.dev/) (`playwright>=1.44.0`) — Chromium | Headless browser automation for bot-check bypass + cookie capture. Requires a one-time `playwright install chromium`. |
| | [httpx](https://www.python-httpx.org/) (`httpx>=0.27.0`) | Async HTTP client for cookie-based pagination and detail-page fetches. |
| | [BeautifulSoup4](https://www.crummy.com/software/BeautifulSoup/) (`beautifulsoup4>=4.12.0`) | HTML parsing (`html.parser` backend), DOM + JSON-LD extraction. |
| | Standard library (`urllib`, `re`, `logging`, `dataclasses`, `asyncio`) | Reverse geocoding call, regex-based field extraction, logging to `scraper.log`. |
| **Backend / API** | Node.js (CommonJS, no bundler/build step) | Version not pinned via `engines`/`.nvmrc`; developed/tested against Node 24. |
| | [Express](https://expressjs.com/) 5.x | HTTP server + routing (`src/api/app.js`, `src/api/routes/grids.js`). |
| | [cors](https://www.npmjs.com/package/cors) 2.8.x | Cross-origin support for the frontend (served from a different port/origin). |
| | [node-postgres (`pg`)](https://node-postgres.com/) 8.x | Postgres driver/connection pool, used directly with raw parameterized SQL — no ORM/query builder. |
| **Ingestion / Aggregation / Ops scripts** | Node.js, same runtime as the API | `src/ingestion/ingest.js`, `src/aggregation/computeStats.js`, `src/scripts/*.js` — plain CLI scripts (`--flag=value` args), no CLI framework. |
| **Database** | [PostgreSQL](https://www.postgresql.org/) 15+ | Primary datastore; developed/tested against Postgres 16. Connection via env vars (`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`) or a single `DATABASE_URL`, no `.env` file/dotenv dependency in-repo — variables are expected to already be set in the shell profile (per `RUNBOOK.md`). |
| | [PostGIS](https://postgis.net/) extension | Geometry columns (`GEOMETRY(Polygon, 4326)`, `GEOMETRY(Point, 4326)`), spatial indexes (GIST), `ST_Contains`/`ST_MakePoint` for validation and generated columns. |
| | [pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) extension | Trigram similarity + GIN index for fuzzy society-name matching during ingestion. |
| **Geocoding** | [Nominatim](https://nominatim.org/) (OpenStreetMap), public API | External HTTP dependency, rate-limited client-side to ~1 req/sec per its usage policy; both forward geocode (`geocoder.js`) and reverse geocode (scraper's city resolution) use it. No API key / paid geocoding service used. |
| **Frontend** | Static HTML/CSS/vanilla JavaScript | No framework (no React/Vue/etc.), no bundler, no npm build step — `index.html` loads `script.js` directly via `<script>` tag. |
| | [Leaflet](https://leafletjs.com/) 1.9.4 (via `unpkg` CDN) | Map rendering; canvas renderer explicitly chosen over the SVG default for performance at thousands of grid cells. |
| | [OpenStreetMap tile server](https://www.openstreetmap.org/) | Base map tiles (`{s}.tile.openstreetmap.org`), attribution required per OSM policy. |
| **Data interchange / storage formats** | JSONL (`scraped_listings.jsonl`, `scraped_archive/*.jsonl`) | Scraper → ingestion handoff format; one JSON object per line. |
| | JSON (`config.json`, `stores.json`) | Runtime configuration, hand-edited or auto-updated by the scraper. |
| | GeoJSON (`noida.geojson`) | Optional cosmetic boundary overlay, Noida-specific leftover. |
| **Local dev / process model** | No containerization (no Dockerfile/docker-compose in-repo) | Postgres is assumed to run as a local background service; the API (`node src/api/server.js`) and a static file server (`python -m http.server 8080`) are run manually in separate terminals per `RUNBOOK.md`. |
| **Testing / CI** | None configured | `package.json`'s `test` script is a placeholder (`exit 1`); no test framework (Jest/Mocha/pytest) is installed; no CI workflow files present. `verify.js` is the closest equivalent — a manual, non-automated health-check script. |

## 3. Architecture Overview

```
config.json / stores.json
        │
        ▼
┌───────────────────┐    Playwright bootstrap → cookies → httpx pagination
│  magicbricks_      │    → per-listing detail-page coordinate enrichment
│  scraper.py         │───────────────────────────────────────┐
└───────────────────┘                                          │
                                                                 ▼
                                                     scraped_listings.jsonl
                                                                 │
        ┌────────────────────────────────────────────────────┐ │
        │                                                      ▼
┌───────────────┐   ┌────────────────┐   ┌──────────────┐  ┌────────────┐
│ seedCity.js    │──▶│  Postgres      │◀──│  ingest.js   │◀─┘
│ (grid lattice) │   │  + PostGIS      │   │ (normalize,  │
└───────────────┘   └────────────────┘   │  geocode,    │
                             ▲            │  grid-assign,│
                             │            │  upsert)     │
                    ┌────────────────┐    └──────────────┘
                    │ computeStats.js │◀── run after ingest
                    │ (aggregation)   │
                    └────────────────┘
                             │
                             ▼
                    ┌────────────────┐        ┌──────────────────────┐
                    │ Express API     │◀──────▶│ index.html / script.js│
                    │ (src/api)       │  HTTP  │ (Leaflet map UI)      │
                    └────────────────┘        └──────────────────────┘
```

`verify.js` is a standalone health-check runnable after any stage.
`batchProcessStores.js` drives the scraper → seed → ingest → aggregate
sequence across a list of stores unattended, writing `config.json` fresh
per store and archiving each store's raw scrape output.

## 4. Components

### 3.1 Scraper — `scraper/magicbricks_scraper.py`

- **Input**: `config.json` (`center_lat`, `center_lng` at minimum).
- **City resolution**: reverse-geocodes the center point via Nominatim on
  first run for a new location, then persists `city_name`/`state` back into
  `config.json` so later stages read the same resolved values.
- **Session bootstrap**: launches headless Playwright/Chromium against the
  MagicBricks search-results page to pass bot detection and capture session
  cookies, then switches to plain `httpx` requests (carrying those cookies)
  for pagination — periodically re-validating via Playwright every
  `BROWSER_REFRESH_EVERY` pages or after a bad response.
- **Parsing**: DOM-first (confirmed selectors against MagicBricks' SRP
  markup, with JSON-LD structured data preferred over raw text scraping for
  price/address), falling back to an embedded-JSON-blob parser if the DOM
  path yields nothing.
- **Rent sanity filter**: rejects any parsed `monthly_rent` outside
  1,000–1,000,000 (guards against mis-extracted sale prices/deposits).
- **Coordinate enrichment**: search-results pages carry no per-listing
  lat/lng, so each listing's detail page is fetched separately afterward to
  extract a real building-level coordinate (JSON-LD → inline JS vars →
  Google Maps embed URL, in that priority order).
- **Output**: `scraped_listings.jsonl`, one JSON object per listing, schema
  matching `properties` table columns closely (`listing_url`,
  `property_name`, `society_name`, `address_raw`, `lat`, `lng`,
  `monthly_rent`, `bhk_raw`, `area_sqft`, `furnishing`, `property_type`,
  `raw_metadata`).
- No radius filtering happens at scrape time — that's deferred to ingestion,
  once real coordinates exist.

### 3.2 Grid Service — `src/services/gridService.js`

- Defines a regular, axis-aligned lattice anchored at a city's
  `(origin_lat, origin_lng)`, extending `radius_m` in each direction in
  `cell_size_m` steps.
- `generateGridCells(city)` — pure function, builds every cell's bounds +
  WKT polygon; does not touch the DB.
- `assignPropertyToGrid(lat, lng, city)` — analytical row/col math (no DB
  round-trip, no polygon test) so a listing's cell can be computed
  identically client-side (`script.js`) and server-side. Points outside the
  configured radius return `null`.
- `gridCodeFor(row, col)` → `"G{row}_{col}"`, e.g. `G-2_1` — stable,
  reconstructible, sorts sensibly.
- `validateAssignment()` — optional PostGIS `ST_Contains` spot-check, not on
  the ingestion hot path.
- Grids are generated once per city (`seedCity.js`) and never regenerated
  during ingestion — ingestion only looks codes up.

### 3.3 BHK Normalizer — `src/services/bhkNormalizer.js`

- Converts free-text BHK strings (`"2.5 BHK"`, `"1 RK"`, `"Studio"`,
  `"Penthouse"`, arbitrary/unknown text) into a stable `bhk_type` label plus
  a sortable `bhk_numeric`.
- Regex-driven, no hardcoded fixed enum — new configurations MagicBricks
  introduces later fall through the same parse path.
- Unrecognized strings never get dropped: they fall back to a
  cleaned/uppercased version of the raw text so bucketing still groups
  identical unknowns together.
- `compareBhkTypes()` provides sort order: numeric configs ascending, then
  non-numeric alphabetically.

### 3.4 Geocoder — `src/services/geocoder.js`

- Wraps Nominatim (OpenStreetMap), rate-limited to ~1 req/sec per its usage
  policy.
- `geocodeAddress(query)` — single lookup.
- `geocodeWithFallbacks(societyName, addressRaw, cityName)` — tries
  progressively broader queries (society+city → address → city alone) so a
  listing always resolves to *something* rather than leaving lat/lng null
  and violating the `properties` table's NOT NULL constraint.
- A geocode that only succeeds at the city-alone tier is treated as "not
  actually resolved" elsewhere in the pipeline (see 3.5) since it's just
  the city's centroid, not a usable per-listing/per-society position.
- The real cache is `societies.lat/lng` in Postgres — geocoded once per
  society, reused forever.

### 3.5 Ingestion — `src/ingestion/ingest.js`

Reads `scraped_listings.jsonl` line by line, and per listing (each in its
own transaction):

1. **BHK normalize** via `bhkNormalizer`.
2. **Coordinate resolution**, priority order:
   - a) `listing.lat/lng` — real per-building coordinate from the detail
     page (highest precision).
   - b) `society.lat/lng` — geocoded society location (coarser, shared
     across all listings in that society).
   - c) Address-level geocode fallback (coarsest, last resort).
   - City-only-tier geocode matches are explicitly treated as unresolved at
     every tier (see `_isCityOnlyMatch`) to avoid silently clustering
     unrelated listings at one point.
3. **Society resolution** (`resolveSociety`) — trigram fuzzy match
   (`pg_trgm`, similarity threshold `0.6`) against existing societies in the
   same city; creates a new society row if no close match. Skips its own
   geocode call when the listing already carries a precise coordinate
   (`skipGeocode`), to avoid burning a rate-limited Nominatim request on
   data that won't be used.
4. **Grid assignment** via `gridService.assignPropertyToGrid`, looked up
   against the pre-seeded `grids` table (cached per-run in a `Map` to avoid
   repeat queries for the same cell) with a warning logged (not a hard
   failure) if a code isn't found.
5. **Upsert** into `properties`, keyed on `UNIQUE(listing_url)` — re-scrapes
   update price/status fields (`ON CONFLICT ... DO UPDATE`) rather than
   duplicating rows.

Listings are never silently dropped: those with no resolvable coordinate at
all are skipped and counted (`skippedNoCoords`); those outside the grid
radius are still stored with `grid_id = NULL` (`skippedOutsideGrid`). One
`scraping_runs` row is created per ingestion run and updated with final
counts.

Run: `node src/ingestion/ingest.js --city=<Name> --input=scraped_listings.jsonl`

### 3.6 Aggregation — `src/aggregation/computeStats.js`

Full recompute (DELETE + INSERT) on every run, not incremental — avoids
stale-row bugs (e.g. a `bhk_type` bucket that no longer has listings) and is
fast enough at this data scale.

- **`bhk_bucket_stats`**: one row per `(grid_id, bhk_type)` — count, avg,
  true median (`PERCENTILE_CONT`), min, max, stddev, avg area. Feeds Section
  1 (rental analytics by BHK).
- **`grid_stats`**: one row per grid — total listings, rent range, avg
  area, dominant + second BHK type (with %), top + second-most-active
  society. Computed in two passes (SQL aggregation, then JS ranking) for
  readability rather than one dense self-joining query. Feeds Sections 3–5
  and the map's density shading.

Run: `node src/aggregation/computeStats.js --city=<Name>`

### 3.7 Database Schema — `db/schema.sql` (Postgres 15+, PostGIS + pg_trgm)

| Table | Purpose |
|---|---|
| `cities` | One row per city/store analysis area — origin point, cell size, radius. `UNIQUE(name)`. |
| `grids` | Pre-generated lattice cells per city. `grid_code` is the stable public ID. `geom` (PostGIS polygon) + GIST index for spatial ops; `row_index`/`col_index` for analytical recompute. `UNIQUE(city_id, grid_code)`. |
| `societies` | Deduplicated society/building names per city, with a `normalized_name` + GIN trigram index for fuzzy matching. |
| `scraping_runs` | Audit log — one row per scraper/ingestion execution (status, counts, error log), so silent scraper breakage is detectable. |
| `properties` | One row per scraped listing. `geom` is a generated column from `lat`/`lng`. `bhk_type`/`bhk_numeric` normalized, `bhk_raw` preserved. `raw_metadata` JSONB catch-all. `is_active` supports soft-delisting. `UNIQUE(listing_url)`. |
| `bhk_bucket_stats` | Aggregation output — per-grid, per-BHK-type stats. `UNIQUE(grid_id, bhk_type)`. |
| `grid_stats` | Aggregation output — one denormalized summary row per grid (PK = `grid_id`), built specifically so a "click a cell" UI interaction is a single indexed lookup, never a live aggregation. |
| `grid_society_counts` (view) | Live per-grid society leaderboard — kept as a view rather than materialized since "top N" is cheap on read. |

Key indexes: GIST on `grids.geom` and `properties.geom`; partial index on
`properties(grid_id)` / `(grid_id, bhk_type)` where `is_active = true`; GIN
trigram index on `societies.normalized_name`.

### 3.8 API — `src/api/` (Express 5)

`app.js` wires CORS + JSON body parsing + the `/api` router + a `/health`
check + a uniform 404 JSON shape. `server.js` starts the HTTP listener
(default port 3001, `PORT` env override). `db.js` exports a shared `pg.Pool`
(configurable via `DATABASE_URL` or discrete `PGHOST`/`PGPORT`/`PGUSER`/
`PGPASSWORD`/`PGDATABASE` env vars).

All grid-scoped endpoints (`src/api/routes/grids.js`) take `?city=` (default
`"Noida"`) since the schema is multi-city. Every failure returns
`{ error: "message" }` with `404` (not found) or `500` (unexpected).

| Endpoint | Spec section | Description |
|---|---|---|
| `GET /api/cities` | — | Lists every seeded city with its origin/radius/cell config — lets the frontend resolve an arbitrary lat/lng to a known scraped city. |
| `GET /api/grids?city=` | Map overlay | Every grid cell's bounds + listing count in one call, for density shading. |
| `GET /api/grids/:gridCode?city=` | 5 (Grid Insights) | Total listings, rent stats, dominant/second housing type, most active society. |
| `GET /api/grids/:gridCode/properties?city=&limit=&offset=` | 2 (Property Listings) | Paginated raw listings in the cell (`limit` capped at 500). |
| `GET /api/grids/:gridCode/statistics?city=` | 1 + 3 (BHK Analytics, Top Types) | Per-BHK bucket stats + top-2 housing types by count. |
| `GET /api/grids/:gridCode/societies?city=&limit=` | 4 (Top Societies) | Leaderboard from the live `grid_society_counts` view (`limit` capped at 50, default 2). |

### 3.9 Frontend — `index.html`, `script.js`, `style.css`

Static site (Leaflet 1.9.4 via CDN), served by any static file server
(`python -m http.server 8080` per the runbook) — no build step.

- Loads `config.json` at startup for the initial center/cell/radius and API
  base URL.
- Renders the grid as a canvas-based Leaflet layer (chosen over SVG
  specifically for the cell count at large radii — e.g. 5000m/200m ⇒ 51×51
  = 2,601 cells — where per-shape DOM elements get sluggish).
- `drawGrid()` fetches `/api/grids` once for all cells' listing counts and
  shades each cell's fill opacity by relative density; the center cell is
  always outlined distinctly.
- Clicking a shaded cell calls `loadGridAnalytics(gridCode)`, which fires
  all four grid-scoped endpoints in parallel and renders Sections 1–5 into
  a tabbed results panel.
- `gotoLocation()` lets a user type in an arbitrary lat/lng, matches it
  against `/api/cities` by haversine distance within each city's seeded
  radius, and switches the whole app to that city without editing
  `config.json` — this can only *view* already-scraped cities, not trigger
  a new scrape.
- `noida.geojson` is a leftover Noida-specific boundary overlay; loaded
  best-effort and only shown if it actually contains the currently
  configured center point (otherwise silently skipped rather than showing
  a misleading shape for a different city).

### 3.10 Operational Scripts — `src/scripts/`

- **`seedCity.js`** — run once per city (or whenever `cell_size_m`/
  `radius_m` changes) to populate `cities` + `grids`. Defaults read from
  `config.json`; CLI args override. Re-running for an existing city updates
  its stored radius/cell size (documented as a fixed real bug: without this
  update, ingestion silently keeps using a stale `radius_m`) and adds any
  newly needed cells without touching existing ones.
- **`batchProcessStores.js`** — drives scrape → seed → ingest → aggregate
  across every entry in `stores.json`, writing a fresh `config.json` per
  store and archiving each store's raw scrape output to `scraped_archive/`.
  Failures on one store are logged and skipped rather than aborting the
  batch; a pass/fail summary prints at the end.
- **`verify.js`** — standalone pipeline health check: schema/PostGIS
  presence, city+grid seed counts, scraped-file sanity (parse errors,
  missing-field rates), ingestion counts (grid/society coverage), and data
  quality spot-checks (BHK distribution, rent range sanity — flags a max
  rent >8x the average as a likely parsing bug).
- **`Debuggeocode.js`** — isolates a single raw Nominatim call (HTTP
  status, full response body) for manual troubleshooting, bypassing
  `geocoder.js`'s summarized logging.

## 5. Configuration Files

- **`config.json`** (project root) — single active store's config, read by
  the scraper (Python), `seedCity.js`, and `script.js` (frontend). Minimum
  required: `center_lat`, `center_lng`. Auto-populated by the scraper on
  first run: `city_name`, `state`, `magicbricks_city_name`,
  `location_label`. Also holds `cell_size_m`, `radius_m`, `max_pages`,
  `api_base_url`, and optionally `magicbricks_locality` to scope the search.
- **`stores.json`** (project root) — batch-mode input: a `defaults` block
  plus a `stores` array (`label`, `center_lat`, `center_lng`, optional
  per-store overrides). Consumed only by `batchProcessStores.js`.

## 6. Data Flow / Pipeline Sequencing

Two supported operating modes, both converging on the same underlying
scripts:

**Manual (single store)**: edit `config.json` → run scraper → note the
resolved city name → `seedCity.js` (no args, reads `config.json`) →
`ingest.js --city=<Name>` → `computeStats.js --city=<Name>` →
`verify.js --city=<Name>`.

**Batch (many stores)**: edit `stores.json` → `batchProcessStores.js` runs
the full sequence per store automatically, archiving raw output and
reporting a pass/fail summary.

Grid seeding must precede ingestion for a given city (ingestion only looks
up existing grid codes, never creates them) — enforced by convention/
documentation, not a hard runtime dependency check beyond the warning
logged in `getOrCreateGridDbId`.

The API server and the static file server run continuously and
independently of the pipeline scripts; the pipeline writes to Postgres, the
API reads from it, and the frontend never touches the DB directly.

## 7. Design Decisions Worth Noting

- **Multi-city from day one**: every table is scoped by `city_id` even
  though the original use case was a single store, specifically to support
  `batchProcessStores.js`-style scaling without a schema migration later.
- **Society-level geocoding as primary, listing-detail-page coordinates as
  an added precision layer**: geocoding is cache-once-per-society (cheap at
  scale), but was found too imprecise at a 200m cell size, so per-listing
  detail-page coordinates were added as the highest-priority source, with
  society/address geocoding remaining as fallbacks.
- **City-only geocode matches are never treated as "resolved"**: a match
  that only succeeds at the "just the city name" tier is the city's
  centroid, and caching that on a society would incorrectly cluster
  unrelated properties at one point — handled as a distinct "still
  unresolved" case at both the society- and listing-level fallback paths.
- **Full-recompute aggregation over incremental**: chosen for correctness
  (no stale-bucket edge cases) since data volume (thousands of listings) is
  a total, small non-issue for a straight DELETE+INSERT.
- **Analytical grid assignment over spatial queries on the hot path**:
  `assignPropertyToGrid` is pure row/col arithmetic, not a PostGIS
  `ST_Contains` call, so ingestion never pays a spatial-query cost per
  listing; `ST_Contains` validation exists but is deliberately kept off
  that path.
- **Nothing is ever silently dropped**: listings without a resolvable
  location, listings outside the grid radius, and unrecognized BHK strings
  all still get stored/counted, with distinct counters/logging for each
  case, rather than disappearing without a trace.

## 8. Known Gaps / Areas Needing Live Calibration

- The MagicBricks scraper's selectors and JSON-blob patterns are explicitly
  flagged in-code as needing confirmation/recalibration against the live
  site (`SEARCH_URL_TEMPLATE`, `JSON_BLOB_PATTERNS`, pagination mechanics)
  — some paths are marked CONFIRMED via live inspection, others are
  best-guess fallbacks.
- `MAX_PAGES` is hardcoded to `1` in the scraper module itself (separate
  from `config.json`'s `max_pages` field, which does not appear to be read
  by the current scraper code) — worth reconciling.
- No automated test suite exists (`package.json`'s `test` script is a
  placeholder); `verify.js` serves as the closest thing to end-to-end
  validation, but it's a manual/CLI health check, not CI-integrated.
- `noida.geojson` is a leftover Noida-specific boundary overlay from the
  original single-city scope (handled gracefully — see 3.9).
- No authentication/authorization on the API — acceptable for a
  local-only/internal tool as currently run, but worth flagging if this is
  ever deployed beyond localhost.
