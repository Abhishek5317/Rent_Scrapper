/**
 * routes/properties.js
 *
 * A global, filterable, paginated browser over the `properties` table —
 * distinct from routes/grids.js's per-grid-cell listing endpoint. This
 * is what powers listings.html: "show me every scraped listing across
 * every store, filtered by X" rather than "show me one grid cell's
 * listings after clicking it on the map".
 *
 * Note on naming: cities.name is now effectively a per-STORE key (see
 * extractionPipeline.js's sanitizeStoreKey), not a true city name — e.g.
 * "Domino's Rajendra Nagar Sahibabad Ghaziabad", not "Ghaziabad". The
 * filter param and response field are named `store` here (not `city`) to
 * match what GET /api/cities actually returns, and the frontend labels
 * it "Store / Location".
 */

const express = require("express");
const pool = require("../db");

const router = express.Router();

// GET /properties?store=&bhk_type=&min_rent=&max_rent=&society=&furnishing=&property_type=&limit=&offset=
router.get("/properties", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const offset = parseInt(req.query.offset, 10) || 0;

  const conditions = ["p.is_active = true"];
  const params = [];

  function addFilter(sql, value) {
    params.push(value);
    conditions.push(sql.replace("?", `$${params.length}`));
  }

  if (req.query.store) addFilter("c.name = ?", req.query.store);
  if (req.query.bhk_type) addFilter("p.bhk_type = ?", req.query.bhk_type);
  if (req.query.furnishing) addFilter("p.furnishing = ?", req.query.furnishing);
  if (req.query.property_type) addFilter("p.property_type = ?", req.query.property_type);
  if (req.query.min_rent) addFilter("p.monthly_rent >= ?", parseFloat(req.query.min_rent));
  if (req.query.max_rent) addFilter("p.monthly_rent <= ?", parseFloat(req.query.max_rent));
  if (req.query.society) addFilter("s.name ILIKE ?", `%${req.query.society}%`); // benefits from the existing idx_societies_trgm GIN index

  const whereClause = conditions.join(" AND ");

  try {
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM properties p
       JOIN cities c ON c.id = p.city_id
       LEFT JOIN societies s ON s.id = p.society_id
       WHERE ${whereClause}`,
      params
    );

    const { rows } = await pool.query(
      `SELECT p.id, p.property_name, s.name AS society_name, c.name AS store_name, c.state,
              g.grid_code, p.bhk_type, p.monthly_rent, p.area_sqft, p.furnishing, p.property_type,
              p.listing_url, p.first_seen_at, p.last_seen_at,
              p.raw_metadata -> 'amenities' AS amenities
       FROM properties p
       JOIN cities c ON c.id = p.city_id
       LEFT JOIN grids g ON g.id = p.grid_id
       LEFT JOIN societies s ON s.id = p.society_id
       WHERE ${whereClause}
       ORDER BY p.last_seen_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      total_count: parseInt(countRows[0].count, 10),
      limit,
      offset,
      properties: rows,
    });
  } catch (e) {
    console.error("GET /properties failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /properties/filters — distinct values for the listings page's
// dropdowns. The store/location dropdown reuses the EXISTING GET /cities
// (not duplicated here).
router.get("/properties/filters", async (req, res) => {
  try {
    const [bhkTypes, furnishings, propertyTypes] = await Promise.all([
      pool.query("SELECT DISTINCT bhk_type FROM properties WHERE bhk_type IS NOT NULL AND is_active = true ORDER BY bhk_type"),
      pool.query("SELECT DISTINCT furnishing FROM properties WHERE furnishing IS NOT NULL AND is_active = true ORDER BY furnishing"),
      pool.query("SELECT DISTINCT property_type FROM properties WHERE property_type IS NOT NULL AND is_active = true ORDER BY property_type"),
    ]);

    res.json({
      bhk_types: bhkTypes.rows.map((r) => r.bhk_type),
      furnishings: furnishings.rows.map((r) => r.furnishing),
      property_types: propertyTypes.rows.map((r) => r.property_type),
    });
  } catch (e) {
    console.error("GET /properties/filters failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
