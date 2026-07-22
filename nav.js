// ═══════════════════════════════════════════════════
//  Shared nav bar — single source of truth for the 4-page nav so it
//  can't drift (one page edited, others forgotten). Each page has
//  <div id="nav-placeholder" data-active="upload"></div> + this script;
//  injected on DOMContentLoaded and highlights the matching link.
// ═══════════════════════════════════════════════════
(function () {
  const LINKS = [
    { key: "grid", href: "index.html", label: "🗺️ Grid Map" },
    { key: "upload", href: "upload.html", label: "📤 Upload & Extract" },
    { key: "listings", href: "listings.html", label: "📋 Listings" },
    { key: "history", href: "history.html", label: "🕘 Run History" },
  ];

  function render() {
    const placeholder = document.getElementById("nav-placeholder");
    if (!placeholder) return;
    const active = placeholder.dataset.active;

    placeholder.innerHTML = `
      <nav class="app-nav">
        ${LINKS.map(
          (l) => `<a href="${l.href}" class="app-nav-link${l.key === active ? " active" : ""}">${l.label}</a>`
        ).join("")}
      </nav>`;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
