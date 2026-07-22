// ═══════════════════════════════════════════════════
//  Shared helpers reused by upload.js / history.js / listings.js —
//  API base URL resolution, formatting, and the extraction-run polling
//  loop (used by both the upload page while a batch is running and the
//  history page when resuming a still-running batch).
// ═══════════════════════════════════════════════════

// Same resolution order as script.js's config.json read, but these
// pages don't need the rest of config.json (no map, no grid) — just the
// API base URL, with the same localhost fallback.
async function getApiBaseUrl() {
  try {
    const config = await fetch("config.json").then((r) => r.json());
    return config.api_base_url || "http://localhost:3001/api";
  } catch {
    return "http://localhost:3001/api";
  }
}

function fmtRupee(n) {
  return n == null ? "—" : `₹${Math.round(n).toLocaleString("en-IN")}`;
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function fmtDuration(startIso, endIso) {
  if (!startIso) return "—";
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ${seconds % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

const STATUS_LABELS = {
  queued: "⏳ Queued",
  running: "🔄 Running",
  success: "✅ Success",
  partial: "⚠️ Partial",
  failed: "❌ Failed",
  pending: "⏳ Pending",
  empty: "📭 Empty",
};

function statusBadge(status) {
  const label = STATUS_LABELS[status] || status;
  return `<span class="status-badge status-${status}">${label}</span>`;
}

/**
 * Polls GET /extraction-runs/:id/status every intervalMs until the batch
 * reaches a terminal status (success/partial/failed), calling onUpdate
 * with each poll's response. Returns a stop() function the caller can
 * use to cancel early (e.g. navigating away).
 */
function pollExtractionRun(apiBaseUrl, batchId, { onUpdate, onError, intervalMs = 3000 } = {}) {
  let stopped = false;
  let sinceOffset = 0;

  async function tick() {
    if (stopped) return;
    try {
      const resp = await fetch(`${apiBaseUrl}/extraction-runs/${batchId}/status?since=${sinceOffset}`);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      sinceOffset = data.next_offset;
      onUpdate && onUpdate(data);

      if (!stopped && (data.status === "queued" || data.status === "running")) {
        setTimeout(tick, intervalMs);
      }
    } catch (e) {
      onError && onError(e);
      if (!stopped) setTimeout(tick, intervalMs);
    }
  }

  tick();
  return { stop: () => { stopped = true; } };
}
