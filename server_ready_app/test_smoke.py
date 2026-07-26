from __future__ import annotations

import os
import tempfile
import unittest
import zipfile
from io import BytesIO
from urllib.parse import parse_qs, urlparse


class BrowserAssistedSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        os.environ["DATABASE_PATH"] = os.path.join(cls.tempdir.name, "test.sqlite3")
        os.environ["CAPTURE_KEY"] = ""
        from app import app

        cls.client = app.test_client()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tempdir.cleanup()

    def test_health(self) -> None:
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["mode"], "browser-assisted-auto")

    def test_index(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"automatic browser capture", response.data)

    def test_search_url_requires_city(self) -> None:
        response = self.client.get("/api/search-url")
        self.assertEqual(response.status_code, 400)

    def test_search_url_contains_automatic_capture_config(self) -> None:
        response = self.client.get("/api/search-url?city=Noida&locality=Sector%2098")
        self.assertEqual(response.status_code, 200)
        url = response.get_json()["url"]
        parsed = urlparse(url)
        fragment = parse_qs(parsed.fragment)
        self.assertIn("cityName=Noida", parsed.query)
        self.assertEqual(fragment["rentiq_auto"], ["1"])
        self.assertEqual(fragment["rentiq_city"], ["Noida"])
        self.assertEqual(fragment["rentiq_locality"], ["Sector 98"])
        self.assertEqual(fragment["rentiq_server"], ["http://localhost"])

    def test_browser_capture(self) -> None:
        response = self.client.post(
            "/api/browser-capture",
            json={
                "city": "Noida",
                "locality": "Sector 98",
                "page_url": "https://www.magicbricks.com/example",
                "listings": [
                    {
                        "source_id": "test-1",
                        "title": "2 BHK Flat for Rent",
                        "monthly_rent": 25000,
                        "bhk": "2 BHK",
                        "area_sqft": 1100,
                        "listing_url": "https://www.magicbricks.com/propertyDetails/test-1",
                    }
                ],
            },
        )
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertEqual(payload["listing_count"], 1)

        listings = self.client.get(f"/api/listings?run_id={payload['run_id']}").get_json()["listings"]
        self.assertEqual(len(listings), 1)
        self.assertEqual(listings[0]["monthly_rent"], 25000)

    def test_extension_zip(self) -> None:
        response = self.client.get("/browser-extension.zip")
        self.assertEqual(response.status_code, 200)
        with zipfile.ZipFile(BytesIO(response.data)) as archive:
            names = archive.namelist()
            self.assertIn("browser_extension/manifest.json", names)
            self.assertIn("browser_extension/background.js", names)
            self.assertIn("browser_extension/content.js", names)


if __name__ == "__main__":
    unittest.main()
