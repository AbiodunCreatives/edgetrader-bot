/**
 * Bayse Markets API client.
 *
 * Base: https://relay.bayse.markets/v1
 * Endpoint: GET /pm/events?page={page}&size=50
 *
 * Notes:
 * - Only include events with status "open" and markets with status "open".
 * - yesBuyPrice / outcome1Price are 0–1 decimals representing YES probability.
 * - Markets are cached in-memory for 5 minutes to reduce API load.
 * - Up to 6 pages are fetched (max 300 events).
 */

import type { MarketData } from "./types.js";

const BASE = "https://relay.bayse.markets/v1";
const PAGE_SIZE = 50;
const MAX_PAGES = 6;
const CACHE_TTL_MS = 5 * 60 * 1000;
const RETRIES = 3;

let cachedMarkets: MarketData[] | null = null;
let cacheExpiresAt = 0;

interface BayseMarketRaw {
  id: string;
  title?: string;
  status?: string;
  yesBuyPrice?: number;
  noBuyPrice?: number;
  outcome1Price?: number;
}

interface BayseEventRaw {
  id: string;
  title: string;
  status?: string;
  totalVolume?: number;
  totalOrders?: number;
  closingDate?: string | null;
  resolutionDate?: string | null;
  category?: string | null;
  markets?: BayseMarketRaw[];
}

interface EventsResponse {
  events?: BayseEventRaw[];
  data?: BayseEventRaw[];
  content?: BayseEventRaw[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url: string): Promise<EventsResponse> {
  let attempt = 0;
  while (attempt < RETRIES) {
    attempt++;
    const res = await fetch(url, { headers: { Accept: "application/json" } });

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= RETRIES) {
        throw new Error(`Bayse API ${res.status}: ${res.statusText} — ${url}`);
      }
      const wait = Math.min(500 * 2 ** (attempt - 1), 5000);
      console.warn(`[bayse] ${res.status} on attempt ${attempt}, retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      throw new Error(`Bayse API ${res.status}: ${res.statusText} — ${url}`);
    }

    return res.json() as Promise<EventsResponse>;
  }

  // Fallback (should never hit due to throw above)
  return { events: [] };
}

function normalizeCategory(cat?: string | null): string | null {
  if (!cat) return null;
  const trimmed = cat.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === "social media") return "Social";
  return trimmed[0].toUpperCase() + trimmed.slice(1).toLowerCase();
}

function normalizeEventMarkets(event: BayseEventRaw): MarketData[] {
  const markets = event.markets ?? [];
  const isMulti = markets.length > 1;
  const baseQuestion = event.title ?? "Untitled event";
  const volume = event.totalVolume ?? event.totalOrders ?? 0;
  const endDate = event.closingDate ?? event.resolutionDate ?? null;
  const category = normalizeCategory(event.category);

  return markets
    .filter((m) => (m.status ?? "").toLowerCase() === "open")
    .map((m) => {
      const probability = m.yesBuyPrice ?? m.outcome1Price ?? 0;
      return {
        id: `bayse_${m.id}`,
        source: "bayse",
        question: isMulti ? `${baseQuestion} — ${m.title ?? "Market"}` : baseQuestion,
        probability,
        lastPrice: probability,
        volume,
        endDate,
        url: `https://bayse.markets/event/${event.id}`,
        category,
      } satisfies MarketData;
    });
}

async function fetchPage(page: number): Promise<BayseEventRaw[]> {
  const url = `${BASE}/pm/events?page=${page}&size=${PAGE_SIZE}`;
  const body = await fetchJsonWithRetry(url);
  return body.events ?? body.data ?? body.content ?? [];
}

async function fetchAllMarkets(): Promise<MarketData[]> {
  const now = Date.now();
  if (cachedMarkets && cacheExpiresAt > now) return cachedMarkets;

  const all: MarketData[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const events = await fetchPage(page);
    if (events.length === 0) break;

    for (const ev of events) {
      if ((ev.status ?? "").toLowerCase() !== "open") continue;
      all.push(...normalizeEventMarkets(ev));
    }
  }

  cachedMarkets = all;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return all;
}

/** Search Bayse markets by query (case-insensitive substring) */
export async function searchBayseMarkets(query: string, limit = 10): Promise<MarketData[]> {
  const markets = await fetchAllMarkets();
  const needle = query.toLowerCase();

  return markets
    .filter((m) => m.question.toLowerCase().includes(needle))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, limit);
}

/** Fetch a single Bayse market by its ID (with or without the bayse_ prefix). */
export async function getBayseMarket(id: string): Promise<MarketData | null> {
  const cleanId = id.startsWith("bayse_") ? id.slice(6) : id;
  const markets = await fetchAllMarkets();
  return markets.find((m) => m.id === `bayse_${cleanId}`) ?? null;
}

/** Return the top Bayse markets by volume. */
export async function getTrendingBayseMarkets(limit = 10): Promise<MarketData[]> {
  const markets = await fetchAllMarkets();
  return markets.sort((a, b) => b.volume - a.volume).slice(0, limit);
}
