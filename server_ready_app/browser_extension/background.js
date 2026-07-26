chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "RENTIQ_SUBMIT_CAPTURE") return;

  (async () => {
    const serverUrl = String(message.serverUrl || "").trim().replace(/\/+$/, "");
    if (!serverUrl) throw new Error("RentIQ server URL is missing.");

    const headers = { "Content-Type": "application/json" };
    const captureKey = String(message.captureKey || "").trim();
    if (captureKey) headers["X-Capture-Key"] = captureKey;

    const response = await fetch(`${serverUrl}/api/browser-capture`, {
      method: "POST",
      headers,
      body: JSON.stringify(message.payload || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Server returned HTTP ${response.status}`);

    return data;
  })()
    .then(data => sendResponse({ ok: true, ...data }))
    .catch(error => sendResponse({ ok: false, error: error.message }));

  return true;
});
