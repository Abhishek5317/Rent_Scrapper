let API_BASE_URL;
let currentOffset = 0;
const PAGE_SIZE = 50;
let currentTotal = 0;

async function init() {
  API_BASE_URL = await getApiBaseUrl();
  await loadFilterOptions();
  await loadResults();
}
init();

async function loadFilterOptions() {
  try {
    const [citiesResp, filtersResp] = await Promise.all([
      fetch(`${API_BASE_URL}/cities`),
      fetch(`${API_BASE_URL}/properties/filters`),
    ]);
    const { cities } = await citiesResp.json();
    const filters = await filtersResp.json();

    const storeSelect = document.getElementById("filter-store");
    cities.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.name;
      opt.textContent = c.state ? `${c.name} (${c.state})` : c.name;
      storeSelect.appendChild(opt);
    });

    fillSelect("filter-bhk", filters.bhk_types);
    fillSelect("filter-furnishing", filters.furnishings);
    fillSelect("filter-property-type", filters.property_types);
  } catch (err) {
    console.error("Failed to load filter options:", err);
  }
}

function fillSelect(id, values) {
  const select = document.getElementById(id);
  values.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  });
}

function buildQuery() {
  const params = new URLSearchParams();
  const store = document.getElementById("filter-store").value;
  const bhk = document.getElementById("filter-bhk").value;
  const furnishing = document.getElementById("filter-furnishing").value;
  const propertyType = document.getElementById("filter-property-type").value;
  const minRent = document.getElementById("filter-min-rent").value;
  const maxRent = document.getElementById("filter-max-rent").value;
  const society = document.getElementById("filter-society").value;

  if (store) params.set("store", store);
  if (bhk) params.set("bhk_type", bhk);
  if (furnishing) params.set("furnishing", furnishing);
  if (propertyType) params.set("property_type", propertyType);
  if (minRent) params.set("min_rent", minRent);
  if (maxRent) params.set("max_rent", maxRent);
  if (society) params.set("society", society);
  params.set("limit", PAGE_SIZE);
  params.set("offset", currentOffset);
  return params.toString();
}

function applyFilters() {
  currentOffset = 0;
  loadResults();
}

function clearFilters() {
  ["filter-store", "filter-bhk", "filter-furnishing", "filter-property-type"].forEach((id) => (document.getElementById(id).value = ""));
  ["filter-min-rent", "filter-max-rent", "filter-society"].forEach((id) => (document.getElementById(id).value = ""));
  currentOffset = 0;
  loadResults();
}

function prevPage() {
  currentOffset = Math.max(0, currentOffset - PAGE_SIZE);
  loadResults();
}

function nextPage() {
  if (currentOffset + PAGE_SIZE < currentTotal) {
    currentOffset += PAGE_SIZE;
    loadResults();
  }
}

async function loadResults() {
  const statusEl = document.getElementById("results-status");
  statusEl.textContent = "Loading...";

  try {
    const resp = await fetch(`${API_BASE_URL}/properties?${buildQuery()}`);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    currentTotal = data.total_count;

    statusEl.textContent = `${data.total_count} listing(s) found`;
    renderTable(data.properties);
    updatePagination();
  } catch (err) {
    statusEl.textContent = `❌ ${err.message}`;
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

function renderTable(properties) {
  const wrap = document.getElementById("results-table-wrap");
  if (properties.length === 0) {
    wrap.innerHTML = `<p class="hint">No listings match these filters.</p>`;
    return;
  }

  wrap.innerHTML = `
    <table class="results-table">
      <thead><tr>
        <th>Name</th><th>Society</th><th>Store / Location</th><th>Grid</th><th>BHK</th>
        <th>Rent</th><th>Area</th><th>Furnishing</th><th>Type</th><th>Amenities</th><th>Last Seen</th>
      </tr></thead>
      <tbody>
        ${properties
          .map(
            (p) => `<tr>
          <td><a href="${p.listing_url}" target="_blank" rel="noopener">${p.property_name || "—"}</a></td>
          <td>${p.society_name || "—"}</td>
          <td>${p.store_name}${p.state ? `, ${p.state}` : ""}</td>
          <td>${p.grid_code || "—"}</td>
          <td><span class="tag">${p.bhk_type || "—"}</span></td>
          <td><span class="rent-badge rent-real">${fmtRupee(p.monthly_rent)}</span></td>
          <td>${p.area_sqft ? `${p.area_sqft} sqft` : "—"}</td>
          <td>${p.furnishing || "—"}</td>
          <td>${p.property_type || "—"}</td>
          <td>${renderAmenityChips(p.amenities)}</td>
          <td>${fmtDateTime(p.last_seen_at)}</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

function updatePagination() {
  const pageNum = Math.floor(currentOffset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(currentTotal / PAGE_SIZE));
  document.getElementById("page-info").textContent = `Page ${pageNum} of ${totalPages}`;
  document.getElementById("prev-btn").disabled = currentOffset === 0;
  document.getElementById("next-btn").disabled = currentOffset + PAGE_SIZE >= currentTotal;
}
