/**
 * ingest.js
 *
 * Reads the JSONL file produced by magicbricks_scraper.py and loads it
 * into Postgres. Each line becomes one `properties` row, going through:
 *
 *   1. BHK normalization        (bhkNormalizer.js)
 *   2. Grid assignment          (gridService.js — analytical, no DB hit)
 *   3. Society resolution       (find-or-create with trigram fuzzy match,
 *                                 same idea as PriceScout's Levenshtein +
 *                                 synonym map, but using Postgres pg_trgm
 *                                 since it's already in the DB layer)
 *   4. Upsert into `properties` (ON CONFLICT listing_url -> update,
 *                                 so re-scrapes refresh price/status
 *                                 instead of duplicating rows)
 *
 * Run: node ingest.js --city="Noida" --input=scraped_listings.jsonl
 */

const fs = require("fs");
const readline = require("readline");
const { Pool } = require("pg");
const { normalizeBhk } = require("../services/bhkNormalizer");
const { assignPropertyToGrid } = require("../services/gridService");
const { geocodeWithFallbacks } = require("../services/geocoder");

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

const SOCIETY_MATCH_THRESHOLD = 0.6; // raised from 0.45 — that was loose enough to
// fuzzy-match genuinely different societies against each other, especially ones
// sharing common words like "Sector", "Apartment", "Noida"

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
    throw new Error(
      `City "${cityName}" not found. Seed it first (see seedCity.js) before ingesting.`
    );
  }
  return rows[0];
}

/**
 * A geocode that only succeeded on its LAST-resort tier (city name alone,
 * e.g. "Noida, India") is not a useful location — it's the city's centroid,
 * shared by every listing anywhere in a large city. Treating that as a
 * "successfully geocoded" result and caching it on the society row is
 * actively harmful: fuzzy-matching later reuses it for unrelated societies,
 * silently clustering unrelated properties at one point kilometers from
 * where they actually are. This detects that specific case so callers can
 * treat it as "still unresolved" instead.
 */
function _isCityOnlyMatch(geo, cityName) {
  return geo && geo.matchedQuery === `${cityName}, India`;
}

/**
 * Find an existing society within the same city whose normalized name
 * is a close trigram match, or create a new one. This is the same
 * problem PriceScout solved with Levenshtein + a synonym map for menu
 * items — here it's society names, and pg_trgm's GIN index makes the
 * fuzzy lookup a single indexed query instead of an O(n) scan.
 *
 * Returns {id, lat, lng} rather than just id: since MagicBricks' SRP
 * pages don't expose per-listing coordinates (confirmed — JSON-LD only
 * has price/agent/name, no geo), properties inherit their society's
 * geocoded location. Geocoding happens ONCE per society and is cached
 * forever in societies.lat/lng — this function backfills that cache
 * on first sight of a society and reuses it on every match after.
 *
 * IMPORTANT: a city-only-tier geocode result is deliberately NOT cached
 * here (see _isCityOnlyMatch) — the society is left with lat/lng = NULL
 * so the caller falls through to per-listing address-based geocoding
 * instead, which is usually far more precise (it has the real sector
 * number in it) than a generic society-name lookup that didn't resolve.
 */
async function resolveSociety(client, cityId, cityName, rawName, addressRaw, skipGeocode = false) {
  if (!rawName || !rawName.trim()) return null;

  const normalized = rawName.trim().toLowerCase().replace(/\s+/g, " ");

  const { rows: matches } = await client.query(
    `SELECT id, name, lat, lng, similarity(normalized_name, $1) AS sim
     FROM societies
     WHERE city_id = $2
     ORDER BY sim DESC
     LIMIT 1`,
    [normalized, cityId]
  );

  if (matches.length > 0 && matches[0].sim >= SOCIETY_MATCH_THRESHOLD) {
    const match = matches[0];
    if (match.lat != null && match.lng != null) {
      return { id: match.id, lat: match.lat, lng: match.lng };
    }
    if (skipGeocode) {
      // The listing itself already has a real, precise coordinate (from
      // its detail page) — no need to spend a rate-limited Nominatim
      // call finding the society's approximate location too. The society
      // row just stays uncoordinated for now; a later listing without
      // its own coordinate can still trigger a real geocode attempt.
      return { id: match.id, lat: null, lng: null };
    }
    // Matched an existing society that was created before geocoding was
    // added, or whose geocode previously failed — retry now rather than
    // permanently leaving it uncoordinated.
    const geo = await geocodeWithFallbacks(rawName.trim(), addressRaw, cityName);
    if (geo && !_isCityOnlyMatch(geo, cityName)) {
      await client.query("UPDATE societies SET lat = $1, lng = $2 WHERE id = $3", [
        geo.lat, geo.lng, match.id,
      ]);
      return { id: match.id, lat: geo.lat, lng: geo.lng };
    }
    if (geo) {
      console.warn(`Only a city-level match found for society "${rawName.trim()}" — leaving uncoordinated, listing will fall back to address-based geocoding.`);
    }
    return { id: match.id, lat: null, lng: null };
  }

  if (skipGeocode) {
    const { rows: inserted } = await client.query(
      `INSERT INTO societies (city_id, name, normalized_name, lat, lng)
       VALUES ($1, $2, $3, NULL, NULL)
       RETURNING id`,
      [cityId, rawName.trim(), normalized]
    );
    return { id: inserted[0].id, lat: null, lng: null };
  }

  const geo = await geocodeWithFallbacks(rawName.trim(), addressRaw, cityName);
  const useableGeo = geo && !_isCityOnlyMatch(geo, cityName) ? geo : null;
  if (!geo) {
    console.warn(`Geocoding failed entirely for new society "${rawName.trim()}" — stored with lat/lng = NULL.`);
  } else if (!useableGeo) {
    console.warn(`Only a city-level match found for new society "${rawName.trim()}" — stored with lat/lng = NULL, listing will fall back to address-based geocoding.`);
  }

  const { rows: inserted } = await client.query(
    `INSERT INTO societies (city_id, name, normalized_name, lat, lng)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [cityId, rawName.trim(), normalized, useableGeo?.lat ?? null, useableGeo?.lng ?? null]
  );
  return { id: inserted[0].id, lat: useableGeo?.lat ?? null, lng: useableGeo?.lng ?? null };
}

async function upsertProperty(client, cityId, gridDbId, societyId, listing, bhk) {
  await client.query(
    `INSERT INTO properties (
       city_id, grid_id, society_id, source, listing_url, property_name,
       address_raw, lat, lng, monthly_rent, bhk_raw, bhk_type, bhk_numeric,
       area_sqft, furnishing, property_type, raw_metadata,
       is_active, first_seen_at, last_seen_at
     ) VALUES (
       $1, $2, $3, 'magicbricks', $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, true, now(), now()
     )
     ON CONFLICT (listing_url) DO UPDATE SET
       grid_id = EXCLUDED.grid_id,
       society_id = EXCLUDED.society_id,
       monthly_rent = EXCLUDED.monthly_rent,
       bhk_raw = EXCLUDED.bhk_raw,
       bhk_type = EXCLUDED.bhk_type,
       bhk_numeric = EXCLUDED.bhk_numeric,
       area_sqft = EXCLUDED.area_sqft,
       furnishing = EXCLUDED.furnishing,
       property_type = EXCLUDED.property_type,
       raw_metadata = EXCLUDED.raw_metadata,
       is_active = true,
       last_seen_at = now()`,
    [
      cityId,
      gridDbId,
      societyId,
      listing.listing_url,
      listing.property_name,
      listing.address_raw,
      listing.lat,
      listing.lng,
      listing.monthly_rent,
      listing.bhk_raw,
      bhk.bhk_type,
      bhk.bhk_numeric,
      listing.area_sqft,
      listing.furnishing,
      listing.property_type,
      JSON.stringify(listing.raw_metadata || {}),
    ]
  );
}

async function getOrCreateGridDbId(client, cityId, city, lat, lng, gridCodeCache) {
  const assignment = assignPropertyToGrid(lat, lng, city);
  if (!assignment) return null; // outside analysis radius — property dropped from grid stats but kept in DB (grid_id null)

  if (gridCodeCache.has(assignment.grid_code)) {
    return gridCodeCache.get(assignment.grid_code);
  }

  const { rows } = await client.query(
    "SELECT id FROM grids WHERE city_id = $1 AND grid_code = $2",
    [cityId, assignment.grid_code]
  );

  if (rows.length === 0) {
    // Should not normally happen if generateGridsForCity() was run first —
    // log loudly rather than silently dropping the property.
    console.warn(
      `WARNING: grid_code ${assignment.grid_code} not found in DB. ` +
      `Did you run the grid seed script for this city? Property will be ` +
      `stored with grid_id = NULL.`
    );
    return null;
  }

  gridCodeCache.set(assignment.grid_code, rows[0].id);
  return rows[0].id;
}

async function run() {
  const args = parseArgs();
  const cityName = args.city || "Noida";
  const inputPath = args.input || "scraped_listings.jsonl";

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const client = await pool.connect();
  const gridCodeCache = new Map();

  let processed = 0;
  let skippedNoUrl = 0;
  let skippedOutsideGrid = 0;
  let skippedNoCoords = 0;
  let errors = 0;

  try {
    const city = await getCity(client, cityName);
    console.log(`Ingesting into city="${city.name}" (id=${city.id})`);

    const runResult = await client.query(
      `INSERT INTO scraping_runs (city_id, source, status) VALUES ($1, 'magicbricks', 'running') RETURNING id`,
      [city.id]
    );
    const runId = runResult.rows[0].id;

    const rl = readline.createInterface({ input: fs.createReadStream(inputPath) });

    for await (const line of rl) {
      if (!line.trim()) continue;

      let listing;
      try {
        listing = JSON.parse(line);
      } catch (e) {
        console.warn("Skipping malformed JSON line:", e.message);
        errors++;
        continue;
      }

      if (!listing.listing_url) {
        skippedNoUrl++;
        continue;
      }

      try {
        await client.query("BEGIN");

        const bhk = normalizeBhk(listing.bhk_raw);

        // Priority order, highest first:
        //   1. listing.lat/lng — a REAL, precise, per-building coordinate
        //      from the listing's own detail page (added after we found
        //      geocoding-by-name too imprecise for a 1000m radius).
        //   2. society.lat/lng — geocoded society location (coarser,
        //      shared by every listing in that society).
        //   3. address-level geocode — coarsest, last resort.
        // Society resolution still always happens (for the society_id
        // foreign key / display name), but skips its own geocode call
        // entirely when we already have a precise coordinate — no point
        // spending a rate-limited Nominatim request on data we won't use.
        let coords = null;
        const hasRealCoords = listing.lat != null && listing.lng != null;

        const society = await resolveSociety(
          client, city.id, city.name, listing.society_name, listing.address_raw,
          hasRealCoords // skipGeocode
        );

        if (hasRealCoords) {
          coords = { lat: listing.lat, lng: listing.lng };
        } else if (society && society.lat != null && society.lng != null) {
          coords = { lat: society.lat, lng: society.lng };
        } else {
          // No society at all (or its geocode failed) — last-resort
          // geocode using whatever address text we scraped. Coarser
          // (locality-level), but keeps the property placeable rather
          // than dropping it or violating the NOT NULL lat/lng columns.
          //
          // Same rule as resolveSociety: a match that only succeeded on
          // the city-name-alone tier is the city's centroid, not this
          // listing's actual location — accepting it would silently
          // cluster unrelated properties at one point. Treated as "no
          // coordinates found" instead; the property still gets INSERTed
          // via the skippedNoCoords guard further down (grid_id = NULL,
          // excluded from grid stats, but not lost from the DB entirely
          // — unless truly nothing resolves, per that guard).
          const fallbackGeo = await geocodeWithFallbacks(
            null, listing.address_raw || listing.property_name, city.name
          );
          if (fallbackGeo && !_isCityOnlyMatch(fallbackGeo, city.name)) {
            coords = { lat: fallbackGeo.lat, lng: fallbackGeo.lng };
          } else if (fallbackGeo) {
            console.warn(`Address-level geocode for "${listing.listing_url}" only matched at city level — leaving uncoordinated.`);
          }
        }

        let gridDbId = null;
        if (coords) {
          gridDbId = await getOrCreateGridDbId(client, city.id, city, coords.lat, coords.lng, gridCodeCache);
          if (gridDbId === null) skippedOutsideGrid++;
        } else {
          skippedOutsideGrid++;
          console.warn(`No coordinates resolvable for listing ${listing.listing_url} — stored with grid_id = NULL.`);
        }

        // Overwrite listing.lat/lng with the resolved coords so
        // upsertProperty stores something non-null (schema requires it).
        listing.lat = coords?.lat ?? listing.lat;
        listing.lng = coords?.lng ?? listing.lng;

        if (listing.lat == null || listing.lng == null) {
          // Every fallback (society geocode, listing coords, address
          // geocode) failed — properties.lat/lng is NOT NULL, so this
          // listing genuinely cannot be stored. Log it distinctly from
          // "no grid" so it's easy to spot in the summary and investigate
          // (usually a garbled/foreign-language address that Nominatim
          // couldn't parse at all).
          await client.query("ROLLBACK");
          console.warn(`Skipping listing entirely — no coordinates resolvable by any method: ${listing.listing_url}`);
          skippedNoCoords++;
          continue;
        }

        await upsertProperty(client, city.id, gridDbId, society?.id ?? null, listing, bhk);

        await client.query("COMMIT");
        processed++;
      } catch (e) {
        await client.query("ROLLBACK");
        console.error(`Error processing listing ${listing.listing_url}:`, e.message);
        errors++;
      }
    }

    await client.query(
      `UPDATE scraping_runs SET status = 'success', finished_at = now(),
       listings_found = $1, errors_count = $2 WHERE id = $3`,
      [processed, errors, runId]
    );

    console.log(`
Ingestion complete for "${city.name}":
  Processed:            ${processed}
  Skipped (no URL):     ${skippedNoUrl}
  Skipped (no coords):  ${skippedNoCoords}
  Skipped (no grid):    ${skippedOutsideGrid}
  Errors:               ${errors}
`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e) => {
  console.error("Fatal ingestion error:", e);
  process.exit(1);
});