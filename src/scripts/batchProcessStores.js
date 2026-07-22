/**
 * batchProcessStores.js
 *
 * Runs the full pipeline (scrape → seed → ingest → aggregate) for every
 * store listed in stores.json, one after another, automatically.
 *
 * This exists because doing the 5-command manual sequence from the
 * project README once per store doesn't scale past a handful of
 * locations — this loops through as many as you give it.
 *
 * Run: node src\scripts\batchProcessStores.js [--input=stores.json]
 *
 * RESILIENCE: if one store fails for any reason (bad coordinates, zero
 * listings found in that area, a transient network error), the batch
 * logs it and moves on to the next store rather than aborting the
 * whole run — you get a full pass/fail report at the end instead of
 * losing all progress because store #7 out of #30 had a problem.
 *
 * This is now a thin wrapper around src/pipeline/extractionPipeline.js —
 * the same shared library the web UI's background worker
 * (src/scripts/extractionWorker.js) drives, so the CLI and the web-
 * triggered path can never silently diverge. Only the console-formatting
 * of progress events lives here; the actual pipeline/cooldown/circuit-
 * breaker logic is all in extractionPipeline.js.
 */

const fs = require("fs");
const path = require("path");
const { ARCHIVE_DIR, runBatch } = require("../pipeline/extractionPipeline");

const PROJECT_ROOT = path.join(__dirname, "..", "..");

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    const m = arg.match(/^--(\w+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  });
  return args;
}

function loadStores(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `Store list not found at ${inputPath}. Create a stores.json (see the ` +
      `example alongside this script) listing each store's center_lat/center_lng.`
    );
  }
  const data = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  if (!Array.isArray(data.stores) || data.stores.length === 0) {
    throw new Error(`${inputPath} has no "stores" array, or it's empty.`);
  }
  return { defaults: data.defaults || {}, stores: data.stores };
}

/**
 * Reproduces the exact console output the pipeline used to print
 * directly, now driven by extractionPipeline.js's onProgress events —
 * this is the only thing that changed for CLI users, and it's
 * output-for-output identical to before the refactor.
 */
function onProgress(event) {
  switch (event.type) {
    case "log":
      process[event.stream].write(event.text);
      break;
    case "store-note":
    case "batch-note":
      console.log(event.text);
      break;
    case "step-start":
      console.log(`\n  → ${event.step}...`);
      break;
    case "cooldown":
      if (event.reason.includes("precautionary")) {
        console.log(`\n⚠️  2 consecutive stores came back troubled — pausing ${event.seconds}s (much longer than `);
        console.log(`   the normal cooldown) before the next attempt, as a precaution.`);
      } else {
        console.log(`\n  ⏳ Cooling down for ${event.seconds}s before the next store...`);
      }
      break;
    // 'store-result' and 'circuit-breaker-stop' carry no additional
    // console output beyond what 'store-note'/'batch-note' already
    // printed for the same event — nothing to do here.
    default:
      break;
  }
}

async function run() {
  const args = parseArgs();
  const inputPath = path.resolve(PROJECT_ROOT, args.input || "stores.json");

  const { defaults, stores } = loadStores(inputPath);
  console.log(`Loaded ${stores.length} store(s) from ${inputPath}`);

  const results = await runBatch(stores, defaults, { onProgress });

  // ── Summary report ──
  console.log(`\n\n${"=".repeat(60)}`);
  console.log("BATCH SUMMARY");
  console.log("=".repeat(60));
  const succeeded = results.filter((r) => r.status === "success");
  const empty = results.filter((r) => r.status === "empty");
  const failed = results.filter((r) => r.status === "failed");

  console.log(`\n✅ Succeeded: ${succeeded.length}/${results.length}`);
  succeeded.forEach((r) => console.log(`   ${r.label} → stored as "${r.storeKey}" (${r.cityName}, ${r.listingCount} listings)`));

  if (empty.length > 0) {
    console.log(`\n⚠️  Zero listings (likely bot-check — re-run these separately, not back-to-back): ${empty.length}/${results.length}`);
    empty.forEach((r) => console.log(`   ${r.label} → ${r.cityName}`));
  }

  if (failed.length > 0) {
    console.log(`\n❌ Failed: ${failed.length}/${results.length}`);
    failed.forEach((r) => console.log(`   ${r.label} → ${r.error}`));
  }

  console.log(`\nScraped data archived in: ${ARCHIVE_DIR}`);
  console.log("Done.");
}

run().catch((e) => {
  console.error("Batch processing crashed:", e.message);
  process.exit(1);
});
