/**
 * Per-user Redis session store.
 *
 * All keys expire after 1 hour so stale state never blocks a user permanently.
 * Keys are namespaced by type so different flows don't collide.
 *
 *  sess:search:{userId}   → MarketData[]  (last search results)
 *  sess:market:{userId}   → MarketData    (currently active market)
 *  sess:compare:{userId}  → CompareSession
 *  sess:alert:{userId}    → AlertFlowState
 *  gsess:{shortId}        → { fullId, chatId, messageId }
 */

import { redis } from "../utils/rateLimit.js";
import type { MarketData } from "../services/markets/types.js";

const TTL = 3600; // 1 hour

async function get<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function set(key: string, value: unknown, ttl = TTL): Promise<void> {
  await redis.set(key, JSON.stringify(value), "EX", ttl);
}

// ── Search ─────────────────────────────────────────────────────────────────

export async function saveSearchResults(userId: number, markets: MarketData[]): Promise<void> {
  await set(`sess:search:${userId}`, markets);
}

export async function getSearchResults(userId: number): Promise<MarketData[] | null> {
  return get<MarketData[]>(`sess:search:${userId}`);
}

// ── Active market (flows that need to remember which market is in context) ──

export async function saveActiveMarket(userId: number, market: MarketData): Promise<void> {
  await set(`sess:market:${userId}`, market);
}

export async function getActiveMarket(userId: number): Promise<MarketData | null> {
  return get<MarketData>(`sess:market:${userId}`);
}

// ── Compare ────────────────────────────────────────────────────────────────

export interface CompareSession {
  results: MarketData[];
  selections: number[]; // indices into results[]
}

export async function saveCompareSession(userId: number, session: CompareSession): Promise<void> {
  await set(`sess:compare:${userId}`, session);
}

export async function getCompareSession(userId: number): Promise<CompareSession | null> {
  return get<CompareSession>(`sess:compare:${userId}`);
}

// ── Alert creation flow ────────────────────────────────────────────────────

export interface AlertFlowState {
  marketId: string;       // composite "source:id"
  marketQuestion: string;
  condition?: "above" | "below";
}

export async function saveAlertState(userId: number, state: AlertFlowState): Promise<void> {
  await set(`sess:alert:${userId}`, state);
}

export async function getAlertState(userId: number): Promise<AlertFlowState | null> {
  return get<AlertFlowState>(`sess:alert:${userId}`);
}

export async function clearAlertState(userId: number): Promise<void> {
  await redis.del(`sess:alert:${userId}`);
}

// ── Game sessions ──────────────────────────────────────────────────────────

export interface GameSessionMeta {
  fullId: string;      // full UUID from DB
  chatId: number;
  messageId: number;   // Telegram message to edit with vote counts
}

/** shortId = sessionId.slice(0, 8) — fits in callback data */
export async function saveGameSessionMeta(shortId: string, meta: GameSessionMeta): Promise<void> {
  await set(`gsess:${shortId}`, meta, 25 * 3600); // 25 h so votes work after 24 h deadline
}

export async function getGameSessionMeta(shortId: string): Promise<GameSessionMeta | null> {
  return get<GameSessionMeta>(`gsess:${shortId}`);
}
