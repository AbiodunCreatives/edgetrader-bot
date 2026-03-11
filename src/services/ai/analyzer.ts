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
  CRYPTO_PRICE_ANALYSIS_PROMPT,
} from "./prompts.js";
import { detectCryptoAsset, parseTargetPrice, fetchLivePrice } from "../price/crypto.js";
import type { LivePrice } from "../price/crypto.js";

// ── Client ─────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const MODEL = "claude-opus-4-6";
const AI_CACHE_TTL = 5 * 60; // 5 minutes for fresher analyses

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

// ── Lightweight news fetcher (Google News RSS) ──────────────────────────────────

async function fetchRecentNews(query: string, limit = 3): Promise<{ title: string; date: string }[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/rss+xml, application/xml" } });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = xml.split("<item>").slice(1);
    const headlines: { title: string; date: string }[] = [];
    for (const item of items) {
      if (headlines.length >= limit) break;
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
      const dateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
      const title = titleMatch?.[1]?.trim();
      const date = dateMatch?.[1];
      if (title) {
        headlines.push({ title, date: date ? new Date(date).toISOString() : "" });
      }
    }
    return headlines;
  } catch {
    return [];
  }
}

// ── Crypto price enrichment ─────────────────────────────────────────────────

interface CryptoPriceContext {
  livePrice: LivePrice;
  /** Extracted from the market question — null when no dollar target is present. */
  targetPrice: number | null;
  /** null when no targetPrice could be determined. */
  requiredMovePct: number | null;
  daysRemaining: number | null;
}

/**
 * If the market question mentions a known crypto asset (BTC/ETH/SOL etc.),
 * fetch a live spot price and build the analysis context.
 *
 * Works for both price-target markets ("Will BTC reach $150k?") and
 * general crypto markets ("Will Bitcoin hit ATH in 2025?").
 * Returns null only for non-crypto markets.
 */
async function buildCryptoPriceContext(
  market: MarketData
): Promise<CryptoPriceContext | null> {
  const asset = detectCryptoAsset(market.question);
  if (!asset) return null;

  const livePrice = await fetchLivePrice(asset);

  const targetPrice = parseTargetPrice(market.question);
  const requiredMovePct =
    targetPrice !== null
      ? ((targetPrice - livePrice.price) / livePrice.price) * 100
      : null;

  let daysRemaining: number | null = null;
  if (market.endDate) {
    const closeMs = new Date(market.endDate).getTime();
    const nowMs = Date.now();
    daysRemaining = Math.max(0, Math.round((closeMs - nowMs) / 86_400_000));
  }

  return { livePrice, targetPrice, requiredMovePct, daysRemaining };
}

/**
 * Format a CryptoPriceContext as a structured block to inject into the Claude
 * user message. Claude is explicitly told to use only these values and must
 * not substitute prices from its training data.
 */
function formatCryptoBlock(ctx: CryptoPriceContext, market: MarketData): string {
  const { livePrice, targetPrice, requiredMovePct, daysRemaining } = ctx;
  const yesOdds = ((market.probability ?? 0) * 100).toFixed(1);
  const closeStr = market.endDate
    ? new Date(market.endDate).toDateString()
    : "open-ended";

  const lines = [
    `LIVE INPUTS (fetched at runtime — do NOT substitute training-data prices):`,
    `  Asset:            ${livePrice.asset}`,
    `  Current price:    $${livePrice.price.toLocaleString("en-US")}`,
    `  Price source:     ${livePrice.source === "coingecko" ? "CoinGecko" : "Binance"}`,
    `  Fetched at:       ${livePrice.fetchedAt} UTC`,
    ``,
    `MARKET DATA (fetched live from Polymarket):`,
    `  Question:         ${market.question}`,
    `  Current YES odds: ${yesOdds}%`,
    `  Market closes:    ${closeStr}`,
    `  Days remaining:   ${daysRemaining !== null ? daysRemaining : "unknown"}`,
    `  Volume:           $${(market.volume ?? 0).toLocaleString("en-US")}`,
  ];

  if (targetPrice !== null && requiredMovePct !== null) {
    const direction = requiredMovePct >= 0 ? "gain" : "decline";
    const absPct = Math.abs(requiredMovePct).toFixed(1);
    lines.push(
      ``,
      `CALCULATED VALUES:`,
      `  Target price:     $${targetPrice.toLocaleString("en-US")}`,
      `  Required move:    ${absPct}% ${direction}`,
    );
  }

  return lines.join("\n");
}

/**
 * Build the data-freshness footer appended to every crypto price analysis.
 */
function freshnessBanner(ctx: CryptoPriceContext): string {
  const src = ctx.livePrice.source === "coingecko" ? "CoinGecko" : "Binance";
  return (
    `\n\n⚠️ Data fetched at ${ctx.livePrice.fetchedAt} UTC via ${src}. ` +
    `Re-run analysis if more than 1 hour has passed.`
  );
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

  // Attempt to detect a crypto price market and fetch live data.
  // If price fetch fails we log the error and fall through to the generic path.
  let cryptoCtx: CryptoPriceContext | null = null;
  try {
    cryptoCtx = await buildCryptoPriceContext(market);
  } catch (err) {
    console.warn("[ai] crypto price fetch failed, falling back to generic analysis:", err);
  }

  let systemPrompt: string;
  let userMessage: string;
  let maxTokens: number;

  if (cryptoCtx) {
    // Validate live price before calling Claude
    if (!cryptoCtx.livePrice.price || cryptoCtx.livePrice.price <= 0) {
      throw new Error("Live price fetch succeeded but returned an invalid value. Analysis aborted.");
    }
    const yesOdds = (market.probability ?? 0) * 100;
    if (yesOdds < 0 || yesOdds > 100) {
      throw new Error(`Market probability out of range (${yesOdds.toFixed(1)}%). Analysis aborted.`);
    }
    if (cryptoCtx.daysRemaining !== null && cryptoCtx.daysRemaining <= 0) {
      throw new Error("Market has already closed (days remaining ≤ 0). Analysis aborted.");
    }

    systemPrompt = CRYPTO_PRICE_ANALYSIS_PROMPT;
    userMessage = formatCryptoBlock(cryptoCtx, market);
    maxTokens = 600;
  } else {
    // Generic path: include market card + recent news
    const news = await fetchRecentNews(market.question, 3);
    const newsBlock =
      news.length === 0
        ? "Recent news: none found."
        : "Recent news:\n" +
          news
            .map(
              (n) =>
                `- ${n.title}${n.date ? ` (${new Date(n.date).toDateString()})` : ""}`
            )
            .join("\n");

    systemPrompt = MARKET_ANALYSIS_PROMPT;
    userMessage = `${formatMarket(market)}\n\n${newsBlock}`;
    maxTokens = 500;
  }

  const result = await callClaude(systemPrompt, userMessage, maxTokens);

  // Append freshness footer for crypto price analyses
  const finalText = cryptoCtx
    ? result.text + freshnessBanner(cryptoCtx)
    : result.text;

  await recordUsage(result.inputTokens, result.outputTokens);
  await cacheSet(cacheKey, finalText, AI_CACHE_TTL);

  return finalText;
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
