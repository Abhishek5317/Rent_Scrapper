function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "RENTIQ_CAPTURE_VISIBLE") return;
  try {
    sendResponse({ ok: true, listings: captureVisibleListings() });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
});
