/**
 * routes/extraction.js
 *
 * The web-UI replacement for hand-editing stores.json + running
 * batchProcessStores.js in a terminal:
 *
 *   POST /extraction-runs/validate-csv  — upload + validate a CSV of stores
 *   POST /extraction-runs               — start a batch (spawns a detached
 *                                          worker, see extractionWorker.js)
 *   GET  /extraction-runs               — run history list
 *   GET  /extraction-runs/:id           — one run's full detail
 *   GET  /extraction-runs/:id/status    — live poll (new log lines + per-store status)
 *   GET  /extraction-runs/:id/stores/:storeIndex/download — that store's archived JSONL
 *   GET  /extraction-runs/:id/log       — the full run log
 *
 * Same conventions as routes/grids.js: {error: "message"} + 404/500,
 * manual try/catch per route.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const pool = require("../db");
const { PROJECT_ROOT, ARCHIVE_DIR, sanitizeStoreKey } = require("../../pipeline/extractionPipeline");

const router = express.Router();

const UPLOADS_DIR = path.join(PROJECT_ROOT, "uploads");
const LOGS_DIR = path.join(PROJECT_ROOT, "logs");

function sanitizeOriginalName(name) {
  return (name || "upload.csv").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${sanitizeOriginalName(file.originalname)}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB — a store list is a small file; generous ceiling against a mistaken upload
  fileFilter: (req, file, cb) => cb(null, /\.csv$/i.test(file.originalname)),
});

const REQUIRED_COLUMNS = ["label", "center_lat", "center_lng"];
const OPTIONAL_NUMERIC_COLUMNS = ["cell_size_m", "radius_m", "max_pages"];
const OPTIONAL_PASSTHROUGH_COLUMNS = ["magicbricks_locality", "magicbricks_city_name"];

/**
 * Validates already-parsed CSV rows. Reject-the-whole-file is reserved
 * for structural problems (handled by the caller before this runs) —
 * everything here is row-level: skip + report, matching the pipeline's
 * existing "never silently lose the rest of the batch" philosophy.
 */
function validateRows(rows) {
  const valid = [];
  const rowErrors = [];
  const seenKeys = new Set();

  rows.forEach((row, i) => {
    const rowNum = i + 2; // +1 for 0-index, +1 for the header row
    const label = (row.label || "").trim();
    const lat = parseFloat(row.center_lat);
    const lng = parseFloat(row.center_lng);

    if (!label) {
      rowErrors.push({ row: rowNum, reason: "Missing or empty label" });
      return;
    }
    let storeKey;
    try {
      storeKey = sanitizeStoreKey(label);
    } catch (e) {
      rowErrors.push({ row: rowNum, reason: e.message });
      return;
    }
    const dedupeKey = storeKey.toLowerCase();
    if (seenKeys.has(dedupeKey)) {
      rowErrors.push({ row: rowNum, reason: `Duplicate label (after sanitizing) — "${storeKey}" already used by an earlier row in this file` });
      return;
    }
    if (Number.isNaN(lat) || lat < -90 || lat > 90) {
      rowErrors.push({ row: rowNum, reason: `Invalid center_lat "${row.center_lat}" — must be a number between -90 and 90` });
      return;
    }
    if (Number.isNaN(lng) || lng < -180 || lng > 180) {
      rowErrors.push({ row: rowNum, reason: `Invalid center_lng "${row.center_lng}" — must be a number between -180 and 180` });
      return;
    }

    seenKeys.add(dedupeKey);
    const store = { label, center_lat: lat, center_lng: lng };

    for (const col of OPTIONAL_NUMERIC_COLUMNS) {
      if (row[col] !== undefined && row[col] !== "") {
        const n = parseInt(row[col], 10);
        if (!Number.isNaN(n) && n > 0) store[col] = n;
      }
    }
    for (const col of OPTIONAL_PASSTHROUGH_COLUMNS) {
      if (row[col] !== undefined && row[col].trim() !== "") store[col] = row[col].trim();
    }

    valid.push({ row: rowNum, ...store });
  });

  return { valid, rowErrors };
}

// POST /extraction-runs/validate-csv
router.post("/extraction-runs/validate-csv", (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload failed: ${err.message}` });
    }
    if (err) {
      return res.status(400).json({ error: err.message || "Upload failed" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (expected a multipart field named \"file\")." });
    }

    let records;
    try {
      const raw = fs.readFileSync(req.file.path, "utf-8");
      records = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
    } catch (e) {
      return res.status(400).json({ error: `Could not parse CSV: ${e.message}` });
    }

    if (records.length === 0) {
      return res.status(400).json({ error: "CSV has no data rows." });
    }

    const headers = Object.keys(records[0]);
    const missingHeaders = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
    if (missingHeaders.length > 0) {
      return res.status(400).json({ error: `CSV is missing required column(s): ${missingHeaders.join(", ")}` });
    }

    const { valid, rowErrors } = validateRows(records);

    const defaults = {
      cell_size_m: parseInt(req.body.cell_size_m, 10) || 200,
      radius_m: parseInt(req.body.radius_m, 10) || 5000,
      max_pages: parseInt(req.body.max_pages, 10) || 5,
      cooldown_seconds: parseInt(req.body.cooldown_seconds, 10) || 45,
      api_base_url: "http://localhost:3001/api",
    };

    res.json({
      upload_token: req.file.filename,
      source_csv_filename: req.file.originalname,
      source_csv_path: req.file.path,
      total_rows: records.length,
      valid_stores: valid,
      row_errors: rowErrors,
      defaults_used: defaults,
    });
  });
});

// POST /extraction-runs
// Body: { defaults, stores, source_csv_filename, source_csv_path } — the
// client echoes back exactly what validate-csv returned (minus any rows
// it chose to drop), so this endpoint never re-reads or re-parses the
// CSV itself — no TOCTOU risk between validate and start.
router.post("/extraction-runs", async (req, res) => {
  const { defaults, stores, source_csv_filename, source_csv_path } = req.body || {};

  if (!Array.isArray(stores) || stores.length === 0) {
    return res.status(400).json({ error: "No stores provided — validate a CSV first." });
  }
  for (const s of stores) {
    if (!s.label || typeof s.center_lat !== "number" || typeof s.center_lng !== "number") {
      return res.status(400).json({ error: "Every store needs a label, center_lat, and center_lng." });
    }
  }

  const client = await pool.connect();
  try {
    // Single-flight check — the DB partial unique index
    // (idx_extraction_batches_one_active) is the real guard against a
    // race between two near-simultaneous clicks; this SELECT just gives
    // a friendlier error message in the common (non-race) case.
    const { rows: active } = await client.query(
      `SELECT id, started_at FROM extraction_batches WHERE status IN ('queued','running') LIMIT 1`
    );
    if (active.length > 0) {
      return res.status(409).json({
        error: "A batch is already running — only one extraction can run at a time.",
        active_batch: active[0],
      });
    }

    await client.query("BEGIN");
    const { rows: batchRows } = await client.query(
      `INSERT INTO extraction_batches (status, total_stores, defaults, source_csv_filename, source_csv_path)
       VALUES ('queued', $1, $2, $3, $4) RETURNING id`,
      [stores.length, JSON.stringify(defaults || {}), source_csv_filename || null, source_csv_path || null]
    );
    const batchId = batchRows[0].id;

    for (let i = 0; i < stores.length; i++) {
      const s = stores[i];
      await client.query(
        `INSERT INTO extraction_batch_stores (batch_id, store_index, label, center_lat, center_lng)
         VALUES ($1, $2, $3, $4, $5)`,
        [batchId, i, s.label, s.center_lat, s.center_lng]
      );
    }
    await client.query("COMMIT");

    // Spawn the worker as its own detached process — NOT tied to this
    // request's lifecycle. stdio:"ignore" because the worker writes its
    // own log file directly; the API process needs no pipe/buffer for it.
    const child = spawn(
      process.execPath,
      [path.join(PROJECT_ROOT, "src", "scripts", "extractionWorker.js"), `--batchId=${batchId}`],
      { cwd: PROJECT_ROOT, detached: true, stdio: "ignore", env: process.env }
    );
    child.unref();

    res.status(202).json({ batch_id: batchId, status: "queued", store_count: stores.length });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("POST /extraction-runs failed:", e);
    // A unique-index violation here means the DB-level single-flight lock
    // caught a race the earlier SELECT missed (two near-simultaneous
    // requests) — surface it as the same 409, not a generic 500.
    if (e.code === "23505") {
      return res.status(409).json({ error: "A batch is already running — only one extraction can run at a time." });
    }
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

// GET /extraction-runs?limit=&offset=
router.get("/extraction-runs", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
  const offset = parseInt(req.query.offset, 10) || 0;

  try {
    const { rows: countRows } = await pool.query("SELECT COUNT(*) FROM extraction_batches");
    const { rows } = await pool.query(
      `SELECT id, status, total_stores, completed_stores, succeeded_count, empty_count, failed_count,
              source_csv_filename, started_at, finished_at
       FROM extraction_batches ORDER BY started_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ total_count: parseInt(countRows[0].count, 10), limit, offset, runs: rows });
  } catch (e) {
    console.error("GET /extraction-runs failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /extraction-runs/:id
router.get("/extraction-runs/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid run id" });

  try {
    const { rows: batchRows } = await pool.query("SELECT * FROM extraction_batches WHERE id = $1", [id]);
    if (batchRows.length === 0) return res.status(404).json({ error: `Run ${id} not found` });
    const batch = batchRows[0];

    const { rows: storeRows } = await pool.query(
      `SELECT store_index, label, center_lat, center_lng, status, store_key, resolved_city_name,
              listing_count, archive_path, error_message, started_at, finished_at
       FROM extraction_batch_stores WHERE batch_id = $1 ORDER BY store_index`,
      [id]
    );

    res.json({
      id: batch.id,
      status: batch.status,
      total_stores: batch.total_stores,
      completed_stores: batch.completed_stores,
      succeeded_count: batch.succeeded_count,
      empty_count: batch.empty_count,
      failed_count: batch.failed_count,
      defaults: batch.defaults,
      source_csv_filename: batch.source_csv_filename,
      started_at: batch.started_at,
      finished_at: batch.finished_at,
      error_message: batch.error_message,
      // Relative to API_BASE_URL (which already ends in "/api") — NOT
      // prefixed with "/api" here, since every caller (history.js) does
      // `${API_BASE_URL}${download_url}`. Double-prefixing this was a
      // real bug caught during end-to-end testing (produced a 404'ing
      // ".../api/api/..." URL).
      log_download_url: batch.log_path ? `/extraction-runs/${id}/log` : null,
      stores: storeRows.map((s) => ({
        index: s.store_index,
        label: s.label,
        center_lat: s.center_lat,
        center_lng: s.center_lng,
        status: s.status,
        store_key: s.store_key,
        resolved_city_name: s.resolved_city_name,
        listing_count: s.listing_count,
        error_message: s.error_message,
        started_at: s.started_at,
        finished_at: s.finished_at,
        download_url: s.archive_path ? `/extraction-runs/${id}/stores/${s.store_index}/download` : null,
      })),
    });
  } catch (e) {
    console.error(`GET /extraction-runs/${id} failed:`, e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /extraction-runs/:id/status?since=<byteOffset>
// Live poll: new log bytes since the client's last-seen offset (tail -f
// pattern) + a cheap per-store status summary. No in-memory state kept
// in the API process — Postgres + the log file are the only source of
// truth, so this stays correct even across an API server restart.
router.get("/extraction-runs/:id/status", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid run id" });
  const since = Math.max(parseInt(req.query.since, 10) || 0, 0);

  try {
    const { rows: batchRows } = await pool.query(
      "SELECT id, status, total_stores, completed_stores, log_path FROM extraction_batches WHERE id = $1",
      [id]
    );
    if (batchRows.length === 0) return res.status(404).json({ error: `Run ${id} not found` });
    const batch = batchRows[0];

    const { rows: storeRows } = await pool.query(
      `SELECT store_index, label, status, resolved_city_name, listing_count, error_message
       FROM extraction_batch_stores WHERE batch_id = $1 ORDER BY store_index`,
      [id]
    );

    let newLogLines = [];
    let nextOffset = since;
    if (batch.log_path && fs.existsSync(batch.log_path)) {
      const stat = fs.statSync(batch.log_path);
      nextOffset = stat.size;
      if (stat.size > since) {
        const fd = fs.openSync(batch.log_path, "r");
        const buf = Buffer.alloc(stat.size - since);
        fs.readSync(fd, buf, 0, buf.length, since);
        fs.closeSync(fd);
        newLogLines = buf.toString("utf-8").split("\n");
      }
    }

    res.json({
      batch_id: batch.id,
      status: batch.status,
      total_stores: batch.total_stores,
      completed_stores: batch.completed_stores,
      stores: storeRows.map((s) => ({
        index: s.store_index,
        label: s.label,
        status: s.status,
        resolved_city_name: s.resolved_city_name,
        listing_count: s.listing_count,
        error_message: s.error_message,
      })),
      new_log_lines: newLogLines,
      next_offset: nextOffset,
    });
  } catch (e) {
    console.error(`GET /extraction-runs/${id}/status failed:`, e);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Both download routes take ONLY integer route params — the servable
 * path always comes from the DB row, never from client input. Resolves
 * the recorded path and confirms it falls inside the expected directory
 * as defense-in-depth (not the primary control — nothing derived from
 * the request ever touches the filesystem path directly).
 */
function safeDownload(res, recordedPath, expectedDir, downloadName) {
  if (!recordedPath) return res.status(404).json({ error: "No file recorded for this run." });
  const resolved = path.resolve(recordedPath);
  if (!resolved.startsWith(expectedDir + path.sep)) {
    console.error(`Refusing to serve path outside ${expectedDir}: ${resolved}`);
    return res.status(500).json({ error: "Recorded path is outside the expected directory — refusing to serve." });
  }
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: "File no longer exists on disk." });
  }
  res.download(resolved, downloadName);
}

// GET /extraction-runs/:id/stores/:storeIndex/download
router.get("/extraction-runs/:id/stores/:storeIndex/download", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const storeIndex = parseInt(req.params.storeIndex, 10);
  if (Number.isNaN(id) || Number.isNaN(storeIndex)) return res.status(400).json({ error: "Invalid run id or store index" });

  try {
    const { rows } = await pool.query(
      "SELECT archive_path, store_key, label FROM extraction_batch_stores WHERE batch_id = $1 AND store_index = $2",
      [id, storeIndex]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Store not found in this run." });
    const row = rows[0];
    safeDownload(res, row.archive_path, ARCHIVE_DIR, `${row.store_key || row.label}.jsonl`);
  } catch (e) {
    console.error(`GET /extraction-runs/${id}/stores/${storeIndex}/download failed:`, e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /extraction-runs/:id/log
router.get("/extraction-runs/:id/log", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid run id" });

  try {
    const { rows } = await pool.query("SELECT log_path FROM extraction_batches WHERE id = $1", [id]);
    if (rows.length === 0) return res.status(404).json({ error: `Run ${id} not found` });
    safeDownload(res, rows[0].log_path, LOGS_DIR, `extraction_${id}.log`);
  } catch (e) {
    console.error(`GET /extraction-runs/${id}/log failed:`, e);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
