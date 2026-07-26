const DETAIL_LOAD_TIMEOUT_MS = 60 * 1000;
const DETAIL_COORDINATE_TIMEOUT_MS = 45 * 1000;
const CAPTCHA_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const DETAIL_DELAY_MS = 1400;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function validCoordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max;
}

function validIndiaPair(latitude, longitude) {
  return validCoordinate(latitude, 5, 40) && validCoordinate(longitude, 65, 100);
}

async function sendProgress(tabId, message, kind = "info", current = null, total = null) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "RENTIQ_ENRICH_PROGRESS",
      message,
      kind,
      current,
      total
    });
  } catch {
    // Search tab may have been closed. Enrichment can continue without the overlay.
  }
}

function waitForTabComplete(tabId, timeoutMs = DETAIL_LOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
    };

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };

    const timer = setTimeout(() => {
      finish(new Error("Timed out while loading a MagicBricks property page."));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId)
      .then(tab => {
        if (tab.status === "complete") finish();
      })
      .catch(error => finish(error));
  });
}

function probeMagicBricksDetailPage() {
  const cleanText = value => String(value || "").replace(/\s+/g, " ").trim();

  const toNumber = value => {
    if (value === null || value === undefined || value === "") return null;
    const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0]);
    return Number.isFinite(number) ? number : null;
  };

  const validPair = (latitude, longitude) => {
    const lat = toNumber(latitude);
    const lng = toNumber(longitude);
    if (lat === null || lng === null) return null;
    if (lat < 5 || lat > 40 || lng < 65 || lng > 100) return null;
    return { latitude: lat, longitude: lng };
  };

  const deepPair = (value, depth = 0) => {
    if (!value || depth > 14) return null;

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = deepPair(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    if (typeof value !== "object") return null;

    const directPairs = [
      [value.latitude, value.longitude],
      [value.lat, value.lng],
      [value.lat, value.lon],
      [value.latitude, value.lng],
      [value.latitude, value.lon]
    ];

    for (const [latitude, longitude] of directPairs) {
      const pair = validPair(latitude, longitude);
      if (pair) return pair;
    }

    for (const nested of Object.values(value)) {
      const found = deepPair(nested, depth + 1);
      if (found) return found;
    }
    return null;
  };

  const challengeText = cleanText(document.body?.innerText).toLowerCase();
  const challenge = [
    "captcha",
    "verify you are human",
    "security check",
    "checking your browser",
    "unusual traffic",
    "access denied"
  ].some(term => challengeText.includes(term)) || [...document.querySelectorAll("iframe")].some(frame =>
    /captcha|recaptcha|hcaptcha|challenge/i.test(frame.src || "")
  );

  const attributePairs = [
    ["data-latitude", "data-longitude"],
    ["data-lat", "data-lng"],
    ["data-lat", "data-lon"],
    ["latitude", "longitude"]
  ];

  for (const [latAttribute, lngAttribute] of attributePairs) {
    for (const element of document.querySelectorAll(`[${latAttribute}][${lngAttribute}]`)) {
      const pair = validPair(
        element.getAttribute(latAttribute),
        element.getAttribute(lngAttribute)
      );
      if (pair) return { ...pair, source: "detail-dom-attribute", challenge: false };
    }
  }

  const metaLatitude = document.querySelector(
    'meta[itemprop="latitude"], meta[property="place:location:latitude"], meta[name="latitude"]'
  )?.content;
  const metaLongitude = document.querySelector(
    'meta[itemprop="longitude"], meta[property="place:location:longitude"], meta[name="longitude"]'
  )?.content;
  const metaPair = validPair(metaLatitude, metaLongitude);
  if (metaPair) return { ...metaPair, source: "detail-meta", challenge: false };

  const structuredScripts = document.querySelectorAll(
    'script[type="application/ld+json"], script[type="application/json"], script[id="__NEXT_DATA__"]'
  );
  for (const script of structuredScripts) {
    const text = script.textContent?.trim();
    if (!text) continue;
    try {
      const pair = deepPair(JSON.parse(text));
      if (pair) return { ...pair, source: "detail-structured-json", challenge: false };
    } catch {
      // Some application/json scripts are JavaScript fragments rather than valid JSON.
    }
  }

  const scriptText = [...document.scripts]
    .map(script => script.textContent || "")
    .filter(text => /latitude|longitude|\blat\b|\blng\b|\blon\b/i.test(text))
    .join("\n");

  const patterns = [
    /["']?(?:latitude|lat)["']?\s*[:=]\s*["']?(-?\d{1,2}(?:\.\d+)?)["']?[\s\S]{0,220}?["']?(?:longitude|lng|lon)["']?\s*[:=]\s*["']?(-?\d{2,3}(?:\.\d+)?)/i,
    /["']?(?:longitude|lng|lon)["']?\s*[:=]\s*["']?(-?\d{2,3}(?:\.\d+)?)["']?[\s\S]{0,220}?["']?(?:latitude|lat)["']?\s*[:=]\s*["']?(-?\d{1,2}(?:\.\d+)?)/i,
    /[?&](?:lat|latitude)=(-?\d{1,2}(?:\.\d+)?)[&][^\s"']*(?:lng|lon|longitude)=(-?\d{2,3}(?:\.\d+)?)/i,
    /@(-?\d{1,2}(?:\.\d+)?),(-?\d{2,3}(?:\.\d+)?)/
  ];

  for (let index = 0; index < patterns.length; index += 1) {
    const match = scriptText.match(patterns[index]) || location.href.match(patterns[index]);
    if (!match) continue;
    const pair = index === 1 ? validPair(match[2], match[1]) : validPair(match[1], match[2]);
    if (pair) return { ...pair, source: "detail-inline-data", challenge: false };
  }

  for (const link of document.querySelectorAll('a[href*="maps"], a[href*="google.com/maps"]')) {
    const href = link.href || "";
    const match = href.match(/@(-?\d{1,2}(?:\.\d+)?),(-?\d{2,3}(?:\.\d+)?)/)
      || href.match(/[?&](?:q|query)=(-?\d{1,2}(?:\.\d+)?),(-?\d{2,3}(?:\.\d+)?)/);
    if (!match) continue;
    const pair = validPair(match[1], match[2]);
    if (pair) return { ...pair, source: "detail-map-link", challenge: false };
  }

  return {
    latitude: null,
    longitude: null,
    source: null,
    challenge,
    title: document.title,
    pageTextLength: cleanText(document.body?.innerText).length
  };
}

async function runDetailProbe(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: probeMagicBricksDetailPage
  });
  return results?.[0]?.result || null;
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
}

async function waitForCoordinatesOrCaptchaResolution(detailTabId, searchTabId, index, total) {
  const startedAt = Date.now();
  let challengeWasShown = false;

  while (Date.now() - startedAt < CAPTCHA_WAIT_TIMEOUT_MS) {
    const probe = await runDetailProbe(detailTabId);
    if (probe && validIndiaPair(probe.latitude, probe.longitude)) return probe;

    if (probe?.challenge) {
      if (!challengeWasShown) {
        challengeWasShown = true;
        await focusTab(detailTabId);
        await sendProgress(
          searchTabId,
          `MagicBricks showed a CAPTCHA on property ${index}/${total}. Complete it manually; RentIQ will resume automatically.`,
          "warning",
          index,
          total
        );
      }
    } else if (challengeWasShown) {
      await sendProgress(
        searchTabId,
        `CAPTCHA cleared. Reading coordinates for property ${index}/${total}…`,
        "info",
        index,
        total
      );
    }

    if (!challengeWasShown && Date.now() - startedAt > DETAIL_COORDINATE_TIMEOUT_MS) return probe;
    await sleep(1800);
  }

  throw new Error("Timed out waiting for a property-detail CAPTCHA to be completed.");
}

async function enrichListings(listings, searchTabId) {
  const enriched = listings.map(item => ({ ...item, raw: { ...(item.raw || {}) } }));
  const targets = enriched.filter(item =>
    !validIndiaPair(item.latitude, item.longitude)
    && /^https:\/\/www\.magicbricks\.com\//i.test(String(item.listing_url || ""))
  );

  if (!targets.length) {
    return { listings: enriched, coordinatesFound: enriched.filter(item => validIndiaPair(item.latitude, item.longitude)).length };
  }

  let detailTabId = null;
  let coordinatesFound = enriched.filter(item => validIndiaPair(item.latitude, item.longitude)).length;

  try {
    for (let index = 0; index < targets.length; index += 1) {
      const listing = targets[index];
      const cleanUrl = String(listing.listing_url).split("#")[0];
      await sendProgress(
        searchTabId,
        `Reading property coordinates ${index + 1}/${targets.length}…`,
        "info",
        index + 1,
        targets.length
      );

      if (detailTabId === null) {
        const tab = await chrome.tabs.create({ url: cleanUrl, active: false });
        detailTabId = tab.id;
      } else {
        await chrome.tabs.update(detailTabId, { url: cleanUrl, active: false });
      }

      await waitForTabComplete(detailTabId);
      await sleep(1800);

      try {
        const probe = await waitForCoordinatesOrCaptchaResolution(
          detailTabId,
          searchTabId,
          index + 1,
          targets.length
        );
        if (probe && validIndiaPair(probe.latitude, probe.longitude)) {
          listing.latitude = Number(probe.latitude);
          listing.longitude = Number(probe.longitude);
          listing.raw.coordinate_source = probe.source || "detail-page";
          coordinatesFound += 1;
        } else {
          listing.raw.coordinate_source = "not-found";
        }
      } catch (error) {
        listing.raw.coordinate_source = "detail-error";
        listing.raw.coordinate_error = error.message;
      }

      await sleep(DETAIL_DELAY_MS + (index % 3) * 350);
    }
  } finally {
    if (detailTabId !== null) {
      try {
        await chrome.tabs.remove(detailTabId);
      } catch {
        // Tab may already have been closed manually.
      }
    }
    if (searchTabId) {
      try {
        await chrome.tabs.update(searchTabId, { active: true });
      } catch {
        // Search tab may have been closed.
      }
    }
  }

  return { listings: enriched, coordinatesFound };
}

async function submitCapture(message, sender) {
  const serverUrl = String(message.serverUrl || "").trim().replace(/\/+$/, "");
  if (!serverUrl) throw new Error("RentIQ server URL is missing.");

  const payload = { ...(message.payload || {}) };
  if (!Array.isArray(payload.listings) || !payload.listings.length) {
    throw new Error("No listings were supplied for enrichment.");
  }

  const searchTabId = message.searchTabId || sender.tab?.id || null;
  const enrichment = await enrichListings(payload.listings, searchTabId);
  payload.listings = enrichment.listings;

  await sendProgress(
    searchTabId,
    `Coordinate enrichment finished. ${enrichment.coordinatesFound}/${payload.listings.length} listings have latitude/longitude. Sending data to RentIQ…`,
    "info"
  );

  const headers = { "Content-Type": "application/json" };
  const captureKey = String(message.captureKey || "").trim();
  if (captureKey) headers["X-Capture-Key"] = captureKey;

  const response = await fetch(`${serverUrl}/api/browser-capture`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Server returned HTTP ${response.status}`);

  return {
    ...data,
    coordinates_found: enrichment.coordinatesFound,
    coordinates_missing: Math.max(payload.listings.length - enrichment.coordinatesFound, 0)
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["RENTIQ_ENRICH_AND_SUBMIT", "RENTIQ_SUBMIT_CAPTURE"].includes(message?.type)) return;

  submitCapture(message, sender)
    .then(data => sendResponse({ ok: true, ...data }))
    .catch(error => sendResponse({ ok: false, error: error.message }));

  return true;
});
