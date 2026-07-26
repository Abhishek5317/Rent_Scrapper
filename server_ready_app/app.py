from __future__ import annotations

import csv
import io
import os
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request, send_file
from waitress import serve

from storage import Storage

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024

storage = Storage(os.getenv("DATABASE_PATH", "data/rentiq.sqlite3"))
current_state: dict[str, Any] = {
    "message": "Ready for browser capture",
    "error": None,
    "last_run_id": None,
    "listing_count": 0,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_search_url(city: str, locality: str | None = None) -> str:
    params = [
        ("bedroom", "1,2,3,4,5"),
        (
            "proptype",
            "Multistorey-Apartment,Builder-Floor-Apartment,Penthouse,"
            "Studio-Apartment,Service-Apartment,Residential-House,Villa",
        ),
    ]
    if locality:
        params.append(("Locality", locality))
    params.extend([("cityName", city), ("page", "1")])
    return (
        "https://www.magicbricks.com/property-for-rent/residential-real-estate?"
        + urlencode(params, safe=",")
    )


def optional_number(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def normalize_listing(
    item: dict[str, Any],
    city: str,
    locality: str | None,
    page_url: str,
    index: int,
) -> dict[str, Any]:
    listing_url = str(item.get("listing_url") or "").strip() or page_url
    source_id = str(item.get("source_id") or "").strip()
    if not source_id:
        source_id = f"browser-{index}-{uuid.uuid4().hex[:12]}"

    return {
        "source_id": source_id,
        "title": str(item.get("title") or "").strip(),
        "locality": str(item.get("locality") or locality or "").strip(),
        "city": str(item.get("city") or city).strip(),
        "monthly_rent": optional_number(item.get("monthly_rent")),
        "bhk": str(item.get("bhk") or "").strip(),
        "area_sqft": optional_number(item.get("area_sqft")),
        "property_type": str(item.get("property_type") or "").strip(),
        "furnishing": str(item.get("furnishing") or "").strip(),
        "latitude": optional_number(item.get("latitude")),
        "longitude": optional_number(item.get("longitude")),
        "listing_url": listing_url,
        "raw": item.get("raw") or item,
    }


def deduplicate_listings(listings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in listings:
        key = (
            str(item.get("source_id") or "").strip()
            or str(item.get("listing_url") or "").strip()
            or "|".join(
                [
                    str(item.get("title") or "").strip(),
                    str(item.get("monthly_rent") or ""),
                    str(item.get("locality") or "").strip(),
                ]
            )
        )
        if key and key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


@app.after_request
def add_api_cors_headers(response: Response) -> Response:
    if request.path.startswith("/api/"):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Capture-Key"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


@app.get("/")
def index() -> str:
    return render_template(
        "index.html",
        default_port=os.getenv("PORT", "8771"),
        server_url=request.host_url.rstrip("/"),
    )


@app.get("/health")
def health() -> Response:
    return jsonify({"status": "ok", "mode": "browser-assisted"})


@app.get("/api/status")
def api_status() -> Response:
    return jsonify(dict(current_state))


@app.get("/api/search-url")
def api_search_url() -> Response:
    city = str(request.args.get("city", "")).strip()
    locality = str(request.args.get("locality", "")).strip() or None
    if not city:
        return jsonify({"error": "city is required"}), 400
    return jsonify({"url": build_search_url(city, locality)})


@app.route("/api/browser-capture", methods=["POST", "OPTIONS"])
def browser_capture() -> Response:
    if request.method == "OPTIONS":
        return Response(status=204)

    expected_key = os.getenv("CAPTURE_KEY", "").strip()
    supplied_key = request.headers.get("X-Capture-Key", "").strip()
    if expected_key and supplied_key != expected_key:
        return jsonify({"error": "Invalid capture key"}), 401

    payload = request.get_json(silent=True) or {}
    city = str(payload.get("city", "")).strip()
    locality = str(payload.get("locality", "")).strip() or None
    page_url = str(payload.get("page_url", "")).strip()
    raw_listings = payload.get("listings")

    if not city:
        return jsonify({"error": "city is required"}), 400
    if not isinstance(raw_listings, list):
        return jsonify({"error": "listings must be an array"}), 400
    if not raw_listings:
        return jsonify({"error": "No visible listings were captured"}), 400
    if len(raw_listings) > 1000:
        return jsonify({"error": "A single capture cannot exceed 1000 listings"}), 400

    normalized = [
        normalize_listing(item, city, locality, page_url, index)
        for index, item in enumerate(raw_listings, start=1)
        if isinstance(item, dict)
    ]
    normalized = deduplicate_listings(normalized)
    if not normalized:
        return jsonify({"error": "No valid listings were captured"}), 400

    run_id = uuid.uuid4().hex
    search_url = page_url or build_search_url(city, locality)
    started_at = now_iso()
    storage.create_run(
        {
            "id": run_id,
            "provider": "browser-assisted",
            "city": city,
            "locality": locality,
            "search_url": search_url,
            "status": "running",
            "started_at": started_at,
        }
    )
    storage.save_listings(run_id, normalized)
    storage.finish_run(run_id, "success", len(normalized), now_iso())

    current_state.update(
        {
            "message": f"Imported {len(normalized)} listings from your browser",
            "error": None,
            "last_run_id": run_id,
            "listing_count": len(normalized),
        }
    )
    return jsonify({"run_id": run_id, "listing_count": len(normalized), "status": "success"}), 201


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
        "run_id",
        "source_id",
        "title",
        "locality",
        "city",
        "monthly_rent",
        "bhk",
        "area_sqft",
        "property_type",
        "furnishing",
        "latitude",
        "longitude",
        "listing_url",
    ]
    writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=rentiq-listings.csv"},
    )


@app.get("/browser-extension.zip")
def browser_extension_zip() -> Response:
    extension_dir = BASE_DIR / "browser_extension"
    if not extension_dir.exists():
        return jsonify({"error": "Browser extension files are missing"}), 404

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(extension_dir.rglob("*")):
            if path.is_file():
                archive.write(path, Path("browser_extension") / path.relative_to(extension_dir))
    buffer.seek(0)
    return send_file(
        buffer,
        mimetype="application/zip",
        as_attachment=True,
        download_name="rentiq-browser-extension.zip",
    )


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8771"))
    print(f"RentIQ listening on http://{host}:{port}")
    serve(app, host=host, port=port, threads=8)
