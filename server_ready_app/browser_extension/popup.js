const serverInput = document.getElementById("server-url");
const cityInput = document.getElementById("city");
const localityInput = document.getElementById("locality");
const keyInput = document.getElementById("capture-key");
const button = document.getElementById("capture");
const statusEl = document.getElementById("status");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes("magicbricks.com")) {
    throw new Error("Open a MagicBricks search-results page first.");
  }
  return tab;
}

async function initialize() {
  const saved = await chrome.storage.sync.get(["serverUrl", "captureKey"]);
  if (saved.serverUrl) serverInput.value = saved.serverUrl;
  if (saved.captureKey) keyInput.value = saved.captureKey;

  try {
    const tab = await activeTab();
    const url = new URL(tab.url);
    cityInput.value = url.searchParams.get("cityName") || "";
    localityInput.value = url.searchParams.get("Locality") || "";
  } catch (error) {
    setStatus(error.message, true);
  }
}

button.addEventListener("click", async () => {
  button.disabled = true;
  setStatus("Reading property cards…");

  try {
    const tab = await activeTab();
    const serverUrl = serverInput.value.trim().replace(/\/+$/, "");
    const city = cityInput.value.trim();
    const locality = localityInput.value.trim();
    const captureKey = keyInput.value.trim();

    if (!serverUrl) throw new Error("RentIQ server URL is required.");
    if (!city) throw new Error("City is required.");

    await chrome.storage.sync.set({ serverUrl, captureKey });

    const capture = await chrome.tabs.sendMessage(tab.id, { type: "RENTIQ_CAPTURE_VISIBLE" });
    if (!capture?.ok) throw new Error(capture?.error || "The page could not be read.");
    if (!capture.listings?.length) {
      throw new Error("No property cards were found. Complete the CAPTCHA and wait for listings first.");
    }

    setStatus(`Found ${capture.listings.length} cards. Reading property coordinates automatically…`);

    const result = await chrome.runtime.sendMessage({
      type: "RENTIQ_ENRICH_AND_SUBMIT",
      serverUrl,
      captureKey,
      searchTabId: tab.id,
      payload: {
        city,
        locality,
        page_url: tab.url,
        listings: capture.listings
      }
    });

    if (!result?.ok) throw new Error(result?.error || "Coordinate enrichment failed.");

    setStatus(
      `Success: ${result.listing_count} listings saved.\nCoordinates: ${result.coordinates_found}/${result.listing_count}.\nRun ID: ${result.run_id}`
    );
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
});

initialize();
