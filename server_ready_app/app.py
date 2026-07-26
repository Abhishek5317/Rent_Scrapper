from __future__ import annotations

import csv
import io
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request, send_from_directory
from waitress import serve

from providers import build_search_url, scrape
from storage import Storage

load_dotenv()

app = Flask(__name__)
storage = Storage(os.getenv("DATABASE_PATH", "data/rentiq.sqlite3"))
debug_dir = os.getenv("DEBUG_DIR", "debug")
Path(debug_dir).mkdir(parents=True, exist_ok=True)

state_lock = threading.Lock()
run_lock = threading.Lock()
current_state: dict[str, Any] = {
    "running": False,
    "run_id": None,
    "message": "Ready",
    "error": None,
    "listing_count": 0,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def set_state(**updates: Any) -> None:
    with state_lock:
        current_state.update(updates)


def run_scrape_job(
    run_id: str,
    requested_provider: str,
    city: str,
    locality: str | None,
    max_results: int,
    max_pages: int,
) -> None:
    try:
        set_state(message="Starting scraper", error=None, listing_count=0)
        selected_provider, search_url, listings = scrape(
            requested_provider,
            city,
            locality,
            max_results,
            max_pages,
            debug_dir,
        )
        storage.save_listings(run_id, listings)
        storage.finish_run(run_id, "success", len(listings), now_iso())
        set_state(
            message=f"Completed with {len(listings)} listings using {selected_provider}",
            listing_count=len(listings),
        )
    except Exception as exc:
        storage.finish_run(run_id, "failed", 0, now_iso(), str(exc))
        set_state(message="Scrape failed", error=str(exc), listing_count=0)
    finally:
        set_state(running=False)
        run_lock.release()


@app.get("/")
def index() -> str:
    return render_template("index.html", default_port=os.getenv("PORT", "8771"))


@app.get("/health")
def health() -> Response:
    return jsonify({"status": "ok", "provider": os.getenv("SCRAPE_PROVIDER", "auto")})


@app.get("/api/status")
def api_status() -> Response:
    with state_lock:
        return jsonify(dict(current_state))


@app.post("/api/scrape")
def api_scrape() -> Response:
    payload = request.get_json(silent=True) or {}
    city = str(payload.get("city", "")).strip()
    locality = str(payload.get("locality", "")).strip() or None
    provider = str(payload.get("provider") or os.getenv("SCRAPE_PROVIDER", "auto")).strip()

    try:
        max_results = min(max(int(payload.get("max_results", 50)), 1), 1000)
        max_pages = min(max(int(payload.get("max_pages", 3)), 1), 20)
    except (TypeError, ValueError):
        return jsonify({"error": "max_results and max_pages must be integers"}), 400

    if not city:
        return jsonify({"error": "city is required"}), 400
    if not run_lock.acquire(blocking=False):
        return jsonify({"error": "Another scrape is already running"}), 409

    run_id = uuid.uuid4().hex
    search_url = build_search_url(city, locality)
    storage.create_run(
        {
            "id": run_id,
            "provider": provider,
            "city": city,
            "locality": locality,
            "search_url": search_url,
            "status": "running",
            "started_at": now_iso(),
        }
    )
    set_state(
        running=True,
        run_id=run_id,
        message="Queued",
        error=None,
        listing_count=0,
    )

    thread = threading.Thread(
        target=run_scrape_job,
        args=(run_id, provider, city, locality, max_results, max_pages),
        daemon=True,
    )
    thread.start()
    return jsonify({"run_id": run_id, "status": "running"}), 202


@app.get("/api/runs")
def api_runs() -> Response:
    return jsonify({"runs": storage.list_runs()})


@app.get("/api/listings")
def api_listings() -> Response:
    run_id = request.args.get("run_id") or None
    try:
        limit = min(max(int(request.args.get("limit", 500)), 1), 5000)
    except ValueError:
        return jsonify({"error": "limit must be an integer"}), 400
    return jsonify({"listings": storage.list_listings(run_id, limit)})


@app.get("/api/listings.csv")
def listings_csv() -> Response:
    run_id = request.args.get("run_id") or None
    rows = storage.list_listings(run_id, 5000)
    output = io.StringIO()
    fields = [
        "run_id", "source_id", "title", "locality", "city", "monthly_rent",
        "bhk", "area_sqft", "property_type", "furnishing", "latitude",
        "longitude", "listing_url",
    ]
    writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=rentiq-listings.csv"},
    )


@app.get("/debug/<path:filename>")
def debug_file(filename: str):
    return send_from_directory(Path(debug_dir).resolve(), filename)


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8771"))
    print(f"RentIQ listening on http://{host}:{port}")
    serve(app, host=host, port=port, threads=8)
