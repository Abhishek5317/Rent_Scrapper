from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


class Storage:
    def __init__(self, database_path: str) -> None:
        self.path = Path(database_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                PRAGMA journal_mode=WAL;

                CREATE TABLE IF NOT EXISTS scrape_runs (
                    id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    city TEXT NOT NULL,
                    locality TEXT,
                    search_url TEXT NOT NULL,
                    status TEXT NOT NULL,
                    listing_count INTEGER NOT NULL DEFAULT 0,
                    error_message TEXT,
                    started_at TEXT NOT NULL,
                    finished_at TEXT
                );

                CREATE TABLE IF NOT EXISTS listings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL REFERENCES scrape_runs(id) ON DELETE CASCADE,
                    source_id TEXT,
                    title TEXT,
                    locality TEXT,
                    city TEXT,
                    monthly_rent REAL,
                    bhk TEXT,
                    area_sqft REAL,
                    property_type TEXT,
                    furnishing TEXT,
                    latitude REAL,
                    longitude REAL,
                    listing_url TEXT,
                    raw_json TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_listings_run_id ON listings(run_id);
                CREATE INDEX IF NOT EXISTS idx_listings_city ON listings(city);
                """
            )

    def create_run(self, run: dict[str, Any]) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scrape_runs (
                    id, provider, city, locality, search_url, status, started_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run["id"], run["provider"], run["city"], run.get("locality"),
                    run["search_url"], run["status"], run["started_at"],
                ),
            )

    def finish_run(
        self,
        run_id: str,
        status: str,
        listing_count: int,
        finished_at: str,
        error_message: str | None = None,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE scrape_runs
                SET status = ?, listing_count = ?, error_message = ?, finished_at = ?
                WHERE id = ?
                """,
                (status, listing_count, error_message, finished_at, run_id),
            )

    def save_listings(self, run_id: str, listings: list[dict[str, Any]]) -> None:
        rows = []
        for item in listings:
            rows.append(
                (
                    run_id,
                    item.get("source_id"),
                    item.get("title"),
                    item.get("locality"),
                    item.get("city"),
                    item.get("monthly_rent"),
                    item.get("bhk"),
                    item.get("area_sqft"),
                    item.get("property_type"),
                    item.get("furnishing"),
                    item.get("latitude"),
                    item.get("longitude"),
                    item.get("listing_url"),
                    json.dumps(item.get("raw", item), ensure_ascii=False),
                )
            )

        with self._connect() as conn:
            conn.executemany(
                """
                INSERT INTO listings (
                    run_id, source_id, title, locality, city, monthly_rent, bhk,
                    area_sqft, property_type, furnishing, latitude, longitude,
                    listing_url, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )

    def list_runs(self, limit: int = 25) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_listings(self, run_id: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if run_id:
                rows = conn.execute(
                    "SELECT * FROM listings WHERE run_id = ? ORDER BY id DESC LIMIT ?",
                    (run_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM listings ORDER BY id DESC LIMIT ?",
                    (limit,),
                ).fetchall()
        return [dict(row) for row in rows]
