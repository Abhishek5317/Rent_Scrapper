"""
magicbricks_scraper.py

Architecture mirrors the PriceScout Swiggy scraper:

  1. Launch a REAL Playwright-controlled Chromium browser and load the
     MagicBricks search results page like a human would. This is what
     defeats bot detection — you're not spoofing anything, the page
     genuinely executes MagicBricks' JS challenge / fingerprinting and
     comes back clean because it IS a real browser.

  2. Once the page has loaded and rendered listing cards, pull the
     cookies out of the browser context via CDP (context.cookies()).
     These cookies are what unlock cheap, fast subsequent requests.

  3. Switch to a plain HTTP session (httpx) carrying those cookies for
     pagination — far faster than driving Playwright through 100+ pages,
     and MagicBricks' pagination endpoints generally just need a valid
     session, not a live browser, once you're past the initial gate.

  4. If a page ever comes back suspicious (redirected to a captcha,
     unexpected HTML shape, 403, etc.), fall back to re-establishing
     the session through Playwright again. Bot walls rotate; the retry
     path assumes they will.

  5. Parse listings from whichever data source is richer on a given
     page: MagicBricks frequently embeds a JSON blob (window.__NEXT_DATA__
     equivalent — check for `<script type="application/json">` or an
     inline `var mbData = {...}` pattern) alongside the rendered DOM.
     JSON is strongly preferred: DOM class names churn constantly,
     embedded JSON is comparatively stable and gives clean lat/lng.

IMPORTANT — you will need to run this against the live site and adjust:
  - SEARCH_URL_TEMPLATE (confirm current MagicBricks URL query params)
  - JSON_BLOB_PATTERNS / DOM_FALLBACK_SELECTORS (confirm against current markup)
  - Pagination mechanics (infinite scroll vs ?page=N vs POST-based "load more")

Everything else (cookie capture, retry/backoff, distance filtering,
output schema) should not need to change.
"""

import asyncio
import json
import logging
import random
import re
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin

import httpx
from playwright.async_api import async_playwright, Page, BrowserContext
from bs4 import BeautifulSoup

# Logging set up FIRST, before config resolution below — the automatic
# reverse-geocoding step needs log.info() available at module load time.
LOG_PATH = Path("scraper.log")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_PATH), logging.StreamHandler()],
)
log = logging.getLogger("magicbricks_scraper")

# ─────────────────────────────────────────────────────────────────
# CONFIG — loaded from config.json (project root), NOT hardcoded here.
#
# This is the file to edit to point the scraper at a different city,
# state, or store location — nothing in THIS script needs to change.
# See config.json's own comments for what each field controls.
#
# MINIMUM required in config.json: just center_lat + center_lng.
# Everything else (city name, MagicBricks search params) is resolved
# automatically below via reverse geocoding — this matters because the
# real use case is "someone hands you a random lat/lng, possibly in a
# city you've never touched before, and it should just work" rather
# than requiring a manual MagicBricks search every time.
# ─────────────────────────────────────────────────────────────────

BASE_URL = "https://www.magicbricks.com"
NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse"
GEOCODE_USER_AGENT = "RentIQ/1.0 (internship project)"


def _load_config() -> dict:
    config_path = Path(__file__).resolve().parent.parent / "config.json"
    if not config_path.exists():
        raise FileNotFoundError(
            f"config.json not found at {config_path}. At minimum it needs "
            f"center_lat and center_lng — everything else can be auto-resolved."
        )
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_config(config_path: Path, config: dict) -> None:
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


def _reverse_geocode_city(lat: float, lng: float) -> dict:
    """
    Given just coordinates, asks Nominatim "what's here?" and pulls out
    the city and state. This is what makes "someone hands you a random
    lat/lng, could be any city or state" actually work without manual
    lookup — same Nominatim service used elsewhere in this project
    (geocoder.js), same ~1 req/sec courtesy rate limit.
    """
    import urllib.request
    import urllib.parse

    params = urllib.parse.urlencode({"lat": lat, "lon": lng, "format": "json"})
    url = f"{NOMINATIM_REVERSE_URL}?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": GEOCODE_USER_AGENT})

    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    address = data.get("address", {})
    # Nominatim's address breakdown varies by country/region — try the
    # most likely keys for "city" in order, since not every reverse-geocode
    # result uses the same field name.
    city = (
        address.get("city") or address.get("town") or address.get("municipality")
        or address.get("county") or address.get("state_district")
    )
    state = address.get("state")
    suburb = address.get("suburb") or address.get("neighbourhood") or address.get("quarter")

    if not city:
        raise ValueError(f"Reverse geocode succeeded but couldn't find a city name in the response: {address}")

    return {"city": city, "state": state, "suburb": suburb}


# Nominatim sometimes returns the name of the administrative BODY
# governing an area (e.g. "Chennai Corporation") rather than the plain
# place name people/platforms actually use ("Chennai"). Discovered live:
# Ramapuram's coordinates resolved to "Chennai Corporation", which
# MagicBricks didn't recognize as a city at all. This is a GENERAL fix
# (not a one-off Chennai alias) since the same pattern — X Corporation,
# X Municipal Corporation, X Nagar Nigam, etc. — could surface for any
# Indian city depending on exactly how Nominatim's address hierarchy
# resolves that specific point, not just this one.
_ADMIN_SUFFIX_PATTERN = re.compile(
    r"\s+(Municipal Corporation|Corporation|Municipality|Nagar Nigam|"
    r"Nagar Palika|Cantonment Board|Cantonment|Urban Agglomeration|"
    r"Development Authority)$",
    re.IGNORECASE,
)


def _strip_admin_suffix(name: str) -> str:
    stripped = _ADMIN_SUFFIX_PATTERN.sub("", name).strip()
    return stripped if stripped else name


# Cases where India's official/administrative city name (what reverse
# geocoding correctly returns) differs from what MagicBricks recognizes
# as its own `cityName` search parameter — discovered live: Bengaluru
# (the official post-2014 name) returned a "no results, remove filters"
# page with only 1-3 BHK options showing, strongly suggesting MagicBricks
# still expects the older colloquial "Bangalore" internally. Likely the
# same story for other renamed/local-administrative-name cities.
#
# city_name (this project's own DB/display name) stays the CORRECT
# official name regardless — only magicbricks_city_name (the literal
# search URL parameter) gets the alias applied, since that's the only
# place it actually matters for the scrape to work.
MAGICBRICKS_CITY_ALIASES = {
    "Bengaluru": "Bangalore",
    "Bidhannagar": "Kolkata",       # Salt Lake's official municipal name
    "Gurugram": "Gurgaon",
    "Puducherry": "Pondicherry",
    "Mumbai Suburban": "Mumbai",
    "Prayagraj": "Allahabad",
}


def _resolve_config(config: dict, config_path: Path) -> dict:
    """
    Fills in anything missing from just center_lat/center_lng, and
    PERSISTS the result back to config.json — so the (rate-limited)
    reverse-geocode lookup only ever happens once per new location,
    not on every run, and so other scripts (seedCity.js) can read the
    same resolved values without duplicating this logic in Node too.
    """
    changed = False

    if not config.get("magicbricks_city_name") or not config.get("city_name"):
        log.info(f"No city name in config — reverse-geocoding ({config['center_lat']}, {config['center_lng']})...")
        resolved = _reverse_geocode_city(config["center_lat"], config["center_lng"])

        # Strip admin-body suffixes FIRST, before anything else uses this
        # name — affects both the display name and the MagicBricks alias
        # lookup below, since "Chennai Corporation" isn't a good choice
        # for either purpose.
        clean_city = _strip_admin_suffix(resolved["city"])
        if clean_city != resolved["city"]:
            log.info(f"Stripped administrative suffix: '{resolved['city']}' -> '{clean_city}'")

        config.setdefault("city_name", clean_city)
        config.setdefault("state", resolved["state"])

        mb_name = MAGICBRICKS_CITY_ALIASES.get(clean_city, clean_city)
        config["magicbricks_city_name"] = config.get("magicbricks_city_name") or mb_name
        if mb_name != clean_city:
            log.info(f"Resolved city: {clean_city}, state: {resolved['state']} — using MagicBricks alias '{mb_name}' for the search URL")
        else:
            log.info(f"Resolved city: {clean_city}, state: {resolved['state']}")
        changed = True
    else:
        # Self-healing: config.json already has values saved, but they
        # might be ones we now know need correcting — either a known
        # alias case, or an admin-suffix case (e.g. "Chennai Corporation"
        # saved during a run before this fix existed). Fix without
        # requiring the user to manually clear config.json.
        old_mb_name = config["magicbricks_city_name"]
        stripped = _strip_admin_suffix(old_mb_name)
        new_mb_name = MAGICBRICKS_CITY_ALIASES.get(stripped, stripped)
        if new_mb_name != old_mb_name:
            config["magicbricks_city_name"] = new_mb_name
            log.info(f"Correcting saved MagicBricks city name '{old_mb_name}' -> '{new_mb_name}'")
            changed = True

        old_city_name = config.get("city_name", "")
        stripped_city_name = _strip_admin_suffix(old_city_name)
        if stripped_city_name != old_city_name:
            config["city_name"] = stripped_city_name
            log.info(f"Correcting saved display city name '{old_city_name}' -> '{stripped_city_name}'")
            changed = True

    if not config.get("location_label"):
        config["location_label"] = config["city_name"]
        changed = True

    if changed:
        _save_config(config_path, config)
        log.info(f"Saved resolved values back to {config_path}")

    return config


_config_path = Path(__file__).resolve().parent.parent / "config.json"
_config = _load_config()
_config = _resolve_config(_config, _config_path)

CITY_NAME = _config["city_name"]
CENTER_LAT = _config["center_lat"]
CENTER_LNG = _config["center_lng"]
MB_CITY_NAME = _config["magicbricks_city_name"]
MB_LOCALITY = _config.get("magicbricks_locality")  # OPTIONAL — see below

# CONFIRMED from live DevTools inspection (2026-07-06): MagicBricks SRP
# pages are server-rendered (html has data-hydrated="true" — the full
# card list is present in the initial HTML, not injected later by JS).
# This means once past the bot-check, a plain HTTP GET with the right
# cookies returns fully-populated listing HTML — no need to wait for
# client-side JS execution on every page, which is a big speed win.
#
# NO bedroom/proptype FILTERS IN THE URL — deliberate, discovered live.
# Testing against a real failing case (Chennai/Ramapuram) found that
# `bedroom=1,2,3,4,5` alone works, `proptype=...` alone works, but
# COMBINING them returns zero results for that city specifically — even
# though each filter works fine on its own. Rather than chase a
# per-city-specific combination that happens to work (an unpredictable,
# ongoing maintenance burden), the request is simplified to just the
# city/locality — the `residential-real-estate` path already scopes to
# residential listings, and this project's own bhkNormalizer.py-equivalent
# logic already dynamically detects whatever BHK configuration shows up
# in the data without assuming a fixed set. Asking MagicBricks to
# pre-filter by bedroom count was working against that "never hardcode
# BHK" design goal anyway — better to fetch broadly and let our own
# code do the filtering, which we already do reliably regardless of city.
#
# LOCALITY SCOPING IS OPTIONAL. If magicbricks_locality is known (found
# via a manual MagicBricks search, same process used for "Sector-98"),
# scoping to it means fewer pages/listings to scrape and enrich — faster.
# If it's NOT known (the common case for "here's a random lat/lng"),
# the scraper falls back to a CITY-WIDE search instead. This still
# produces CORRECT results, just slower for large cities: every listing
# gets a real per-building coordinate from its own detail page anyway
# (see enrich_listings_with_detail_data below), and ingest.js already
# filters by genuine distance from center_lat/center_lng downstream —
# so a wider net at scrape time doesn't produce wrong data, only more
# of it to sift through.
if MB_LOCALITY:
    SEARCH_URL_TEMPLATE = (
        "https://www.magicbricks.com/property-for-rent/residential-real-estate"
        f"?Locality={MB_LOCALITY}&cityName={MB_CITY_NAME}" + "&page={page}"
    )
else:
    SEARCH_URL_TEMPLATE = (
        "https://www.magicbricks.com/property-for-rent/residential-real-estate"
        f"?cityName={MB_CITY_NAME}" + "&page={page}"
    )

MAX_PAGES = _config.get("max_pages", 50)  # hard ceiling so a scraper bug can't run forever;
                                            # configurable via config.json's "max_pages" field —
                                            # useful for batch runs across many stores where you
                                            # want each one capped lower to keep total time sane
REQUEST_DELAY_RANGE = (2.5, 5.5)   # seconds, randomized between requests — looks human, avoids rate limits
BROWSER_REFRESH_EVERY = 15     # re-validate session via Playwright every N HTTP pages
OUTPUT_PATH = Path("scraped_listings.jsonl")

# A small pool of REAL, current, common browser identities (Chrome/Edge on
# Windows — the most common real-world combination), picked randomly per
# session rather than one fixed string that never changes. This isn't about
# hiding what's making the request (Playwright already runs an actual
# browser engine, so the underlying behavior is genuinely browser-like) —
# it's just avoiding an unnecessarily static fingerprint across many runs.
USER_AGENT_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
]
USER_AGENT = random.choice(USER_AGENT_POOL)


# ─────────────────────────────────────────────────────────────────
# DATA MODEL — matches the `properties` table columns 1:1 so the
# ingestion script can do a near-direct mapping.
# ─────────────────────────────────────────────────────────────────

@dataclass
class ScrapedListing:
    listing_url: str
    property_name: Optional[str] = None
    society_name: Optional[str] = None
    address_raw: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    monthly_rent: Optional[float] = None
    bhk_raw: Optional[str] = None
    area_sqft: Optional[float] = None
    furnishing: Optional[str] = None
    property_type: Optional[str] = None
    raw_metadata: dict = field(default_factory=dict)
    scraped_at: float = field(default_factory=time.time)


# ─────────────────────────────────────────────────────────────────
# STAGE 1 — Playwright: load the page like a real user, capture cookies
# ─────────────────────────────────────────────────────────────────

async def bootstrap_session() -> tuple[dict, str]:
    """
    Opens the search page in a real browser, waits for listing cards
    to render (proof the bot-check passed), then extracts cookies +
    the fully rendered HTML of page 1 (so we don't waste that first
    page — no need to re-fetch it over HTTP).

    Returns (cookies_dict, first_page_html)
    """
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])
        context: BrowserContext = await browser.new_context(
            user_agent=USER_AGENT,
            viewport={"width": 1366, "height": 900},
            locale="en-IN",
        )
        page: Page = await context.new_page()

        url = SEARCH_URL_TEMPLATE.format(page=1)
        log.info(f"Bootstrapping session via Playwright: {url}")
        # domcontentloaded, not networkidle: sites like MagicBricks run
        # continuous background activity (ads, analytics, chat widgets)
        # that can prevent the network from ever truly going idle, causing
        # networkidle to hang until timeout even after the page has fully
        # rendered. The explicit wait_for_selector() right below is the
        # real "is the page actually ready" signal — domcontentloaded just
        # needs to get us close enough to start checking for it.
        await page.goto(url, wait_until="domcontentloaded", timeout=45000)

        # CONFIRMED selector (see parse_listings_from_dom docstring) —
        # its presence proves the bot-check passed and cards rendered.
        try:
            await page.wait_for_selector("div.mb-srp__card", timeout=20000)
        except Exception:
            log.warning(
                "Listing card selector didn't show up — page may have been "
                "served a captcha/interstitial. Inspect a screenshot before "
                "assuming the scraper is broken vs. the selector being stale."
            )
            await page.screenshot(path="bootstrap_debug.png")

        html = await page.content()
        cookies = await context.cookies()
        cookie_dict = {c["name"]: c["value"] for c in cookies}

        await browser.close()
        return cookie_dict, html


# ─────────────────────────────────────────────────────────────────
# STAGE 2 — Parsing: prefer embedded JSON, fall back to DOM regex/selectors
# ─────────────────────────────────────────────────────────────────

# Common patterns MagicBricks (and similar Indian listing sites) have used
# historically for embedding SRP (search-results-page) data as JSON.
# Try each in order; log which one hit so future maintenance is easy.
JSON_BLOB_PATTERNS = [
    re.compile(r"window\.mbData\s*=\s*({.*?});", re.DOTALL),
    re.compile(r"window\.__PRELOADED_STATE__\s*=\s*({.*?});", re.DOTALL),
    re.compile(r"<script type=\"application/json\"[^>]*>(.*?)</script>", re.DOTALL),
]


def extract_json_blob(html: str) -> Optional[dict]:
    for pattern in JSON_BLOB_PATTERNS:
        match = pattern.search(html)
        if match:
            try:
                return json.loads(match.group(1))
            except json.JSONDecodeError:
                continue
    return None


def parse_listing_from_json(item: dict) -> Optional[ScrapedListing]:
    """
    Maps one listing record from the embedded JSON blob into our schema.
    Field names below are best-guess based on typical MagicBricks payload
    shapes — confirm exact keys via a live capture (see NOTE at bottom)
    and adjust the .get() paths accordingly. Written defensively (all
    .get() with fallbacks) so a missing/renamed field degrades a single
    listing instead of crashing the whole batch.
    """
    try:
        return ScrapedListing(
            listing_url=item.get("url") or item.get("detailUrl") or "",
            property_name=item.get("title") or item.get("propertyTitle"),
            society_name=item.get("societyName") or item.get("projectName"),
            address_raw=item.get("address") or item.get("locality"),
            lat=_safe_float(item.get("latitude") or item.get("lat")),
            lng=_safe_float(item.get("longitude") or item.get("lng")),
            monthly_rent=_parse_rent(item.get("price") or item.get("rent")),
            bhk_raw=item.get("bedroom") or item.get("bhk"),
            area_sqft=_safe_float(item.get("area") or item.get("carpetArea")),
            furnishing=item.get("furnishing"),
            property_type=item.get("propertyType"),
            raw_metadata=item,
        )
    except Exception as e:
        log.warning(f"Failed to parse a JSON listing item: {e}")
        return None


def _diagnose_empty_page(html: str) -> str:
    """
    Zero listing containers found could mean two very different things,
    discovered by actually inspecting a real screenshot rather than
    assuming: (1) a genuine bot-check/CAPTCHA interstitial, or (2) a
    perfectly legitimate "no results with these filters" page — e.g.
    requesting bedroom=1,2,3,4,5 for a city where MagicBricks only
    offers 1-3 BHK as valid options for that search. These call for
    different responses (the first needs backing off; the second needs
    adjusting the search parameters, not retrying blindly), so it's
    worth telling them apart rather than logging the same generic
    "possible bot-check" warning for both.
    """
    lower_html = html.lower()

    bot_check_markers = ["captcha", "recaptcha", "verify you are human", "unusual traffic",
                          "access denied", "attention required", "cloudflare"]
    no_results_markers = ["try removing any filter", "reset filters", "edit search preferences",
                           "no results found", "broaden your search"]

    if any(marker in lower_html for marker in bot_check_markers):
        return ("BOT-CHECK: page contains a known CAPTCHA/block indicator. "
                "This genuinely needs a longer cool-down before retrying, ideally not "
                "back-to-back with other requests.")
    if any(marker in lower_html for marker in no_results_markers):
        return ("NO-RESULTS PAGE (not a block): MagicBricks returned a legitimate "
                "'no listings match these filters' page — e.g. this city may not "
                "support the full bedroom range or property-type list requested. "
                "Check bootstrap_debug.png to see exactly which filter got rejected; "
                "retrying the same request won't help, the search parameters need adjusting.")
    return ("UNKNOWN: neither a recognized bot-check marker nor a recognized "
            "no-results marker was found in the page — could be a genuine markup "
            "change on MagicBricks' side. Check bootstrap_debug.png directly.")


def parse_listings_from_dom(html: str) -> list[ScrapedListing]:
    """
    CONFIRMED selectors (via live DevTools inspection on the actual
    /property-for-rent/ SRP, 2026-07-06):

      div.mb-srp__list[id^="cardid"]        — outer wrapper, ONE per listing,
                                                id="cardid83303695" etc. The
                                                numeric suffix is a stable
                                                per-listing ID, matched by
                                                div[id^="propertiesAction"]
                                                on the same card — used here
                                                as a fallback key if the
                                                detail URL is ever missing.
        div.mb-srp__card                     — inner card
          h2.mb-srp__card--title              — `title` attr + inner text,
                                                 e.g. "3 BHK Flat for Rent in
                                                 Sector 121, Noida". BHK is
                                                 the leading token, parsed
                                                 out rather than assumed.
          div.mb-srp__card__society           — CONFIRMED (not __developer
                                                 as originally guessed):
                                                 project/society name,
                                                 rendered as a link e.g.
                                                 "ABA Cleo County"
          [data-summary="X"]                  — furnishing, bathroom,
                                                 balcony, super-area, etc.
                                                 rendered directly on the
                                                 card (no expand-click
                                                 needed). Parsed generically
                                                 by whatever keys exist.
          script[type="application/ld+json"]  — schema.org structured data,
                                                 sibling of card__info and
                                                 card_estimate. Tried FIRST
                                                 for price/geo/address since
                                                 structured data > scraping
                                                 rendered text when present.
    """
    soup = BeautifulSoup(html, "html.parser")

    # Prefer the outer per-listing wrapper (gives us the fallback ID too);
    # fall back to the inner card directly if that wrapper is ever absent.
    list_items = soup.select('div.mb-srp__list[id^="cardid"]')
    if not list_items:
        list_items = soup.select("div.mb-srp__card")

    if not list_items:
        diagnosis = _diagnose_empty_page(html)
        log.error(f"Zero listing containers found. Diagnosis: {diagnosis}")
        return []

    listings = []
    for item in list_items:
        try:
            listing = _parse_one_card(item)
            if _looks_commercial(listing):
                log.info(f"Skipping likely-commercial listing: {listing.property_name}")
                continue
            listings.append(listing)
        except Exception as e:
            log.warning(f"Failed to parse a card, skipping it: {e}")
            continue

    return listings


_COMMERCIAL_KEYWORDS = re.compile(
    r"\b(office space|commercial|co-working|coworking|shop|showroom|warehouse|"
    r"godown|industrial|retail space|business center|business centre)\b",
    re.IGNORECASE,
)


def _looks_commercial(listing: "ScrapedListing") -> bool:
    """
    Defensive client-side filter: since the proptype URL filter was
    removed (see SEARCH_URL_TEMPLATE's comment — combining it with other
    filters broke results for some cities), this catches the case where
    MagicBricks' `residential-real-estate` path doesn't fully exclude
    commercial listings on its own. Checked against the title/name text,
    which is the only field reliably present for every listing.
    """
    text = (listing.property_name or "") + " " + (listing.address_raw or "")
    return bool(_COMMERCIAL_KEYWORDS.search(text))


def _find_detail_url(card) -> str:
    """
    Prefers an anchor whose href matches a CONFIRMED per-listing detail-page
    pattern (-pdpid- or /propertyDetails/ — both seen in real scraped URLs)
    over just grabbing the first <a href> in the card. Discovered necessary
    live: multiple distinct units within the same project/building (e.g.
    several different BHK configs in "Lotus Boulevard Sector 100 Block A")
    each have their OWN unique detail link, but also share a "view project"
    or similar link earlier in the card's DOM — grabbing the first anchor
    blindly was catching that shared link instead, silently merging what
    should have been many distinct listings into one.
    """
    for a in card.select("a[href]"):
        href = a.get("href", "")
        if "-pdpid-" in href or "/propertyDetails/" in href:
            return href
    # Fallback: no confirmed-pattern link found — first anchor is better
    # than nothing, but flag it as unconfirmed in raw_metadata upstream.
    first = card.select_one("a[href]")
    return first["href"] if first else ""


def _parse_one_card(list_item) -> ScrapedListing:
    # list_item may be the outer div.mb-srp__list OR the inner div.mb-srp__card
    # depending on which selector matched — .select_one below works either way
    # since it searches descendants-or-self is not needed; mb-srp__card is a
    # child when list_item is the outer wrapper, and IS list_item itself when
    # the fallback selector matched directly.
    card = list_item.select_one("div.mb-srp__card") or list_item

    fallback_id = None
    if list_item.get("id", "").startswith("cardid"):
        fallback_id = list_item["id"].replace("cardid", "")

    title_el = card.select_one("h2.mb-srp__card--title")
    title_text = (title_el.get("title") if title_el else None) or (
        title_el.get_text(strip=True) if title_el else None
    )

    raw_href = _find_detail_url(card)
    base_url = urljoin(BASE_URL, raw_href) if raw_href else ""
    used_confirmed_pattern = bool(raw_href) and ("-pdpid-" in raw_href or "/propertyDetails/" in raw_href)
    if raw_href and not used_confirmed_pattern:
        log.warning(f"URL for a listing didn't match the confirmed -pdpid-/propertyDetails pattern: {raw_href}")

    # CONFIRMED LIVE (2026-07-07): large projects show several distinct
    # bedroom/price configurations as separate-looking SRP cards that all
    # share the SAME underlying detail link — only the project has its
    # own crawlable URL, not each configuration. Appending the per-card
    # cardid (confirmed unique per card, even when the href repeats) as
    # a URL fragment keeps every genuinely distinct listing distinct in
    # our database, without breaking the link itself (fragments are
    # inert to the server, so it's still the correct, clickable URL).
    listing_url = f"{base_url}#cardid-{fallback_id}" if base_url and fallback_id else base_url
    if not listing_url and fallback_id:
        # Never leave listing_url empty if we have SOME stable identifier —
        # ingest.js's UNIQUE constraint relies on this being non-empty and
        # consistent across re-scrapes.
        listing_url = f"{BASE_URL}/unresolved-url/cardid-{fallback_id}"

    # CONFIRMED selector — was previously a guess (.mb-srp__card__developer)
    society_el = card.select_one(".mb-srp__card__society")
    society_name = society_el.get_text(strip=True) if society_el else None

    # Generic data-summary extraction — never assumes a fixed key set.
    summary = {}
    for el in card.select("[data-summary]"):
        key = el.get("data-summary")
        value_el = el.select_one(".mb-srp__card_summary--value")
        if key and value_el:
            summary[key] = value_el.get_text(strip=True)

    # Structured data FIRST — more reliable than scraping rendered text
    # when the schema.org fields we need are actually present.
    ldjson = _extract_ldjson_from_card(card)
    ld_lat = _deep_find(ldjson, "latitude") if ldjson else None
    ld_lng = _deep_find(ldjson, "longitude") if ldjson else None
    ld_price = _find_rent_price(ldjson) if ldjson else None
    ld_address = _deep_find(ldjson, "streetAddress") if ldjson else None

    # DOM price fallback only if JSON-LD didn't have it — a raw ₹-prefixed
    # text scan is crude but better than silently returning no rent.
    price_source = ld_price
    if price_source is None:
        price_el = card.select_one(
            "[class*='price'], [class*='Price'], [class*='cost'], [class*='rent']"
        )
        price_source = price_el.get_text(strip=True) if price_el else None
        if price_source is None:
            rupee_match = re.search(r"₹\s?[\d,.]+\s?(?:Lac|Cr|K)?", card.get_text())
            price_source = rupee_match.group(0) if rupee_match else None

    bhk_raw = summary.get("bedroom") or summary.get("bhk") or _extract_bhk_from_title(title_text)

    parsed_rent = _parse_rent(price_source)
    # Sanity check: a monthly RENT figure this large or small is almost
    # certainly a mis-extraction (e.g. a sale price, a total project
    # value, or a builder's registration number that happened to match
    # a "price" key elsewhere on the page) rather than a real rent.
    # Found via a real ₹3.9-crore "rent" that turned out to be exactly
    # this kind of mix-up. Flagged instead of silently trusted.
    if parsed_rent is not None and not (1000 <= parsed_rent <= 1_000_000):
        log.warning(
            f"Rejecting implausible monthly_rent={parsed_rent} for cardid={fallback_id} "
            f"(source text: {price_source!r}) — outside the 1,000-1,000,000 sanity range."
        )
        parsed_rent = None

    return ScrapedListing(
        listing_url=listing_url,
        property_name=title_text,
        society_name=society_name,
        address_raw=ld_address or title_text,
        lat=_safe_float(ld_lat),
        lng=_safe_float(ld_lng),
        monthly_rent=parsed_rent,
        bhk_raw=bhk_raw,
        area_sqft=_safe_float(summary.get("super-area") or summary.get("carpet-area")),
        furnishing=summary.get("furnishing"),
        property_type=None,  # derivable from the proptype query param per search run
        raw_metadata={
            **summary,
            "cardid": fallback_id,
            "ldjson_found": ldjson is not None,
            "price_source_text": price_source,  # kept for future debugging —
            "ld_price_raw": ld_price,            # previously this info was lost entirely
        },
    )


def _find_rent_price(ldjson: dict) -> Optional[float]:
    """
    Targeted extraction matching the CONFIRMED live schema shape:
      {"@type": "RentAction", ..., "priceSpecification": {"price": N, ...}}

    Deliberately more specific than a blind recursive "find any key
    named price anywhere" search — that approach caused a real bug
    (a ₹3.9-crore "rent" that was actually some other price-like value
    elsewhere in a more complex JSON-LD document). Anchoring to the
    known priceSpecification object first avoids that class of mix-up;
    falls back to the generic deep search only if the exact shape isn't
    found, since some listings may use a slightly different structure.
    """
    price_spec = _deep_find(ldjson, "priceSpecification")
    if isinstance(price_spec, dict) and "price" in price_spec:
        return price_spec["price"]
    return _deep_find(ldjson, "price")


def _extract_ldjson_from_card(card) -> Optional[dict]:
    """
    Looks for a JSON-LD script tag within the card, OR as a sibling of it
    (confirmed layout has the script as a sibling of card__info/card_estimate
    under the same card__container, not necessarily nested inside `card`
    itself — check the parent container too if not found directly inside).
    """
    script_el = card.select_one('script[type="application/ld+json"]')
    if script_el is None and card.parent is not None:
        script_el = card.parent.select_one('script[type="application/ld+json"]')
    if script_el is None:
        return None
    try:
        return json.loads(script_el.string or script_el.get_text())
    except (json.JSONDecodeError, TypeError):
        return None


def _deep_find(obj, target_key: str):
    """
    Recursively searches a nested dict/list (typical schema.org JSON-LD
    shape) for the first occurrence of target_key, at any depth. Written
    this way because the exact nesting of price/geo under JSON-LD hasn't
    been confirmed yet (could be top-level, under `offers`, under `geo`,
    etc.) — once confirmed, this can be replaced with a direct path for
    speed, but deep-search is the safe default until then.
    """
    if isinstance(obj, dict):
        if target_key in obj:
            return obj[target_key]
        for v in obj.values():
            result = _deep_find(v, target_key)
            if result is not None:
                return result
    elif isinstance(obj, list):
        for item in obj:
            result = _deep_find(item, target_key)
            if result is not None:
                return result
    return None


def _extract_bhk_from_title(title: Optional[str]) -> Optional[str]:
    """Title text leads with the config, e.g. '3 BHK Flat for Sale in...' —
    extract it rather than assume any particular value is present."""
    if not title:
        return None
    match = re.match(r"\s*(\d+(?:\.\d+)?)\s*BHK", title, re.IGNORECASE)
    if match:
        return f"{match.group(1)} BHK"
    rk_match = re.match(r"\s*(\d+(?:\.\d+)?)\s*RK", title, re.IGNORECASE)
    if rk_match:
        return f"{rk_match.group(1)} RK"
    return None


def _safe_float(val) -> Optional[float]:
    """
    Extracts the first numeric token from a string, tolerant of units
    and stray punctuation (e.g. '1200 sq.ft.', '850 sqft', '2.5').
    Deliberately matches the FIRST number rather than stripping all
    non-digits, since stripping alone leaves stray periods from things
    like 'sq.ft.' that break float() (e.g. '1200..' is invalid).
    """
    if val is None:
        return None
    cleaned = str(val).replace(",", "")
    match = re.search(r"\d+(?:\.\d+)?", cleaned)
    if not match:
        return None
    try:
        return float(match.group(0))
    except (ValueError, TypeError):
        return None


def _parse_rent(val) -> Optional[float]:
    """Handles '₹18,000', '18000', '1.2 Lac' style strings."""
    if val is None:
        return None
    s = str(val).lower().replace(",", "").replace("₹", "").strip()
    lac_match = re.search(r"([\d.]+)\s*lac", s)
    if lac_match:
        return float(lac_match.group(1)) * 100000
    num_match = re.search(r"[\d.]+", s)
    return float(num_match.group(0)) if num_match else None


# ─────────────────────────────────────────────────────────────────
# STAGE 3 — HTTP pagination using captured cookies
# ─────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────
# DETAIL-PAGE COORDINATE + AMENITIES EXTRACTION
#
# SRP (search results) pages confirmed to have NO lat/lng anywhere
# (verified via live JSON-LD inspection) and no amenities list either —
# both only exist on the detail/PDP page. Detail pages are a different
# template and typically embed a real map widget with the building's
# actual coordinates plus a "Top Amenities" section — tried here via
# several strategies since neither's exact embedding pattern has been
# confirmed live yet.
# ─────────────────────────────────────────────────────────────────

def _deep_find_coord_keys(obj) -> Optional[tuple[float, float]]:
    """Recursively searches a nested dict/list (JSON-LD shape) for
    latitude/longitude anywhere, same approach as the JS ingestion
    side's _deep_find — safe default until the exact PDP JSON shape
    is confirmed against the live site."""
    if isinstance(obj, dict):
        lat = obj.get("latitude")
        lng = obj.get("longitude")
        if lat is not None and lng is not None:
            try:
                return float(lat), float(lng)
            except (ValueError, TypeError):
                pass
        for v in obj.values():
            result = _deep_find_coord_keys(v)
            if result:
                return result
    elif isinstance(obj, list):
        for item in obj:
            result = _deep_find_coord_keys(item)
            if result:
                return result
    return None


# Inline JS variable patterns (outside any JSON-LD block) — some sites
# set coordinates as plain page-level JS variables rather than
# structured data. Tried as a fallback if no JSON-LD has them.
_LAT_LNG_VAR_PATTERN = re.compile(
    r'["\']?latitude["\']?\s*[:=]\s*["\']?(-?\d{1,2}\.\d+)["\']?.{0,200}?'
    r'["\']?longitude["\']?\s*[:=]\s*["\']?(-?\d{1,3}\.\d+)["\']?',
    re.DOTALL,
)

# Google Maps embed URL patterns — either "@lat,lng" (standard Maps URL
# format) or "q=lat,lng" / "center=lat,lng" (embed/static map formats).
_MAPS_URL_PATTERN = re.compile(
    r'(?:@|q=|center=)(-?\d{1,2}\.\d+)[,%2C]+\s*(-?\d{1,3}\.\d+)'
)


def extract_coordinates_from_detail_html(html: str) -> Optional[tuple[float, float]]:
    """
    Tries, in order:
      1. Any JSON-LD block's geo/latitude+longitude fields (structured
         data — most reliable when present)
      2. Inline JS variables named latitude/longitude anywhere in the page
      3. A Google Maps embed/static-map URL with coordinates in it

    Returns (lat, lng) or None. Logs which strategy succeeded (or that
    none did) so a live run makes it obvious which path to calibrate
    further if coverage turns out to be low.
    """
    soup = BeautifulSoup(html, "html.parser")

    for script in soup.find_all("script", {"type": "application/ld+json"}):
        try:
            data = json.loads(script.string or script.get_text())
        except (json.JSONDecodeError, TypeError):
            continue
        coords = _deep_find_coord_keys(data)
        if coords:
            return coords

    var_match = _LAT_LNG_VAR_PATTERN.search(html)
    if var_match:
        try:
            return float(var_match.group(1)), float(var_match.group(2))
        except ValueError:
            pass

    maps_match = _MAPS_URL_PATTERN.search(html)
    if maps_match:
        try:
            return float(maps_match.group(1)), float(maps_match.group(2))
        except ValueError:
            pass

    return None


# Individual amenity tiles are short labels ("Lift", "Power Backup", "24x7
# Security") — CONFIRMED via a live screenshot (2026-07-14) of a real PDP's
# "Top Amenities" section. This length cap is what keeps a too-wide
# container/section from also sweeping in unrelated paragraph text.
_AMENITY_LABEL_MAX_LEN = 40

# CONFIRMED live text pattern (2026-07-14 screenshot): the section header
# reads "<Society Name> Top Amenities" — matching on "top amenities" rather
# than just "amenities" avoids false-positive hits elsewhere on the page
# (nav links, "similar properties" blurbs, etc. that just mention the word).
_TOP_AMENITIES_HEADING_PATTERN = re.compile(r"top amenities", re.IGNORECASE)

# CONFIRMED live (same screenshot): the tile grid is truncated with a
# "View All Amenitites (14)" link when there are more amenities than fit
# in the initial grid (12 shown, 14 total in the example) — note the
# live site's own typo, "Amenitites" not "Amenities"; matched via
# `amenit\w*` so this survives either spelling. This scraper only ever
# sees static HTML (no click-through), so if the rest aren't already
# present in that HTML (e.g. in a same-page hidden modal), they're
# unreachable here. Matched so extract_amenities_from_detail_html can at
# least detect and log an under-count instead of silently returning a
# partial list with no signal that anything was missed.
_VIEW_ALL_AMENITIES_PATTERN = re.compile(r"view all amenit\w*\s*\((\d+)\)", re.IGNORECASE)

# The "View All Amenities (N)" link itself is short enough to otherwise
# pass as a leaf label — explicitly excluded, along with the generic
# "Read More" link seen elsewhere on the same PDP (see the "About" section
# in the same screenshot).
_SKIP_LABEL_PATTERN = re.compile(r"^(view all|read more)\b", re.IGNORECASE)

# CONFIRMED live (2026-07-14 scraper.log, real run): MagicBricks PDPs have
# a quick-nav tab strip near the TOP of the page ("Overview / Top Amenities
# / Nearby landmarks / Project Reviews...") that appears BEFORE the real
# "<Society> Top Amenities" section in document order. A naive first-match
# on "top amenities" grabs that tab strip's bare label instead, and the
# leaf-extraction then returns the OTHER tab names as if they were
# amenities (e.g. "Nearby landmarks", "Project Reviews" showed up as
# scraped "amenities" in a real run). These are the confirmed-bad values
# from that run, plus the promo blurb sitting next to the tab strip —
# used as a safety net to reject a heading candidate entirely rather than
# trust a list that's clearly the wrong section.
_NON_AMENITY_LABELS = {
    "top amenities", "amenities", "overview", "nearby landmarks",
    "project reviews", "photos", "floor plan", "price trends",
    "similar properties", "explore locality", "most comprehensive",
    "insights you won't find anywhere else", "mb",
}

# Real amenity tile labels are short, 1-3 word phrases ("Power Back Up",
# "Reserved Parking") — CONFIRMED via live screenshot. A sentence-like
# blurb ("Insights you won't find anywhere else") can still slip under
# the character-length cap, so a word-count cap catches it too.
_AMENITY_LABEL_MAX_WORDS = 4


def _looks_like_real_amenity_list(names: list[str]) -> bool:
    """
    Safety net for the heading-anchored strategy (see _NON_AMENITY_LABELS'
    docstring for the confirmed live failure mode this guards against).
    Any single bad-looking label invalidates the WHOLE candidate list —
    a wrong container was found, so nothing extracted from it should be
    trusted, not just the one obviously-bad entry.
    """
    if not names:
        return False
    for n in names:
        if n.strip().lower() in _NON_AMENITY_LABELS:
            return False
        if len(n.split()) > _AMENITY_LABEL_MAX_WORDS:
            return False
    return True


def _dedupe_preserve_order(items: list[str]) -> list[str]:
    seen = set()
    out = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _extract_leaf_amenity_labels(container) -> list[str]:
    """
    Pulls one label per amenity tile out of a container shaped like the
    confirmed PDP grid — a repeated icon+label tile, where the icon (svg/
    img) contributes no text so the tile's own innermost text-bearing
    element IS the amenity name. Only true leaves (no element children)
    are taken, so a tile's outer wrapper div doesn't ALSO get counted
    right alongside its inner label.
    """
    labels = []
    for el in container.find_all(["li", "span", "p", "div", "a"]):
        if el.find_all():  # has element children -> not a leaf; its text is covered by the leaf itself
            continue
        text = el.get_text(strip=True)
        if not text or len(text) > _AMENITY_LABEL_MAX_LEN or _SKIP_LABEL_PATTERN.match(text):
            continue
        # CONFIRMED live: a rating-star icon (e.g. "★") sometimes renders as
        # a plain unicode character rather than an svg/img, so it has real
        # text and passes the leaf check above like a genuine label would —
        # requiring at least one letter is what filters pure symbol/icon
        # glyphs out without also rejecting real labels like "24x7 Security".
        if not any(c.isalpha() for c in text):
            continue
        labels.append(text)
    return _dedupe_preserve_order(labels)


def _find_section_after_heading(heading):
    """
    The confirmed heading ("<Society> Top Amenities") sits directly above
    the tile grid, but exactly how many DOM levels separate them from a
    shared ancestor isn't known — walk up from heading.parent (bounded, so
    this can't runaway to capturing the whole page) until reaching an
    ancestor whose OWN text STARTS WITH the heading's text, i.e. the
    heading is the leading content of that container.

    Deliberately NOT "has more text than the heading" (an earlier version
    of this used that, and it broke on a short amenities list: with only
    a couple of tiles, the heading's immediate container didn't have
    "enough extra text" to satisfy that check, so it kept walking up past
    an unrelated preceding sibling — a nav tab strip — into a shared
    ancestor that included BOTH, letting the tab strip's other labels
    leak back in through this path even though the heading-preference and
    _looks_like_real_amenity_list checks elsewhere already guard against
    picking the tab strip's OWN heading directly). Requiring the heading
    to be the leading content rules that out structurally.
    """
    ancestor = heading.parent
    heading_text = heading.get_text(strip=True)
    for _ in range(4):
        if ancestor is None:
            break
        ancestor_text = ancestor.get_text(strip=True)
        if ancestor_text.startswith(heading_text) and len(ancestor_text) > len(heading_text):
            return ancestor
        ancestor = ancestor.parent
    return heading.parent


def extract_amenities_from_detail_html(html: str) -> list[str]:
    """
    Extracts the PDP's "Top Amenities" list (e.g. "Lift", "Power Backup",
    "24x7 Security", "Gymnasium"). Tried in order:
      1. schema.org `amenityFeature` in any JSON-LD block (structured
         data — most reliable when present AND not subject to the same
         "View All" truncation as the visible tile grid, since it's a
         separate machine-readable representation).
      2. The confirmed "<Society> Top Amenities" heading (see
         _TOP_AMENITIES_HEADING_PATTERN) — leaf-text labels are pulled
         from the section that follows it.
      3. A CSS container matched via _AMENITIES_CONTAINER_SELECTORS, for
         listings whose heading is worded differently.

    Degrades to an empty (or partial) list rather than raising if the
    shape doesn't match — a miss here costs one listing's amenities, not
    the whole scrape. If a "View All Amenities (N)" link is present and
    N exceeds what was actually found, logs a warning rather than
    silently returning an incomplete list with no signal.
    """
    soup = BeautifulSoup(html, "html.parser")

    for script in soup.find_all("script", {"type": "application/ld+json"}):
        try:
            data = json.loads(script.string or script.get_text())
        except (json.JSONDecodeError, TypeError):
            continue
        features = _deep_find(data, "amenityFeature")
        if isinstance(features, list) and features:
            names = [
                str(f.get("name")).strip() if isinstance(f, dict) and f.get("name") else str(f).strip()
                for f in features
            ]
            names = _dedupe_preserve_order([n for n in names if n])
            if names:
                return names

    names = []
    heading_candidates = [
        tag for tag in soup.find_all(["h1", "h2", "h3", "h4", "div", "span", "p"])
        if tag.get_text(strip=True) and len(tag.get_text(strip=True)) <= 80
        and _TOP_AMENITIES_HEADING_PATTERN.search(tag.get_text(strip=True))
    ]
    # The real section heading is "<Society> Top Amenities" (longer than
    # the bare "Top Amenities" tab-strip label) — trying longer matches
    # first means the real heading normally wins outright; the
    # _looks_like_real_amenity_list check below is what actually GUARANTEES
    # the tab strip never gets accepted, even if this ordering doesn't
    # land on the right candidate first.
    heading_candidates.sort(key=lambda t: len(t.get_text(strip=True)), reverse=True)

    for heading in heading_candidates:
        candidate = _extract_leaf_amenity_labels(_find_section_after_heading(heading))
        if _looks_like_real_amenity_list(candidate):
            names = candidate
            break

    # No generic CSS-class fallback here on purpose: an earlier version
    # tried `[class*='amenities']`-style selectors as a last resort, but
    # CONFIRMED live (2026-07-14) that this actually matched an unrelated
    # "Specifications" accordion on some listings — the exact same
    # ["Parking", "Lift", "Flooring", "Furnishing", "Additional Rooms"]
    # set showed up as "amenities" across totally unrelated societies,
    # a dead giveaway it's a generic category menu, not real per-listing
    # amenities. An empty list (an honest "couldn't find it") is strictly
    # better than a confident wrong one.

    count_match = _VIEW_ALL_AMENITIES_PATTERN.search(soup.get_text())
    if count_match:
        total = int(count_match.group(1))
        if len(names) < total:
            log.warning(
                f"Amenities section shows 'View All Amenities ({total})' but only "
                f"{len(names)} were captured from the static HTML — the rest are "
                f"likely behind a click-to-expand this scraper doesn't drive. "
                f"Got: {names}"
            )

    return names


async def fetch_listing_detail_data(client: httpx.AsyncClient, listing_url: str) -> dict:
    """
    Fetches a listing's detail page ONCE and pulls out everything that
    page has that the SRP card doesn't: precise coordinates (see
    extract_coordinates_from_detail_html) and the Top Amenities list (see
    extract_amenities_from_detail_html). Combined into a single fetch —
    the detail-page fetch is already the slow, rate-limit-sensitive part
    of the scrape (see enrich_listings_with_detail_data), not worth
    paying for twice per listing.
    """
    empty = {"coords": None, "amenities": []}
    if not listing_url or listing_url.startswith(f"{BASE_URL}/unresolved-url"):
        return empty
    try:
        resp = await client.get(listing_url)

        if resp.status_code == 429 or resp.status_code == 503:
            retry_after = resp.headers.get("Retry-After")
            wait_seconds = int(retry_after) if retry_after and retry_after.isdigit() else 60
            log.warning(f"Detail page fetch rate-limited (HTTP {resp.status_code}) — "
                        f"backing off for {wait_seconds}s, this is the more request-heavy part of the scrape.")
            await asyncio.sleep(wait_seconds)
            resp = await client.get(listing_url)

        if resp.status_code != 200:
            log.warning(f"Detail page fetch for {listing_url} returned HTTP {resp.status_code}")
            return empty

        return {
            "coords": extract_coordinates_from_detail_html(resp.text),
            "amenities": extract_amenities_from_detail_html(resp.text),
        }
    except httpx.RequestError as e:
        log.warning(f"Detail page fetch failed for {listing_url}: {e}")
        return empty


async def enrich_listings_with_detail_data(client: httpx.AsyncClient, listings: list[ScrapedListing]) -> None:
    """
    Visits each listing's detail page to fill in real lat/lng AND its
    Top Amenities list, mutating the listings in place. Amenities land in
    raw_metadata (not a dedicated ScrapedListing field) since that's this
    project's existing catch-all for scraped data without its own DB
    column — ingest.js already persists the whole raw_metadata dict as
    JSONB with zero extra plumbing needed.

    Only reasonable to do per-listing because a locality-scoped search
    returns dozens of listings, not thousands — this would NOT be the
    right approach for a city-wide scrape.
    """
    found_coords = 0
    found_amenities = 0
    for i, listing in enumerate(listings, 1):
        await asyncio.sleep(random.uniform(*REQUEST_DELAY_RANGE))
        detail = await fetch_listing_detail_data(client, listing.listing_url)
        if detail["coords"]:
            listing.lat, listing.lng = detail["coords"]
            found_coords += 1
        if detail["amenities"]:
            listing.raw_metadata["amenities"] = detail["amenities"]
            found_amenities += 1
        if i % 10 == 0:
            log.info(f"Detail-page enrichment: {i}/{len(listings)} processed, "
                      f"{found_coords} coordinates and {found_amenities} amenity lists found so far")

    log.info(f"Detail-page enrichment complete: {found_coords}/{len(listings)} listings got real coordinates, "
             f"{found_amenities}/{len(listings)} got an amenities list")


# ─────────────────────────────────────────────────────────────────
# SCRAPE ORCHESTRATION
# ─────────────────────────────────────────────────────────────────

async def scrape_all(max_pages: int = MAX_PAGES) -> list[ScrapedListing]:
    cookies, first_page_html = await bootstrap_session()
    all_listings: list[ScrapedListing] = []

    # Parse page 1 (already fetched during bootstrap — don't waste it)
    all_listings.extend(_parse_page(first_page_html))
    log.info(f"Page 1: {len(all_listings)} listings parsed so far")

    async with httpx.AsyncClient(
        cookies=cookies,
        headers={"User-Agent": USER_AGENT, "Referer": "https://www.magicbricks.com/"},
        timeout=30,
        follow_redirects=True,
    ) as client:
        for page_num in range(2, max_pages + 1):
            await asyncio.sleep(random.uniform(*REQUEST_DELAY_RANGE))

            if page_num % BROWSER_REFRESH_EVERY == 0:
                log.info("Refreshing session via Playwright (periodic re-validation)...")
                cookies, _ = await bootstrap_session()
                client.cookies.update(cookies)

            url = SEARCH_URL_TEMPLATE.format(page=page_num)
            try:
                resp = await client.get(url)
            except httpx.RequestError as e:
                log.warning(f"Page {page_num} request failed: {e}. Retrying once.")
                await asyncio.sleep(5)
                try:
                    resp = await client.get(url)
                except httpx.RequestError as e2:
                    log.error(f"Page {page_num} failed twice, skipping: {e2}")
                    continue

            if resp.status_code == 429 or resp.status_code == 503:
                # An explicit "slow down" signal from the server — the
                # respectful response is to actually back off significantly,
                # honoring Retry-After if the server sent one, then retry
                # THIS SAME page (not skip ahead to the next one, which
                # would just hit the same rate limit again immediately).
                retry_after = resp.headers.get("Retry-After")
                wait_seconds = int(retry_after) if retry_after and retry_after.isdigit() else 60
                log.warning(f"Page {page_num} got HTTP {resp.status_code} (rate limited) — "
                            f"backing off for {wait_seconds}s before retrying, as requested.")
                await asyncio.sleep(wait_seconds)
                try:
                    resp = await client.get(url)
                except httpx.RequestError as e:
                    log.error(f"Page {page_num} failed again after rate-limit backoff: {e}. Skipping this page.")
                    continue

            if resp.status_code != 200:
                log.warning(f"Page {page_num} returned HTTP {resp.status_code}. "
                            f"Re-bootstrapping session and retrying once.")
                cookies, _ = await bootstrap_session()
                client.cookies.update(cookies)
                continue

            page_listings = _parse_page(resp.text)
            if not page_listings:
                log.info(f"Page {page_num} returned 0 listings — assuming end of results, stopping.")
                break

            all_listings.extend(page_listings)
            log.info(f"Page {page_num}: +{len(page_listings)} listings (running total: {len(all_listings)})")

        # Reuses the SAME authenticated client/cookies, before the
        # session closes, to fetch each listing's detail page for its
        # real coordinates — precise (building-level, not sector-level)
        # and covers every listing, not just the ones Nominatim happens
        # to recognize by name.
        log.info(f"Starting detail-page enrichment (coordinates + amenities) for {len(all_listings)} listings...")
        await enrich_listings_with_detail_data(client, all_listings)

    return all_listings


def _parse_page(html: str) -> list[ScrapedListing]:
    # DOM-first: confirmed via live inspection that MagicBricks SRP pages
    # are server-rendered, so the card list is reliably present in HTML.
    listings = parse_listings_from_dom(html)
    if listings:
        return listings

    # Fallback: in case some page variant embeds a JSON blob instead
    # (not confirmed to exist on rent SRP pages, but cheap to try).
    log.info("DOM parse returned nothing, trying JSON blob fallback...")
    blob = extract_json_blob(html)
    if blob:
        items = _find_listing_array(blob)
        if items:
            parsed = [parse_listing_from_json(i) for i in items]
            return [p for p in parsed if p is not None]
    return []


def _find_listing_array(blob: dict) -> list:
    """
    JSON blob structure varies; walk common nesting paths rather than
    assuming one fixed shape. Extend this list once you've inspected
    a real payload.
    """
    candidates = [
        blob.get("results"),
        blob.get("searchResults"),
        blob.get("properties"),
        blob.get("data", {}).get("results") if isinstance(blob.get("data"), dict) else None,
    ]
    for c in candidates:
        if isinstance(c, list) and c:
            return c
    return []


# ─────────────────────────────────────────────────────────────────
# ENTRYPOINT
# ─────────────────────────────────────────────────────────────────

async def main():
    log.info("Starting MagicBricks scrape run")
    listings = await scrape_all()

    # NOTE: no radius filtering happens here. MagicBricks' search-results
    # pages don't expose per-listing lat/lng (confirmed via live JSON-LD
    # inspection), so every listing.lat/lng is None at this point by
    # design — coordinates get filled in later during ingestion, via
    # geocoding. The "is this listing within the configured radius of the
    # store location" check
    # correctly happens in ingest.js AFTER real coordinates exist, not
    # here. An earlier version of this function filtered by within_radius()
    # at this stage, which — since lat/lng is always None here — silently
    # discarded every listing regardless of where it actually is. Fixed.
    log.info(f"Scraped {len(listings)} total listings")

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        for listing in listings:
            f.write(json.dumps(asdict(listing)) + "\n")

    log.info(f"Wrote {len(listings)} listings to {OUTPUT_PATH}")


if __name__ == "__main__":
    asyncio.run(main())

# ─────────────────────────────────────────────────────────────────
# NOTE ON GETTING THIS TO 100%:
#
# Run once with `headless=False` (temporarily flip the launch() arg)
# and step through in a visible browser, or inspect bootstrap_debug.png
# after a failed run. Then:
#   1. Open browser devtools > Network tab on the real MagicBricks SRP
#   2. Search page source for "latitude" or "bhk" to find the actual
#      embedded JSON variable name -> update JSON_BLOB_PATTERNS
#   3. If no JSON blob exists at all, inspect one listing card's HTML
#      and update the CSS selectors in parse_listings_from_dom()
#   4. Confirm the real pagination param (?page=N vs ?offset=N vs a
#      POST "load more" call) and adjust SEARCH_URL_TEMPLATE / scrape_all
#   5. Open one listing's own detail/PDP page and confirm the "Top
#      Amenities" section's real markup -> update
#      _AMENITIES_CONTAINER_SELECTORS in extract_amenities_from_detail_html()
#      (same idea as step 3, just for the PDP's amenities block instead
#      of the SRP's listing cards)
#
# This is a ~15-30 minute calibration pass against the live site, not
# a rewrite — the cookie capture, retry, distance filter, and output
# schema underneath are stable regardless of what you find.
# ─────────────────────────────────────────────────────────────────