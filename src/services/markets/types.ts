/**
 * Canonical market shape shared across all sources.
 * All source-specific clients normalise their raw API responses into this.
 */
export interface MarketData {
  /** Native ID from the source platform (condition_id for Polymarket, market id for Bayse). */
  id: string;

  source: "polymarket" | "bayse";

  question: string;

  /** Current implied probability of the YES / leading outcome, 0–1. */
  probability: number;

  /**
   * Most recent trade price for the YES / leading outcome, 0–1.
   * For sources that don't expose a separate last-trade price this equals probability.
   */
  lastPrice: number;

  /** Total traded volume in USD. */
  volume: number;

  /** ISO-8601 resolution/close date, or null if open-ended. */
  endDate: string | null;

  /** Canonical link to the market on its platform. */
  url: string;

  /** Best-effort category tag from the source (e.g. "Politics", "Sports"). */
  category: string | null;
}

/** Composite routing key used throughout the app: "{source}:{id}" */
export function marketKey(market: MarketData): string {
  return `${market.source}:${market.id}`;
}

/** Parse a composite key back into its parts. Returns null if malformed. */
export function parseMarketKey(key: string): { source: string; id: string } | null {
  const colonIdx = key.indexOf(":");
  if (colonIdx === -1) return null;
  return { source: key.slice(0, colonIdx), id: key.slice(colonIdx + 1) };
}
