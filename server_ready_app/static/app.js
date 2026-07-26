const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const body = document.getElementById("listing-body");
const runBody = document.getElementById("run-body");
const countEl = document.getElementById("count");
const downloadLink = document.getElementById("download-link");
const openButton = document.getElementById("open-button");

function money(value) {
  if (value === null || value === undefined || value === "") return "—";
  return `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function coordinate(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(6) : "—";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[ch]);
}

async function loadListings(runId = null) {
  const query = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  const response = await fetch(`/api/listings${query}`);
  const data = await response.json();
  const rows = data.listings || [];
  const coordinateCount = rows.filter(row => row.latitude !== null && row.longitude !== null).length;
  countEl.textContent = `${rows.length} rows loaded · ${coordinateCount} with coordinates`;
  downloadLink.href = runId
    ? `/api/listings.csv?run_id=${encodeURIComponent(runId)}`
    : "/api/listings.csv";

  body.innerHTML = rows.length ? rows.map(row => `
    <tr>
      <td>${escapeHtml(row.title || "—")}</td>
      <td>${escapeHtml(row.locality || "—")}</td>
      <td>${money(row.monthly_rent)}</td>
      <td>${escapeHtml(row.bhk || "—")}</td>
      <td>${row.area_sqft ? `${Number(row.area_sqft).toLocaleString("en-IN")} sq ft` : "—"}</td>
      <td>${escapeHtml(row.property_type || "—")}</td>
      <td>${coordinate(row.latitude)}</td>
      <td>${coordinate(row.longitude)}</td>
      <td>${row.listing_url ? `<a href="${escapeHtml(row.listing_url)}" target="_blank" rel="noopener">Open</a>` : "—"}</td>
    </tr>
  `).join("") : `<tr><td colspan="9">No captured listings yet.</td></tr>`;
}

async function loadRuns() {
  const response = await fetch("/api/runs");
  const data = await response.json();
  const runs = data.runs || [];

  runBody.innerHTML = runs.length ? runs.map(run => `
    <tr>
      <td>${escapeHtml(new Date(run.started_at).toLocaleString("en-IN"))}</td>
      <td>${escapeHtml(run.city)}</td>
      <td>${escapeHtml(run.locality || "—")}</td>
      <td>${escapeHtml(run.listing_count)}</td>
      <td>${escapeHtml(run.status)}</td>
    </tr>
  `).join("") : `<tr><td colspan="5">No capture runs yet.</td></tr>`;

  await loadListings(runs[0]?.id || null);
}

openButton.addEventListener("click", async () => {
  errorEl.textContent = "";
  const city = document.getElementById("city").value.trim();
  const locality = document.getElementById("locality").value.trim();
  openButton.disabled = true;
  openButton.textContent = "Opening…";

  try {
    const response = await fetch(
      `/api/search-url?city=${encodeURIComponent(city)}&locality=${encodeURIComponent(locality)}`
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    window.open(data.url, "_blank", "noopener");
    statusEl.textContent = "MagicBricks opened. Complete any CAPTCHA manually. RentIQ will auto-scroll, read coordinates from listing JSON-LD, open only missing property pages in one reusable tab, and send everything automatically.";
  } catch (error) {
    errorEl.textContent = error.message;
  } finally {
    openButton.disabled = false;
    openButton.textContent = "Open MagicBricks & Start Automatic Capture";
  }
});

document.getElementById("copy-server").addEventListener("click", async () => {
  const value = document.getElementById("server-url").textContent.trim();
  await navigator.clipboard.writeText(value);
  statusEl.textContent = `Copied ${value}`;
});

document.getElementById("refresh-button").addEventListener("click", loadRuns);

loadRuns();
setInterval(loadRuns, 5000);
