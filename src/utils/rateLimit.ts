/**
 * Tier-aware rate limiting for Edge Trader Bot.
 *
 * Tier limits (daily, sliding 24-hour window):
 *   free  — 10 searches, 10 compares, 3 picks, 1 game, no portfolio, max 3 alerts
 *   pro   — unlimited searches/compares/picks/games, portfolio, max 20 alerts, daily picks push
 *   whale — everything pro + unlimited alerts
 *
 * Implementation:
 *   - Daily limits use Redis sorted-set sliding-window (key: rl:daily:{telegramId}:{action})
 *   - Portfolio access is a tier gate (boolean, no Redis)
 *   - Alert quotas are checked via DB count (not time-based)
 *   - User tier is cached in Redis for 5 min (key: tier:{telegramId}) to avoid hot-path DB hits
 */

import Redis from "ioredis";
import { config } from "../config.js";
import { getUserByTelegramId, getUserAlerts } from "../db/queries.js";

// ── Redis singleton ────────────────────────────────────────────────────────────

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  lazyConnect: true,
  connectTimeout: 5000, // fail fast if Upstash is unreachable
});

redis.on("connect",      ()    => console.log("[redis] Connecting…"));
redis.on("ready",        ()    => console.log("[redis] Ready."));
redis.on("error",        (err) => console.error("[redis] Error:", err.message));
redis.on("close",        ()    => console.warn("[redis] Connection closed."));
redis.on("reconnecting", ()    => console.log("[redis] Reconnecting…"));

// ── Types ──────────────────────────────────────────────────────────────────────

export type UserTier = "free" | "pro" | "whale";

/** Actions that can be rate-limited. */
export type RateLimitedAction =
  | "search"
  | "compare"
  | "picks"
  | "game"
  | "portfolio";

export interface RateLimitResult {
  allowed: boolean;
  /** Requests remaining today; -1 means unlimited. */
  remaining: number;
  /** Seconds until window resets (0 for non-time-based gates). */
  resetIn: number;
  tier: UserTier;
}

export interface QuotaInfo {
  tier: UserTier;
  search:  { used: number; limit: number | null };
  compare: { used: number; limit: number | null };
  picks:   { used: number; limit: number | null };
  game:    { used: number; limit: number | null };
  /** true if the tier can access portfolio at all */
  portfolio: boolean;
  /** Max active (non-triggered) alerts allowed; null = unlimited */
  alertMax: number | null;
}

// ── Tier configuration ─────────────────────────────────────────────────────────

interface TierConfig {
  /** Daily sliding-window limit per action; null = unlimited */
  dailyLimits: Record<"search" | "compare" | "picks" | "game", number | null>;
  portfolio: boolean;
  alertMax: number | null;
}

export const TIER_CONFIG: Record<UserTier, TierConfig> = {
  free: {
    dailyLimits: { search: 10, compare: 10, picks: 3, game: 1 },
    portfolio: false,
    alertMax: 3,
  },
  pro: {
    dailyLimits: { search: null, compare: null, picks: null, game: null },
    portfolio: true,
    alertMax: 20,
  },
  whale: {
    dailyLimits: { search: null, compare: null, picks: null, game: null },
    portfolio: true,
    alertMax: null,
  },
};

// ── Tier cache ────────────────────────────────────────────────────────────────

const TIER_CACHE_TTL_S = 5 * 60; // 5 minutes

/**
 * Returns the user's tier.
 * Caches in Redis for 5 min to avoid a DB lookup on every message.
 */
export async function getUserTier(telegramId: number): Promise<UserTier> {
  console.log(`[rateLimit] getUserTier(${telegramId})`);
  const key = `tier:${telegramId}`;
  const cached = await redis.get(key);
  if (cached === "free" || cached === "pro" || cached === "whale") return cached;

  const user = await getUserByTelegramId(telegramId);
  const tier = (user?.tier ?? "free") as UserTier;
  await redis.set(key, tier, "EX", TIER_CACHE_TTL_S);
  return tier;
}

/**
 * Invalidate the cached tier — call this after upgrading a user so the new
 * tier takes effect immediately without waiting for the 5-min TTL.
 */
export async function invalidateTierCache(telegramId: number): Promise<void> {
  await redis.del(`tier:${telegramId}`);
}

// ── Sliding-window helpers ────────────────────────────────────────────────────

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Atomically records an action attempt and returns the resulting usage count.
 * Uses a Redis sorted set with timestamps as both score and member.
 */
async function recordAndCount(
  telegramId: number,
  action: "search" | "compare" | "picks" | "game"
): Promise<number> {
  const key = `rl:daily:${telegramId}:${action}`;
  const now = Date.now();
  const windowMs = DAY_SECONDS * 1000;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, now - windowMs); // evict expired entries
  pipeline.zadd(key, now, `${now}`);                  // record this attempt
  pipeline.zcard(key);                                 // total in window
  pipeline.pexpire(key, windowMs);                    // auto-clean the key

  const results = await pipeline.exec();
  return (results?.[2]?.[1] as number) ?? 0;
}

/**
 * Returns the current usage count without recording a new attempt.
 * Used by getRemainingQuota for display purposes.
 */
async function peekCount(
  telegramId: number,
  action: "search" | "compare" | "picks" | "game"
): Promise<number> {
  const key = `rl:daily:${telegramId}:${action}`;
  const now = Date.now();
  await redis.zremrangebyscore(key, 0, now - DAY_SECONDS * 1000);
  return await redis.zcard(key);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Checks whether a user is allowed to perform an action and records the
 * attempt for time-windowed limits. For portfolio, no usage is recorded.
 */
export async function checkRateLimit(
  telegramId: number,
  action: RateLimitedAction
): Promise<RateLimitResult> {
  console.log(`[rateLimit] checkRateLimit(${telegramId}, ${action})`);
  const tier = await getUserTier(telegramId);
  const cfg = TIER_CONFIG[tier];

  // Portfolio is a boolean gate — no usage tracking
  if (action === "portfolio") {
    return {
      allowed: cfg.portfolio,
      remaining: cfg.portfolio ? -1 : 0,
      resetIn: 0,
      tier,
    };
  }

  const limit = cfg.dailyLimits[action];

  // Unlimited tier — still record for analytics but always allow
  if (limit === null) {
    void recordAndCount(telegramId, action).catch(() => null);
    return { allowed: true, remaining: -1, resetIn: 0, tier };
  }

  const used = await recordAndCount(telegramId, action);
  const allowed = used <= limit;
  const remaining = Math.max(0, limit - used);

  return { allowed, remaining, resetIn: DAY_SECONDS, tier };
}

/**
 * Returns a full quota snapshot (read-only — does NOT record usage).
 * Used by the /upgrade command to display current consumption.
 */
export async function getRemainingQuota(telegramId: number): Promise<QuotaInfo> {
  const tier = await getUserTier(telegramId);
  const cfg = TIER_CONFIG[tier];

  const [search, compare, picks, game] = await Promise.all([
    peek(telegramId, "search",  cfg.dailyLimits.search),
    peek(telegramId, "compare", cfg.dailyLimits.compare),
    peek(telegramId, "picks",   cfg.dailyLimits.picks),
    peek(telegramId, "game",    cfg.dailyLimits.game),
  ]);

  return { tier, search, compare, picks, game, portfolio: cfg.portfolio, alertMax: cfg.alertMax };
}

async function peek(
  telegramId: number,
  action: "search" | "compare" | "picks" | "game",
  limit: number | null
): Promise<{ used: number; limit: number | null }> {
  const used = limit !== null ? await peekCount(telegramId, action) : 0;
  return { used, limit };
}

/**
 * Check whether the user can create one more alert.
 * Alert quota is based on the count of active (non-triggered) alerts in the DB.
 */
export async function checkAlertQuota(
  telegramId: number
): Promise<{ allowed: boolean; current: number; max: number | null }> {
  const tier = await getUserTier(telegramId);
  const max = TIER_CONFIG[tier].alertMax;

  if (max === null) return { allowed: true, current: 0, max: null };

  const user = await getUserByTelegramId(telegramId);
  if (!user) return { allowed: false, current: 0, max };

  const all = await getUserAlerts(user.id);
  const current = all.filter((a) => !a.triggered).length;
  return { allowed: current < max, current, max };
}

// ── Upgrade CTA ───────────────────────────────────────────────────────────────

/**
 * Returns a user-facing HTML message explaining which limit was hit and how
 * to upgrade.
 */
export function buildUpgradeCta(action: RateLimitedAction, _tier: UserTier): string {
  const fl = TIER_CONFIG.free.dailyLimits;

  switch (action) {
    case "search":
      return (
        `⏳ <b>Daily search limit reached</b> (${fl.search}/day on Free).\n\n` +
        `Upgrade to <b>Pro</b> for unlimited searches → /upgrade`
      );
    case "compare":
      return (
        `⏳ <b>Daily compare limit reached</b> (${fl.compare}/day on Free).\n\n` +
        `Upgrade to <b>Pro</b> for unlimited market comparisons → /upgrade`
      );
    case "picks":
      return (
        `⏳ <b>Daily picks limit reached</b> (${fl.picks}/day on Free).\n\n` +
        `Upgrade to <b>Pro</b> for unlimited AI picks + 7 AM morning delivery → /upgrade`
      );
    case "game":
      return (
        `⏳ <b>Daily game limit reached</b> (${fl.game} game/day on Free).\n\n` +
        `Upgrade to <b>Pro</b> for unlimited prediction games → /upgrade`
      );
    case "portfolio":
      return (
        `🔒 <b>Portfolio tracking is a Pro feature.</b>\n\n` +
        `Upgrade to unlock portfolio tracking, more alerts, and unlimited AI analysis → /upgrade`
      );
    default:
      return `⏳ You've hit your daily limit.\n\nUpgrade to <b>Pro</b> for more → /upgrade`;
  }
}

/**
 * Deletes all rate-limit counters and the tier cache for a user.
 * Use in dev/admin contexts only.
 */
export async function resetUserRateLimits(telegramId: number): Promise<void> {
  const keys = (["search", "compare", "picks", "game"] as const).map(
    (a) => `rl:daily:${telegramId}:${a}`
  );
  keys.push(`tier:${telegramId}`);
  await redis.del(...keys);
}

/**
 * Returns an upgrade CTA for hitting the alert max count.
 */
export function buildAlertQuotaCta(current: number, max: number): string {
  return (
    `⚡ <b>Alert limit reached</b> (${current}/${max} on your plan).\n\n` +
    `Delete an existing alert to make room, or upgrade for more → /upgrade`
  );
}
