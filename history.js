let API_BASE_URL;
let currentPoll = null;

async function init() {
  API_BASE_URL = await getApiBaseUrl();
  await loadRuns();
}
init();

async function loadRuns() {
  const statusEl = document.getElementById("runs-status");
  try {
    const resp = await fetch(`${API_BASE_URL}/extraction-runs?limit=50`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    statusEl.textContent = `${data.total_count} run(s)`;
    renderRunsTable(data.runs);
  } catch (err) {
    statusEl.textContent = `❌ ${err.message}`;
    console.error(err);
  }
}

function renderRunsTable(runs) {
  const wrap = document.getElementById("runs-table-wrap");
  if (runs.length === 0) {
    wrap.innerHTML = `<p class="hint">No extraction batches yet — start one from <a href="upload.html">Upload &amp; Extract</a>.</p>`;
    return;
  }

  wrap.innerHTML = `
    <table class="results-table">
      <thead><tr>
        <th>#</th><th>Status</th><th>Started</th><th>Duration</th>
        <th>Stores</th><th>✅</th><th>📭</th><th>❌</th><th>CSV</th>
      </tr></thead>
      <tbody>
        ${runs
          .map(
            (r) => `<tr class="clickable-row" onclick="showRunDetail(${r.id})">
          <td>${r.id}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${fmtDateTime(r.started_at)}</td>
          <td>${fmtDuration(r.started_at, r.finished_at)}</td>
          <td>${r.completed_stores}/${r.total_stores}</td>
          <td>${r.succeeded_count}</td>
          <td>${r.empty_count}</td>
          <td>${r.failed_count}</td>
          <td>${r.source_csv_filename || "—"}</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

async function showRunDetail(batchId) {
  if (currentPoll) currentPoll.stop();

  const panel = document.getElementById("run-detail-panel");
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth" });
  document.getElementById("run-detail-title").textContent = `Run #${batchId}`;
  document.getElementById("run-detail-status").textContent = "Loading...";
  document.getElementById("run-detail-stores").innerHTML = "";
  document.getElementById("run-detail-log").classList.add("hidden");

  try {
    const resp = await fetch(`${API_BASE_URL}/extraction-runs/${batchId}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    renderRunDetail(data);

    if (data.status === "queued" || data.status === "running") {
      currentPoll = pollExtractionRun(API_BASE_URL, batchId, {
        onUpdate: (statusData) => renderLiveUpdate(batchId, statusData),
      });
    }
  } catch (err) {
    document.getElementById("run-detail-status").textContent = `❌ ${err.message}`;
    console.error(err);
  }
}

function renderRunDetail(data) {
  document.getElementById("run-detail-status").innerHTML =
    `${statusBadge(data.status)} — started ${fmtDateTime(data.started_at)}, duration ${fmtDuration(data.started_at, data.finished_at)}` +
    (data.log_download_url ? ` — <a href="${API_BASE_URL}${data.log_download_url}">⬇️ Download full log</a>` : "");

  document.getElementById("run-detail-stores").innerHTML =
    `<table class="results-table">
      <thead><tr><th>#</th><th>Label</th><th>Status</th><th>City</th><th>Listings</th><th>Data</th></tr></thead>
      <tbody>
        ${data.stores
          .map(
            (s) => `<tr>
          <td>${s.index + 1}</td>
          <td>${s.label}</td>
          <td>${statusBadge(s.status)}${s.error_message ? `<div class="error-text">${s.error_message}</div>` : ""}</td>
          <td>${s.resolved_city_name || "—"}</td>
          <td>${s.listing_count}</td>
          <td>${s.download_url ? `<a href="${API_BASE_URL}${s.download_url}">⬇️ Download</a>` : "—"}</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

function renderLiveUpdate(batchId, data) {
  document.getElementById("run-detail-status").innerHTML =
    `${statusBadge(data.status)} — ${data.completed_stores}/${data.total_stores} store(s) processed (live)`;

  document.getElementById("run-detail-stores").innerHTML =
    `<table class="results-table">
      <thead><tr><th>#</th><th>Label</th><th>Status</th><th>City</th><th>Listings</th></tr></thead>
      <tbody>
        ${data.stores
          .map(
            (s) => `<tr>
          <td>${s.index + 1}</td>
          <td>${s.label}</td>
          <td>${statusBadge(s.status)}${s.error_message ? `<div class="error-text">${s.error_message}</div>` : ""}</td>
          <td>${s.resolved_city_name || "—"}</td>
          <td>${s.listing_count}</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>`;

  if (data.new_log_lines && data.new_log_lines.length > 0) {
    const logEl = document.getElementById("run-detail-log");
    logEl.classList.remove("hidden");
    logEl.textContent += data.new_log_lines.join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }

  if (data.status !== "queued" && data.status !== "running") {
    if (currentPoll) currentPoll.stop();
    loadRuns(); // refresh the list so the finished batch's summary counts are current
    showRunDetail(batchId); // reload full detail (incl. download links, now available)
  }
}
