/**
 * debugGeocode.js
 *
 * Isolates ONE geocoding call with full raw output — HTTP status, raw
 * response body — so we can see exactly what Nominatim is actually
 * saying, rather than inferring it through geocoder.js's normal
 * "found no results" summary.
 *
 * Run: node src\scripts\debugGeocode.js
 */

const USER_AGENT = "RentIQ/1.0 (internship project debug run)";

async function debugQuery(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  console.log(`\n=== Query: "${query}" ===`);
  console.log(`URL: ${url}`);

  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    console.log(`HTTP status: ${response.status} ${response.statusText}`);
    console.log(`Response headers:`, Object.fromEntries(response.headers.entries()));

    const rawText = await response.text();
    console.log(`Raw response body: ${rawText.slice(0, 500)}`);
  } catch (e) {
    console.log(`Request threw an error: ${e.message}`);
  }
}

async function run() {
  // Test 1: a query that MUST work if Nominatim is reachable at all —
  // Noida is a real, well-mapped city.
  await debugQuery("Noida, India");

  await new Promise((r) => setTimeout(r, 1200)); // respect rate limit between tests

  // Test 2: one of the real societies that failed in the actual run
  await debugQuery("Godrej Woods, Noida, India");
}

run();