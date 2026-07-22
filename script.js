// ═══════════════════════════════════════════════════
//  CONFIG — loaded from config.json, NOT hardcoded here.
//
// Same principle as the Python scraper: this file should never need
// editing to point at a different city/store — only config.json does.
// ═══════════════════════════════════════════════════
let SKYMARK, CELL_METERS, GRID_RADIUS_METERS, API_BASE_URL, CITY_NAME, LOCATION_LABEL;
let map, noidaLayer = null;

// Refreshes the "Grid Details" tab's cell size / centre point stats and
// hint text from the current SKYMARK/CELL_METERS/GRID_RADIUS_METERS/
// LOCATION_LABEL — called on initial load AND whenever switchToCity()
// changes the active city, so these never go stale after a city switch
// (previously they were static HTML text left over from whichever city
// was configured at page-load time).
function updateGridInfoDisplay() {
  document.getElementById("stat-size").textContent = `${CELL_METERS}m × ${CELL_METERS}m`;
  document.getElementById("stat-center").textContent = `${SKYMARK.lat}, ${SKYMARK.lng}`;
  document.getElementById("cell-size-hint").innerHTML =
    `Each cell = one ${CELL_METERS}m×${CELL_METERS}m grid square, covering a ~${GRID_RADIUS_METERS}m radius around ${LOCATION_LABEL}.<br/>` +
    `Teal-shaded cells have real scraped listings — click one to see full analytics.`;
}

async function initApp() {
  const config = await fetch("config.json").then(r => r.json());

  SKYMARK = { lat: config.center_lat, lng: config.center_lng };
  CELL_METERS = config.cell_size_m;
  GRID_RADIUS_METERS = config.radius_m;
  API_BASE_URL = config.api_base_url || "http://localhost:3001/api";
  CITY_NAME = config.city_name;
  if (!CITY_NAME) {
    document.getElementById("grid-status").textContent =
      "❌ config.json is missing \"city_name\" — this must exactly match the city name used when you ran seedCity.js/ingest.js (e.g. \"Mumbai\"), or every grid click will fail with a confusing 404.";
  }
  LOCATION_LABEL = config.location_label || config.city_name || "Selected Location";

  document.getElementById("coords-display").innerHTML =
    `📍 ${LOCATION_LABEL} &nbsp;|&nbsp; Lat: ${SKYMARK.lat}, Lng: ${SKYMARK.lng}`;
  updateGridInfoDisplay();

  // ═══════════════════════════════════════════════════
  //  MAP INIT
  // ═══════════════════════════════════════════════════
  // Canvas renderer, not the SVG default — matters a lot at this cell
  // count (2601 grid cells vs. the original 121): SVG creates one DOM
  // element per shape and gets sluggish in the thousands, canvas draws
  // them all to one bitmap and stays smooth.
  map = L.map("map", { renderer: L.canvas() }).setView([SKYMARK.lat, SKYMARK.lng], 14);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '© <a href="https://www.openstreetmap.org/">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(map);

  const centreIcon = L.divIcon({
    className: "",
    html: `<div style="background:#1a1a2e;color:white;padding:4px 10px;
           border-radius:6px;font-size:11px;font-weight:bold;
           white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.5);
           border:2px solid #e94560">📍 ${LOCATION_LABEL}</div>`,
    iconAnchor: [55, 10]
  });
  L.marker([SKYMARK.lat, SKYMARK.lng], { icon: centreIcon }).addTo(map)
    .bindPopup(`<b>${LOCATION_LABEL}</b><br/>Lat: ${SKYMARK.lat}, Lng: ${SKYMARK.lng}`);

  // ═══════════════════════════════════════════════════
  //  LOAD BOUNDARY GEOJSON (optional, best-effort)
  // ═══════════════════════════════════════════════════
  // NOTE: noida.geojson is specific to Noida's own boundary shape — for
  // a different city this file would need to be swapped for that city's
  // own boundary (or removed entirely; it's cosmetic, not required for
  // the grid/analytics to work). Failure here is handled gracefully.
  loadBoundary();
}

function loadBoundary() {
  fetch("noida.geojson")
  .then(r => r.json())
  .then(data => {
    noidaLayer = L.geoJSON(data, {
      style: {
        color: "#e94560",
        weight: 2.5,
        fillColor: "#e94560",
        fillOpacity: 0.06,
        dashArray: "6 4"
      }
    }).addTo(map);

    // noida.geojson is a leftover Noida-specific boundary shape — only
    // let it recenter the map if it actually contains the CONFIGURED
    // location. Otherwise (e.g. config.json points at Mumbai, but this
    // old Noida boundary file is still sitting in the folder) it would
    // silently hijack the view to Noida's real location, overriding the
    // correct center entirely. Better to just skip showing an irrelevant
    // boundary shape than to have it fight the actual target location.
    const bounds = noidaLayer.getBounds();
    if (bounds.contains([SKYMARK.lat, SKYMARK.lng])) {
      map.fitBounds(bounds, { padding: [20, 20] });
      document.getElementById("grid-status").textContent =
        "✅ Boundary loaded. Now click 'Draw 200m Grid'.";
    } else {
      // Boundary doesn't match the configured location — remove it
      // rather than show a misleading, unrelated shape on the map.
      map.removeLayer(noidaLayer);
      noidaLayer = null;
      document.getElementById("grid-status").textContent =
        `📍 Centered on ${LOCATION_LABEL} (${SKYMARK.lat}, ${SKYMARK.lng}). Click 'Draw 200m Grid' to start.`;
    }
  })
  .catch(err => {
    document.getElementById("grid-status").textContent =
      `📍 Centered on ${LOCATION_LABEL} (${SKYMARK.lat}, ${SKYMARK.lng}). Click 'Draw 200m Grid' to start.`;
    console.warn("No boundary file loaded (this is fine if targeting a non-Noida city):", err);
  });
}

// ═══════════════════════════════════════════════════
//  GO TO LOCATION — jump to any scraped city by lat/lng directly,
//  no config.json editing needed for VIEWING already-scraped data.
// ═══════════════════════════════════════════════════

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

async function fetchCities() {
  const resp = await fetch(`${API_BASE_URL}/cities`);
  if (!resp.ok) throw new Error(`API returned HTTP ${resp.status}`);
  const { cities } = await resp.json();
  return cities;
}

// Switches the whole app over to an already-resolved city object (as
// returned by /api/cities) and redraws the grid there. Shared by both the
// manual lat/lng "Go to Location" flow and the name-search autosuggest —
// both end up with a concrete city row, just found a different way.
async function switchToCity(city, statusEl, statusSuffix = "") {
  SKYMARK = { lat: city.origin_lat, lng: city.origin_lng };
  CELL_METERS = city.cell_size_m;
  GRID_RADIUS_METERS = city.radius_m;
  CITY_NAME = city.name;
  LOCATION_LABEL = city.name + (city.state ? `, ${city.state}` : "");

  document.getElementById("coords-display").innerHTML =
    `📍 ${LOCATION_LABEL} &nbsp;|&nbsp; Lat: ${SKYMARK.lat}, Lng: ${SKYMARK.lng}`;
  updateGridInfoDisplay();
  if (statusEl) {
    statusEl.textContent = `✅ Switched to "${city.name}".${statusSuffix} Redrawing grid...`;
  }

  // Clear any existing grid/analytics before redrawing at the new centre
  clearAll();
  map.setView([SKYMARK.lat, SKYMARK.lng], 14);
  await drawGrid();
}

async function gotoLocation() {
  const statusEl = document.getElementById("goto-status");
  const lat = parseFloat(document.getElementById("input-lat").value);
  const lng = parseFloat(document.getElementById("input-lng").value);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    statusEl.textContent = "⚠️ Enter both latitude and longitude.";
    return;
  }

  statusEl.textContent = "🔍 Checking for scraped data near this location...";

  try {
    const cities = await fetchCities();

    // Find which (if any) already-scraped city this point falls within.
    // Matches on the SAME radius_m that city was originally seeded with —
    // this can only find data that's already been scraped; it can't
    // trigger a new scrape (that's a separate, much slower backend job).
    let match = null;
    for (const city of cities) {
      const dist = haversineMeters(lat, lng, city.origin_lat, city.origin_lng);
      if (dist <= city.radius_m) {
        match = city;
        break;
      }
    }

    if (!match) {
      statusEl.textContent =
        "❌ No scraped data found near this location. Run the scraper for these coordinates first (see project setup).";
      return;
    }

    const distanceNote = ` (${Math.round(haversineMeters(lat, lng, match.origin_lat, match.origin_lng))}m from its centre.)`;
    await switchToCity(match, statusEl, distanceNote);
  } catch (err) {
    statusEl.textContent = `❌ Error: ${err.message}`;
    console.error(err);
  }
}

// ═══════════════════════════════════════════════════
//  LOCATION AUTOSUGGEST — type a scraped city's name, pick it from a
//  dropdown, grid populates immediately. Suggestions are drawn from
//  /api/cities (only places that have actually been scraped already) —
//  cached client-side after the first lookup since that list only changes
//  when a new store finishes processing on the backend.
// ═══════════════════════════════════════════════════
let citiesCache = null;
let suggestionIndex = -1;

async function getCitiesCached() {
  if (!citiesCache) citiesCache = await fetchCities();
  return citiesCache;
}

function renderSuggestions(matches, hasQuery = false) {
  const box = document.getElementById("location-suggestions");
  suggestionIndex = -1;

  if (matches.length === 0) {
    if (hasQuery) {
      box.innerHTML = `<div class="suggestion-empty">No scraped cities match — try "Go to Location" with exact coordinates instead.</div>`;
      box.classList.remove("hidden");
    } else {
      box.classList.add("hidden");
      box.innerHTML = "";
    }
    return;
  }

  box.innerHTML = matches
    .map(
      (city, idx) => `
    <div class="suggestion-item" data-idx="${idx}">
      <span class="suggestion-name">${city.name}</span>
      ${city.state ? `<span class="suggestion-state">${city.state}</span>` : ""}
    </div>`
    )
    .join("");
  box.classList.remove("hidden");

  box.querySelectorAll(".suggestion-item").forEach((el) => {
    el.addEventListener("click", () => selectSuggestion(matches[parseInt(el.dataset.idx, 10)]));
  });
}

function renderSuggestionsError(message) {
  const box = document.getElementById("location-suggestions");
  box.innerHTML = `<div class="suggestion-empty">❌ ${message}</div>`;
  box.classList.remove("hidden");
}

async function onLocationSearchInput() {
  const query = document.getElementById("location-search").value.trim().toLowerCase();

  if (!query) {
    renderSuggestions([]);
    return;
  }

  try {
    const cities = await getCitiesCached();
    const matches = cities.filter((c) => c.name.toLowerCase().includes(query)).slice(0, 8);
    renderSuggestions(matches, true);
  } catch (err) {
    renderSuggestionsError(err.message);
    console.error(err);
  }
}

async function selectSuggestion(city) {
  document.getElementById("location-search").value = city.name;
  document.getElementById("input-lat").value = city.origin_lat;
  document.getElementById("input-lng").value = city.origin_lng;
  renderSuggestions([]);

  const statusEl = document.getElementById("goto-status");
  statusEl.textContent = `🔍 Loading "${city.name}"...`;
  try {
    await switchToCity(city, statusEl);
  } catch (err) {
    statusEl.textContent = `❌ Error: ${err.message}`;
    console.error(err);
  }
}

function handleSearchKeydown(e) {
  const items = document.querySelectorAll("#location-suggestions .suggestion-item");
  if (items.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    suggestionIndex = Math.min(suggestionIndex + 1, items.length - 1);
    highlightSuggestion(items);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    suggestionIndex = Math.max(suggestionIndex - 1, 0);
    highlightSuggestion(items);
  } else if (e.key === "Enter") {
    e.preventDefault();
    items[suggestionIndex >= 0 ? suggestionIndex : 0].click();
  } else if (e.key === "Escape") {
    renderSuggestions([]);
  }
}

function highlightSuggestion(items) {
  items.forEach((el, idx) => el.classList.toggle("active", idx === suggestionIndex));
  if (suggestionIndex >= 0) items[suggestionIndex].scrollIntoView({ block: "nearest" });
}

// Close the dropdown on any click outside the search box itself.
document.addEventListener("click", (e) => {
  const wrapper = document.getElementById("location-search-wrapper");
  if (wrapper && !wrapper.contains(e.target)) {
    renderSuggestions([]);
  }
});

// ═══════════════════════════════════════════════════
//  GRID LOGIC
// ═══════════════════════════════════════════════════

// Convert meters offset to degrees
// ~111,320 meters per degree latitude
// longitude degrees shrink with cos(lat)
function metersToDegLat(m) { return m / 111320; }
function metersToDegLng(m, lat) { return m / (111320 * Math.cos(lat * Math.PI / 180)); }

let gridLayers = [];
let gridCells = []; // store cell bounds for reference

async function drawGrid() {
  // Clear previous grid
  gridLayers.forEach(l => map.removeLayer(l));
  gridLayers = [];
  gridCells = [];

  const btn = document.getElementById("grid-btn");
  btn.disabled = true;
  btn.textContent = "⏳ Drawing...";

  // Fetch real listing counts per cell FIRST (one call for all 2601 cells,
  // not one call per cell) so we can shade cells by density — otherwise,
  // at this radius, the user would be clicking blindly through thousands
  // of empty cells to find the handful with real data.
  let listingsByCode = {};
  try {
    const resp = await fetch(`${API_BASE_URL}/grids?city=${CITY_NAME}`);
    if (resp.ok) {
      const data = await resp.json();
      data.grids.forEach(g => { listingsByCode[g.grid_code] = g.total_listings; });
    }
  } catch (err) {
    console.warn("Could not reach the API to fetch listing density — drawing grid without shading.", err);
    document.getElementById("grid-status").textContent =
      "⚠️ Grid drawn, but couldn't reach the API (is it running on localhost:3001?) — cells aren't shaded by data density.";
  }

  const HALF_GRID = Math.ceil(GRID_RADIUS_METERS / CELL_METERS);
  const dLat = metersToDegLat(CELL_METERS);
  const dLng = metersToDegLng(CELL_METERS, SKYMARK.lat);
  const maxListings = Math.max(1, ...Object.values(listingsByCode));

  let cellCount = 0;

  for (let row = -HALF_GRID; row <= HALF_GRID; row++) {
    for (let col = -HALF_GRID; col <= HALF_GRID; col++) {
      const south = SKYMARK.lat + row * dLat;
      const north = SKYMARK.lat + (row + 1) * dLat;
      const west  = SKYMARK.lng + col * dLng;
      const east  = SKYMARK.lng + (col + 1) * dLng;

      const isCentre = (row === 0 && col === 0);
      const gridCode = `G${row}_${col}`;
      const listingCount = listingsByCode[gridCode] || 0;
      const hasData = listingCount > 0;

      // Shade by density: cells with real listings get a visible teal
      // fill (darker = more listings), empty cells stay faint. Centre
      // cell (the configured store/location itself) always outlined in
      // red regardless.
      const intensity = hasData ? 0.15 + 0.55 * (listingCount / maxListings) : 0.03;
      const rect = L.rectangle(
        [[south, west], [north, east]],
        {
          color: isCentre ? "#e94560" : hasData ? "#16a085" : "#999",
          weight: isCentre ? 2.5 : hasData ? 1.5 : 0.5,
          fillColor: isCentre ? "#e94560" : "#16a085",
          fillOpacity: isCentre ? 0.25 : intensity,
        }
      ).addTo(map);

      const cellLabel = isCentre ? `🏙️ ${gridCode} — CENTRE (${LOCATION_LABEL})` : gridCode;
      rect.bindPopup(`
        <b>${cellLabel}</b><br/>
        ${hasData ? `📊 ${listingCount} listing${listingCount === 1 ? "" : "s"} — click for full analytics` : "No listings scraped here yet"}<br/>
        SW: ${south.toFixed(5)}, ${west.toFixed(5)}<br/>
        NE: ${north.toFixed(5)}, ${east.toFixed(5)}
      `);

      rect.on("click", () => loadGridAnalytics(gridCode));

      gridLayers.push(rect);
      gridCells.push({ grid_code: gridCode, south, north, west, east, row, col });
      cellCount++;
    }
  }

  // Update UI
  document.getElementById("stat-cells").textContent = cellCount;
  document.getElementById("grid-stats").classList.remove("hidden");
  const dataCells = Object.values(listingsByCode).filter(c => c > 0).length;
  document.getElementById("grid-status").textContent =
    `✅ ${cellCount} grid cells drawn (${HALF_GRID * 2 + 1}×${HALF_GRID * 2 + 1} grid, each 200m×200m, ~${GRID_RADIUS_METERS}m radius). ` +
    `${dataCells} cell${dataCells === 1 ? "" : "s"} have real listing data — click a shaded (teal) cell to see analytics.`;

  // Zoom to grid
  const totalDLat = (HALF_GRID * 2 + 1) * dLat;
  const totalDLng = (HALF_GRID * 2 + 1) * dLng;
  map.fitBounds([
    [SKYMARK.lat - totalDLat, SKYMARK.lng - totalDLng],
    [SKYMARK.lat + totalDLat, SKYMARK.lng + totalDLng]
  ], { padding: [40, 40] });

  btn.disabled = false;
  btn.textContent = "🔲 Draw 200m Grid";
}

// ═══════════════════════════════════════════════════
//  GRID ANALYTICS — real data from the backend API
// ═══════════════════════════════════════════════════
let currentAnalyticsMarkers = [];

async function loadGridAnalytics(gridCode) {
  switchTab("analytics");

  const status = document.getElementById("analytics-status");
  const content = document.getElementById("analytics-content");
  const loader = document.getElementById("loader");

  status.textContent = `Loading analytics for ${gridCode}...`;
  content.innerHTML = "";
  loader.classList.remove("hidden");

  currentAnalyticsMarkers.forEach(m => map.removeLayer(m));
  currentAnalyticsMarkers = [];

  try {
    const [insightsRes, statsRes, propsRes, socRes] = await Promise.all([
      fetch(`${API_BASE_URL}/grids/${gridCode}?city=${CITY_NAME}`),
      fetch(`${API_BASE_URL}/grids/${gridCode}/statistics?city=${CITY_NAME}`),
      fetch(`${API_BASE_URL}/grids/${gridCode}/properties?city=${CITY_NAME}`),
      fetch(`${API_BASE_URL}/grids/${gridCode}/societies?city=${CITY_NAME}`),
    ]);

    if (!insightsRes.ok) {
      let apiMessage = `HTTP ${insightsRes.status}`;
      try {
        const errBody = await insightsRes.json();
        if (errBody.error) apiMessage = errBody.error;
      } catch { /* response wasn't JSON, just use the status code */ }
      throw new Error(apiMessage);
    }

    const insights = await insightsRes.json();
    const stats = await statsRes.json();
    const props = await propsRes.json();
    const societies = await socRes.json();

    loader.classList.add("hidden");

    if (!insights.insights) {
      status.innerHTML = `📭 <b>${gridCode}</b> — no listings scraped in this cell yet.`;
      content.innerHTML = `<p class="hint">Try clicking a teal-shaded cell instead — those have real data. Empty cells are expected across most of this grid; only a locality-scoped scrape has run so far.</p>`;
      return;
    }

    status.textContent = `✅ ${gridCode} — ${insights.insights.total_listings} listings found`;
    renderAnalytics(gridCode, insights, stats, props, societies);
  } catch (err) {
    loader.classList.add("hidden");
    status.textContent = `❌ Error: ${err.message}`;
    content.innerHTML = `<p class="hint">Make sure the API server is running (<code>node src\\api\\server.js</code>) on localhost:3001.</p>`;
    console.error(err);
  }
}

// Amenities come back as a JSON array (or null/undefined if the detail-page
// scrape never found any — see magicbricks_scraper.py's
// extract_amenities_from_detail_html) — rendered as compact tag chips,
// capped so one listing with a huge amenities list doesn't blow out the
// table row; the full list is still available via the title tooltip.
const AMENITY_CHIP_CAP = 4;
function renderAmenityChips(amenities) {
  if (!Array.isArray(amenities) || amenities.length === 0) return "—";
  const shown = amenities.slice(0, AMENITY_CHIP_CAP);
  const extra = amenities.length - shown.length;
  const chips = shown.map((a) => `<span class="amenity-tag">${a}</span>`).join("");
  const moreChip = extra > 0 ? `<span class="amenity-tag amenity-tag-more">+${extra} more</span>` : "";
  return `<div class="amenity-list" title="${amenities.join(", ")}">${chips}${moreChip}</div>`;
}

function renderAnalytics(gridCode, insights, stats, props, societies) {
  const content = document.getElementById("analytics-content");
  const i = insights.insights;

  const fmtRupee = (n) => n == null ? "—" : `₹${Math.round(n).toLocaleString("en-IN")}`;

  // ── Section 5: Grid Insights summary ──
  let html = `
    <div class="insights-card">
      <h4>${gridCode} — Grid Insights</h4>
      <div class="stats-box">
        <div class="stat"><span>${i.total_listings}</span><label>Total Listings</label></div>
        <div class="stat"><span>${fmtRupee(i.avg_rent)}</span><label>Avg Rent</label></div>
        <div class="stat"><span>${fmtRupee(i.min_rent)} – ${fmtRupee(i.max_rent)}</span><label>Rent Range</label></div>
      </div>
      ${i.dominant_housing_type ? `<p><b>Dominant type:</b> ${i.dominant_housing_type.bhk_type} (${i.dominant_housing_type.pct}%)${i.second_housing_type ? ` · <b>2nd:</b> ${i.second_housing_type.bhk_type} (${i.second_housing_type.pct}%)` : ""}</p>` : ""}
      ${i.most_active_society ? `<p><b>Most active society:</b> ${i.most_active_society.name} (${i.most_active_society.listing_count} listings)</p>` : ""}
    </div>
  `;

  // ── Section 3: Most Important Housing Types ──
  if (stats.top_housing_types && stats.top_housing_types.length > 0) {
    html += `<h4>Most Common Housing Types</h4><div class="stats-box">`;
    stats.top_housing_types.forEach(t => {
      html += `<div class="stat"><span>${t.bhk_type}</span><label>${t.listing_count} listings (${t.pct}%)</label></div>`;
    });
    html += `</div>`;
  }

  // ── Section 4: Top Societies ──
  if (societies.top_societies && societies.top_societies.length > 0) {
    html += `<h4>Top Residential Societies</h4><ul class="society-list">`;
    societies.top_societies.forEach(s => {
      html += `<li>${s.name} <span class="tag">${s.listing_count} listings</span></li>`;
    });
    html += `</ul>`;
  }

  // ── Section 1: BHK Bucket Analytics ──
  if (stats.buckets && stats.buckets.length > 0) {
    html += `<h4>Rental Analytics by BHK</h4><table class="results-table"><thead><tr>
      <th>BHK</th><th>Listings</th><th>Avg</th><th>Median</th><th>Range</th>
    </tr></thead><tbody>`;
    stats.buckets.forEach(b => {
      html += `<tr>
        <td><span class="tag">${b.bhk_type}</span></td>
        <td>${b.listing_count}</td>
        <td><span class="rent-badge rent-real">${fmtRupee(b.avg_rent)}</span></td>
        <td>${fmtRupee(b.median_rent)}</td>
        <td>${fmtRupee(b.rent_range.min)} – ${fmtRupee(b.rent_range.max)}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  }

  // ── Section 2: Full Property Listings ──
  if (props.properties && props.properties.length > 0) {
    html += `<h4>All Listings in ${gridCode} (${props.total_count})</h4><table class="results-table"><thead><tr>
      <th>#</th><th>Name</th><th>Society</th><th>BHK</th><th>Rent</th><th>Amenities</th>
    </tr></thead><tbody>`;
    props.properties.forEach((p, idx) => {
      // MagicBricks generates listing titles from just "BHK + locality",
      // so multiple genuinely distinct units in the same building (e.g.
      // three different 4BHK flats in Parx Laureate) can show identical
      // text. Extracting the cardid we appended earlier (for exactly
      // this de-duplication reason) and showing it here makes it visibly
      // clear these are different listings, not a display bug.
      const cardIdMatch = p.listing_url.match(/#cardid-(\d+)/);
      const listingId = cardIdMatch ? cardIdMatch[1] : null;

      html += `<tr>
        <td>${idx + 1}</td>
        <td>
          <a href="${p.listing_url}" target="_blank" rel="noopener">${p.property_name || "—"}</a>
          ${listingId ? `<div class="listing-id">Listing ID: ${listingId}</div>` : ""}
        </td>
        <td>${p.society_name || "—"}</td>
        <td><span class="tag">${p.bhk_type || "—"}</span></td>
        <td><span class="rent-badge rent-real">${fmtRupee(p.monthly_rent)}</span></td>
        <td>${renderAmenityChips(p.amenities)}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  }

  content.innerHTML = html;

  // Marker on the map for this grid's centre, for orientation
  const marker = L.marker([insights.center.lat, insights.center.lng]).addTo(map)
    .bindPopup(`<b>${gridCode}</b><br/>${i.total_listings} listings`).openPopup();
  currentAnalyticsMarkers.push(marker);
}

// ═══════════════════════════════════════════════════
//  CLEAR ALL
// ═══════════════════════════════════════════════════
function clearAll() {
  gridLayers.forEach(l => map.removeLayer(l));
  currentAnalyticsMarkers.forEach(m => map.removeLayer(m));
  gridLayers = [];
  currentAnalyticsMarkers = [];
  gridCells = [];

  document.getElementById("analytics-content").innerHTML = "";
  document.getElementById("grid-stats").classList.add("hidden");
  document.getElementById("grid-status").textContent = "Click 'Draw 200m Grid' to start.";
  document.getElementById("analytics-status").textContent = "Draw the grid, then click any shaded cell to see its analytics.";
  document.getElementById("loader").classList.add("hidden");
}

// ═══════════════════════════════════════════════════
//  TABS
// ═══════════════════════════════════════════════════
function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.add("hidden"));
  document.getElementById("tab-" + name).classList.remove("hidden");
  document.querySelectorAll(".tab")[name === "grid" ? 0 : 1].classList.add("active");
}

// ═══════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════
initApp().catch(err => {
  console.error("Failed to initialize app:", err);
  document.getElementById("grid-status").textContent =
    "❌ Failed to load config.json — make sure it's in the project root folder and you're serving via http:// (not file://).";
});