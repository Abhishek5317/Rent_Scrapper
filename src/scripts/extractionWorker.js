/**
 * extractionWorker.js
 *
 * The process the API spawns (detached, unref'd — see src/api/routes/
 * extraction.js's POST /extraction-runs) to actually run a web-triggered
 * batch. Deliberately a SEPARATE OS process from the Express server, not
 * something running inside a request handler — a batch can take 30-90+
 * minutes (scrape delays, geocode rate limits, inter-store cooldowns),
 * which would otherwise block the entire API for that whole time.
 *
 * Drives the exact same src/pipeline/extractionPipeline.js runBatch()
 * the CLI (batchProcessStores.js) uses — this worker only differs in
 * WHERE progress goes: a per-batch log file (readable live via polling,
 * and downloadable afterward) plus Postgres row updates, instead of the
 * terminal.
 *
 * Run: node src\scripts\extractionWorker.js --batchId=<id>
 * (never invoked directly by a person — POST /extraction-runs spawns it)
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { runBatch } = require("../pipeline/extractionPipeline");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const LOGS_DIR = path.join(PROJECT_ROOT, "logs");

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PGHOST || "localhost",
        port: parseInt(process.env.PGPORT || "5432", 10),
        user: process.env.PGUSER || "postgres",
        password: process.env.PGPASSWORD || "postgres",
        database: process.env.PGDATABASE || "skymark",
      }
);

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    const m = arg.match(/^--(\w+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  });
  return args;
}

/**
 * Formats a progress event into the same human-readable text shape
 * batchProcessStores.js prints to the terminal, so a downloaded run log
 * reads like a normal terminal transcript. Kept separate from (but
 * intentionally mirroring) batchProcessStores.js's onProgress formatting.
 */
function formatEvent(event) {
  switch (event.type) {
    case "log":
      return event.text;
    case "store-note":
    case "batch-note":
      return event.text + "\n";
    case "step-start":
      return `\n  → ${event.step}...\n`;
    case "cooldown":
      if (event.reason.includes("precautionary")) {
        return `\n⚠️  2 consecutive stores came back troubled — pausing ${event.seconds}s (much longer than\n   the normal cooldown) before the next attempt, as a precaution.\n`;
      }
      return `\n  ⏳ Cooling down for ${event.seconds}s before the next store...\n`;
    default:
      return null;
  }
}

async function loadBatch(client, batchId) {
  const { rows } = await client.query("SELECT * FROM extraction_batches WHERE id = $1", [batchId]);
  if (rows.length === 0) throw new Error(`extraction_batches row ${batchId} not found`);
  return rows[0];
}

async function loadStores(client, batchId) {
  const { rows } = await client.query(
    "SELECT * FROM extraction_batch_stores WHERE batch_id = $1 ORDER BY store_index",
    [batchId]
  );
  return rows;
}

async function markStoreRunning(client, batchId, index) {
  await client.query(
    `UPDATE extraction_batch_stores SET status = 'running', started_at = now()
     WHERE batch_id = $1 AND store_index = $2`,
    [batchId, index]
  );
}

async function markStoreResult(client, batchId, index, result) {
  let cityId = null;
  if (result.storeKey) {
    const { rows } = await client.query("SELECT id FROM cities WHERE name = $1", [result.storeKey]);
    cityId = rows[0]?.id ?? null;
  }

  await client.query(
    `UPDATE extraction_batch_stores SET
       status = $1, store_key = $2, city_id = $3, resolved_city_name = $4,
       listing_count = $5, archive_path = $6, error_message = $7, finished_at = now()
     WHERE batch_id = $8 AND store_index = $9`,
    [
      result.status,
      result.storeKey || null,
      cityId,
      result.cityName || null,
      result.listingCount || 0,
      result.archivePath || null,
      result.error || null,
      batchId,
      index,
    ]
  );

  const column = result.status === "success" ? "succeeded_count" : result.status === "empty" ? "empty_count" : "failed_count";
  await client.query(
    `UPDATE extraction_batches SET completed_stores = completed_stores + 1, ${column} = ${column} + 1 WHERE id = $1`,
    [batchId]
  );
}

async function run() {
  const args = parseArgs();
  const batchId = parseInt(args.batchId, 10);
  if (Number.isNaN(batchId)) {
    console.error("extractionWorker.js requires --batchId=<id>");
    process.exit(1);
  }

  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = path.join(LOGS_DIR, `extraction_${batchId}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const client = await pool.connect();

  // Crash-safety: if this process dies unexpectedly (uncaught exception,
  // unhandled rejection, OS kill), make sure the batch never gets stuck
  // showing 'running' forever — the run-history page and the single-
  // flight lock (idx_extraction_batches_one_active) both depend on
  // status eventually leaving 'queued'/'running'.
  async function failHard(err) {
    logStream.write(`\n\nFATAL: extraction worker crashed: ${err.message}\n${err.stack || ""}\n`);
    try {
      await pool.query(
        `UPDATE extraction_batches SET status = 'failed', error_message = $1, finished_at = now() WHERE id = $2`,
        [err.message, batchId]
      );
    } catch (e2) {
      // Last resort — nothing more we can do if even this fails.
      logStream.write(`\n\nAlso failed to persist the crash to Postgres: ${e2.message}\n`);
    }
    await new Promise((resolve) => logStream.end(resolve));
    process.exit(1);
  }
  process.on("uncaughtException", (err) => failHard(err));
  process.on("unhandledRejection", (err) => failHard(err instanceof Error ? err : new Error(String(err))));

  try {
    const batch = await loadBatch(client, batchId);
    const storeRows = await loadStores(client, batchId);
    const defaults = batch.defaults || {};
    const stores = storeRows.map((r) => ({
      label: r.label,
      center_lat: r.center_lat,
      center_lng: r.center_lng,
    }));

    await client.query(`UPDATE extraction_batches SET log_path = $1, status = 'running' WHERE id = $2`, [logPath, batchId]);
    logStream.write(`Extraction batch #${batchId} started — ${stores.length} store(s).\n`);

    // extractionPipeline.js's processStore/runBatch `await` every call to
    // onProgress (see its comments) specifically so that a caller doing
    // async work here — like these Postgres writes — is guaranteed to
    // have finished before the pipeline moves on, and so the LAST event
    // of the whole batch is guaranteed to have finished before run()
    // below proceeds to close the log stream and exit. A failure to
    // persist one progress update is logged but never thrown, so it
    // can't be mistaken for the store's own pipeline step failing.
    const onProgress = async (event) => {
      const text = formatEvent(event);
      if (text) logStream.write(text);

      try {
        if (event.type === "store-start") {
          await markStoreRunning(client, batchId, event.index);
        } else if (event.type === "store-result") {
          await markStoreResult(client, batchId, event.index, event.result);
        }
      } catch (e) {
        logStream.write(`\n(non-fatal) progress update failed: ${e.message}\n`);
      }
    };

    // detachChildren: true — this worker itself has no interactive user
    // who'd want to Ctrl+C it (it's a detached background process
    // triggered from a web request), so its own pipeline steps
    // (scraper/seed/ingest/aggregate) get their own Windows process
    // group too, insulating them from a Ctrl+C sent to whatever
    // terminal happens to be running the API server. See runStep()'s
    // doc comment in extractionPipeline.js for the caveats (this does
    // NOT protect against a terminal host's Job Object killing the
    // whole tree, e.g. closing a VS Code integrated terminal — that's
    // what this file's own crash-safety handlers above are for).
    const results = await runBatch(stores, defaults, { onProgress, detachChildren: true });

    const succeeded = results.filter((r) => r.status === "success").length;
    const empty = results.filter((r) => r.status === "empty").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const finalStatus = failed === results.length ? "failed" : failed > 0 || empty > 0 ? "partial" : "success";

    logStream.write(`\n\nBatch #${batchId} finished: ${succeeded} succeeded, ${empty} empty, ${failed} failed.\n`);
    await client.query(
      `UPDATE extraction_batches SET status = $1, finished_at = now() WHERE id = $2`,
      [finalStatus, batchId]
    );

    // Wait for the stream's internal buffer to actually flush to disk —
    // fs.WriteStream.write() queues data asynchronously; calling
    // process.exit() right after it (without waiting for 'finish') can
    // truncate the last few writes, which would both corrupt the
    // downloadable log and make a "tail -f"-style poll miss the final
    // lines right when a user is most likely to be watching.
    await new Promise((resolve) => logStream.end(resolve));
    client.release();
    await pool.end();
    process.exit(0);
  } catch (e) {
    client.release();
    await failHard(e);
  }
}

run();
