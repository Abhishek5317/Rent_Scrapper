from __future__ import annotations

import os
import re
import shutil
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

import requests


class ScrapeError(RuntimeError):
    pass


def build_search_url(city: str, locality: str | None = None, page: int = 1) -> str:
    params = [f"cityName={quote_plus(city)}", f"page={page}"]
    if locality:
        params.insert(0, f"Locality={quote_plus(locality)}")
    return (
        "https://www.magicbricks.com/property-for-rent/residential-real-estate?"
        + "&".join(params)
    )


def _number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).replace(",", "")
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    return float(match.group(0)) if match else None


def _money(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).replace(",", "").strip()
    match = re.search(r"(\d+(?:\.\d+)?)", text)
    if not match:
        return None
    amount = float(match.group(1))
    lowered = text.lower()
    if "crore" in lowered or re.search(r"\bcr\b", lowered):
        amount *= 10_000_000
    elif "lakh" in lowered or "lac" in lowered:
        amount *= 100_000
    elif re.search(r"\bk\b", lowered):
        amount *= 1_000
    return amount


def _deep_get(data: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in data and data[key] not in (None, ""):
            return data[key]
    return None


def normalize_listing(item: dict[str, Any], city: str) -> dict[str, Any]:
    return {
        "source_id": str(_deep_get(item, "propertyId", "id", "property_id") or ""),
        "title": _deep_get(item, "title", "name", "propertyTitle", "property_name"),
        "locality": _deep_get(item, "locality", "location", "address", "address_raw"),
        "city": _deep_get(item, "city", "cityName") or city,
        "monthly_rent": _money(_deep_get(item, "price", "rent", "monthlyRent", "monthly_rent")),
        "bhk": _deep_get(item, "bhk", "bedroom", "bhkType", "bhk_raw"),
        "area_sqft": _number(_deep_get(item, "area", "coveredArea", "carpetArea", "area_sqft")),
        "property_type": _deep_get(item, "propertyType", "property_type", "type"),
        "furnishing": _deep_get(item, "furnishing", "furnishingStatus"),
        "latitude": _number(_deep_get(item, "latitude", "lat")),
        "longitude": _number(_deep_get(item, "longitude", "lng", "lon")),
        "listing_url": _deep_get(item, "url", "listingUrl", "listing_url", "detailUrl"),
        "raw": item,
    }


class ApifyProvider:
    def __init__(self) -> None:
        self.token = os.getenv("APIFY_TOKEN", "").strip()
        self.actor = os.getenv(
            "APIFY_ACTOR", "codingfrontend~magicbricks-property-search-scraper"
        ).strip()
        if not self.token:
            raise ScrapeError(
                "APIFY_TOKEN is missing. Add it to .env, or set SCRAPE_PROVIDER=direct."
            )

    def scrape(
        self,
        city: str,
        locality: str | None,
        max_results: int,
        max_pages: int,
    ) -> tuple[str, list[dict[str, Any]]]:
        search_url = build_search_url(city, locality)
        endpoint = (
            f"https://api.apify.com/v2/acts/{self.actor}/"
            f"run-sync-get-dataset-items?token={self.token}"
        )
        payload = {
            "searchUrls": [search_url],
            "maxPropertiesPerSearch": max_results,
            "maxProperties": max_results,
        }
        response = requests.post(endpoint, json=payload, timeout=900)
        if not response.ok:
            raise ScrapeError(
                f"Apify returned HTTP {response.status_code}: {response.text[:500]}"
            )
        data = response.json()
        if isinstance(data, dict):
            items = data.get("items") or data.get("results") or data.get("data") or []
        else:
            items = data
        if not isinstance(items, list):
            raise ScrapeError("The scraping provider returned an unexpected response shape.")
        listings = [normalize_listing(item, city) for item in items if isinstance(item, dict)]
        return search_url, listings[:max_results]


class DirectBrowserProvider:
    BLOCK_MARKERS = (
        "captcha",
        "access denied",
        "unusual traffic",
        "verify you are human",
        "bot detection",
    )

    def __init__(self, debug_dir: str) -> None:
        self.debug_dir = Path(debug_dir)
        self.debug_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _chrome_path() -> str | None:
        configured = os.getenv("CHROME_PATH", "").strip()
        if configured and Path(configured).exists():
            return configured
        for candidate in (
            "google-chrome-stable",
            "google-chrome",
            "chromium-browser",
            "chromium",
            "chrome",
        ):
            found = shutil.which(candidate)
            if found:
                return found
        return None

    def scrape(
        self,
        city: str,
        locality: str | None,
        max_results: int,
        max_pages: int,
    ) -> tuple[str, list[dict[str, Any]]]:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise ScrapeError(
                "Direct mode needs Playwright. Run: ./setup.sh direct"
            ) from exc

        chrome_path = self._chrome_path()
        if not chrome_path:
            raise ScrapeError(
                "No system Chrome/Chromium executable was found. Set CHROME_PATH in .env, "
                "or use SCRAPE_PROVIDER=apify for a browser-free server deployment."
            )
        headless = os.getenv("HEADLESS", "true").lower() != "false"
        profile_dir = Path("data/browser-profile").resolve()
        profile_dir.mkdir(parents=True, exist_ok=True)
        all_items: list[dict[str, Any]] = []
        first_url = build_search_url(city, locality, 1)

        with sync_playwright() as playwright:
            launch_kwargs: dict[str, Any] = {
                "user_data_dir": str(profile_dir),
                "headless": headless,
                "viewport": {"width": 1366, "height": 900},
                "locale": "en-IN",
                "args": ["--no-sandbox", "--disable-dev-shm-usage"],
                "executable_path": chrome_path,
            }

            context = playwright.chromium.launch_persistent_context(**launch_kwargs)
            page = context.pages[0] if context.pages else context.new_page()
            try:
                page.goto(
                    "https://www.magicbricks.com/",
                    wait_until="domcontentloaded",
                    timeout=60000,
                )
                page.wait_for_timeout(2500)

                for page_number in range(1, max_pages + 1):
                    url = build_search_url(city, locality, page_number)
                    response = page.goto(url, wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_timeout(4000)
                    for position in (700, 1500, 2400, 3400):
                        page.evaluate(f"window.scrollTo(0, {position})")
                        page.wait_for_timeout(700)

                    body_text = page.locator("body").inner_text(timeout=15000)
                    lowered = body_text.lower()
                    if any(marker in lowered for marker in self.BLOCK_MARKERS):
                        stamp = int(time.time())
                        page.screenshot(
                            path=str(self.debug_dir / f"blocked-{stamp}.png"),
                            full_page=True,
                        )
                        (self.debug_dir / f"blocked-{stamp}.html").write_text(
                            page.content(), encoding="utf-8"
                        )
                        status = response.status if response else "unknown"
                        raise ScrapeError(
                            "MagicBricks returned a bot-check page to this server "
                            f"(HTTP {status}). Use SCRAPE_PROVIDER=apify for reliable "
                            "datacenter execution. Debug files were saved in debug/."
                        )

                    raw_items = page.locator(
                        'div.mb-srp__list[id^="cardid"], div.mb-srp__card'
                    ).evaluate_all(
                        r"""
                        cards => cards.map(card => {
                          const root = card.matches('.mb-srp__card') ? card : (card.querySelector('.mb-srp__card') || card);
                          const text = sel => root.querySelector(sel)?.textContent?.trim() || null;
                          const titleNode = root.querySelector('h2.mb-srp__card--title');
                          const title = titleNode?.getAttribute('title') || titleNode?.textContent?.trim() || null;
                          const hrefNode = [...root.querySelectorAll('a[href]')].find(a => a.href.includes('-pdpid-') || a.href.includes('/propertyDetails/')) || root.querySelector('a[href]');
                          const fullText = root.textContent || '';
                          const priceMatch = fullText.match(/₹\s*[\d,.]+\s*(?:Lac|Cr|K)?/i);
                          const bhkMatch = fullText.match(/\b\d+(?:\.\d+)?\s*BHK\b/i);
                          const areaMatch = fullText.match(/([\d,.]+)\s*(?:sq\.?\s*ft|sqft)/i);
                          return {
                            title,
                            locality: text('.mb-srp__card__society') || title,
                            price: priceMatch ? priceMatch[0] : null,
                            bhk: bhkMatch ? bhkMatch[0] : null,
                            area: areaMatch ? areaMatch[1] : null,
                            url: hrefNode?.href || null,
                            raw_text: fullText.trim()
                          };
                        })
                        """
                    )
                    if not raw_items:
                        if page_number == 1:
                            stamp = int(time.time())
                            page.screenshot(
                                path=str(self.debug_dir / f"empty-{stamp}.png"),
                                full_page=True,
                            )
                            (self.debug_dir / f"empty-{stamp}.html").write_text(
                                page.content(), encoding="utf-8"
                            )
                            raise ScrapeError(
                                "No listing cards were found. MagicBricks may have changed "
                                "its markup or returned an interstitial. Debug files were saved."
                            )
                        break

                    all_items.extend(normalize_listing(item, city) for item in raw_items)
                    if len(all_items) >= max_results:
                        break
                    page.wait_for_timeout(2000)
            finally:
                context.close()

        return first_url, all_items[:max_results]


def scrape(
    provider_name: str,
    city: str,
    locality: str | None,
    max_results: int,
    max_pages: int,
    debug_dir: str,
) -> tuple[str, str, list[dict[str, Any]]]:
    selected = provider_name.lower().strip()
    if selected == "auto":
        selected = "apify" if os.getenv("APIFY_TOKEN", "").strip() else "direct"

    if selected == "apify":
        provider = ApifyProvider()
    elif selected == "direct":
        provider = DirectBrowserProvider(debug_dir)
    else:
        raise ScrapeError(f"Unsupported provider: {provider_name}")

    search_url, listings = provider.scrape(city, locality, max_results, max_pages)
    return selected, search_url, listings
