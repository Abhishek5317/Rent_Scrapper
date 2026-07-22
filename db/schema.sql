-- ═══════════════════════════════════════════════════════════════
-- RentIQ — Database Schema
-- PostgreSQL 15+ with PostGIS extension
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- for fuzzy society-name matching

-- ───────────────────────────────────────────────────────────────
-- CITIES
-- Enables multi-city scaling from day one. Every downstream table
-- is scoped by city_id so queries never accidentally cross regions.
-- ───────────────────────────────────────────────────────────────
CREATE TABLE cities (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    state           VARCHAR(100),
    origin_lat      DOUBLE PRECISION NOT NULL,   -- anchor point for grid math (e.g. a store location)
    origin_lng      DOUBLE PRECISION NOT NULL,
    cell_size_m     INTEGER NOT NULL DEFAULT 200,
    radius_m        INTEGER NOT NULL DEFAULT 1000,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_cities_name ON cities(name);

-- ───────────────────────────────────────────────────────────────
-- GRIDS
-- Pre-generated once per city. grid_code is the stable public ID
-- (e.g. "G12") used in the frontend and APIs. row/col let you
-- recompute assignment analytically without touching geometry.
-- geom is the authoritative polygon (PostGIS), used for rendering,
-- ST_Contains validation, and any future non-rectangular grid.
-- ───────────────────────────────────────────────────────────────
CREATE TABLE grids (
    id              SERIAL PRIMARY KEY,
    city_id         INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    grid_code       VARCHAR(20) NOT NULL,          -- e.g. "G12"
    row_index       INTEGER NOT NULL,
    col_index       INTEGER NOT NULL,
    south           DOUBLE PRECISION NOT NULL,
    north           DOUBLE PRECISION NOT NULL,
    west            DOUBLE PRECISION NOT NULL,
    east            DOUBLE PRECISION NOT NULL,
    center_lat      DOUBLE PRECISION NOT NULL,
    center_lng      DOUBLE PRECISION NOT NULL,
    geom            GEOMETRY(Polygon, 4326) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (city_id, grid_code)
);

CREATE INDEX idx_grids_geom ON grids USING GIST (geom);
CREATE INDEX idx_grids_city ON grids (city_id);

-- ───────────────────────────────────────────────────────────────
-- SOCIETIES
-- Normalized separately so "ATS Happy Trails" scraped 40 different
-- ways collapses to one row. normalized_name strips whitespace/case
-- for trigram fuzzy matching during ingestion.
-- ───────────────────────────────────────────────────────────────
CREATE TABLE societies (
    id                  SERIAL PRIMARY KEY,
    city_id             INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    normalized_name     VARCHAR(255) NOT NULL,
    lat                 DOUBLE PRECISION,
    lng                 DOUBLE PRECISION,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_societies_trgm ON societies USING GIN (normalized_name gin_trgm_ops);
CREATE INDEX idx_societies_city ON societies (city_id);

-- ───────────────────────────────────────────────────────────────
-- SCRAPING_RUNS
-- One row per scraper execution. Lets you audit ingestion, detect
-- silent scraper breakage (e.g. record count crashes to 0), and
-- trace any property back to the run that produced it.
-- ───────────────────────────────────────────────────────────────
CREATE TABLE scraping_runs (
    id                  BIGSERIAL PRIMARY KEY,
    city_id             INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    source              VARCHAR(50) NOT NULL DEFAULT 'magicbricks',
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ,
    status              VARCHAR(20) NOT NULL DEFAULT 'running',  -- running / success / failed / partial
    listings_found      INTEGER DEFAULT 0,
    listings_new        INTEGER DEFAULT 0,
    listings_updated    INTEGER DEFAULT 0,
    errors_count        INTEGER DEFAULT 0,
    error_log           JSONB,
    notes               TEXT
);

CREATE INDEX idx_scraping_runs_city ON scraping_runs (city_id, started_at DESC);

-- ───────────────────────────────────────────────────────────────
-- PROPERTIES
-- One row per scraped listing. bhk_type is a normalized string
-- (never hardcoded to a fixed enum) + bhk_numeric for sorting/
-- filtering. grid_id is assigned at ingestion time (analytical
-- math + PostGIS validation — see gridService.js).
-- ───────────────────────────────────────────────────────────────
CREATE TABLE properties (

    id                  BIGSERIAL PRIMARY KEY,
    city_id             INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    grid_id             INTEGER REFERENCES grids(id) ON DELETE SET NULL,
    society_id          INTEGER REFERENCES societies(id) ON DELETE SET NULL,

    source              VARCHAR(50) NOT NULL DEFAULT 'magicbricks',
    listing_url         TEXT NOT NULL,
    property_name       VARCHAR(255),
    address_raw         TEXT,

    lat                 DOUBLE PRECISION NOT NULL,
    lng                 DOUBLE PRECISION NOT NULL,
    geom                GEOMETRY(Point, 4326) GENERATED ALWAYS AS (
                            ST_SetSRID(ST_MakePoint(lng, lat), 4326)
                        ) STORED,

    monthly_rent        NUMERIC(12, 2),
    bhk_raw             VARCHAR(50),               -- exactly what was scraped e.g. "2.5 BHK"
    bhk_type            VARCHAR(30),                -- normalized e.g. "2.5BHK", "1RK", "PENTHOUSE"
    bhk_numeric          NUMERIC(4, 1),              -- 1.0, 2.5 ... NULL for non-numeric configs
    area_sqft           NUMERIC(10, 2),
    furnishing          VARCHAR(30),                -- Furnished / Semi-Furnished / Unfurnished
    property_type       VARCHAR(50),                -- Apartment / Independent House / Villa ...

    raw_metadata        JSONB,                      -- catch-all for anything else scraped
    is_active           BOOLEAN NOT NULL DEFAULT true,   -- false once delisted
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    scraping_run_id     BIGINT REFERENCES scraping_runs(id),

    UNIQUE (listing_url)
);

CREATE INDEX idx_properties_geom ON properties USING GIST (geom);
CREATE INDEX idx_properties_grid ON properties (grid_id) WHERE is_active = true;
CREATE INDEX idx_properties_society ON properties (society_id);
CREATE INDEX idx_properties_bhk ON properties (grid_id, bhk_type) WHERE is_active = true;
CREATE INDEX idx_properties_city_active ON properties (city_id, is_active);

-- ───────────────────────────────────────────────────────────────
-- BHK_BUCKET_STATS  (Section 1 — Rental Analytics)
-- One row per (grid, bhk_type) combination. This is the dynamic
-- bucket table — rows are created/updated as new bhk_types show
-- up in the data, never predefined. Recomputed by the aggregation
-- pipeline after every scraping run.
-- ───────────────────────────────────────────────────────────────
CREATE TABLE bhk_bucket_stats (
    id              BIGSERIAL PRIMARY KEY,
    grid_id         INTEGER NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
    bhk_type        VARCHAR(30) NOT NULL,
    listing_count   INTEGER NOT NULL,
    avg_rent        NUMERIC(12, 2),
    median_rent     NUMERIC(12, 2),
    min_rent        NUMERIC(12, 2),
    max_rent        NUMERIC(12, 2),
    stddev_rent     NUMERIC(12, 2),
    avg_area_sqft   NUMERIC(10, 2),
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (grid_id, bhk_type)
);

CREATE INDEX idx_bucket_stats_grid ON bhk_bucket_stats (grid_id);

-- Added after initial schema design: needed so the API can sort buckets
-- in a sensible order (1RK, 1BHK, 2BHK, 2.5BHK, 3BHK...) rather than
-- alphabetically. IF NOT EXISTS makes this safe to re-run even if
-- schema.sql already ran once without it.
ALTER TABLE bhk_bucket_stats ADD COLUMN IF NOT EXISTS bhk_numeric NUMERIC(4, 1);

-- ───────────────────────────────────────────────────────────────
-- GRID_STATS  (Section 5 — Grid Insights, and the map summary layer)
-- One row per grid: the pre-computed rollup so the "click a grid"
-- interaction never runs a live aggregation query. Denormalizes
-- a couple of fields (dominant_bhk_type, top_society) on purpose —
-- this table exists specifically to make Section 5 a single
-- indexed row-lookup.
-- ───────────────────────────────────────────────────────────────
CREATE TABLE grid_stats (
    grid_id                        INTEGER PRIMARY KEY REFERENCES grids(id) ON DELETE CASCADE,
    total_listings                 INTEGER NOT NULL DEFAULT 0,
    avg_rent                       NUMERIC(12, 2),
    min_rent                       NUMERIC(12, 2),
    max_rent                       NUMERIC(12, 2),
    avg_area_sqft                  NUMERIC(10, 2),
    dominant_bhk_type              VARCHAR(30),
    dominant_bhk_pct               NUMERIC(5, 2),
    second_bhk_type                VARCHAR(30),
    second_bhk_pct                 NUMERIC(5, 2),
    top_society_id                 INTEGER REFERENCES societies(id),
    top_society_listing_count      INTEGER,
    second_society_id              INTEGER REFERENCES societies(id),
    second_society_listing_count   INTEGER,
    computed_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────────────────────────────────────────────
-- View: society leaderboard per grid (Section 4), kept as a view
-- rather than a stored table since "top 2" is cheap to derive on
-- read and doesn't need its own cache-invalidation logic.
-- ───────────────────────────────────────────────────────────────
CREATE VIEW grid_society_counts AS
SELECT
    p.grid_id,
    p.society_id,
    s.name AS society_name,
    COUNT(*) AS listing_count
FROM properties p
JOIN societies s ON s.id = p.society_id
WHERE p.is_active = true
GROUP BY p.grid_id, p.society_id, s.name;

-- ───────────────────────────────────────────────────────────────
-- EXTRACTION_BATCHES
-- One row per CSV-upload-triggered batch run from the web UI — the
-- persisted, pollable equivalent of a batchProcessStores.js invocation.
-- Distinct from scraping_runs (per-CITY, created by ingest.js itself):
-- this is per-BATCH, created by the API before any pipeline step runs,
-- updated live by extractionWorker.js. Powers the run-history page.
-- ───────────────────────────────────────────────────────────────
CREATE TABLE extraction_batches (
    id                  BIGSERIAL PRIMARY KEY,
    status              VARCHAR(20) NOT NULL DEFAULT 'queued',  -- queued/running/success/partial/failed
    total_stores        INTEGER NOT NULL,
    completed_stores    INTEGER NOT NULL DEFAULT 0,
    succeeded_count     INTEGER NOT NULL DEFAULT 0,
    empty_count         INTEGER NOT NULL DEFAULT 0,
    failed_count        INTEGER NOT NULL DEFAULT 0,
    defaults            JSONB,               -- cell_size_m/radius_m/max_pages/cooldown_seconds for this batch
    source_csv_filename VARCHAR(255),
    source_csv_path     TEXT,                -- staged under uploads/, audit only, never re-read
    log_path            TEXT,                -- under logs/ — the ONLY path the log-download endpoint may serve
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ,
    error_message       TEXT                 -- set if the worker process itself crashed outright
);

CREATE INDEX idx_extraction_batches_started ON extraction_batches (started_at DESC);

-- Single-flight enforced at the DB level (not just an app-side check-then-
-- insert): config.json/scraped_listings.jsonl are shared fixed file paths,
-- so two concurrent batches would corrupt each other.
CREATE UNIQUE INDEX idx_extraction_batches_one_active ON extraction_batches ((true))
    WHERE status IN ('queued', 'running');

-- ───────────────────────────────────────────────────────────────
-- EXTRACTION_BATCH_STORES
-- One row per store within a batch — persisted equivalent of
-- batchProcessStores.js's in-memory `results` array. archive_path points
-- at that store's exact scraped_archive/*.jsonl file; download endpoints
-- serve ONLY this DB-recorded path, never a client-supplied filename.
-- ───────────────────────────────────────────────────────────────
CREATE TABLE extraction_batch_stores (
    id                  BIGSERIAL PRIMARY KEY,
    batch_id            BIGINT NOT NULL REFERENCES extraction_batches(id) ON DELETE CASCADE,
    store_index         INTEGER NOT NULL,
    label               VARCHAR(255) NOT NULL,
    center_lat          DOUBLE PRECISION NOT NULL,
    center_lng          DOUBLE PRECISION NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending/running/success/empty/failed
    store_key           VARCHAR(90),          -- sanitized label = the cities.name value actually used
    city_id             INTEGER REFERENCES cities(id) ON DELETE SET NULL,
    resolved_city_name  VARCHAR(100),         -- real city (e.g. "Ghaziabad") from reverse-geocoding
    listing_count       INTEGER NOT NULL DEFAULT 0,
    archive_path        TEXT,
    error_message       TEXT,
    started_at          TIMESTAMPTZ,
    finished_at         TIMESTAMPTZ,

    UNIQUE (batch_id, store_index)
);

CREATE INDEX idx_extraction_batch_stores_batch ON extraction_batch_stores (batch_id, store_index);