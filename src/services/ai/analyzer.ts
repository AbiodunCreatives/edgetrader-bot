/**
 * AI analysis engine powered by Claude Opus 4.6.
 *
 * Three public functions:
 *   analyzeMarket      — single market deep-dive (cached 15 min)
 *   generateDailyPicks — top-3 edge opportunities from a list (cached 15 min)
 *   compareMarkets     — side-by-side comparison table (cached 15 min)
 *
 * All responses are streamed and cached in Redis. A rolling 24-hour token
 * budget prevents runaway API spend; the budget resets automatically when
 * the Redis key expires.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config.js";
import { redis } from "../../utils/rateLimit.js";
import { cacheGet, cacheSet } from "../../utils/cache.js";
import type { MarketData } from "../markets/types.js";
import {
  MARKET_ANALYSIS_PROMPT,
  DAILY_PICKS_PROMPT,
  COMPARE_PROMPT,
} from "./prompts.js";

// ── Client ─────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const MODEL = "claude-opus-4-6";
const AI_CACHE_TTL = 15 * 60; // 15 minutes in seconds

// ── Token Budget ───────────────────────────────────────────────────────────

const BUDGET_REDIS_KEY = "ai:budget:daily";

interface BudgetStatus {
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number;
}

async function getBudgetStatus(): Promise<BudgetStatus> {
  const raw = await redis.get(BUDGET_REDIS_KEY);
  const used = raw ? parseInt(raw, 10) : 0;
  const limit = config.ANTHROPIC_DAILY_TOKEN_BUDGET;
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    percentUsed: limit > 0 ? Math.round((used / limit) * 100) : 0,
  };
}

/**
 * Atomically increment the rolling token counter.
 * Sets a 24-hour TTL the first time the key is written so the budget
 * resets automatically at the same relative time each day.
 */
async function recordUsage(
  inputTokens: number,
  outputTokens: number
): Promise<BudgetStatus> {
  const total = inputTokens + outputTokens;
  const limit = config.ANTHROPIC_DAILY_TOKEN_BUDGET;

  const pipeline = redis.pipeline();
  pipeline.incrby(BUDGET_REDIS_KEY, total);
  pipeline.ttl(BUDGET_REDIS_KEY);
  const results = await pipeline.exec();

  const used = (results?.[0]?.[1] as number) ?? total;
  const ttl = (results?.[1]?.[1] as number) ?? -1;

  // Key is new (ttl == -1) or has no expiry set (ttl == -2 shouldn't happen
  // after incrby, but guard anyway) — set the 24-hour window.
  if (ttl < 0) {
    await redis.expire(BUDGET_REDIS_KEY, 24 * 60 * 60);
  }

  const status: BudgetStatus = {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    percentUsed: limit > 0 ? Math.round((used / limit) * 100) : 0,
  };

  if (status.percentUsed >= 90) {
    console.warn(
      `[ai] ⚠️  Token budget at ${status.percentUsed}% — ` +
        `${status.used.toLocaleString()} / ${status.limit.toLocaleString()} tokens used today.`
    );
  }

  return status;
}

/**
 * Throw a user-friendly error when the daily budget is exhausted.
 * Includes the reset time so users know when to retry.
 */
async function guardBudget(): Promise<void> {
  const status = await getBudgetStatus();
  if (status.remaining <= 0) {
    const ttl = await redis.ttl(BUDGET_REDIS_KEY);
    const hoursLeft = ttl > 0 ? Math.ceil(ttl / 3600) : 24;
    throw new Error(
      `Daily AI analysis budget exhausted ` +
        `(${status.used.toLocaleString()} / ${status.limit.toLocaleString()} tokens). ` +
        `Resets in ~${hoursLeft}h. Try again later or upgrade to Pro.`
    );
  }
}

// ── Formatting helpers ─────────────────────────────────────────────────────

/** Extract only text blocks from a Claude response, skipping thinking blocks. */
function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Render a MarketData object as a concise structured text block for prompts. */
function formatMarket(m: MarketData, index?: number): string {
  const label = index !== undefined ? `Market ${index + 1}` : "Market";
  const pct = (n: number | null | undefined) =>
    n == null ? "N/A" : `${(n * 100).toFixed(1)}%`;
  const usd = (n: number | null | undefined) =>
    n == null ? "N/A" :
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` :
    n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K` :
    `$${n.toFixed(0)}`;

  return [
    `[${label}] ${m.question}`,
    `  Source:      ${m.source}`,
    `  Probability: ${pct(m.probability)} YES`,
    `  Last price:  ${pct(m.lastPrice)}`,
    `  Volume:      ${usd(m.volume)}`,
    `  Closes:      ${m.endDate ? new Date(m.endDate).toDateString() : "Open-ended"}`,
    `  Category:    ${m.category ?? "Uncategorized"}`,
    `  URL:         ${m.url}`,
  ].join("\n");
}

/**
 * Build a stable, order-independent fingerprint for a list of markets.
 * Used as part of the Redis cache key for multi-market calls.
 */
function marketFingerprint(markets: MarketData[]): string {
  return markets
    .map((m) => `${m.source}:${m.id}`)
    .sort()
    .join("|");
}

/**
 * Round probability to the nearest 5% bucket.
 * Prevents a 0.01 price tick from busting the cache for every market.
 */
function priceBucket(probability: number | null | undefined): string {
  if (probability == null) return "0.00";
  return (Math.round(probability * 20) / 20).toFixed(2);
}

// ── Core API wrapper ───────────────────────────────────────────────────────

interface ClaudeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Stream a single Claude request and return the assembled text + token counts.
 * Uses adaptive thinking on Opus 4.6 — no budget_tokens required.
 * Streaming prevents HTTP timeouts on long responses.
 */
async function callClaude(
  system: string,
  userMessage: string,
  maxTokens: number
): Promise<ClaudeResult> {
  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  let message: Anthropic.Message;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error("Claude API rate limit hit. Please wait a moment and try again.");
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`Claude API error (${err.status}): ${err.message}`);
    }
    throw err;
  }

  return {
    text: extractText(message),
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a concise analysis for a single prediction market.
 *
 * Cache key includes a price bucket so an analysis refreshes when the
 * market probability moves by more than ~2.5 percentage points.
 */
export async function analyzeMarket(market: MarketData): Promise<string> {
  const bucket = priceBucket(market.probability);
  const cacheKey = `ai:analysis:${market.source}:${market.id}:${bucket}`;

  const cached = await cacheGet<string>(cacheKey);
  if (cached) return cached;

  await guardBudget();

  const userMessage = formatMarket(market);
  const result = await callClaude(MARKET_ANALYSIS_PROMPT, userMessage, 500);

  await recordUsage(result.inputTokens, result.outputTokens);
  await cacheSet(cacheKey, result.text, AI_CACHE_TTL);

  return result.text;
}

/**
 * Given a list of markets, identify the top 3 edge opportunities.
 *
 * Pre-filters to markets in the "interesting" probability range (10–90%)
 * and with meaningful volume before sending to Claude, so the model focuses
 * on actionable opportunities rather than near-certain or illiquid markets.
 */
export async function generateDailyPicks(markets: MarketData[]): Promise<string> {
  // Filter to liquid, non-trivial markets
  const candidates = markets
    .filter(
      (m) =>
        m.probability >= 0.10 &&
        m.probability <= 0.90 &&
        m.volume > 0
    )
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 15); // give Claude the top 15 by volume to choose from

  if (candidates.length === 0) {
    return "No suitable markets found for daily picks. Try again with a broader search.";
  }

  const fingerprint = marketFingerprint(candidates);
  const cacheKey = `ai:picks:${fingerprint}`;

  const cached = await cacheGet<string>(cacheKey);
  if (cached) return cached;

  await guardBudget();

  const userMessage =
    `Here are today's active markets. Select the top 3 with the most interesting ` +
    `edge opportunities and explain why each looks mispriced:\n\n` +
    candidates.map((m, i) => formatMarket(m, i)).join("\n\n");

  const result = await callClaude(DAILY_PICKS_PROMPT, userMessage, 800);

  await recordUsage(result.inputTokens, result.outputTokens);
  await cacheSet(cacheKey, result.text, AI_CACHE_TTL);

  return result.text;
}

/**
 * Compare two or more markets side-by-side and highlight the best risk/reward.
 * Intended for the /compare command where a user wants cross-platform or
 * cross-topic analysis.
 */
export async function compareMarkets(markets: MarketData[]): Promise<string> {
  if (markets.length < 2) {
    return "Please provide at least 2 markets to compare.";
  }

  const fingerprint = marketFingerprint(markets);
  const cacheKey = `ai:compare:${fingerprint}`;

  const cached = await cacheGet<string>(cacheKey);
  if (cached) return cached;

  await guardBudget();

  const userMessage =
    `Compare the following ${markets.length} prediction markets:\n\n` +
    markets.map((m, i) => formatMarket(m, i)).join("\n\n");

  const result = await callClaude(COMPARE_PROMPT, userMessage, 800);

  await recordUsage(result.inputTokens, result.outputTokens);
  await cacheSet(cacheKey, result.text, AI_CACHE_TTL);

  return result.text;
}

// ── Budget introspection (exported for /admin commands) ────────────────────

export { getBudgetStatus };
export type { BudgetStatus };
