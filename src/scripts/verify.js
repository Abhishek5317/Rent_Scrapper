/**
 * verify.js
 *
 * Run this after each stage of the pipeline to get a clear pass/fail
 * readout instead of guessing from silence. Checks, in order:
 *
 *   1. Schema exists (tables + PostGIS)
 *   2. City + grids were seeded correctly
 *   3. Scraper output file looks sane (BEFORE you even touch the DB)
 *   4. Ingestion actually landed rows, and how many succeeded vs. were
 *      skipped/failed, broken down by reason
 *   5. Data quality spot-checks (nulls where there shouldn't be any,
 *      grid distribution, society geocode coverage)
 *
 * Run: node verify.js --city=Noida [--scraped=scraped_listings.jsonl]
 */

const fs = require("fs");
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

function pass(label, detail = "") {
  console.log(`  ✅ ${label}${detail ? " — " + detail : ""}`);
}
function fail(label, detail = "") {
  console.log(`  ❌ ${label}${detail ? " — " + detail : ""}`);
}
function warn(label, detail = "") {
  console.log(`  ⚠️  ${label}${detail ? " — " + detail : ""}`);
}

async function checkSchema(client) {
  console.log("\n[1] Schema check");
  const expected = ["cities", "grids", "societies", "properties", "scraping_runs", "bhk_bucket_stats", "grid_stats"];
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  );
  const existing = rows.map((r) => r.table_name);

  for (const table of expected) {
    if (existing.includes(table)) pass(`table "${table}" exists`);
    else fail(`table "${table}" MISSING`, "run schema.sql");
  }

  try {
    const { rows: pgis } = await client.query("SELECT postgis_version()");
    pass("PostGIS extension active", pgis[0].postgis_version);
  } catch (e) {
    fail("PostGIS extension NOT active", "run: CREATE EXTENSION postgis;");
  }
}

async function checkCityAndGrids(client, cityName) {
  console.log("\n[2] City + grid seed check");
  const { rows: cities } = await client.query("SELECT * FROM cities WHERE name = $1", [cityName]);
  if (cities.length === 0) {
    fail(`City "${cityName}" not found`, `run: node seedCity.js --name=${cityName} --lat=... --lng=...`);
    return null;
  }
  const city = cities[0];
  pass(`City "${cityName}" found`, `id=${city.id}, ${city.cell_size_m}m cells, ${city.radius_m}m radius`);

  const { rows: gridCount } = await client.query("SELECT COUNT(*) FROM grids WHERE city_id = $1", [city.id]);
  const count = parseInt(gridCount[0].count, 10);
  const expectedCount = Math.pow(2 * Math.ceil(city.radius_m / city.cell_size_m) + 1, 2);

  if (count === expectedCount) pass(`Grid count correct`, `${count} cells`);
  else if (count === 0) fail(`Zero grids found`, `run seedCity.js — grids table is empty`);
  else warn(`Grid count is ${count}, expected ${expectedCount}`, "check for a partial/failed seed run");

  return city;
}

function checkScrapedFile(path) {
  console.log("\n[3] Scraper output file check");
  if (!path) {
    warn("No --scraped path given, skipping this check");
    return;
  }
  if (!fs.existsSync(path)) {
    fail(`File not found: ${path}`);
    return;
  }

  const lines = fs.readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
  if (lines.length === 0) {
    fail("File exists but has ZERO lines", "scraper likely hit a bot-check wall or selectors are stale — check scraper.log and bootstrap_debug.png");
    return;
  }
  pass(`File has listings`, `${lines.length} lines`);

  let parseErrors = 0, missingRent = 0, missingBhk = 0, missingSociety = 0;
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item.monthly_rent == null) missingRent++;
      if (!item.bhk_raw) missingBhk++;
      if (!item.society_name) missingSociety++;
    } catch {
      parseErrors++;
    }
  }

  if (parseErrors > 0) fail(`${parseErrors} lines failed to parse as JSON`);
  else pass("All lines are valid JSON");

  const pct = (n) => ((n / lines.length) * 100).toFixed(0);
  if (missingRent / lines.length > 0.3) warn(`${missingRent} listings (${pct(missingRent)}%) missing monthly_rent`, "price selector may need calibration");
  else pass(`Rent field populated`, `${lines.length - missingRent}/${lines.length}`);

  if (missingBhk / lines.length > 0.1) warn(`${missingBhk} listings (${pct(missingBhk)}%) missing bhk_raw`);
  else pass(`BHK field populated`, `${lines.length - missingBhk}/${lines.length}`);

  if (missingSociety / lines.length > 0.3) warn(`${missingSociety} listings (${pct(missingSociety)}%) missing society_name`, "these will fall back to address-level geocoding — slower, coarser");
  else pass(`Society field populated`, `${lines.length - missingSociety}/${lines.length}`);
}

async function checkIngestion(client, city) {
  console.log("\n[4] Ingestion check");
  if (!city) {
    warn("Skipping — no city to check against");
    return;
  }

  const { rows: propCount } = await client.query(
    "SELECT COUNT(*) FROM properties WHERE city_id = $1", [city.id]
  );
  const count = parseInt(propCount[0].count, 10);
  if (count === 0) {
    fail("Zero properties in DB for this city", "ingest.js hasn't run successfully yet, or every listing was skipped — check its console output");
    return;
  }
  pass(`Properties in DB`, `${count} rows`);

  const { rows: runs } = await client.query(
    `SELECT status, listings_found, errors_count, started_at, finished_at
     FROM scraping_runs WHERE city_id = $1 ORDER BY started_at DESC LIMIT 1`,
    [city.id]
  );
  if (runs.length > 0) {
    const run = runs[0];
    const durationSec = run.finished_at
      ? Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000)
      : null;
    if (run.status === "success") pass(`Last scraping_run: success`, `${run.listings_found} listings, ${run.errors_count} errors, ${durationSec}s`);
    else warn(`Last scraping_run status: ${run.status}`);
  }

  const { rows: nullGrid } = await client.query(
    "SELECT COUNT(*) FROM properties WHERE city_id = $1 AND grid_id IS NULL", [city.id]
  );
  const nullGridCount = parseInt(nullGrid[0].count, 10);
  const pctNullGrid = ((nullGridCount / count) * 100).toFixed(0);
  if (nullGridCount === 0) pass("All properties have a grid_id assigned");
  else if (nullGridCount / count > 0.3) fail(`${nullGridCount} properties (${pctNullGrid}%) have NO grid_id`, "likely outside the 1000m analysis radius, or grids weren't seeded before ingestion ran");
  else warn(`${nullGridCount} properties (${pctNullGrid}%) have no grid_id`, "expected for listings genuinely outside the radius");

  const { rows: nullSociety } = await client.query(
    "SELECT COUNT(*) FROM properties WHERE city_id = $1 AND society_id IS NULL", [city.id]
  );
  pass(`Properties without a society`, `${nullSociety[0].count}/${count} (these still have grid_id via address-level geocode fallback)`);
}

async function checkDataQuality(client, city) {
  console.log("\n[5] Data quality spot-checks");
  if (!city) {
    warn("Skipping — no city to check against");
    return;
  }

  // NOTE: societies are frequently left ungeocoded ON PURPOSE now — once
  // the scraper started pulling precise per-listing coordinates from each
  // detail page, resolveSociety() correctly SKIPS its own (coarser, slower)
  // geocode call whenever a listing already has one (see skipGeocode in
  // ingest.js). So "0% societies geocoded" is often a sign the better path
  // is working, not a problem. What actually matters is whether PROPERTIES
  // have coordinates — checked separately below.
  const { rows: propCoords } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL) AS with_coords, COUNT(*) AS total
     FROM properties WHERE city_id = $1`,
    [city.id]
  );
  const { with_coords, total: totalProps } = propCoords[0];
  if (totalProps > 0) {
    if (with_coords == totalProps) pass(`All properties have coordinates`, `${with_coords}/${totalProps}`);
    else warn(`${with_coords}/${totalProps} properties have coordinates`, "the rest have no usable location from any source (listing, society, or address fallback)");
  }

  const { rows: geoCoverage } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL) AS geocoded, COUNT(*) AS total
     FROM societies WHERE city_id = $1`,
    [city.id]
  );
  const { geocoded, total } = geoCoverage[0];
  if (total > 0) {
    const pct = ((geocoded / total) * 100).toFixed(0);
    console.log(`  ℹ️  Societies geocoded independently: ${geocoded}/${total} (${pct}%) — low is fine if properties above have coordinates from their own detail pages instead`);
  } else {
    warn("No societies in DB yet");
  }

  const { rows: bhkDist } = await client.query(
    `SELECT bhk_type, COUNT(*) FROM properties WHERE city_id = $1 GROUP BY bhk_type ORDER BY COUNT(*) DESC`,
    [city.id]
  );
  if (bhkDist.length > 0) {
    console.log("  ℹ️  BHK distribution:");
    bhkDist.forEach((r) => console.log(`       ${r.bhk_type}: ${r.count}`));
    if (bhkDist.length === 1) warn("Only ONE bhk_type present", "either a very narrow scrape, or bhkNormalizer/scraper isn't capturing variety — worth a manual look");
  }

  const { rows: rentRange } = await client.query(
    `SELECT MIN(monthly_rent), MAX(monthly_rent), AVG(monthly_rent)::int
     FROM properties WHERE city_id = $1 AND monthly_rent IS NOT NULL`,
    [city.id]
  );
  const r = rentRange[0];
  if (r.min == null) {
    fail("No monthly_rent values at all", "price extraction is failing across the board — recheck the price selector");
  } else {
    pass(`Rent range sane?`, `min=₹${r.min}, max=₹${r.max}, avg=₹${r.avg}`);
    // City-agnostic check: flag a max that's wildly disproportionate to
    // the average, rather than an absolute number tuned to one city's
    // price scale. A real Mumbai luxury rental can legitimately exceed
    // what would be suspicious in Noida — what actually indicates a
    // parsing bug (like the earlier sale-price/rent mixup) is a rent
    // sitting many times higher than everything else in the same
    // dataset, regardless of which city that dataset is for.
    const maxToAvgRatio = r.max / r.avg;
    if (maxToAvgRatio > 8) {
      warn(`Max rent is ${maxToAvgRatio.toFixed(1)}x the average`, "possible parsing bug (e.g. picked up a deposit, sale price, or estimate figure instead of rent) — worth spot-checking that specific listing");
    }
  }
}

async function run() {
  const args = parseArgs();
  const cityName = args.city || "Noida";

  console.log(`\n═══ RentIQ Pipeline Health Check: "${cityName}" ═══`);

  const client = await pool.connect();
  try {
    await checkSchema(client);
    const city = await checkCityAndGrids(client, cityName);
    checkScrapedFile(args.scraped);
    await checkIngestion(client, city);
    await checkDataQuality(client, city);
    console.log("\n═══ Done ═══\n");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e) => {
  console.error("\nHealth check crashed:", e.message);
  process.exit(1);
});