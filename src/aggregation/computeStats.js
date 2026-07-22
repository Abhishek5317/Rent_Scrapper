/**
 * computeStats.js
 *
 * Stage 3 of the pipeline: turns raw `properties` rows into the actual
 * analytics the frontend will display when someone clicks a grid cell.
 *
 * Two outputs, both full-recompute (DELETE + INSERT) rather than
 * incremental — at this scale (thousands of listings) a full recompute
 * is fast and eliminates an entire class of "stale bucket" bugs (e.g.
 * a bhk_type that had listings last run but has none now would leave a
 * dangling row behind under an incremental approach).
 *
 *   1. bhk_bucket_stats — one row per (grid, bhk_type): count, avg,
 *      median, min, max, stddev, avg area. This is Section 1 of the
 *      spec (rental analytics grouped by BHK bucket).
 *
 *   2. grid_stats — one row per grid: total listings, overall rent
 *      range, dominant + second-most-common BHK type (with %), and
 *      top + second-most-active society. This is Section 5 (grid
 *      insights) plus what Section 3/4 need (most important housing
 *      types, most active societies).
 *
 * Run: node computeStats.js --city=Noida
 */

const { Pool } = require("pg");

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        // Discrete fields avoid URL-encoding problems entirely -- a
        // password containing @, :, /, %, #, etc. would otherwise need
        // careful percent-encoding to survive being embedded in a
        // connection-string URL. This sidesteps that whole class of bugs.
        host: process.env.PGHOST || "localhost",
        port: parseInt(process.env.PGPORT || "5432", 10),
        user: process.env.PGUSER || "postgres",
        password: process.env.PGPASSWORD || "postgres",
        database: process.env.PGDATABASE || "skymark",
      }
);

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    const m = arg.match(/^--(\w+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  });
  return args;
}

async function getCity(client, cityName) {
  const { rows } = await client.query("SELECT * FROM cities WHERE name = $1", [cityName]);
  if (rows.length === 0) {
    throw new Error(`City "${cityName}" not found — seed it first.`);
  }
  return rows[0];
}

/**
 * Section 1 data: per-grid, per-BHK-type statistics.
 * Uses Postgres's built-in PERCENTILE_CONT for a true median (not just
 * an approximation) and STDDEV for the optional spread metric.
 */
async function recomputeBucketStats(client, cityId) {
  await client.query(
    `DELETE FROM bhk_bucket_stats WHERE grid_id IN (SELECT id FROM grids WHERE city_id = $1)`,
    [cityId]
  );

  const { rowCount } = await client.query(
    `INSERT INTO bhk_bucket_stats (
       grid_id, bhk_type, bhk_numeric, listing_count, avg_rent, median_rent,
       min_rent, max_rent, stddev_rent, avg_area_sqft, computed_at
     )
     SELECT
       p.grid_id,
       p.bhk_type,
       MIN(p.bhk_numeric) AS bhk_numeric,
       COUNT(*) AS listing_count,
       AVG(p.monthly_rent) AS avg_rent,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.monthly_rent) AS median_rent,
       MIN(p.monthly_rent) AS min_rent,
       MAX(p.monthly_rent) AS max_rent,
       STDDEV(p.monthly_rent) AS stddev_rent,
       AVG(p.area_sqft) AS avg_area_sqft,
       now()
     FROM properties p
     JOIN grids g ON p.grid_id = g.id
     WHERE g.city_id = $1
       AND p.is_active = true
       AND p.grid_id IS NOT NULL
       AND p.monthly_rent IS NOT NULL
       AND p.bhk_type IS NOT NULL
     GROUP BY p.grid_id, p.bhk_type`,
    [cityId]
  );

  return rowCount;
}

/**
 * Section 5 (+ 3/4) data: one row per grid summarizing the whole thing.
 * Done in two steps — fetch the raw grouped counts, rank them in JS —
 * rather than one dense self-joining SQL query. This is meant to be
 * readable and debuggable by a second person (or you, in three months),
 * not just correct.
 */
async function recomputeGridStats(client, cityId) {
  const { rows: overall } = await client.query(
    `SELECT
       p.grid_id,
       COUNT(*) AS total_listings,
       AVG(p.monthly_rent) AS avg_rent,
       MIN(p.monthly_rent) AS min_rent,
       MAX(p.monthly_rent) AS max_rent,
       AVG(p.area_sqft) AS avg_area_sqft
     FROM properties p
     JOIN grids g ON p.grid_id = g.id
     WHERE g.city_id = $1 AND p.is_active = true AND p.grid_id IS NOT NULL AND p.monthly_rent IS NOT NULL
     GROUP BY p.grid_id`,
    [cityId]
  );

  const { rows: bhkCounts } = await client.query(
    `SELECT p.grid_id, p.bhk_type, COUNT(*) AS cnt
     FROM properties p
     JOIN grids g ON p.grid_id = g.id
     WHERE g.city_id = $1 AND p.is_active = true AND p.grid_id IS NOT NULL AND p.bhk_type IS NOT NULL
     GROUP BY p.grid_id, p.bhk_type`,
    [cityId]
  );

  const { rows: societyCounts } = await client.query(
    `SELECT p.grid_id, s.id AS society_id, COUNT(*) AS cnt
     FROM properties p
     JOIN grids g ON p.grid_id = g.id
     JOIN societies s ON p.society_id = s.id
     WHERE g.city_id = $1 AND p.is_active = true AND p.grid_id IS NOT NULL
     GROUP BY p.grid_id, s.id`,
    [cityId]
  );

  const bhkByGrid = _groupAndRank(bhkCounts, "grid_id", "cnt");
  const societyByGrid = _groupAndRank(societyCounts, "grid_id", "cnt");

  await client.query(
    `DELETE FROM grid_stats WHERE grid_id IN (SELECT id FROM grids WHERE city_id = $1)`,
    [cityId]
  );

  let written = 0;
  for (const row of overall) {
    const total = parseInt(row.total_listings, 10);
    const topBhk = bhkByGrid.get(row.grid_id) || [];
    const topSoc = societyByGrid.get(row.grid_id) || [];

    await client.query(
      `INSERT INTO grid_stats (
         grid_id, total_listings, avg_rent, min_rent, max_rent, avg_area_sqft,
         dominant_bhk_type, dominant_bhk_pct, second_bhk_type, second_bhk_pct,
         top_society_id, top_society_listing_count,
         second_society_id, second_society_listing_count, computed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())`,
      [
        row.grid_id,
        total,
        row.avg_rent,
        row.min_rent,
        row.max_rent,
        row.avg_area_sqft,
        topBhk[0]?.key ?? null,
        topBhk[0] ? _pct(topBhk[0].cnt, total) : null,
        topBhk[1]?.key ?? null,
        topBhk[1] ? _pct(topBhk[1].cnt, total) : null,
        topSoc[0]?.key ?? null,
        topSoc[0]?.cnt ?? null,
        topSoc[1]?.key ?? null,
        topSoc[1]?.cnt ?? null,
      ]
    );
    written++;
  }

  return written;
}

/**
 * Groups rows by groupKey, sorts each group descending by countKey,
 * returns a Map<groupValue, [{key, cnt}, ...]> — i.e. per-grid ranked
 * lists, ready to read top-1/top-2 off the front.
 */
function _groupAndRank(rows, groupKey, countKey) {
  const map = new Map();
  for (const row of rows) {
    const group = row[groupKey];
    if (!map.has(group)) map.set(group, []);
    // bhk rows use "bhk_type" as their label field, society rows use "society_id"
    const label = row.bhk_type !== undefined ? row.bhk_type : row.society_id;
    map.get(group).push({ key: label, cnt: parseInt(row[countKey], 10) });
  }
  for (const list of map.values()) {
    list.sort((a, b) => b.cnt - a.cnt);
  }
  return map;
}

function _pct(count, total) {
  if (!total) return null;
  return Math.round((count / total) * 10000) / 100; // 2 decimal places
}

async function run() {
  const args = parseArgs();
  const cityName = args.city || "Noida";

  const client = await pool.connect();
  try {
    const city = await getCity(client, cityName);
    console.log(`Computing stats for "${city.name}" (id=${city.id})...`);

    const bucketRows = await recomputeBucketStats(client, city.id);
    console.log(`  bhk_bucket_stats: ${bucketRows} rows written`);

    const gridRows = await recomputeGridStats(client, city.id);
    console.log(`  grid_stats: ${gridRows} rows written`);

    console.log("Done.");
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { _groupAndRank, _pct }; // exported for testing

if (require.main === module) {
  run().catch((e) => {
    console.error("Aggregation failed:", e.message);
    process.exit(1);
  });
}