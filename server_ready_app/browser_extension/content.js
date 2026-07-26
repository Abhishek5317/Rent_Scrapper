const RENTIQ_PENDING_JOB = "rentiqPendingAutoCapture";
const AUTO_JOB_TTL_MS = 15 * 60 * 1000;
const AUTO_SCROLL_LIMIT_MS = 3 * 60 * 1000;
const WAIT_FOR_RESULTS_LIMIT_MS = 10 * 60 * 1000;
const SCROLL_DELAY_MS = 1500;
const STABLE_CYCLES_REQUIRED = 4;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function firstText(root, selectors) {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    const value = cleanText(element?.textContent);
    if (value) return value;
  }
  return "";
}

function firstAttribute(root, selectors, attribute) {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    const value = element?.getAttribute(attribute);
    if (value) return value;
  }
  return "";
}

function absoluteUrl(value) {
  if (!value) return "";
  try {
    return new URL(value, location.href).href;
  } catch {
    return "";
  }
}

function parseIndianMoney(text) {
  const normalized = cleanText(text).replace(/,/g, "");
  const match = normalized.match(/(?:₹|Rs\.?|INR)\s*([\d.]+)\s*(Lac|Lakh|Cr|Crore)?/i)
    || normalized.match(/([\d.]+)\s*(Lac|Lakh|Cr|Crore)\b/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = String(match[2] || "").toLowerCase();
  if (unit.startsWith("lac") || unit.startsWith("lakh")) return value * 100000;
  if (unit === "cr" || unit.startsWith("crore")) return value * 10000000;
  return value;
}

function parseArea(text) {
  const match = cleanText(text).replace(/,/g, "").match(
    /([\d.]+)\s*(?:sq\.?\s*ft|sqft|square\s*feet)/i
  );
  return match ? Number(match[1]) : null;
}

function parseBhk(text) {
  const match = cleanText(text).match(/(\d+(?:\.\d+)?)\s*BHK/i);
  return match ? `${match[1]} BHK` : "";
}

function parsePropertyType(text) {
  const types = [
    "Multistorey Apartment", "Builder Floor Apartment", "Builder Floor",
    "Residential House", "Service Apartment", "Studio Apartment",
    "Penthouse", "Villa", "Apartment"
  ];
  const normalized = cleanText(text).toLowerCase();
  return types.find(type => normalized.includes(type.toLowerCase())) || "";
}

function parseFurnishing(text) {
  const normalized = cleanText(text).toLowerCase();
  if (normalized.includes("semi-furnished") || normalized.includes("semi furnished")) return "Semi-Furnished";
  if (normalized.includes("unfurnished")) return "Unfurnished";
  if (normalized.includes("furnished")) return "Furnished";
  return "";
}

function collectCandidateCards() {
  const selectors = [
    ".mb-srp__card",
    "[class*='mb-srp__card']",
    "[data-propertyid]",
    "[data-property-id]"
  ];

  const candidates = new Set();
  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach(node => candidates.add(node));
  }

  if (!candidates.size) {
    document.querySelectorAll(
      "a[href*='propertyDetails'], a[href*='property-for-rent'], a[href*='propertyDetailsForRent']"
    ).forEach(anchor => {
      const card = anchor.closest("article, li, section, div[class*='card'], div");
      if (card) candidates.add(card);
    });
  }

  return [...candidates].filter(card => cleanText(card.textContent).length >= 40);
}

function extractCard(card) {
  const fullText = cleanText(card.textContent);
  const listingUrl = absoluteUrl(firstAttribute(card, [
    "a[href*='propertyDetails']",
    "a[href*='property-for-rent']",
    "a[href*='propertyDetailsForRent']",
    "a[href]"
  ], "href"));

  const title = firstText(card, [
    ".mb-srp__card--title",
    "[class*='card--title']",
    "[class*='property-title']",
    "h2", "h3"
  ]) || parseBhk(fullText) || "Rental property";

  const locality = firstText(card, [
    ".mb-srp__card--desc-loc",
    "[class*='location']",
    "[class*='locality']",
    "[class*='address']"
  ]);

  const rentText = firstText(card, [
    ".mb-srp__card__price--amount",
    "[class*='price--amount']",
    "[class*='rent']",
    "[class*='price']"
  ]) || fullText;

  const sourceId =
    card.getAttribute("data-propertyid")
    || card.getAttribute("data-property-id")
    || card.dataset?.propertyid
    || (listingUrl.match(/(?:propertyId=|\/)(\d{6,})/i)?.[1])
    || listingUrl;

  return {
    source_id: sourceId,
    title,
    locality,
    monthly_rent: parseIndianMoney(rentText),
    bhk: parseBhk(`${title} ${fullText}`),
    area_sqft: parseArea(fullText),
    property_type: parsePropertyType(fullText),
    furnishing: parseFurnishing(fullText),
    latitude: Number(card.getAttribute("data-latitude")) || null,
    longitude: Number(card.getAttribute("data-longitude")) || null,
    listing_url: listingUrl,
    raw: { text: fullText }
  };
}

function captureVisibleListings() {
  const extracted = collectCandidateCards().map(extractCard);
  const unique = new Map();

  for (const listing of extracted) {
    const key = listing.source_id
      || listing.listing_url
      || `${listing.title}|${listing.monthly_rent}|${listing.locality}`;
    if (!key) continue;
    if (!listing.listing_url && listing.monthly_rent === null) continue;
    if (!unique.has(key)) unique.set(key, listing);
  }

  return [...unique.values()];
}

function pageLooksLikeChallenge() {
  const bodyText = cleanText(document.body?.innerText).toLowerCase();
  const challengeText = [
    "captcha",
    "verify you are human",
    "security check",
    "checking your browser",
    "unusual traffic",
    "access denied"
  ].some(term => bodyText.includes(term));

  const challengeFrame = [...document.querySelectorAll("iframe")].some(frame =>
    /captcha|recaptcha|hcaptcha|challenge/i.test(frame.src || "")
  );

  return collectCandidateCards().length === 0 && (challengeText || challengeFrame);
}

function statusBox() {
  let box = document.getElementById("rentiq-auto-capture-status");
  if (box) return box;

  box = document.createElement("div");
  box.id = "rentiq-auto-capture-status";
  Object.assign(box.style, {
    position: "fixed",
    right: "18px",
    bottom: "18px",
    zIndex: "2147483647",
    maxWidth: "360px",
    padding: "14px 16px",
    borderRadius: "10px",
    background: "#17232c",
    color: "#ffffff",
    font: "600 14px/1.45 system-ui, sans-serif",
    boxShadow: "0 12px 35px rgba(0,0,0,.28)"
  });
  document.documentElement.appendChild(box);
  return box;
}

function setAutoStatus(message, kind = "info") {
  const box = statusBox();
  box.textContent = message;
  box.style.background = kind === "error" ? "#9f1c1c" : kind === "success" ? "#116149" : "#17232c";
}

function elementIsVisible(element) {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function clickLoadMoreIfPresent() {
  const pattern = /load more|show more|view more properties|see more properties/i;
  const candidate = [...document.querySelectorAll("button, a")].find(element =>
    elementIsVisible(element)
    && !element.disabled
    && pattern.test(cleanText(element.textContent))
  );

  if (!candidate) return false;
  candidate.click();
  return true;
}

function documentHeight() {
  return Math.max(
    document.body?.scrollHeight || 0,
    document.documentElement?.scrollHeight || 0
  );
}

async function waitForListings() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < WAIT_FOR_RESULTS_LIMIT_MS) {
    const count = collectCandidateCards().length;
    if (count > 0) return count;

    if (pageLooksLikeChallenge()) {
      setAutoStatus("RentIQ is waiting. Complete the CAPTCHA manually; automatic capture will resume afterwards.");
    } else {
      setAutoStatus("RentIQ is waiting for MagicBricks listing cards to load…");
    }
    await sleep(1500);
  }

  throw new Error("Timed out while waiting for MagicBricks listings. Open the search again and complete the CAPTCHA within 10 minutes.");
}

async function autoScrollUntilStable() {
  const startedAt = Date.now();
  let previousCount = -1;
  let previousHeight = -1;
  let stableCycles = 0;

  while (Date.now() - startedAt < AUTO_SCROLL_LIMIT_MS) {
    if (pageLooksLikeChallenge()) {
      await waitForListings();
    }

    const beforeCount = collectCandidateCards().length;
    const beforeHeight = documentHeight();
    setAutoStatus(`RentIQ is loading the full page automatically… ${beforeCount} listing cards found.`);

    const clickedLoadMore = clickLoadMoreIfPresent();
    window.scrollTo({ top: beforeHeight, behavior: "smooth" });
    await sleep(SCROLL_DELAY_MS);

    const afterCount = collectCandidateCards().length;
    const afterHeight = documentHeight();
    const atBottom = window.scrollY + window.innerHeight >= afterHeight - 250;
    const unchanged = afterCount === previousCount && afterHeight === previousHeight;

    if (unchanged && atBottom && !clickedLoadMore) {
      stableCycles += 1;
    } else {
      stableCycles = 0;
    }

    previousCount = afterCount;
    previousHeight = afterHeight;

    if (stableCycles >= STABLE_CYCLES_REQUIRED) return afterCount;
  }

  return collectCandidateCards().length;
}

function autoConfigFromHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (params.get("rentiq_auto") !== "1") return null;

  const serverUrl = cleanText(params.get("rentiq_server")).replace(/\/+$/, "");
  const city = cleanText(params.get("rentiq_city"));
  if (!serverUrl || !city) return null;

  return {
    serverUrl,
    city,
    locality: cleanText(params.get("rentiq_locality")),
    createdAt: Date.now()
  };
}

async function resolvePendingAutoJob() {
  const fromHash = autoConfigFromHash();
  if (fromHash) {
    await chrome.storage.local.set({ [RENTIQ_PENDING_JOB]: fromHash });
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return fromHash;
  }

  const saved = await chrome.storage.local.get(RENTIQ_PENDING_JOB);
  const job = saved[RENTIQ_PENDING_JOB];
  if (!job) return null;

  if (!job.createdAt || Date.now() - job.createdAt > AUTO_JOB_TTL_MS) {
    await chrome.storage.local.remove(RENTIQ_PENDING_JOB);
    return null;
  }
  return job;
}

async function runAutomaticCapture(job) {
  if (window.__rentiqAutoCaptureStarted) return;
  window.__rentiqAutoCaptureStarted = true;

  try {
    await waitForListings();
    await autoScrollUntilStable();

    const listings = captureVisibleListings();
    if (!listings.length) throw new Error("No listing cards were found after automatic scrolling.");

    const saved = await chrome.storage.sync.get(["captureKey"]);
    setAutoStatus(`RentIQ found ${listings.length} listings. Sending them to the server…`);

    const result = await chrome.runtime.sendMessage({
      type: "RENTIQ_SUBMIT_CAPTURE",
      serverUrl: job.serverUrl,
      captureKey: cleanText(saved.captureKey),
      payload: {
        city: job.city,
        locality: job.locality,
        page_url: location.href,
        listings
      }
    });

    if (!result?.ok) throw new Error(result?.error || "RentIQ server rejected the capture.");

    await chrome.storage.local.remove(RENTIQ_PENDING_JOB);
    setAutoStatus(`Success: ${result.listing_count} listings were saved in RentIQ.`, "success");
  } catch (error) {
    await chrome.storage.local.remove(RENTIQ_PENDING_JOB);
    setAutoStatus(`RentIQ automatic capture failed: ${error.message}`, "error");
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "RENTIQ_CAPTURE_VISIBLE") return;
  try {
    sendResponse({ ok: true, listings: captureVisibleListings() });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
});

resolvePendingAutoJob()
  .then(job => {
    if (job) runAutomaticCapture(job);
  })
  .catch(error => setAutoStatus(`RentIQ could not start: ${error.message}`, "error"));
