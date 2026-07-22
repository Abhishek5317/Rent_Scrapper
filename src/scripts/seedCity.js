/**
 * seedCity.js
 *
 * Run ONCE per city (or whenever cell_size_m / radius_m changes for
 * that city) to populate `cities` and `grids`. This is what makes
 * grid_code stable — ingestion never creates grids on the fly, it
 * only looks them up.
 *
 * Defaults come from config.json (project root) — the same file the
 * scraper reads/auto-resolves. This means after running the scraper
 * once (which reverse-geocodes a raw lat/lng into a real city name and
 * saves it back to config.json), this script can just be run with NO
 * arguments at all and it'll pick up the right values automatically.
 *
 * Run: node seedCity.js                          (uses config.json entirely)
 * Or:  node seedCity.js --radius=3000             (override just one field)
 * Or:  node seedCity.js --name="Noida" --lat=28.5074 --lng=77.3912  (fully manual)
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { generateGridCells } = require("../services/gridService");

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

function loadConfig() {
  const configPath = path.join(__dirname, "..", "..", "config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (e) {
    console.warn(`Couldn't parse config.json (${e.message}) — falling back to CLI args only.`);
    return {};
  }
}

async function run() {
  const args = parseArgs();
  const config = loadConfig();

  // CLI args win if given; otherwise prefer config.store_key (a per-store
  // UNIQUE identifier set by batchProcessStores.js — fixes multiple
  // stores in the same city silently colliding, since city_name alone is
  // identical for every store in that city); falls back to city_name for
  // simple single-store manual runs where store_key was never set.
  const name = args.name || config.store_key || config.city_name;
  const lat = parseFloat(args.lat ?? config.center_lat);
  const lng = parseFloat(args.lng ?? config.center_lng);
  const state = args.state || config.state || null;
  const cellSize = parseInt(args.cellSize || config.cell_size_m || "200", 10);
  const radius = parseInt(args.radius || config.radius_m || "1000", 10);

  if (!name || Number.isNaN(lat) || Number.isNaN(lng)) {
    console.error(
      "Missing city name or coordinates. Either:\n" +
      "  1. Run the scraper first (it auto-resolves city_name into config.json from just center_lat/center_lng), or\n" +
      "  2. Pass them directly: node seedCity.js --name=Noida --lat=28.5074 --lng=77.3912 [--state=...] [--cellSize=200] [--radius=1000]"
    );
    process.exit(1);
  }

  console.log(`Seeding city "${name}" (${lat}, ${lng}) — ${cellSize}m cells, ${radius}m radius`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: existing } = await client.query("SELECT id FROM cities WHERE name = $1", [name]);
    let cityId;

    if (existing.length > 0) {
      cityId = existing[0].id;
      // IMPORTANT: also update the stored radius/cell size, not just
      // generate more grid cells. Missing this was a real bug — without
      // it, ingest.js's assignPropertyToGrid() reads the OLD radius_m
      // from the cities table and silently keeps using the smaller
      // halfGrid boundary, no matter how many new grid cells actually
      // exist in the grids table.
      await client.query(
        `UPDATE cities SET cell_size_m = $1, radius_m = $2 WHERE id = $3`,
        [cellSize, radius, cityId]
      );
      console.log(`City "${name}" already exists (id=${cityId}). Updated to ${cellSize}m cells, ${radius}m radius. Generating any new grid cells needed (existing ones untouched).`);
    } else {
      const { rows } = await client.query(
        `INSERT INTO cities (name, state, origin_lat, origin_lng, cell_size_m, radius_m)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [name, state, lat, lng, cellSize, radius]
      );
      cityId = rows[0].id;
      console.log(`Created city "${name}" (id=${cityId})`);
    }

    const city = { origin_lat: lat, origin_lng: lng, cell_size_m: cellSize, radius_m: radius };
    const cells = generateGridCells(city);

    let inserted = 0;
    for (const cell of cells) {
      await client.query(
        `INSERT INTO grids (
           city_id, grid_code, row_index, col_index,
           south, north, west, east, center_lat, center_lng, geom
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ST_GeomFromText($11, 4326)
         )
         ON CONFLICT (city_id, grid_code) DO NOTHING`,
        [
          cityId, cell.grid_code, cell.row_index, cell.col_index,
          cell.south, cell.north, cell.west, cell.east,
          cell.center_lat, cell.center_lng, cell.geom_wkt,
        ]
      );
      inserted++;
    }

    await client.query("COMMIT");
    console.log(`Seeded ${inserted} grid cells for "${name}" (${cellSize}m cells, ${radius}m radius).`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Seed failed:", e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();