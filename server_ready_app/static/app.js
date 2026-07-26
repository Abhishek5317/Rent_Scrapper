const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const button = document.getElementById("scrape-button");
const body = document.getElementById("listing-body");
const countEl = document.getElementById("count");

function money(value) {
  if (value === null || value === undefined || value === "") return "—";
  return `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
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
  countEl.textContent = `${rows.length} rows loaded`;
  body.innerHTML = rows.map(row => `
    <tr>
      <td>${escapeHtml(row.title || "—")}</td>
      <td>${escapeHtml(row.locality || "—")}</td>
      <td>${money(row.monthly_rent)}</td>
      <td>${escapeHtml(row.bhk || "—")}</td>
      <td>${row.area_sqft ? `${Number(row.area_sqft).toLocaleString("en-IN")} sq ft` : "—"}</td>
      <td>${escapeHtml(row.property_type || "—")}</td>
      <td>${row.listing_url ? `<a href="${escapeHtml(row.listing_url)}" target="_blank" rel="noopener">Open</a>` : "—"}</td>
    </tr>
  `).join("");
}

async function pollStatus(runId) {
  const response = await fetch("/api/status");
  const data = await response.json();
  statusEl.textContent = data.message || "Running";
  errorEl.textContent = data.error || "";
  if (data.running) {
    setTimeout(() => pollStatus(runId), 2000);
  } else {
    button.disabled = false;
    button.textContent = "Start scrape";
    await loadListings(runId);
  }
}

button.addEventListener("click", async () => {
  errorEl.textContent = "";
  button.disabled = true;
  button.textContent = "Starting…";
  const payload = {
    city: document.getElementById("city").value.trim(),
    locality: document.getElementById("locality").value.trim(),
    provider: document.getElementById("provider").value,
    max_results: Number(document.getElementById("max-results").value),
    max_pages: Number(document.getElementById("max-pages").value)
  };
  try {
    const response = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    statusEl.textContent = "Running";
    pollStatus(data.run_id);
  } catch (error) {
    errorEl.textContent = error.message;
    button.disabled = false;
    button.textContent = "Start scrape";
  }
});

document.getElementById("refresh-button").addEventListener("click", () => loadListings());
loadListings();
