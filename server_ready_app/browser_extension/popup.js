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
  setStatus("Reading visible property cards…");

  try {
    const tab = await activeTab();
    const serverUrl = serverInput.value.trim().replace(/\/+$/, "");
    const city = cityInput.value.trim();
    const locality = localityInput.value.trim();
    const captureKey = keyInput.value.trim();

    if (!serverUrl) throw new Error("RentIQ server URL is required.");
    if (!city) throw new Error("City is required.");

    await chrome.storage.sync.set({ serverUrl, captureKey });

    const result = await chrome.tabs.sendMessage(tab.id, { type: "RENTIQ_CAPTURE_VISIBLE" });
    if (!result?.ok) throw new Error(result?.error || "The page could not be read.");
    if (!result.listings?.length) {
      throw new Error("No property cards were found. Complete the CAPTCHA, wait for listings, and scroll the page first.");
    }

    setStatus(`Found ${result.listings.length} cards. Sending to RentIQ…`);

    const headers = { "Content-Type": "application/json" };
    if (captureKey) headers["X-Capture-Key"] = captureKey;

    const response = await fetch(`${serverUrl}/api/browser-capture`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        city,
        locality,
        page_url: tab.url,
        listings: result.listings
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Server returned HTTP ${response.status}`);

    setStatus(`Success: ${data.listing_count} listings saved.\nRun ID: ${data.run_id}`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
});

initialize();
