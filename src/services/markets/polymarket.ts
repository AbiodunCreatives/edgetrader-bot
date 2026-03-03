/**
 * Polymarket CLOB API client.
 *
 * Docs: https://docs.polymarket.com/#markets
 * Base: https://clob.polymarket.com
 *
 * The CLOB API does not support full-text search, so searchMarkets()
 * paginates through active markets and filters client-side by question text.
 * Results are cached so repeated identical queries are cheap.
 */

import { config } from "../../config.js";
import { cacheGetOrFetch } from "../../utils/cache.js";
import type { MarketData } from "./types.js";

// ── Raw CLOB API types ─────────────────────────────────────────────────────

interface ClobToken {
  token_id: string;
  outcome: string;
  /** Current mid-market price, 0–1. */
  price: number;
  winner: boolean;
}

interface ClobMarket {
  condition_id: string;
  question: string;
  market_slug: string;
  tokens: ClobToken[];
  /** Volume as a numeric value (USD). */
  volume_num: number;
  liquidity_num: number;
  end_date_iso: string | null;
  category: string | null;
  active: boolean;
  closed: boolean;
  description?: string;
}

interface ClobPage {
  data: ClobMarket[];
  /** Base64-encoded cursor. "LTE=" (base64 of "-1") signals last page. */
  next_cursor: string;
  count: number;
  limit: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const BASE = config.POLYMARKET_CLOB_URL;
const PAGE_SIZE = 100;
/** Polymarket's sentinel value indicating there are no more pages. */
const END_CURSOR = "LTE=";
/** Minimum ms to wait between paginated requests (≈4 req/s). */
const PAGE_DELAY_MS = 250;

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch one page from the CLOB /markets endpoint.
 * Retries on 429 with exponential back-off (max ~30 s).
 */
async function fetchPage(cursor?: string): Promise<ClobPage> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), active: "true" });
  if (cursor) params.set("next_cursor", cursor);
  const url = `${BASE}/markets?${params}`;

  let attempt = 0;
  while (true) {
    attempt++;
    const res = await fetch(url, { headers: { Accept: "application/json" } });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? 0);
      const wait = retryAfter > 0 ? retryAfter * 1_000 : Math.min(500 * 2 ** attempt, 30_000);
      console.warn(`[polymarket] Rate-limited. Waiting ${wait}ms (attempt ${attempt})`);
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      throw new Error(`Polymarket CLOB ${res.status}: ${res.statusText} — ${url}`);
    }

    return res.json() as Promise<ClobPage>;
  }
}

function normalize(m: ClobMarket): MarketData {
  // YES token holds the probability of the affirmative outcome.
  // Fall back to the first token if "Yes" isn't present (e.g. multi-outcome).
  const yesToken = m.tokens.find((t) => t.outcome.toLowerCase() === "yes") ?? m.tokens[0];
  const probability = yesToken?.price ?? 0;

  return {
    id: m.condition_id,
    source: "polymarket",
    question: m.question,
    probability,
    lastPrice: probability,        // CLOB price == current mid-market price
    volume: m.volume_num,
    endDate: m.end_date_iso ?? null,
    url: `https://polymarket.com/event/${m.market_slug}`,
    category: m.category,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Search active Polymarket markets by question text.
 * Paginates the CLOB API and filters client-side; stops early once `limit`
 * matches are found or all pages are exhausted.
 */
export async function searchMarkets(query: string, limit = 10): Promise<MarketData[]> {
  const cacheKey = `poly:search:${query.toLowerCase()}:${limit}`;

  return cacheGetOrFetch(
    cacheKey,
    async () => {
      const results: MarketData[] = [];
      const needle = query.toLowerCase();
      let cursor: string | undefined;

      while (results.length < limit) {
        const page = await fetchPage(cursor);

        for (const market of page.data) {
          if (!market.active || market.closed) continue;
          if (market.question.toLowerCase().includes(needle)) {
            results.push(normalize(market));
            if (results.length >= limit) break;
          }
        }

        const isLastPage =
          !page.next_cursor ||
          page.next_cursor === END_CURSOR ||
          page.count < PAGE_SIZE;

        if (isLastPage) break;

        cursor = page.next_cursor;
        await sleep(PAGE_DELAY_MS); // rate-limit between pages
      }

      return results;
    },
    config.CACHE_TTL_SECONDS
  );
}

/**
 * Fetch a single Polymarket market by its condition ID.
 * Returns null if the market is not found (404).
 */
export async function getMarketById(conditionId: string): Promise<MarketData | null> {
  const cacheKey = `poly:market:${conditionId}`;

  return cacheGetOrFetch(
    cacheKey,
    async () => {
      const url = `${BASE}/markets/${conditionId}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Polymarket CLOB ${res.status}: ${res.statusText}`);
      const market = (await res.json()) as ClobMarket;
      return normalize(market);
    },
    config.CACHE_TTL_SECONDS
  );
}

/**
 * Fetch the first page of active markets sorted by the CLOB's default order.
 * Useful for surfacing top markets without a query.
 */
export async function getTopMarkets(limit = 10): Promise<MarketData[]> {
  const cacheKey = `poly:top:${limit}`;

  return cacheGetOrFetch(
    cacheKey,
    async () => {
      const page = await fetchPage();
      return page.data
        .filter((m) => m.active && !m.closed)
        .slice(0, limit)
        .map(normalize)
        .sort((a, b) => b.volume - a.volume);
    },
    config.CACHE_TTL_SECONDS
  );
}
