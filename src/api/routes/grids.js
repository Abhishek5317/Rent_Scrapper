/**
 * routes/grids.js
 *
 * Endpoints, mapped directly to the spec's UI sections:
 *
 *   GET /grids                       — list all grids for a city (map overlay data)
 *   GET /grids/:gridCode             — Section 5: grid insights summary
 *   GET /grids/:gridCode/properties  — Section 2: full property listings
 *   GET /grids/:gridCode/statistics  — Section 1 + 3: BHK buckets + top housing types
 *   GET /grids/:gridCode/societies   — Section 4: most active societies
 *
 * All endpoints take ?city=Noida (defaults to "Noida" if omitted) since
 * the schema is multi-city from day one.
 *
 * Every response follows the same error shape on failure:
 *   { error: "message" } with an appropriate HTTP status —
 *   404 for "doesn't exist", 500 for anything unexpected — so the
 *   frontend has one consistent shape to handle rather than guessing
 *   per-endpoint.
 */

const express = require("express");
const pool = require("../db");

const router = express.Router();

async function resolveCityAndGrid(cityName, gridCode) {
  const { rows: cityRows } = await pool.query("SELECT * FROM cities WHERE name = $1", [cityName]);
  if (cityRows.length === 0) return { error: `City "${cityName}" not found`, status: 404 };
  const city = cityRows[0];

  const { rows: gridRows } = await pool.query(
    "SELECT * FROM grids WHERE city_id = $1 AND grid_code = $2",
    [city.id, gridCode]
  );
  if (gridRows.length === 0) {
    return { error: `Grid "${gridCode}" not found in city "${cityName}"`, status: 404 };
  }

  return { city, grid: gridRows[0] };
}

// GET /cities
// Lists every seeded city with its center/radius/cell config — used by
// the frontend to figure out which (if any) scraped city a user-entered
// lat/lng falls within, so someone can type in coordinates directly
// instead of editing config.json.
router.get("/cities", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT name, state, origin_lat, origin_lng, cell_size_m, radius_m FROM cities ORDER BY name"
    );
    res.json({ cities: rows });
  } catch (e) {
    console.error("GET /cities failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /grids?city=Noida
// Overlay data for the map — every grid cell's bounds + a quick listing
// count, so the frontend can shade cells by density without a second
// round-trip per cell.
router.get("/grids", async (req, res) => {
  const cityName = req.query.city || "Noida";
  try {
    const { rows: cityRows } = await pool.query("SELECT * FROM cities WHERE name = $1", [cityName]);
    if (cityRows.length === 0) {
      return res.status(404).json({ error: `City "${cityName}" not found` });
    }
    const city = cityRows[0];

    const { rows } = await pool.query(
      `SELECT g.grid_code, g.row_index, g.col_index, g.south, g.north, g.west, g.east,
              g.center_lat, g.center_lng, COALESCE(gs.total_listings, 0) AS total_listings
       FROM grids g
       LEFT JOIN grid_stats gs ON gs.grid_id = g.id
       WHERE g.city_id = $1
       ORDER BY g.row_index, g.col_index`,
      [city.id]
    );

    res.json({
      city: city.name,
      cell_size_m: city.cell_size_m,
      radius_m: city.radius_m,
      grid_count: rows.length,
      grids: rows,
    });
  } catch (e) {
    console.error("GET /grids failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /grids/:gridCode?city=Noida
// Section 5: grid insights summary.
router.get("/grids/:gridCode", async (req, res) => {
  const cityName = req.query.city || "Noida";
  const { gridCode } = req.params;

  try {
    const resolved = await resolveCityAndGrid(cityName, gridCode);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { grid } = resolved;

    const { rows: statRows } = await pool.query(
      `SELECT gs.*, ts.name AS top_society_name, ss.name AS second_society_name
       FROM grid_stats gs
       LEFT JOIN societies ts ON ts.id = gs.top_society_id
       LEFT JOIN societies ss ON ss.id = gs.second_society_id
       WHERE gs.grid_id = $1`,
      [grid.id]
    );

    if (statRows.length === 0) {
      return res.json({
        grid_code: grid.grid_code,
        bounds: { south: grid.south, north: grid.north, west: grid.west, east: grid.east },
        center: { lat: grid.center_lat, lng: grid.center_lng },
        insights: null,
        message: "No statistics computed yet for this grid — run the aggregation pipeline after scraping.",
      });
    }

    const s = statRows[0];
    res.json({
      grid_code: grid.grid_code,
      bounds: { south: grid.south, north: grid.north, west: grid.west, east: grid.east },
      center: { lat: grid.center_lat, lng: grid.center_lng },
      insights: {
        total_listings: s.total_listings,
        avg_rent: _round(s.avg_rent),
        min_rent: s.min_rent,
        max_rent: s.max_rent,
        avg_area_sqft: _round(s.avg_area_sqft),
        rent_range: { min: s.min_rent, max: s.max_rent },
        dominant_housing_type: s.dominant_bhk_type
          ? { bhk_type: s.dominant_bhk_type, pct: s.dominant_bhk_pct }
          : null,
        second_housing_type: s.second_bhk_type
          ? { bhk_type: s.second_bhk_type, pct: s.second_bhk_pct }
          : null,
        most_active_society: s.top_society_name
          ? { name: s.top_society_name, listing_count: s.top_society_listing_count }
          : null,
        computed_at: s.computed_at,
      },
    });
  } catch (e) {
    console.error(`GET /grids/${gridCode} failed:`, e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /grids/:gridCode/properties?city=Noida&limit=&offset=
// Section 2: every scraped property in the grid, so a user can inspect
// the raw listings behind the aggregated stats.
router.get("/grids/:gridCode/properties", async (req, res) => {
  const cityName = req.query.city || "Noida";
  const { gridCode } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = parseInt(req.query.offset, 10) || 0;

  try {
    const resolved = await resolveCityAndGrid(cityName, gridCode);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { grid } = resolved;

    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*) FROM properties WHERE grid_id = $1 AND is_active = true",
      [grid.id]
    );

    const { rows } = await pool.query(
      `SELECT p.id, p.property_name, s.name AS society_name, p.bhk_type, p.monthly_rent,
              p.area_sqft, p.furnishing, p.property_type, p.address_raw, p.listing_url,
              p.raw_metadata -> 'amenities' AS amenities
       FROM properties p
       LEFT JOIN societies s ON p.society_id = s.id
       WHERE p.grid_id = $1 AND p.is_active = true
       ORDER BY p.monthly_rent ASC NULLS LAST
       LIMIT $2 OFFSET $3`,
      [grid.id, limit, offset]
    );

    res.json({
      grid_code: grid.grid_code,
      total_count: parseInt(countRows[0].count, 10),
      limit,
      offset,
      properties: rows,
    });
  } catch (e) {
    console.error(`GET /grids/${gridCode}/properties failed:`, e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /grids/:gridCode/statistics?city=Noida
// Section 1 (per-BHK bucket analytics) + Section 3 (top 2 housing types).
router.get("/grids/:gridCode/statistics", async (req, res) => {
  const cityName = req.query.city || "Noida";
  const { gridCode } = req.params;

  try {
    const resolved = await resolveCityAndGrid(cityName, gridCode);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { grid } = resolved;

    const { rows: buckets } = await pool.query(
      `SELECT bhk_type, bhk_numeric, listing_count, avg_rent, median_rent,
              min_rent, max_rent, stddev_rent, avg_area_sqft
       FROM bhk_bucket_stats
       WHERE grid_id = $1
       ORDER BY bhk_numeric ASC NULLS LAST, bhk_type ASC`,
      [grid.id]
    );

    const totalListings = buckets.reduce((sum, b) => sum + b.listing_count, 0);
    const topHousingTypes = [...buckets]
      .sort((a, b) => b.listing_count - a.listing_count)
      .slice(0, 2)
      .map((b) => ({
        bhk_type: b.bhk_type,
        listing_count: b.listing_count,
        pct: totalListings ? Math.round((b.listing_count / totalListings) * 10000) / 100 : null,
      }));

    res.json({
      grid_code: grid.grid_code,
      buckets: buckets.map((b) => ({
        bhk_type: b.bhk_type,
        listing_count: b.listing_count,
        avg_rent: _round(b.avg_rent),
        median_rent: _round(b.median_rent),
        min_rent: b.min_rent,
        max_rent: b.max_rent,
        stddev_rent: _round(b.stddev_rent),
        avg_area_sqft: _round(b.avg_area_sqft),
        rent_range: { min: b.min_rent, max: b.max_rent },
      })),
      top_housing_types: topHousingTypes,
    });
  } catch (e) {
    console.error(`GET /grids/${gridCode}/statistics failed:`, e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /grids/:gridCode/societies?city=Noida&limit=2
// Section 4: most active residential societies. Queries the live view
// (not just the precomputed top-2 in grid_stats) so ?limit= can go
// beyond 2 if the frontend ever wants a fuller breakdown.
router.get("/grids/:gridCode/societies", async (req, res) => {
  const cityName = req.query.city || "Noida";
  const { gridCode } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 2, 50);

  try {
    const resolved = await resolveCityAndGrid(cityName, gridCode);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { grid } = resolved;

    const { rows } = await pool.query(
      `SELECT society_id, society_name, listing_count
       FROM grid_society_counts
       WHERE grid_id = $1
       ORDER BY listing_count DESC
       LIMIT $2`,
      [grid.id, limit]
    );

    res.json({
      grid_code: grid.grid_code,
      top_societies: rows.map((r) => ({
        society_id: r.society_id,
        name: r.society_name,
        listing_count: r.listing_count,
      })),
    });
  } catch (e) {
    console.error(`GET /grids/${gridCode}/societies failed:`, e);
    res.status(500).json({ error: "Internal server error" });
  }
});

function _round(val) {
  if (val == null) return null;
  return Math.round(parseFloat(val) * 100) / 100;
}

module.exports = router;