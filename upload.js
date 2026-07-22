let API_BASE_URL;
let lastValidation = null; // { upload_token, source_csv_filename, source_csv_path, valid_stores, defaults_used }
let currentPoll = null;

async function init() {
  API_BASE_URL = await getApiBaseUrl();
}
init();

function toggleHelp() {
  document.getElementById("csv-help").classList.toggle("hidden");
}

function currentDefaults() {
  return {
    cell_size_m: parseInt(document.getElementById("def-cell-size").value, 10) || 200,
    radius_m: parseInt(document.getElementById("def-radius").value, 10) || 5000,
    max_pages: parseInt(document.getElementById("def-max-pages").value, 10) || 5,
    cooldown_seconds: parseInt(document.getElementById("def-cooldown").value, 10) || 45,
    api_base_url: "http://localhost:3001/api",
  };
}

async function validateCsv() {
  const fileInput = document.getElementById("csv-file");
  const statusEl = document.getElementById("validate-status");
  const btn = document.getElementById("validate-btn");

  if (!fileInput.files || fileInput.files.length === 0) {
    statusEl.textContent = "⚠️ Choose a CSV file first.";
    return;
  }

  const defaults = currentDefaults();
  const formData = new FormData();
  formData.append("file", fileInput.files[0]);
  formData.append("cell_size_m", defaults.cell_size_m);
  formData.append("radius_m", defaults.radius_m);
  formData.append("max_pages", defaults.max_pages);
  formData.append("cooldown_seconds", defaults.cooldown_seconds);

  btn.disabled = true;
  btn.textContent = "⏳ Validating...";
  statusEl.textContent = "";

  try {
    const resp = await fetch(`${API_BASE_URL}/extraction-runs/validate-csv`, { method: "POST", body: formData });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

    lastValidation = {
      upload_token: data.upload_token,
      source_csv_filename: data.source_csv_filename,
      source_csv_path: data.source_csv_path,
      valid_stores: data.valid_stores,
      defaults_used: data.defaults_used,
    };

    renderPreview(data);
    statusEl.textContent = `✅ Parsed ${data.total_rows} row(s) — ${data.valid_stores.length} valid, ${data.row_errors.length} skipped.`;
  } catch (err) {
    statusEl.textContent = `❌ ${err.message}`;
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "🔍 Validate";
  }
}

function renderPreview(data) {
  const panel = document.getElementById("preview-panel");
  panel.classList.remove("hidden");

  document.getElementById("valid-summary").innerHTML =
    `<div class="stats-box">
      <div class="stat"><span>${data.total_rows}</span><label>Rows in file</label></div>
      <div class="stat"><span>${data.valid_stores.length}</span><label>Valid stores</label></div>
      <div class="stat"><span>${data.row_errors.length}</span><label>Skipped rows</label></div>
    </div>`;

  const errorsEl = document.getElementById("row-errors");
  if (data.row_errors.length > 0) {
    errorsEl.innerHTML =
      `<p class="warning-text">⚠️ ${data.row_errors.length} row(s) skipped:</p>
      <ul class="error-list">${data.row_errors.map((e) => `<li>Row ${e.row}: ${e.reason}</li>`).join("")}</ul>`;
  } else {
    errorsEl.innerHTML = "";
  }

  const previewEl = document.getElementById("valid-preview");
  if (data.valid_stores.length > 0) {
    previewEl.innerHTML =
      `<table class="results-table"><thead><tr><th>Row</th><th>Label</th><th>Lat</th><th>Lng</th></tr></thead><tbody>
        ${data.valid_stores.map((s) => `<tr><td>${s.row}</td><td>${s.label}</td><td>${s.center_lat}</td><td>${s.center_lng}</td></tr>`).join("")}
      </tbody></table>`;
  } else {
    previewEl.innerHTML = `<p class="hint">No valid rows to extract.</p>`;
  }

  document.getElementById("start-btn").disabled = data.valid_stores.length === 0;
  document.getElementById("start-status").textContent = "";
}

async function startExtraction() {
  if (!lastValidation || lastValidation.valid_stores.length === 0) return;

  const startBtn = document.getElementById("start-btn");
  const statusEl = document.getElementById("start-status");
  startBtn.disabled = true;
  statusEl.textContent = "";

  const stores = lastValidation.valid_stores.map((s) => {
    const { row, ...store } = s;
    return store;
  });

  try {
    const resp = await fetch(`${API_BASE_URL}/extraction-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        defaults: lastValidation.defaults_used,
        stores,
        source_csv_filename: lastValidation.source_csv_filename,
        source_csv_path: lastValidation.source_csv_path,
      }),
    });
    const data = await resp.json();

    if (resp.status === 409) {
      const startedAt = data.active_batch ? fmtDateTime(data.active_batch.started_at) : "";
      statusEl.innerHTML = `⚠️ A batch is already running${startedAt ? ` (started ${startedAt})` : ""} — <a href="history.html">watch it in Run History</a> instead.`;
      startBtn.disabled = false;
      return;
    }
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

    statusEl.textContent = `✅ Batch #${data.batch_id} queued (${data.store_count} store(s)).`;
    beginProgressTracking(data.batch_id);
  } catch (err) {
    statusEl.textContent = `❌ ${err.message}`;
    console.error(err);
    startBtn.disabled = false;
  }
}

function beginProgressTracking(batchId) {
  document.getElementById("progress-panel").classList.remove("hidden");
  document.getElementById("progress-panel").scrollIntoView({ behavior: "smooth" });

  if (currentPoll) currentPoll.stop();
  currentPoll = pollExtractionRun(API_BASE_URL, batchId, {
    onUpdate: (data) => renderProgress(batchId, data),
    onError: (err) => {
      document.getElementById("progress-status").textContent = `⚠️ Polling error: ${err.message} (retrying...)`;
    },
  });
}

function renderProgress(batchId, data) {
  const statusEl = document.getElementById("progress-status");
  statusEl.innerHTML = `${statusBadge(data.status)} — ${data.completed_stores}/${data.total_stores} store(s) processed`;

  document.getElementById("store-status-list").innerHTML =
    `<ul class="store-status-list">${data.stores
      .map((s) => `<li>${statusBadge(s.status)} <b>${s.label}</b>${s.resolved_city_name ? ` — ${s.resolved_city_name}` : ""}${s.listing_count ? ` (${s.listing_count} listings)` : ""}${s.error_message ? ` — <span class="error-text">${s.error_message}</span>` : ""}</li>`)
      .join("")}</ul>`;

  if (data.new_log_lines && data.new_log_lines.length > 0) {
    const console_ = document.getElementById("log-console");
    const atBottom = console_.scrollTop + console_.clientHeight >= console_.scrollHeight - 20;
    console_.textContent += data.new_log_lines.join("\n");
    if (atBottom) console_.scrollTop = console_.scrollHeight;
  }

  if (data.status !== "queued" && data.status !== "running") {
    if (currentPoll) currentPoll.stop();
    document.getElementById("progress-links").innerHTML = `<a href="history.html">📜 View full run in Run History</a>`;
  }
}
