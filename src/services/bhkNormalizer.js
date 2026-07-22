/**
 * bhkNormalizer.js
 *
 * Turns whatever free-text BHK string MagicBricks gives us into:
 *   - bhk_type:    a stable, normalized label used for GROUP BY / bucketing
 *   - bhk_numeric: a sortable numeric value (null when there isn't one)
 *
 * DESIGN RULE: this file must never special-case "2 BHK" or assume a
 * fixed set of configurations. Every configuration — present today or
 * added by MagicBricks tomorrow — goes through the same regex-driven
 * parse path. Unrecognized strings fall back to a cleaned version of
 * the raw text rather than being dropped, so bucketing degrades
 * gracefully instead of silently losing listings.
 */

// Known non-numeric configuration keywords, checked before the
// numeric regex. Extend this list freely — it does not change any
// other logic in the file.
const NAMED_CONFIGS = [
  { pattern: /studio/i, type: "STUDIO", numeric: 0 },
  { pattern: /\brk\b/i, type: "1RK", numeric: 0.5 }, // "1 RK" — handled below too, kept here as a fallback
  { pattern: /penthouse/i, type: "PENTHOUSE", numeric: null },
];

/**
 * @param {string} raw  e.g. "2 BHK", "2.5 BHK", "1 RK", "Penthouse", "3BHK+Servant"
 * @returns {{bhk_type: string, bhk_numeric: number|null, bhk_raw: string}}
 */
function normalizeBhk(raw) {
  const bhk_raw = (raw || "").trim();
  if (!bhk_raw) {
    return { bhk_type: "UNKNOWN", bhk_numeric: null, bhk_raw };
  }

  const cleaned = bhk_raw.toLowerCase();

  // 1. "N RK" (e.g. "1 RK") — treat distinctly from BHK since it's a
  //    different property class (room-kitchen, no separate bedroom).
  const rkMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*rk/);
  if (rkMatch) {
    const n = parseFloat(rkMatch[1]);
    return { bhk_type: `${formatNum(n)}RK`, bhk_numeric: n, bhk_raw };
  }

  // 2. "N BHK" / "N.M BHK" (e.g. "2 BHK", "2.5 BHK", "3BHK")
  const bhkMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*\+?\s*bhk/);
  if (bhkMatch) {
    const n = parseFloat(bhkMatch[1]);
    return { bhk_type: `${formatNum(n)}BHK`, bhk_numeric: n, bhk_raw };
  }

  // 3. Named non-numeric configs (studio, penthouse, ...)
  for (const config of NAMED_CONFIGS) {
    if (config.pattern.test(cleaned)) {
      return { bhk_type: config.type, bhk_numeric: config.numeric, bhk_raw };
    }
  }

  // 4. Fallback — never silently drop the listing. Normalize whitespace
  //    and case so at least exact-duplicate unknowns still bucket
  //    together, and flag it for manual review via raw_metadata upstream.
  const fallbackType = bhk_raw.toUpperCase().replace(/\s+/g, "_");
  return { bhk_type: fallbackType, bhk_numeric: null, bhk_raw };
}

function formatNum(n) {
  // 2 -> "2", 2.5 -> "2.5" — avoids "2.0BHK"
  return Number.isInteger(n) ? String(n) : String(n);
}

/**
 * Sort comparator for displaying buckets in a sensible order:
 * numeric configs ascending (1 RK, 1 BHK, 2 BHK, 2.5 BHK, 3 BHK...),
 * then any non-numeric/unknown configs alphabetically at the end.
 */
function compareBhkTypes(a, b) {
  const an = a.bhk_numeric;
  const bn = b.bhk_numeric;
  if (an !== null && bn !== null) return an - bn;
  if (an !== null) return -1;
  if (bn !== null) return 1;
  return a.bhk_type.localeCompare(b.bhk_type);
}

module.exports = { normalizeBhk, compareBhkTypes };