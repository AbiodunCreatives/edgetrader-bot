/**
 * Market aggregator — unified interface across Polymarket and Bayse.
 *
 * All external code should import from this file rather than from the
 * individual source clients, so source-routing logic lives in one place.
 */

import {
  searchMarkets as searchPoly,
  getMarketById as getPolyById,
  getTopMarkets as getPolyTop,
} from "./polymarket.js";
import {
  searchBayseMarkets,
  getBayseMarket,
  getTrendingBayseMarkets,
} from "./bayse.js";

// Re-export the canonical type and key helpers so callers only need one import.
export type { MarketData } from "./types.js";
export { marketKey, parseMarketKey } from "./types.js";

// ── searchAllMarkets ───────────────────────────────────────────────────────

/**
 * Search across all sources concurrently.
 *
 * - Both source searches run in parallel; a failure in one doesn't block the other.
 * - Results are deduplicated on exact question text (case-insensitive) to
 *   collapse markets that appear on both platforms with identical wording.
 * - Sorted by volume descending so the most liquid markets surface first.
 * - Returns up to `limit` results per source (so up to `limit * 2` total before dedup).
 */
export async function searchAllMarkets(
  query: string,
  limit = 10
): Promise<import("./types.js").MarketData[]> {
  const [polyResult, bayseResult] = await Promise.allSettled([
    searchPoly(query, limit),
    searchBayseMarkets(query, limit),
  ]);

  const combined: import("./types.js").MarketData[] = [];

  if (polyResult.status === "fulfilled") {
    combined.push(...polyResult.value);
  } else {
    console.warn("[aggregator] Polymarket search failed:", polyResult.reason);
  }

  if (bayseResult.status === "fulfilled") {
    combined.push(...bayseResult.value);
  } else {
    console.warn("[aggregator] Bayse search failed:", bayseResult.reason);
  }

  // Deduplicate by normalised question text
  const seen = new Set<string>();
  return combined
    .filter((m) => {
      const key = m.question.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.volume - a.volume);
}

// ── getMarketById ──────────────────────────────────────────────────────────

/**
 * Fetch a single market by composite key `"source:id"`.
 * Returns null for unknown sources or missing markets.
 *
 * @example
 *   getMarketById("polymarket:0xabc123...")
 *   getMarketById("bayse:bayse_12345")
 */
export async function getMarketById(
  compositeId: string
): Promise<import("./types.js").MarketData | null> {
  const colonIdx = compositeId.indexOf(":");
  if (colonIdx === -1) return null;

  const source = compositeId.slice(0, colonIdx);
  const id = compositeId.slice(colonIdx + 1);

  if (source === "polymarket") return getPolyById(id);
  if (source === "bayse") return getBayseMarket(id);

  console.warn(`[aggregator] Unknown market source: "${source}"`);
  return null;
}

// ── getTopMarkets ──────────────────────────────────────────────────────────

/**
 * Fetch the most liquid/active markets from each source and merge them.
 * Useful for the /picks command and daily digests.
 */
export async function getTopMarkets(
  limitPerSource = 5
): Promise<import("./types.js").MarketData[]> {
  const [polyResult, bayseResult] = await Promise.allSettled([
    getPolyTop(limitPerSource),
    getTrendingBayseMarkets(limitPerSource),
  ]);

  const combined: import("./types.js").MarketData[] = [];
  if (polyResult.status === "fulfilled") combined.push(...polyResult.value);
  if (bayseResult.status === "fulfilled") combined.push(...bayseResult.value);

  return combined.sort((a, b) => b.volume - a.volume);
}

// ── compareMarkets ─────────────────────────────────────────────────────────

/**
 * Run the same query on each platform in parallel and return the results
 * side-by-side. Used by the /compare command to show pricing discrepancies.
 */
export async function compareMarkets(query: string, limit = 5): Promise<{
  polymarket: import("./types.js").MarketData[];
  bayse: import("./types.js").MarketData[];
}> {
  const [polyResult, bayseResult] = await Promise.allSettled([
    searchPoly(query, limit),
    searchBayseMarkets(query, limit),
  ]);

  return {
    polymarket: polyResult.status === "fulfilled" ? polyResult.value : [],
    bayse: bayseResult.status === "fulfilled" ? bayseResult.value : [],
  };
}
