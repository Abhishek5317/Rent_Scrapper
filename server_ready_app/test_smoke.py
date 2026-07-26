from __future__ import annotations

import os
import tempfile
import unittest


class ServerReadySmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        os.environ["DATABASE_PATH"] = os.path.join(cls.tempdir.name, "test.sqlite3")
        os.environ["DEBUG_DIR"] = os.path.join(cls.tempdir.name, "debug")
        from app import app

        cls.client = app.test_client()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tempdir.cleanup()

    def test_health(self) -> None:
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "ok")

    def test_index(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"MagicBricks rental scraper", response.data)

    def test_city_is_required(self) -> None:
        response = self.client.post("/api/scrape", json={})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "city is required")

    def test_empty_listings(self) -> None:
        response = self.client.get("/api/listings")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["listings"], [])


if __name__ == "__main__":
    unittest.main()
