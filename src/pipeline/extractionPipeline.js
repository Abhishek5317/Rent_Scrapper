/**
 * extractionPipeline.js
 *
 * Shared pipeline logic (scrape → seed → ingest → aggregate, per store,
 * with a cooldown + circuit-breaker between stores) — extracted out of
 * batchProcessStores.js so BOTH the CLI entrypoint
 * (src/scripts/batchProcessStores.js) and the web-triggered background
 * worker (src/scripts/extractionWorker.js) drive the exact same logic
 * instead of two copies drifting apart.
 *
 * Every function that used to `console.log` directly now takes an
 * `onProgress(event)` callback instead — the CLI wrapper's onProgress
 * reproduces today's console output exactly (see batchProcessStores.js),
 * the worker's onProgress writes to a per-batch log file + Postgres.
 *
 * runStep() is the one behavioral change from the original: spawnSync
 * (blocking, stdio:"inherit") became async spawn() with streamed
 * onOutput chunks — required so this can run inside a long-lived
 * background worker process without freezing anything else in it. The
 * default onOutput writes straight to process.stdout/stderr, so CLI
 * behavior is unchanged.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");
const SCRAPED_OUTPUT_PATH = path.join(PROJECT_ROOT, "scraped_listings.jsonl");
const ARCHIVE_DIR = path.join(PROJECT_ROOT, "scraped_archive");

/**
 * Sanitizes a store's label into a safe, stable, UNIQUE database key.
 * This is the actual fix for the "multiple stores in one city" problem:
 * the auto-resolved city name (e.g. "Bengaluru") is IDENTICAL for every
 * store in that city, so using it as the database lookup key means a
 * second store silently overwrites the first one's grid/center point —
 * exactly what happened testing two different Bengaluru locations.
 * Each store's own label is already meant to be unique (that's the whole
 * point of giving each one a distinct name) — using IT as the key instead
 * fixes the collision at the source.
 */
function sanitizeStoreKey(label) {
  const cleaned = label.trim().replace(/[^a-zA-Z0-9\s.'-]/g, "").slice(0, 90);
  if (!cleaned) {
    throw new Error(`Store label "${label}" has no usable characters after sanitizing — give it a real name.`);
  }
  return cleaned;
}

function writeStoreConfig(store, defaults) {
  const storeKey = sanitizeStoreKey(store.label || `Store_${store.center_lat}_${store.center_lng}`);
  const config = {
    center_lat: store.center_lat,
    center_lng: store.center_lng,
    cell_size_m: store.cell_size_m || defaults.cell_size_m || 200,
    radius_m: store.radius_m || defaults.radius_m || 5000,
    max_pages: store.max_pages || defaults.max_pages || 5,
    api_base_url: defaults.api_base_url || "http://localhost:3001/api",
    // This becomes the actual database key (see resolveDbKey below) —
    // NOT passed as city_name, so the scraper's own reverse-geocoding
    // and MagicBricks search logic are completely unaffected. This is
    // purely about what key ingest.js/seedCity.js/computeStats.js use
    // to store and look up this store's data.
    store_key: storeKey,
  };
  if (store.magicbricks_locality) config.magicbricks_locality = store.magicbricks_locality;
  if (store.magicbricks_city_name) config.magicbricks_city_name = store.magicbricks_city_name;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return storeKey;
}

function readResolvedCityName() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const cityName = config.city_name || null;

  // Defense-in-depth: city_name originates from EXTERNAL data (Nominatim's
  // reverse-geocoding response), not something this project controls. It
  // gets passed as a command-line argument to ingest.js/computeStats.js
  // below — validating it's a plausible city name (letters, spaces, basic
  // punctuation only) before that happens costs nothing and closes off an
  // entire class of injection risk, however unlikely, from unexpected
  // characters in a geocoding result.
  if (cityName && !/^[a-zA-ZÀ-ɏ\s.'-]+$/.test(cityName)) {
    throw new Error(
      `Resolved city_name "${cityName}" contains unexpected characters — refusing to use it ` +
      `as a command-line argument. This is likely a data issue with the geocoding response, ` +
      `not a real city name.`
    );
  }

  return cityName;
}

/**
 * Runs a command asynchronously, streaming stdout/stderr chunks to
 * onOutput as they arrive (default: straight to process.stdout/stderr,
 * so CLI behavior is unchanged), and resolves/rejects based on the exit
 * code — same contract the old spawnSync-based version had, just
 * non-blocking so it's safe to call from inside a long-lived worker
 * process.
 *
 * Deliberately NOT using shell:true — that option builds a shell command
 * by concatenating arguments as raw text rather than passing them safely,
 * which matters here since one argument (the city name) ultimately comes
 * from external geocoding data. python/node both run fine without it.
 *
 * detachChild (Windows-specific hardening): when true, spawns with its
 * own process group (Node's `detached: true`, which on Windows gives the
 * child its own console) so a Ctrl+C or console-close event delivered to
 * WHATEVER terminal launched the top-level caller doesn't cascade down
 * to this step's child process (python/node). extractionWorker.js (the
 * web-triggered background path) opts into this — a batch can run for
 * 30-90+ minutes unattended and has no interactive user who'd want to
 * Ctrl+C it. batchProcessStores.js (the CLI path) deliberately does NOT
 * opt in, so a person running it by hand can still Ctrl+C to abort — a
 * detached child would keep running orphaned in the background instead,
 * which is worse UX for an interactive session than being killable.
 * Note this is a mitigation, not a complete guarantee: some terminal
 * hosts (e.g. VS Code's integrated terminal) track all descendant
 * processes via a Windows Job Object independent of console process
 * groups, and closing that terminal/IDE can still terminate the whole
 * tree regardless of this flag — hence extractionWorker.js's separate
 * crash-safety handlers (see there) as the real backstop.
 */
function runStep(label, command, args, { onOutput, onLabel, detachChild } = {}) {
  const emitOutput = onOutput || ((chunk, stream) => process[stream].write(chunk));
  if (onLabel) onLabel(label);
  else process.stdout.write(`\n  → ${label}...\n`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      detached: !!detachChild,
      windowsHide: !!detachChild,
    });

    child.stdout.on("data", (chunk) => emitOutput(chunk, "stdout"));
    child.stderr.on("data", (chunk) => emitOutput(chunk, "stderr"));

    child.on("error", (err) => reject(new Error(`${label} failed to start: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${label} exited with code ${code}`));
      else resolve();
    });
  });
}

function countListings() {
  if (!fs.existsSync(SCRAPED_OUTPUT_PATH)) return 0;
  return fs.readFileSync(SCRAPED_OUTPUT_PATH, "utf-8").split("\n").filter((l) => l.trim()).length;
}

/**
 * Archives the just-scraped JSONL under a name derived from the store's
 * key (not the resolved city name — same collision-avoidance reasoning
 * as sanitizeStoreKey). Returns the path it wrote so callers can persist
 * it (e.g. extraction_batch_stores.archive_path) — the original CLI-only
 * version didn't need a return value since nothing downstream re-read it.
 */
function archiveScrapedFile(storeKey) {
  if (!fs.existsSync(SCRAPED_OUTPUT_PATH)) return null;
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeStoreKey = (storeKey || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const archivePath = path.join(ARCHIVE_DIR, `${safeStoreKey}_${timestamp}.jsonl`);
  fs.copyFileSync(SCRAPED_OUTPUT_PATH, archivePath);
  return archivePath;
}

/**
 * Processes one store through the full pipeline. onProgress receives:
 *   {type:'log', text, stream}                         — raw child output
 *   {type:'step-start', step}                            — before each of the 4 steps
 *   {type:'store-note', text}                             — human-readable status lines
 * Returns {label, cityName, storeKey, listingCount, archivePath, status}
 * where status is 'success' | 'empty' | (throws on real failure).
 */
async function processStore(store, defaults, { index, total, onProgress, detachChildren }) {
  // emit is awaited everywhere below EXCEPT from inside runStep's
  // onOutput (streamed child-process output chunks) — those fire
  // synchronously per chunk and the worker's handling of 'log' events is
  // itself synchronous (a plain log-file write), so there's nothing
  // meaningful to await there. Every other event (store-start,
  // store-note, store-result, etc.) IS awaited so that a caller like
  // extractionWorker.js — whose onProgress does async Postgres writes —
  // is guaranteed to have finished persisting one event before the next
  // one (or the pipeline's own completion) proceeds. Without this, the
  // very last store's result could still be mid-write to Postgres when
  // the worker process exits.
  const emit = onProgress || (() => {});
  const label = store.label || `Store ${index + 1}`;

  // Dedicated machine-readable "this store's turn began" signal (distinct
  // from the human-readable banner text below) — extractionWorker.js uses
  // this to mark the matching extraction_batch_stores row 'running'
  // without having to parse banner text. batchProcessStores.js's CLI
  // onProgress has no case for it, so it's a silent no-op there.
  await emit({ type: "store-start", index, label });
  await emit({ type: "store-note", text: `\n${"=".repeat(60)}\n[${index + 1}/${total}] ${label} (${store.center_lat}, ${store.center_lng})\n${"=".repeat(60)}` });

  const storeKey = writeStoreConfig(store, defaults);
  const onOutput = (chunk, stream) => emit({ type: "log", text: chunk.toString(), stream });

  await runStep("Scraping", "python", ["scraper\\magicbricks_scraper.py"], {
    onOutput,
    onLabel: (step) => emit({ type: "step-start", step }),
    detachChild: detachChildren,
  });

  const cityName = readResolvedCityName();
  if (!cityName) {
    throw new Error("Scraper finished but config.json has no city_name — reverse geocoding likely failed for these coordinates.");
  }
  await emit({ type: "store-note", text: `  Resolved city: ${cityName} (stored under unique key: "${storeKey}")` });

  const listingCount = countListings();
  const archivePath = archiveScrapedFile(storeKey);

  // A "successful" scraper exit with ZERO listings usually means MagicBricks
  // served a bot-check/CAPTCHA page instead of real results (the scraper
  // logs this specifically) — often triggered by many rapid successive
  // requests across a fast multi-city batch. Rather than silently reporting
  // this as a clean success (0 listings, 0 grid cells with data), flag it
  // distinctly so it's obvious this store needs a manual re-run later,
  // ideally on its own rather than back-to-back with others.
  if (listingCount === 0) {
    await emit({ type: "store-note", text: `  ⚠️  Zero listings scraped — likely hit a bot-check page (see bootstrap_debug.png). Skipping seed/ingest/aggregate for this store.` });
    return { label, cityName, storeKey, listingCount: 0, archivePath, status: "empty" };
  }

  // storeKey (not cityName!) is what gets used as the actual database
  // key from here on — this is the fix for multiple stores sharing one
  // city. seedCity.js reads config.json directly (see writeStoreConfig
  // above, which already wrote store_key into it) and prefers store_key
  // over city_name for exactly this reason.
  await runStep("Seeding grid", "node", ["src\\scripts\\seedCity.js"], { onOutput, onLabel: (step) => emit({ type: "step-start", step }), detachChild: detachChildren });
  await runStep("Ingesting", "node", ["src\\ingestion\\ingest.js", `--city=${storeKey}`, `--input=scraped_listings.jsonl`], { onOutput, onLabel: (step) => emit({ type: "step-start", step }), detachChild: detachChildren });
  await runStep("Aggregating", "node", ["src\\aggregation\\computeStats.js", `--city=${storeKey}`], { onOutput, onLabel: (step) => emit({ type: "step-start", step }), detachChild: detachChildren });

  return { label, cityName, storeKey, listingCount, archivePath, status: "success" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drives every store in `stores` sequentially, with the cooldown +
 * circuit-breaker safety behavior between attempts. onProgress receives
 * everything processStore() emits, plus:
 *   {type:'store-result', index, result}   — after each store finishes/fails
 *   {type:'cooldown', seconds, reason}     — before a cooldown sleep
 *   {type:'circuit-breaker-stop', remaining} — batch halted early
 *   {type:'batch-note', text}              — misc status lines (e.g. summary)
 * Returns the same results[] array shape the original CLI script printed
 * a summary from.
 */
async function runBatch(stores, defaults, { onProgress, detachChildren } = {}) {
  const emit = onProgress || (() => {});
  const results = [];
  let consecutiveTroubled = 0;

  for (let i = 0; i < stores.length; i++) {
    const store = stores[i];
    let troubled = false;
    let result;
    try {
      result = await processStore(store, defaults, { index: i, total: stores.length, onProgress, detachChildren });
      results.push(result);
      troubled = result.status === "empty";
    } catch (e) {
      await emit({ type: "store-note", text: `\n  ❌ FAILED: ${e.message}` });
      result = {
        label: store.label || `Store ${i + 1}`,
        cityName: null,
        storeKey: null,
        listingCount: 0,
        archivePath: null,
        status: "failed",
        error: e.message,
      };
      results.push(result);
      troubled = true;
      // Deliberately continue to the next store rather than exiting —
      // one bad location shouldn't lose progress on the rest of the batch.
    }

    await emit({ type: "store-result", index: i, result });

    // Circuit breaker: repeated back-to-back empty/failed stores is a
    // meaningfully different situation than one isolated bad location —
    // it's a real signal that something broader might be wrong (an
    // actual IP-level block, MagicBricks being down, a network issue),
    // and continuing to hammer away every ~45s would only make a real
    // block worse. Escalate the response instead of treating every
    // failure identically.
    if (troubled) consecutiveTroubled++;
    else consecutiveTroubled = 0;

    if (consecutiveTroubled >= 3) {
      const remaining = stores.length - i - 1;
      await emit({
        type: "batch-note",
        text: `\n🛑 STOPPING BATCH: ${consecutiveTroubled} consecutive stores came back empty/failed.\n` +
          `   This pattern suggests something broader than one bad location — possibly an actual\n` +
          `   IP-level block. Continuing would likely make it worse. Remaining ${remaining}\n` +
          `   store(s) were NOT attempted — wait a while (hours, not minutes) before resuming, and\n` +
          `   consider checking bootstrap_debug.png from the last attempt to confirm what's happening.`,
      });
      await emit({ type: "circuit-breaker-stop", remaining });
      break;
    } else if (consecutiveTroubled === 2) {
      if (i < stores.length - 1) {
        const longCooldown = 300;
        await emit({ type: "cooldown", seconds: longCooldown, reason: "2 consecutive stores came back troubled — precautionary long cooldown" });
        await sleep(longCooldown * 1000);
      }
      continue; // skip the normal shorter cooldown below, already handled above
    }

    // Cooldown between stores — a fast multi-city batch means many rapid
    // successive automated visits to MagicBricks in a short window, which
    // can trigger bot detection. Skip the wait after the very last store.
    if (i < stores.length - 1) {
      const cooldownSeconds = defaults.cooldown_seconds ?? 45;
      await emit({ type: "cooldown", seconds: cooldownSeconds, reason: "normal between-store cooldown" });
      await sleep(cooldownSeconds * 1000);
    }
  }

  return results;
}

module.exports = {
  PROJECT_ROOT,
  CONFIG_PATH,
  SCRAPED_OUTPUT_PATH,
  ARCHIVE_DIR,
  sanitizeStoreKey,
  writeStoreConfig,
  readResolvedCityName,
  runStep,
  countListings,
  archiveScrapedFile,
  processStore,
  runBatch,
};
